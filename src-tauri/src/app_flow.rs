// Orchestration flows: hold-to-open launcher reveal, mode switching, capture,
// the screenshot editor pipeline (handshake queue, F4 ownership, save/pin),
// secondary pin annotation, and configurable shortcut registration.

use crate::capture::{capture_display_bgra, cursor_display};
use crate::clip_logic::{add_image, broadcast_delta, ImageOpts};
use crate::core::*;
use crate::ctx::{ctx, trace};
use crate::hold::ShortcutHold;
use crate::shortcuts::{accelerator_to_hotkey, shortcut_key_groups};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

pub const HOTKEY_APP: i32 = 1;
pub const HOTKEY_CAPTURE: i32 = 2;
pub const HOTKEY_QUICK_PIN: i32 = 3;
pub const HOTKEY_HISTORY: i32 = 4;
pub const HOTKEY_F4: i32 = 5;

// ---------------------------------------------------------------- main window / launcher

pub fn set_main_window_mode(mode: &str, anchor: Option<(i32, i32)>) {
    let app = &ctx().app;
    let Some(win) = app.get_webview_window("main") else { return };
    {
        let mut state = ctx().state.lock().unwrap();
        state.mode_revision += 1;
    }
    let _scale = win.scale_factor().unwrap_or(1.0);
    // Only a fresh invocation follows the mouse; navigation keeps the window
    // center fixed on its current display.
    let center = match (win.inner_position(), win.inner_size()) {
        (Ok(pos), Ok(size)) => (
            (pos.x as f64 + size.width as f64 / 2.0) as i32,
            (pos.y as f64 + size.height as f64 / 2.0) as i32,
        ),
        _ => cursor_display()
            .map(|d| (d.bounds.x + d.bounds.width / 2, d.bounds.y + d.bounds.height / 2))
            .unwrap_or((0, 0)),
    };
    let anchor = anchor.unwrap_or(center);
    let Some(work_display) = display_for_anchor(anchor) else { return };
    let scale = work_display.scale;
    let (size_w, size_h): (f64, f64) = if mode == "clipboard" { (540.0, 720.0) } else { (520.0, 520.0) };
    let work_logical = (
        work_display.work.width as f64 / scale,
        work_display.work.height as f64 / scale,
    );
    let work_origin = (
        work_display.work.x as f64 / scale,
        work_display.work.y as f64 / scale,
    );
    let fitted = (size_w.min(work_logical.0), size_h.min(work_logical.1));
    let anchor_logical = (anchor.0 as f64 / scale, anchor.1 as f64 / scale);
    let position = cursor_window_position(
        Rect {
            x: work_origin.0.round() as i32,
            y: work_origin.1.round() as i32,
            width: work_logical.0.round() as i32,
            height: work_logical.1.round() as i32,
        },
        (fitted.0.round() as i32, fitted.1.round() as i32),
        (anchor_logical.0.round() as i32, anchor_logical.1.round() as i32),
    );
    let _ = scale;
    // Commit size and position together.
    let _ = win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(
        position.0 as f64,
        position.1 as f64,
    )));
    let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(fitted.0, fitted.1)));
}

fn display_for_anchor(_anchor: (i32, i32)) -> Option<crate::capture::DisplayInfo> {
    // MonitorFromPoint on the anchor (physical).
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
    unsafe {
        let pt = POINT { x: _anchor.0, y: _anchor.1 };
        let monitor = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
        if monitor.is_invalid() {
            return None;
        }
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return None;
        }
        let mut dpi = 96u32;
        let mut y = 96u32;
        let _ = GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi, &mut y);
        Some(crate::capture::DisplayInfo {
            bounds: Rect {
                x: info.rcMonitor.left,
                y: info.rcMonitor.top,
                width: info.rcMonitor.right - info.rcMonitor.left,
                height: info.rcMonitor.bottom - info.rcMonitor.top,
            },
            work: Rect {
                x: info.rcWork.left,
                y: info.rcWork.top,
                width: info.rcWork.right - info.rcWork.left,
                height: info.rcWork.bottom - info.rcWork.top,
            },
            scale: dpi as f64 / 96.0,
            cursor: _anchor,
        })
    }
}

