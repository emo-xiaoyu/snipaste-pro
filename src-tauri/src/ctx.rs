// Process-wide context: app handle + state + bridges + OCR LRU cache.
// Stored in a global so message-window threads, hold polling threads, and
// Tauri command handlers all reach the same instance.

use crate::msg_window::MsgBridge;
use crate::state::AppState;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::sync::mpsc::Sender;
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;

pub struct OcrLru {
    order: VecDeque<String>,
    map: HashMap<String, Result<Value, String>>,
    limit: usize,
}

impl OcrLru {
    pub fn new(limit: usize) -> Self {
        Self { order: VecDeque::new(), map: HashMap::new(), limit }
    }

    fn touch(&mut self, key: &str) {
        self.order.retain(|k| k != key);
        self.order.push_back(key.to_string());
    }

    pub fn get(&mut self, key: &str) -> Option<Result<Value, String>> {
        let hit = self.map.get(key).cloned();
        if hit.is_some() {
            self.touch(key);
        }
        hit
    }

    pub fn put(&mut self, key: String, value: Result<Value, String>) {
        if value.is_err() {
            return;
        }
        self.map.insert(key.clone(), value);
        self.touch(&key);
        while self.order.len() > self.limit {
            if let Some(oldest) = self.order.pop_front() {
                self.map.remove(&oldest);
            }
        }
    }

    pub fn delete(&mut self, key: &str) {
        self.order.retain(|k| k != key);
        self.map.remove(key);
    }

    pub fn clear(&mut self) {
        self.order.clear();
        self.map.clear();
    }
}

pub struct Ctx {
    pub app: AppHandle,
    pub state: Mutex<AppState>,
    pub msg: MsgBridge,
    pub store_tx: Sender<crate::store::StoreJob>,
    pub ocr_cache: Mutex<OcrLru>,
    pub pin_menu_target: Mutex<Option<(String, String)>>,
    pub pending_image_writes: std::sync::atomic::AtomicI64,
    pub clipboard_busy: Mutex<()>,
}

static CTX: OnceLock<Ctx> = OnceLock::new();

pub fn init_ctx(ctx: Ctx) -> &'static Ctx {
    CTX.set(ctx).ok().expect("ctx initialized twice");
    CTX.get().unwrap()
}

pub fn ctx() -> &'static Ctx {
    CTX.get().expect("ctx not initialized")
}

pub fn trace(label: &str) {
    if let Ok(path) = std::env::var("PASTY_QA_TIMING") {
        use std::io::Write;
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{} {}", crate::core::now_ms(), label);
        }
    }
}

/// broadcast / broadcastDelta ports over Tauri events.
pub fn emit_main(event: &str, payload: Value) {
    use tauri::Emitter;
    let _ = ctx().app.emit_to("main", event, payload);
}
