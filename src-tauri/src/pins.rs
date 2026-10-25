// Desktop pin windows: warm pool, exact placement, zoom/opacity/move, native
// context menu, save-to-file, secondary annotation entry. Session geometry is
// bookkept in logical (DIP) units like the Electron build; exact creation
// bounds arrive in physical pixels and convert once via the target monitor's
// scale factor.

use crate::core::{random_id, reset_pin_bounds, zoom_pin_bounds, Rect};
use crate::ctx::ctx;
use crate::state::PinSession;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

fn build_pin_window(app: &AppHandle, label: &str) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::App("pin.html".into()))
        .title("Pasty 贴图")
        .inner_size(1.0, 1.0)
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        // No DWM shadow: the outer frame would exceed the content area and
        // break exact 1:1 pin placement (spike-validated). The pin's edge
        // highlight comes from the CSS ::after overlay instead.
        .shadow(false)
        .visible(false)
        .build()
}

pub fn ensure_warm_pin() {
    let app = &ctx().app;
    let warm = {
        let state = ctx().state.lock().unwrap();
        state.warm_pin_label.clone()
    };
    if let Some(label) = warm {
        if app.get_webview_window(&label).is_some() {
            return;
        }
    }
    let mut state = ctx().state.lock().unwrap();
    state.pin_label_seq += 1;
    let label = format!("pin-warm-{}", state.pin_label_seq);
    drop(state);
    if build_pin_window(app, &label).is_ok() {
        ctx().state.lock().unwrap().warm_pin_label = Some(label);
    }
}

fn acquire_pin_label() -> String {
    ensure_warm_pin();
    let mut state = ctx().state.lock().unwrap();
    let taken = state
        .warm_pin_label
        .take()
        .filter(|label| ctx().app.get_webview_window(label).is_some());
    match taken {
        Some(label) => {
            drop(state);
            // Warm a replacement shell in the background.
            std::thread::spawn(ensure_warm_pin);
            label
        }
        None => {
            state.pin_label_seq += 1;
            format!("pin-{}", state.pin_label_seq)
        }
    }
}

fn pin_entry_public(entry: &Value) -> Value {
    let mut out = entry.clone();
    if let Some(obj) = out.as_object_mut() {
        obj.remove("imagePath");
    }
    out
}

/// port of openPinWindow: exact-bounds (physical) or clamped default placement.
pub fn open_pin_window(
    entry: &Value,
    exact_physical: Option<Rect>,
    image_bytes: Vec<u8>,
    size: (u32, u32),
) -> Value {
    let app = &ctx().app;
    let id = entry.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    // Reveal an already-pinned entry instead of duplicating it.
    if let Some(session) = ctx().state.lock().unwrap().pin_sessions.get(&id).cloned() {
        if let Some(win) = app.get_webview_window(&session.label) {
            let _ = win.set_always_on_top(true);
            let _ = win.show();
            let _ = win.set_focus();
            return json!({ "success": true });
        }
    }
    let label = acquire_pin_label();
    if std::env::var("PASTY_DEBUG").is_ok() {
        eprintln!("[dbg] open_pin_window id={id} label={label}");
    }
    let Some(win) = app.get_webview_window(&label) else {
        return json!({ "success": false, "message": "贴图窗口创建失败" });
    };
    let scale = win.scale_factor().unwrap_or(1.0);

    // Default placement: clamp to 520x420 logical, centered on the cursor
    // display work area (matches the Electron default branch).
    let target_physical: Rect = match exact_physical {
        Some(rect) => rect,
        None => {
            let display = crate::capture::cursor_display().ok();
            let scale_for_fit = display.as_ref().map(|d| d.scale).unwrap_or(1.0);
            let ratio = {
                let w = size.0 as f64;
                let h = size.1 as f64;
                (520.0 * scale_for_fit / w).min(420.0 * scale_for_fit / h).min(1.0)
            };
            let content_w = ((size.0 as f64 * ratio).round() as i32).max(1);
            let content_h = ((size.1 as f64 * ratio).round() as i32).max(1);
            match display {
                Some(d) => {
                    let x = d.work.x + (d.work.width - content_w) / 2;
                    let y = d.work.y + (d.work.height - content_h) / 2;
                    Rect { x, y, width: content_w, height: content_h }
                }
                None => Rect { x: 100, y: 100, width: content_w, height: content_h },
            }
        }
    };
    let _ = win.set_position(tauri::PhysicalPosition::new(target_physical.x, target_physical.y));
    let _ = win.set_size(tauri::PhysicalSize::new(
        target_physical.width.max(1) as u32,
        target_physical.height.max(1) as u32,
    ));
    let _ = win.set_always_on_top(true);

    // Base zoom bookkeeping in logical units.
    let base_width = target_physical.width as f64 / scale;
    let base_height = target_physical.height as f64 / scale;
    let entry_payload = {
        let mut public = pin_entry_public(entry);
        public["imageBytesB64"] = json!(crate::imaging::base64_encode(&image_bytes));
        json!({ "id": id, "entry": public })
    };
    let already_ready = ctx()
        .state
        .lock()
        .unwrap()
        .pin_renderer_labels
        .contains(&label);
    let session = PinSession {
        label: label.clone(),
        entry_id: id.clone(),
        image_bytes,
        image_path: entry
            .get("imagePath")
            .and_then(|v| v.as_str())
            .map(String::from),
        width: size.0,
        height: size.1,
        base_area: base_width * base_height,
        base_width,
        opacity: 1.0,
        renderer_ready: already_ready,
        pending_payload: Some(entry_payload),
    };
    {
        let mut state = ctx().state.lock().unwrap();
        state.pin_sessions.insert(id.clone(), session);
    }
    // The warm window may carry a previous pin's faded state; the adapter
    // resets page opacity when it receives the pin payload.
    let _ = win.emit_to(&label, "pin:set-opacity", json!({ "opacity": 1.0 }));
    send_pending_pin(&label);
    if std::env::var("PASTY_DEBUG").is_ok() {
        eprintln!("[dbg] pin session inserted, sending pending + reveal timer");
    }
    let reveal_label = label.clone();
    let reveal_id = id.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(180));
        reveal_pin(&reveal_id, Some(&reveal_label));
    });
    json!({ "success": true })
}

