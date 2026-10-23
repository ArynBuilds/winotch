// winotch — app wiring and the commands the island calls.

mod apps;
mod sessions;
mod agents;
mod claude;
mod claude_code;
mod config_file;
mod files;
mod flow;
mod github;
mod github_auth;
mod github_notify;
mod hooks;
mod i18n;
mod integrations;
mod island;
mod log;
mod mail;
mod net;
mod notes;
mod pipe;
mod platform;
#[cfg(target_os = "linux")]
mod portal;
mod recap;
mod secrets;
mod session_window;
mod settings;
mod shortcuts;
mod sounds;
mod speech;
mod spotify;
mod today;
mod tray;
mod mark_icon;
mod voice;
#[cfg(windows)]
mod webview_drop;

use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};

use claude::ModelInfo;
use files::DroppedFile;
use hooks::{HookPreview, HookStatus};
use island::{PollGate, ScreenInfo};
use pipe::Pending;
use settings::Settings;

pub struct Shared {
    pub settings: Mutex<Settings>,
    pub gate: Arc<PollGate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    settings: Settings,
    screen: ScreenInfo,
    version: String,
    hook_path: String,
    /// False where the OS has no global cursor (Wayland): the page then reports
    /// the cursor from its own mouse events.
    cursor_poll: bool,
}

#[tauri::command]
fn boot(app: AppHandle, shared: State<Shared>) -> BootInfo {
    let mut settings = shared.settings.lock().unwrap().clone();
    // The real state of ~/.claude/settings.json wins over whatever we stored.
    let hooks_status = hooks::status();
    settings.hooks_installed = hooks_status.installed;
    settings.plan_relay_installed = hooks_status.plan_relay_installed;
    let screen = island::screen_info(&app, &settings.screen);
    BootInfo {
        settings,
        screen,
        version: env!("CARGO_PKG_VERSION").to_string(),
        hook_path: settings::hook_exe_path().to_string_lossy().to_string(),
        cursor_poll: platform::CURSOR_POLL,
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, shared: State<Shared>, settings: Settings) {
    let (screen_changed, autostart_changed, shortcuts_changed, github_auth_changed) = {
        let mut current = shared.settings.lock().unwrap();
        let github_auth_changed = current.github_auth != settings.github_auth;
        let screen_changed = current.screen != settings.screen;
        let autostart_changed = current.autostart != settings.autostart;
        let shortcuts_changed = current.shortcuts != settings.shortcuts;
        // The Gmail accounts belong to the mail_* commands: a page's copy of
        // the settings may be older than the last account added.
        let accounts = std::mem::take(&mut current.gmail_accounts);
        // Get started shows once: an older copy cannot bring it back.
        let welcomed = current.welcomed;
        *current = settings;
        current.gmail_accounts = accounts;
        current.welcomed |= welcomed;
        (screen_changed, autostart_changed, shortcuts_changed, github_auth_changed)
    };
    let settings = shared.settings.lock().unwrap().clone();
    if let Err(err) = settings::save(&settings) {
        log::line(format!("could not save settings: {err}"));
    }
    if autostart_changed {
        let manager = app.autolaunch();
        let result = if settings.autostart { manager.enable() } else { manager.disable() };
        if let Err(err) = result {
            eprintln!("[winotch] autostart: {err}");
        }
    }
    if screen_changed {
        let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
        island::apply_geometry(&app, &settings.screen, collapsed);
    }
    // Which apps are on is the registry's (apps.rs), not the settings'.
    if github_auth_changed {
        // GitHub CLI ⇄ token: another account, perhaps, and another key to ask for.
        integrations::github_token_changed(&app);
        apps::refresh_setup(&app);
    }
    mail::sync(&app);
    if shortcuts_changed {
        shortcuts::apply(&app, &settings.shortcuts);
    }
    if i18n::set_picked(&settings.language) {
        language_changed(&app);
    }
    // Keep the other window in step (island ⇄ settings window).
    let _ = app.emit("settings-changed", settings);
}

/// The island reports the system's languages at launch, for "System" in
/// Settings → Language (WebView2 and WebKitGTK know them best).
#[tauri::command]
fn set_system_languages(app: AppHandle, languages: Vec<String>) {
    if i18n::set_system(languages) {
        language_changed(&app);
    }
}

/// What Rust labels itself follows the new language: the tray menu. The
/// webview switches on its own.
fn language_changed(app: &AppHandle) {
    tray::retitle(app);
}

/// Hidden island → shrink the window to the invisible wake strip and park the
/// cursor poll; anything else → full panel and 60 Hz polling.
///
/// winotch: with the cursor poll (Windows) the window keeps its full size and
/// the poll keeps running; only the wake strip takes the mouse (island.rs).
/// Growing the window back from the strip showed the folded island's last
/// frame for an instant at the strip's old left edge, a hairline left of the
/// notch, before the page caught up, and cost the open its first frames.
#[tauri::command]
fn set_collapsed(app: AppHandle, shared: State<Shared>, collapsed: bool) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    shared.gate.collapsed.store(collapsed, Ordering::Relaxed);
    if platform::CURSOR_POLL {
        // The next tick sets click-through for the strip or the island.
        shared.gate.forget_ignore_state();
        return;
    }
    island::apply_geometry(&app, &pref, collapsed);
    // The wake strip must always take the mouse, and a resize invalidates the flag.
    island::refresh_click_through(&app, &shared.gate);
    shared.gate.set_active(!collapsed);
    platform::set_pointer_watch(!collapsed);
}