pub fn hide_main() {
    ShortcutHold::commit();
    if let Some(win) = ctx().app.get_webview_window("main") {
        let _ = win.hide();
    }
}

pub fn reveal_main(cursor: (i32, i32), invocation: Option<Value>) {
    set_main_window_mode("launcher", Some(cursor));
    let app = &ctx().app;
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
        let _ = app.emit_to("main", "window:open-launcher", invocation.clone().unwrap_or(Value::Null));
    }
}

/// Port of showWindow. The cursor position is sampled the moment the
/// invocation arrives — before the foreground lookup, per the positioning
/// clarification contract.
pub fn show_main_window(from_shortcut: bool) {
    let cursor = crate::capture::cursor_position();
    if from_shortcut {
        let (recording, shortcut) = {
            let state = ctx().state.lock().unwrap();
            (
                state.shortcut_recording_active,
                state.shortcut.clone(),
            )
        };
        if recording {
            return;
        }
        let Some((session_id, groups)) = ShortcutHold::start(&ctx().app, &shortcut) else {
            return;
        };
        let flat_keys: Vec<i32> = groups.concat();
        let app = ctx().app.clone();
        std::thread::spawn(move || {
            let source = crate::foreground::foreground();
            // First poll already ran inside start(); verify the chord is still
            // physically held before revealing anything.
            if !ShortcutHold::check(&app, session_id) {
                return;
            }
            if !ShortcutHold::is_active_id(session_id) || !ShortcutHold::is_pending() {
                return;
            }
            if !ShortcutHold::check(&app, session_id) {
                return;
            }
            if let Some(info) = source.as_ref() {
                let normalized = crate::foreground::normalize_source(info);
                let mut state = ctx().state.lock().unwrap();
                if let Some(source) = normalized.clone() {
                    state.last_external_source = Some(source);
                    state.previous_window_handle = Some(info.handle.clone());
                } else {
                    state.previous_window_handle =
                        state.last_external_source.as_ref().and_then(|s| s.get("handle")).and_then(|v| v.as_str()).map(String::from);
                }
            }
            let _ = crate::foreground::foreground();
            reveal_main(
                cursor,
                Some(json!({
                    "shortcutKeys": flat_keys,
                    "shortcutSession": session_id,
                })),
            );
        });
        return;
    }
    ShortcutHold::stop();
    reveal_main(cursor, None);
}

// ---------------------------------------------------------------- shortcut registration

fn register_hotkey_id(id: i32, accelerator: &str) -> bool {
    let Some(spec) = accelerator_to_hotkey(accelerator) else { return false };
    let ok = ctx().msg.hotkey(id, spec.modifiers, spec.vk);
    if ok {
        let mut state = ctx().state.lock().unwrap();
        if !state.registered_hotkeys.contains(&id) {
            state.registered_hotkeys.push(id);
        }
    }
    ok
}

fn unregister_hotkey_id(id: i32) {
    ctx().msg.unhotkey(id);
    let mut state = ctx().state.lock().unwrap();
    state.registered_hotkeys.retain(|v| *v != id);
}

pub fn register_app_shortcut(next: &str, persist: bool) -> Value {
    if shortcut_key_groups(next).is_none() {
        return json!({ "success": false, "message": "此快捷键暂不支持按住唤出，请使用字母、数字或标准功能键组合" });
    }
    let previous = {
        let state = ctx().state.lock().unwrap();
        if state.shortcut.is_empty() { DEFAULT_SHORTCUT.to_string() } else { state.shortcut.clone() }
    };
    unregister_hotkey_id(HOTKEY_APP);
    let success = register_hotkey_id(HOTKEY_APP, next);
    if !success {
        register_hotkey_id(HOTKEY_APP, &previous);
        return json!({ "success": false, "message": "快捷键已被其他应用占用" });
    }
    {
        let mut state = ctx().state.lock().unwrap();
        state.shortcut = next.to_string();
    }
    if persist {
        let state = ctx().state.lock().unwrap();
        crate::clip_logic::schedule_store(&state, None);
        let shortcut = state.shortcut.clone();
        drop(state);
        broadcast_delta(json!({ "notice": format!("快捷键已更新为 {shortcut}"), "shortcut": shortcut }));
    }
    json!({ "success": true, "shortcut": next })
}

