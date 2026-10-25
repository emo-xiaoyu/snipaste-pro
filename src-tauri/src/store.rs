// Durable store: same clipboard-store.json shape and the same userData-style
// directory as the Electron build, so an existing installation keeps working.
// Writes are serialized through a writer thread; each snapshot carries a
// revision and the writer only renames the latest one into place (the port of
// writeStoreAsync's revision check). Quit paths call `flush_sync` for the
// synchronous final write (the port of `writeStore` on will-quit).

use crate::core::{merge_preferences, migrate_entry, now_ms, DEFAULT_SHORTCUT};
use crate::state::AppState;
use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

pub struct StoreJob {
    pub revision: u64,
    pub snapshot: String,
    pub store_path: PathBuf,
    pub on_complete: Option<Arc<dyn Fn() + Send + Sync>>,
}

pub fn store_state_json(state: &AppState) -> String {
    let doc = json!({
        "entries": state.entries,
        "shortcut": state.shortcut,
        "screenshotShortcuts": state.screenshot_shortcuts,
        "preferences": state.preferences,
        "pinnedScreenshots": [],
    });
    serde_json::to_string_pretty(&doc).unwrap_or_default()
}

pub fn spawn_writer() -> Sender<StoreJob> {
    let (tx, rx) = std::sync::mpsc::channel::<StoreJob>();
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            // Coalesce any queued snapshots; only the newest revision lands.
            let mut latest = first;
            while let Ok(next) = rx.try_recv() {
                if next.revision >= latest.revision {
                    if let Some(cb) = latest.on_complete {
                        cb();
                    }
                    latest = next;
                } else if let Some(cb) = next.on_complete {
                    cb();
                }
            }
            write_snapshot(&latest);
            if std::env::var("PASTY_DEBUG").is_ok() {
                eprintln!("[dbg] store snapshot written rev={}", latest.revision);
            }
            if let Some(cb) = latest.on_complete {
                cb();
            }
        }
    });
    tx
}

fn write_snapshot(job: &StoreJob) {
    let tmp = job.store_path.with_extension(format!("tmp{}", job.revision));
    let write = || -> std::io::Result<()> {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(job.snapshot.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&tmp, &job.store_path)?;
        Ok(())
    };
    if let Err(error) = write() {
        let _ = std::fs::remove_file(&tmp);
        eprintln!("Could not persist clipboard store asynchronously: {error}");
    }
}

pub fn flush_sync(state: &AppState) {
    let snapshot = store_state_json(state);
    let tmp = state.store_path.with_extension("tmp-final");
    let write = || -> std::io::Result<()> {
        if let Some(parent) = state.store_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(snapshot.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&tmp, &state.store_path)?;
        Ok(())
    };
    if let Err(error) = write() {
        let _ = std::fs::remove_file(&tmp);
        eprintln!("Could not flush clipboard store on exit: {error}");
    }
}

/// Resolve the data directory: reuse an existing Electron-era store when
/// present (userData dir named after productName "Pasty" or package name
/// "pasty-clipboard"), else default to %APPDATA%/Pasty.
pub fn resolve_data_dir() -> PathBuf {
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let base = PathBuf::from(&appdata);
        for candidate in ["Pasty", "pasty-clipboard"] {
            let dir = base.join(candidate);
            if dir.join("clipboard-store.json").is_file() {
                return dir;
            }
        }
        return base.join("Pasty");
    }
    PathBuf::from(".")
}

pub fn load_store(state: &mut AppState) {
    state.store_dir = resolve_data_dir();
    state.store_path = state.store_dir.join("clipboard-store.json");
    state.images_dir = state.store_dir.join("images");
    let _ = std::fs::create_dir_all(&state.images_dir);
    let Ok(text) = std::fs::read_to_string(&state.store_path) else {
        return;
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
        eprintln!("Could not load clipboard store: invalid JSON");
        return;
    };
    if let Some(entries) = parsed.get("entries").and_then(|v| v.as_array()) {
        state.entries = entries.iter().map(migrate_entry).collect();
    }
    if let Some(shortcut) = parsed.get("shortcut").and_then(|v| v.as_str()) {
        if !shortcut.trim().is_empty() {
            state.shortcut = shortcut.trim().to_string();
        }
    }
    let mut shortcuts = crate::core::default_screenshot_shortcuts();
    if let Some(saved) = parsed.get("screenshotShortcuts").and_then(|v| v.as_object()) {
        for (key, value) in saved {
            if let Some(text) = value.as_str() {
                shortcuts[key.clone()] = json!(text);
            }
        }
    }
    // Validate against defaults like the JS spread does (unknown keys dropped).
    let defaults = crate::core::default_screenshot_shortcuts();
    let mut cleaned = serde_json::Map::new();
    if let Some(obj) = shortcuts.as_object() {
        for (key, value) in obj {
            if defaults.get(key).is_some() {
                cleaned.insert(key.clone(), value.clone());
            }
        }
    }
    state.screenshot_shortcuts = Value::Object(cleaned);
    state.preferences = merge_preferences(parsed.get("preferences"));
    // Desktop pins are session-only; older builds persisted them.
    if parsed
        .get("pinnedScreenshots")
        .and_then(|v| v.as_array())
        .map(|a| !a.is_empty())
        .unwrap_or(false)
    {
        let _ = now_ms();
    }
}

pub fn default_shortcut_hint() -> &'static str {
    DEFAULT_SHORTCUT
}

// Pending image writes tracking for shutdown draining.
pub struct PendingWrites(Arc<Mutex<Vec<u64>>>);

impl PendingWrites {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(Vec::new())))
    }
    pub fn add(&self) -> u64 {
        let token = now_ms() ^ rand_token();
        self.0.lock().unwrap().push(token);
        token
    }
    pub fn remove(&self, token: u64) {
        self.0.lock().unwrap().retain(|t| *t != token);
    }
    pub fn is_empty(&self) -> bool {
        self.0.lock().unwrap().is_empty()
    }
}

fn rand_token() -> u64 {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(0);
    hasher.finish()
}
