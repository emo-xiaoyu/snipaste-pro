// In-process paste, replacing windows-bridge.ps1 `paste`: restore the target
// window, wait the configured synchronization delay, then send Ctrl+V with
// keybd_event exactly like the PowerShell bridge did.

use std::thread::sleep;
use std::time::Duration;
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Input::KeyboardAndMouse::{keybd_event, KEYBD_EVENT_FLAGS};
use windows::Win32::UI::WindowsAndMessaging::{SetForegroundWindow, ShowWindowAsync, SW_SHOW};

const VK_CONTROL: u8 = 0x11;
const VK_V: u8 = 0x56;
const KEYEVENTF_KEYUP: u32 = 0x0002;

pub fn send_paste(target_handle: Option<&str>, delay_ms: i64) -> Result<(), String> {
    let delay = delay_ms.clamp(0, 1200) as u64;
    let handle: isize = target_handle
        .and_then(|s| s.trim().parse::<isize>().ok())
        .unwrap_or(0);
    unsafe {
        if handle != 0 {
            let hwnd = HWND(handle as *mut _);
            let _ = ShowWindowAsync(hwnd, SW_SHOW);
            let _ = SetForegroundWindow(hwnd);
        }
        if delay > 0 {
            sleep(Duration::from_millis(delay));
        }
        let up = KEYBD_EVENT_FLAGS(KEYEVENTF_KEYUP);
        keybd_event(VK_CONTROL, 0, KEYBD_EVENT_FLAGS(0), 0);
        keybd_event(VK_V, 0, KEYBD_EVENT_FLAGS(0), 0);
        keybd_event(VK_V, 0, up, 0);
        keybd_event(VK_CONTROL, 0, up, 0);
    }
    Ok(())
}