fn configurable_values(app_shortcut: &str, shortcuts: &Value) -> Vec<String> {
    let mut values = vec![app_shortcut.trim().to_string()];
    for key in ["capture", "quickPin", "history"] {
        values.push(
            shortcuts
                .get(key)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string(),
        );
    }
    values
}

fn screenshot_bindings(shortcuts: &Value) -> Vec<(&'static str, String)> {
    let get = |key: &str| shortcuts.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();
    vec![
        ("capture", get("capture")),
        ("quickPin", get("quickPin")),
        ("history", get("history")),
    ]
}

fn restore_configurable_shortcuts() {
    let (app_shortcut, screenshot_shortcuts) = {
        let state = ctx().state.lock().unwrap();
        (state.shortcut.clone(), state.screenshot_shortcuts.clone())
    };
    for id in [HOTKEY_APP, HOTKEY_CAPTURE, HOTKEY_QUICK_PIN, HOTKEY_HISTORY] {
        unregister_hotkey_id(id);
    }
    let shortcut = if app_shortcut.is_empty() { DEFAULT_SHORTCUT.to_string() } else { app_shortcut };
    register_hotkey_id(HOTKEY_APP, &shortcut);
    for (i, (_, accelerator)) in screenshot_bindings(&screenshot_shortcuts).iter().enumerate() {
        let id = [HOTKEY_CAPTURE, HOTKEY_QUICK_PIN, HOTKEY_HISTORY][i];
        register_hotkey_id(id, accelerator);
    }
}

pub fn set_shortcut_recording(active: bool) -> Value {
    ShortcutHold::stop();
    {
        let mut state = ctx().state.lock().unwrap();
        state.shortcut_recording_active = active;
    }
    if active {
        for id in [HOTKEY_APP, HOTKEY_CAPTURE, HOTKEY_QUICK_PIN, HOTKEY_HISTORY] {
            unregister_hotkey_id(id);
        }
    } else {
        restore_configurable_shortcuts();
    }
    let active = ctx().state.lock().unwrap().shortcut_recording_active;
    json!({ "success": true, "active": active })
}

pub fn update_all_shortcuts(next_app: Option<String>, next_screenshot: Value) -> Value {
    let (previous_app, previous_screenshot) = {
        let state = ctx().state.lock().unwrap();
        (state.shortcut.clone(), state.screenshot_shortcuts.clone())
    };
    let _default_app = if previous_app.is_empty() { DEFAULT_SHORTCUT.to_string() } else { previous_app.clone() };
    let candidate_app = next_app.unwrap_or_default().trim().to_string();
    if shortcut_key_groups(&candidate_app).is_none() {
        return json!({ "success": false, "message": "主窗口快捷键不支持按住检测，请使用字母、数字或标准功能键组合" });
    }
    let mut candidate = default_screenshot_shortcuts();
    if let Some(obj) = next_screenshot.as_object() {
        for (k, v) in obj {
            if let Some(text) = v.as_str() {
                candidate[k.clone()] = json!(text);
            }
        }
    }
    let values = configurable_values(&candidate_app, &candidate);
    if values.iter().any(|v| v.is_empty()) || duplicate_ci(&values) {
        return json!({ "success": false, "message": "全局快捷键不能为空或重复" });
    }
    let history_pin = candidate
        .get("historyPin")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if history_pin.is_empty() {
        return json!({ "success": false, "message": "历史截图钉到桌面的按键不能为空" });
    }
    candidate["historyPin"] = json!(history_pin);

    for id in [HOTKEY_APP, HOTKEY_CAPTURE, HOTKEY_QUICK_PIN, HOTKEY_HISTORY] {
        unregister_hotkey_id(id);
    }
    let mut registered: Vec<i32> = Vec::new();
    let bindings = screenshot_bindings(&candidate);
    let mut failed: Option<String> = None;
    if !register_hotkey_id(HOTKEY_APP, &candidate_app) {
        failed = Some(candidate_app.clone());
    } else {
        registered.push(HOTKEY_APP);
        for (i, (_, accelerator)) in bindings.iter().enumerate() {
            let id = [HOTKEY_CAPTURE, HOTKEY_QUICK_PIN, HOTKEY_HISTORY][i];
            if register_hotkey_id(id, accelerator) {
                registered.push(id);
            } else {
                failed = Some(accelerator.clone());
                break;
            }
        }
    }
    if let Some(conflict) = failed {
        for id in registered {
            unregister_hotkey_id(id);
        }
        {
            let mut state = ctx().state.lock().unwrap();
            state.shortcut = previous_app;
            state.screenshot_shortcuts = previous_screenshot;
        }
        restore_configurable_shortcuts();
        return json!({ "success": false, "message": format!("快捷键 {conflict} 已被其他应用占用，请换一个组合") });
    }
    let recording_active = {
        let mut state = ctx().state.lock().unwrap();
        state.shortcut = candidate_app.clone();
        state.screenshot_shortcuts = candidate.clone();
        state.shortcut_recording_active
    };
    if recording_active {
        for id in [HOTKEY_APP, HOTKEY_CAPTURE, HOTKEY_QUICK_PIN, HOTKEY_HISTORY] {
            unregister_hotkey_id(id);
        }
    }
    {
        let state = ctx().state.lock().unwrap();
        crate::clip_logic::schedule_store(&state, None);
    }
    broadcast_delta(json!({
        "notice": "快捷键已保存并生效",
        "shortcut": candidate_app,
        "screenshotShortcuts": candidate,
    }));
    json!({
        "success": true,
        "shortcut": candidate_app,
        "screenshotShortcuts": candidate,
    })
}

