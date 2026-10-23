// The tray icon and the windows' taskbar icon follow the Windows theme: the
// mark in light ink on a dark taskbar, in dark ink on a light one, with no
// ground behind it either way. Drawn here, the same way scripts/gen-icons.mjs
// draws the .exe's icon (which Windows cannot theme), so nothing is loaded.

use std::time::Duration;

use tauri::image::Image;
use tauri::{AppHandle, Manager};

const LIGHT_INK: [u8; 3] = [0xEC, 0xEC, 0xEC];
const DARK_INK: [u8; 3] = [0x14, 0x14, 0x14];
const DASH: f64 = 2.3;
/// Supersampling per axis: smooth edges at 32 px.
const SS: u32 = 4;
const SIZE: u32 = 64;

/// The mark alone, `size`×`size` RGBA, its coverage as the alpha.
fn render(size: u32, ink: [u8; 3]) -> Vec<u8> {
    let gap = if size <= 32 { 0.3 } else { 0.45 };
    let u = 0.94 / (DASH + gap + 1.0);
    let left = -0.47;
    let dash_end = left + DASH * u;
    let dot_x = dash_end + gap * u + u / 2.0;
    let r = u / 2.0;
    let inside = |x: f64, y: f64| {
        let cx = x.clamp(left + r, dash_end - r);
        (x - cx).powi(2) + y * y <= r * r || (x - dot_x).powi(2) + y * y <= r * r
    };
    let mut px = vec![0u8; (size * size * 4) as usize];
    for y in 0..size {
        for x in 0..size {
            let mut ink_hits = 0;
            for sy in 0..SS {
                for sx in 0..SS {
                    let fx = (x as f64 + (sx as f64 + 0.5) / SS as f64) / size as f64 - 0.5;
                    let fy = (y as f64 + (sy as f64 + 0.5) / SS as f64) / size as f64 - 0.5;
                    if inside(fx, fy) {
                        ink_hits += 1;
                    }
                }
            }
            let o = ((y * size + x) * 4) as usize;
            px[o..o + 3].copy_from_slice(&ink);
            px[o + 3] = ((ink_hits as f64 / (SS * SS) as f64) * 255.0).round() as u8;
        }
    }
    px
}

/// Whether the taskbar is light (Settings → Personalisation → Colours, "Windows mode").
#[cfg(windows)]
fn taskbar_light() -> bool {
    use windows::core::w;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    let mut value = 0u32;
    let mut len = std::mem::size_of::<u32>() as u32;
    let read = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"),
            w!("SystemUsesLightTheme"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut value as *mut u32 as *mut _),
            Some(&mut len),
        )
    };
    read.is_ok() && value == 1
}

#[cfg(not(windows))]
fn taskbar_light() -> bool {
    false
}

/// Sets the tray's and the windows' icons for the theme in use now.
fn apply(app: &AppHandle, light: bool) {
    let ink = if light { DARK_INK } else { LIGHT_INK };
    let icon = Image::new_owned(render(SIZE, ink), SIZE, SIZE);
    if let Some(tray) = app.tray_by_id("winotch") {
        let _ = tray.set_icon(Some(icon.clone()));
    }
    for win in app.webview_windows().values() {
        let _ = win.set_icon(icon.clone());
    }
}

/// The theme may have changed (Windows said so): icons for the one in use now.
pub fn refresh(app: &AppHandle) {
    apply(app, taskbar_light());
}

/// Icons for the current theme now, then again whenever it changes. Windows
/// says so to apps whose own theme changes, not always for the taskbar alone,
/// so the setting is also read twice a minute: one registry read, nothing more.
pub fn follow_theme(app: &AppHandle) {
    let mut light = taskbar_light();
    apply(app, light);
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(30));
        let now = taskbar_light();
        if now != light {
            light = now;
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || apply(&handle, now));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mark_has_ink_in_the_middle_and_none_in_the_corners() {
        let px = render(64, LIGHT_INK);
        let alpha = |x: u32, y: u32| px[((y * 64 + x) * 4 + 3) as usize];
        assert_eq!(alpha(0, 0), 0);
        assert_eq!(alpha(63, 63), 0);
        // The dash crosses the centre line on the left, the dot on the right.
        assert!(alpha(16, 32) > 200);
        assert!(alpha(58, 32) > 200);
        // Nothing above or below the mark: it is a thin line, no ground.
        assert_eq!(alpha(32, 4), 0);
    }
}