pub fn send_pending_pin(label: &str) {
    let app = &ctx().app;
    let pending = {
        let mut state = ctx().state.lock().unwrap();
        let Some(session) = state
            .pin_sessions
            .values_mut()
            .find(|s| s.label == label)
        else {
            return;
        };
        if !session.renderer_ready {
            return;
        }
        session.pending_payload.take()
    };
    if let Some(payload) = pending {
        if std::env::var("PASTY_DEBUG").is_ok() {
            eprintln!("[dbg] pin:show emitted to {label}");
        }
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.emit_to(label, "pin:show", payload);
        }
    }
}

/// Show as activated, reassert always-on-top, moveTop equivalent, then repeat
/// the top assertion shortly after (pin visibility ordering contract).
pub fn reveal_pin(entry_id: &str, label_hint: Option<&str>) {
    let app = &ctx().app;
    let label = {
        let state = ctx().state.lock().unwrap();
        match state.pin_sessions.get(entry_id) {
            Some(session) => session.label.clone(),
            None => label_hint.unwrap_or("").to_string(),
        }
    };
    let Some(win) = app.get_webview_window(&label) else { return };
    if win.is_visible().unwrap_or(false) {
        return;
    }
    let _ = win.set_always_on_top(true);
    let _ = win.show();
    if std::env::var("PASTY_DEBUG").is_ok() {
        eprintln!("[dbg] reveal_pin label={label}");
    }
    crate::ctx::trace("pin-window-shown");
    let _ = win.set_focus();
    let label2 = label.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(80));
        if let Some(win) = ctx().app.get_webview_window(&label2) {
            let _ = win.set_always_on_top(true);
            let _ = win.show();
        }
    });
}

fn pin_window_bounds_logical(win: &WebviewWindow) -> Option<Rect> {
    let pos = win.inner_position().ok()?;
    let size = win.inner_size().ok()?;
    let scale = win.scale_factor().unwrap_or(1.0);
    Some(Rect {
        x: (pos.x as f64 / scale).round() as i32,
        y: (pos.y as f64 / scale).round() as i32,
        width: (size.width as f64 / scale).round() as i32,
        height: (size.height as f64 / scale).round() as i32,
    })
}

fn set_pin_bounds_logical(win: &WebviewWindow, rect: Rect) {
    let scale = win.scale_factor().unwrap_or(1.0);
    let _ = win.set_position(tauri::PhysicalPosition::new(
        (rect.x as f64 * scale).round() as i32,
        (rect.y as f64 * scale).round() as i32,
    ));
    let _ = win.set_size(tauri::PhysicalSize::new(
        (rect.width as f64 * scale).round().max(1.0) as u32,
        (rect.height as f64 * scale).round().max(1.0) as u32,
    ));
}

