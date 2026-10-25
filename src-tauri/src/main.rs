// Pasty main process entry: single instance, tray, windows, message-window
// dispatch (hotkeys + clipboard events), and the Tauri event wiring that
// replaces electron/main.cjs.

mod app_flow;
mod appwindows;
mod capture;
mod clip_logic;
mod clipboard_native;
mod core;
mod ctx;
mod foreground;
mod hold;
mod imaging;
mod ipc;
mod msg_window;
mod ocr;
mod paste;
mod pins;
mod shortcuts;
mod state;
mod store;

use ctx::Ctx;
use msg_window::MsgEvent;
use serde_json::{json, Value};
use state::AppState;
use tauri::{AppHandle, Manager, WindowEvent};

static APP_USER_MODEL_ID: &str = "com.local.pasty";

fn main() {
    unsafe {
        let wide: Vec<u16> = APP_USER_MODEL_ID.encode_utf16().chain(std::iter::once(0)).collect();
        let _ = windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(windows::core::PCWSTR(wide.as_ptr()));
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {
            // Second instance: a fresh invocation samples the mouse again.
            app_flow::show_main_window(false);
        }))
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => match window.label() {
                "main" => {
                    api.prevent_close();
                    app_flow::hide_main();
                }
                "editor" => {
                    api.prevent_close();
                    app_flow::close_screenshot_editor_task();
                }
                _ => {}
            },
            WindowEvent::Focused(false) => {
                if window.label() == "main" {
                    app_flow::hide_main();
                }
            }
            WindowEvent::Destroyed => {
                let label = window.label().to_string();
                let mut state = ctx::ctx().state.lock().unwrap();
                let owned = state
                    .pin_sessions
                    .values()
                    .find(|s| s.label == label)
                    .map(|s| s.entry_id.clone());
                if let Some(id) = owned {
                    drop(state);
                    ctx::ctx().state.lock().unwrap().pin_sessions.remove(&id);
                    ctx::ctx().ocr_cache.lock().unwrap().delete(&id);
                    return;
                }
                if state.warm_pin_label.as_deref() == Some(&label) {
                    state.warm_pin_label = None;
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            ipc::get_state,
            ipc::paste_entry,
            ipc::toggle_pin,
            ipc::delete_entry,
            ipc::create_entry,
            ipc::update_shortcut,
            ipc::write_clipboard_text,
            ipc::update_screenshot_shortcuts,
            ipc::set_shortcut_recording,
            ipc::update_all_shortcuts,
            ipc::update_preferences,
            ipc::open_screenshot_history,
            ipc::save_screenshot,
            ipc::reselect_screenshot,
            ipc::get_screenshot_history,
            ipc::get_screenshot_entry,
            ipc::pin_screenshot,
            ipc::unpin_screenshot,
            ipc::close_current_pin,
            ipc::show_pin_menu,
            ipc::update_pin_image,
            ipc::recognize_pin_text,
            ipc::copy_pin_text,
            ipc::zoom_pin,
            ipc::set_pin_opacity,
            ipc::move_pin,
            ipc::pin_renderer_ready,
            ipc::pin_image_ready,
            ipc::close_screenshot_editor,
            ipc::close_screenshot_history,
            ipc::hide_window,
            ipc::quit_app,
            ipc::set_window_mode,
            ipc::activate_launcher,
            ipc::release_launcher_shortcut,
            ipc::shortcut_key_up,
            ipc::screenshot_renderer_ready,
            ipc::screenshot_ready,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Message window thread: hotkeys + clipboard listener + dispatcher.
            let (event_tx, event_rx) = std::sync::mpsc::channel::<MsgEvent>();
            let bridge = msg_window::spawn(event_tx);
            let dispatch_handle = handle.clone();
            std::thread::spawn(move || {
                while let Ok(event) = event_rx.recv() {
                    dispatch_event(&dispatch_handle, event);
                }
            });

            // Pump muda menu events (pin context menu commands).
            std::thread::spawn(|| {
                loop {
                    match muda::MenuEvent::receiver().recv() {
                        Ok(event) => pins::handle_menu_event(&event.id.0),
                        Err(_) => return,
                    }
                }
            });

            let mut state = AppState::new();
            store::load_store(&mut state);
            let store_tx = store::spawn_writer();
            ctx::init_ctx(Ctx {
                app: handle.clone(),
                state: std::sync::Mutex::new(state),
                msg: bridge,
                store_tx,
                ocr_cache: std::sync::Mutex::new(ctx::OcrLru::new(64)),
                pin_menu_target: std::sync::Mutex::new(None),
                pending_image_writes: std::sync::atomic::AtomicI64::new(0),
                clipboard_busy: std::sync::Mutex::new(()),
            });

            // Surfaces: main window, toast, hidden editor, warm pin shell.
            appwindows::build_main_window(&handle)?;
            appwindows::build_toast_window(&handle)?;
            appwindows::build_editor_window(&handle)?;
            pins::ensure_warm_pin();

            build_tray(&handle)?;

            // Register the persisted shortcuts (persist: false at startup).
            let shortcut = {
                let state = ctx::ctx().state.lock().unwrap();
                if state.shortcut.is_empty() { core::DEFAULT_SHORTCUT.to_string() } else { state.shortcut.clone() }
            };
            app_flow::register_app_shortcut(&shortcut, false);
            app_flow::register_screenshot_shortcuts_at_start();

            // Startup housekeeping.
            {
                let mut state = ctx::ctx().state.lock().unwrap();
                let _ = clip_logic::trim_history(&mut state);
            }
            std::thread::spawn(|| {
                std::thread::sleep(std::time::Duration::from_millis(1500));
                clip_logic::run_image_gc();
            });
            std::thread::spawn(clip_logic::refresh_source_context);
            std::thread::spawn(clip_logic::inspect_clipboard);

            Ok(())
        })
        .on_menu_event(|_app, event| {
            let id = event.id().0.clone();
            match id.as_str() {
                "tray-open" => app_flow::show_main_window(false),
                "tray-capture" => {
                    if let Err(message) = app_flow::capture_current_display(false) {
                        clip_logic::broadcast_delta(json!({ "notice": message }));
                    }
                }
                "tray-quick-pin" => {
                    if let Err(message) = app_flow::capture_current_display(true) {
                        clip_logic::broadcast_delta(json!({ "notice": message }));
                    }
                }
                "tray-history" => appwindows::show_history_window(),
                "tray-exit" => app_flow::quit_application(),
                other => pins::handle_menu_event(other),
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build Pasty")
        .run(|_app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                let state = ctx::ctx().state.lock().unwrap();
                store::flush_sync(&state);
                ctx::ctx().ocr_cache.lock().unwrap().clear();
            }
        });
}

