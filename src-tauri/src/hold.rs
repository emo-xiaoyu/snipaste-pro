// Hold-to-open state machine, ported 1:1 from electron/shortcut-hold.cjs.
// While the configured chord is physically held, a 16 ms poll thread watches
// native key state; releasing (natively or via renderer key-up) hides the
// wheel unless the session was committed by a deliberate selection.

use crate::shortcuts::{keys_down, shortcut_key_groups};
use serde_json::Value;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

struct HoldSession {
    id: u64,
    groups: Vec<Vec<i32>>,
    committed: bool,
}

struct HoldInner {
    active: Option<HoldSession>,
    next_id: u64,
}

static HOLD: OnceLock<Mutex<HoldInner>> = OnceLock::new();

fn hold() -> &'static Mutex<HoldInner> {
    HOLD.get_or_init(|| Mutex::new(HoldInner { active: None, next_id: 0 }))
}

pub struct ShortcutHold;

impl ShortcutHold {
    /// Starts a hold session. Returns (session id, key groups), or None when a
    /// session is already active (OS key repeat never toggles the wheel).
    pub fn start(app: &AppHandle, accelerator: &str) -> Option<(u64, Vec<Vec<i32>>)> {
        let (id, groups) = {
            let mut guard = hold().lock().unwrap();
            if guard.active.is_some() {
                return None;
            }
            let groups = shortcut_key_groups(accelerator)?;
            guard.next_id += 1;
            let id = guard.next_id;
            guard.active = Some(HoldSession { id, groups: groups.clone(), committed: false });
            (id, groups)
        };
        let poll_app = app.clone();
        std::thread::spawn(move || Self::poll_loop(poll_app, id));
        Some((id, groups))
    }

    fn poll_loop(app: AppHandle, id: u64) {
        loop {
            std::thread::sleep(std::time::Duration::from_millis(16));
            let groups = {
                let guard = hold().lock().unwrap();
                match &guard.active {
                    Some(s) if s.id == id => s.groups.clone(),
                    _ => return,
                }
            };
            if !keys_down(&groups) {
                release_by_id(&app, id);
                return;
            }
        }
    }

    /// Native key-state check for an active session; releases it when the
    /// chord is no longer held. Returns whether the chord is still down.
    pub fn check(app: &AppHandle, id: u64) -> bool {
        let groups = {
            let guard = hold().lock().unwrap();
            match &guard.active {
                Some(s) if s.id == id => s.groups.clone(),
                _ => return false,
            }
        };
        let down = keys_down(&groups);
        if !down {
            release_by_id(app, id);
        }
        down
    }

    /// Renderer-side release (key-up observed in the page) or explicit cancel.
    pub fn release(app: &AppHandle) {
        let committed = {
            let mut guard = hold().lock().unwrap();
            match guard.active.take() {
                Some(s) => s.committed,
                None => return,
            }
        };
        if !committed {
            on_release(app);
        }
    }

    /// Renderer key-up fallback: releases when the released key belongs to the
    /// held chord (electron/main.cjs before-input-event path).
    pub fn key_up(app: &AppHandle, key_code: i32) {
        let take = {
            let guard = hold().lock().unwrap();
            match &guard.active {
                Some(s) if s.groups.iter().any(|g| g.contains(&key_code)) => Some(s.committed),
                _ => None,
            }
        };
        if let Some(committed) = take {
            hold().lock().unwrap().active = None;
            if !committed {
                on_release(app);
            }
        }
    }

    pub fn stop() {
        hold().lock().unwrap().active = None;
    }

    pub fn commit() {
        if let Some(session) = hold().lock().unwrap().active.as_mut() {
            session.committed = true;
        }
    }

    pub fn is_pending() -> bool {
        hold().lock()
            .unwrap()
            .active
            .as_ref()
            .map(|s| !s.committed)
            .unwrap_or(false)
    }

    pub fn session_id() -> Option<u64> {
        hold().lock().unwrap().active.as_ref().map(|s| s.id)
    }

    pub fn is_active_id(id: u64) -> bool {
        hold().lock().unwrap().active.as_ref().map(|s| s.id) == Some(id)
    }
}

fn release_by_id(app: &AppHandle, id: u64) {
    let committed = {
        let mut guard = hold().lock().unwrap();
        match &guard.active {
            Some(s) if s.id == id => {
                let c = s.committed;
                guard.active = None;
                c
            }
            _ => return,
        }
    };
    if !committed {
        on_release(app);
    }
}

fn on_release(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit_to("main", "window:shortcut-released", Value::Null);
        let _ = main.hide();
    }
}
