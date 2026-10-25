// All Tauri commands, one per window.clipboardAPI member. The JS adapter
// (src/bridge/tauri-adapter.js) keeps the renderer-facing names and maps them
// onto these snake_case commands; binary payloads travel as base64 fields
// (imageBytesB64) that the adapter converts in both directions.

use crate::clip_logic::{self, broadcast, broadcast_delta, public_entry, public_state, ImageOpts, TextOpts};
use crate::core::is_screenshot_entry;
use crate::ctx::ctx;
use crate::hold::ShortcutHold;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

fn sender_label(window: &tauri::WebviewWindow) -> String {
    window.label().to_string()
}

#[tauri::command]
pub fn get_state() -> Value {
    let mut state = ctx().state.lock().unwrap();
    public_state(&mut state)
}

#[tauri::command]
pub fn paste_entry(id: String) -> Value {
    let entry = {
        let state = ctx().state.lock().unwrap();
        match state.find_entry(&id) {
            Some(entry) => entry.clone(),
            None => return json!({ "success": false, "message": "这条内容已不存在" }),
        }
    };
    match clip_logic::paste_entry_flow(&entry) {
        Ok(()) => json!({ "success": true }),
        Err(message) => json!({ "success": false, "message": message }),
    }
}

#[tauri::command]
pub fn toggle_pin(id: String) -> Value {
    let mut state = ctx().state.lock().unwrap();
    let Some(entry) = state
        .entries
        .iter_mut()
        .find(|e| e.get("id").and_then(|v| v.as_str()) == Some(&id))
    else {
        return json!({ "success": false, "message": "这条内容已不存在" });
    };
    let pinned = !entry.get("pinned").and_then(|v| v.as_bool()).unwrap_or(false);
    if let Some(obj) = entry.as_object_mut() {
        obj.insert("pinned".into(), json!(pinned));
    }
    let updated = entry.clone();
    clip_logic::schedule_store(&state, None);
    let public = public_entry(&mut state, &updated);
    drop(state);
    broadcast_delta(json!({ "updatedEntry": public }));
    json!({ "success": true })
}

#[tauri::command]
pub fn delete_entry(id: String) -> Value {
    crate::pins::destroy_pin(&id);
    let removed = {
        let mut state = ctx().state.lock().unwrap();
        let removed = state
            .entries
            .iter()
            .find(|e| e.get("id").and_then(|v| v.as_str()) == Some(&id))
            .cloned();
        state.entries.retain(|e| e.get("id").and_then(|v| v.as_str()) != Some(&id));
        if let Some(path) = removed
            .as_ref()
            .and_then(|e| e.get("imagePath"))
            .and_then(|v| v.as_str())
        {
            state.thumbnail_cache.remove(path);
        }
        clip_logic::schedule_store(&state, None);
        removed
    };
    clip_logic::schedule_image_gc(2500);
    broadcast_delta(json!({ "removedIds": [id] }));
    let _ = removed;
    json!({ "success": true })
}

#[tauri::command]
pub fn create_entry(payload: Value) -> Value {
    if payload.get("type").and_then(|v| v.as_str()) == Some("image") {
        let png = crate::clipboard_native::read_png_bytes()
            .or_else(|| {
                crate::clipboard_native::read_dib_bgra()
                    .and_then(|(w, h, bgra)| crate::imaging::encode_png(w, h, &bgra).ok())
            });
        return match png {
            Some(bytes) => {
                let title = payload.get("title").and_then(|v| v.as_str()).map(String::from);
                match clip_logic::add_image(
                    bytes,
                    ImageOpts { custom: true, title, ..Default::default() },
                ) {
                    Some(_) => json!({ "success": true }),
                    None => json!({ "success": false, "message": "当前剪贴板里没有图片" }),
                }
            }
            None => json!({ "success": false, "message": "当前剪贴板里没有图片" }),
        };
    }
    let content = payload.get("content").and_then(|v| v.as_str()).unwrap_or("");
    let result = clip_logic::add_text(
        content,
        TextOpts {
            custom: true,
            title: payload.get("title").and_then(|v| v.as_str()).map(String::from),
            type_hint: payload.get("type").and_then(|v| v.as_str()).map(String::from),
            ..Default::default()
        },
    );
    match result {
        Some(_) => json!({ "success": true }),
        None => json!({ "success": false, "message": "请输入要保存的内容" }),
    }
}