/// Port of zoomPinWindow. pointer values are CSS (logical) client coords.
pub fn zoom_pin(entry_id: &str, payload: &Value) -> Value {
    let app = &ctx().app;
    let label = {
        let state = ctx().state.lock().unwrap();
        match state.pin_sessions.get(entry_id) {
            Some(s) => s.label.clone(),
            None => return json!({ "success": false, "message": "贴图已关闭" }),
        }
    };
    let Some(win) = app.get_webview_window(&label) else {
        return json!({ "success": false, "message": "贴图已关闭" });
    };
    let (image_w, image_h, base_width) = {
        let state = ctx().state.lock().unwrap();
        let s = state.pin_sessions.get(entry_id).unwrap();
        (s.width, s.height, s.base_width)
    };
    let ratio = if image_w > 0 && image_h > 0 {
        image_w as f64 / image_h as f64
    } else {
        0.0
    };
    let Some(bounds) = pin_window_bounds_logical(&win) else {
        return json!({ "success": false, "message": "贴图已关闭" });
    };
    let next = if payload.get("reset").and_then(|v| v.as_bool()).unwrap_or(false) {
        let base_area = ctx().state.lock().unwrap().pin_sessions.get(entry_id).map(|s| s.base_area).unwrap_or(bounds.width as f64 * bounds.height as f64);
        reset_pin_bounds(bounds, base_area, ratio)
    } else {
        let pointer_x = payload.get("clientX").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let pointer_y = payload.get("clientY").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let delta = payload.get("deltaY").and_then(|v| v.as_f64()).unwrap_or(0.0);
        zoom_pin_bounds(bounds, (pointer_x, pointer_y), delta, ratio)
    };
    set_pin_bounds_logical(&win, next);
    let _ = win.set_always_on_top(true);
    let _ = win.set_focus();
    let scale = if base_width > 0.0 {
        next.width as f64 / base_width
    } else {
        1.0
    };
    json!({
        "success": true,
        "bounds": next.to_json(),
        "scale": (scale * 100.0).round() / 100.0,
    })
}

pub fn set_pin_opacity(entry_id: &str, requested: f64) -> Value {
    if !requested.is_finite() {
        return json!({ "success": false, "message": "不透明度无效" });
    }
    let opacity = requested.min(1.0).max(0.15);
    let app = &ctx().app;
    let label = {
        let mut state = ctx().state.lock().unwrap();
        let Some(session) = state.pin_sessions.get_mut(entry_id) else {
            return json!({ "success": false, "message": "贴图已关闭" });
        };
        session.opacity = opacity;
        session.label.clone()
    };
    if let Some(win) = app.get_webview_window(&label) {
        // Page-level opacity via the adapter (WebView2 content is not covered
        // by Win32 layered-window alpha applied to the host window alone).
        let _ = win.emit_to(&label, "pin:set-opacity", json!({ "opacity": opacity }));
    }
    json!({ "success": true, "opacity": opacity })
}

/// Drag movement: renderer sends screenX/Y deltas (physical desktop pixels).
pub fn move_pin(entry_id: &str, x: f64, y: f64) {
    let app = &ctx().app;
    let label = {
        let state = ctx().state.lock().unwrap();
        match state.pin_sessions.get(entry_id) {
            Some(s) => s.label.clone(),
            None => return,
        }
    };
    if !x.is_finite() || !y.is_finite() {
        return;
    }
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.set_position(tauri::PhysicalPosition::new(x.round() as i32, y.round() as i32));
        let _ = win.set_always_on_top(true);
    }
}

