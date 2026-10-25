// Display lookup + frozen-screen capture via GDI BitBlt, replacing both the
// desktopCapturer path and windows-bridge.ps1 `captureDisplay`. The process is
// per-monitor DPI aware (tao), so all coordinates here are physical pixels.

use crate::core::Rect;
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, GetMonitorInfoW,
    MonitorFromPoint, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
    DIB_RGB_COLORS, HMONITOR, MONITORINFO, MONITOR_DEFAULTTONEAREST, SRCCOPY,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

pub struct DisplayInfo {
    /// Full monitor bounds in physical pixels.
    pub bounds: Rect,
    /// Work area (shell dock excluded) in physical pixels.
    pub work: Rect,
    pub scale: f64,
    pub cursor: (i32, i32),
}

pub fn cursor_position() -> (i32, i32) {
    unsafe {
        let mut pt = POINT::default();
        let _ = GetCursorPos(&mut pt);
        (pt.x, pt.y)
    }
}

pub fn cursor_display() -> Result<DisplayInfo, String> {
    unsafe {
        let mut pt = POINT::default();
        GetCursorPos(&mut pt).map_err(|_| "无法读取鼠标位置".to_string())?;
        let monitor: HMONITOR = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
        if monitor.is_invalid() {
            return Err("无法确定当前显示器".into());
        }
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return Err("无法读取显示器信息".to_string());
        }
        let mut dpi_x: u32 = 96;
        let mut dpi_y: u32 = 96;
        let _ = GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
        let rc = info.rcMonitor;
        let rw = info.rcWork;
        Ok(DisplayInfo {
            bounds: Rect { x: rc.left, y: rc.top, width: rc.right - rc.left, height: rc.bottom - rc.top },
            work: Rect { x: rw.left, y: rw.top, width: rw.right - rw.left, height: rw.bottom - rw.top },
            scale: dpi_x as f64 / 96.0,
            cursor: (pt.x, pt.y),
        })
    }
}

/// BitBlt the whole monitor into a top-down 32bpp BGRA buffer.
pub fn capture_display_bgra(display: &DisplayInfo) -> Result<(u32, u32, Vec<u8>), String> {
    unsafe {
        let w = display.bounds.width;
        let h = display.bounds.height;
        if w <= 0 || h <= 0 {
            return Err("显示器尺寸无效".into());
        }
        let hdc = GetDC(None);
        let mut bmi = BITMAPINFO::default();
        bmi.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            biSizeImage: (w * h * 4) as u32,
            ..Default::default()
        };
        let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
        let hbmp = CreateDIBSection(Some(hdc), &bmi, DIB_RGB_COLORS, &mut bits, None, 0)
            .map_err(|_| "无法创建截图位图".to_string())?;
        let memdc = CreateCompatibleDC(Some(hdc));
        let old = SelectObject(memdc, hbmp.into());
        let blit = BitBlt(
            memdc,
            0,
            0,
            w,
            h,
            Some(hdc),
            display.bounds.x,
            display.bounds.y,
            SRCCOPY,
        );
        let mut data = Vec::new();
        if blit.is_ok() && !bits.is_null() {
            let len = (w as usize) * (h as usize) * 4;
            data.extend_from_slice(std::slice::from_raw_parts(bits as *const u8, len));
        }
        SelectObject(memdc, old);
        let _ = DeleteObject(hbmp.into());
        let _ = DeleteDC(memdc);
        ReleaseDC(None, hdc);
        if data.is_empty() {
            return Err("屏幕抓取失败".into());
        }
        Ok((w as u32, h as u32, data))
    }
}
