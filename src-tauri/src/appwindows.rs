// Window lifecycle for the four persistent surfaces (main, toast, editor,
// history). Pin windows live in pins.rs. Sizes follow the Electron values in
// logical (DIP) units; placement math runs on physical pixels from capture.rs.

use crate::capture::{cursor_display, cursor_position};
use crate::core::Rect;
use crate::ctx::{ctx, trace};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub fn build_main_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Pasty")
        .inner_size(520.0, 520.0)
        .min_inner_size(440.0, 480.0)
        .decorations(false)
        .transparent(true)
        .resizable(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(true)
        .visible(false)
        .on_page_load(|win, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished && win.label() == "main" {
                first_load_reveal();
            }
        })
        .build()
}

/// did-finish-load port: broadcast the full state and reveal the launcher once.
fn first_load_reveal() {
    let already = {
        let mut state = ctx().state.lock().unwrap();
        if state.main_loaded {
            true
        } else {
            state.main_loaded = true;
            false
        }
    };
    if already {
        return;
    }
    let full = {
        let mut state = ctx().state.lock().unwrap();
        let mut payload = crate::clip_logic::public_state(&mut state);
        payload["full"] = serde_json::json!(true);
        payload
    };
    crate::ctx::emit_main("clipboard:state-changed", full);
    crate::app_flow::show_main_window(false);
}

pub fn build_toast_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let win = WebviewWindowBuilder::new(
        app,
        "toast",
        WebviewUrl::App("capture.html".into()),
    )
    .title("Pasty Capture")
    .inner_size(360.0, 96.0)
    .decorations(false)
    .transparent(true)
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .visible(false)
    .build()?;
    let _ = win.set_ignore_cursor_events(true);
    Ok(win)
}

pub fn build_editor_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(
        app,
        "editor",
        WebviewUrl::App("screenshot.html".into()),
    )
    .title("Pasty 截图")
    .inner_size(1.0, 1.0)
    .decorations(false)
    .transparent(true)
    .resizable(false)
    .maximizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .visible(false)
    .build()
}

pub fn build_history_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(
        app,
        "history",
        WebviewUrl::App("screenshot-history.html".into()),
    )
    .title("Pasty 截图历史")
    .inner_size(820.0, 650.0)
    .min_inner_size(620.0, 480.0)
    .decorations(false)
    .transparent(true)
    .resizable(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(true)
    .visible(false)
    .build()
}

pub fn show_history_window() {
    let app = &ctx().app;
    let win = match app.get_webview_window("history") {
        Some(win) => win,
        None => match build_history_window(app) {
            Ok(win) => win,
            Err(_) => return,
        },
    };
    if let Ok(display) = cursor_display() {
        let scale = display.scale;
        let work = display.work;
        let size = win.inner_size().unwrap_or(PhysicalSize::new(820, 650));
        let logical_w = size.width as f64 / scale;
        let logical_h = size.height as f64 / scale;
        let work_logical_w = work.width as f64 / scale;
        let work_logical_h = work.height as f64 / scale;
        let x = work.x as f64 / scale + (work_logical_w - logical_w) / 2.0;
        let y = work.y as f64 / scale + (work_logical_h - logical_h) / 2.0;
        let _ = win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
    }
    let _ = win.show();
    let _ = win.set_focus();
    let _ = app.emit_to("history", "screenshot:history-refresh", Value::Null);
}

/// Bottom-right copy toast on the cursor's display (showInactive equivalent:
/// the toast window is non-focusable).
static TOAST_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn show_toast(entry: Value) {
    let app = &ctx().app;
    let Some(win) = app.get_webview_window("toast") else { return };
    let generation = TOAST_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let _ = app.emit_to("toast", "capture:show", entry);
    if let Ok(display) = cursor_display() {
        let scale = display.scale;
        let work = display.work;
        let logical_w = 360.0;
        let logical_h = 96.0;
        let margin = 24.0;
        let x = work.x as f64 / scale + work.width as f64 / scale - logical_w - margin;
        let y = work.y as f64 / scale + work.height as f64 / scale - logical_h - margin;
        let _ = win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
    }
    let _ = win.show();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(2200));
        let current = TOAST_GENERATION.load(std::sync::atomic::Ordering::SeqCst);
        if current == generation {
            if let Some(win) = ctx().app.get_webview_window("toast") {
                let _ = win.hide();
            }
        }
    });
}

/// Hide the fullscreen editor (unregisters the native F4 hotkey with it).
pub fn hide_editor() {
    crate::app_flow::set_screenshot_pin_shortcut(false);
    if let Some(win) = ctx().app.get_webview_window("editor") {
        let _ = win.hide();
    }
}

pub fn editor_visible() -> bool {
    ctx().app
        .get_webview_window("editor")
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false)
}

/// Place a window over a physical monitor rect (used by the screenshot editor).
pub fn set_window_physical_bounds(win: &WebviewWindow, rect: Rect) {
    let _ = win.set_position(PhysicalPosition::new(rect.x, rect.y));
    let _ = win.set_size(PhysicalSize::new(
        rect.width.max(1) as u32,
        rect.height.max(1) as u32,
    ));
}

// Trace helper re-exports for window flows.
pub fn trace_screenshot(label: &str) {
    trace(label);
}

pub fn current_cursor() -> (i32, i32) {
    cursor_position()
}
