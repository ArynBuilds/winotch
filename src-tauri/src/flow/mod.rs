// Flow dictation: hold a key anywhere, speak, let go, and the words are pasted
// where you type. Port of FlowDictation.swift for Windows and Linux.
//
// One thread owns the dictation: the key's events come in from the OS listener
// (os_windows.rs / os_linux.rs), KeyLogic turns them into start / lock /
// finish / cancel, the microphone is opened on the first press, and when you
// let go the words go to Parakeet on this computer, then through the
// dictionary, the snippets and (if turned on) Claude's clean-up, and are
// pasted. The thread sleeps on its channel while nothing happens. The island's
// compact notch shows it (notch.rs): keys only, nothing to click.

pub mod cleanup;
pub mod logic;
pub mod notch;
pub mod paste;
pub mod store;
pub mod text;

#[cfg(windows)]
#[path = "os_windows.rs"]
pub mod os;
#[cfg(target_os = "linux")]
#[path = "os_linux.rs"]
pub mod os;
#[cfg(target_os = "linux")]
pub mod wayland;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::i18n::t;
use crate::speech::{self, audio};
use logic::{Action, KeyLogic};
use notch::Phase;
use store::{AppStyle, Entry, Prefs, Store, Words};
use text::Snippet;

/// What reaches the dictation thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyEvent {
    Down,
    Up,
    /// Another key while the dictation key is held: a shortcut.
    Other,
    /// winotch: Shift with the dictation key held: what is said is asked of
    /// Claude Code (the island's quick conversation), not typed.
    Ask,
    Escape,
    Quit,
}

pub struct Flow {
    pub store: Mutex<Store>,
    running: Mutex<Option<Running>>,
}

struct Running {
    tx: Sender<(KeyEvent, Instant)>,
    /// The OS's key listener (or, on Wayland, the portal's shortcut); dropping it stops it.
    _listener: Option<Box<dyn std::any::Any + Send>>,
}

pub fn get(app: &AppHandle) -> Option<Arc<Flow>> {
    app.try_state::<Arc<Flow>>().map(|s| s.inner().clone())
}

