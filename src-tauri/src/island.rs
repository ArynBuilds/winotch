// Island window: placement on the chosen display, the two window sizes
// (full panel / invisible wake strip), click-through and the cursor poll.
//
// There is no notch on a PC, so the island is a black shape drawn at the top
// centre of the main display inside a borderless, transparent, always-on-top
// window that never takes focus.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::platform::{self, cursor_physical, left_button_down};

/// Logical size of the full window — the largest island view, like the macOS panel.
/// winotch: 920 × 600 (was 720 × 320) for the settings in the island and their
/// ears (core/layout.ts SETTINGS_W). Click-through outside the island.
pub const PANEL_W: f64 = 920.0;
pub const PANEL_H: f64 = 600.0;
/// Logical size of the invisible strip that wakes the island when it is hidden.
pub const STRIP_W: f64 = 240.0;
pub const STRIP_H: f64 = 6.0;

pub const WINDOW_LABEL: &str = "island";

/// Margin around the island that still counts as "on the island", in logical px.
/// Wider than the macOS 6 pt because a click must never be swallowed.
const HIT_MARGIN: f64 = 14.0;
/// How often a hidden island checks for the pointer on its wake strip.
const STRIP_CHECK: Duration = Duration::from_millis(80);
/// How far beyond the island's sides (logical px) the pointer can still move
/// the mark's dot: the crossing band (engine.ts CROSS_BAND) plus some margin.
const CROSS_COLUMN: f64 = 160.0;

/// How near the island (logical px) the cursor is still sent to the page on every move.
const NEAR: f64 = 160.0;

#[derive(Serialize, Clone)]
pub struct CursorPayload {
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize, Clone)]
pub struct ScreenInfo {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

/// The island shape in window-logical coordinates, pushed by the front end.
/// The poll thread owns the click-through decision so it lands in the same 16 ms
/// tick as the cursor read — an IPC round trip here loses clicks.
#[derive(Clone, Copy, Default)]
pub struct IslandRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Wakes / parks the cursor poll thread so a hidden island costs literally nothing.
pub struct PollGate {
    active: Mutex<bool>,
    cv: Condvar,
    pub collapsed: AtomicBool,
    pub rect: Mutex<IslandRect>,
    /// Mirrors the window flag so we only call into the OS when it changes.
    ignoring: AtomicBool,
}

impl PollGate {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(false),
            cv: Condvar::new(),
            collapsed: AtomicBool::new(true),
            rect: Mutex::new(IslandRect::default()),
            ignoring: AtomicBool::new(false),
        }
    }

    pub fn set_rect(&self, rect: IslandRect) {
        *self.rect.lock().unwrap() = rect;
    }

    /// Forces the next poll tick to re-apply the flag (after a window resize).
    pub fn forget_ignore_state(&self) {
        self.ignoring.store(false, Ordering::Relaxed);
    }

    pub fn set_active(&self, on: bool) {
        let mut guard = self.active.lock().unwrap();
        *guard = on;
        self.cv.notify_all();
    }

    /// Waits until the poll is turned on, or `timeout` goes by. True when on.
    pub(crate) fn wait_active_for(&self, timeout: Duration) -> bool {
        let guard = self.active.lock().unwrap();
        let (guard, _) = self.cv.wait_timeout_while(guard, timeout, |on| !*on).unwrap();
        *guard
    }

    pub(crate) fn is_active(&self) -> bool {
        *self.active.lock().unwrap()
    }
}

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
}

fn monitor_contains(m: &Monitor, x: f64, y: f64) -> bool {
    let p = m.position();
    let s = m.size();
    x >= p.x as f64
        && x < (p.x + s.width as i32) as f64
        && y >= p.y as f64
        && y < (p.y + s.height as i32) as f64
}

/// A display's logical origin, the key `at:<x>,<y>` preferences are matched on.
/// Names are no good for that: two monitors of the same model share one.
fn logical_origin(m: &Monitor) -> (i32, i32) {
    let scale = m.scale_factor();
    let p = m.position();
    ((p.x as f64 / scale).round() as i32, (p.y as f64 / scale).round() as i32)
}

/// One entry of the "Island lives on" list in Settings.
#[derive(Serialize, Clone)]
pub struct MonitorChoice {
    pub key: String,
    pub label: String,
}