fn dispatch_event(_app: &AppHandle, event: MsgEvent) {
    match event {
        MsgEvent::Hotkey(id) => match id {
            app_flow::HOTKEY_APP => app_flow::show_main_window(true),
            app_flow::HOTKEY_CAPTURE => {
                if let Err(message) = app_flow::capture_current_display(false) {
                    clip_logic::broadcast_delta(json!({ "notice": message }));
                }
            }
            app_flow::HOTKEY_QUICK_PIN => {
                if let Err(message) = app_flow::capture_current_display(true) {
                    clip_logic::broadcast_delta(json!({ "notice": message }));
                }
            }
            app_flow::HOTKEY_HISTORY => appwindows::show_history_window(),
            app_flow::HOTKEY_F4 => app_flow::on_f4_hotkey(),
            _ => {}
        },
        MsgEvent::ClipboardUpdate => clip_logic::on_clipboard_event(),
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let open = MenuItem::with_id(app, "tray-open", "打开 Pasty", true, None::<&str>)?;
    let capture = MenuItem::with_id(app, "tray-capture", "截图", true, None::<&str>)?;
    let quick_pin = MenuItem::with_id(app, "tray-quick-pin", "快速截图并固定", true, None::<&str>)?;
    let history = MenuItem::with_id(app, "tray-history", "截图历史", true, None::<&str>)?;
    let exit = MenuItem::with_id(app, "tray-exit", "退出 Pasty", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &separator,
            &capture,
            &quick_pin,
            &history,
            &PredefinedMenuItem::separator(app)?,
            &exit,
        ],
    )?;

    let icon = load_tray_icon();
    let _tray = TrayIconBuilder::with_id("pasty-tray")
        .icon(icon)
        .tooltip("Pasty · 剪贴板与截图")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = tray.app_handle().clone();
                app_flow::show_main_window(false);
            }
        })
        .build(app)?;
    Ok(())
}

/// Tray icon: pasty-tray.png decoded + scaled to 20px (the Electron resize).
fn load_tray_icon() -> tauri::image::Image<'static> {
    let bytes = include_bytes!("../assets/pasty-tray.png");
    if let Ok((w, h, bgra)) = imaging::decode_bgra(bytes) {
        let scale = 20.0 / w as f64;
        let th = ((h as f64 * scale).round() as u32).max(1);
        let mut rgba = imaging::resize_bgra(w, h, &bgra, 20, th);
        // BGRA -> RGBA for tauri::image::Image.
        for px in rgba.chunks_exact_mut(4) {
            px.swap(0, 2);
        }
        tauri::image::Image::new_owned(rgba, 20, th)
    } else {
        tauri::image::Image::new_owned(vec![0u8; 4 * 4], 4, 4)
    }
}

// Keep Value referenced for event payload construction.
#[allow(dead_code)]
fn _unused(v: Value) -> Value {
    let _ = v;
    json!({})
}