/// The front end pushes the island shape; Rust decides click-through from it.
#[tauri::command]
fn set_island_rect(app: AppHandle, shared: State<Shared>, x: f64, y: f64, width: f64, height: f64) {
    shared.gate.set_rect(island::IslandRect { x, y, w: width, h: height });
    // Without the cursor poll the input region is the click-through: it follows the island.
    if !platform::CURSOR_POLL {
        island::refresh_click_through(&app, &shared.gate);
    }
}

#[tauri::command]
fn focus_window(app: AppHandle, focused: bool) {
    let Some(win) = island::window(&app) else { return };
    platform::set_activating(&win, focused);
    if focused {
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn reposition(app: AppHandle, shared: State<Shared>) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
    island::apply_geometry(&app, &pref, collapsed);
}

/// The panel is laid out in CSS px against the window's own scale. If the webview
/// reports a different devicePixelRatio (it ends up bigger than the window and gets
/// cut), correct its zoom so one CSS px is one logical px again.
#[tauri::command]
fn fit_zoom(app: AppHandle, dpr: f64) -> bool {
    let Some(win) = island::window(&app) else { return false };
    let scale = win.scale_factor().unwrap_or(1.0);
    static ZOOM: std::sync::Mutex<f64> = std::sync::Mutex::new(1.0);
    let mut zoom = ZOOM.lock().unwrap();
    if let Some(new_zoom) = island::calculate_zoom_correction(*zoom, scale, dpr) {
        *zoom = new_zoom;
        log::line(format!("webview dpr {dpr} != window scale {scale} — setting zoom {new_zoom:.3}"));
        let _ = win.set_zoom(new_zoom);
        true
    } else {
        false
    }
}


/// The displays the island can be pinned to, for Settings.
#[tauri::command]
fn list_monitors(app: AppHandle) -> Vec<island::MonitorChoice> {
    island::monitor_choices(&app)
}

#[tauri::command]
fn open_url(url: String) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    platform::open_url(&url);
}

