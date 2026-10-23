// What Flow shows in the island's compact notch (winotch: the Flow pill is
// gone). Between the mark and the bell: the bars while you dictate, a call's
// clock while one is recorded, a short line of text for a few seconds, and
// what « OK Tent » heard and answered. Nothing there is clicked: the keys do
// it all (hold to dictate, tap twice for hands-free, Esc cancels), calls start
// and stop on the Notetaker page.
//
// The whole state goes to the island's page as `flow-notch` on every change;
// the bars' levels come as `flow-bands` about 30 times a second while you speak.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Where dictation is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    #[default]
    Idle,
    /// The key is held: the bars follow the voice.
    Listening,
    /// Hands-free: listening until the key is tapped again.
    Locked,
    /// The words are being written.
    Thinking,
}

/// A short line, gone by itself after a few seconds.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Message {
    pub id: u64,
    pub text: String,
}

/// What the compact notch shows of Flow, sent whole to the island's page.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct NotchState {
    pub phase: Phase,
    /// When the call being recorded started (ms since 1970), or none.
    pub note_started_at: Option<u64>,
    pub message: Option<Message>,
    /// « OK Tent » is talking with you.
    pub voice: Option<crate::voice::VoiceView>,
    /// winotch: what is being said goes to Claude Code (Shift with the key
    /// held), not typed; the bars say so. Gone with the dictation.
    pub ask: bool,
}

static STATE: Mutex<NotchState> =
    Mutex::new(NotchState { phase: Phase::Idle, note_started_at: None, message: None, voice: None, ask: false });
static NEXT_MESSAGE: AtomicU64 = AtomicU64::new(1);

pub fn state() -> NotchState {
    STATE.lock().unwrap().clone()
}

/// Changes what the notch shows; the island's page hears of it only on a change.
pub fn update(app: &AppHandle, change: impl FnOnce(&mut NotchState)) {
    let changed = {
        let mut s = STATE.lock().unwrap();
        let before = s.clone();
        change(&mut s);
        (*s != before).then(|| s.clone())
    };
    if let Some(state) = changed {
        let _ = app.emit_to(crate::island::WINDOW_LABEL, "flow-notch", &state);
    }
}

pub fn set_phase(app: &AppHandle, phase: Phase) {
    update(app, |s| {
        s.phase = phase;
        if phase == Phase::Idle {
            s.ask = false;
        }
    });
}

/// The dictation under way is asked of Claude Code (KeyEvent::Ask).
pub fn set_ask(app: &AppHandle) {
    update(app, |s| s.ask = true);
}

/// A dictation is under way: the microphone is Flow's.
pub fn dictating() -> bool {
    STATE.lock().unwrap().phase != Phase::Idle
}

/// The bars' levels, while you speak.
pub fn bands(app: &AppHandle, levels: [f32; super::logic::bands::COUNT]) {
    let _ = app.emit_to(crate::island::WINDOW_LABEL, "flow-bands", levels);
}

/// A short line in the notch for `seconds`, then it goes by itself. A newer
/// line takes its place at once.
pub fn announce(app: &AppHandle, text: String, seconds: u64) {
    let id = NEXT_MESSAGE.fetch_add(1, Ordering::Relaxed);
    update(app, |s| s.message = Some(Message { id, text }));
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(seconds));
        update(&app, |s| {
            if s.message.as_ref().is_some_and(|m| m.id == id) {
                s.message = None;
            }
        });
    });
}

/// The island's page asks once as it starts.
#[tauri::command]
pub fn flow_notch_state() -> NotchState {
    state()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_reads_the_notch_in_camel_case() {
        let s = NotchState {
            phase: Phase::Locked,
            note_started_at: Some(5),
            message: Some(Message { id: 2, text: "Hi".into() }),
            voice: None,
            ask: true,
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v, serde_json::json!({ "phase": "locked", "noteStartedAt": 5, "message": { "id": 2, "text": "Hi" }, "voice": null, "ask": true }));
    }
}
