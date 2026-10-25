// Spike: can a Tauri 2 (tao/wry/WebView2) frameless window land an image at an
// exact desktop physical-pixel rect, like the Electron pin path does today?
//
// Target: pattern.png (600x400) placed at physical (300, 200), then the test
// harness screenshots the desktop and pixel-compares that rect with the source.

use tauri::{LogicalSize, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

const PAT_W: f64 = 600.0;
const PAT_H: f64 = 400.0;
const PAT_X: i32 = 300;
const PAT_Y: i32 = 200;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let win = WebviewWindowBuilder::new(app, "pin", WebviewUrl::App("index.html".into()))
                .title("pin-spike")
                .decorations(false)
                .resizable(false)
                .always_on_top(true)
                .shadow(false)
                .visible(false)
                .build()?;

            let scale = win.scale_factor()?;
            win.set_size(LogicalSize::new(PAT_W / scale, PAT_H / scale))?;
            win.set_position(PhysicalPosition::new(PAT_X, PAT_Y))?;
            win.show()?;

            // Give the webview a moment to load, then pin the exact CSS size.
            std::thread::sleep(std::time::Duration::from_millis(1500));
            win.eval(&format!("window.__setup({},{})", PAT_W / scale, PAT_H / scale))?;
            std::thread::sleep(std::time::Duration::from_millis(500));

            let pos = win.outer_position()?;
            let size = win.outer_size()?;
            println!(
                "SPIKE pos=({},{}) size={}x{} scale={}",
                pos.x, pos.y, size.width, size.height, scale
            );
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri run failed");
}
