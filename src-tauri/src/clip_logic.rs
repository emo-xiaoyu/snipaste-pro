// Clipboard business logic: the port of the entry pipeline in
// electron/main.cjs (inspectClipboard, addText/addImage/addFiles, merge,
// trim, image GC, thumbnails, toasts, broadcasts, paste keystroke).

use crate::clipboard_native;
use crate::core::*;
use crate::ctx::{ctx, trace};
use crate::paste::send_paste;
use crate::state::AppState;
use serde_json::{json, Value};
use tauri::Manager;
use std::sync::atomic::Ordering;

pub struct TextOpts {
    pub custom: bool,
    pub title: Option<String>,
    pub type_hint: Option<String>,
    pub html: String,
    pub formats: Vec<String>,
    pub source: Option<Value>,
}

impl Default for TextOpts {
    fn default() -> Self {
        Self {
            custom: false,
            title: None,
            type_hint: None,
            html: String::new(),
            formats: vec!["text/plain".into()],
            source: None,
        }
    }
}

pub struct ImageOpts {
    pub custom: bool,
    pub title: Option<String>,
    pub origin: Option<&'static str>,
    pub force: bool,
    pub source: Option<Value>,
}

impl Default for ImageOpts {
    fn default() -> Self {
        Self { custom: false, title: None, origin: None, force: false, source: None }
    }
}

pub struct FileOpts {
    pub formats: Vec<String>,
    pub source: Option<Value>,
}

impl Default for FileOpts {
    fn default() -> Self {
        Self { formats: vec!["text/uri-list".into()], source: None }
    }
}

// ---------------------------------------------------------------- public shapes

pub fn thumbnail_data_url(state: &mut AppState, entry: &Value) -> Option<String> {
    if entry.get("type").and_then(|v| v.as_str()) != Some("image") {
        return None;
    }
    let path = entry.get("imagePath")?.as_str()?;
    if !std::path::Path::new(path).is_file() {
        return None;
    }
    if let Some(hit) = state.thumbnail_cache.get(path) {
        return Some(hit.clone());
    }
    let bytes = std::fs::read(path).ok()?;
    let url = crate::imaging::thumbnail_data_url(&bytes)?;
    state.thumbnail_cache.insert(path.to_string(), url.clone());
    Some(url)
}

pub fn public_entry(state: &mut AppState, entry: &Value) -> Value {
    let mut out = entry.clone();
    let image_url = thumbnail_data_url(state, entry);
    if let Some(obj) = out.as_object_mut() {
        obj.remove("imagePath");
        if let Some(url) = image_url {
            obj.insert("imageUrl".into(), json!(url));
        }
    }
    out
}

pub fn public_state(state: &mut AppState) -> Value {
    let snapshot: Vec<Value> = state.entries.clone();
    let entries: Vec<Value> = snapshot
        .iter()
        .map(|entry| public_entry(state, entry))
        .collect();
    json!({
        "shortcut": state.shortcut,
        "screenshotShortcuts": state.screenshot_shortcuts,
        "preferences": state.preferences,
        "entries": entries,
    })
}

pub fn broadcast(extra: Value) {
    let mut state = ctx().state.lock().unwrap();
    let full = public_state(&mut state);
    let mut payload = full;
    if let (Some(dst), Some(src)) = (payload.as_object_mut(), extra.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
        dst.insert("full".into(), json!(true));
    }
    crate::ctx::emit_main("clipboard:state-changed", payload);
}

pub fn broadcast_delta(extra: Value) {
    let mut payload = extra;
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("full".into(), json!(false));
    }
    crate::ctx::emit_main("clipboard:state-changed", payload);
}

pub fn schedule_store(state: &AppState, on_complete: Option<std::sync::Arc<dyn Fn() + Send + Sync>>) {
    let revision = now_ms();
    ctx().store_tx
        .send(crate::store::StoreJob {
            revision,
            snapshot: crate::store::store_state_json(state),
            store_path: state.store_path.clone(),
            on_complete,
        })
        .ok();
}

// ---------------------------------------------------------------- history maintenance