fn duplicate_ci(values: &[String]) -> bool {
    let mut seen = std::collections::HashSet::new();
    values.iter().any(|v| !seen.insert(v.to_lowercase()))
}

/// Register the screenshot shortcuts at startup (persist: false path).
pub fn register_screenshot_shortcuts_at_start() {
    let shortcuts = ctx().state.lock().unwrap().screenshot_shortcuts.clone();
    let values = screenshot_bindings(&shortcuts);
    let flat: Vec<String> = values.iter().map(|(_, v)| v.trim().to_string()).collect();
    if flat.iter().any(|v| v.is_empty()) || duplicate_ci(&flat) {
        return;
    }
    for (i, (_, accelerator)) in values.iter().enumerate() {
        let id = [HOTKEY_CAPTURE, HOTKEY_QUICK_PIN, HOTKEY_HISTORY][i];
        register_hotkey_id(id, accelerator);
    }
}

// ---------------------------------------------------------------- capture pipeline

pub fn set_screenshot_pin_shortcut(active: bool) {
    let already = ctx().state.lock().unwrap().screenshot_pin_registered;
    if !active {
        if already {
            unregister_hotkey_id(HOTKEY_F4);
        }
        ctx().state.lock().unwrap().screenshot_pin_registered = false;
        return;
    }
    if already {
        return;
    }
    let ok = register_hotkey_id(HOTKEY_F4, "F4");
    ctx().state.lock().unwrap().screenshot_pin_registered = ok;
}

/// Native F4: forward to the visible editor as screenshot:pin-request.
pub fn on_f4_hotkey() {
    if !crate::appwindows::editor_visible() {
        return;
    }
    trace("f4-main-received");
    let app = &ctx().app;
    if let Some(_win) = app.get_webview_window("editor") {
        let _ = app.emit_to("editor", "screenshot:pin-request", Value::Null);
    }
}