/// A program's name as people know it: "outlook" → "Outlook".
pub fn display_name(stem: &str) -> String {
    let id = stem.to_lowercase();
    if let Some(s) = store::default_app_styles().into_iter().find(|s| s.id == id) {
        return s.name;
    }
    let mut chars = stem.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// Parts of the desktop itself, never a place to dictate into.
pub fn is_shell(id: &str) -> bool {
    matches!(
        id,
        "explorer" | "applicationframehost" | "textinputhost" | "shellexperiencehost" | "searchhost"
            | "startmenuexperiencehost" | "lockapp" | "winotch" | "gnome-shell" | "plasmashell" | "xfdesktop"
    )
}

fn is_terminal(id: &str) -> bool {
    #[cfg(target_os = "linux")]
    {
        os::is_terminal(id)
    }
    #[cfg(windows)]
    {
        // Windows Terminal, conhost and the rest paste with Ctrl+V.
        let _ = id;
        false
    }
}

// ── Setup, on and off ─────────────────────────────────────────────────────────

pub fn setup(app: &AppHandle) {
    let flow = Arc::new(Flow { store: Mutex::new(Store::load()), running: Mutex::new(None) });
    app.manage(flow.clone());
    let prefs = flow.store.lock().unwrap().prefs.clone();
    if prefs.enabled {
        enable(app, &flow);
    }
    crate::voice::sync(app);
}

fn enable(app: &AppHandle, flow: &Arc<Flow>) {
    let mut running = flow.running.lock().unwrap();
    if running.is_some() {
        return;
    }
    let prefs = flow.store.lock().unwrap().prefs.clone();
    let (tx, rx) = mpsc::channel::<(KeyEvent, Instant)>();
    let listener: Option<Box<dyn std::any::Any + Send>> = match os::keys_supported() {
        Ok(()) => match os::listen(prefs.key, tx.clone()) {
            Ok(l) => Some(Box::new(l)),
            Err(err) => {
                crate::log::line(format!("flow: the key can't be watched: {err}"));
                None
            }
        },
        #[cfg(target_os = "linux")]
        Err("wayland") => wayland::listen(tx.clone()).map(|h| Box::new(h) as Box<dyn std::any::Any + Send>),
        Err(why) => {
            crate::log::line(format!("flow: no key on this desktop ({why})"));
            None
        }
    };
    let app2 = app.clone();
    let flow2 = flow.clone();
    std::thread::Builder::new()
        .name("winotch-flow".into())
        .spawn(move || run(app2, flow2, rx))
        .ok();
    *running = Some(Running { tx, _listener: listener });
    drop(running);
    speech::preload();
    crate::log::line(format!("flow dictation on ({})", prefs.key.label()));
}

fn disable(app: &AppHandle, flow: &Arc<Flow>) {
    let running = flow.running.lock().unwrap().take();
    if let Some(r) = running {
        let _ = r.tx.send((KeyEvent::Quit, Instant::now()));
    }
    notch::set_phase(app, Phase::Idle);
    if !crate::notes::is_recording(app) && !crate::voice::is_listening() {
        speech::unload();
    }
}

// ── The dictation thread ──────────────────────────────────────────────────────

struct Listening {
    capture: audio::Capture,
    take: Arc<Mutex<audio::Take>>,
    started: Instant,
    app: Option<(String, String)>,
    /// Asked of Claude Code instead of typed (KeyEvent::Ask).
    ask: bool,
}

fn run(app: AppHandle, flow: Arc<Flow>, rx: mpsc::Receiver<(KeyEvent, Instant)>) {
    let epoch = Instant::now();
    let secs = |at: Instant| at.saturating_duration_since(epoch).as_secs_f64();
    let mut logic = KeyLogic::default();
    let mut listening: Option<Listening> = None;
    let busy = Arc::new(AtomicBool::new(false));
    loop {
        let active = listening.is_some() || logic.is_active();
        let received = if active {
            match rx.recv_timeout(Duration::from_millis(33)) {
                Ok(m) => Some(m),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => break,
            }
        } else {
            match rx.recv() {
                Ok(m) => Some(m),
                Err(_) => break,
            }
        };
        let action = match received {
            Some((KeyEvent::Quit, _)) => {
                drop(listening.take());
                break;
            }
            Some((KeyEvent::Down, at)) => logic.key_down(secs(at)),
            Some((KeyEvent::Up, at)) => logic.key_up(secs(at)),
            Some((KeyEvent::Other, _)) => logic.other_key(),
            Some((KeyEvent::Ask, _)) => {
                if let Some(l) = listening.as_mut().filter(|l| !l.ask) {
                    l.ask = true;
                    crate::log::line("flow: asking Claude Code".to_string());
                    notch::set_ask(&app);
                }
                Action::None
            }
            Some((KeyEvent::Escape, _)) => logic.escape(),
            None => logic.tick(secs(Instant::now())),
        };
        match action {
            Action::None => {}
            Action::Start => {
                crate::log::line("flow: key held, listening".to_string());
                listening = begin(&app, &flow);
                if listening.is_none() {
                    logic.reset();
                }
            }
            Action::Restart => {
                drop(listening.take());
                listening = begin(&app, &flow);
                if listening.is_none() {
                    logic.reset();
                }
            }
            Action::Lock => notch::set_phase(&app, Phase::Locked),
            Action::Cancel => {
                crate::log::line("flow: cancelled".to_string());
                drop(listening.take());
                notch::set_phase(&app, Phase::Idle);
            }
            Action::Finish => {
                if let Some(l) = listening.take() {
                    finish(&app, &flow, l, busy.clone());
                } else {
                    notch::set_phase(&app, Phase::Idle);
                }
            }
        }
        // The notch's bars, about 30 times a second while you speak.
        if let Some(l) = &listening {
            let levels = l.take.lock().unwrap().meter.levels;
            notch::bands(&app, levels);
        }
    }
    notch::set_phase(&app, Phase::Idle);
}

/// Opens the microphone. None (and the notch says why) when it can't.
fn begin(app: &AppHandle, flow: &Arc<Flow>) -> Option<Listening> {
    if !speech::is_ready() {
        crate::log::line("flow: the voice model is not ready".to_string());
        notch::announce(app, t("Download the voice model first"), 6);
        return None;
    }
    let mic = flow.store.lock().unwrap().prefs.mic.clone();
    let take = Arc::new(Mutex::new(audio::Take::default()));
    let sink_take = take.clone();
    let source = audio::Source::Mic(if mic.is_empty() { None } else { Some(mic) });
    // How long from the key to the microphone's first sound, in the log: the
    // wait before the bars show is measured, not guessed.
    let pressed = Instant::now();
    let capture = audio::Capture::start(source, move |samples| {
        let mut t = sink_take.lock().unwrap();
        if t.samples.is_empty() && !samples.is_empty() {
            crate::log::line(format!("flow: first sound {} ms after the key", pressed.elapsed().as_millis()));
        }
        // Ten minutes at most: a dictation left open by mistake stops growing.
        if t.samples.len() < 16_000 * 600 {
            t.samples.extend_from_slice(samples);
        }
        t.peak = samples.iter().fold(t.peak, |m, &s| m.max(s.abs()));
        t.meter.feed(samples);
    });
    crate::log::line(format!("flow: microphone opened in {} ms", pressed.elapsed().as_millis()));
    match capture {
        Ok(capture) => {
            let app_front = os::foreground_app().filter(|(id, _)| !is_shell(id));
            notch::set_phase(app, Phase::Listening);
            Some(Listening { capture, take, started: Instant::now(), app: app_front, ask: false })
        }
        Err(err) => {
            crate::log::line(format!("flow: microphone: {err}"));
            notch::set_phase(app, Phase::Idle);
            notch::announce(app, t("Microphone unavailable"), 5);
            None
        }
    }
}

/// Stops listening and turns what was said into pasted text, on a worker
/// thread so the key works again at once.
fn finish(app: &AppHandle, flow: &Arc<Flow>, mut l: Listening, busy: Arc<AtomicBool>) {
    l.capture.stop();
    let seconds = l.started.elapsed().as_secs_f64();
    let (samples, peak) = {
        let mut t = l.take.lock().unwrap();
        (std::mem::take(&mut t.samples), t.peak)
    };
    // Too short or silent: nothing to send to the model (the sensitivity the
    // user wants: unchanged). Logged by length and loudness only, never what
    // was said, so a dictation that "does nothing" can be traced.
    let length = samples.len() as f64 / 16_000.0;
    if samples.len() < 16_000 / 4 || peak < 0.004 {
        crate::log::line(format!("flow: dropped, {length:.1} s at peak {peak:.4} (too short or silent)"));
        notch::set_phase(app, Phase::Idle);
        return;
    }
    crate::log::line(format!("flow: released, {length:.1} s at peak {peak:.3}"));
    notch::set_phase(app, Phase::Thinking);
    let app = app.clone();
    let flow = flow.clone();
    let front = l.app.clone();
    if l.ask {
        std::thread::spawn(move || {
            busy.store(true, Ordering::Relaxed);
            ask(&app, &flow, &samples);
            busy.store(false, Ordering::Relaxed);
        });
        return;
    }
    std::thread::spawn(move || {
        busy.store(true, Ordering::Relaxed);
        let result = process(&app, &flow, &samples, front.as_ref(), seconds);
        busy.store(false, Ordering::Relaxed);
        if let Err(err) = result {
            crate::log::line(format!("flow: {err}"));
            notch::set_phase(&app, Phase::Idle);
        }
    });
}

fn process(app: &AppHandle, flow: &Arc<Flow>, samples: &[f32], front: Option<&(String, String)>, seconds: f64) -> Result<(), String> {
    let started = Instant::now();
    let transcript = speech::transcribe(samples).ok_or("the voice model is not loaded")?;
    let raw = transcript.text.trim().to_string();
    if raw.is_empty() {
        crate::log::line("flow: the model heard no words".to_string());
        notch::set_phase(app, Phase::Idle);
        return Ok(());
    }
    let (prepared, style, cleanup, words, key) = {
        let store = flow.store.lock().unwrap();
        let app_id = front.map(|(id, _)| id.as_str());
        (store.prepare(&raw), store.style_for(app_id), store.prefs.cleanup, store.words.words.clone(), store.prefs.key)
    };
    let mut written = prepared.text.clone();
    if cleanup && style != store::Style::Verbatim && cleanup::has_key() {
        let app_name = front.map(|(_, n)| n.clone());
        let cleaned = tauri::async_runtime::block_on(cleanup::clean(&prepared.text, style, app_name.as_deref(), &words));
        if text::keeps_marks(&cleaned, &prepared.snippets) {
            written = cleaned;
        }
    }
    let final_text = text::finish(&written, &prepared.snippets);
    crate::log::line(format!("flow: {} words in {:?}", text::word_count(&final_text), started.elapsed()));

    os::wait_key_released(key);
    let terminal = front.is_some_and(|(id, _)| is_terminal(id));
    let outcome = paste::paste(&final_text, terminal);
    let entry = {
        let mut store = flow.store.lock().unwrap();
        store.record(&final_text, front.map(|(_, n)| n.as_str()), seconds, store::today(), store::now_ms())
    };
    let _ = app.emit_to(crate::HUB_LABEL, "flow-history", entry);
    match outcome {
        paste::Outcome::Pasted => notch::set_phase(app, Phase::Idle),
        paste::Outcome::Copied => {
            notch::set_phase(app, Phase::Idle);
            notch::announce(app, t("Copied — Ctrl+V to paste"), 6);
        }
        paste::Outcome::Failed => {
            notch::set_phase(app, Phase::Idle);
            return Err("the clipboard refused the text".into());
        }
    }
    Ok(())
}

/// What was said with Shift goes to Claude Code: written out here (your words
/// and replacements, no clean-up: Claude reads it as said), then handed to the
/// island, whose quick conversation asks it and says the answer in the notch
/// (views/chat.ts ask). Nothing is pasted, nothing recorded as a dictation.
fn ask(app: &AppHandle, flow: &Arc<Flow>, samples: &[f32]) {
    let Some(transcript) = speech::transcribe(samples) else {
        crate::log::line("flow: the voice model is not loaded".to_string());
        notch::set_phase(app, Phase::Idle);
        return;
    };
    let raw = transcript.text.trim().to_string();
    notch::set_phase(app, Phase::Idle);
    if raw.is_empty() {
        crate::log::line("flow: the model heard no words".to_string());
        return;
    }
    let text = {
        let store = flow.store.lock().unwrap();
        let prepared = store.prepare(&raw);
        text::finish(&prepared.text, &prepared.snippets)
    };
    crate::log::line(format!("flow: {} words asked of Claude Code", text::word_count(&text)));
    let _ = app.emit_to(crate::island::WINDOW_LABEL, "flow-ask", text);
}

/// "Paste again": the last dictation, in the app in front now.
fn paste_again(app: &AppHandle, flow: &Arc<Flow>) {
    let Some(text) = flow.store.lock().unwrap().last_text() else { return };
    let front = os::foreground_app();
    let terminal = front.as_ref().is_some_and(|(id, _)| is_terminal(id));
    if paste::paste(&text, terminal) == paste::Outcome::Pasted {
        notch::announce(app, t("Last dictation pasted"), 2);
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowStatus {
    prefs: Prefs,
    models: speech::ModelsStatus,
    /// "ok", or why the key can't be watched here ("wayland", "no-display").
    keys: String,
    has_claude_key: bool,
    mics: Vec<audio::InputDevice>,
    platform: &'static str,
    /// winotch started with the computer.
    autostarted: bool,
    /// The user's first name, for "Hello Louis".
    user_name: Option<String>,
}

/// A key in one of winotch's own fields, for the dictation key (os_windows.rs forward_key).
#[tauri::command]
pub fn flow_key(code: String, key_code: u32, down: bool) {
    os::forward_key(&code, key_code, down);
}

#[tauri::command]
pub fn flow_status(flow: State<Arc<Flow>>) -> FlowStatus {
    FlowStatus {
        prefs: flow.store.lock().unwrap().prefs.clone(),
        models: speech::status(),
        keys: match os::keys_supported() {
            Ok(()) => "ok".into(),
            Err(why) => why.into(),
        },
        has_claude_key: cleanup::has_key(),
        mics: audio::input_devices(),
        platform: if cfg!(windows) { "windows" } else { "linux" },
        autostarted: crate::launched_at_login(),
        user_name: crate::platform::user_full_name()
            .and_then(|n| n.split_whitespace().next().map(String::from))
            .filter(|n| !n.is_empty()),
    }
}

#[tauri::command]
pub fn flow_set_prefs(app: AppHandle, flow: State<Arc<Flow>>, prefs: Prefs) {
    let flow = flow.inner().clone();
    let before = {
        let mut store = flow.store.lock().unwrap();
        let before = store.prefs.clone();
        store.prefs = prefs.clone();
        store.save_prefs();
        if before.keep_days != prefs.keep_days {
            store.prune(store::now_ms());
        }
        before
    };
    let restart = before.key != prefs.key;
    if before.enabled && (!prefs.enabled || restart) {
        disable(&app, &flow);
    }
    if prefs.enabled && (!before.enabled || restart) {
        enable(&app, &flow);
    }
    if before.voice != prefs.voice || before.mic != prefs.mic {
        if before.mic != prefs.mic {
            crate::voice::restart(&app);
        } else {
            crate::voice::sync(&app);
        }
    }
    let _ = app.emit("flow-prefs", &prefs);
}

#[tauri::command]
pub fn flow_history(flow: State<Arc<Flow>>) -> Vec<Entry> {
    flow.store.lock().unwrap().history.clone()
}

#[tauri::command]
pub fn flow_delete(flow: State<Arc<Flow>>, id: String) {
    flow.store.lock().unwrap().delete(&id);
}

#[tauri::command]
pub fn flow_clear(flow: State<Arc<Flow>>, everything: bool) {
    let mut store = flow.store.lock().unwrap();
    if everything {
        store.clear_everything();
    } else {
        store.clear_history();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    words: u64,
    seconds: f64,
    dictations: u64,
    words_per_minute: u64,
    minutes_saved: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsView {
    week: Totals,
    month: Totals,
    all: Totals,
    /// The words of the last 30 days, oldest first: ("2026-10-14", words).
    daily: Vec<(String, u64)>,
    apps: std::collections::BTreeMap<String, u64>,
    streak: u32,
}

#[tauri::command]
pub fn flow_stats(flow: State<Arc<Flow>>) -> StatsView {
    let store = flow.store.lock().unwrap();
    let today = store::today();
    let totals = |from: Option<text::Day>| {
        let (words, seconds, dictations) = store.totals(from);
        Totals {
            words,
            seconds,
            dictations,
            words_per_minute: text::words_per_minute(words, seconds),
            minutes_saved: text::minutes_saved(words, seconds),
        }
    };
    let daily = (0..30)
        .rev()
        .map(|back| {
            let key = today.minus(back).key();
            let words = store.stats.days.get(&key).map(|d| d.words).unwrap_or(0);
            (key, words)
        })
        .collect();
    StatsView {
        week: totals(Some(today.minus(6))),
        month: totals(Some(today.minus(29))),
        all: totals(None),
        daily,
        apps: store.stats.apps.clone(),
        streak: store.streak(today),
    }
}

#[tauri::command]
pub fn flow_words(flow: State<Arc<Flow>>) -> Words {
    flow.store.lock().unwrap().words.clone()
}

#[tauri::command]
pub fn flow_set_words(flow: State<Arc<Flow>>, words: Words) {
    let mut store = flow.store.lock().unwrap();
    store.words = words;
    store.save_words();
}

#[tauri::command]
pub fn flow_snippets(flow: State<Arc<Flow>>) -> Vec<Snippet> {
    flow.store.lock().unwrap().snippets.clone()
}

#[tauri::command]
pub fn flow_set_snippets(flow: State<Arc<Flow>>, snippets: Vec<Snippet>) {
    let mut store = flow.store.lock().unwrap();
    store.snippets = snippets;
    store.save_snippets();
}

#[tauri::command]
pub fn flow_styles(flow: State<Arc<Flow>>) -> Vec<AppStyle> {
    flow.store.lock().unwrap().app_styles.clone()
}

#[tauri::command]
pub fn flow_set_styles(flow: State<Arc<Flow>>, styles: Vec<AppStyle>) {
    let mut store = flow.store.lock().unwrap();
    store.app_styles = styles;
    store.save_styles();
}

#[derive(Serialize, Deserialize)]
pub struct RunningApp {
    id: String,
    name: String,
}

#[tauri::command]
pub async fn flow_running_apps() -> Vec<RunningApp> {
    tauri::async_runtime::spawn_blocking(|| os::running_apps().into_iter().map(|(id, name)| RunningApp { id, name }).collect())
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub fn flow_copy(text: String) -> bool {
    paste::copy(&text)
}

#[tauri::command]
pub fn flow_paste_again(app: AppHandle, flow: State<Arc<Flow>>) {
    let flow = flow.inner().clone();
    std::thread::spawn(move || paste_again(&app, &flow));
}

#[tauri::command]
pub fn flow_models_download(app: AppHandle) {
    speech::download(app);
}

#[tauri::command]
pub fn flow_models_remove(app: AppHandle) {
    speech::remove(&app);
}