/// Port of updatePinImage (rotate/flip/annotate results from the renderer).
pub fn update_pin_image(entry_id: &str, bytes: Vec<u8>, notify_renderer: bool) -> Value {
    let Some((w, h)) = crate::core::png_size(&bytes) else {
        return json!({ "success": false, "message": "图片变换结果无效" });
    };
    let app = &ctx().app;
    let (label, entry_exists) = {
        let mut state = ctx().state.lock().unwrap();
        let (label, base_area) = {
            let Some(session) = state.pin_sessions.get_mut(entry_id) else {
                return json!({ "success": false, "message": "贴图已关闭" });
            };
            (session.label.clone(), session.base_area)
        };
        let entry_exists = state
            .entries
            .iter()
            .any(|e| e.get("id").and_then(|v| v.as_str()) == Some(entry_id));
        let ratio = w as f64 / h as f64;
        let Some(win) = app.get_webview_window(&label) else {
            return json!({ "success": false, "message": "贴图已关闭" });
        };
        let Some(bounds) = pin_window_bounds_logical(&win) else {
            return json!({ "success": false, "message": "贴图已关闭" });
        };
        let next = reset_pin_bounds(bounds, base_area, ratio);
        {
            let Some(session) = state.pin_sessions.get_mut(entry_id) else {
                return json!({ "success": false, "message": "贴图已关闭" });
            };
            session.image_bytes = bytes.clone();
            session.image_path = None;
            session.width = w;
            session.height = h;
            // The area-preserving reset size becomes the new 100% zoom reference.
            session.base_area = next.width as f64 * next.height as f64;
            session.base_width = next.width as f64;
        }
        set_pin_bounds_logical(&win, next);
        let _ = win.set_always_on_top(true);
        let _ = win.show();
        ctx().ocr_cache.lock().unwrap().delete(entry_id);
        (label, entry_exists)
    };
    if notify_renderer && entry_exists {
        let payload = {
            let state = ctx().state.lock().unwrap();
            let entry = state.entries.iter().find(|e| e.get("id").and_then(|v| v.as_str()) == Some(entry_id)).cloned();
            let _session = state.pin_sessions.get(entry_id).unwrap();
            match entry {
                Some(mut entry) => {
                    let mut public = pin_entry_public(&entry);
                    if let Some(obj) = public.as_object_mut() {
                        obj.insert("width".into(), json!(w));
                        obj.insert("height".into(), json!(h));
                        obj.insert("content".into(), json!(format!("{w} × {h} · PNG")));
                        obj.insert("imageBytesB64".into(), json!(crate::imaging::base64_encode(&bytes)));
                    }
                    let _ = &mut entry;
                    json!({ "id": entry_id, "entry": public })
                }
                None => json!({ "id": entry_id, "entry": { "id": entry_id, "width": w, "height": h, "imageBytesB64": crate::imaging::base64_encode(&bytes) } }),
            }
        };
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.emit_to(&label, "pin:show", payload);
        }
    }
    json!({
        "success": true,
        "imageBytesB64": crate::imaging::base64_encode(&bytes),
        "size": { "width": w, "height": h },
    })
}

pub fn destroy_pin(entry_id: &str) {
    let app = &ctx().app;
    let label = {
        let mut state = ctx().state.lock().unwrap();
        state.pin_sessions.remove(entry_id).map(|s| s.label)
    };
    if let Some(label) = label {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.destroy();
        }
    }
    ctx().ocr_cache.lock().unwrap().delete(entry_id);
}

/// Hover-close / context-menu close path: works from the sender window itself
/// without knowing the pin id (pin:close-current contract).
pub fn close_pin_by_window(label: &str) {
    let entry_id = {
        let state = ctx().state.lock().unwrap();
        state
            .pin_sessions
            .iter()
            .find(|(_, s)| s.label == label)
            .map(|(id, _)| id.clone())
    };
    match entry_id {
        Some(id) => destroy_pin(&id),
        None => {
            // A warm shell never carries content; just hide it.
            if let Some(win) = ctx().app.get_webview_window(label) {
                let _ = win.destroy();
            }
        }
    }
}

/// Session lookup by entry id (used by edit/annotate flows).
pub fn pin_session_by_label_of(entry_id: &str) -> Option<(String, PinSession)> {
    pin_session_by_entry(entry_id)
}

pub fn pin_session_by_entry(entry_id: &str) -> Option<(String, PinSession)> {
    let state = ctx().state.lock().unwrap();
    state.pin_sessions.get(entry_id).map(|s| {
        (
            s.entry_id.clone(),
            PinSession {
                label: s.label.clone(),
                entry_id: s.entry_id.clone(),
                image_bytes: s.image_bytes.clone(),
                image_path: s.image_path.clone(),
                width: s.width,
                height: s.height,
                base_area: s.base_area,
                base_width: s.base_width,
                opacity: s.opacity,
                renderer_ready: s.renderer_ready,
                pending_payload: s.pending_payload.clone(),
            },
        )
    })
}

