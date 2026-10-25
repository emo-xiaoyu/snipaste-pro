// Win32 clipboard access, replacing Electron's clipboard module and the
// readFiles/writeFiles bridge ops. Handles: CF_UNICODETEXT, "HTML Format",
// CF_HDROP file lists, and images (prefer the registered "PNG" format, fall
// back to CF_DIB/CF_DIBV5 parsing like Chromium's readImage).

use std::thread::sleep;
use std::time::Duration;
use windows::Win32::Foundation::{HANDLE, HGLOBAL};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData,
    GetClipboardFormatNameW, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::UI::Shell::DROPFILES;

const CF_UNICODETEXT: u32 = 13;
const CF_DIB: u32 = 8;
const CF_DIBV5: u32 = 17;
const CF_HDROP: u32 = 15;

pub struct ClipboardGuard;

impl ClipboardGuard {
    pub fn open() -> Option<ClipboardGuard> {
        // Other apps can hold the clipboard briefly; retry like Chromium.
        for _ in 0..8 {
            if unsafe { OpenClipboard(None) }.is_ok() {
                return Some(ClipboardGuard);
            }
            sleep(Duration::from_millis(8));
        }
        None
    }
}

impl Drop for ClipboardGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseClipboard();
        }
    }
}

pub fn sequence_number() -> u32 {
    unsafe { windows::Win32::System::DataExchange::GetClipboardSequenceNumber() }
}

fn registered_format(name: &str) -> u32 {
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { RegisterClipboardFormatW(windows::core::PCWSTR(wide.as_ptr())) }
}

fn png_format() -> u32 {
    registered_format("PNG")
}

fn html_format() -> u32 {
    registered_format("HTML Format")
}

pub struct ClipboardSnapshot {
    pub has_unicode_text: bool,
    pub has_html: bool,
    pub has_png: bool,
    pub has_dib: bool,
    pub has_hdrop: bool,
    pub format_names: Vec<String>,
}

pub fn snapshot() -> ClipboardSnapshot {
    let mut out = ClipboardSnapshot {
        has_unicode_text: false,
        has_html: false,
        has_png: false,
        has_dib: false,
        has_hdrop: false,
        format_names: Vec::new(),
    };
    let png = png_format();
    let html = html_format();
    let Some(_guard) = ClipboardGuard::open() else { return out };
    unsafe {
        let mut format = EnumClipboardFormats(0);
        while format != 0 {
            match format {
                CF_UNICODETEXT => out.has_unicode_text = true,
                CF_DIB | CF_DIBV5 => out.has_dib = true,
                CF_HDROP => out.has_hdrop = true,
                f if f == png => out.has_png = true,
                f if f == html => out.has_html = true,
                _ => {}
            }
            let mut buffer = [0u16; 128];
            let len = GetClipboardFormatNameW(format, &mut buffer);
            if len > 0 {
                out.format_names
                    .push(String::from_utf16_lossy(&buffer[..len as usize]));
            }
            format = EnumClipboardFormats(format);
        }
    }
    out
}

// ---------------------------------------------------------------- reading

fn lock_hglobal(handle: HANDLE) -> Option<(HGLOBAL, usize)> {
    if handle.is_invalid() || handle.0.is_null() {
        return None;
    }
    let hglobal = HGLOBAL(handle.0);
    let size = unsafe { GlobalSize(hglobal) };
    Some((hglobal, size))
}

pub fn read_text() -> Option<String> {
    let Some(_guard) = ClipboardGuard::open() else { return None };
    unsafe {
        let handle = GetClipboardData(CF_UNICODETEXT).ok()?;
        let (hglobal, size) = lock_hglobal(handle)?;
        let ptr = GlobalLock(hglobal) as *const u16;
        if ptr.is_null() {
            return None;
        }
        let len = size / 2;
        let mut end = len;
        for (i, item) in std::slice::from_raw_parts(ptr, len).iter().enumerate() {
            if *item == 0 {
                end = i;
                break;
            }
        }
        let text = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, end));
        let _ = GlobalUnlock(hglobal);
        Some(text)
    }
}

