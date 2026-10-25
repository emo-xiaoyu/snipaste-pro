// Message-only window thread: owns global hotkey registration
// (RegisterHotKey posts WM_HOTKEY to the registering thread) and the clipboard
// change listener (AddClipboardFormatListener). Other threads submit commands
// through a channel; the window thread executes them on its own queue.

use std::sync::mpsc::{channel, Receiver, Sender};
use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::DataExchange::AddClipboardFormatListener;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PostMessageW, RegisterClassW,
    TranslateMessage, HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WINDOW_STYLE, WNDCLASSW,
};

pub const WM_APP_BRIDGE: u32 = 0x8001;
pub const WM_HOTKEY_MSG: u32 = 0x0312;
pub const WM_CLIPBOARD_UPDATE: u32 = 0x031D;

pub enum MsgCommand {
    RegisterHotkey { id: i32, modifiers: u32, vk: u32, ack: Sender<bool> },
    UnregisterHotkey { id: i32, ack: Sender<bool> },
}

pub enum MsgEvent {
    Hotkey(i32),
    ClipboardUpdate,
}

struct BridgeState {
    event_tx: Sender<MsgEvent>,
    cmd_rx: Receiver<MsgCommand>,
}

static STATE: std::sync::Mutex<Option<BridgeState>> = std::sync::Mutex::new(None);
static PUBLISHED_HWND: std::sync::Mutex<Option<isize>> = std::sync::Mutex::new(None);

fn current_hwnd() -> Option<isize> {
    *PUBLISHED_HWND.lock().unwrap()
}

#[derive(Clone)]
pub struct MsgBridge {
    cmd_tx: Sender<MsgCommand>,
}

impl MsgBridge {
    /// Register a global hotkey; blocks until the message thread confirms.
    pub fn hotkey(&self, id: i32, modifiers: u32, vk: u32) -> bool {
        // Wait briefly for the window to exist at startup.
        for _ in 0..100 {
            if current_hwnd().is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let Some(hwnd) = current_hwnd() else { return false };
        let (tx, rx) = channel();
        if self
            .cmd_tx
            .send(MsgCommand::RegisterHotkey { id, modifiers, vk, ack: tx })
            .is_err()
        {
            return false;
        }
        unsafe {
            let _ = PostMessageW(Some(HWND(hwnd as *mut _)), WM_APP_BRIDGE, WPARAM(0), LPARAM(0));
        }
        rx.recv().unwrap_or(false)
    }

    pub fn unhotkey(&self, id: i32) {
        let Some(hwnd) = current_hwnd() else { return };
        let (tx, _rx) = channel();
        let _ = self.cmd_tx.send(MsgCommand::UnregisterHotkey { id, ack: tx });
        unsafe {
            let _ = PostMessageW(Some(HWND(hwnd as *mut _)), WM_APP_BRIDGE, WPARAM(0), LPARAM(0));
        }
    }
}

pub fn spawn(event_tx: Sender<MsgEvent>) -> MsgBridge {
    let (cmd_tx, cmd_rx) = channel::<MsgCommand>();
    *STATE.lock().unwrap() = Some(BridgeState { event_tx, cmd_rx });
    let bridge = MsgBridge { cmd_tx };
    std::thread::spawn(move || unsafe {
        let hinstance = GetModuleHandleW(None).ok();
        let wc_hinstance = hinstance
            .map(|m| windows::Win32::Foundation::HINSTANCE(m.0))
            .unwrap_or_default();
        let class_name = w!("PastyMsgWindow");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(wnd_proc),
            hInstance: wc_hinstance,
            lpszClassName: class_name,
            ..Default::default()
        };
        if RegisterClassW(&wc) == 0 {
            return;
        }
        let Ok(hwnd) = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class_name,
            w!("PastyBridge"),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(wc_hinstance),
            None,
        ) else {
            return;
        };
        let listen_ok = AddClipboardFormatListener(hwnd).is_ok();
        if std::env::var("PASTY_DEBUG").is_ok() {
            eprintln!("[dbg] msg window created hwnd={:?} clipboard_listener={}", hwnd.0, listen_ok);
        }
        *PUBLISHED_HWND.lock().unwrap() = Some(hwnd.0 as isize);
        let mut msg = MSG::default();
        loop {
            let r = GetMessageW(&mut msg, None, 0, 0);
            if r.0 == 0 || r.0 == -1 {
                break;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
    bridge
}

unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_HOTKEY_MSG => {
            let id = (wparam.0 & 0xFFFF) as i32;
            if std::env::var("PASTY_DEBUG").is_ok() {
                eprintln!("[dbg] WM_HOTKEY id={id}");
            }
            if let Some(state) = STATE.lock().unwrap().as_ref() {
                let _ = state.event_tx.send(MsgEvent::Hotkey(id));
            }
            LRESULT(0)
        }
        WM_CLIPBOARD_UPDATE => {
            if std::env::var("PASTY_DEBUG").is_ok() {
                eprintln!("[dbg] WM_CLIPBOARDUPDATE");
            }
            if let Some(state) = STATE.lock().unwrap().as_ref() {
                let _ = state.event_tx.send(MsgEvent::ClipboardUpdate);
            }
            LRESULT(0)
        }
        WM_APP_BRIDGE => {
            if let Some(state) = STATE.lock().unwrap().as_ref() {
                while let Ok(cmd) = state.cmd_rx.try_recv() {
                    match cmd {
                        MsgCommand::RegisterHotkey { id, modifiers, vk, ack } => {
                            let ok = RegisterHotKey(
                                Some(hwnd),
                                id,
                                windows::Win32::UI::Input::KeyboardAndMouse::HOT_KEY_MODIFIERS(
                                    modifiers,
                                ),
                                vk,
                            )
                            .is_ok();
                            let _ = ack.send(ok);
                        }
                        MsgCommand::UnregisterHotkey { id, ack } => {
                            let _ = UnregisterHotKey(Some(hwnd), id);
                            let _ = ack.send(true);
                        }
                    }
                }
            }
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}