/// "Open terminal" opens the working folder in VS Code when `code` is on PATH,
/// and falls back to the file manager otherwise.
#[tauri::command]
fn open_in_vscode(path: Option<String>) -> bool {
    // No shell anywhere near this. The path is a project folder chosen by
    // whoever is using Claude Code, and a shell would happily read `&`, `^`, `%`
    // or `$` in a folder name as syntax. Finding the launcher ourselves and
    // handing the path over as a separate argument keeps it a path.
    let path = path.filter(|p| !p.is_empty());
    // It arrives in a hook payload: only an existing folder, given by its full
    // path, goes any further. `code` would read `--something` as an option, and
    // xdg-open would launch a file with whatever handles its type.
    if let Some(p) = path.as_deref() {
        let p = std::path::Path::new(p);
        if !(p.is_absolute() && p.is_dir()) {
            return false;
        }
    }
    if let Some(code) = platform::find_on_path("code") {
        let mut cmd = Command::new(code);
        if let Some(p) = path.as_deref() {
            cmd.arg(p);
        }
        if platform::no_console(&mut cmd).spawn().is_ok() {
            return true;
        }
    }
    if let Some(p) = path.as_deref() {
        platform::reveal_folder(p);
    }
    false
}

/// "Open terminal": brings forward the terminal or editor window the session
/// runs in, when it was found (see session_window.rs); otherwise opens the
/// folder in VS Code, as before.
#[tauri::command]
fn open_session(session_id: Option<String>, path: Option<String>) -> bool {
    show_session(session_id, path)
}

/// A session's terminal to the front, else VS Code on its folder (the command above, and Claude Code's
/// winotch_open_session through the API, apps.rs).
pub(crate) fn show_session(session_id: Option<String>, path: Option<String>) -> bool {
    let Some(owners) = session_id.as_deref().and_then(session_window::lookup) else {
        return open_in_vscode(path);
    };
    let folder = path.as_deref().map(session_window::folder_name).unwrap_or_default().to_string();
    #[cfg(windows)]
    {
        if platform::focus_session_window(&owners, &folder) {
            return true;
        }
        open_in_vscode(path)
    }
    // Linux asks the display server, KWin or the terminal, which can take a
    // moment: never on the UI thread a sync command runs on. VS Code still
    // opens when none of them could bring the window forward.
    #[cfg(target_os = "linux")]
    {
        std::thread::spawn(move || {
            if !platform::focus_session_window(&owners, &folder) {
                open_in_vscode(path);
            }
        });
        true
    }
}

/// The Claude Desktop pill's target: the Claude app (Windows only — it has no
/// Linux build).
#[tauri::command]
fn open_claude_desktop() -> bool {
    platform::open_claude_desktop()
}

/// The file behind a live diff, if it may be handed to the editor: an existing
/// regular file given by its full path. Anything else — a relative path, a
/// folder, a path `code` could read as an option — goes no further.
fn diff_file(path: &str) -> Option<&std::path::Path> {
    let p = std::path::Path::new(path);
    (p.is_absolute() && p.is_file()).then_some(p)
}

