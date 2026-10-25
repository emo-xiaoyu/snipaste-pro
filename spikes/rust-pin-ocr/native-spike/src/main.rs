// Spike: validate from pure Rust (windows-rs), with no PowerShell bridge:
// 1. ocr      - in-process WinRT OCR (Windows.Media.Ocr) with word bounding boxes
// 2. capture  - frozen-screen grab via GDI BitBlt saved as BMP
// 3. compare  - pixel-diff a reference PNG against a rect of a full-screen BMP

use std::time::Instant;
use windows::core::{h, Interface, Result, HSTRING};
use windows::Globalization::Language;
use windows::Graphics::Imaging::{BitmapBufferAccessMode, BitmapDecoder};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::{FileAccessMode, StorageFile};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC,
    SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, SRCCOPY,
};
use windows::Win32::System::WinRT::IMemoryBufferByteAccess;
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let r = match args.get(1).map(|s| s.as_str()) {
        Some("ocr") => run_ocr(&args[2]),
        Some("capture") => run_capture(&args[2]),
        Some("compare") => run_compare(
            &args[2],
            &args[3],
            args[4].parse().unwrap(),
            args[5].parse().unwrap(),
            args.get(6).and_then(|s| s.parse().ok()).unwrap_or(0),
        ),
        _ => {
            eprintln!("usage: native-spike ocr <img> | capture <out.bmp> | compare <pattern.png> <shot.bmp> <x> <y>");
            Ok(())
        }
    };
    if let Err(e) = r {
        eprintln!("ERROR: {e}");
        std::process::exit(1);
    }
}

fn abs_path(p: &str) -> HSTRING {
    let c = std::fs::canonicalize(p).unwrap_or_else(|_| std::path::PathBuf::from(p));
    let s = c.to_string_lossy();
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s);
    HSTRING::from(s.to_string())
}

fn open_decoder(path: &str) -> Result<BitmapDecoder> {
    let file = StorageFile::GetFileFromPathAsync(&abs_path(path))?.get()?;
    let stream = file.OpenAsync(FileAccessMode::Read)?.get()?;
    BitmapDecoder::CreateAsync(&stream)?.get()
}

// Decode any WIC-supported image (PNG/BMP/JPEG) to raw BGRA8 pixels.
fn decode_image(path: &str) -> Result<(u32, u32, Vec<u8>)> {
    let decoder = open_decoder(path)?;
    let bitmap = decoder.GetSoftwareBitmapAsync()?.get()?;
    let (w, h) = (bitmap.PixelWidth()? as u32, bitmap.PixelHeight()? as u32);
    let buf = bitmap.LockBuffer(BitmapBufferAccessMode::Read)?;
    let reference = buf.CreateReference()?;
    let byte_access: IMemoryBufferByteAccess = reference.cast()?;
    let mut data: *mut u8 = std::ptr::null_mut();
    let mut capacity: u32 = 0;
    unsafe {
        byte_access.GetBuffer(&mut data, &mut capacity)?;
        let bytes = std::slice::from_raw_parts(data, capacity as usize);
        Ok((w, h, bytes[..(w * h * 4) as usize].to_vec()))
    }
}

fn run_ocr(path: &str) -> Result<()> {
    let decoder = open_decoder(path)?;
    let bitmap = decoder.GetSoftwareBitmapAsync()?.get()?;
    println!("image: {}x{}", bitmap.PixelWidth()?, bitmap.PixelHeight()?);

    let engine = match OcrEngine::TryCreateFromLanguage(&Language::CreateLanguage(h!("zh-Hans"))?) {
        Ok(e) => {
            println!("engine: zh-Hans (explicit)");
            e
        }
        Err(_) => match OcrEngine::TryCreateFromUserProfileLanguages() {
            Ok(e) => {
                println!("engine: user-profile fallback");
                e
            }
            Err(_) => {
                eprintln!("no OCR engine available");
                std::process::exit(2);
            }
        },
    };
    println!("max image dimension: {}", OcrEngine::MaxImageDimension()?);

    let t0 = Instant::now();
    let result = engine.RecognizeAsync(&bitmap)?.get()?;
    println!("recognize: {} ms (in-process)", t0.elapsed().as_millis());

    for line in result.Lines()? {
        let text = line.Text()?;
        let boxes: Vec<String> = line
            .Words()?
            .into_iter()
            .filter_map(|w| {
                let r = w.BoundingRect().ok()?;
                Some(format!("({:.0},{:.0} {:.0}x{:.0})", r.X, r.Y, r.Width, r.Height))
            })
            .collect();
        println!("LINE: {text}");
        println!("   boxes: {}", boxes.join(" "));
    }
    Ok(())
}