pub fn pin_session_by_label(label: &str) -> Option<(String, PinSession)> {    let state = ctx().state.lock().unwrap();
    state
        .pin_sessions
        .iter()
        .find(|(_, s)| s.label == label)
        .map(|(id, s)| (id.clone(), PinSession {
            label: s.label.clone(),
            entry_id: s.entry_id.clone(),
            image_bytes: s.image_bytes.clone(),
            image_path: s.image_path.clone(),
            width: s.width,
            height: s.height,
            base_area: s.base_area,
            base_width: s.base_width,
            opacity: s.opacity,
            renderer_ready: s.renderer_ready,
            pending_payload: s.pending_payload.clone(),
        }))
}

pub fn mark_pin_renderer_ready(label: &str) {
    {
        let mut state = ctx().state.lock().unwrap();
        state.pin_renderer_labels.insert(label.to_string());
        if let Some(session) = state
            .pin_sessions
            .values_mut()
            .find(|s| s.label == label)
        {
            session.renderer_ready = true;
        }
    }
    send_pending_pin(label);
}

/// pin:image-ready — the renderer finished decoding; reveal immediately and
/// start background OCR prewarming (+120ms like Electron).
pub fn on_pin_image_ready(label: &str, entry_id: &str) {
    let session = pin_session_by_label(label);
    let Some((id, session)) = session else { return };
    if session.entry_id != entry_id {
        return;
    }
    crate::ctx::trace("pin-image-ready");
    reveal_pin(&id, Some(label));
    let bytes = session.image_bytes.clone();
    let (w, h) = (session.width, session.height);
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(120));
        let _ = recognize_pin_text_cached(&id, &bytes, w, h);
    });
}

/// OCR with the shared LRU (createPinOcrCache port); failures are not cached.
pub fn recognize_pin_text_cached(entry_id: &str, bytes: &[u8], w: u32, h: u32) -> Result<Value, String> {
    {
        let mut cache = ctx().ocr_cache.lock().unwrap();
        if let Some(hit) = cache.get(entry_id) {
            return hit;
        }
    }
    let result = crate::ocr::recognize_payload(bytes, w, h);
    if let Ok(value) = &result {
        ctx().ocr_cache.lock().unwrap().put(entry_id.to_string(), Ok(value.clone()));
    }
    result
}

// ---------------------------------------------------------------- native context menu

pub fn show_pin_context_menu(label: &str, has_selection: bool) {
    let app = &ctx().app;
    let Some((entry_id, _session)) = pin_session_by_label(label) else { return };
    let label_owned = label.to_string();

    // muda menus are built and shown on the main thread (TrackPopupMenu runs a
    // modal loop on the calling thread; the pin hwnd may belong to it).
    let app_for_thread = app.clone();
    let run = move || {
        use muda::{CheckMenuItem, ContextMenu, Menu, MenuItem, PredefinedMenuItem, Submenu};
        let build = || -> muda::Result<Menu> {
            let menu = Menu::new();
            if has_selection {
                menu.append(&MenuItem::with_id("pinmenu-copy-selection", "复制所选文字", true, None))?;
                menu.append(&MenuItem::with_id("pinmenu-finish-text", "退出选字", true, None))?;
                menu.append(&PredefinedMenuItem::separator())?;
            }
            menu.append(&MenuItem::with_id("pinmenu-save", "保存到本地…", true, None))?;
            menu.append(&MenuItem::with_id("pinmenu-edit", "再次涂鸦标记", true, None))?;
            menu.append(&PredefinedMenuItem::separator())?;
            menu.append(&MenuItem::with_id("pinmenu-rotate-left", "向左旋转", true, None))?;
            menu.append(&MenuItem::with_id("pinmenu-rotate-right", "向右旋转", true, None))?;
            menu.append(&MenuItem::with_id("pinmenu-flip-horizontal", "水平翻转（镜像）", true, None))?;
            menu.append(&MenuItem::with_id("pinmenu-flip-vertical", "垂直翻转（镜像）", true, None))?;
            menu.append(&PredefinedMenuItem::separator())?;
            let zoom = Submenu::with_id_and_items(
                "pinmenu-zoom",
                "缩放",
                true,
                &[
                    &MenuItem::with_id("pinmenu-zoom-in", "放大", true, None),
                    &MenuItem::with_id("pinmenu-zoom-out", "缩小", true, None),
                    &MenuItem::with_id("pinmenu-zoom-reset", "恢复初始大小", true, None),
                ],
            )?;
            menu.append(&zoom)?;
            let current = pin_session_by_label(&label_owned).map(|(_, s)| s.opacity).unwrap_or(1.0);
            let mut opacity_items: Vec<CheckMenuItem> = Vec::new();
            for value in [1.0f64, 0.8, 0.6, 0.4, 0.2] {
                let id = format!("pinmenu-opacity-{}", (value * 100.0).round() as i32);
                let checked = (current - value).abs() < 0.001;
                opacity_items.push(CheckMenuItem::with_id(id, format!("{}%", (value * 100.0).round() as i32), true, checked, None));
            }
            let refs: Vec<&dyn muda::IsMenuItem> =
                opacity_items.iter().map(|item| item as &dyn muda::IsMenuItem).collect();
            let opacity = Submenu::with_id_and_items("pinmenu-opacity", "不透明度", true, &refs)?;
            menu.append(&opacity)?;
            menu.append(&PredefinedMenuItem::separator())?;
            menu.append(&MenuItem::with_id("pinmenu-close", "关闭贴图", true, None))?;
            Ok(menu)
        };
        let Ok(menu) = build() else { return };
        *ctx().pin_menu_target.lock().unwrap() = Some((entry_id.clone(), label_owned.clone()));
        if let Some(win) = app_for_thread.get_webview_window(&label_owned) {
            if let Ok(hwnd) = win.hwnd() {
                unsafe {
                    let _ = menu.show_context_menu_for_hwnd(hwnd.0 as isize, None);
                }
            }
        }
    };
    let _ = app.run_on_main_thread(run);
}