pub fn monitor_choices(app: &AppHandle) -> Vec<MonitorChoice> {
    let Ok(monitors) = app.available_monitors() else { return Vec::new() };
    monitors
        .iter()
        .map(|m| {
            let d = describe(m);
            MonitorChoice {
                key: d.key(),
                label: crate::i18n::tf(
                    "{name} — {width}×{height} at {x},{y}",
                    &[
                        ("name", &d.name),
                        ("width", &d.w.to_string()),
                        ("height", &d.h.to_string()),
                        ("x", &d.x.to_string()),
                        ("y", &d.y.to_string()),
                    ],
                ),
            }
        })
        .collect()
}

/// What a display is remembered by: its logical origin, plus its name and
/// logical size, so it is still found after the layout is rearranged or the
/// resolution changes (the Mac keeps the display's UUID for the same reason;
/// Tauri has no stable ID).
#[derive(Debug, Clone, PartialEq)]
struct DisplayId {
    name: String,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

impl DisplayId {
    /// `at:<x>,<y>` stays first, so a preference saved before still matches.
    fn key(&self) -> String {
        format!("at:{},{}|{}|{}x{}", self.x, self.y, self.name.replace('|', " "), self.w, self.h)
    }
}

fn describe(m: &Monitor) -> DisplayId {
    let (x, y) = logical_origin(m);
    let scale = m.scale_factor();
    let s = m.size();
    DisplayId {
        name: m.name().cloned().unwrap_or_else(|| "Display".into()),
        x,
        y,
        w: (s.width as f64 / scale).round() as i32,
        h: (s.height as f64 / scale).round() as i32,
    }
}

/// Which display a saved `at:` preference points at, best match first: same
/// place and name; the same name and size elsewhere (layout rearranged); the
/// same name alone when unique (resolution changed); the same place. None
/// means unplugged, and the caller falls back to the primary display.
fn pick_display(pref: &str, displays: &[DisplayId]) -> Option<usize> {
    let rest = pref.strip_prefix("at:")?;
    let mut parts = rest.split('|');
    let (x, y) = parts.next()?.split_once(',')?;
    let (x, y) = (x.trim().parse::<i32>().ok()?, y.trim().parse::<i32>().ok()?);
    let name = parts.next();
    let size = parts.next().and_then(|s| {
        let (w, h) = s.split_once('x')?;
        Some((w.parse::<i32>().ok()?, h.parse::<i32>().ok()?))
    });
    let at = |d: &DisplayId| d.x == x && d.y == y;
    if let Some(name) = name {
        if let Some(i) = displays.iter().position(|d| at(d) && d.name == name) {
            return Some(i);
        }
        if let Some((w, h)) = size {
            if let Some(i) = displays.iter().position(|d| d.name == name && d.w == w && d.h == h) {
                return Some(i);
            }
        }
        let mut same_name = displays.iter().enumerate().filter(|(_, d)| d.name == name);
        if let (Some((i, _)), None) = (same_name.next(), same_name.next()) {
            return Some(i);
        }
    }
    displays.iter().position(at)
}

/// The display the island lives on: a chosen one, the primary one, or the one
/// under the cursor.
fn target_monitor(app: &AppHandle, pref: &str) -> Option<Monitor> {
    let monitors = app.available_monitors().ok()?;
    let ids: Vec<DisplayId> = monitors.iter().map(describe).collect();
    if let Some(i) = pick_display(pref, &ids) {
        return Some(monitors[i].clone());
    }
    if pref == "cursor" {
        if let Some((cx, cy)) = cursor_physical() {
            if let Some(m) = monitors.iter().find(|m| monitor_contains(m, cx, cy)) {
                return Some(m.clone());
            }
        }
    }
    app.primary_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.into_iter().next())
}

#[cfg(test)]
mod display_tests {
    use super::*;

    fn d(name: &str, x: i32, y: i32, w: i32, h: i32) -> DisplayId {
        DisplayId { name: name.into(), x, y, w, h }
    }

    #[test]
    fn a_display_is_found_again_after_changes() {
        let dell = d("DELL U2720Q", 1920, 0, 2560, 1440);
        let lap = d("eDP-1", 0, 0, 1920, 1200);
        let key = dell.key();
        assert_eq!(pick_display(&key, &[lap.clone(), dell.clone()]), Some(1));
        // Rearranged: the Dell moved to the left of the laptop.
        let moved = [d("eDP-1", 2560, 0, 1920, 1200), d("DELL U2720Q", 0, 0, 2560, 1440)];
        assert_eq!(pick_display(&key, &moved), Some(1));
        // Resolution changed, still the only Dell.
        let rescaled = [lap.clone(), d("DELL U2720Q", 1920, 0, 1920, 1080)];
        assert_eq!(pick_display(&key, &rescaled), Some(1));
        // Unplugged: nothing, so the caller falls back to the primary display.
        assert_eq!(pick_display(&key, &[lap.clone()]), None);
    }

