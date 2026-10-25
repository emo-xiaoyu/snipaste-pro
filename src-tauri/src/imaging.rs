// Imaging pipeline on Windows built-ins only: WinRT BitmapDecoder/Encoder for
// PNG codec, manual bilinear scaling, tiny base64, and a data-URL builder.
// Replaces Electron nativeImage and System.Drawing in the old PS bridge.

use serde_json::Value;
use windows::core::Interface;
use windows::Graphics::Imaging::{
    BitmapAlphaMode, BitmapBufferAccessMode, BitmapDecoder, BitmapEncoder,
    BitmapPixelFormat, SoftwareBitmap,
};
use windows::Storage::Streams::{
    DataReader, DataWriter, InMemoryRandomAccessStream,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::WinRT::IMemoryBufferByteAccess;

/// Best-effort MTA init per calling thread; ignore "already initialized"
/// and "wrong apartment mode" outcomes like the JS runtime does.
pub fn ensure_mta() {
    unsafe {
        let _ = CoInitializeEx(Some(std::ptr::null()), COINIT_MULTITHREADED);
    }
}

// ---------------------------------------------------------------- base64

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64[(triple >> 18) as usize & 63] as char);
        out.push(B64[(triple >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(triple >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[triple as usize & 63] as char } else { '=' });
    }
    out
}

pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    fn value(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a' + 26) as u32),
            b'0'..=b'9' => Some((c - b'0' + 52) as u32),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for ch in text.bytes() {
        if ch == b'=' || ch == b'\r' || ch == b'\n' {
            continue;
        }
        let v = value(ch)?;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

pub fn png_data_url(png: &[u8]) -> String {
    format!("data:image/png;base64,{}", base64_encode(png))
}

// ---------------------------------------------------------------- decode

/// Decode PNG bytes into (width, height, BGRA8 pixels). Converts to Bgra8
/// when the decoder produced another layout.
pub fn decode_bgra(png: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
    ensure_mta();
    let stream = InMemoryRandomAccessStream::new().map_err(|e| e.to_string())?;
    write_stream(&stream, png)?;
    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;
    let mut bitmap = decoder
        .GetSoftwareBitmapAsync()
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;
    if bitmap.BitmapPixelFormat().map_err(|e| e.to_string())? != BitmapPixelFormat::Bgra8 {
        bitmap = SoftwareBitmap::ConvertWithAlpha(
            &bitmap,
            BitmapPixelFormat::Bgra8,
            BitmapAlphaMode::Premultiplied,
        )
        .map_err(|e| e.to_string())?;
    }
    let w = bitmap.PixelWidth().map_err(|e| e.to_string())? as u32;
    let h = bitmap.PixelHeight().map_err(|e| e.to_string())? as u32;
    let pixels = lock_pixels(&bitmap, w, h)?;
    Ok((w, h, pixels))
}

pub fn decode_bgra_file(path: &std::path::Path) -> Result<(u32, u32, Vec<u8>), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读取图片失败：{e}"))?;
    decode_bgra(&bytes)
}

fn lock_pixels(bitmap: &SoftwareBitmap, w: u32, h: u32) -> Result<Vec<u8>, String> {
    let buffer = bitmap
        .LockBuffer(BitmapBufferAccessMode::Read)
        .map_err(|e| e.to_string())?;
    let reference = buffer.CreateReference().map_err(|e| e.to_string())?;
    let byte_access: IMemoryBufferByteAccess = reference.cast().map_err(|e| e.to_string())?;
    let mut data: *mut u8 = std::ptr::null_mut();
    let mut capacity: u32 = 0;
    unsafe {
        byte_access
            .GetBuffer(&mut data, &mut capacity)
            .map_err(|e| e.to_string())?;
        let len = (w * h * 4) as usize;
        if (capacity as usize) < len {
            return Err("位图缓冲区大小不足".into());
        }
        Ok(std::slice::from_raw_parts(data, len).to_vec())
    }
}

// ---------------------------------------------------------------- encode

fn write_stream(stream: &InMemoryRandomAccessStream, bytes: &[u8]) -> Result<(), String> {
    let writer = DataWriter::CreateDataWriter(stream).map_err(|e| e.to_string())?;
    writer.WriteBytes(bytes).map_err(|e| e.to_string())?;
    writer.StoreAsync().map_err(|e| e.to_string())?.get().map_err(|e| e.to_string())?;
    writer.FlushAsync().map_err(|e| e.to_string())?.get().map_err(|e| e.to_string())?;
    let _ = writer.DetachStream();
    stream.Seek(0).map_err(|e| e.to_string())?;
    Ok(())
}

fn read_stream(stream: &InMemoryRandomAccessStream) -> Result<Vec<u8>, String> {
    stream.Seek(0).map_err(|e| e.to_string())?;
    let size = stream.Size().map_err(|e| e.to_string())? as usize;
    if size == 0 {
        return Err("编码输出为空".into());
    }
    let reader = DataReader::CreateDataReader(stream).map_err(|e| e.to_string())?;
    reader
        .LoadAsync(size as u32)
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;
    let mut out = vec![0u8; size];
    reader.ReadBytes(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

/// Encode BGRA8 pixels as PNG bytes.
pub fn encode_png(w: u32, h: u32, bgra: &[u8]) -> Result<Vec<u8>, String> {
    ensure_mta();
    let stream = InMemoryRandomAccessStream::new().map_err(|e| e.to_string())?;
    let encoder_id = BitmapEncoder::PngEncoderId().map_err(|e| e.to_string())?;
    let encoder = BitmapEncoder::CreateAsync(encoder_id, &stream)
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;
    encoder
        .SetPixelData(BitmapPixelFormat::Bgra8, BitmapAlphaMode::Straight, w, h, 96.0, 96.0, bgra)
        .map_err(|e| e.to_string())?;
    encoder.FlushAsync().map_err(|e| e.to_string())?.get().map_err(|e| e.to_string())?;
    read_stream(&stream)
}

// ---------------------------------------------------------------- scaling

/// Bilinear resize of a BGRA8 buffer.
pub fn resize_bgra(w: u32, h: u32, src: &[u8], tw: u32, th: u32) -> Vec<u8> {
    if tw == 0 || th == 0 || w == 0 || h == 0 {
        return Vec::new();
    }
    if tw == w && th == h {
        return src.to_vec();
    }
    let mut out = vec![0u8; (tw * th * 4) as usize];
    let x_ratio = w as f64 / tw as f64;
    let y_ratio = h as f64 / th as f64;
    for dy in 0..th {
        let sy = (dy as f64 + 0.5) * y_ratio - 0.5;
        let y0 = sy.floor().max(0.0) as u32;
        let y1 = (y0 + 1).min(h - 1);
        let fy = (sy - y0 as f64).clamp(0.0, 1.0);
        for dx in 0..tw {
            let sx = (dx as f64 + 0.5) * x_ratio - 0.5;
            let x0 = sx.floor().max(0.0) as u32;
            let x1 = (x0 + 1).min(w - 1);
            let fx = (sx - x0 as f64).clamp(0.0, 1.0);
            for c in 0..4 {
                let p00 = src[((y0 * w + x0) * 4 + c) as usize] as f64;
                let p10 = src[((y0 * w + x1) * 4 + c) as usize] as f64;
                let p01 = src[((y1 * w + x0) * 4 + c) as usize] as f64;
                let p11 = src[((y1 * w + x1) * 4 + c) as usize] as f64;
                let top = p00 + (p10 - p00) * fx;
                let bottom = p01 + (p11 - p01) * fx;
                out[((dy * tw + dx) * 4 + c) as usize] = (top + (bottom - top) * fy).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    out
}

/// Thumbnail data URL mirroring `nativeImage.resize({ width: 300 })`: the
/// output is exactly `width` pixels wide, height scaled to preserve aspect.
pub fn thumbnail_data_url(png_bytes: &[u8]) -> Option<String> {
    let (w, h, pixels) = decode_bgra(png_bytes).ok()?;
    if w == 0 || h == 0 {
        return None;
    }
    let tw = 300u32;
    let th = (((h as f64) * (tw as f64) / w as f64).round() as u32).max(1);
    let scaled = resize_bgra(w, h, &pixels, tw, th);
    let png = encode_png(tw, th, &scaled).ok()?;
    Some(png_data_url(&png))
}

/// Rotate/flip BGRA pixels in place semantics matching the renderer matrix
/// plans (used by pin transforms, which are renderer-side; kept for parity).
#[allow(dead_code)]
pub fn transform_bgra(w: u32, h: u32, src: &[u8], rotate_cw: bool) -> Vec<u8> {
    let mut out = vec![0u8; src.len()];
    for y in 0..h {
        for x in 0..w {
            let (tx, ty) = if rotate_cw { (h - 1 - y, x) } else { (y, w - 1 - x) };
            for c in 0..4 {
                out[((ty * w + tx) * 4 + c) as usize] = src[((y * w + x) * 4 + c) as usize];
            }
        }
    }
    out
}

// ---------------------------------------------------------------- json helpers

#[allow(dead_code)]
pub fn image_size_json(w: u32, h: u32) -> Value {
    serde_json::json!({ "width": w, "height": h })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_roundtrip() {
        assert_eq!(base64_encode(b"Man"), "TWFu");
        assert_eq!(base64_encode(b"Ma"), "TWE=");
        assert_eq!(base64_encode(b"M"), "TQ==");
        let data = vec![0u8, 1, 2, 250, 251, 252, 77];
        assert_eq!(base64_decode(&base64_encode(&data)).unwrap(), data);
    }

    #[test]
    fn resize_preserves_dims() {
        let src = vec![10u8; 4 * 4 * 4];
        let out = resize_bgra(4, 4, &src, 8, 8);
        assert_eq!(out.len(), 8 * 8 * 4);
        assert!(out.iter().all(|v| *v == 10));
    }
}