pub fn trim_history(state: &mut AppState) -> Vec<String> {
    let durable: Vec<Value> = state
        .entries
        .iter()
        .filter(|e| {
            e.get("pinned").and_then(|v| v.as_bool()).unwrap_or(false)
                || e.get("custom").and_then(|v| v.as_bool()).unwrap_or(false)
        })
        .cloned()
        .collect();
    let limit = state
        .preferences
        .get("historyLimit")
        .and_then(|v| v.as_u64())
        .unwrap_or(HISTORY_LIMIT as u64) as usize;
    let transient: Vec<Value> = state
        .entries
        .iter()
        .filter(|e| {
            !(e.get("pinned").and_then(|v| v.as_bool()).unwrap_or(false)
                || e.get("custom").and_then(|v| v.as_bool()).unwrap_or(false))
        })
        .take(limit)
        .cloned()
        .collect();
    let keep: std::collections::HashSet<String> = durable
        .iter()
        .chain(transient.iter())
        .filter_map(|e| e.get("id").and_then(|v| v.as_str()).map(String::from))
        .collect();
    let removed: Vec<String> = state
        .entries
        .iter()
        .filter(|e| {
            e.get("id")
                .and_then(|v| v.as_str())
                .map(|id| !keep.contains(id))
                .unwrap_or(false)
        })
        .filter_map(|e| e.get("id").and_then(|v| v.as_str()).map(String::from))
        .collect();
    if !removed.is_empty() {
        let removed_set: std::collections::HashSet<&String> = removed.iter().collect();
        for entry in state.entries.clone().iter() {
            if let Some(path) = entry.get("imagePath").and_then(|v| v.as_str()) {
                let id = entry.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if removed_set.contains(&id.to_string()) || !keep.contains(id) {
                    state.thumbnail_cache.remove(path);
                }
            }
        }
        state.entries.retain(|e| {
            e.get("id")
                .and_then(|v| v.as_str())
                .map(|id| keep.contains(id))
                .unwrap_or(false)
        });
        schedule_image_gc(2500);
    }
    removed
}

// Debounced image GC: unreferenced PNGs under images/ are removed after the
// burst of trims/deletes settles.
static GC_TX: std::sync::OnceLock<std::sync::mpsc::Sender<u64>> = std::sync::OnceLock::new();

pub fn schedule_image_gc(delay_ms: u64) {
    let tx = GC_TX.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<u64>();
        std::thread::spawn(move || {
            let mut wait = 0u64;
            loop {
                wait = match rx.recv() {
                    Ok(next) => next,
                    Err(_) => return,
                };
                // Reset the timer for every burst event.
                loop {
                    match rx.recv_timeout(std::time::Duration::from_millis(wait.max(1))) {
                        Ok(next) => wait = next,
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                }
                run_image_gc();
            }
        });
        tx
    });
    let _ = tx.send(delay_ms);
}

pub fn run_image_gc() {
    let state = ctx().state.lock().unwrap();
    let Some(dir) = state.images_dir.to_str().map(String::from) else { return };
    let referenced: std::collections::HashSet<String> = state
        .entries
        .iter()
        .filter(|e| e.get("type").and_then(|v| v.as_str()) == Some("image"))
        .filter_map(|e| {
            e.get("imagePath")
                .and_then(|v| v.as_str())
                .and_then(|p| std::path::Path::new(p).file_name().map(|n| n.to_string_lossy().to_string()))
        })
        .collect();
    drop(state);
    let Ok(names) = std::fs::read_dir(&dir) else { return };
    for entry in names.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.to_lowercase().ends_with(".png") || referenced.contains(&name) {
            continue;
        }
        let path = entry.path();
        if std::fs::remove_file(&path).is_ok() {
            ctx().state.lock().unwrap().thumbnail_cache.remove(path.to_string_lossy().as_ref());
        }
    }
}

// ---------------------------------------------------------------- source tracking

pub fn refresh_source_context() {
    {
        let mut state = ctx().state.lock().unwrap();
        if state.source_read_pending {
            return;
        }
        state.source_read_pending = true;
    }
    std::thread::spawn(move || {
        let normalized = crate::foreground::foreground()
            .as_ref()
            .and_then(crate::foreground::normalize_source);
        let mut state = ctx().state.lock().unwrap();
        if let Some(source) = normalized {
            state.last_external_source = Some(source);
        }
        state.source_read_pending = false;
    });
}