/// The diff card's ↗: opens the edited file in VS Code when `code` is on PATH,
/// otherwise shows its folder. The file itself is never opened by its type —
/// xdg-open or Explorer would run a script that Claude just wrote.
#[tauri::command]
fn open_file_in_vscode(path: String) -> bool {
    let Some(file) = diff_file(&path) else { return false };
    if let Some(code) = platform::find_on_path("code") {
        let mut cmd = Command::new(code);
        cmd.arg(file);
        if platform::no_console(&mut cmd).spawn().is_ok() {
            return true;
        }
    }
    if let Some(folder) = file.parent().filter(|d| d.is_dir()) {
        platform::reveal_folder(&folder.to_string_lossy());
    }
    false
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Tray → Pause. Paused means paused: the pollers stop talking to the network,
/// not just the island stopping showing things.
#[tauri::command]
fn set_paused(paused: bool) {
    integrations::set_paused(paused);
    // The mail watchers hang up while paused and connect again after.
    mail::wake_all();
}

// ── Claude Code hooks ─────────────────────────────────────────────────────────

#[tauri::command]
fn hooks_status() -> HookStatus {
    hooks::status()
}

/// Returns the diff the user has to look at before anything is written.
#[tauri::command]
fn hooks_preview(install: bool) -> Result<HookPreview, String> {
    hooks::preview(install)
}

/// Only ever called from an explicit click in the settings window.
#[tauri::command]
fn hooks_apply(
    app: AppHandle,
    shared: State<Shared>,
    install: bool,
    fingerprint: String,
) -> Result<String, String> {
    // The fingerprint comes from the preview the user actually looked at, so a
    // settings.json that changed in between is refused rather than overwritten.
    let backup = hooks::write(install, &fingerprint)?;
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        current.hooks_installed = install;
        if let Err(err) = settings::save(&current) {
            log::line(format!("could not save settings: {err}"));
        }
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(backup)
}

// ── Plan usage ────────────────────────────────────────────────────────────────

/// The diff of putting the plan usage relay into (or taking it out of) the
/// status line, before anything is written.
#[tauri::command]
fn status_line_preview(install: bool) -> Result<HookPreview, String> {
    hooks::status_line_preview(install)
}

/// Only ever called from an explicit click in the settings window.
#[tauri::command]
fn status_line_apply(
    app: AppHandle,
    shared: State<Shared>,
    install: bool,
    fingerprint: String,
) -> Result<String, String> {
    let backup = hooks::status_line_write(install, &fingerprint)?;
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        current.plan_relay_installed = install;
        // As on the Mac: taking the relay out turns the pill off with it.
        if !install {
            current.show_plan_in_notch = false;
        }
        if let Err(err) = settings::save(&current) {
            log::line(format!("could not save settings: {err}"));
        }
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(backup)
}

#[tauri::command]
fn approval_decision(app: AppHandle, request_id: String, decision: String) {
    recap::record_decision(&app, &request_id, &decision);
    pipe::answer(&app, &request_id, &decision);
}

/// An option picked on the island for a question Claude Code asked.
#[tauri::command]
fn approval_answer(
    app: AppHandle,
    request_id: String,
    answers: std::collections::HashMap<String, serde_json::Value>,
) {
    // An answered question is not an Allow / Deny: nothing for the recap.
    recap::forget_request(&app, &request_id);
    pipe::answer_question(&app, &request_id, &answers);
}

/// The island has the card on screen, so the long wait for a human may begin.
/// Until this arrives the relay only waits a few hundred milliseconds, which is
/// what stops a paused or unresponsive island from freezing Claude Code.
#[tauri::command]
fn approval_ack(app: AppHandle, request_id: String) {
    pipe::acknowledge(&app, &request_id);
}

/// Nobody can act on this request — the island is paused, or another card is
/// already up. Claude Code falls back to asking in the terminal immediately.
#[tauri::command]
fn approval_decline(app: AppHandle, request_id: String) {
    recap::forget_request(&app, &request_id);
    pipe::decline(&app, &request_id);
}

// ── Files and secrets ───────────────────────────────────────────────────────

/// The models on the user's Claude account, for the model select of the
/// settings. Only asked once a key is saved.
#[tauri::command]
async fn claude_models() -> Result<Vec<ModelInfo>, String> {
    let key = secrets::get(claude::KEY).ok_or_else(|| i18n::t("No API key — add it in Settings."))?;
    claude::models(&key).await
}

/// Copies a dropped file into the inbox and reports its name back.
#[tauri::command]
fn ingest_file(path: String) -> Result<DroppedFile, String> {
    files::ingest(&path)
}

/// The island may only ask whether a key exists — never read it.
#[tauri::command]
fn secret_present(key: String) -> bool {
    secrets::present(&key)
}

#[tauri::command]
fn secret_set(app: AppHandle, key: String, value: String) -> Result<(), String> {
    // A Gmail password only comes in through mail_add_account, which checks it.
    if secrets::is_mail_key(&key) {
        return Err(i18n::t("Gmail accounts are added in Settings → Apps"));
    }
    let before = (key == "github-token").then(|| secrets::get(&key));
    secrets::set(&key, &value)?;
    if key == claude::KEY {
        voice::sync(&app);
    }
    if let Some(before) = before {
        if secrets::get(&key) != before {
            integrations::github_token_changed(&app);
        }
    }
    // A built-in's key: its status line in the registry.
    apps::refresh_setup(&app);
    Ok(())
}

#[tauri::command]
fn secret_clear(app: AppHandle, key: String) -> Result<(), String> {
    if secrets::is_mail_key(&key) {
        return Err(i18n::t("Gmail accounts are removed in Settings → Apps"));
    }
    let had = key == "github-token" && secrets::present(&key);
    secrets::clear(&key)?;
    if key == claude::KEY {
        voice::sync(&app);
    }
    if had {
        integrations::github_token_changed(&app);
    }
    apps::refresh_setup(&app);
    Ok(())
}

/// Refresh buttons in the integration cards.
#[tauri::command]
async fn refresh_integration(app: AppHandle, id: String) {
    integrations::poll_once(app, &id).await;
}

/// The GitHub card was opened: refetch its `section` ("pulse" or "activity")
/// if it is stale. The pollers still decline while the pill is off or paused.
#[tauri::command]
fn github_refresh(section: String) {
    integrations::github_refresh_if_stale(&section);
}

/// Lets the island write to the same log as the Rust side.
#[tauri::command]
fn log_line(message: String) {
    log::line(format!("ui  {message}"));
}

// ── Global shortcuts ──────────────────────────────────────────────────────────

/// How each global shortcut went: registered, taken by another app, and so on.
#[tauri::command]
fn shortcuts_status(app: AppHandle) -> shortcuts::Report {
    shortcuts::status(&app)
}

/// Settings is recording a new combination: let go of ours meanwhile, so the
/// keys reach the recorder instead of running an action. `false` takes them back.
#[tauri::command]
fn shortcuts_suspend(app: AppHandle, shared: State<Shared>, suspended: bool) {
    if suspended {
        shortcuts::suspend(&app);
    } else {
        let stored = shared.settings.lock().unwrap().shortcuts.clone();
        shortcuts::apply(&app, &stored);
    }
}

// ── Settings window ───────────────────────────────────────────────────────────

// The island is winotch's only window now (the Flow pill went into its compact
// notch). Should another one come back: WebView2 allows exactly one browser
// environment per app, its options fixed by whichever webview is created
// first, so a window built at run time must ask for the island's own
// `additionalBrowserArgs` (tauri.conf.json), or it comes up blank, with no
// error anywhere.

/// winotch's settings live inside the island (views/settings.ts), not in a
/// window of their own: what Rust sent to that window (flow-history,
/// notes-changed) goes to the island, which draws those pages now.
pub const HUB_LABEL: &str = island::WINDOW_LABEL;

pub fn show_settings_window(app: &AppHandle) {
    show_hub(app, Some("general"));
}

/// Opens winotch's settings, in the island, on `page` when given ("dictation",
/// "notes", "settings", "general"…): the island grows around them.
pub fn show_hub(app: &AppHandle, page: Option<&str>) {
    let _ = app.emit_to(island::WINDOW_LABEL, "open-settings", page.unwrap_or("general").to_string());
}

/// The argument the login item starts winotch with.
const AUTOSTART_ARG: &str = "--autostart";

/// winotch started with the computer, not opened by the user: the window stays hidden.
pub fn launched_at_login() -> bool {
    std::env::args().any(|a| a == AUTOSTART_ARG)
}

#[tauri::command]
fn open_settings_window(app: AppHandle, page: Option<String>) {
    show_hub(&app, Some(page.as_deref().unwrap_or("general")));
}

/// What Claude Code sets in the processes it starts, naming its session as
/// their parent. winotch started from a Claude Code terminal would pass them on
/// to every `claude` it runs, which then saves no transcript (a child session)
/// and carries another session's identity; to a terminal it opens, too. Only
/// these session markers go: settings the user may have set themselves stay.
const PARENT_SESSION_VARS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_BRIDGE_SESSION_ID",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_PID",
];

