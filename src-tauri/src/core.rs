// Line-for-line port of electron/clipboard-core.cjs. The JS version is the
// behavioral spec; every clamp, rounding, and fallback here mirrors it so
// persisted data and renderer payloads stay bit-compatible.

use serde_json::{json, Value};

pub const DEFAULT_SHORTCUT: &str = "Alt+V";
pub const HISTORY_LIMIT: u32 = 120;

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------- sha1

pub fn sha1_hex(data: &[u8]) -> String {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let ml = (data.len() as u64) * 8;
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&ml.to_be_bytes());
    for chunk in msg.chunks_exact(64) {
        let mut w = [0u32; 80];
        for (i, word) in chunk.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A827999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }
    h.iter().map(|v| format!("{v:08x}")).collect()
}

// ---------------------------------------------------------------- text helpers

pub fn js_normalize_text(content: &str) -> String {
    content.replace('\0', "").replace("\r\n", "\n").trim().to_string()
}

pub fn strip_nulls_normalize(content: &str) -> String {
    content.replace('\0', "").replace("\r\n", "\n")
}

pub fn classify_text(content: &str) -> &'static str {
    let trimmed = js_normalize_text(content);
    if trimmed.is_empty() {
        return "text";
    }
    let lower = trimmed.to_lowercase();
    if (lower.starts_with("http://") || lower.starts_with("https://")) && trimmed.len() > 8 {
        let rest = &trimmed[trimmed.find("://").unwrap() + 3..];
        if !rest.is_empty() && !rest.starts_with(char::is_whitespace) {
            return "url";
        }
    }
    let file_path = regex::Regex::new(r"(?i)^(?:[a-z]:\\|\\\\)[^\r\n]+$").unwrap();
    if file_path.is_match(&trimmed) {
        return "file";
    }
    let code_signals = regex::Regex::new(
        r#"(?i)(^|\s)(npm|pnpm|yarn|git|docker|kubectl|adb|select|update|insert|delete|curl|ssh|pip|python|node|cargo|go)\b|[{}();]|=>|^#!/"#,
    )
    .unwrap();
    if code_signals.is_match(&trimmed) {
        return "code";
    }
    "text"
}

pub fn path_basename(input: &str) -> String {
    input
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(input)
        .to_string()
}