/// Called with the state lock already held; never re-locks it (std::sync::Mutex
/// is not reentrant). The refresh thread takes the lock itself afterwards.
pub fn get_cached_source_context(state: &AppState) -> Option<Value> {
    if !state.pref("trackSource") {
        return None;
    }
    std::thread::spawn(|| {
        let normalized = crate::foreground::foreground()
            .as_ref()
            .and_then(crate::foreground::normalize_source);
        let mut state = ctx().state.lock().unwrap();
        if let Some(source) = normalized {
            state.last_external_source = Some(source);
        }
    });
    state.last_external_source.clone()
}

// ---------------------------------------------------------------- capture pipeline

fn show_capture_toast(state: &mut AppState, entry: &Value) {
    if !state.pref("showCopyToast") {
        return;
    }
    let public = public_entry(state, entry);
    crate::appwindows::show_toast(public);
}

pub fn merge_duplicate(state: &mut AppState, fingerprint: &str, source: Option<&Value>) -> Option<Value> {
    let index = state.entries.iter().position(|e| {
        e.get("fingerprint").and_then(|v| v.as_str()) == Some(fingerprint)
    })?;
    let mut existing = state.entries.remove(index);
    if let Some(obj) = existing.as_object_mut() {
        let count = obj.get("copyCount").and_then(|v| v.as_i64()).unwrap_or(1).max(1) + 1;
        obj.insert("copyCount".into(), json!(count));
        obj.insert("lastCopiedAt".into(), json!(now_ms()));
        obj.insert("createdAt".into(), json!(now_ms()));
        if let Some(src) = source {
            obj.insert("source".into(), src.clone());
        }
    }
    state.entries.insert(0, existing.clone());
    let removed = trim_history(state);
    schedule_store(state, None);
    let public = public_entry(state, &existing);
    broadcast_delta(json!({
        "capturedEntry": public,
        "removedIds": removed,
    }));
    show_capture_toast(state, &existing);
    Some(existing)
}

pub fn add_text(content: &str, options: TextOpts) -> Option<Value> {
    let normalized: String = content.replace('\0', "").replace("\r\n", "\n");
    if normalized.trim().is_empty() {
        return None;
    }
    let mut state = ctx().state.lock().unwrap();
    let capture_rich = state.pref("captureRichText");
    let html = if capture_rich { options.html.clone() } else { String::new() };
    let fingerprint = text_fingerprint(&normalized, &html);
    if !options.custom && fingerprint != state.last_fingerprint {
        state.suppress_fingerprint = String::new();
    }
    if !options.custom
        && (fingerprint == state.last_fingerprint || fingerprint == state.suppress_fingerprint)
    {
        return None;
    }
    if !options.custom {
        if let Some((_, label)) = detect_sensitive(&normalized) {
            if state.pref("protectSensitive") {
                state.last_fingerprint = fingerprint.clone();
                drop(state);
                broadcast_delta(json!({ "notice": format!("检测到{label}，已跳过记录") }));
                return None;
            }
        }
    }
    state.last_fingerprint = fingerprint.clone();
    let source = options.source.clone().or_else(|| get_cached_source_context(&state));
    let merge_duplicates = state.pref("mergeDuplicates");
    if !options.custom && merge_duplicates {
        if let Some(merged) = merge_duplicate(&mut state, &fingerprint, source.as_ref()) {
            return Some(merged);
        }
    }
    let type_name = match options.type_hint.as_deref() {
        Some(t) if t != "auto" => t.to_string(),
        _ => classify_text(&normalized).to_string(),
    };
    let files: Vec<String> = if type_name == "file" {
        normalized.split('\n').map(String::from).collect()
    } else {
        Vec::new()
    };
    let now = now_ms();
    let mut entry = json!({
        "id": random_id(),
        "fingerprint": fingerprint,
        "type": type_name,
        "title": options.title.clone()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| entry_title(&normalized, &type_name, &files)),
        "content": normalized,
        "createdAt": now,
        "lastCopiedAt": now,
        "copyCount": 1,
        "formats": options.formats,
        "source": source,
        "sensitive": detect_sensitive(&content).is_some(),
        "pinned": options.custom,
        "custom": options.custom,
    });
    if !html.is_empty() {
        entry["html"] = json!(html);
    }
    if !files.is_empty() {
        entry["files"] = json!(files);
    }
    state.entries.insert(0, entry.clone());
    let removed = trim_history(&mut state);
    schedule_store(&state, None);
    let public = public_entry(&mut state, &entry);
    broadcast_delta(json!({
        "capturedEntry": public,
        "removedIds": removed,
    }));
    show_capture_toast(&mut state, &entry);
    Some(entry)
}

