// Foreground window identification, replacing windows-bridge.ps1 `foreground`.

use serde_json::{json, Value};
use windows::Win32::Foundation::{CloseHandle, HWND, HANDLE};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
};

pub struct ForegroundInfo {
    pub handle: String,
    pub app: String,
    pub title: String,
}

pub fn foreground() -> Option<ForegroundInfo> {
    unsafe {
        let hwnd: HWND = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut title = [0u16; 512];
        let len = GetWindowTextW(hwnd, &mut title);
        let title = String::from_utf16_lossy(&title[..len.max(0) as usize]);

        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let app = process_name(pid).unwrap_or_default();

        Some(ForegroundInfo {
            handle: format!("{}", hwnd.0 as isize),
            app,
            title,
        })
    }
}

fn process_name(pid: u32) -> Option<String> {
    unsafe {
        if pid == 0 {
            return None;
        }
        let handle: HANDLE = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = [0u16; 1024];
        let mut size = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buffer.as_mut_ptr()),
            &mut size,
        )
        .is_ok();
        let _ = CloseHandle(handle);
        if !ok {
            return None;
        }
        let path = String::from_utf16_lossy(&buffer[..size as usize]);
        let file = path.rsplit(['\\', '/']).next().unwrap_or("");
        // Process.ProcessName excludes the .exe extension.
        Some(file.strip_suffix(".exe").unwrap_or(file).to_string())
    }
}

/// normalizeSource port: skip our own process so capturing from Pasty never
/// records Pasty itself as the copy source.
pub fn normalize_source(info: &ForegroundInfo) -> Option<Value> {
    let app = info.app.trim();
    if app.is_empty() {
        return None;
    }
    let lower = app.to_lowercase();
    if lower == "electron" || lower == "pasty" {
        return None;
    }
    let title: String = info.title.chars().take(160).collect();
    Some(json!({ "app": app, "title": title, "handle": info.handle }))
}