/// Extract the fragment between StartFragment/EndFragment offsets, matching
/// Chromium's clipboard.readHTML behavior on the "HTML Format" clipboard.
pub fn read_html() -> Option<String> {
    let format = html_format();
    if format == 0 {
        return None;
    }
    let Some(_guard) = ClipboardGuard::open() else { return None };
    unsafe {
        let handle = GetClipboardData(format).ok()?;
        let (hglobal, size) = lock_hglobal(handle)?;
        let ptr = GlobalLock(hglobal) as *const u8;
        if ptr.is_null() {
            return None;
        }
        let bytes = std::slice::from_raw_parts(ptr, size).to_vec();
        let _ = GlobalUnlock(hglobal);
        parse_html_fragment(&bytes)
    }
}

fn parse_html_fragment(bytes: &[u8]) -> Option<String> {
    let header = String::from_utf8_lossy(&bytes[..bytes.len().min(2048)]);
    let start = header
        .find("StartFragment:")
        .and_then(|i| header[i + 14..].trim().split(|c: char| c == '\r' || c == '\n').next())
        .and_then(|v| v.trim().parse::<usize>().ok());
    let end = header
        .find("EndFragment:")
        .and_then(|i| header[i + 12..].trim().split(|c: char| c == '\r' || c == '\n').next())
        .and_then(|v| v.trim().parse::<usize>().ok());
    if let (Some(s), Some(e)) = (start, end) {
        if e > s && e <= bytes.len() {
            return Some(String::from_utf8_lossy(&bytes[s..e]).to_string());
        }
    }
    // Fall back to the comment markers, like Chromium for non-standard headers.
    let text = String::from_utf8_lossy(bytes);
    let s = text.find("<!--StartFragment-->").map(|i| i + 20)?;
    let e = text.find("<!--EndFragment-->").unwrap_or(text.len());
    if e > s {
        Some(text[s..e].trim_start_matches('\r').trim_start_matches('\n').to_string())
    } else {
        None
    }
}

pub fn read_png_bytes() -> Option<Vec<u8>> {
    let format = png_format();
    if format == 0 {
        return None;
    }
    let Some(_guard) = ClipboardGuard::open() else { return None };
    unsafe {
        let handle = GetClipboardData(format).ok()?;
        let (hglobal, size) = lock_hglobal(handle)?;
        let ptr = GlobalLock(hglobal) as *const u8;
        if ptr.is_null() {
            return None;
        }
        let bytes = std::slice::from_raw_parts(ptr, size).to_vec();
        let _ = GlobalUnlock(hglobal);
        if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            Some(bytes)
        } else {
            None
        }
    }
}

/// Parse CF_DIB / CF_DIBV5 into top-down 32bpp BGRA (Chromium readImage parity:
/// BI_RGB 32bpp is treated as opaque).
pub fn read_dib_bgra() -> Option<(u32, u32, Vec<u8>)> {
    let Some(_guard) = ClipboardGuard::open() else { return None };
    unsafe {
        let handle = GetClipboardData(CF_DIBV5)
            .or_else(|_| GetClipboardData(CF_DIB))
            .ok()?;
        let (hglobal, size) = lock_hglobal(handle)?;
        let ptr = GlobalLock(hglobal) as *const u8;
        if ptr.is_null() {
            return None;
        }
        let bytes = std::slice::from_raw_parts(ptr, size).to_vec();
        let _ = GlobalUnlock(hglobal);
        parse_dib(&bytes)
    }
}

fn read_u32(b: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
}
fn read_i32(b: &[u8], off: usize) -> i32 {
    i32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
}