pub fn add_image(png_bytes: Vec<u8>, options: ImageOpts) -> Option<Value> {
    let Some((w, h)) = png_size(&png_bytes) else {
        return None;
    };
    let digest = sha1_hex(&png_bytes);
    let fingerprint = format!("image:{digest}");
    let mut state = ctx().state.lock().unwrap();
    if !options.custom && fingerprint != state.last_fingerprint {
        state.suppress_fingerprint = String::new();
    }
    if !options.custom
        && !options.force
        && (fingerprint == state.last_fingerprint || fingerprint == state.suppress_fingerprint)
    {
        return None;
    }
    state.last_fingerprint = fingerprint.clone();
    let source = options.source.clone().or_else(|| get_cached_source_context(&state));
    let merge_duplicates = state.pref("mergeDuplicates");
    if !options.custom && !options.force && merge_duplicates {
        if let Some(merged) = merge_duplicate(&mut state, &fingerprint, source.as_ref()) {
            return Some(merged);
        }
    }
    let image_path = state
        .images_dir
        .join(format!("{digest}.png"))
        .to_string_lossy()
        .to_string();
    let needs_write = !std::path::Path::new(&image_path).is_file();
    let now = now_ms();
    let title_local = chrono_like_now();
    let mut entry = json!({
        "id": random_id(),
        "fingerprint": fingerprint,
        "type": "image",
        "title": options.title.clone()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| format!("截图 {title_local}")),
        "content": format!("{w} × {h} · PNG"),
        "width": w,
        "height": h,
        "imagePath": image_path,
        "createdAt": now,
        "lastCopiedAt": now,
        "copyCount": 1,
        "formats": ["image/png"],
        "source": source,
        "pinned": options.custom,
        "custom": options.custom,
    });
    if let Some(origin) = options.origin {
        entry["origin"] = json!(origin);
    }
    state.entries.insert(0, entry.clone());
    let removed = trim_history(&mut state);
    if !removed.is_empty() {
        let removed_ids: Vec<String> = removed;
        broadcast_delta(json!({ "removedIds": removed_ids }));
    }
    let entry_id = entry.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    // Image bytes and the store both persist asynchronously; broadcast and the
    // toast follow once the thumbnail can actually be read from disk.
    let path = entry.get("imagePath").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let token = ctx().pending_image_writes.fetch_add(1, Ordering::SeqCst);
    let _ = token;
    std::thread::spawn(move || {
        if needs_write {
            if let Err(error) = std::fs::write(&path, &png_bytes) {
                ctx().pending_image_writes.fetch_sub(1, Ordering::SeqCst);
                eprintln!("Could not persist clipboard image: {error}");
                broadcast_delta(json!({ "notice": "图片已记录，但本地历史写入失败" }));
                return;
            }
        }
        let (snapshot, store_path, revision) = {
            let state = ctx().state.lock().unwrap();
            (
                crate::store::store_state_json(&state),
                state.store_path.clone(),
                now_ms(),
            )
        };
        let entry_id = entry_id.clone();
        let done = std::sync::Arc::new({
            let entry_id = entry_id.clone();
            move || {
                ctx().pending_image_writes.fetch_sub(1, Ordering::SeqCst);
                // The user may delete this image while bytes were in flight;
                // never resurrect it in the renderer.
                let mut state = ctx().state.lock().unwrap();
                if !state.entries.iter().any(|e| e.get("id").and_then(|v| v.as_str()) == Some(&entry_id)) {
                    return;
                }
                if let Some(kept) = state.entries.iter().find(|e| e.get("id").and_then(|v| v.as_str()) == Some(&entry_id)).cloned() {
                    let index = state.entries.iter().position(|e| e.get("id").and_then(|v| v.as_str()) == Some(&entry_id));
                    let public = public_entry(&mut state, &kept);
                    let mut payload = json!({ "capturedEntry": public });
                    if let Some(i) = index {
                        payload["capturedIndex"] = json!(i);
                    }
                    broadcast_delta(payload);
                    show_capture_toast(&mut state, &kept);
                }
            }
        });
        ctx().store_tx
            .send(crate::store::StoreJob {
                revision,
                snapshot,
                store_path,
                on_complete: Some(done),
            })
            .ok();
    });
    Some(entry)
}