    #[test]
    fn two_identical_monitors_are_told_apart_by_place() {
        let a = d("LG 27UL500", 0, 0, 1920, 1080);
        let b = d("LG 27UL500", 1920, 0, 1920, 1080);
        assert_eq!(pick_display(&b.key(), &[a.clone(), b.clone()]), Some(1));
        assert_eq!(pick_display(&a.key(), &[a, b]), Some(0));
    }

    #[test]
    fn preferences_saved_before_still_match() {
        let lap = d("eDP-1", 0, 0, 1920, 1200);
        let ext = d("HDMI-1", 1920, 0, 1920, 1080);
        assert_eq!(pick_display("at:1920,0", &[lap.clone(), ext.clone()]), Some(1));
        assert_eq!(pick_display("primary", &[lap, ext]), None);
        assert_eq!(pick_display("at:nonsense", &[]), None);
    }
}

/// Calculates the zoom correction factor so that 1 CSS pixel equals 1 window logical pixel.
/// If WebView2's devicePixelRatio differs from the window's scale factor (e.g. system text
/// scaling or multi-monitor DPI mismatch), adjusting the webview zoom ensures the island
/// canvas (PANEL_W / EXPANDED_W) fits within the window without clipping.
pub fn calculate_zoom_correction(current_zoom: f64, scale: f64, dpr: f64) -> Option<f64> {
    if dpr <= 0.0 || !dpr.is_finite() || scale <= 0.0 || !scale.is_finite() {
        return None;
    }
    if (dpr - scale).abs() / scale < 0.02 {
        return None;
    }
    let new_zoom = (current_zoom * (scale / dpr)).clamp(0.25, 4.0);
    Some(new_zoom)
}

#[cfg(test)]
mod zoom_tests {
    use super::*;

    #[test]
    fn zoom_correction_is_none_when_dpr_matches_window_scale() {
        assert_eq!(calculate_zoom_correction(1.0, 1.0, 1.0), None);
        assert_eq!(calculate_zoom_correction(1.0, 1.25, 1.25), None);
        // Within 2% threshold
        assert_eq!(calculate_zoom_correction(1.0, 1.0, 1.01), None);
    }

    #[test]
    fn zoom_correction_adjusts_for_dpi_mismatch() {
        // Issue #346: 100% scale display (scale 1.0) but WebView2 dpr = 1.25
        let zoom = calculate_zoom_correction(1.0, 1.0, 1.25);
        assert_eq!(zoom, Some(0.8));

        // 125% display with 125% text scale (dpr 1.5625 vs scale 1.25)
        let zoom = calculate_zoom_correction(1.0, 1.25, 1.5625);
        assert_eq!(zoom, Some(0.8));

        // 150% display with 100% webview dpr
        let zoom = calculate_zoom_correction(1.0, 1.5, 1.0);
        assert_eq!(zoom, Some(1.5));
    }

    #[test]
    fn zoom_correction_handles_invalid_inputs() {
        assert_eq!(calculate_zoom_correction(1.0, 0.0, 1.0), None);
        assert_eq!(calculate_zoom_correction(1.0, 1.0, -1.0), None);
        assert_eq!(calculate_zoom_correction(1.0, f64::NAN, 1.0), None);
        assert_eq!(calculate_zoom_correction(1.0, 1.0, f64::INFINITY), None);
    }
}


pub fn screen_info(app: &AppHandle, pref: &str) -> ScreenInfo {
    match target_monitor(app, pref) {
        Some(m) => {
            let scale = m.scale_factor();
            let p = m.position();
            let s = m.size();
            ScreenInfo {
                x: p.x as f64 / scale,
                y: p.y as f64 / scale,
                width: s.width as f64 / scale,
                height: s.height as f64 / scale,
                scale,
            }
        }
        None => ScreenInfo { x: 0.0, y: 0.0, width: 1920.0, height: 1080.0, scale: 1.0 },
    }
}