#[tauri::command]
pub fn update_shortcut(accelerator: String) -> Value {
    crate::app_flow::register_app_shortcut(&accelerator, true)
}

#[tauri::command]
pub fn write_clipboard_text(text: String) -> Value {
    crate::clipboard_native::write_text(&text);
    json!({ "success": true })
}

#[tauri::command]
pub fn update_screenshot_shortcuts(shortcuts: Value) -> Value {
    // Kept for IPC compatibility; the settings dialog uses update_all_shortcuts.
    let _ = shortcuts;
    json!({ "success": true })
}

#[tauri::command]
pub fn set_shortcut_recording(active: bool) -> Value {
    crate::app_flow::set_shortcut_recording(active)
}

#[tauri::command]
pub fn update_all_shortcuts(shortcut: Option<String>, screenshot_shortcuts: Option<Value>) -> Value {
    crate::app_flow::update_all_shortcuts(
        shortcut,
        screenshot_shortcuts.unwrap_or_else(|| json!({})),
    )
}

#[tauri::command]
pub fn update_preferences(preferences: Value) -> Value {
    let merged = {
        let mut state = ctx().state.lock().unwrap();
        let current = state.preferences.clone();
        let mut combined = current;
        if let (Some(dst), Some(src)) = (combined.as_object_mut(), preferences.as_object()) {
            for (k, v) in src {
                dst.insert(k.clone(), v.clone());
            }
        }
        state.preferences = crate::core::merge_preferences(Some(&combined));
        clip_logic::trim_history(&mut state);
        clip_logic::schedule_store(&state, None);
        state.preferences.clone()
    };
    broadcast(json!({ "notice": "复制记录设置已更新" }));
    json!({ "success": true, "preferences": merged })
}

#[tauri::command]
pub fn open_screenshot_history() -> Value {
    crate::appwindows::show_history_window();
    json!({ "success": true })
}

#[tauri::command]
pub fn save_screenshot(payload: Value) -> Value {
    crate::app_flow::save_screenshot(&payload)
}

#[tauri::command]
pub fn reselect_screenshot() -> Value {
    crate::app_flow::reselect_screenshot()
}

#[tauri::command]
pub fn get_screenshot_history() -> Value {
    let mut state = ctx().state.lock().unwrap();
    let snapshot: Vec<Value> = state.entries.clone();
    let entries: Vec<Value> = snapshot
        .iter()
        .filter(|e| is_screenshot_entry(e))
        .map(|e| public_entry(&mut state, e))
        .collect();
    let pinned: Vec<String> = state.pin_sessions.keys().cloned().collect();
    let history_pin = state.screenshot_shortcut("historyPin");
    json!({
        "entries": entries,
        "pinnedIds": pinned,
        "historyPinShortcut": history_pin,
    })
}

#[tauri::command]
pub fn get_screenshot_entry(id: String) -> Value {
    let mut state = ctx().state.lock().unwrap();
    let Some(entry) = state
        .entries
        .iter()
        .find(|e| e.get("id").and_then(|v| v.as_str()) == Some(&id) && e.get("type").and_then(|v| v.as_str()) == Some("image"))
        .cloned()
    else {
        return Value::Null;
    };
    // Flat public entry + raw bytes, like the Electron handler returned.
    let public = public_entry(&mut state, &entry);
    let bytes = entry
        .get("imagePath")
        .and_then(|v| v.as_str())
        .and_then(|p| std::fs::read(p).ok())
        .unwrap_or_default();
    let mut out = public;
    if let Some(obj) = out.as_object_mut() {
        obj.insert("imageBytesB64".into(), json!(crate::imaging::base64_encode(&bytes)));
    }
    out
}