fn pin_menu_command(app: &AppHandle, entry_id: &str, label: &str, command: &str) {
    let send = |text: &str| {
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.emit_to(label, "pin:menu-command", text);
        }
    };
    let center_zoom = |delta: f64| {
        if let Some(win) = app.get_webview_window(label) {
            if let Some(bounds) = pin_window_bounds_logical(&win) {
                let _ = zoom_pin(
                    entry_id,
                    &json!({
                        "deltaY": delta,
                        "clientX": bounds.width as f64 / 2.0,
                        "clientY": bounds.height as f64 / 2.0,
                    }),
                );
            }
        }
    };
    match command {
        "pinmenu-copy-selection" => send("copy-selection"),
        "pinmenu-finish-text" => send("finish-text-selection"),
        "pinmenu-save" => save_pin_to_file(entry_id, label),
        "pinmenu-edit" => crate::app_flow::edit_pin_image(entry_id),
        "pinmenu-rotate-left" => send("rotate-left"),
        "pinmenu-rotate-right" => send("rotate-right"),
        "pinmenu-flip-horizontal" => send("flip-horizontal"),
        "pinmenu-flip-vertical" => send("flip-vertical"),
        "pinmenu-zoom-in" => center_zoom(-100.0),
        "pinmenu-zoom-out" => center_zoom(100.0),
        "pinmenu-zoom-reset" => {
            let _ = zoom_pin(entry_id, &json!({ "reset": true }));
        }
        "pinmenu-close" => destroy_pin(entry_id),
        other if other.starts_with("pinmenu-opacity-") => {
            let percent: f64 = other
                .trim_start_matches("pinmenu-opacity-")
                .parse()
                .unwrap_or(100.0);
            // Routed through the renderer so its opacity state stays the
            // single source of truth for later Ctrl+wheel steps.
            send(&format!("set-opacity:{}", percent / 100.0));
        }
        _ => {}
    }
}

/// Dispatch a menu event routed from main.rs (tray ids handled separately).
pub fn handle_menu_event(id: &str) {
    if !id.starts_with("pinmenu-") {
        return;
    }
    let target = ctx().pin_menu_target.lock().unwrap().clone();
    if let Some((entry_id, label)) = target {
        pin_menu_command(&ctx().app, &entry_id, &label, id);
    }
}

pub fn notify_pin_operation(label: &str, result: Value) {
    if let Some(win) = ctx().app.get_webview_window(label) {
        let _ = win.emit_to(label, "pin:operation-result", result);
    }
}