pub fn add_files(files: Vec<String>, options: FileOpts) -> Option<Value> {
    let mut valid: Vec<String> = Vec::new();
    for file in files.iter().filter(|f| !f.is_empty()) {
        let normalized = normalize_win_path(file);
        if !valid.contains(&normalized) {
            valid.push(normalized);
        }
    }
    if valid.is_empty() {
        return None;
    }
    let fingerprint = file_fingerprint(&valid);
    let mut state = ctx().state.lock().unwrap();
    if fingerprint != state.last_fingerprint {
        state.suppress_fingerprint = String::new();
    }
    if fingerprint == state.last_fingerprint || fingerprint == state.suppress_fingerprint {
        return None;
    }
    state.last_fingerprint = fingerprint.clone();
    let source = options.source.clone().or_else(|| get_cached_source_context(&state));
    if state.pref("mergeDuplicates") {
        if let Some(merged) = merge_duplicate(&mut state, &fingerprint, source.as_ref()) {
            return Some(merged);
        }
    }
    let now = now_ms();
    let title = entry_title("", "file", &valid);
    let entry = json!({
        "id": random_id(),
        "fingerprint": fingerprint,
        "type": "file",
        "title": title,
        "content": valid.join("\n"),
        "files": valid,
        "createdAt": now,
        "lastCopiedAt": now,
        "copyCount": 1,
        "formats": options.formats,
        "source": source,
        "pinned": false,
        "custom": false,
    });
    state.entries.insert(0, entry.clone());
    let removed = trim_history(&mut state);
    schedule_store(&state, None);
    let public = public_entry(&mut state, &entry);
    broadcast_delta(json!({
        "capturedEntry": public,
        "removedIds": removed,
    }));
    show_capture_toast(&mut state, &entry);
    Some(entry)
}

fn normalize_win_path(path: &str) -> String {
    // path.normalize collapses separators to backslashes on win32.
    let mut out = String::with_capacity(path.len());
    for ch in path.chars() {
        out.push(if ch == '/' { '\\' } else { ch });
    }
    out
}

/// "2026/10/24 10:24:31" style used by `new Date().toLocaleString('zh-CN')`.
fn chrono_like_now() -> String {
    let ms = now_ms();
    let secs = (ms / 1000) as i64;
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Civil-from-days (Howard Hinnant's algorithm).
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y}/{m:02}/{d:02} {hour:02}:{minute:02}:{second:02}")
}

// ---------------------------------------------------------------- inspect (event driven)

pub fn inspect_clipboard() {
    let _guard = ctx().clipboard_busy.lock().unwrap();
    let (track_source, capture_files, capture_images, capture_text) = {
        let state = ctx().state.lock().unwrap();
        (
            state.pref("trackSource"),
            state.pref("captureFiles"),
            state.pref("captureImages"),
            state.pref("captureText"),
        )
    };
    if track_source {
        refresh_source_context();
    }
    let snap = clipboard_native::snapshot();
    if std::env::var("PASTY_DEBUG").is_ok() {
        eprintln!("[dbg] inspect: text={} html={} png={} dib={} hdrop={}", snap.has_unicode_text, snap.has_html, snap.has_png, snap.has_dib, snap.has_hdrop);
    }
    if capture_files && snap.has_hdrop {
        let files = clipboard_native::read_files();
        if !files.is_empty() {
            add_files(files, FileOpts::default());
            return;
        }
    }
    if capture_images && (snap.has_png || snap.has_dib) {
        let png = if snap.has_png {
            clipboard_native::read_png_bytes()
        } else {
            clipboard_native::read_dib_bgra()
                .and_then(|(w, h, bgra)| crate::imaging::encode_png(w, h, &bgra).ok())
        };
        if let Some(bytes) = png {
            if png_size(&bytes).is_some() {
                add_text_image_common(bytes);
                return;
            }
        }
    }
    if capture_text && (snap.has_unicode_text || snap.has_html) {
        let text = clipboard_native::read_text().unwrap_or_default();
        if std::env::var("PASTY_DEBUG").is_ok() {
            eprintln!("[dbg] add_text path, len={}", text.len());
        }
        let html = clipboard_native::read_html().unwrap_or_default();
        let mut formats = vec!["text/plain".to_string()];
        if snap.has_html {
            formats.push("text/html".into());
        }
        add_text(&text, TextOpts { html, formats, ..Default::default() });
    }
}