pub fn capture_current_display(pin_immediately: bool) -> Result<(), String> {
    trace("capture-shortcut-received");
    let app = &ctx().app;
    let any_visible = ["main", "toast", "history"]
        .iter()
        .any(|label| app.get_webview_window(label).map(|w| w.is_visible().unwrap_or(false)).unwrap_or(false));
    for label in ["main", "toast", "history"] {
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.hide();
        }
    }
    if any_visible {
        std::thread::sleep(std::time::Duration::from_millis(16));
    }
    trace("capture-ui-hidden");
    let display = cursor_display()?;
    let (w, h, bgra) = capture_display_bgra(&display)?;
    trace("capture-native-ready");
    // Preselection preferred size is 520x320 logical; convert to physical.
    let preferred_w = (520.0 * display.scale).round() as i32;
    let preferred_h = (320.0 * display.scale).round() as i32;
    let region = default_capture_region(display.bounds, display.cursor, preferred_w, preferred_h);
    let png_bytes = crate::imaging::encode_png(w, h, &bgra)?;
    trace("capture-png-ready");
    if pin_immediately {
        let crop_bytes = crop_png(
            &png_bytes,
            region.x - display.bounds.x,
            region.y - display.bounds.y,
            region.width,
            region.height,
        )?;
        let Some(entry) = add_image(
            crop_bytes.clone(),
            ImageOpts { origin: Some("screenshot"), force: true, ..Default::default() },
        ) else {
            return Ok(());
        };
        crate::clipboard_native::write_image_png(&crop_bytes);
        {
            let mut state = ctx().state.lock().unwrap();
            state.suppress_sequence = Some(crate::clipboard_native::sequence_number());
            state.suppress_fingerprint = entry.get("fingerprint").and_then(|v| v.as_str()).unwrap_or("").to_string();
            state.last_fingerprint = state.suppress_fingerprint.clone();
        }
        let size = crate::core::png_size(&crop_bytes).unwrap_or((w, h));
        crate::pins::open_pin_window(&entry, Some(region), crop_bytes, size);
        return Ok(());
    }
    let crop = Rect {
        x: (region.x - display.bounds.x).max(0),
        y: (region.y - display.bounds.y).max(0),
        width: region.width.min(w as i32),
        height: region.height.min(h as i32),
    };
    {
        let mut state = ctx().state.lock().unwrap();
        state.current_capture = Some(json!({
            "displayBounds": display.bounds.to_json(),
            "sourceSize": { "width": w, "height": h },
            "imageBytesB64": crate::imaging::base64_encode(&png_bytes),
        }));
    }
    open_screenshot_editor(
        display.bounds,
        png_bytes,
        Some(crop),
        json!({}),
    );
    Ok(())
}

/// Crop BGRA and re-encode (quick pin path, port of nativeImage.crop).
fn crop_png(bytes: &[u8], x: i32, y: i32, width: i32, height: i32) -> Result<Vec<u8>, String> {
    let (w, h, bgra) = crate::imaging::decode_bgra(bytes)?;
    let x0 = (x.max(0) as u32).min(w.saturating_sub(1));
    let y0 = (y.max(0) as u32).min(h.saturating_sub(1));
    let crop_w = (width.max(1) as u32).min(w - x0);
    let crop_h = (height.max(1) as u32).min(h - y0);
    let mut out = vec![0u8; (crop_w * crop_h * 4) as usize];
    for row in 0..crop_h {
        let src_start = (((y0 + row) * w + x0) * 4) as usize;
        let dst_start = (row * crop_w * 4) as usize;
        out[dst_start..dst_start + (crop_w * 4) as usize]
            .copy_from_slice(&bgra[src_start..src_start + (crop_w * 4) as usize]);
    }
    crate::imaging::encode_png(crop_w, crop_h, &out)
}

/// Port of openScreenshotEditor with the renderer-ready handshake queue.
pub fn open_screenshot_editor(
    window_bounds: Rect,
    png_bytes: Vec<u8>,
    initial_selection: Option<Rect>,
    task: Value,
) {
    let app = &ctx().app;
    ensure_editor_window();
    set_screenshot_pin_shortcut(true);
    let Some(win) = app.get_webview_window("editor") else { return };
    crate::appwindows::set_window_physical_bounds(&win, window_bounds);
    let mut payload = json!({});
    payload["imageBytesB64"] = json!(crate::imaging::base64_encode(&png_bytes));
    if let Some(selection) = initial_selection {
        payload["initialSelection"] = selection.to_json();
    }
    if let Some(obj) = task.as_object() {
        for (k, v) in obj {
            payload[k.clone()] = v.clone();
        }
    }
    let ready = ctx().state.lock().unwrap().screenshot_renderer_ready;
    if ready {
        let _ = app.emit_to("editor", "screenshot:begin", payload);
    } else {
        ctx().state.lock().unwrap().pending_screenshot_payload = Some(payload);
    }
}

pub fn ensure_editor_window() {
    let app = &ctx().app;
    if app.get_webview_window("editor").is_none() {
        let _ = crate::appwindows::build_editor_window(app);
        ctx().state.lock().unwrap().screenshot_renderer_ready = false;
    }
}

