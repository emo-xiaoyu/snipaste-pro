// In-process Windows OCR (Windows.Media.Ocl via windows-rs), replacing the
// powershell.exe-per-recognition bridge. Word boxes are flattened into the
// per-character item contract that pin.jsx / pin-text-selection.js expects;
// the upscale (<700px x2) / downscale (>engine limit) policy and coordinate
// mapping back to the source image are ported from win-ocr.ps1 + win-ocr-core.cjs.

use crate::imaging::{decode_bgra, encode_png, resize_bgra};
use serde_json::{json, Value};
use windows::core::h;
use windows::Globalization::Language;
use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapDecoder, BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};

pub struct OcrOutcome {
    pub text: String,
    pub items: Vec<Value>,
}

const FALLBACK_MAX_DIMENSION: u32 = 4096;

fn create_engine() -> Result<OcrEngine, String> {
    let zh = Language::CreateLanguage(h!("zh-Hans")).map_err(|e| e.to_string())?;
    if let Ok(engine) = OcrEngine::TryCreateFromLanguage(&zh) {
        return Ok(engine);
    }
    OcrEngine::TryCreateFromUserProfileLanguages().map_err(|e| e.to_string())
}

fn max_dimension() -> u32 {
    OcrEngine::MaxImageDimension().unwrap_or(FALLBACK_MAX_DIMENSION).max(1)
}

fn bitmap_from_png_bytes(bytes: &[u8]) -> Result<SoftwareBitmap, String> {
    crate::imaging::ensure_mta();
    let stream = InMemoryRandomAccessStream::new().map_err(|e| e.to_string())?;
    let writer = DataWriter::CreateDataWriter(&stream).map_err(|e| e.to_string())?;
    writer.WriteBytes(bytes).map_err(|e| e.to_string())?;
    writer.StoreAsync().map_err(|e| e.to_string())?.get().map_err(|e| e.to_string())?;
    writer.FlushAsync().map_err(|e| e.to_string())?.get().map_err(|e| e.to_string())?;
    let _ = writer.DetachStream();
    stream.Seek(0).map_err(|e| e.to_string())?;

    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;
    decoder
        .GetSoftwareBitmapAsync()
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())
}

fn software_bitmap_to_bgra8(bitmap: SoftwareBitmap) -> Result<SoftwareBitmap, String> {
    if bitmap.BitmapPixelFormat().map_err(|e| e.to_string())? == BitmapPixelFormat::Bgra8 {
        return Ok(bitmap);
    }
    SoftwareBitmap::ConvertWithAlpha(&bitmap, BitmapPixelFormat::Bgra8, BitmapAlphaMode::Premultiplied)
        .map_err(|e| e.to_string())
}