/// Places and sizes the window. `collapsed` picks the wake strip instead of the panel.
pub fn apply_geometry(app: &AppHandle, pref: &str, collapsed: bool) {
    let Some(win) = window(app) else { return };
    let Some(m) = target_monitor(app, pref) else { return };

    let scale = m.scale_factor();
    let mp = *m.position();
    let ms = *m.size();

    // With the cursor poll the window never shrinks (lib.rs set_collapsed).
    let collapsed = collapsed && !platform::CURSOR_POLL;
    let (lw, lh) = if collapsed { (STRIP_W, STRIP_H) } else { (PANEL_W, PANEL_H) };
    let pw = (lw * scale).round().max(1.0) as u32;
    let ph = (lh * scale).round().max(1.0) as u32;
    let x = mp.x + (ms.width as i32 - pw as i32) / 2;
    let y = mp.y;

    // GTK never sizes a non-resizable window below its natural size (200 px
    // here), so on Linux the 6 px wake strip would stay a 200 px block. tao
    // re-applies the config's `resizable: false` after the first configure, so
    // this is asked every time, just before the resize. Undecorated, the window
    // still offers the user nothing to resize it by. (Found by @YossiYad, #44.)
    #[cfg(target_os = "linux")]
    let _ = win.set_resizable(true);
    let _ = win.set_size(PhysicalSize::new(pw, ph));
    let _ = win.set_position(PhysicalPosition::new(x, y));
    let (lx, ly) = logical_origin(&m);
    platform::pin_to_monitor(&win, lx, ly);
    // Moving across displays can rescale the window: re-assert the physical size.
    let _ = win.set_size(PhysicalSize::new(pw, ph));
    let _ = win.set_always_on_top(true);

    // On Windows, moving across displays or waking from the strip can clamp or lag
    // the resize. If the physical inner size differs from what was requested, retry once.
    if let Ok(got) = win.inner_size() {
        if got.width != pw || got.height != ph {
            crate::log::line(format!(
                "window size mismatch: wanted {pw}x{ph}, got {}x{} (scale {scale}, monitor {}x{})",
                got.width, got.height, ms.width, ms.height
            ));
            let _ = win.set_size(PhysicalSize::new(pw, ph));
            let _ = win.set_position(PhysicalPosition::new(x, y));
        }
    }
}

/// Position, size and scale of the monitor the island lives on. Any change here
/// means the island has to be placed again.
fn current_screen_key(app: &AppHandle) -> Option<(i32, i32, u32, u32, u64)> {
    let pref = app
        .try_state::<crate::Shared>()
        .map(|s| s.settings.lock().unwrap().screen.clone())
        .unwrap_or_else(|| "primary".into());
    let m = target_monitor(app, &pref)?;
    let p = m.position();
    let size = m.size();
    Some((p.x, p.y, size.width, size.height, m.scale_factor().to_bits()))
}