/// GetSaveFileNameW based save-to-file (comdlg32, no extra runtime deps).
pub fn save_pin_to_file(entry_id: &str, label: &str) {
    let Some((_, session)) = pin_session_by_label(label) else { return };
    let app = &ctx().app;
    let title = {
        let state = ctx().state.lock().unwrap();
        state
            .entries
            .iter()
            .find(|e| e.get("id").and_then(|v| v.as_str()) == Some(entry_id))
            .and_then(|e| e.get("title").and_then(|v| v.as_str()).map(String::from))
            .unwrap_or_else(|| "贴图".into())
    };
    let sanitized: String = title
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .take(80)
        .collect();
    let base = if sanitized.trim().is_empty() { "贴图".to_string() } else { sanitized };
    let pictures = std::env::var_os("USERPROFILE")
        .map(|home| std::path::PathBuf::from(home).join("Pictures"))
        .unwrap_or_default();
    let default_path = pictures.join(format!("{base}.png"));

    let Some(path) = prompt_save_png(app, &default_path) else {
        return;
    };
    match std::fs::write(&path, &session.image_bytes) {
        Ok(()) => {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            notify_pin_operation(label, json!({ "success": true, "message": format!("已保存到 {name}") }));
        }
        Err(error) => {
            notify_pin_operation(label, json!({ "success": false, "message": format!("保存失败：{error}") }));
        }
    }
}

fn prompt_save_png(_app: &AppHandle, default_path: &std::path::Path) -> Option<std::path::PathBuf> {
    use windows::Win32::UI::Controls::Dialogs::{
        GetSaveFileNameW, OFN_EXPLORER, OFN_NOCHANGEDIR, OFN_NOREADONLYRETURN, OFN_OVERWRITEPROMPT,
        OFN_PATHMUSTEXIST, OPENFILENAMEW,
    };
    let mut file_buf: Vec<u16> = default_path.to_string_lossy().encode_utf16().collect();
    file_buf.resize(1024, 0);
    let filter: Vec<u16> = "PNG 图片\0*.png\0\0"
        .encode_utf16()
        .collect();
    let def_ext: Vec<u16> = "png".encode_utf16().chain(std::iter::once(0)).collect();
    let title: Vec<u16> = "保存固定截图".encode_utf16().chain(std::iter::once(0)).collect();
    let initial_dir: Vec<u16> = default_path
        .parent()
        .map(|p| p.to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect())
        .unwrap_or_default();
    let mut ofn = OPENFILENAMEW {
        lStructSize: std::mem::size_of::<OPENFILENAMEW>() as u32,
        hwndOwner: Default::default(),
        hInstance: Default::default(),
        lpstrFilter: windows::core::PCWSTR(filter.as_ptr()),
        lpstrCustomFilter: windows::core::PWSTR::null(),
        nMaxCustFilter: 0,
        nFilterIndex: 1,
        lpstrFile: windows::core::PWSTR(file_buf.as_mut_ptr()),
        nMaxFile: file_buf.len() as u32,
        lpstrFileTitle: windows::core::PWSTR::null(),
        nMaxFileTitle: 0,
        lpstrInitialDir: if initial_dir.is_empty() {
            windows::core::PCWSTR::null()
        } else {
            windows::core::PCWSTR(initial_dir.as_ptr())
        },
        lpstrTitle: windows::core::PCWSTR(title.as_ptr()),
        Flags: OFN_EXPLORER | OFN_PATHMUSTEXIST | OFN_OVERWRITEPROMPT | OFN_NOREADONLYRETURN | OFN_NOCHANGEDIR,
        nFileOffset: 0,
        nFileExtension: 0,
        lpstrDefExt: windows::core::PCWSTR(def_ext.as_ptr()),
        lCustData: windows::Win32::Foundation::LPARAM(0),
        lpfnHook: None,
        lpTemplateName: windows::core::PCWSTR::null(),
        pvReserved: std::ptr::null_mut(),
        dwReserved: 0,
        FlagsEx: windows::Win32::UI::Controls::Dialogs::OPEN_FILENAME_FLAGS_EX(0),
    };
    unsafe {
        if GetSaveFileNameW(&mut ofn).as_bool() {
            let len = file_buf.iter().position(|c| *c == 0).unwrap_or(file_buf.len());
            Some(std::path::PathBuf::from(String::from_utf16_lossy(&file_buf[..len])))
        } else {
            None
        }
    }
}

pub fn spawn_replacement_warm() {
    std::thread::spawn(ensure_warm_pin);
}

pub fn new_pin_label() -> String {
    format!("pin-{}", random_id())
}