/// Recognize a PNG image. `source_w/source_h` describe the original pin image
/// so hit boxes map back to it even when the engine bitmap was rescaled.
pub fn recognize_png(png_bytes: &[u8], source_w: u32, source_h: u32) -> Result<OcrOutcome, String> {
    let Some((png_w, png_h)) = crate::core::png_size(png_bytes) else {
        return Err("无法读取贴图内容".into());
    };
    let max_dim = max_dimension();
    let longest = png_w.max(png_h);
    let target: u32 = if longest > max_dim {
        max_dim
    } else if longest < 700 {
        (max_dim).min(longest.saturating_mul(2))
    } else {
        longest
    };

    let bitmap = if target == longest {
        software_bitmap_to_bgra8(bitmap_from_png_bytes(png_bytes)?)?
    } else {
        // Match win-ocr.ps1: scale factor applied per axis, truncated to int.
        let scale = target as f64 / longest as f64;
        let tw = ((png_w as f64) * scale) as u32;
        let th = ((png_h as f64) * scale) as u32;
        let (w, h, pixels) = decode_bgra(png_bytes)?;
        let resized = resize_bgra(w, h, &pixels, tw.max(1), th.max(1));
        let reencoded = encode_png(tw.max(1), th.max(1), &resized)?;
        software_bitmap_to_bgra8(bitmap_from_png_bytes(&reencoded)?)?
    };

    let bitmap_w = bitmap.PixelWidth().map_err(|e| e.to_string())?;
    let bitmap_h = bitmap.PixelHeight().map_err(|e| e.to_string())?;

    let engine = create_engine()?;
    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;

    let text = result.Text().map_err(|e| e.to_string())?.to_string();
    let lines = result.Lines().map_err(|e| e.to_string())?;

    let scale_x = if bitmap_w > 0 { source_w as f64 / bitmap_w as f64 } else { 1.0 };
    let scale_y = if bitmap_h > 0 { source_h as f64 / bitmap_h as f64 } else { 1.0 };

    let mut items: Vec<Value> = Vec::new();
    let mut line_id: u32 = 0;
    let mut word_id: u32 = 0;
    for line in lines {
        let words = line.Words().map_err(|e| e.to_string())?;
        let mut emitted_words = 0usize;
        let line_start = items.len();
        for word in words {
            let word_text = word.Text().map_err(|e| e.to_string())?.to_string();
            let characters: Vec<char> = word_text
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect();
            if characters.is_empty() {
                continue;
            }
            let rect = word.BoundingRect().map_err(|e| e.to_string())?;
            let x = rect.X as f64;
            let y = rect.Y as f64;
            let w = rect.Width as f64;
            let h = rect.Height as f64;
            if w <= 0.0 || h <= 0.0 {
                continue;
            }
            let count = characters.len();
            let word_start = items.len();
            for (index, character) in characters.iter().enumerate() {
                let x0 = x + w * index as f64 / count as f64;
                let x1 = x + w * (index + 1) as f64 / count as f64;
                let prefix = if items.is_empty() {
                    ""
                } else if items.len() == line_start {
                    "\n"
                } else if index == 0 {
                    " "
                } else {
                    ""
                };
                items.push(json!({
                    "text": character.to_string(),
                    "prefix": prefix,
                    "lineId": line_id,
                    "wordId": word_id,
                    "bbox": {
                        "x0": x0 * scale_x,
                        "y0": y * scale_y,
                        "x1": x1 * scale_x,
                        "y1": (y + h) * scale_y,
                    },
                }));
            }
            if items.len() > word_start {
                word_id += 1;
                emitted_words += 1;
            }
        }
        if emitted_words > 0 {
            line_id += 1;
        }
    }
    Ok(OcrOutcome { text, items })
}

/// recognizePinImage result shape from electron/main.cjs.
pub fn recognize_payload(png_bytes: &[u8], source_w: u32, source_h: u32) -> Result<Value, String> {
    let outcome = recognize_png(png_bytes, source_w, source_h)?;
    if outcome.items.is_empty() {
        return Err("没有识别到可选择的文字或数字".into());
    }
    // JS string length counts UTF-16 code units.
    let char_count = outcome.text.encode_utf16().count();
    Ok(json!({
        "success": true,
        "engine": "windows",
        "charCount": char_count,
        "confidence": 100,
        "imageSize": { "width": source_w, "height": source_h },
        "items": outcome.items,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Real-engine end-to-end check on the bundled test image (zh-Hans pack
    // required, present on the dev machine). Verifies the pin text-selection
    // contract: per-character items, prefix hints, and source-space bboxes.
    #[test]
    fn recognize_payload_contract() {
        let bytes = include_bytes!("../assets/ocr-text.png");
        let (w, h) = crate::core::png_size(bytes).expect("png header");
        let payload = recognize_payload(bytes, w, h).expect("ocr");
        assert_eq!(payload["success"], serde_json::json!(true));
        assert_eq!(payload["engine"], serde_json::json!("windows"));
        let items = payload["items"].as_array().expect("items array");
        assert!(!items.is_empty(), "expected recognized characters");
        let text: String = items
            .iter()
            .filter_map(|i| i["text"].as_str())
            .collect();
        for expected in ['滑', '动', '质', '量'] {
            assert!(text.contains(expected), "missing {expected} in {text}");
        }
        // First item carries no prefix; line starts carry a newline.
        assert_eq!(items[0]["prefix"], serde_json::json!(""));
        // Hit boxes stay inside the source image bounds.
        for item in items {
            let bbox = &item["bbox"];
            let x0 = bbox["x0"].as_f64().unwrap();
            let x1 = bbox["x1"].as_f64().unwrap();
            let y0 = bbox["y0"].as_f64().unwrap();
            let y1 = bbox["y1"].as_f64().unwrap();
            assert!(x1 > x0 && y1 > y0, "degenerate box");
            assert!(x0 >= 0.0 && y0 >= 0.0 && x1 <= w as f64 + 1.0 && y1 <= h as f64 + 1.0, "box outside source");
        }
    }
}