fn parse_dib(bytes: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
    if bytes.len() < 40 {
        #[cfg(test)]
        eprintln!("parse_dib None at #1");
        return None;
    }
    let header_size = read_u32(bytes, 0) as usize;
    if header_size < 40 || bytes.len() < header_size {
        #[cfg(test)]
        eprintln!("parse_dib None at #2");
        return None;
    }
    let width = read_i32(bytes, 4);
    let raw_height = read_i32(bytes, 8);
    let bottom_up = raw_height > 0;
    let height = raw_height.unsigned_abs();
    let planes = read_u16(bytes, 12);
    let bpp = read_u16(bytes, 14);
    let compression = read_u32(bytes, 16);
    if width <= 0 || height == 0 || planes != 1 {
        #[cfg(test)]
        eprintln!("parse_dib None at #3");
        return None;
    }
    let (width, height) = (width as u32, height);
    if bpp != 32 && bpp != 24 {
        #[cfg(test)]
        eprintln!("parse_dib None at #4");
        return None;
    }
    // Color masks: default for BI_RGB; explicit for BI_BITFIELDS (V4/V5).
    let mut mask_r = 0x00FF0000u32;
    let mut mask_g = 0x0000FF00u32;
    let mut mask_b = 0x000000FFu32;
    if compression == 3 && header_size >= 52 {
        mask_r = read_u32(bytes, 40);
        mask_g = read_u32(bytes, 44);
        mask_b = read_u32(bytes, 48);
    } else if compression != 0 && compression != 3 {
        #[cfg(test)]
        eprintln!("parse_dib None at #5");
        return None;
    }
    let pixel_offset = header_size.max(if compression == 3 { 52 } else { 40 });
    let stride = ((width as usize * bpp as usize + 31) / 32) * 4;
    if bytes.len() < pixel_offset + stride * height as usize {
        #[cfg(test)]
        eprintln!("parse_dib bounds fail: len={} offset={} stride={} h={}", bytes.len(), pixel_offset, stride, height);
        #[cfg(test)]
        eprintln!("parse_dib None at #6");
        return None;
    }
    let src = &bytes[pixel_offset..];
    let mut out = vec![255u8; (width * height * 4) as usize];
    for row in 0..height as usize {
        let src_y = if bottom_up { height as usize - 1 - row } else { row };
        for col in 0..width as usize {
            let si = src_y * stride + col * (bpp as usize / 8);
            let (b, g, r) = if bpp == 32 {
                let px = u32::from_le_bytes([src[si], src[si + 1], src[si + 2], src[si + 3]]);
                (channel(px, mask_b), channel(px, mask_g), channel(px, mask_r))
            } else {
                (src[si], src[si + 1], src[si + 2])
            };
            let di = (row * width as usize + col) * 4;
            out[di] = b;
            out[di + 1] = g;
            out[di + 2] = r;
            out[di + 3] = 255;
        }
    }
    Some((width, height, out))
}

fn read_u16(b: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([b[off], b[off + 1]])
}

fn channel(px: u32, mask: u32) -> u8 {
    if mask == 0 {
        return 0;
    }
    let shift = mask.trailing_zeros();
    let bits = mask.count_ones();
    let v = (px & mask) >> shift;
    if bits >= 8 {
        (v.min(0xFF)) as u8
    } else {
        ((v * 255) / ((1u32 << bits) - 1)) as u8
    }
}

pub fn read_files() -> Vec<String> {
    let Some(_guard) = ClipboardGuard::open() else { return Vec::new() };
    unsafe {
        let Ok(handle) = GetClipboardData(CF_HDROP) else {
            return Vec::new();
        };
        let (hglobal, _size) = match lock_hglobal(handle) {
            Some(v) => v,
            None => return Vec::new(),
        };
        let ptr = GlobalLock(hglobal) as *const DROPFILES;
        if ptr.is_null() {
            return Vec::new();
        }
        let drop = *ptr;
        let base = ptr as *const u8;
        let offset = drop.pFiles as usize;
        if !drop.fWide.as_bool() {
            let _ = GlobalUnlock(hglobal);
            return Vec::new();
        }
        let wide_ptr = base.add(offset) as *const u16;
        // Iterate double-null-terminated wide strings without knowing the length:
        // bound the scan by the allocation size.
        let alloc_units = (_size.saturating_sub(offset)) / 2;
        let mut paths = Vec::new();
        let mut index = 0usize;
        'outer: loop {
            let mut chars = Vec::new();
            loop {
                if index >= alloc_units {
                    break 'outer;
                }
                let ch = *wide_ptr.add(index);
                index += 1;
                if ch == 0 {
                    break;
                }
                chars.push(ch);
            }
            if chars.is_empty() {
                break;
            }
            paths.push(String::from_utf16_lossy(&chars));
        }
        let _ = GlobalUnlock(hglobal);
        paths
    }
}

// ---------------------------------------------------------------- writing