pub fn on_screenshot_renderer_ready() {
    let pending = {
        let mut state = ctx().state.lock().unwrap();
        state.screenshot_renderer_ready = true;
        state.pending_screenshot_payload.take()
    };
    if let Some(payload) = pending {
        let app = &ctx().app;
        let _ = app.emit_to("editor", "screenshot:begin", payload);
    }
}

pub fn on_screenshot_ready() {
    let app = &ctx().app;
    let Some(win) = app.get_webview_window("editor") else { return };
    set_screenshot_pin_shortcut(true);
    let _ = win.show();
    trace("capture-window-shown");
    let _ = win.set_focus();
}

/// Escape / cancel path: hide the editor, restore the pin being annotated.
pub fn close_screenshot_editor_task() {
    let edit_pin_id = ctx()
        .state
        .lock()
        .unwrap()
        .current_capture
        .as_ref()
        .and_then(|c| c.get("editPinId"))
        .and_then(|v| v.as_str())
        .map(String::from);
    crate::appwindows::hide_editor();
    let Some(id) = edit_pin_id else { return };
    ctx().state.lock().unwrap().current_capture = None;
    crate::pins::reveal_pin(&id, None);
}

/// Port of editPinImage: annotate an existing pin at its desktop position.
pub fn edit_pin_image(entry_id: &str) {
    let Some((_, session)) = crate::pins::pin_session_by_label_of(entry_id) else {
        return;
    };
    let app = &ctx().app;
    let Some(win) = app.get_webview_window(&session.label) else { return };
    let scale = win.scale_factor().unwrap_or(1.0);
    let physical = win.inner_position().ok().zip(win.inner_size().ok());
    let Some((pos, size)) = physical else { return };
    let margin = 30.0;
    let editor_logical = Rect {
        x: ((pos.x as f64 / scale) - margin).round() as i32,
        y: ((pos.y as f64 / scale) - margin).round() as i32,
        width: ((size.width as f64 / scale) + margin * 2.0).round() as i32,
        height: ((size.height as f64 / scale) + margin * 2.0).round() as i32,
    };
    let editor_physical = Rect {
        x: (editor_logical.x as f64 * scale).round() as i32,
        y: (editor_logical.y as f64 * scale).round() as i32,
        width: (editor_logical.width as f64 * scale).round() as i32,
        height: (editor_logical.height as f64 * scale).round() as i32,
    };
    {
        let mut state = ctx().state.lock().unwrap();
        state.current_capture = Some(json!({
            "editPinId": entry_id,
            "displayBounds": display_for_anchor((pos.x + 1, pos.y + 1))
                .map(|d| d.bounds.to_json())
                .unwrap_or(Value::Null),
            "sourceSize": { "width": session.width, "height": session.height },
        }));
    }
    let _ = win.hide();
    open_screenshot_editor(
        editor_physical,
        session.image_bytes.clone(),
        Some(Rect { x: 0, y: 0, width: session.width as i32, height: session.height as i32 }),
        json!({
            "editPinId": entry_id,
            "followSelection": false,
            "initialTool": "pen",
            "contentInset": { "left": margin as i64, "top": margin as i64, "right": margin as i64, "bottom": margin as i64 },
        }),
    );
}