fn run_capture(out: &str) -> Result<()> {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let hdc = GetDC(None);
        let w = GetSystemMetrics(SM_CXSCREEN);
        let h = GetSystemMetrics(SM_CYSCREEN);

        let mut bmi = BITMAPINFO::default();
        bmi.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0 as u32,
            biSizeImage: (w * h * 4) as u32,
            ..Default::default()
        };
        let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
        let hbmp = CreateDIBSection(Some(hdc), &bmi, DIB_RGB_COLORS, &mut bits, None, 0)?;
        let memdc = CreateCompatibleDC(Some(hdc));
        let old = SelectObject(memdc, hbmp.into());
        BitBlt(memdc, 0, 0, w, h, Some(hdc), 0, 0, SRCCOPY);

        let len = (w as usize) * (h as usize) * 4;
        let data = std::slice::from_raw_parts(bits as *const u8, len);
        write_bmp(out, w as u32, h as u32, data)?;

        SelectObject(memdc, old);
        let _ = DeleteObject(hbmp.into());
        let _ = DeleteDC(memdc);
        ReleaseDC(None, hdc);
        println!("captured {}x{} -> {}", w, h, out);
    }
    Ok(())
}

// Standard bottom-up 32bpp BI_RGB BMP.
fn write_bmp(path: &str, w: u32, h: u32, top_down_bgra: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let stride = (w * 4) as usize;
    let data_size = (stride * h as usize) as u32;
    let mut f = std::fs::File::create(path)?;
    let mut hdr = [0u8; 54];
    hdr[0..2].copy_from_slice(b"BM");
    hdr[2..6].copy_from_slice(&(54 + data_size).to_le_bytes());
    hdr[10..14].copy_from_slice(&54u32.to_le_bytes());
    hdr[14..18].copy_from_slice(&40u32.to_le_bytes());
    hdr[18..22].copy_from_slice(&(w as i32).to_le_bytes());
    hdr[22..26].copy_from_slice(&(h as i32).to_le_bytes());
    hdr[26..28].copy_from_slice(&1u16.to_le_bytes());
    hdr[28..30].copy_from_slice(&32u16.to_le_bytes());
    hdr[34..38].copy_from_slice(&data_size.to_le_bytes());
    f.write_all(&hdr)?;
    for y in (0..h as usize).rev() {
        f.write_all(&top_down_bgra[y * stride..(y + 1) * stride])?;
    }
    Ok(())
}

fn run_compare(pattern: &str, shot: &str, sx: i32, sy: i32, inset: u32) -> Result<()> {
    let (pw, ph, pd) = decode_image(pattern)?;
    let (sw, sh, sd) = decode_image(shot)?;
    println!("pattern {}x{}, shot {}x{}", pw, ph, sw, sh);
    if sx < 0 || sy < 0 || sx as u32 + pw > sw || sy as u32 + ph > sh {
        eprintln!("rect ({sx},{sy} {pw}x{ph}) outside shot");
        std::process::exit(1);
    }
    // inset skips the outer frame (DWM border / rounded corners on Win11);
    // interior pixels must still match 1:1.
    let x0 = inset;
    let y0 = inset;
    let x1 = pw - inset;
    let y1 = ph - inset;
    println!("comparing interior rect ({x0},{y0})-({x1},{y1}), inset {inset}");

    let mut mismatch = 0u64;
    let mut max_diff = 0u8;
    let mut first_bad: Option<(u32, u32)> = None;
    let tol: u8 = 8;
    for y in y0..y1 {
        for x in x0..x1 {
            let pi = ((y * pw + x) * 4) as usize;
            let si = (((y + sy as u32) * sw + (x + sx as u32)) * 4) as usize;
            for c in 0..3 {
                let d = pd[pi + c].abs_diff(sd[si + c]);
                if d > max_diff {
                    max_diff = d;
                }
                if d > tol {
                    mismatch += 1;
                    if first_bad.is_none() {
                        first_bad = Some((x, y));
                    }
                }
            }
        }
    }
    let total = (pw as u64) * (ph as u64) * 3;
    let pct = mismatch as f64 * 100.0 / total as f64;
    println!(
        "compared {total} channels: mismatch {mismatch} ({pct:.4}%), max channel diff {max_diff}, first bad at {:?}",
        first_bad.unwrap_or((u32::MAX, u32::MAX))
    );
    if pct > 0.1 {
        eprintln!("RESULT: FAIL (mismatch {pct:.4}% > 0.1%)");
        std::process::exit(3);
    }
    println!("RESULT: PASS (mismatch {pct:.4}% <= 0.1%)");
    Ok(())
}