fn set_bytes(format: u32, bytes: &[u8]) -> bool {
    unsafe {
        let Ok(hglobal) = GlobalAlloc(GMEM_MOVEABLE, bytes.len()) else {
            return false;
        };
        let ptr = GlobalLock(hglobal) as *mut u8;
        if ptr.is_null() {
            return false;
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
        let _ = GlobalUnlock(hglobal);
        SetClipboardData(format, Some(HANDLE(hglobal.0))).is_ok()
    }
}

fn set_wide_string(format: u32, text: &str) -> bool {
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    set_bytes(format, &align_bytes_u16(&wide))
}

fn align_bytes_u16(wide: &[u16]) -> Vec<u8> {
    wide.iter().flat_map(|v| v.to_le_bytes()).collect()
}

pub fn write_text(text: &str) {
    let Some(_guard) = ClipboardGuard::open() else { return };
    unsafe {
        if EmptyClipboard().is_ok() {
            set_wide_string(CF_UNICODETEXT, text);
        }
    }
}

pub fn write_rich(text: &str, html: &str) {
    let Some(_guard) = ClipboardGuard::open() else { return };
    unsafe {
        if EmptyClipboard().is_ok() {
            set_wide_string(CF_UNICODETEXT, text);
            let format = html_format();
            if format != 0 {
                if let Some(payload) = build_html_format(html) {
                    set_bytes(format, &payload);
                }
            }
        }
    }
}

/// Wrap a fragment into the "HTML Format" clipboard layout (CF header with
/// byte offsets), mirroring Chromium's clipboard writer.
fn build_html_format(fragment: &str) -> Option<Vec<u8>> {
    // Fixed-width 10-digit offsets, computed after assembly.
    let before = "<html><body>\r\n<!--StartFragment-->";
    let after = "<!--EndFragment-->\r\n</body>\r\n</html>";
    // Header length is constant because every offset is 10 digits.
    let header_len = "Version:0.9\r\nStartHTML:0000000000\r\nEndHTML:0000000000\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n".len();
    let start_html = header_len;
    let start_fragment = start_html + before.len();
    let end_fragment = start_fragment + fragment.len();
    let end_html = end_fragment + after.len();
    let fmt10 = |v: usize| format!("{v:010}");
    Some(format!(
        "Version:0.9\r\nStartHTML:{}\r\nEndHTML:{}\r\nStartFragment:{}\r\nEndFragment:{}\r\n{}{}{}",
        fmt10(start_html),
        fmt10(end_html),
        fmt10(start_fragment),
        fmt10(end_fragment),
        before,
        fragment,
        after
    )
    .into_bytes())
}

/// Write an image as both the registered "PNG" format and a 32bpp
/// BITMAPV5HEADER CF_DIB (BI_BITFIELDS masks), which is what Chromium emits.
pub fn write_image_png(png_bytes: &[u8]) -> bool {
    let Ok((w, h, bgra)) = crate::imaging::decode_bgra(png_bytes) else {
        return false;
    };
    let Some(_guard) = ClipboardGuard::open() else { return false };
    unsafe {
        if EmptyClipboard().is_err() {
            return false;
        }
        let png_format = png_format();
        if png_format != 0 {
            set_bytes(png_format, png_bytes);
        }
        // BITMAPV5HEADER (124 bytes) + top-down BGRA pixels in one HGLOBAL.
        let mut header: Vec<u8> = Vec::with_capacity(124);
        let mut push = |bytes: &[u8]| header.extend_from_slice(bytes);
        push(&124u32.to_le_bytes()); // bV5Size
        push(&(w as i32).to_le_bytes());
        push(&(-(h as i32)).to_le_bytes()); // top-down
        push(&1u16.to_le_bytes()); // planes
        push(&32u16.to_le_bytes()); // bpp
        push(&3u32.to_le_bytes()); // BI_BITFIELDS
        push(&(w * h * 4).to_le_bytes());
        push(&2835i32.to_le_bytes()); // ppm x
        push(&2835i32.to_le_bytes()); // ppm y
        push(&0u32.to_le_bytes());
        push(&0u32.to_le_bytes());
        push(&0x00FF0000u32.to_le_bytes()); // red mask
        push(&0x0000FF00u32.to_le_bytes()); // green mask
        push(&0x000000FFu32.to_le_bytes()); // blue mask
        push(&0xFF000000u32.to_le_bytes()); // alpha mask
        // CSType + endpoints + gammas + intent/profile (remaining 68 bytes).
        push(&[0u8; 68]);
        let mut dib = header;
        dib.extend_from_slice(&bgra);
        set_bytes(CF_DIBV5, &dib)
    }
}

pub fn write_files(paths: &[String]) -> bool {
    if paths.is_empty() {
        return false;
    }
    let mut wide = Vec::<u16>::new();
    for path in paths {
        wide.extend(path.encode_utf16());
        wide.push(0);
    }
    wide.push(0); // double-null terminated list
    let drop_size = std::mem::size_of::<DROPFILES>();
    let byte_len = drop_size + wide.len() * 2;
    let Some(_guard) = ClipboardGuard::open() else { return false };
    unsafe {
        if EmptyClipboard().is_err() {
            return false;
        }
        let Ok(hglobal) = GlobalAlloc(GMEM_MOVEABLE, byte_len) else {
            return false;
        };
        let ptr = GlobalLock(hglobal) as *mut u8;
        if ptr.is_null() {
            return false;
        }
        std::ptr::write_bytes(ptr, 0, byte_len);
        let drop = ptr as *mut DROPFILES;
        (*drop).pFiles = drop_size as u32;
        (*drop).fWide = windows::core::BOOL(1);
        let dest = ptr.add(drop_size) as *mut u16;
        std::ptr::copy_nonoverlapping(wide.as_ptr(), dest, wide.len());
        let _ = GlobalUnlock(hglobal);
        SetClipboardData(CF_HDROP, Some(HANDLE(hglobal.0))).is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_fragment_parsing() {
        let header = "Version:0.9\r\nStartHTML:0000000139\r\nEndHTML:0000000259\r\nStartFragment:0000000181\r\nEndFragment:0000000225\r\n";
        let before = "<html><body>\r\n<!--StartFragment-->";
        let fragment = "<b>hello</b>";
        let after = "<!--EndFragment-->\r\n</body>\r\n</html>";
        let mut bytes = header.as_bytes().to_vec();
        let start_fragment = bytes.len() + before.len();
        let end_fragment = start_fragment + fragment.len();
        bytes.extend_from_slice(before.as_bytes());
        bytes.extend_from_slice(fragment.as_bytes());
        bytes.extend_from_slice(after.as_bytes());
        // Fix offsets with real values.
        let fix = |bytes: &mut Vec<u8>, at: usize, value: usize| {
            let text = format!("{value:010}");
            bytes[at..at + 10].copy_from_slice(text.as_bytes());
        };
        let sf_pos = header.find("StartFragment:").unwrap() + 14;
        let ef_pos = header.find("EndFragment:").unwrap() + 12;
        fix(&mut bytes, sf_pos, start_fragment);
        fix(&mut bytes, ef_pos, end_fragment);
        assert_eq!(parse_html_fragment(&bytes).unwrap(), "<b>hello</b>");
    }

    #[test]
    fn html_format_roundtrip() {
        let payload = build_html_format("<i>x</i>").unwrap();
        assert_eq!(parse_html_fragment(&payload).unwrap(), "<i>x</i>");
    }

    #[test]
    fn dib_parse_32bpp() {
        // 2x2 bottom-up 32bpp BI_RGB DIB.
        let mut dib = Vec::new();
        dib.extend_from_slice(&40u32.to_le_bytes());
        dib.extend_from_slice(&2i32.to_le_bytes());
        dib.extend_from_slice(&2i32.to_le_bytes());
        dib.extend_from_slice(&1u16.to_le_bytes());
        dib.extend_from_slice(&32u16.to_le_bytes());
        dib.extend_from_slice(&0u32.to_le_bytes());
        // biSizeImage..biClrImportant (remaining 20 bytes of the 40-byte header)
        dib.extend_from_slice(&[0u8; 20]);
        // pixels: bottom row first
        for px in [[3u8, 4, 5, 255], [6, 7, 8, 255], [9, 10, 11, 255], [12, 13, 14, 255]] {
            dib.extend_from_slice(&px);
        }
        let (w, h, bgra) = parse_dib(&dib).unwrap();
        assert_eq!((w, h), (2, 2));
        // top-down order flipped: out row 0 comes from the last source row.
        assert_eq!(&bgra[0..4], &[9, 10, 11, 255]);
        assert_eq!(&bgra[8..12], &[3, 4, 5, 255]);
        assert_eq!(&bgra[12..16], &[6, 7, 8, 255]);
    }
}