fn add_text_image_common(bytes: Vec<u8>) {
    add_image(bytes, ImageOpts::default());
}

// ---------------------------------------------------------------- clipboard writes + paste

pub fn write_entry_to_clipboard(entry: &Value) -> Result<(), String> {
    let entry_type = entry.get("type").and_then(|v| v.as_str()).unwrap_or("text");
    match entry_type {
        "image" => {
            let path = entry
                .get("imagePath")
                .and_then(|v| v.as_str())
                .ok_or("图片文件已不存在")?;
            let bytes =
                std::fs::read(path).map_err(|_| "图片文件已不存在".to_string())?;
            clipboard_native::write_image_png(&bytes);
        }
        "file" => {
            let files: Vec<String> = entry
                .get("files")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|f| f.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            if !files.is_empty() {
                clipboard_native::write_files(&files);
            } else {
                clipboard_native::write_text(entry.get("content").and_then(|v| v.as_str()).unwrap_or(""));
            }
        }
        _ => {
            let text = entry.get("content").and_then(|v| v.as_str()).unwrap_or("");
            match entry.get("html").and_then(|v| v.as_str()) {
                Some(html) if !html.is_empty() => clipboard_native::write_rich(text, html),
                _ => clipboard_native::write_text(text),
            }
        }
    }
    Ok(())
}

/// Port of writeEntryToClipboard's suppression bookkeeping + sendPasteKeystroke.
pub fn paste_entry_flow(entry: &Value) -> Result<(), String> {
    let (source, handle) = {
        let mut state = ctx().state.lock().unwrap();
        let source = state.last_external_source.clone();
        let handle = state.previous_window_handle.clone();
        state.previous_window_handle = None;
        let fingerprint = entry.get("fingerprint").and_then(|v| v.as_str()).unwrap_or("").to_string();
        state.suppress_fingerprint = fingerprint.clone();
        state.last_fingerprint = fingerprint;
        state.suppress_sequence = Some(clipboard_native::sequence_number());
        (source, handle)
    };
    write_entry_to_clipboard(entry)?;
    // Refresh the post-write sequence: the echo event carries this number.
    {
        let mut state = ctx().state.lock().unwrap();
        state.suppress_sequence = Some(clipboard_native::sequence_number());
    }
    if let Some(main) = ctx().app.get_webview_window("main") {
        let _ = main.hide();
    }
    let delay = {
        let state = ctx().state.lock().unwrap();
        resolve_paste_delay(&state.preferences, source.as_ref())
    };
    std::thread::spawn(move || {
        trace("paste-keystroke-sent");
        if send_paste(handle.as_deref(), delay).is_err() {
            broadcast_delta(json!({ "notice": "内容已复制；自动粘贴暂时不可用。" }));
        }
    });
    Ok(())
}

/// Called from WM_CLIPBOARDUPDATE: skip the echo of our own writes, then
/// inspect. The clipboard sequence number gives exact echo suppression that
/// the old 650 ms polling loop approximated.
pub fn on_clipboard_event() {
    if std::env::var("PASTY_DEBUG").is_ok() {
        eprintln!("[dbg] on_clipboard_event seq={}", clipboard_native::sequence_number());
    }
    let seq = clipboard_native::sequence_number();
    {
        let state = ctx().state.lock().unwrap();
        if let Some(suppressed) = state.suppress_sequence {
            if suppressed == seq {
                return;
            }
        }
    }
    inspect_clipboard();
}