#[tauri::command]
pub fn pin_screenshot(id: String) -> Value {
    let entry = {
        let state = ctx().state.lock().unwrap();
        state
            .entries
            .iter()
            .find(|e| e.get("id").and_then(|v| v.as_str()) == Some(&id) && e.get("type").and_then(|v| v.as_str()) == Some("image"))
            .cloned()
    };
    let Some(entry) = entry else {
        return json!({ "success": false, "message": "截图不存在" });
    };
    let path = entry.get("imagePath").and_then(|v| v.as_str()).map(String::from);
    let bytes = path.as_ref().and_then(|p| std::fs::read(p).ok()).unwrap_or_default();
    let size = crate::core::png_size(&bytes)
        .or_else(|| {
            entry
                .get("width")
                .zip(entry.get("height"))
                .and_then(|(w, h)| Some((w.as_u64()? as u32, h.as_u64()? as u32)))
        })
        .unwrap_or((1, 1));
    if bytes.is_empty() {
        return json!({ "success": false, "message": "截图文件已不存在" });
    }
    crate::pins::open_pin_window(&entry, None, bytes, size)
}

#[tauri::command]
pub fn unpin_screenshot(id: String, window: tauri::WebviewWindow) -> Value {
    let label = sender_label(&window);
    let mapped = ctx().state.lock().unwrap().pin_sessions.contains_key(&id);
    if mapped {
        crate::pins::destroy_pin(&id);
        return json!({ "success": true, "closed": true });
    }
    if label.starts_with("pin") {
        crate::pins::close_pin_by_window(&label);
        return json!({ "success": true, "closed": true });
    }
    json!({ "success": true, "closed": false })
}

#[tauri::command]
pub fn close_current_pin(window: tauri::WebviewWindow) {
    let label = sender_label(&window);
    if label.starts_with("pin") {
        crate::pins::close_pin_by_window(&label);
    }
}

#[tauri::command]
pub fn show_pin_menu(id: String, has_selection: Option<bool>, _text_mode: Option<bool>, window: tauri::WebviewWindow) {
    let label = sender_label(&window);
    // Only the owning pin window may open its menu.
    let owner = ctx()
        .state
        .lock()
        .unwrap()
        .pin_sessions
        .get(&id)
        .map(|s| s.label.clone());
    if owner.as_deref() != Some(label.as_str()) {
        return;
    }
    crate::pins::show_pin_context_menu(&label, has_selection.unwrap_or(false));
}

#[tauri::command]
pub fn update_pin_image(id: String, image_bytes_b64: String, window: tauri::WebviewWindow) -> Value {
    let label = sender_label(&window);
    let owner = ctx()
        .state
        .lock()
        .unwrap()
        .pin_sessions
        .get(&id)
        .map(|s| s.label.clone());
    if owner.as_deref() != Some(label.as_str()) {
        return json!({ "success": false, "message": "贴图已关闭" });
    }
    let Some(bytes) = crate::imaging::base64_decode(&image_bytes_b64) else {
        return json!({ "success": false, "message": "图片变换结果无效" });
    };
    crate::pins::update_pin_image(&id, bytes, true)
}

#[tauri::command]
pub fn recognize_pin_text(id: String, window: tauri::WebviewWindow) -> Value {
    let label = sender_label(&window);
    let session = ctx()
        .state
        .lock()
        .unwrap()
        .pin_sessions
        .get(&id)
        .filter(|s| s.label == label)
        .map(|s| (s.image_bytes.clone(), s.width, s.height));
    let Some((bytes, w, h)) = session else {
        return json!({ "success": false, "message": "贴图已关闭" });
    };
    match crate::pins::recognize_pin_text_cached(&id, &bytes, w, h) {
        Ok(payload) => payload,
        Err(message) => json!({ "success": false, "message": format!("文字识别失败：{message}") }),
    }
}

#[tauri::command]
pub fn copy_pin_text(id: String, text: String, _window: tauri::WebviewWindow) -> Value {
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return json!({ "success": false, "message": "请先选择要复制的文字" });
    }
    let limited: String = trimmed.chars().take(100_000).collect();
    crate::clipboard_native::write_text(&limited);
    {
        let mut state = ctx().state.lock().unwrap();
        state.suppress_sequence = Some(crate::clipboard_native::sequence_number());
    }
    let char_count = limited.encode_utf16().count();
    let _ = id;
    json!({ "success": true, "charCount": char_count })
}

#[tauri::command]
pub fn zoom_pin(id: String, delta_y: Option<f64>, client_x: Option<f64>, client_y: Option<f64>, reset: Option<bool>, window: tauri::WebviewWindow) -> Value {
    let label = sender_label(&window);
    let owner = ctx()
        .state
        .lock()
        .unwrap()
        .pin_sessions
        .get(&id)
        .map(|s| s.label.clone());
    if owner.as_deref() != Some(label.as_str()) {
        return json!({ "success": false, "message": "贴图已关闭" });
    }
    crate::pins::zoom_pin(
        &id,
        &json!({
            "deltaY": delta_y.unwrap_or(0.0),
            "clientX": client_x.unwrap_or(0.0),
            "clientY": client_y.unwrap_or(0.0),
            "reset": reset.unwrap_or(false),
        }),
    )
}

