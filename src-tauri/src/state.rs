// Process-wide application state, mirroring the module-level lets in
// electron/main.cjs. Entries/preferences are serde_json values in the exact
// camelCase shapes the renderer expects.

use crate::core::{default_preferences, default_screenshot_shortcuts, DEFAULT_SHORTCUT};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Clone)]
pub struct PinSession {
    pub label: String,
    pub entry_id: String,
    pub image_bytes: Vec<u8>,
    pub image_path: Option<String>,
    pub width: u32,
    pub height: u32,
    /// Logical (DIP) bookkeeping for zoom/reset baselines.
    pub base_area: f64,
    pub base_width: f64,
    pub opacity: f64,
    pub renderer_ready: bool,
    pub pending_payload: Option<Value>,
}

pub struct AppState {
    pub entries: Vec<Value>,
    pub shortcut: String,
    pub screenshot_shortcuts: Value,
    pub preferences: Value,

    pub last_fingerprint: String,
    pub suppress_fingerprint: String,
    pub suppress_sequence: Option<u32>,
    pub last_external_source: Option<Value>,
    pub previous_window_handle: Option<String>,
    pub source_read_pending: bool,

    pub shortcut_recording_active: bool,
    pub registered_hotkeys: Vec<i32>,

    pub current_capture: Option<Value>,
    pub pending_screenshot_payload: Option<Value>,
    pub screenshot_renderer_ready: bool,
    pub screenshot_pin_registered: bool,

    pub pin_sessions: HashMap<String, PinSession>,
    /// Pin window labels whose renderer announced readiness. Tracked per
    /// label (not per session) because warm shells announce before any
    /// session exists.
    pub pin_renderer_labels: std::collections::HashSet<String>,
    pub warm_pin_label: Option<String>,
    pub pin_label_seq: u64,

    pub mode_revision: u64,
    pub main_loaded: bool,
    pub quitting: bool,

    pub store_dir: PathBuf,
    pub store_path: PathBuf,
    pub images_dir: PathBuf,
    pub thumbnail_cache: HashMap<String, String>,
    pub toast_generation: u64,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
            shortcut: DEFAULT_SHORTCUT.to_string(),
            screenshot_shortcuts: default_screenshot_shortcuts(),
            preferences: default_preferences(),
            last_fingerprint: String::new(),
            suppress_fingerprint: String::new(),
            suppress_sequence: None,
            last_external_source: None,
            previous_window_handle: None,
            source_read_pending: false,
            shortcut_recording_active: false,
            registered_hotkeys: Vec::new(),
            current_capture: None,
            pending_screenshot_payload: None,
            screenshot_renderer_ready: false,
            screenshot_pin_registered: false,
            pin_sessions: HashMap::new(),
            pin_renderer_labels: std::collections::HashSet::new(),
            warm_pin_label: None,
            pin_label_seq: 0,
            mode_revision: 0,
            main_loaded: false,
            quitting: false,
            store_dir: PathBuf::new(),
            store_path: PathBuf::new(),
            images_dir: PathBuf::new(),
            thumbnail_cache: HashMap::new(),
            toast_generation: 0,
        }
    }

    pub fn pref(&self, key: &str) -> bool {
        crate::core::pref_bool(&self.preferences, key)
    }

    pub fn find_entry(&self, id: &str) -> Option<&Value> {
        self.entries.iter().find(|e| e.get("id").and_then(|v| v.as_str()) == Some(id))
    }

    pub fn screenshot_shortcut(&self, key: &str) -> String {
        self.screenshot_shortcuts
            .get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
    }
}