/// screenshot:save flow (port of the ipcMain.handle body).
pub fn save_screenshot(payload: &Value) -> Value {
    trace("save-ipc-start");
    let bytes = payload
        .get("imageBytesB64")
        .and_then(|v| v.as_str())
        .and_then(crate::imaging::base64_decode)
        .unwrap_or_default();
    let Some((w, h)) = crate::core::png_size(&bytes) else {
        return json!({ "success": false, "message": "截图数据无效" });
    };
    let copy = payload.get("copy").and_then(|v| v.as_bool()).unwrap_or(true);
    let edit_pin_id = payload.get("editPinId").and_then(|v| v.as_str()).map(String::from);

    if let Some(edit_id) = &edit_pin_id {
        let current = ctx()
            .state
            .lock()
            .unwrap()
            .current_capture
            .as_ref()
            .and_then(|c| c.get("editPinId"))
            .and_then(|v| v.as_str())
            .map(String::from);
        if current.as_deref() != Some(edit_id.as_str()) {
            return json!({ "success": false, "message": "要标记的贴图已关闭" });
        }
        let updated = crate::pins::update_pin_image(edit_id, bytes.clone(), true);
        if !updated.get("success").and_then(|v| v.as_bool()).unwrap_or(false) {
            return updated;
        }
        if copy {
            crate::clipboard_native::write_image_png(&bytes);
            let mut state = ctx().state.lock().unwrap();
            state.suppress_sequence = Some(crate::clipboard_native::sequence_number());
        }
        crate::appwindows::hide_editor();
        ctx().state.lock().unwrap().current_capture = None;
        crate::pins::reveal_pin(edit_id, None);
        return json!({ "success": true, "id": edit_id, "editedPin": true });
    }

    let Some(entry) = add_image(
        bytes.clone(),
        ImageOpts { origin: Some("screenshot"), force: true, ..Default::default() },
    ) else {
        return json!({ "success": false, "message": "截图没有变化" });
    };
    trace("save-history-queued");
    if copy {
        crate::clipboard_native::write_image_png(&bytes);
        let mut state = ctx().state.lock().unwrap();
        state.suppress_sequence = Some(crate::clipboard_native::sequence_number());
    }
    let pin = payload.get("pin").and_then(|v| v.as_bool()).unwrap_or(false);
    if pin {
        let exact = {
            let state = ctx().state.lock().unwrap();
            state.current_capture.as_ref().and_then(|capture| {
                let display = capture.get("displayBounds")?;
                let source = capture.get("sourceSize")?;
                let display_rect = Rect {
                    x: display.get("x").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
                    y: display.get("y").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
                    width: display.get("width").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
                    height: display.get("height").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
                };
                let source_w = source.get("width").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let source_h = source.get("height").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let crop = payload.get("crop").cloned().unwrap_or(Value::Null);
                capture_pin_bounds(display_rect, (source_w, source_h), &crop)
            })
        };
        crate::appwindows::hide_editor();
        let entry_id = entry.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let result = crate::pins::open_pin_window(&entry, exact, bytes, (w, h));
        trace("pin-window-prepared");
        let _ = entry_id;
        return result;
    }
    crate::appwindows::hide_editor();
    json!({ "success": true, "id": entry.get("id").cloned().unwrap_or(Value::Null) })
}

/// screenshot:reselect — restart selection on the same capture.
pub fn reselect_screenshot() -> Value {
    let app = &ctx().app;
    let (Some(win), Some(capture)) = (
        app.get_webview_window("editor"),
        ctx().state.lock().unwrap().current_capture.clone(),
    ) else {
        return json!({ "success": false });
    };
    let Some(display) = capture.get("displayBounds").cloned() else {
        return json!({ "success": false });
    };
    let rect = Rect {
        x: display.get("x").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
        y: display.get("y").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
        width: display.get("width").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
        height: display.get("height").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
    };
    crate::appwindows::set_window_physical_bounds(&win, rect);
    let mut payload = json!({});
    if let Some(bytes_b64) = capture.get("imageBytesB64").cloned() {
        payload["imageBytesB64"] = bytes_b64;
    }
    let _ = app.emit_to("editor", "screenshot:begin", payload);
    let _ = win.set_focus();
    json!({ "success": true })
}

/// Persist the current capture's image bytes for reselect (kept alongside
/// current_capture when the editor opens).
pub fn remember_capture_bytes(bytes_b64: String) {
    let mut state = ctx().state.lock().unwrap();
    if let Some(capture) = state.current_capture.as_mut() {
        capture["imageBytesB64"] = json!(bytes_b64);
    }
}

pub fn quit_application() {
    {
        let mut state = ctx().state.lock().unwrap();
        state.quitting = true;
    }
    ShortcutHold::stop();
    let registered: Vec<i32> = ctx().state.lock().unwrap().registered_hotkeys.clone();
    for id in registered {
        ctx().msg.unhotkey(id);
    }
    // Drain in-flight image writes (bounded) before the final flush.
    for _ in 0..40 {
        if ctx().pending_image_writes.load(std::sync::atomic::Ordering::SeqCst) <= 0 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let state = ctx().state.lock().unwrap();
    crate::store::flush_sync(&state);
    ctx().app.exit(0);
}