/// Emits `cursor` (window-logical coordinates) at ~60 Hz while the island is
/// visible. Parked on a condvar the rest of the time.
pub fn spawn_cursor_poll(app: AppHandle, gate: Arc<PollGate>) {
    std::thread::spawn(move || {
        let mut was_down = false;
        // Remembered across wakes so a display change while hidden is noticed the
        // moment the island comes back.
        let mut last_screen: Option<(i32, i32, u32, u32, u64)> = None;
        // Without a cursor to read (Linux) the loop only watches the display
        // layout, and twice a second is plenty for that: waking at 60 Hz just to
        // find no cursor costs CPU for nothing.
        let (period, screen_every) = if platform::CURSOR_POLL { (16, 30) } else { (500, 1) };
        loop {
            // Parked while the island is hidden. Every few seconds, make sure the
            // wake strip still takes the mouse: an island nobody can wake is gone
            // for good, so it is cheaper to check than to trust every path.
            //
            // winotch: and a few times a second, whether the pointer is on the
            // strip. The page wakes on the strip's mouseenter, which never fires
            // for a pointer already there when the window shrank to the strip
            // (moved up while the island folded): it took leaving and coming back.
            let mut on_strip = false;
            let mut waited = Duration::ZERO;
            while !gate.wait_active_for(STRIP_CHECK) {
                if !gate.collapsed.load(Ordering::Relaxed) {
                    on_strip = false;
                    continue;
                }
                waited += STRIP_CHECK;
                if waited >= Duration::from_secs(2) {
                    waited = Duration::ZERO;
                    keep_strip_reachable(&app, &gate);
                }
                let now_on = cursor_on_window(&app);
                if now_on && !on_strip {
                    let _ = app.emit_to(WINDOW_LABEL, "strip-hover", ());
                }
                on_strip = now_on;
            }
            let mut last = (f64::MIN, f64::MIN);
            // Where the pointer last was across the mark's column, and whether
            // it was in it (the dot crosses there: src/mark/engine.ts overFor).
            let mut last_x = f64::NAN;
            let mut was_in_column = false;
            let mut far = false;
            let mut was_near = true;
            let mut ticks: u32 = 0;
            while gate.is_active() {
                // Far from the island nothing needs the cursor to the frame: a
                // slower beat, still quick enough to be ready when it arrives.
                std::thread::sleep(Duration::from_millis(if far { period * 2 } else { period }));
                // The island may have been hidden while this thread slept. A tick
                // run now would measure the cursor against the old island and make
                // the wake strip click-through, with no tick left to undo it.
                if !gate.is_active() {
                    break;
                }

                // Monitors get plugged in, unplugged, rearranged and rescaled, and
                // an island pinned to coordinates that no longer exist is an island
                // nobody can reach. Checked about twice a second — the cursor poll
                // is already running, so this costs one monitor query.
                ticks = ticks.wrapping_add(1);
                if ticks % screen_every == 0 {
                    let now = current_screen_key(&app);
                    if now.is_some() && now != last_screen {
                        let first = last_screen.is_none();
                        last_screen = now;
                        if !first {
                            crate::log::line("display layout changed — repositioning".to_string());
                            let _ = app.emit_to(WINDOW_LABEL, "screen-changed", ());
                        }
                    }
                }

                let Some(win) = window(&app) else { continue };
                let Ok(origin) = win.outer_position() else { continue };
                let scale = win.scale_factor().unwrap_or(1.0);
                let Some((cx, cy)) = cursor_physical() else { continue };
                let x = (cx - origin.x as f64) / scale;
                let y = (cy - origin.y as f64) / scale;
                let size = match win.inner_size() {
                    Ok(s) => (s.width as f64 / scale, s.height as f64 / scale),
                    Err(_) => (PANEL_W, PANEL_H),
                };
                if (x - last.0).abs() < 1.0 && (y - last.1).abs() < 1.0 {
                    continue;
                }
                last = (x, y);

                // Click-through: the window only takes the mouse over the island
                // shape. A small entry margin means the flag is already off by the
                // time a moving cursor reaches a button.
                let r = *gate.rect.lock().unwrap();
                // Hidden, only the wake strip at the top takes the mouse, as when
                // the window shrank to it (lib.rs set_collapsed).
                let on_island = if gate.collapsed.load(Ordering::Relaxed) {
                    let left = (size.0 - STRIP_W) / 2.0;
                    x >= left && x <= left + STRIP_W && y >= 0.0 && y <= STRIP_H
                } else {
                    r.w > 0.0
                        && x >= r.x - HIT_MARGIN
                        && x <= r.x + r.w + HIT_MARGIN
                        && y >= r.y - HIT_MARGIN
                        && y <= r.y + r.h + HIT_MARGIN
                };

                // A file being dragged has to be able to find us. WS_EX_TRANSPARENT
                // — what click-through is on Windows — hides the window from
                // WindowFromPoint, so OLE finds no drop target and shows the "no
                // drop" cursor. macOS has no such problem: AppKit delivers drags to
                // registered destinations whatever ignoresMouseEvents says. So while
                // a button is held anywhere over the panel, the whole panel takes
                // the mouse, which also makes the drop zone as forgiving as the Mac's.
                // A press may be the start of a drag: make sure the drop target is
                // ours before the file arrives.
                let down = left_button_down();
                if down && !was_down {
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || platform::unblock_webview_drops(&handle));
                }
                was_down = down;

                let dragging = down
                    && x >= 0.0
                    && x <= size.0
                    && y >= 0.0
                    && y <= size.1;

                let accept = on_island || dragging;
                if gate.ignoring.load(Ordering::Relaxed) == accept {
                    gate.ignoring.store(!accept, Ordering::Relaxed);
                    // Applied on the main thread, where set_collapsed runs too: by
                    // the time this lands the island may be hidden, and the wake
                    // strip must then take the mouse whatever this tick measured.
                    let handle = app.clone();
                    let g = gate.clone();
                    let _ = app.run_on_main_thread(move || {
                        // A window shrunk to the strip must take the mouse; one that
                        // keeps its size (the cursor poll's) goes by the tick.
                        let ignore = !accept && (platform::CURSOR_POLL || !g.collapsed.load(Ordering::Relaxed));
                        if !ignore {
                            g.ignoring.store(false, Ordering::Relaxed);
                        }
                        if let Some(w) = window(&handle) {
                            let _ = w.set_ignore_cursor_events(ignore);
                        }
                    });
                }

                let near = r.w > 0.0
                    && x >= r.x - NEAR
                    && x <= r.x + r.w + NEAR
                    && y <= r.y + r.h + NEAR;
                far = !near && !down;

                // The pointer moves all day: away from the island the page only
                // needs it while it passes the mark's column, where the dot
                // crosses the dash, and once as it leaves that column.
                let in_column = x >= r.x - CROSS_COLUMN && x <= r.x + r.w + CROSS_COLUMN;
                let crossed = in_column != was_in_column || (in_column && (x - last_x).abs() >= 2.0);
                was_in_column = in_column;
                // The first move out of reach always goes: the page must see the
                // pointer leave, or the island would wait for it forever.
                let left = was_near && !near;
                was_near = near;
                if !near && !left && !dragging && !crossed {
                    continue;
                }
                last_x = x;
                let _ = app.emit_to(WINDOW_LABEL, "cursor", CursorPayload { x, y });
            }
        }
    });
}