#[tauri::command]
pub fn set_pin_opacity(id: String, opacity: f64, window: tauri::WebviewWindow) -> Value {
    let label = sender_label(&window);
    let owner = ctx()
        .state
        .lock()
        .unwrap()
        .pin_sessions
        .get(&id)
        .map(|s| s.label.clone());
    if owner.as_deref() != Some(label.as_str()) {
        return json!({ "success": false, "message": "贴图已关闭" });
    }
    crate::pins::set_pin_opacity(&id, opacity)
}

#[tauri::command]
pub fn move_pin(id: String, x: f64, y: f64, window: tauri::WebviewWindow) {
    let label = sender_label(&window);
    let owner = ctx()
        .state
        .lock()
        .unwrap()
        .pin_sessions
        .get(&id)
        .map(|s| s.label.clone());
    if owner.as_deref() != Some(label.as_str()) {
        return;
    }
    crate::pins::move_pin(&id, x, y);
}

#[tauri::command]
pub fn pin_renderer_ready(window: tauri::WebviewWindow) {
    crate::pins::mark_pin_renderer_ready(window.label());
}

#[tauri::command]
pub fn pin_image_ready(id: String, window: tauri::WebviewWindow) {
crate::pins::on_pin_image_ready(window.label(), &id);
}

#[tauri::command]
pub fn close_screenshot_editor() {
    crate::app_flow::close_screenshot_editor_task();
}

#[tauri::command]
pub fn close_screenshot_history() {
    if let Some(win) = ctx().app.get_webview_window("history") {
        let _ = win.hide();
    }
}

#[tauri::command]
pub fn hide_window() {
    crate::app_flow::hide_main();
}

#[tauri::command]
pub fn quit_app() {
    crate::app_flow::quit_application();
}

#[tauri::command]
pub fn set_window_mode(mode: String) -> Value {
    let app = &ctx().app;
    let Some(win) = app.get_webview_window("main") else {
        return json!({ "success": false });
    };
    let revision = {
        let mut state = ctx().state.lock().unwrap();
        state.mode_revision += 1;
        state.mode_revision
    };
    // The renderer already painted the destination page (double rAF) before
    // invoking this; commit the new bounds now, unless a newer request landed.
    let current = ctx().state.lock().unwrap().mode_revision;
    if revision != current {
        return json!({ "success": false });
    }
    let _ = &win;
    crate::app_flow::set_main_window_mode(if mode == "clipboard" { "clipboard" } else { "launcher" }, None);
    json!({ "success": true })
}

#[tauri::command]
pub async fn activate_launcher(session_id: Option<u64>, app: AppHandle) -> Value {
    if let Some(session) = session_id {
        if !ShortcutHold::is_pending() || ShortcutHold::session_id() != Some(session) {
            return json!({ "success": false });
        }
        if ShortcutHold::session_id() != Some(session) {
            return json!({ "success": false });
        }
        // Recheck native key ownership before accepting a click or pointer
        // release; the renderer key-up may still be in flight.
        if !ShortcutHold::check(&app, session) {
            return json!({ "success": false });
        }
        ShortcutHold::commit();
    }
    json!({ "success": true })
}

#[tauri::command]
pub fn release_launcher_shortcut() {
    let app = ctx().app.clone();
    ShortcutHold::release(&app);
}

#[tauri::command]
pub fn shortcut_key_up(key_code: i32) {
    let app = ctx().app.clone();
    ShortcutHold::key_up(&app, key_code);
}

#[tauri::command]
pub fn screenshot_renderer_ready() {
    crate::app_flow::on_screenshot_renderer_ready();
}

#[tauri::command]
pub fn screenshot_ready() {
    crate::app_flow::on_screenshot_ready();
}

pub fn emit_to(app: &AppHandle, label: &str, event: &str, payload: Value) {
    use tauri::Emitter;
    let _ = app.emit_to(label, event, payload);
}