pub fn run() {
    // First, while winotch is still one thread: changing the environment is
    // only sound before any other thread could be reading it.
    for var in PARENT_SESSION_VARS {
        unsafe { std::env::remove_var(var) };
    }
    platform::prepare_environment();
    let upgrading = settings::file_exists();
    let loaded = settings::load();
    let mail_accounts: Vec<String> = loaded.gmail_accounts.iter().map(|a| a.email.clone()).collect();
    i18n::set_picked(&loaded.language);
    let gate = Arc::new(PollGate::new());

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // `winotch --shortcut <action>`: what a desktop's own keyboard
            // settings run where we can't listen for keys ourselves (Wayland).
            match shortcuts::from_args(&argv) {
                Some(action) => shortcuts::dispatch(app, action),
                // Opening winotch again (its shortcut, the Start menu) shows its window.
                None => show_hub(app, None),
            }
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![AUTOSTART_ARG])));
    // Where no global shortcut can work, the plugin isn't even started.
    if platform::global_shortcuts_blocked().is_none() {
        builder = builder.plugin(shortcuts::plugin());
    }

    builder
        .manage(Shared {
            settings: Mutex::new(loaded.clone()),
            gate: gate.clone(),
        })
        .manage(Pending::default())
        .manage(shortcuts::Registry::default())
        .manage(recap::load())
        .invoke_handler(tauri::generate_handler![
            boot,
            save_settings,
            set_system_languages,
            set_collapsed,
            set_island_rect,
            focus_window,
            reposition,
            fit_zoom,
            list_monitors,
            open_url,
            open_in_vscode,
            open_session,
            open_claude_desktop,
            open_file_in_vscode,
            quit_app,
            hooks_status,
            hooks_preview,
            hooks_apply,
            status_line_preview,
            status_line_apply,
            approval_decision,
            approval_answer,
            approval_ack,
            approval_decline,
            log_line,
            claude_models,
            ingest_file,
            secret_present,
            secret_set,
            secret_clear,
            refresh_integration,
            github_refresh,
            github_auth::github_cli_status,
            github_notify::github_act,
            open_settings_window,
            set_paused,
            shortcuts_status,
            shortcuts_suspend,
            recap::recap_history,
            recap::recap_prefs,
            recap::recap_set_enabled,
            recap::recap_set_hide_projects,
            recap::recap_mark_shown,
            recap::recap_clear,
            recap::recap_save_png,
            recap::recap_reveal_saved,
            sounds::custom_sounds,
            sounds::custom_sound,
            sounds::reveal_sounds_folder,
            sounds::reload_sounds,
            spotify::spotify_refresh,
            spotify::spotify_control,
            spotify::spotify_open,
            spotify::spotify_installed,
            flow::flow_status,
            flow::flow_key,
            flow::flow_set_prefs,
            flow::flow_history,
            flow::flow_delete,
            flow::flow_clear,
            flow::flow_stats,
            flow::flow_words,
            flow::flow_set_words,
            flow::flow_snippets,
            flow::flow_set_snippets,
            flow::flow_styles,
            flow::flow_set_styles,
            flow::flow_running_apps,
            flow::flow_copy,
            flow::flow_paste_again,
            flow::flow_models_download,
            flow::flow_models_remove,
            flow::notch::flow_notch_state,
            apps::apps_snapshot,
            apps::notification_read,
            apps::notification_dismiss,
            apps::notification_act,
            apps::app_item_act,
            apps::app_item_detail,
            apps::app_item_prefetch,
            apps::app_set_muted,
            apps::app_set_hidden,
            apps::app_remove,
            apps::apps_refresh_setup,
            apps::apps_api_file,
            claude_code::mcp_status,
            claude_code::mcp_install,
            claude_code::mcp_remove,
            mail::mail_accounts,
            mail::mail_add_account,
            mail::mail_remove_account,
            mail::mail_set_account,
            today::today_state,
            today::today_todo_add,
            today::today_todo_update,
            today::today_todo_delete,
            today::today_note_add,
            today::today_note_update,
            today::today_note_delete,
            sessions::sessions_list,
            sessions::session_messages,
            sessions::session_send,
            sessions::sessions_reachable,
            sessions::session_type,
            sessions::quick_send,
            sessions::quick_reset,
            notes::notes_state,
            notes::notes_start,
            notes::notes_stop,
            notes::notes_rename,
            notes::notes_rename_speaker,
            notes::notes_toggle_todo,
            notes::notes_delete,
            notes::notes_summarize,
            notes::notes_retry,
            notes::notes_markdown,
            notes::notes_export,
            voice::voice_done,
            voice::voice_say_native,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            // Before anything reads a key: an upgrade finds them under winotch's own name.
            secrets::move_from_fork(upgrading, &mail_accounts);
            tray::build(&handle)?;
            // Dictation's key, OK Tent and the Notetaker: no window of their
            // own, the island's compact notch shows them (flow/notch.rs).
            flow::setup(&handle);
            notes::setup(&handle);
            // The tray and the windows wear the mark in the ink of the Windows theme.
            mark_icon::follow_theme(&handle);

            if let Some(win) = island::window(&handle) {
                // Where Tauri takes the drop itself (Linux), its paths are the
                // ones ingest_file may copy (files.rs).
                let themed = handle.clone();
                win.on_window_event(move |event| match event {
                    tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                        files::allow_dropped(paths.iter().map(|p| p.to_string_lossy().to_string()));
                    }
                    // Light or dark mode changed: the mark changes ink at once.
                    tauri::WindowEvent::ThemeChanged(_) => mark_icon::refresh(&themed),
                    _ => {}
                });
                platform::make_non_activating(&win);
                #[cfg(windows)]
                webview_drop::install(&handle);
                island::apply_geometry(&handle, &loaded.screen, false);
                let _ = win.show();
            }
            gate.collapsed.store(false, Ordering::Relaxed);
            // Nothing drawn yet, so nothing takes the mouse until the page
            // reports the island's shape.
            if !platform::CURSOR_POLL {
                island::refresh_click_through(&handle, &gate);
            }
            gate.set_active(true);
            island::spawn_cursor_poll(handle.clone(), gate.clone());

            log::line(format!("--- winotch {} started ---", env!("CARGO_PKG_VERSION")));
            hooks::ensure_hook_exe(&handle);
            pipe::start(handle.clone());
            apps::start(&handle);
            github_notify::setup(&handle);
            // After the feed exists: Gmail is an app in it.
            mail::start(&handle);
            // Today: its to-dos and notes, and the one timer of its reminders.
            today::start(&handle);
            handle.manage(sessions::Sending::default());
            handle.manage(sessions::Consoles::default());
            handle.manage(sessions::Quick::default());
            // The built-ins switched on start (the registry says which), and
            // each one's status line says what it still needs.
            integrations::sync(&handle);
            apps::refresh_setup(&handle);
            shortcuts::apply(&handle, &loaded.shortcuts);
            if loaded.autostart {
                // Login items written before 0.5 start winotch without --autostart:
                // writing it again adds it, so the window stays hidden at login.
                let _ = handle.autolaunch().enable();
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building winotch")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                notes::shutdown(app);
                sessions::quick_shutdown(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::diff_file;

    #[test]
    fn only_an_existing_file_by_its_full_path_reaches_the_editor() {
        let dir = std::env::temp_dir().join(format!("winotch-diff-file-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("edited.ts");
        std::fs::write(&file, "x").unwrap();

        assert!(diff_file(&file.to_string_lossy()).is_some());
        // A folder, a missing file, a relative path or an option never pass.
        assert!(diff_file(&dir.to_string_lossy()).is_none());
        assert!(diff_file(&dir.join("missing.ts").to_string_lossy()).is_none());
        assert!(diff_file("edited.ts").is_none());
        assert!(diff_file("--help").is_none());
        assert!(diff_file("").is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