fn url_hostname(input: &str) -> Option<String> {
    let rest = input
        .strip_prefix("http://")
        .or_else(|| input.strip_prefix("https://"))
        .or_else(|| {
            input
                .strip_prefix("HTTP://")
                .or_else(|| input.strip_prefix("HTTPS://"))
        })?;
    let host = rest.split(['/', '?', '#']).next()?;
    // Strip userinfo and port like `new URL().hostname`.
    let host = host.rsplit('@').next().unwrap_or(host);
    let host = host.split(':').next().unwrap_or(host);
    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

pub fn entry_title(content: &str, entry_type: &str, files: &[String]) -> String {
    let first_line = js_normalize_text(content)
        .split('\n')
        .next()
        .unwrap_or("")
        .to_string();
    if entry_type == "url" {
        if let Some(host) = url_hostname(&first_line) {
            let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
            return host;
        }
    }
    if entry_type == "file" {
        let first_path = files
            .first()
            .cloned()
            .unwrap_or_else(|| first_line.clone());
        let base = path_basename(&first_path);
        return if files.len() > 1 {
            format!("{base} 等 {} 个文件", files.len())
        } else {
            base
        };
    }
    first_line.chars().take(80).collect()
}

// ---------------------------------------------------------------- sensitive detection

fn passes_luhn(value: &str) -> bool {
    let mut sum = 0u32;
    let mut double = false;
    for ch in value.chars().rev() {
        let mut digit = match ch.to_digit(10) {
            Some(d) => d,
            None => return false,
        };
        if double {
            digit *= 2;
            if digit > 9 {
                digit -= 9;
            }
        }
        sum += digit;
        double = !double;
    }
    sum % 10 == 0
}

pub fn detect_sensitive(content: &str) -> Option<(&'static str, &'static str)> {
    let text = js_normalize_text(content);
    if text.is_empty() {
        return None;
    }
    let rules: &[(&str, &str, &str)] = &[
        ("private-key", r"(?i)-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----", "私钥"),
        ("password", r#"(?i)(?:password|passwd|pwd|密码)\s*[:=]\s*[^\s]{4,}"#, "密码"),
        ("token", r#"(?i)(?:api[_-]?key|access[_-]?token|secret|authorization)\s*[:=]\s*["']?[a-z0-9_\-.]{12,}"#, "访问密钥"),
        ("bearer", r"(?i)\bbearer\s+[a-z0-9_\-.]{16,}", "Bearer Token"),
        ("jwt", r"(?i)\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b", "JWT"),
    ];
    for (kind, pattern, label) in rules {
        if regex::Regex::new(pattern).unwrap().is_match(&text) {
            return Some((kind, label));
        }
    }
    let digits: String = text.chars().filter(|c| !c.is_whitespace() && *c != '-').collect();
    if digits.len() >= 13
        && digits.len() <= 19
        && digits.chars().all(|c| c.is_ascii_digit())
        && passes_luhn(&digits)
    {
        return Some(("payment-card", "银行卡号"));
    }
    None
}

// ---------------------------------------------------------------- fingerprints

pub fn text_fingerprint(content: &str, html: &str) -> String {
    let text = strip_nulls_normalize(content);
    let payload = format!("{}\n{}", text, js_normalize_text(html));
    format!("text:{}", sha1_hex(payload.as_bytes()))
}

pub fn file_fingerprint(files: &[String]) -> String {
    let mut lowered: Vec<String> = files.iter().map(|f| f.to_lowercase()).collect();
    lowered.sort();
    format!("file:{}", sha1_hex(lowered.join("\n").as_bytes()))
}

// ---------------------------------------------------------------- preferences

pub fn default_preferences() -> Value {
    json!({
        "captureText": true,
        "captureImages": true,
        "captureFiles": true,
        "captureRichText": true,
        "trackSource": true,
        "mergeDuplicates": true,
        "protectSensitive": true,
        "showCopyToast": true,
        "autoRemoteDelay": true,
        "pasteDelay": 35,
        "remotePasteDelay": 320,
        "historyLimit": 120,
    })
}

pub fn default_screenshot_shortcuts() -> Value {
    json!({
        "capture": "Alt+Shift+S",
        "quickPin": "Alt+Shift+P",
        "history": "Alt+Shift+V",
        "historyPin": "Enter",
    })
}

fn js_number(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(n)) => n.as_f64(),
        // JS Number(true) === 1
        Some(Value::Bool(b)) => Some(if *b { 1.0 } else { 0.0 }),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

pub fn merge_preferences(value: Option<&Value>) -> Value {
    let defaults = default_preferences().as_object().unwrap().clone();
    let input = value.and_then(|v| v.as_object());
    let mut picked = serde_json::Map::new();
    for key in defaults.keys() {
        if let Some(obj) = input {
            if let Some(v) = obj.get(key) {
                picked.insert(key.clone(), v.clone());
            }
        }
    }
    // JS: Math.min(1000, Math.max(20, Number(picked.historyLimit) || 120))
    let history_limit = {
        let raw = js_number(picked.get("historyLimit"));
        let n = match raw {
            Some(v) if v != 0.0 && v.is_finite() => v,
            _ => 120.0,
        };
        (n.max(20.0).min(1000.0)) as i64
    };
    let paste_delay = {
        // JS: Number(picked.pasteDelay ?? 35); null -> 0 -> clamped to 0.
        let raw = match picked.get("pasteDelay") {
            Some(Value::Null) | None => 35.0,
            Some(v) => js_number(Some(v)).unwrap_or(f64::NAN),
        };
        if raw.is_finite() {
            raw.max(0.0).min(300.0) as i64
        } else {
            35
        }
    };
    let remote_paste_delay = {
        // JS: Math.min(1200, Math.max(100, Number(picked.remotePasteDelay) || 320))
        let raw = js_number(picked.get("remotePasteDelay")).unwrap_or(0.0);
        let n = if raw == 0.0 || !raw.is_finite() { 320.0 } else { raw };
        n.max(100.0).min(1200.0) as i64
    };
    let mut merged = defaults;
    for (k, v) in picked {
        merged.insert(k, v);
    }
    merged.insert("historyLimit".into(), json!(history_limit));
    merged.insert("pasteDelay".into(), json!(paste_delay));
    merged.insert("remotePasteDelay".into(), json!(remote_paste_delay));
    Value::Object(merged)
}

pub fn pref_bool(prefs: &Value, key: &str) -> bool {
    prefs.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

pub fn pref_i64(prefs: &Value, key: &str) -> i64 {
    prefs.get(key).and_then(|v| v.as_i64()).unwrap_or(0)
}

pub fn is_remote_source(source: Option<&Value>) -> bool {
    let _empty = String::new();
    let app = source
        .and_then(|s| s.get("app"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let title = source
        .and_then(|s| s.get("title"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let combined = format!("{app} {title}");
    regex::Regex::new(r"(?i)(?:gameviewer|todesk|awesun|sunlogin|mstsc|rustdesk|anydesk|teamviewer|parsec|向日葵|uu远程)")
        .unwrap()
        .is_match(&combined)
}

pub fn resolve_paste_delay(preferences: &Value, source: Option<&Value>) -> i64 {
    let merged = merge_preferences(Some(preferences));
    if pref_bool(&merged, "autoRemoteDelay") && is_remote_source(source) {
        pref_i64(&merged, "remotePasteDelay")
    } else {
        pref_i64(&merged, "pasteDelay")
    }
}

pub fn is_screenshot_entry(entry: &Value) -> bool {
    entry.get("type").and_then(|v| v.as_str()) == Some("image")
        && entry.get("origin").and_then(|v| v.as_str()) == Some("screenshot")
}

// ---------------------------------------------------------------- geometry

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Rect {
    pub fn to_json(self) -> Value {
        json!({"x": self.x, "y": self.y, "width": self.width, "height": self.height})
    }
}

pub fn default_capture_region(
    display: Rect,
    cursor: (i32, i32),
    preferred_width: i32,
    preferred_height: i32,
) -> Rect {
    let width = display.width.min(preferred_width.max(160));
    let height = display.height.min(preferred_height.max(120));
    let x = (display.x + display.width - width).min((cursor.0 - width / 2).max(display.x));
    let y = (display.y + display.height - height).min((cursor.1 - height / 2).max(display.y));
    Rect { x, y, width, height }
}

pub fn cursor_window_position(work: Rect, size: (i32, i32), cursor: (i32, i32)) -> (i32, i32) {
    let max_x = work.x + (work.width - size.0).max(0);
    let max_y = work.y + (work.height - size.1).max(0);
    let x = ((max_x).min((work.x).max(cursor.0 - size.0 / 2)) as f64).round() as i32;
    let y = ((max_y).min((work.y).max(cursor.1 - size.1 / 2)) as f64).round() as i32;
    (x, y)
}

pub fn capture_pin_bounds(display: Rect, image: (f64, f64), crop: &Value) -> Option<Rect> {
    if image.0 <= 0.0 || image.1 <= 0.0 {
        return None;
    }
    let crop_x = crop.get("x")?.as_f64()?;
    let crop_y = crop.get("y")?.as_f64()?;
    let crop_w = crop.get("width")?.as_f64()?;
    let crop_h = crop.get("height")?.as_f64()?;
    if crop_w <= 0.0 || crop_h <= 0.0 {
        return None;
    }
    let scale_x = display.width as f64 / image.0;
    let scale_y = display.height as f64 / image.1;
    Some(Rect {
        x: (display.x as f64 + crop_x * scale_x).round() as i32,
        y: (display.y as f64 + crop_y * scale_y).round() as i32,
        width: (crop_w * scale_x).round().max(1.0) as i32,
        height: (crop_h * scale_y).round().max(1.0) as i32,
    })
}

pub fn zoom_pin_bounds(bounds: Rect, pointer: (f64, f64), delta_y: f64, aspect_ratio: f64) -> Rect {
    if bounds.width <= 0 || bounds.height <= 0 || delta_y == 0.0 || !delta_y.is_finite() {
        return bounds;
    }
    let ratio = if aspect_ratio.is_finite() && aspect_ratio > 0.0 {
        aspect_ratio
    } else {
        bounds.width as f64 / bounds.height as f64
    };
    let steps = (delta_y.abs() / 100.0).max(0.25).min(4.0);
    let requested = 1.12f64.powf(if delta_y < 0.0 { steps } else { -steps });
    let min_scale = (80.0 / bounds.width as f64).max(60.0 / bounds.height as f64);
    let max_scale = (4096.0 / bounds.width as f64).min(4096.0 / bounds.height as f64);
    let scale = requested.min(max_scale).max(min_scale);
    let width = ((bounds.width as f64 * scale).round() as i32).max(1);
    let height = ((width as f64 / ratio).round() as i32).max(1);
    let pointer_x = pointer.0.min(bounds.width as f64).max(0.0);
    let pointer_y = pointer.1.min(bounds.height as f64).max(0.0);
    let anchor_x = bounds.x as f64 + pointer_x;
    let anchor_y = bounds.y as f64 + pointer_y;
    Rect {
        x: (anchor_x - (pointer_x / bounds.width as f64) * width as f64).round() as i32,
        y: (anchor_y - (pointer_y / bounds.height as f64) * height as f64).round() as i32,
        width,
        height,
    }
}

pub fn reset_pin_bounds(bounds: Rect, base_area: f64, aspect_ratio: f64) -> Rect {
    if bounds.width <= 0 || bounds.height <= 0 {
        return bounds;
    }
    let ratio = if aspect_ratio.is_finite() && aspect_ratio > 0.0 {
        aspect_ratio
    } else {
        bounds.width as f64 / bounds.height as f64
    };
    let area = if base_area.is_finite() && base_area > 0.0 {
        base_area
    } else {
        bounds.width as f64 * bounds.height as f64
    };
    let width = ((area * ratio).sqrt().round() as i32).max(1);
    let height = ((width as f64 / ratio).round() as i32).max(1);
    Rect {
        x: (bounds.x as f64 + (bounds.width - width) as f64 / 2.0).round() as i32,
        y: (bounds.y as f64 + (bounds.height - height) as f64 / 2.0).round() as i32,
        width,
        height,
    }
}

// ---------------------------------------------------------------- entry migration

pub fn migrate_entry(entry: &Value) -> Value {
    let mut out = entry.clone();
    let obj = out.as_object_mut().unwrap();
    let created_at = entry.get("createdAt").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let created_at = if created_at > 0.0 {
        created_at as u64
    } else {
        now_ms()
    };
    let last_copied = entry
        .get("lastCopiedAt")
        .and_then(|v| v.as_f64())
        .filter(|v| *v > 0.0)
        .map(|v| v as u64)
        .unwrap_or(created_at);
    let copy_count = entry
        .get("copyCount")
        .and_then(|v| v.as_f64())
        .filter(|v| *v >= 1.0)
        .unwrap_or(1.0) as i64;
    let is_image = entry.get("type").and_then(|v| v.as_str()) == Some("image");
    let formats = match entry.get("formats") {
        Some(Value::Array(a)) if !a.is_empty() => Value::Array(a.clone()),
        _ => json!([if is_image { "image/png" } else { "text/plain" }]),
    };
    let source = match entry.get("source") {
        Some(v @ Value::Object(_)) => v.clone(),
        _ => Value::Null,
    };
    obj.insert("createdAt".into(), json!(created_at));
    obj.insert("lastCopiedAt".into(), json!(last_copied));
    obj.insert("copyCount".into(), json!(copy_count));
    obj.insert("formats".into(), formats);
    obj.insert("source".into(), source);
    out
}

// ---------------------------------------------------------------- ids

pub fn random_id() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut hex = String::with_capacity(32);
    let now = now_ms();
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    for part in [now, n, std::process::id() as u64] {
        hex.push_str(&format!("{part:016x}"));
    }
    let mut hasher = RandomState::new().build_hasher();
    hasher.write(hex.as_bytes());
    let h1 = hasher.finish();
    let mut hasher2 = RandomState::new().build_hasher();
    hasher2.write(hex.as_bytes());
    hasher2.write(&h1.to_le_bytes());
    let h2 = hasher2.finish();
    format!("{h1:016x}{h2:016x}")
}

// ---------------------------------------------------------------- png size (IHDR)

pub fn png_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || &bytes[0..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    if width == 0 || height == 0 {
        return None;
    }
    Some((width, height))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha1_matches_reference_vectors() {
        assert_eq!(sha1_hex(b""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(sha1_hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(
            sha1_hex(b"The quick brown fox jumps over the lazy dog"),
            "2fd4e1c67a2d28fced849ee1bb76e7391b93eb12"
        );
    }

    #[test]
    fn classify_text_known_cases() {
        assert_eq!(classify_text("https://example.com/x"), "url");
        assert_eq!(classify_text("HTTP://example.com"), "url");
        assert_eq!(classify_text("npm run dev"), "code");
        assert_eq!(classify_text("C:\\Users\\test\\file.txt"), "file");
        assert_eq!(classify_text("\\\\server\\share\\doc"), "file");
        assert_eq!(classify_text("你好世界"), "text");
        assert_eq!(classify_text("SELECT * FROM t;"), "code");
    }

    #[test]
    fn entry_titles() {
        assert_eq!(entry_title("https://www.example.com/a\nb", "url", &[]), "example.com");
        assert_eq!(entry_title("", "file", &["C:\\a\\b.txt".into()]), "b.txt");
        assert_eq!(
            entry_title("", "file", &["C:\\a\\b.txt".into(), "C:\\a\\c.txt".into()]),
            "b.txt 等 2 个文件"
        );
    }

    #[test]
    fn sensitive_rules() {
        assert_eq!(detect_sensitive("password: abcd1234").map(|(_, l)| l), Some("密码"));
        assert_eq!(
            detect_sensitive("-----BEGIN RSA PRIVATE KEY-----").map(|(_, l)| l),
            Some("私钥")
        );
        assert_eq!(detect_sensitive("4111111111111111").map(|(_, l)| l), Some("银行卡号"));
        assert_eq!(detect_sensitive("普通文本内容"), None);
    }

    #[test]
    fn geometry_matches_js() {
        let display = Rect { x: 0, y: 0, width: 2560, height: 1440 };
        let region = default_capture_region(display, (1300, 700), 520, 320);
        assert_eq!(region, Rect { x: 1040, y: 540, width: 520, height: 320 });

        let b = zoom_pin_bounds(
            Rect { x: 100, y: 100, width: 400, height: 300 },
            (200.0, 150.0),
            -100.0,
            4.0 / 3.0,
        );
        assert_eq!(b.width, 448);
        assert_eq!(b.height, 336);
        // Pointer anchored at its own position within the new size.
        let expected_x = (300.0f64 - 0.5 * 448.0).round() as i32;
        assert_eq!(b.x, expected_x);

        let r = reset_pin_bounds(Rect { x: 0, y: 0, width: 800, height: 100 }, 400.0 * 300.0, 4.0 / 3.0);
        assert_eq!((r.width, r.height), (400, 300));
    }

    #[test]
    fn fingerprints_stable() {
        let fp = text_fingerprint("hello", "");
        assert!(fp.starts_with("text:"));
        assert_eq!(fp, format!("text:{}", sha1_hex(b"hello\n")));
    }
}