/// Whether the cursor is over the island's window: while hidden, the wake strip.
fn cursor_on_window(app: &AppHandle) -> bool {
    let Some(win) = window(app) else { return false };
    let (Ok(at), Ok(size)) = (win.outer_position(), win.outer_size()) else { return false };
    let Some((cx, cy)) = cursor_physical() else { return false };
    cx >= at.x as f64 && cx < (at.x + size.width as i32) as f64 && cy >= at.y as f64 && cy < (at.y + size.height as i32) as f64
}

/// While the island is hidden: the wake strip takes the mouse, and is where the
/// display now says it should be. Display changes are otherwise only noticed by
/// the cursor poll, which is parked while the island is hidden.
fn keep_strip_reachable(app: &AppHandle, gate: &Arc<PollGate>) {
    let handle = app.clone();
    let g = gate.clone();
    let _ = app.run_on_main_thread(move || {
        if !g.collapsed.load(Ordering::Relaxed) {
            return;
        }
        g.ignoring.store(false, Ordering::Relaxed);
        if let Some(w) = window(&handle) {
            let _ = w.set_ignore_cursor_events(false);
            let _ = w.set_always_on_top(true);
        }
    });
}

/// Re-applies click-through after the window or the island changed shape.
///
/// With the cursor poll (Windows) the window takes the mouse again and the next
/// tick decides from the cursor. Without it (Linux) the input region is set to
/// the island itself, or to the whole wake strip while collapsed.
pub fn refresh_click_through(app: &AppHandle, gate: &PollGate) {
    if platform::CURSOR_POLL {
        set_ignore_cursor(app, false);
        gate.forget_ignore_state();
        return;
    }
    let Some(win) = window(app) else { return };
    let region = if gate.collapsed.load(Ordering::Relaxed) {
        // The wake strip itself, never "the whole window": if the window ever
        // fails to shrink to the strip, the rest of it must not swallow clicks
        // meant for whatever sits under the top of the screen.
        Some((0.0, 0.0, STRIP_W, STRIP_H))
    } else {
        let r = *gate.rect.lock().unwrap();
        if r.w <= 0.0 {
            // Nothing drawn yet: nothing takes the mouse.
            Some((0.0, 0.0, 0.0, 0.0))
        } else {
            let x0 = (r.x - HIT_MARGIN).max(0.0);
            let y0 = (r.y - HIT_MARGIN).max(0.0);
            let x1 = r.x + r.w + HIT_MARGIN;
            let y1 = r.y + r.h + HIT_MARGIN;
            Some((x0, y0, x1 - x0, y1 - y0))
        }
    };
    platform::set_input_region(&win, region);
}

pub fn set_ignore_cursor(app: &AppHandle, ignore: bool) {
    if let Some(win) = window(app) {
        let _ = win.set_ignore_cursor_events(ignore);
    }
}
