// The app framework (WINOTCH.md): any app on this computer can put itself on
// the island and send notifications through one small contract, over HTTP on
// 127.0.0.1. Nothing listens beyond this computer, and every call but the
// health check carries the token written next to the address in api.json.
//
//   POST /v1/apps      register or update an app: id, name, icon, callback, status
//   POST /v1/status    what an app's pill says now: app, status
//   POST /v1/notify    a notification: app, title, body, url, importance, actions
//   GET  /v1/notifications?app=&unread=1&limit=   the feed, newest first
//   GET  /v1/apps      the apps
//   POST /v1/read      mark read: id, or app, or all
//   POST /v1/items     the app's current list (an inbox, open drafts): app,
//                      status, views, sections of items; it replaces the last one
//
// When the user presses an action, the island posts {app, notification,
// action} to the app's callback, and the app does the work; a press on a list
// item posts {type: "item", app, item, action}. A click on an item that has
// `detail` asks {type: "detail", app, item}, answered with the item's details
// (`ItemDetail`). An app can draft; only a press sends.
//
// This is the one registry of apps (WINOTCH.md, "Apps: one registry"). Every
// app is an entry here, and every screen draws from its snapshot: the island's
// pills, Settings → Apps, the bell, the expanded view, the logos.
// - The built-ins (BUILTINS: GitHub, Stripe, Notion, Spotify, Gmail, Today) are
//   winotch's own. They are always registered, on or off, configured or not;
//   their modules write their status, list and notifications here through the
//   internal API below; their presses are handled in Rust; no outside app may
//   take their id or post as them. Gmail also owns GET/POST /v1/mail/*.
// - API apps register themselves over HTTP.
// Shown on the island (`hidden`) and may open it (`muted`) are the user's, for
// every app alike, kept in apps.json. Each entry also declares what its row in
// Settings needs (`Setup`), which Settings renders without knowing the app.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::i18n::n_;
use crate::island::WINDOW_LABEL;
use crate::settings;

/// The port apps find in api.json; another one is picked when it is taken.
pub const PORT: u16 = 47830;
const MAX_HEAD: usize = 16 * 1024;
/// Room for a full list (5 sections of 50 items); a notification is far smaller.
const MAX_BODY: usize = 512 * 1024;
/// Notifications kept, newest first.
const KEEP: usize = 300;
const MAX_ACTIONS: usize = 3;
/// A list's bounds: refused past them rather than cut, so an app learns its
/// list would not be shown whole.
const MAX_SECTIONS: usize = 5;
const MAX_ITEMS: usize = 50;
/// A list's views (its left column on the island): few and short.
const MAX_VIEWS: usize = 6;
const MAX_VIEW_ID: usize = 24;
const MAX_VIEW_LABEL: usize = 20;
/// An item's details, as an app answers them: refused past these.
const MAX_DETAIL_ANSWER: usize = 256 * 1024;
const MAX_DETAIL_BODY: usize = 20_000;
const MAX_DETAIL_META: usize = 8;
const MAX_DETAIL_FILES: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub id: String,
    pub name: String,
    /// Its sign, dashes and dots ("-.", "--."). None: the island makes one.
    #[serde(default)]
    pub sign: Option<String>,
    /// Its own logo, a `data:` URL of a PNG or SVG picture. Shown as an image,
    /// never as markup, so a picture cannot run anything.
    #[serde(default)]
    pub icon: Option<String>,
    /// Where pressed actions are posted, on this computer only.
    #[serde(default)]
    pub callback: Option<String>,
    /// What its pill says now.
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub updated: u64,
    /// Muted in Settings: its notifications stay in the feed but never open
    /// or peek the island.
    #[serde(default)]
    pub muted: bool,
    /// Hidden in Settings: no pill on the island. Its notifications still
    /// arrive in the feed; whether they open the island is `muted`'s call.
    /// A built-in that is hidden is also off: its poller does not run.
    #[serde(default)]
    pub hidden: bool,
    /// A built-in (winotch's own: Rust handles its presses, and it cannot be
    /// removed or taken over through the API) or an app from the API. An
    /// apps.json from before reads as "api"; the built-ins are set again at
    /// every start (`ensure_builtins`).
    #[serde(default)]
    pub kind: Kind,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Builtin,
    #[default]
    Api,
}

// ── What an app's row in Settings needs ───────────────────────────────────────

/// A key in the credential store (secrets.rs). The labels are English keys,
/// translated where they are shown.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeySetup {
    /// Its name in the credential store ("stripe-api-key").
    pub secret: &'static str,
    pub label: &'static str,
    pub placeholder: &'static str,
    /// What the key needs, when that is not obvious.
    pub hint: Option<&'static str>,
}

/// What an app declares its Settings row needs, besides the switches every
/// app has. Settings renders each kind the same way for every app.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Setup {
    /// Nothing to set up.
    None,
    /// One key.
    Key(KeySetup),
    /// A list of accounts, each added with its own sign-in and each choosing
    /// whether it may open the island (Gmail, mail/).
    Accounts,
    /// A choice of how to sign in ("cli": a command-line tool's login;
    /// "token": the key, asked for only then). GitHub, github_auth.rs.
    SignIn { modes: &'static [&'static str], key: KeySetup },
}

/// One of winotch's own apps.
pub struct Builtin {
    pub id: &'static str,
    pub name: &'static str,
    /// Its pill on the island. The four that had a pill before the registry
    /// keep its id ("integration_github"), so nothing that names it changes.
    pub pill: &'static str,
    /// Its mark in core/logos.ts.
    pub logo: &'static str,
    pub setup: Setup,
    /// Its id in settings.json's `activeIntegrations` / `quietApps`, where
    /// its two switches were kept before the registry (see `migrate`).
    pub legacy: Option<&'static str>,
    /// On the island on a fresh install.
    pub shown_by_default: bool,
    /// What it needs on this computer to do anything (Spotify: the app).
    pub installed: Option<fn() -> bool>,
}

const KEY_MISSING: &str = n_("Key not configured");
const NOT_INSTALLED: &str = n_("Not installed");
const NOT_CONNECTED: &str = n_("Not connected");

/// The built-ins, in the order Settings lists them and the island shows them.
pub const BUILTINS: &[Builtin] = &[
    Builtin {
        id: "github",
        name: "GitHub",
        pill: "integration_github",
        logo: "github",
        setup: Setup::SignIn {
            modes: &["cli", "token"],
            key: KeySetup {
                secret: "github-token",
                label: n_("Token"),
                placeholder: "ghp_…",
                hint: Some(n_("Classic token with the repo scope, or fine-grained with read access to Pull requests, Commit statuses and Actions.")),
            },
        },
        legacy: Some("integration_github"),
        shown_by_default: true,
        installed: None,
    },
    Builtin {
        id: "stripe",
        name: "Stripe",
        pill: "integration_stripe",
        logo: "stripe",
        setup: Setup::Key(KeySetup { secret: "stripe-api-key", label: n_("Secret key"), placeholder: "sk_live_…", hint: None }),
        legacy: Some("integration_stripe"),
        shown_by_default: false,
        installed: None,
    },
    Builtin {
        id: "notion",
        name: "Notion",
        pill: "integration_notion",
        logo: "notion",
        setup: Setup::Key(KeySetup { secret: "notion-api-key", label: n_("Integration token"), placeholder: "ntn_…", hint: None }),
        legacy: Some("integration_notion"),
        shown_by_default: false,
        installed: None,
    },
    Builtin {
        id: "spotify",
        name: "Spotify",
        pill: "integration_spotify",
        logo: "spotify",
        setup: Setup::None,
        legacy: Some("integration_spotify"),
        shown_by_default: false,
        installed: Some(crate::spotify::spotify_installed),
    },
    Builtin {
        id: "gmail",
        name: "Gmail",
        pill: "app_gmail",
        logo: "gmail",
        setup: Setup::Accounts,
        // Gmail kept its switches in apps.json already.
        legacy: None,
        shown_by_default: true,
        installed: None,
    },
    Builtin {
        id: "today",
        name: "Today",
        pill: "app_today",
        logo: "today",
        // Local only: nothing to sign in to (today.rs).
        setup: Setup::None,
        legacy: None,
        shown_by_default: true,
        installed: None,
    },
];

pub fn builtin(id: &str) -> Option<&'static Builtin> {
    BUILTINS.iter().find(|b| b.id == id)
}

/// Claude Code's own pill. It is not an app of the registry; what Claude
/// posts through MCP (the API app "claude") is shown under it.
pub const MAIN_PILL: &str = "integration_claude";

/// The island's pill of an API app: `app_<id>`; Claude's posts go to Claude Code's.
fn api_pill(id: &str) -> String {
    if id == "claude" { MAIN_PILL.to_string() } else { format!("app_{id}") }
}

// ── The internal API: winotch's own modules (the built-ins) ────────────────────
//
// A built-in's module (mail/, github_notify.rs, integrations.rs…) is always in
// the registry (BUILTINS) and writes what it knows through these:
//
//   apps::set_internal_handler("gmail", handler)   once, before any press can come
//   apps::set_internal_detail("gmail", handler)    the same, for its items' details
//   apps::post_internal(&handle, "gmail", NewNotification { .. })  → its id
//   apps::read_internal(&handle, &id) / apps::dismiss_internal(&handle, &id)
//   apps::set_internal_items(&handle, "gmail", Some(AppItems { .. }))  its list and status
//   apps::set_problem(&handle, "stripe", Some(error))   what is wrong, or None
//   apps::set_available(&handle, "gmail", false)        no pill until it can do something
//   apps::is_shown(&handle, "github")                   switched on: may it poll?
//
// A press on one of its buttons (a notification's or a list item's) calls the
// handler instead of posting to a callback. Its id is refused to outside apps
// on every call (register, status, notify, items), and Settings cannot remove it.

/// winotch's own: a built-in's id, refused to outside apps.
pub fn is_builtin(id: &str) -> bool {
    builtin(id).is_some()
}

/// A press on one of a built-in's buttons. The notification (its `id`,
/// its `meta`) or the list item comes whole, as it was when pressed.
pub enum Press {
    Notification { notification: Notification, action: String },
    Item { item: ListItem, action: String },
}

pub type PressFuture = std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>>;
/// What does the work of a built-in's presses. An error is shown on the
/// island, and a notification's buttons stay to press again.
pub type PressHandler = std::sync::Arc<dyn Fn(AppHandle, Press) -> PressFuture + Send + Sync>;

static HANDLERS: std::sync::LazyLock<Mutex<HashMap<String, PressHandler>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Routes the presses of the built-in `id` to `handler`.
pub fn set_internal_handler(id: &str, handler: PressHandler) {
    HANDLERS.lock().unwrap().insert(id.to_string(), handler);
}

/// A click on one of a built-in's items that has `detail`: the item comes
/// whole, as the list has it now.
pub struct DetailRequest {
    pub item: ListItem,
    /// Only the pointer resting on its row: read it ahead if that helps, and
    /// answer at once (nothing is shown, nothing marked read).
    pub prefetch: bool,
}

pub type DetailFuture = std::pin::Pin<Box<dyn std::future::Future<Output = Result<ItemDetail, String>> + Send>>;
/// What reads a built-in's item details. An error is shown in the details pane.
pub type DetailHandler = std::sync::Arc<dyn Fn(AppHandle, DetailRequest) -> DetailFuture + Send + Sync>;

static DETAILS: std::sync::LazyLock<Mutex<HashMap<String, DetailHandler>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Routes the details of the built-in `id`'s items to `handler`.
pub fn set_internal_detail(id: &str, handler: DetailHandler) {
    DETAILS.lock().unwrap().insert(id.to_string(), handler);
}

/// A notification a built-in posts from Rust: what /v1/notify takes, plus
/// `meta`, the app's own record of what it stands for (mail/: which mails), kept
/// in apps.json and handed back with every press.
pub struct NewNotification {
    pub title: String,
    pub body: Option<String>,
    /// http(s) only, or it is dropped.
    pub url: Option<String>,
    /// "low" (waits behind the bell), "normal" (peeks) or "high" (opens).
    pub importance: &'static str,
    pub actions: Vec<Action>,
    pub meta: Option<Value>,
    /// The id of its list item it is about, if any (see `Notification::item`).
    pub item: Option<String>,
}

/// What is wrong with a built-in now (a poll that failed, a signed-out
/// command-line tool), shown as its status line; None once it works again.
/// Tells the island only when it changed, so a poll that fails the same way
/// every time draws nothing.
pub fn set_problem(handle: &AppHandle, id: &str, problem: Option<String>) {
    if let Some(apps) = handle.try_state::<Apps>() {
        if apps.set_live(id, |l| l.problem = problem) {
            changed(handle);
        }
    }
}

/// Whether a built-in can do anything yet (Gmail: an account exists). Off,
/// it keeps its row in Settings but has no pill.
pub fn set_available(handle: &AppHandle, id: &str, available: bool) {
    if let Some(apps) = handle.try_state::<Apps>() {
        if apps.set_live(id, |l| l.unavailable = !available) {
            changed(handle);
        }
    }
}

/// Switched on (it has a pill): a built-in polls only then.
pub fn is_shown(handle: &AppHandle, id: &str) -> bool {
    handle.try_state::<Apps>().is_some_and(|apps| apps.shown(id))
}

/// Kept from opening or peeking the island (Settings → Apps).
pub fn is_muted(handle: &AppHandle, id: &str) -> bool {
    handle.try_state::<Apps>().is_some_and(|apps| apps.is_muted(id))
}

/// Looks again at what each built-in needs (its key, its sign-in mode, the
/// app it drives) for its status line: at start, after a key was saved or
/// removed, after the settings changed, and when Settings → Apps opens.
/// Local reads only (the credential store, two files): nothing on the network.
pub fn refresh_setup(handle: &AppHandle) {
    let Some(apps) = handle.try_state::<Apps>() else { return };
    let mut any = false;
    for b in BUILTINS {
        let note = setup_note(handle, b);
        any |= apps.set_live(b.id, |l| l.note = note);
    }
    if any {
        changed(handle);
    }
}

/// What a built-in still needs before it can work, as an English key.
fn setup_note(handle: &AppHandle, b: &Builtin) -> Option<&'static str> {
    if b.installed.is_some_and(|installed| !installed()) {
        return Some(NOT_INSTALLED);
    }
    match &b.setup {
        Setup::Key(key) => (!crate::secrets::present(key.secret)).then_some(KEY_MISSING),
        // Signed in through the command line, there is no key to ask for; its
        // own problems show once it is polled (set_problem).
        Setup::SignIn { key, .. } => (crate::github_auth::mode(handle) == crate::github_auth::Mode::Token
            && !crate::secrets::present(key.secret))
        .then_some(KEY_MISSING),
        Setup::None | Setup::Accounts => None,
    }
}

/// Posts a notification as a built-in and shows it (unless the user
/// muted the app). Returns its id.
pub fn post_internal(handle: &AppHandle, app: &str, n: NewNotification) -> Result<String, String> {
    let apps = handle.try_state::<Apps>().ok_or("the feed is not ready")?;
    let posted = apps.post(app, n)?;
    changed(handle);
    announce(handle, &posted);
    Ok(posted.id)
}

// For built-ins beside Gmail (GitHub's notifications): mail/ marks read
// through read_and_dismiss, many at a time.
#[allow(dead_code)]
pub fn read_internal(handle: &AppHandle, id: &str) {
    if let Some(apps) = handle.try_state::<Apps>() {
        apps.mark_read(Some(id), None);
        changed(handle);
    }
}

pub fn dismiss_internal(handle: &AppHandle, id: &str) {
    if let Some(apps) = handle.try_state::<Apps>() {
        apps.dismiss(id);
        changed(handle);
    }
}

/// A built-in's list, shown when it is expanded, and its pill's status
/// (the list's). None, or no sections, clears it. Never opens the island.
pub fn set_internal_items(handle: &AppHandle, app: &str, items: Option<AppItems>) {
    if let Some(apps) = handle.try_state::<Apps>() {
        let (status, sections, views) = items.map(|i| (i.status, i.sections, i.views)).unwrap_or_default();
        apps.put_list(app, status, sections, views);
        changed(handle);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Action {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub id: String,
    pub app: String,
    pub title: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    /// "low", "normal" or "high". High opens the island.
    pub importance: String,
    #[serde(default)]
    pub actions: Vec<Action>,
    /// Milliseconds since 1970.
    pub time: u64,
    #[serde(default)]
    pub read: bool,
    /// The action the user pressed, once they have.
    #[serde(default)]
    pub acted: Option<String>,
    /// A built-in's own record of what this stands for (mail/: the
    /// account and the mails). Never set through the API.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
    /// The item of the app's list it is about (a mail): a click on it in the
    /// feed opens the app expanded on that item.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item: Option<String>,
}

/// One row of an app's list: a mail, a draft.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListItem {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub subtitle: Option<String>,
    /// Milliseconds since 1970.
    #[serde(default)]
    pub time: Option<u64>,
    #[serde(default)]
    pub unread: bool,
    /// http:, https: or mailto: only, so opening it reaches a browser or mail and nothing else.
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub actions: Vec<Action>,
    /// A click opens its details in the expanded view (`app_item_detail`):
    /// a mail's whole text. Absent is false.
    #[serde(default, skip_serializing_if = "is_false")]
    pub detail: bool,
    /// The ids of the list's views it shows in; absent: all of them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub views: Option<Vec<String>>,
    /// Who and when ("Ana · 2026-10-17 09:05"): its details pane shows it at
    /// once, before the details came. Set by built-ins (Gmail), not the API.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub byline: Option<String>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// A view of an app's list, a button in the expanded view's left column
/// (Gmail: Inbox, Primary, Unread): only its words, never a count. Choosing
/// one filters the list on the island; nothing is asked of the app.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListView {
    pub id: String,
    pub label: String,
}

/// What a click on an item with `detail` shows: a header (its title, a few
/// lines such as "From …" and the date), its text, the names of its
/// attachments, where it opens, and up to three buttons, which are pressed as
/// the item's own (`app_item_act`).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ItemDetail {
    pub title: String,
    /// One line under the title, always shown (Gmail: the sender's name and
    /// the date). With it, `meta` waits behind the pane's details chevron.
    #[serde(default)]
    pub byline: Option<String>,
    #[serde(default)]
    pub meta: Vec<String>,
    /// Plain text; line breaks are kept, nothing in it is a link.
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub attachments: Vec<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub actions: Vec<Action>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListSection {
    #[serde(default)]
    pub title: Option<String>,
    pub items: Vec<ListItem>,
}

/// What an app has open now, shown when its pill is expanded. Data only: a
/// new list never opens the island.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppItems {
    pub status: Option<String>,
    pub sections: Vec<ListSection>,
    pub updated: u64,
    /// Its views, in order; none: the list is shown whole.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub views: Vec<ListView>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct Saved {
    apps: Vec<AppInfo>,
    notifications: Vec<Notification>,
    next: u64,
    /// Each app's list, by app id. An apps.json from before lists loads without.
    #[serde(default)]
    lists: HashMap<String, AppItems>,
    /// 1 once the built-ins' switches moved here from settings.json (`migrate`).
    /// An apps.json from before the registry reads as 0.
    #[serde(default)]
    registry: u32,
}

/// The registry's version: what `migrate` brings an older apps.json to.
const REGISTRY: u32 = 1;

/// What a built-in's module reports, never saved: it is learned again at
/// every start.
#[derive(Debug, Default, Clone, PartialEq)]
struct Live {
    /// What is wrong now (a failed poll), in the interface language.
    problem: Option<String>,
    /// What it still needs (an English key: "Key not configured").
    note: Option<&'static str>,
    /// It can do nothing yet (Gmail without an account).
    unavailable: bool,
}

/// One app as every screen sees it: what apps.json keeps, and what the
/// registry knows of it now.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppEntry {
    #[serde(flatten)]
    pub info: AppInfo,
    /// Its mark in core/logos.ts (an API app: its id; its own `icon` wins).
    pub logo: String,
    /// Its pill's id on the island.
    pub pill: String,
    /// On the island: not hidden. Its pill shows when it is also `available`.
    pub shown: bool,
    /// May open or peek the island: not muted.
    pub opens_island: bool,
    /// Able to do something yet; false keeps it off the island (Gmail before
    /// its first account) but never out of Settings.
    pub available: bool,
    /// Its setup is done (the key is there, the app it drives is installed).
    pub configured: bool,
    /// What is wrong or missing, in the interface language; None when all is well.
    pub problem: Option<String>,
    /// What its row in Settings needs.
    pub settings: Setup,
}

/// What the island shows: every app, the feed and the apps' lists. The apps
/// come in their one order: the built-ins as BUILTINS lists them, then the
/// apps from the API by name.
#[derive(Debug, Clone, Serialize)]
pub struct Snapshot {
    pub apps: Vec<AppEntry>,
    pub notifications: Vec<Notification>,
    pub lists: HashMap<String, AppItems>,
}

pub struct Apps {
    saved: Mutex<Saved>,
    live: Mutex<HashMap<String, Live>>,
    /// Per app, the item whose details were last shown and their buttons:
    /// those are pressed as the item's own. Never saved.
    opened: Mutex<HashMap<String, (String, Vec<Action>)>>,
    token: String,
    file: PathBuf,
}

/// Puts every built-in in the registry, as a built-in, keeping the user's
/// switches; one that was never there takes its defaults. An API app that
/// had a built-in's id becomes the built-in.
fn ensure_builtins(saved: &mut Saved) {
    for b in BUILTINS {
        match saved.apps.iter_mut().find(|a| a.id == b.id) {
            Some(app) => {
                app.name = b.name.into();
                app.kind = Kind::Builtin;
                app.callback = None;
            }
            None => saved.apps.push(AppInfo {
                id: b.id.into(),
                name: b.name.into(),
                sign: None,
                icon: None,
                callback: None,
                status: None,
                updated: now_ms(),
                muted: false,
                hidden: !b.shown_by_default,
                kind: Kind::Builtin,
            }),
        }
    }
}

/// An apps.json from before the registry: the built-ins' switches were in
/// settings.json (`activeIntegrations`: on the island; `quietApps`: may not
/// open it). They move here once, and settings.json stops keeping them.
/// Gmail's were here already, as were the API apps', and stay as they are;
/// "github" was the notifications' twin of the GitHub pill and now is GitHub
/// itself, with the pill's switches. Returns whether anything moved.
fn migrate(saved: &mut Saved, active: &[String], quiet: &[String]) -> bool {
    if saved.registry >= REGISTRY {
        return false;
    }
    ensure_builtins(saved);
    for b in BUILTINS {
        let Some(legacy) = b.legacy else { continue };
        if let Some(app) = saved.apps.iter_mut().find(|a| a.id == b.id) {
            app.hidden = !active.iter().any(|x| x == legacy);
            app.muted = quiet.iter().any(|x| x == legacy);
        }
    }
    saved.registry = REGISTRY;
    true
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn valid_id(id: &str) -> bool {
    (1..=32).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn valid_sign(sign: &str) -> bool {
    (1..=3).contains(&sign.len()) && sign.bytes().all(|b| b == b'-' || b == b'.')
}

/// Callbacks stay on this computer: an app may not send the island's presses elsewhere.
fn valid_callback(url: &str) -> bool {
    ["http://127.0.0.1:", "http://localhost:", "http://[::1]:"].iter().any(|p| url.starts_with(p)) && url.len() <= 512
}

/// A logo: a PNG or SVG picture as a data: URL, at most 32 KB.
fn valid_icon(url: &str) -> bool {
    url.len() <= 32 * 1024 && (url.starts_with("data:image/png;base64,") || url.starts_with("data:image/svg+xml"))
}

fn clip(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// An optional text of a list: absent or null is none; another type, or more
/// than `max` characters, is refused with the field's name.
fn list_text(value: &Value, field: &str, max: usize) -> Result<Option<String>, String> {
    match value {
        Value::Null => Ok(None),
        Value::String(s) if s.chars().count() <= max => Ok(Some(s.clone())),
        Value::String(_) => Err(format!("{field}: at most {max} characters")),
        _ => Err(format!("{field}: a string")),
    }
}

/// A required text of a list: there, not blank, at most `max` characters.
fn list_name(value: &Value, field: &str, max: usize) -> Result<String, String> {
    list_text(value, field, max)?.filter(|s| !s.trim().is_empty()).ok_or_else(|| format!("{field} is missing"))
}

/// Actions as a list carries them: at most three of `{id, label}`.
fn list_actions(value: &Value, at: &str) -> Result<Vec<Action>, String> {
    match value {
        Value::Null => Ok(Vec::new()),
        Value::Array(list) if list.len() <= MAX_ACTIONS => list
            .iter()
            .enumerate()
            .map(|(k, a)| {
                Ok(Action {
                    id: list_name(&a["id"], &format!("{at}[{k}].id"), 40)?,
                    label: list_name(&a["label"], &format!("{at}[{k}].label"), 24)?,
                })
            })
            .collect(),
        Value::Array(_) => Err(format!("{at}: at most {MAX_ACTIONS}")),
        _ => Err(format!("{at}: a list")),
    }
}

/// A link a row or a detail may open: http:, https: or mailto: only.
fn list_url(value: &Value, at: &str) -> Result<Option<String>, String> {
    let url = list_text(value, at, 1024)?;
    if url.as_deref().is_some_and(|u| !["http://", "https://", "mailto:"].iter().any(|p| u.starts_with(p))) {
        return Err(format!("{at}: http:, https: or mailto: only"));
    }
    Ok(url)
}

/// A list's views: at most six of `{id, label}`, ids unique. A `count` an
/// older app still sends is let be and not shown.
fn list_views(value: &Value) -> Result<Vec<ListView>, String> {
    let list = match value {
        Value::Null => return Ok(Vec::new()),
        Value::Array(list) if list.len() <= MAX_VIEWS => list,
        Value::Array(_) => return Err(format!("views: at most {MAX_VIEWS}")),
        _ => return Err("views: a list".into()),
    };
    let mut out: Vec<ListView> = Vec::new();
    for (i, v) in list.iter().enumerate() {
        let id = list_name(&v["id"], &format!("views[{i}].id"), MAX_VIEW_ID)?;
        if out.iter().any(|o| o.id == id) {
            return Err(format!("views[{i}].id: {id} is used twice"));
        }
        out.push(ListView { id, label: list_name(&v["label"], &format!("views[{i}].label"), MAX_VIEW_LABEL)? });
    }
    Ok(out)
}

fn list_item(item: &Value, at: &str, views: &[ListView]) -> Result<ListItem, String> {
    let url = list_url(&item["url"], &format!("{at}.url"))?;
    let time = match &item["time"] {
        Value::Null => None,
        t => Some(t.as_u64().ok_or_else(|| format!("{at}.time: milliseconds since 1970"))?),
    };
    let unread = match &item["unread"] {
        Value::Null => false,
        u => u.as_bool().ok_or_else(|| format!("{at}.unread: true or false"))?,
    };
    let actions = list_actions(&item["actions"], &format!("{at}.actions"))?;
    let detail = match &item["detail"] {
        Value::Null => false,
        d => d.as_bool().ok_or_else(|| format!("{at}.detail: true or false"))?,
    };
    // The views it is in, each one the list declares.
    let in_views = match &item["views"] {
        Value::Null => None,
        Value::Array(ids) => Some(
            ids.iter()
                .enumerate()
                .map(|(k, id)| {
                    let id = id.as_str().ok_or_else(|| format!("{at}.views[{k}]: a view's id"))?;
                    if !views.iter().any(|v| v.id == id) {
                        return Err(format!("{at}.views[{k}]: the list has no view {id}"));
                    }
                    Ok(id.to_string())
                })
                .collect::<Result<Vec<_>, String>>()?,
        ),
        _ => return Err(format!("{at}.views: a list of view ids")),
    };
    Ok(ListItem {
        id: list_name(&item["id"], &format!("{at}.id"), 64)?,
        title: list_name(&item["title"], &format!("{at}.title"), 200)?,
        subtitle: list_text(&item["subtitle"], &format!("{at}.subtitle"), 300)?,
        time,
        unread,
        url,
        actions,
        detail,
        views: in_views,
        byline: None,
    })
}

/// A list as POST /v1/items gives it, checked whole.
struct Parsed {
    app: String,
    status: Option<String>,
    sections: Vec<ListSection>,
    views: Vec<ListView>,
}

/// A POST /v1/items body, checked whole: the app it is for, its status, views and sections.
fn parse_items(input: &Value) -> Result<Parsed, String> {
    let app = input["app"].as_str().ok_or("app is missing")?.to_string();
    let status = list_text(&input["status"], "status", 120)?.filter(|s| !s.trim().is_empty());
    let views = list_views(&input["views"])?;
    let list = input["sections"].as_array().ok_or("sections: a list of sections (an empty one clears the list)")?;
    if list.len() > MAX_SECTIONS {
        return Err(format!("sections: at most {MAX_SECTIONS}"));
    }
    let mut ids = std::collections::HashSet::new();
    let mut sections = Vec::new();
    for (i, section) in list.iter().enumerate() {
        let at = format!("sections[{i}]");
        let title = list_text(&section["title"], &format!("{at}.title"), 60)?;
        let raw = section["items"].as_array().ok_or_else(|| format!("{at}.items: a list"))?;
        if raw.len() > MAX_ITEMS {
            return Err(format!("{at}.items: at most {MAX_ITEMS}"));
        }
        let mut items = Vec::new();
        for (j, item) in raw.iter().enumerate() {
            let item = list_item(item, &format!("{at}.items[{j}]"), &views)?;
            // A press names only the item, so its id must be one across all sections.
            if !ids.insert(item.id.clone()) {
                return Err(format!("{at}.items[{j}].id: {} is used twice", item.id));
            }
            items.push(item);
        }
        sections.push(ListSection { title, items });
    }
    Ok(Parsed { app, status, sections, views })
}

/// An item's details as an app answered them (`{type: "detail"}` on its
/// callback), checked as a list is: refused past its bounds rather than cut.
fn parse_detail(input: &Value) -> Result<ItemDetail, String> {
    if !input.is_object() {
        return Err("the details: a JSON object".into());
    }
    let texts = |field: &str, max_items: usize, max_chars: usize| -> Result<Vec<String>, String> {
        match &input[field] {
            Value::Null => Ok(Vec::new()),
            Value::Array(list) if list.len() <= max_items => list
                .iter()
                .enumerate()
                .map(|(k, v)| list_name(v, &format!("{field}[{k}]"), max_chars))
                .collect(),
            Value::Array(_) => Err(format!("{field}: at most {max_items}")),
            _ => Err(format!("{field}: a list of strings")),
        }
    };
    Ok(ItemDetail {
        title: list_name(&input["title"], "title", 200)?,
        byline: list_text(&input["byline"], "byline", 200)?.filter(|b| !b.trim().is_empty()),
        meta: texts("meta", MAX_DETAIL_META, 300)?,
        body: list_text(&input["body"], "body", MAX_DETAIL_BODY)?.unwrap_or_default(),
        attachments: texts("attachments", MAX_DETAIL_FILES, 200)?,
        url: list_url(&input["url"], "url")?,
        actions: list_actions(&input["actions"], "actions")?,
    })
}

/// Every app as the screens see it, in the registry's one order: the
/// built-ins as BUILTINS lists them, then the API apps by name.
fn entries(apps: &[AppInfo], live: &HashMap<String, Live>) -> Vec<AppEntry> {
    let none = Live::default();
    let mut out: Vec<AppEntry> = Vec::with_capacity(apps.len());
    for b in BUILTINS {
        let Some(info) = apps.iter().find(|a| a.id == b.id) else { continue };
        let l = live.get(b.id).unwrap_or(&none);
        let problem = if l.unavailable {
            Some(crate::i18n::t(NOT_CONNECTED))
        } else {
            l.note.map(crate::i18n::t).or_else(|| l.problem.clone())
        };
        out.push(AppEntry {
            info: info.clone(),
            logo: b.logo.into(),
            pill: b.pill.into(),
            shown: !info.hidden,
            opens_island: !info.muted,
            available: !l.unavailable,
            configured: l.note.is_none() && !l.unavailable,
            problem,
            settings: b.setup.clone(),
        });
    }
    let mut api: Vec<&AppInfo> = apps.iter().filter(|a| !is_builtin(&a.id)).collect();
    api.sort_by_key(|a| (a.name.to_lowercase(), a.id.clone()));
    for info in api {
        out.push(AppEntry {
            info: info.clone(),
            logo: info.id.clone(),
            pill: api_pill(&info.id),
            shown: !info.hidden,
            opens_island: !info.muted,
            available: true,
            configured: true,
            problem: None,
            settings: Setup::None,
        });
    }
    out
}

fn random_token() -> String {
    use ring::rand::{SecureRandom, SystemRandom};
    let mut bytes = [0u8; 24];
    if SystemRandom::new().fill(&mut bytes).is_err() {
        // No secure random source: the time and process are better than nothing.
        let seed = format!("{}{}", now_ms(), std::process::id());
        bytes[..seed.len().min(24)].copy_from_slice(&seed.as_bytes()[..seed.len().min(24)]);
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl Apps {
    /// apps.json, brought up to date: every built-in there, and (once) their
    /// switches moved from the settings as they were loaded.
    fn load(settings: &settings::Settings) -> Self {
        let dir = settings::local_dir();
        let _ = crate::platform::ensure_private_dir(&dir);
        let file = dir.join("apps.json");
        let saved = std::fs::read_to_string(&file)
            .ok()
            .and_then(|s| serde_json::from_str::<Saved>(&s).ok())
            .unwrap_or_default();
        let (apps, migrated) = Self::from_saved(saved, file, settings);
        if migrated {
            crate::log::line("apps: the built-ins' switches moved from settings.json to apps.json");
        }
        apps
    }

    /// The registry from what apps.json held; true when it was migrated (and saved).
    fn from_saved(mut saved: Saved, file: PathBuf, settings: &settings::Settings) -> (Self, bool) {
        let migrated = migrate(&mut saved, &settings.active_integrations, &settings.quiet_apps);
        ensure_builtins(&mut saved);
        let apps = Self { saved: Mutex::new(saved), live: Mutex::new(HashMap::new()), opened: Mutex::new(HashMap::new()), token: random_token(), file };
        if migrated {
            apps.save(&apps.saved.lock().unwrap());
        }
        (apps, migrated)
    }

    /// Changes what a built-in's module reported; true when that changed anything.
    fn set_live(&self, id: &str, change: impl FnOnce(&mut Live)) -> bool {
        let mut live = self.live.lock().unwrap();
        let entry = live.entry(id.to_string()).or_default();
        let before = entry.clone();
        change(entry);
        *entry != before
    }

    /// On the island: registered and not hidden.
    pub fn shown(&self, id: &str) -> bool {
        self.saved.lock().unwrap().apps.iter().any(|a| a.id == id && !a.hidden)
    }

    fn save(&self, saved: &Saved) {
        if let Ok(text) = serde_json::to_string(saved) {
            let tmp = self.file.with_extension("json.tmp");
            if std::fs::write(&tmp, text).is_ok() {
                let _ = std::fs::rename(&tmp, &self.file);
            }
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        let s = self.saved.lock().unwrap();
        let live = self.live.lock().unwrap();
        Snapshot { apps: entries(&s.apps, &live), notifications: s.notifications.clone(), lists: s.lists.clone() }
    }

    fn change<T>(&self, f: impl FnOnce(&mut Saved) -> T) -> T {
        let mut s = self.saved.lock().unwrap();
        let out = f(&mut s);
        self.save(&s);
        out
    }

    pub fn register(&self, input: &Value) -> Result<AppInfo, String> {
        let id = input["id"].as_str().filter(|id| valid_id(id)).ok_or("id: 1 to 32 of a-z, 0-9 and -")?;
        if is_builtin(id) {
            return Err(format!("id: {id} is winotch's own app"));
        }
        let name = input["name"].as_str().map(|n| clip(n.trim(), 40)).filter(|n| !n.is_empty()).ok_or("name is missing")?;
        let sign = match input["sign"].as_str() {
            Some(s) if valid_sign(s) => Some(s.to_string()),
            Some(_) => return Err("sign: one to three of - and .".into()),
            None => None,
        };
        let callback = match input["callback"].as_str() {
            Some(c) if valid_callback(c) => Some(c.to_string()),
            Some(_) => return Err("callback: an http:// address on 127.0.0.1 or localhost".into()),
            None => None,
        };
        let icon = match input["icon"].as_str() {
            Some(i) if valid_icon(i) => Some(i.to_string()),
            Some(_) => return Err("icon: a data:image/png;base64 or data:image/svg+xml URL, at most 32 KB".into()),
            None => None,
        };
        let status = input["status"].as_str().map(|s| clip(s, 120));
        Ok(self.change(|s| {
            let app = AppInfo {
                id: id.into(), name, sign, icon, callback, status, updated: now_ms(), muted: false, hidden: false,
                kind: Kind::Api,
            };
            match s.apps.iter_mut().find(|a| a.id == id) {
                Some(existing) => {
                    // An update keeps what it does not say again.
                    let keep = existing.clone();
                    *existing = AppInfo {
                        sign: app.sign.or(keep.sign),
                        icon: app.icon.or(keep.icon),
                        callback: app.callback.or(keep.callback),
                        status: app.status.or(keep.status),
                        // The user's choices, never the app's to undo.
                        muted: keep.muted,
                        hidden: keep.hidden,
                        ..app
                    };
                    existing.clone()
                }
                None => {
                    s.apps.push(app.clone());
                    app
                }
            }
        }))
    }

    pub fn set_status(&self, input: &Value) -> Result<(), String> {
        let id = input["app"].as_str().ok_or("app is missing")?;
        let status = input["status"].as_str().map(|s| clip(s, 120));
        self.change(|s| match s.apps.iter_mut().find(|a| a.id == id) {
            Some(app) => {
                app.status = status;
                app.updated = now_ms();
                Ok(())
            }
            None => Err(format!("no app {id}: register it first")),
        })
    }

    pub fn notify(&self, input: &Value) -> Result<Notification, String> {
        let app = input["app"].as_str().ok_or("app is missing")?;
        let title = input["title"].as_str().map(|t| clip(t.trim(), 200)).filter(|t| !t.is_empty()).ok_or("title is missing")?;
        let importance = match input["importance"].as_str().unwrap_or("normal") {
            i @ ("low" | "normal" | "high") => i.to_string(),
            _ => return Err("importance: low, normal or high".into()),
        };
        let mut actions = Vec::new();
        if let Some(list) = input["actions"].as_array() {
            for a in list.iter().take(MAX_ACTIONS) {
                let (Some(id), Some(label)) = (a["id"].as_str(), a["label"].as_str()) else {
                    return Err("each action needs an id and a label".into());
                };
                actions.push(Action { id: clip(id, 32), label: clip(label, 24) });
            }
        }
        let url = input["url"].as_str().filter(|u| u.starts_with("https://") || u.starts_with("http://")).map(|u| clip(u, 1024));
        let body = input["body"].as_str().map(|b| clip(b, 2000));
        let item = list_text(&input["item"], "item", 64)?.filter(|i| !i.trim().is_empty());
        self.push(Notification {
            id: String::new(),
            app: app.into(),
            title,
            body,
            url,
            importance,
            actions,
            time: 0,
            read: false,
            acted: None,
            meta: None,
            item,
        })
    }

    /// Files a new notification: its id and time are given here.
    fn push(&self, mut n: Notification) -> Result<Notification, String> {
        self.change(|s| {
            if !s.apps.iter().any(|a| a.id == n.app) {
                return Err(format!("no app {}: register it first", n.app));
            }
            s.next += 1;
            n.id = format!("{}", s.next);
            n.time = now_ms();
            s.notifications.insert(0, n.clone());
            s.notifications.truncate(KEEP);
            Ok(n)
        })
    }

    // ── Built-ins, from Rust ──────────────────────────────────────────────────

    pub fn post(&self, app: &str, notice: NewNotification) -> Result<Notification, String> {
        self.push(Notification {
            id: String::new(),
            app: app.into(),
            title: clip(notice.title.trim(), 200),
            body: notice.body.map(|b| clip(&b, 2000)),
            url: notice.url.filter(|u| u.starts_with("https://") || u.starts_with("http://")).map(|u| clip(&u, 1024)),
            importance: notice.importance.into(),
            actions: notice.actions.into_iter().take(MAX_ACTIONS).collect(),
            time: 0,
            read: false,
            acted: None,
            meta: notice.meta,
            item: notice.item.filter(|i| !i.is_empty()).map(|i| clip(&i, 64)),
        })
    }

    /// A built-in's list and pill status, as /v1/items would set them,
    /// without its checks: Rust builds it. No sections clears the list.
    pub fn put_list(&self, app: &str, status: Option<String>, sections: Vec<ListSection>, views: Vec<ListView>) {
        self.change(|s| {
            if let Some(info) = s.apps.iter_mut().find(|a| a.id == app) {
                info.status = status.clone();
                info.updated = now_ms();
            }
            if sections.is_empty() {
                s.lists.remove(app);
            } else {
                s.lists.insert(app.into(), AppItems { status, sections, updated: now_ms(), views });
            }
        });
    }

    /// One app's notifications, newest first.
    pub fn notifications_of(&self, app: &str) -> Vec<Notification> {
        self.saved.lock().unwrap().notifications.iter().filter(|n| n.app == app).cloned().collect()
    }

    /// Marks these read and drops those, in one save.
    pub fn read_and_dismiss(&self, read: &[String], dismiss: &[String]) {
        if read.is_empty() && dismiss.is_empty() {
            return;
        }
        self.change(|s| {
            s.notifications.retain(|n| !dismiss.contains(&n.id));
            for n in s.notifications.iter_mut().filter(|n| read.contains(&n.id)) {
                n.read = true;
            }
        });
    }

    /// Sets or clears the pressed action: a press that failed, or one that
    /// only opened a link, leaves the buttons there to press again.
    pub fn set_acted(&self, id: &str, acted: Option<&str>) {
        self.change(|s| {
            if let Some(n) = s.notifications.iter_mut().find(|n| n.id == id) {
                n.acted = acted.map(str::to_string);
            }
        });
    }

    pub fn is_muted(&self, app: &str) -> bool {
        self.saved.lock().unwrap().apps.iter().any(|a| a.id == app && a.muted)
    }

    /// Replaces an app's list; no sections clears it. Errors carry their HTTP
    /// status: 404 for an app that never registered, 400 for a bad list.
    pub fn set_items(&self, input: &Value) -> Result<Option<AppItems>, (u16, String)> {
        let Parsed { app, status, sections, views } = parse_items(input).map_err(|e| (400, e))?;
        self.change(|s| {
            if !s.apps.iter().any(|a| a.id == app) {
                return Err((404, format!("no app {app}: register it first")));
            }
            if sections.is_empty() {
                s.lists.remove(&app);
                return Ok(None);
            }
            let items = AppItems { status, sections, updated: now_ms(), views };
            s.lists.insert(app, items.clone());
            Ok(Some(items))
        })
    }

    pub fn list(&self, query: &HashMap<String, String>) -> Vec<Notification> {
        let s = self.saved.lock().unwrap();
        let limit = query.get("limit").and_then(|l| l.parse().ok()).unwrap_or(50usize).min(KEEP);
        s.notifications
            .iter()
            .filter(|n| query.get("app").is_none_or(|a| &n.app == a))
            .filter(|n| query.get("unread").is_none_or(|u| u != "1" || !n.read))
            .take(limit)
            .cloned()
            .collect()
    }

    /// Marks read: one notification, one app's, or all of them.
    pub fn mark_read(&self, id: Option<&str>, app: Option<&str>) {
        self.change(|s| {
            for n in s.notifications.iter_mut() {
                if id.is_none_or(|id| n.id == id) && app.is_none_or(|a| n.app == a) {
                    n.read = true;
                }
            }
        });
    }

    pub fn set_muted(&self, id: &str, muted: bool) {
        self.change(|s| {
            if let Some(app) = s.apps.iter_mut().find(|a| a.id == id) {
                app.muted = muted;
            }
        });
    }

    pub fn set_hidden(&self, id: &str, hidden: bool) {
        self.change(|s| {
            if let Some(app) = s.apps.iter_mut().find(|a| a.id == id) {
                app.hidden = hidden;
            }
        });
    }

    /// Forgets an app and its notifications. It joins again on its next call.
    /// The built-ins stay: they are turned off, never removed.
    pub fn remove(&self, id: &str) {
        if is_builtin(id) {
            return;
        }
        self.change(|s| {
            s.apps.retain(|a| a.id != id);
            s.notifications.retain(|n| n.app != id);
            s.lists.remove(id);
        });
    }

    pub fn dismiss(&self, id: &str) {
        self.change(|s| s.notifications.retain(|n| n.id != id));
    }

    /// The press of an action: recorded, and where to post it.
    fn act(&self, id: &str, action: &str) -> Result<(Option<String>, Notification), String> {
        self.change(|s| {
            let n = s.notifications.iter_mut().find(|n| n.id == id).ok_or("that notification is gone")?;
            if !n.actions.iter().any(|a| a.id == action) {
                return Err("that notification has no such action".into());
            }
            n.acted = Some(action.into());
            n.read = true;
            let n = n.clone();
            let callback = s.apps.iter().find(|a| a.id == n.app).and_then(|a| a.callback.clone());
            Ok((callback, n))
        })
    }

    /// The press of a list item's action: checked against the list as it is
    /// now, and where to post it. Nothing is recorded; the app sends a new list.
    fn item_act(&self, app: &str, item: &str, action: &str) -> Result<(Option<String>, ListItem), String> {
        let s = self.saved.lock().unwrap();
        let list = s.lists.get(app).ok_or("that app has no list")?;
        let found = list.sections.iter().flat_map(|sec| &sec.items).find(|i| i.id == item).ok_or("that item is gone")?;
        // Its row's buttons, or those of its details while they are shown.
        let in_detail = || {
            self.opened.lock().unwrap().get(app).is_some_and(|(id, actions)| id == item && actions.iter().any(|a| a.id == action))
        };
        if !found.actions.iter().any(|a| a.id == action) && !in_detail() {
            return Err("that item has no such action".into());
        }
        let callback = s.apps.iter().find(|a| a.id == app).and_then(|a| a.callback.clone());
        Ok((callback, found.clone()))
    }

    /// The item whose details are asked for, as the list has it now, and
    /// where to ask: only an item that says it has details.
    fn detail_item(&self, app: &str, item: &str) -> Result<(Option<String>, ListItem), String> {
        let s = self.saved.lock().unwrap();
        let list = s.lists.get(app).ok_or("that app has no list")?;
        let found = list.sections.iter().flat_map(|sec| &sec.items).find(|i| i.id == item).ok_or("that item is gone")?;
        if !found.detail {
            return Err("that item has no details".into());
        }
        let callback = s.apps.iter().find(|a| a.id == app).and_then(|a| a.callback.clone());
        Ok((callback, found.clone()))
    }

    /// The details shown now for an app's item: their buttons may be pressed.
    fn remember_detail(&self, app: &str, item: &str, actions: Vec<Action>) {
        self.opened.lock().unwrap().insert(app.to_string(), (item.to_string(), actions));
    }
}

/// Asks an app for an item's details on its callback and checks the answer.
async fn ask_detail(app_id: &str, callback: &str, body: Value) -> Result<ItemDetail, String> {
    let url = reqwest::Url::parse(callback).map_err(|e| e.to_string())?;
    let client = crate::net::client(&url, Duration::from_secs(10))?;
    let mut response = client
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("{app_id} did not answer: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("{app_id} answered {}", response.status()));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("{app_id} did not answer: {e}"))? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > MAX_DETAIL_ANSWER {
            return Err(format!("{app_id} answered more than {} KB of details", MAX_DETAIL_ANSWER / 1024));
        }
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|e| format!("{app_id} answered no details: {e}"))?;
    parse_detail(&value).map_err(|e| format!("{app_id}'s details: {e}"))
}

/// Posts a press to an app's callback, which registration kept on this computer.
async fn post_press(app_id: &str, callback: &str, body: Value) -> Result<(), String> {
    let url = reqwest::Url::parse(callback).map_err(|e| e.to_string())?;
    let client = crate::net::client(&url, Duration::from_secs(10))?;
    let response = client
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("{app_id} did not answer: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("{app_id} answered {}", response.status()));
    }
    Ok(())
}

/// Tells the island what changed.
pub fn changed(app: &AppHandle) {
    if let Some(apps) = app.try_state::<Apps>() {
        let _ = app.emit("apps", apps.snapshot());
    }
}

/// A new notification reaches the island, unless its app is muted (then it
/// waits in the feed). What it opens is the island's call, by importance.
pub fn announce(app: &AppHandle, n: &Notification) {
    if let Some(apps) = app.try_state::<Apps>() {
        if !apps.is_muted(&n.app) {
            let _ = app.emit_to(WINDOW_LABEL, "notification", n);
        }
    }
}

/// A built-in's press, handled by its module.
async fn internal_press(app: &AppHandle, id: &str, press: Press) -> Result<(), String> {
    let handler = HANDLERS.lock().unwrap().get(id).cloned();
    match handler {
        Some(handler) => handler(app.clone(), press).await,
        None => Err(format!("{id} takes no presses")),
    }
}

/// A built-in's details of one of its items, read by its module.
async fn internal_detail(app: &AppHandle, id: &str, request: DetailRequest) -> Result<ItemDetail, String> {
    let handler = DETAILS.lock().unwrap().get(id).cloned();
    match handler {
        Some(handler) => handler(app.clone(), request).await,
        None => Err(format!("{id} has no details")),
    }
}

// ── The island's side ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn apps_snapshot(apps: tauri::State<Apps>) -> Snapshot {
    apps.snapshot()
}

#[tauri::command]
pub fn notification_read(app: AppHandle, apps: tauri::State<Apps>, id: Option<String>, of_app: Option<String>) {
    apps.mark_read(id.as_deref(), of_app.as_deref());
    changed(&app);
}

#[tauri::command]
pub fn app_set_muted(app: AppHandle, apps: tauri::State<Apps>, id: String, muted: bool) {
    apps.set_muted(&id, muted);
    changed(&app);
}

/// On the island or not. A built-in's poller starts or stops with it.
#[tauri::command]
pub fn app_set_hidden(app: AppHandle, apps: tauri::State<Apps>, id: String, hidden: bool) {
    apps.set_hidden(&id, hidden);
    if is_builtin(&id) {
        crate::integrations::sync(&app);
    }
    changed(&app);
}

/// Settings → Apps opened: what each built-in needs, looked at again.
#[tauri::command]
pub fn apps_refresh_setup(app: AppHandle) {
    refresh_setup(&app);
}

#[tauri::command]
pub fn app_remove(app: AppHandle, apps: tauri::State<Apps>, id: String) {
    apps.remove(&id);
    changed(&app);
}

/// Where the API is, for Settings to show: api.json and the MCP server's command.
#[tauri::command]
pub fn apps_api_file() -> String {
    settings::local_dir().join("api.json").to_string_lossy().into_owned()
}

#[tauri::command]
pub fn notification_dismiss(app: AppHandle, apps: tauri::State<Apps>, id: String) {
    apps.dismiss(&id);
    changed(&app);
}

/// The user pressed one of a notification's actions: the app hears of it.
#[tauri::command]
pub async fn notification_act(app: AppHandle, id: String, action: String) -> Result<(), String> {
    let (callback, n) = app.state::<Apps>().act(&id, &action)?;
    changed(&app);
    if is_builtin(&n.app) {
        let app_id = n.app.clone();
        let result = internal_press(&app, &app_id, Press::Notification { notification: n, action }).await;
        if result.is_err() {
            // Not done: the buttons stay, to try again.
            app.state::<Apps>().set_acted(&id, None);
            changed(&app);
        }
        return result;
    }
    let Some(callback) = callback else { return Ok(()) };
    let body = json!({ "app": n.app, "notification": n.id, "action": action, "title": n.title });
    post_press(&n.app, &callback, body).await
}

/// The user pressed an action on an item of an app's list. `type` tells the
/// app it is not a notification's press, whose body has none.
#[tauri::command]
pub async fn app_item_act(handle: AppHandle, app: String, item: String, action: String) -> Result<(), String> {
    let (callback, found) = handle.state::<Apps>().item_act(&app, &item, &action)?;
    if is_builtin(&app) {
        return internal_press(&handle, &app, Press::Item { item: found, action }).await;
    }
    let Some(callback) = callback else { return Ok(()) };
    let body = json!({ "type": "item", "app": app, "item": found.id, "action": action, "title": found.title });
    post_press(&app, &callback, body).await
}

/// The user clicked an item that has details: a built-in reads them itself
/// (Gmail: the mail, which opening marks read), an API app is asked on its
/// callback with `{type: "detail", app, item}` and answers an `ItemDetail`.
/// Their buttons are then pressed as the item's own (`app_item_act`).
///
/// Each ask is one log line: the app, how it ended and how long it took
/// (never the item or its details).
#[tauri::command]
pub async fn app_item_detail(handle: AppHandle, app: String, item: String) -> Result<ItemDetail, String> {
    let started = std::time::Instant::now();
    let result = item_detail(&handle, &app, &item).await;
    let ms = started.elapsed().as_millis();
    match &result {
        Ok(_) => crate::log::line(format!("apps: {app}'s item details shown ({ms} ms)")),
        Err(_) => crate::log::line(format!("apps: {app}'s item details failed ({ms} ms)")),
    }
    result
}

async fn item_detail(handle: &AppHandle, app: &str, item: &str) -> Result<ItemDetail, String> {
    let (callback, found) = handle.state::<Apps>().detail_item(app, item)?;
    let detail = if is_builtin(app) {
        internal_detail(handle, app, DetailRequest { item: found.clone(), prefetch: false }).await?
    } else {
        let callback = callback.ok_or_else(|| format!("{app} has no callback to ask"))?;
        let body = json!({ "type": "detail", "app": app, "item": found.id });
        ask_detail(app, &callback, body).await?
    };
    handle.state::<Apps>().remember_detail(app, &found.id, detail.actions.clone());
    Ok(detail)
}

/// The pointer rests on a row with details: a built-in may read them ahead
/// (Gmail), so the click finds them there. Answers at once; never marks
/// anything read, never logs. Other apps are not asked.
#[tauri::command]
pub async fn app_item_prefetch(handle: AppHandle, app: String, item: String) -> Result<(), String> {
    if !is_builtin(&app) {
        return Ok(());
    }
    let (_, found) = handle.state::<Apps>().detail_item(&app, &item)?;
    internal_detail(&handle, &app, DetailRequest { item: found, prefetch: true }).await.map(|_| ())
}

// ── The HTTP side ─────────────────────────────────────────────────────────────

struct Request {
    method: String,
    path: String,
    query: HashMap<String, String>,
    token: Option<String>,
    body: Vec<u8>,
}

/// A query's pairs, decoded: `+` is a space and `%XX` a byte, as browsers and
/// URLSearchParams send them (a Gmail search is full of `:` and spaces).
fn parse_query(q: &str) -> HashMap<String, String> {
    q.split('&')
        .filter_map(|pair| pair.split_once('=').or(Some((pair, ""))))
        .filter(|(k, _)| !k.is_empty())
        .map(|(k, v)| (percent_decode(k), percent_decode(v)))
        .collect()
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() + 1 => match (hex(bytes[i + 1]), bytes.get(i + 2).copied().and_then(hex)) {
                (Some(hi), Some(lo)) => {
                    out.push(hi * 16 + lo);
                    i += 2;
                }
                // A lone % stays as it is.
                _ => out.push(b'%'),
            },
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

async fn read_request(stream: &mut TcpStream) -> Result<Request, (u16, String)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        let n = stream.read(&mut chunk).await.map_err(|e| (400, e.to_string()))?;
        if n == 0 {
            return Err((400, "closed".into()));
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        if buf.len() > MAX_HEAD {
            return Err((431, "headers too large".into()));
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let first = lines.next().unwrap_or_default();
    let mut parts = first.split(' ');
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or_default();
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let mut length = 0usize;
    let mut token = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else { continue };
        let value = value.trim();
        match name.trim().to_ascii_lowercase().as_str() {
            "content-length" => length = value.parse().map_err(|_| (400, "bad content-length".to_string()))?,
            "authorization" => token = value.strip_prefix("Bearer ").map(str::to_string),
            _ => {}
        }
    }
    if length > MAX_BODY {
        return Err((413, "body too large".into()));
    }
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < length {
        let n = stream.read(&mut chunk).await.map_err(|e| (400, e.to_string()))?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(length);
    Ok(Request { method, path: path.to_string(), query: parse_query(query), token, body })
}

async fn respond(stream: &mut TcpStream, status: u16, body: &Value) {
    let text = body.to_string();
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        _ => "Error",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        text.len()
    );
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(text.as_bytes()).await;
    let _ = stream.shutdown().await;
}

fn route(app: &AppHandle, req: &Request) -> Result<Value, (u16, String)> {
    let apps = app.state::<Apps>();
    if req.method == "GET" && req.path == "/v1/health" {
        return Ok(json!({ "ok": true, "name": "winotch" }));
    }
    if req.token.as_deref() != Some(apps.token.as_str()) {
        return Err((401, "the token from api.json is missing or wrong".into()));
    }
    let body = || -> Result<Value, (u16, String)> {
        serde_json::from_slice(&req.body).map_err(|e| (400, format!("JSON: {e}")))
    };
    let bad = |e: String| (400, e);
    // winotch's own apps post from Rust only: nobody else may speak as Gmail.
    let posts = matches!(req.path.as_str(), "/v1/status" | "/v1/notify" | "/v1/items");
    if req.method == "POST" && posts {
        if let Some(id) = body()?["app"].as_str().filter(|id| is_builtin(id)) {
            return Err((403, format!("{id} is winotch's own app")));
        }
    }
    match (req.method.as_str(), req.path.as_str()) {
        ("POST", "/v1/apps") => {
            let info = apps.register(&body()?).map_err(bad)?;
            changed(app);
            Ok(json!(info))
        }
        ("GET", "/v1/apps") => Ok(json!(apps.snapshot().apps)),
        ("POST", "/v1/status") => {
            apps.set_status(&body()?).map_err(bad)?;
            changed(app);
            Ok(json!({ "ok": true }))
        }
        ("POST", "/v1/notify") => {
            let n = apps.notify(&body()?).map_err(bad)?;
            changed(app);
            announce(app, &n);
            Ok(json!({ "id": n.id }))
        }
        ("GET", "/v1/notifications") => Ok(json!(apps.list(&req.query))),
        ("POST", "/v1/items") => {
            let list = apps.set_items(&body()?)?;
            // Only "apps", never "notification": a list is data and opens nothing.
            changed(app);
            let count: usize = list.map_or(0, |l| l.sections.iter().map(|s| s.items.len()).sum());
            Ok(json!({ "ok": true, "items": count }))
        }
        ("POST", "/v1/read") => {
            let b = body()?;
            apps.mark_read(b["id"].as_str(), b["app"].as_str());
            changed(app);
            Ok(json!({ "ok": true }))
        }
        // Claude Code's sessions, for the quick question ("open my last
        // my-app session"): listed by folder, opened in the chat or in their
        // terminal, a folder shown in Explorer (hook/src/mcp.rs).
        ("GET", "/v1/sessions") => {
            let folder = req.query.get("folder").map(String::as_str);
            let limit = req.query.get("limit").and_then(|l| l.parse().ok()).unwrap_or(10).clamp(1, 30);
            let live = crate::sessions::live(app);
            let list: Vec<Value> = crate::sessions::recent(folder, limit)
                .into_iter()
                .map(|s| {
                    json!({
                        "id": s.id, "folder": s.project, "title": s.title, "cwd": s.cwd,
                        "updated": s.updated, "openInTerminal": live.contains(&s.id),
                    })
                })
                .collect();
            Ok(json!({ "sessions": list }))
        }
        ("POST", "/v1/sessions/open") => {
            let b = body()?;
            let id = b["id"].as_str().ok_or_else(|| bad("id: the session to open".into()))?;
            let session = crate::sessions::one(id).ok_or((404, format!("no session {id} on this computer")))?;
            match b["in"].as_str().unwrap_or("chat") {
                // The island's chat, on that session (views/chat.ts, island.ts openChatSession).
                "chat" => {
                    let _ = app.emit_to(crate::island::WINDOW_LABEL, "open-chat-session", &session.id);
                    Ok(json!({ "ok": true, "opened": "chat", "folder": session.project, "title": session.title }))
                }
                // Its terminal to the front (or VS Code on its folder), as the finished card's button does.
                "terminal" => {
                    let shown = crate::show_session(Some(session.id.clone()), Some(session.cwd.clone()));
                    Ok(json!({ "ok": shown, "opened": "terminal", "folder": session.project, "title": session.title }))
                }
                other => Err(bad(format!("in: \"chat\" or \"terminal\", not {other:?}"))),
            }
        }
        ("POST", "/v1/folders/open") => {
            let b = body()?;
            let path = b["path"].as_str().map(std::path::Path::new).ok_or_else(|| bad("path: the folder to open".into()))?;
            // A folder, by its full path: never a file (Explorer would run it).
            if !path.is_absolute() || !path.is_dir() {
                return Err(bad(format!("{} is not a folder on this computer", path.display())));
            }
            crate::platform::reveal_folder(&path.to_string_lossy());
            Ok(json!({ "ok": true }))
        }
        _ => Err((404, format!("no {} {}", req.method, req.path))),
    }
}

async fn serve(app: AppHandle, mut stream: TcpStream) {
    let req = match tokio::time::timeout(Duration::from_secs(5), read_request(&mut stream)).await {
        Ok(Ok(req)) => req,
        Ok(Err((status, message))) => return respond(&mut stream, status, &json!({ "error": message })).await,
        Err(_) => return,
    };
    // Mail talks to Gmail, so its calls wait on the network: served apart
    // from the quick ones, with the same token.
    // Today's to-dos and notes: local, quick, the same token (today.rs).
    if req.path.starts_with("/v1/today/") {
        let authorized = req.token.as_deref() == Some(app.state::<Apps>().token.as_str());
        let result = if authorized {
            crate::today::route(&app, &req.method, &req.path, &req.query, &req.body)
        } else {
            Err((401, "the token from api.json is missing or wrong".into()))
        };
        return match result {
            Ok(body) => respond(&mut stream, 200, &body).await,
            Err((status, message)) => respond(&mut stream, status, &json!({ "error": message })).await,
        };
    }
    if req.path.starts_with("/v1/mail/") {
        let authorized = req.token.as_deref() == Some(app.state::<Apps>().token.as_str());
        let result = if authorized {
            crate::mail::route(&app, &req.method, &req.path, &req.query, &req.body).await
        } else {
            Err((401, "the token from api.json is missing or wrong".into()))
        };
        return match result {
            Ok(body) => respond(&mut stream, 200, &body).await,
            Err((status, message)) => respond(&mut stream, status, &json!({ "error": message })).await,
        };
    }
    match route(&app, &req) {
        Ok(body) => respond(&mut stream, 200, &body).await,
        Err((status, message)) => respond(&mut stream, status, &json!({ "error": message })).await,
    }
}

/// Starts the API, and writes where it is and its token to api.json, readable
/// by this user only, for apps (and the MCP server) to find.
pub fn start(app: &AppHandle) {
    // The settings as they were loaded: an apps.json from before the registry
    // takes the built-ins' switches from them (`migrate`).
    let settings = app
        .try_state::<crate::Shared>()
        .map(|shared| shared.settings.lock().unwrap().clone())
        .unwrap_or_else(settings::load);
    app.manage(Apps::load(&settings));
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::bind(("127.0.0.1", PORT)).await {
            Ok(l) => l,
            Err(_) => match TcpListener::bind(("127.0.0.1", 0)).await {
                Ok(l) => l,
                Err(e) => {
                    crate::log::line(format!("apps: no port for the API: {e}"));
                    return;
                }
            },
        };
        let port = listener.local_addr().map(|a| a.port()).unwrap_or(PORT);
        let token = handle.state::<Apps>().token.clone();
        let info = json!({ "url": format!("http://127.0.0.1:{port}"), "token": token });
        let path = settings::local_dir().join("api.json");
        if let Err(e) = std::fs::write(&path, info.to_string()) {
            crate::log::line(format!("apps: could not write api.json: {e}"));
        }
        crate::log::line(format!("apps: API on 127.0.0.1:{port}"));
        loop {
            let Ok((stream, peer)) = listener.accept().await else {
                // An error that persists (out of handles) would otherwise spin a core.
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            };
            if !peer.ip().is_loopback() {
                continue;
            }
            tauri::async_runtime::spawn(serve(handle.clone(), stream));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with(mut saved: Saved) -> Apps {
        ensure_builtins(&mut saved);
        // The test registries of a run share one file in the temp folder; the
        // files earlier runs left there go the first time (one was left per run).
        static SWEEP: std::sync::Once = std::sync::Once::new();
        SWEEP.call_once(|| {
            let mine = format!("winotch-apps-test-{}.json", std::process::id());
            for entry in std::fs::read_dir(std::env::temp_dir()).into_iter().flatten().flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("winotch-apps-test") && name.ends_with(".json") && name != mine {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        });
        Apps {
            saved: Mutex::new(saved),
            live: Mutex::new(HashMap::new()),
            opened: Mutex::new(HashMap::new()),
            token: "t".into(),
            file: std::env::temp_dir().join(format!("winotch-apps-test-{}.json", std::process::id())),
        }
    }

    /// The registry as it is at start: the built-ins, nothing else yet.
    fn apps() -> Apps {
        with(Saved { registry: REGISTRY, ..Saved::default() })
    }

    fn entry(snap: &Snapshot, id: &str) -> AppEntry {
        snap.apps.iter().find(|a| a.info.id == id).cloned().unwrap_or_else(|| panic!("no {id}"))
    }

    #[test]
    fn an_app_registers_then_notifies_and_its_feed_reads_newest_first() {
        let a = apps();
        assert!(a.notify(&json!({ "app": "gtm", "title": "x" })).is_err(), "unknown app");
        a.register(&json!({ "id": "gtm", "name": "gtm.js", "sign": "--.", "callback": "http://127.0.0.1:5/act" })).unwrap();
        let first = a.notify(&json!({ "app": "gtm", "title": "Draft 1" })).unwrap();
        let second = a.notify(&json!({ "app": "gtm", "title": "Draft 2", "importance": "high",
            "actions": [{ "id": "approve", "label": "Approve" }] })).unwrap();
        let feed = a.list(&HashMap::new());
        assert_eq!(feed.iter().map(|n| n.id.clone()).collect::<Vec<_>>(), vec![second.id.clone(), first.id.clone()]);
        assert_eq!(feed[0].actions[0].label, "Approve");
    }

    #[test]
    fn what_comes_in_is_checked() {
        let a = apps();
        assert!(a.register(&json!({ "id": "Bad Id", "name": "x" })).is_err());
        assert!(a.register(&json!({ "id": "ok", "name": "x", "sign": "---." })).is_err(), "four parts");
        assert!(a.register(&json!({ "id": "ok", "name": "x", "callback": "https://example.com/hook" })).is_err(), "off this computer");
        assert!(a.register(&json!({ "id": "ok", "name": "x", "icon": "https://example.com/logo.png" })).is_err(), "a picture, not a link");
        assert!(a.register(&json!({ "id": "ok", "name": "x", "icon": "data:image/png;base64,iVBOR" })).is_ok());
        a.register(&json!({ "id": "ok", "name": "x" })).unwrap();
        assert!(a.notify(&json!({ "app": "ok", "title": "t", "importance": "urgent" })).is_err());
    }

    #[test]
    fn reading_and_pressing() {
        let a = apps();
        a.register(&json!({ "id": "mail", "name": "Mail" })).unwrap();
        let n = a.notify(&json!({ "app": "mail", "title": "Hi", "actions": [{ "id": "reply", "label": "Reply" }] })).unwrap();
        let unread = |a: &Apps| a.list(&HashMap::from([("unread".to_string(), "1".to_string())])).len();
        assert_eq!(unread(&a), 1);
        assert!(a.act(&n.id, "delete").is_err(), "not one of its actions");
        let (callback, done) = a.act(&n.id, "reply").unwrap();
        assert_eq!(callback, None);
        assert_eq!(done.acted.as_deref(), Some("reply"));
        assert_eq!(unread(&a), 0);
    }

    #[test]
    fn an_update_keeps_what_it_does_not_repeat() {
        let a = apps();
        a.register(&json!({ "id": "gtm", "name": "gtm.js", "sign": "--.", "callback": "http://localhost:7/x" })).unwrap();
        let again = a.register(&json!({ "id": "gtm", "name": "gtm.js", "status": "3 drafts" })).unwrap();
        assert_eq!(again.sign.as_deref(), Some("--."));
        assert_eq!(again.callback.as_deref(), Some("http://localhost:7/x"));
        assert_eq!(again.status.as_deref(), Some("3 drafts"));
    }

    #[test]
    fn hidden_and_muted_are_the_users_and_survive_a_new_registration() {
        let a = apps();
        a.register(&json!({ "id": "gtm", "name": "gtm.js" })).unwrap();
        a.set_hidden("gtm", true);
        a.set_muted("gtm", true);
        let again = a.register(&json!({ "id": "gtm", "name": "gtm.js", "status": "ready" })).unwrap();
        assert!(again.hidden && again.muted);
        a.set_hidden("gtm", false);
        assert!(entry(&a.snapshot(), "gtm").shown);
        // An apps.json from before the flag loads, with the app shown.
        let old: AppInfo = serde_json::from_value(json!({ "id": "x", "name": "X", "muted": true })).unwrap();
        assert!(!old.hidden && old.muted);
    }

    fn item(id: &str) -> Value {
        json!({ "id": id, "title": format!("Draft {id}"), "actions": [{ "id": format!("posted:{id}"), "label": "Posted" }] })
    }

    fn items(app: &str, list: Vec<Value>) -> Value {
        json!({ "app": app, "status": "drafts waiting", "sections": [{ "title": "Drafts", "items": list }] })
    }

    #[test]
    fn a_list_is_for_a_registered_app_and_replaces_the_last_one() {
        let a = apps();
        assert_eq!(a.set_items(&items("gtm", vec![item("1")])).unwrap_err().0, 404, "unknown app");
        a.register(&json!({ "id": "gtm", "name": "gtm.js" })).unwrap();
        a.set_items(&items("gtm", vec![item("1"), item("2")])).unwrap();
        let list = a.set_items(&items("gtm", vec![item("3")])).unwrap().unwrap();
        assert!(list.updated > 0);
        let snap = a.snapshot();
        let ids: Vec<_> = snap.lists["gtm"].sections[0].items.iter().map(|i| i.id.clone()).collect();
        assert_eq!(ids, vec!["3"]);
        assert_eq!(snap.lists["gtm"].status.as_deref(), Some("drafts waiting"));
        // As the island reads it: camelCase, absent fields null.
        let sent = serde_json::to_value(&snap).unwrap();
        assert_eq!(sent["lists"]["gtm"]["sections"][0]["items"][0]["subtitle"], Value::Null);
        assert_eq!(sent["lists"]["gtm"]["sections"][0]["title"], "Drafts");
        // No sections clears it.
        assert_eq!(a.set_items(&json!({ "app": "gtm", "sections": [] })).unwrap(), None);
        assert!(a.snapshot().lists.is_empty());
    }

    #[test]
    fn a_list_may_declare_views_and_items_with_details_within_bounds() {
        let a = apps();
        a.register(&json!({ "id": "mail", "name": "Mail", "callback": "http://127.0.0.1:5/act" })).unwrap();
        let views = json!([{ "id": "all", "label": "All", "count": 3 }, { "id": "starred", "label": "Starred" }]);
        let body = json!({ "app": "mail", "views": views, "sections": [{ "title": "Work", "items": [
            { "id": "1", "title": "One", "detail": true, "views": ["all", "starred"] },
            { "id": "2", "title": "Two" },
        ] }] });
        let list = a.set_items(&body).unwrap().unwrap();
        assert_eq!(list.views, vec![
            ListView { id: "all".into(), label: "All".into() },
            ListView { id: "starred".into(), label: "Starred".into() },
        ]);
        let [one, two] = &list.sections[0].items[..] else { panic!() };
        assert!(one.detail && !two.detail);
        assert_eq!(one.views.as_deref(), Some(&["all".to_string(), "starred".to_string()][..]));
        assert_eq!(two.views, None, "absent: in every view");
        // On the wire, additive: an item without them carries neither, a list without views has none.
        let sent = serde_json::to_value(a.snapshot()).unwrap();
        let wire = &sent["lists"]["mail"];
        assert_eq!(wire["views"], json!([{ "id": "all", "label": "All" }, { "id": "starred", "label": "Starred" }]), "a count sent is not shown");
        assert_eq!(wire["sections"][0]["items"][0]["detail"], true);
        assert!(wire["sections"][0]["items"][1].get("detail").is_none() && wire["sections"][0]["items"][1].get("views").is_none());
        a.set_items(&items("mail", vec![item("1")])).unwrap();
        assert!(serde_json::to_value(a.snapshot()).unwrap()["lists"]["mail"].get("views").is_none());
        // An older list (apps.json) loads without either.
        let old: AppItems = serde_json::from_value(json!({ "status": null, "updated": 1, "sections": [{ "items": [{ "id": "1", "title": "t" }] }] })).unwrap();
        assert!(old.views.is_empty() && !old.sections[0].items[0].detail);

        let refused = |views: Value, item: Value| {
            let (status, message) = a.set_items(&json!({ "app": "mail", "views": views, "sections": [{ "items": [item] }] })).map(|_| ()).unwrap_err();
            assert_eq!(status, 400, "{message}");
            message
        };
        let ok = json!({ "id": "1", "title": "t" });
        let view = |id: &str| json!({ "id": id, "label": "L" });
        assert!(refused(json!((0..7).map(|i| view(&i.to_string())).collect::<Vec<_>>()), ok.clone()).contains("at most 6"));
        assert!(a.set_items(&json!({ "app": "mail", "views": (0..6).map(|i| view(&i.to_string())).collect::<Vec<_>>(), "sections": [] })).is_ok(), "six fit");
        assert!(refused(json!([view(&"x".repeat(25))]), ok.clone()).contains("views[0].id"));
        assert!(refused(json!([{ "id": "a", "label": "x".repeat(21) }]), ok.clone()).contains("views[0].label"));
        assert!(refused(json!([{ "id": "a", "label": "" }]), ok.clone()).contains("label is missing"));
        assert!(refused(json!([view("a"), view("a")]), ok.clone()).contains("used twice"));
        assert!(a.set_items(&json!({ "app": "mail", "views": [{ "id": "a", "label": "A", "count": -1 }], "sections": [] })).is_ok(), "an old app's count is no error");
        assert!(refused(json!({ "id": "a" }), ok.clone()).contains("views: a list"));
        assert!(refused(json!([view("a")]), json!({ "id": "1", "title": "t", "views": ["b"] })).contains("no view b"));
        assert!(refused(Value::Null, json!({ "id": "1", "title": "t", "views": ["a"] })).contains("no view a"), "no views declared");
        assert!(refused(json!([view("a")]), json!({ "id": "1", "title": "t", "views": "a" })).contains("views"));
        assert!(refused(Value::Null, json!({ "id": "1", "title": "t", "detail": "yes" })).contains("detail"));
    }

    #[test]
    fn details_answered_by_an_app_are_checked_like_a_list() {
        let good = json!({
            "title": "Lunch", "meta": ["From Ana <ana@example.com>", "2026-10-17 09:05"], "body": "Hi\n\nthere",
            "attachments": ["a.pdf"], "url": "https://example.com/m/1", "actions": [{ "id": "reply", "label": "Reply" }],
        });
        let d = parse_detail(&good).unwrap();
        assert_eq!(d.title, "Lunch");
        assert_eq!(d.meta.len(), 2);
        assert_eq!(d.body, "Hi\n\nthere");
        assert_eq!(d.actions[0].id, "reply");
        // Only a title is needed.
        assert_eq!(parse_detail(&json!({ "title": "t" })).unwrap(), ItemDetail { title: "t".into(), ..Default::default() });
        let bad = |field: &str, value: Value| {
            let mut d = good.clone();
            d[field] = value;
            parse_detail(&d).unwrap_err()
        };
        assert!(parse_detail(&json!([1])).unwrap_err().contains("object"));
        assert!(bad("title", json!("")).contains("title is missing"));
        assert!(bad("title", json!("x".repeat(201))).contains("title"));
        assert!(bad("body", json!("x".repeat(MAX_DETAIL_BODY + 1))).contains("body"));
        assert!(parse_detail(&json!({ "title": "t", "body": "x".repeat(MAX_DETAIL_BODY) })).is_ok());
        assert!(bad("meta", json!(vec!["m"; 9])).contains("at most 8"));
        assert!(bad("meta", json!(["x".repeat(301)])).contains("meta[0]"));
        assert!(bad("meta", json!("From me")).contains("meta"));
        assert!(bad("attachments", json!(vec!["a"; 21])).contains("at most 20"));
        assert!(bad("url", json!("javascript:alert(1)")).contains("http:, https: or mailto:"));
        assert!(bad("actions", json!(vec![json!({ "id": "a", "label": "A" }); 4])).contains("at most 3"));
        assert!(bad("actions", json!([{ "id": "a", "label": "x".repeat(25) }])).contains("actions[0].label"));
    }

    #[test]
    fn details_are_only_for_items_that_have_them_and_their_buttons_press_as_the_items() {
        let a = apps();
        a.register(&json!({ "id": "mail", "name": "Mail", "callback": "http://127.0.0.1:5/act" })).unwrap();
        a.set_items(&json!({ "app": "mail", "sections": [{ "items": [
            { "id": "1", "title": "One", "detail": true, "actions": [{ "id": "read", "label": "Mark read" }] },
            { "id": "2", "title": "Two" },
        ] }] })).unwrap();
        assert!(a.detail_item("mail", "2").unwrap_err().contains("no details"));
        assert!(a.detail_item("mail", "3").unwrap_err().contains("gone"));
        assert!(a.detail_item("other", "1").is_err());
        let (callback, found) = a.detail_item("mail", "1").unwrap();
        assert_eq!(callback.as_deref(), Some("http://127.0.0.1:5/act"));
        assert_eq!(found.title, "One");
        // Before the details are shown their buttons are no buttons of the item.
        assert!(a.item_act("mail", "1", "reply").is_err());
        a.remember_detail("mail", "1", vec![Action { id: "reply".into(), label: "Reply".into() }]);
        assert!(a.item_act("mail", "1", "reply").is_ok());
        assert!(a.item_act("mail", "1", "read").is_ok(), "the row's own still press");
        assert!(a.item_act("mail", "2", "reply").is_err(), "another item's details");
        // Another item's details replace them.
        a.remember_detail("mail", "2", Vec::new());
        assert!(a.item_act("mail", "1", "reply").is_err());
    }

    #[test]
    fn a_notification_may_name_the_item_it_is_about() {
        let a = apps();
        a.register(&json!({ "id": "mail", "name": "Mail" })).unwrap();
        let n = a.notify(&json!({ "app": "mail", "title": "New mail", "item": "m-42" })).unwrap();
        assert_eq!(n.item.as_deref(), Some("m-42"));
        assert_eq!(serde_json::to_value(&n).unwrap()["item"], "m-42");
        let plain = a.notify(&json!({ "app": "mail", "title": "Hello" })).unwrap();
        assert_eq!(plain.item, None);
        assert!(serde_json::to_value(&plain).unwrap().get("item").is_none(), "absent stays absent");
        assert_eq!(a.notify(&json!({ "app": "mail", "title": "t", "item": " " })).unwrap().item, None, "blank is none");
        assert!(a.notify(&json!({ "app": "mail", "title": "t", "item": "x".repeat(65) })).unwrap_err().contains("item"));
        assert!(a.notify(&json!({ "app": "mail", "title": "t", "item": 42 })).unwrap_err().contains("item"));
        // An older apps.json loads without it.
        let old: Notification = serde_json::from_value(json!({ "id": "1", "app": "x", "title": "t", "importance": "low", "time": 1 })).unwrap();
        assert_eq!(old.item, None);
    }

    #[test]
    fn a_list_past_its_bounds_or_with_a_strange_link_is_refused() {
        let a = apps();
        a.register(&json!({ "id": "gtm", "name": "gtm.js" })).unwrap();
        let refused = |body: Value| a.set_items(&body).map(|_| ()).unwrap_err();
        let bad = |field: &str, value: Value| {
            let mut i = item("1");
            i[field] = value;
            let (status, message) = refused(items("gtm", vec![i]));
            assert_eq!(status, 400, "{message}");
            message
        };
        assert_eq!(refused(json!({ "app": "gtm" })).0, 400, "sections missing");
        assert_eq!(refused(json!({ "app": "gtm", "sections": vec![json!({ "items": [] }); 6] })).0, 400);
        assert_eq!(refused(items("gtm", (0..51).map(|i| item(&i.to_string())).collect())).0, 400);
        assert!(a.set_items(&items("gtm", (0..50).map(|i| item(&i.to_string())).collect())).is_ok(), "fifty fit");
        assert!(refused(items("gtm", vec![item("1"), item("1")])).1.contains("used twice"));
        assert!(refused(json!({ "app": "gtm", "sections": [{ "items": [item("1")] }, { "items": [item("1")] }] })).1.contains("used twice"));
        assert!(refused(json!({ "app": "gtm", "status": "x".repeat(121), "sections": [] })).1.starts_with("status"));
        assert!(refused(json!({ "app": "gtm", "sections": [{ "title": "x".repeat(61), "items": [] }] })).1.contains("title"));
        assert!(bad("title", json!("")).contains("title is missing"));
        assert!(bad("title", json!("x".repeat(201))).contains("at most 200"));
        assert!(bad("subtitle", json!("x".repeat(301))).contains("subtitle"));
        assert!(bad("id", json!("x".repeat(65))).contains("id"));
        assert!(bad("time", json!("yesterday")).contains("time"));
        assert!(bad("unread", json!("yes")).contains("unread"));
        assert!(bad("url", json!("javascript:alert(1)")).contains("http:, https: or mailto:"));
        assert!(bad("url", json!("file:///C:/x")).contains("url"));
        assert!(bad("actions", json!([{ "id": "a", "label": "A" }, { "id": "b", "label": "B" }, { "id": "c", "label": "C" }, { "id": "d", "label": "D" }])).contains("at most 3"));
        assert!(bad("actions", json!([{ "id": "x".repeat(41), "label": "A" }])).contains("actions[0].id"));
        assert!(bad("actions", json!([{ "id": "a", "label": "x".repeat(25) }])).contains("actions[0].label"));
        for url in ["https://x.com/a", "http://localhost:3000", "mailto:a@b.c"] {
            let mut i = item("1");
            i["url"] = json!(url);
            assert!(a.set_items(&items("gtm", vec![i])).is_ok(), "{url}");
        }
        // A refused list leaves the last good one in place.
        assert_eq!(a.snapshot().lists["gtm"].sections[0].items.len(), 1);
    }

    #[test]
    fn removing_an_app_drops_its_list_and_old_files_load_without_lists() {
        let a = apps();
        a.register(&json!({ "id": "gtm", "name": "gtm.js" })).unwrap();
        a.set_items(&items("gtm", vec![item("1")])).unwrap();
        a.remove("gtm");
        assert!(a.snapshot().lists.is_empty());
        let old: Saved = serde_json::from_value(json!({ "apps": [], "notifications": [], "next": 4 })).unwrap();
        assert!(old.lists.is_empty());
    }

    #[test]
    fn pressing_an_item_needs_the_item_and_its_action() {
        let a = apps();
        a.register(&json!({ "id": "gtm", "name": "gtm.js", "callback": "http://127.0.0.1:5/act" })).unwrap();
        assert!(a.item_act("gtm", "1", "posted:1").is_err(), "no list yet");
        a.set_items(&items("gtm", vec![item("1")])).unwrap();
        assert!(a.item_act("gtm", "2", "posted:2").unwrap_err().contains("gone"));
        assert!(a.item_act("gtm", "1", "drop:1").unwrap_err().contains("no such action"));
        assert!(a.item_act("other", "1", "posted:1").is_err());
        let (callback, found) = a.item_act("gtm", "1", "posted:1").unwrap();
        assert_eq!(callback.as_deref(), Some("http://127.0.0.1:5/act"));
        assert_eq!(found.title, "Draft 1");
    }

    #[test]
    fn winotchs_own_apps_cannot_be_taken_over_or_removed_from_outside() {
        let a = apps();
        for b in BUILTINS {
            assert!(a.register(&json!({ "id": b.id, "name": "Fake" })).unwrap_err().contains("winotch's own"), "{}", b.id);
        }
        // "claude" is what Claude Code posts through MCP: an API app, not reserved.
        assert!(a.register(&json!({ "id": "claude", "name": "Claude" })).is_ok());
        a.remove("gmail");
        a.remove("github");
        let snap = a.snapshot();
        let gmail = entry(&snap, "gmail");
        assert_eq!(gmail.info.kind, Kind::Builtin, "Settings' Remove leaves it");
        assert!(gmail.info.callback.is_none());
        assert!(snap.apps.iter().any(|e| e.info.id == "github"));
        // An apps.json from before kinds loads as an API app (the built-ins are set again at start).
        let old: AppInfo = serde_json::from_value(json!({ "id": "x", "name": "X", "internal": true, "twin": "integration_github" })).unwrap();
        assert_eq!(old.kind, Kind::Api);
    }

    #[test]
    fn an_internal_app_posts_with_its_meta_lists_and_keeps_the_bell_in_step() {
        let a = apps();
        let notice = |title: &str| NewNotification {
            title: title.into(),
            body: Some("b".into()),
            url: Some("javascript:alert(1)".into()),
            importance: "low",
            actions: vec![Action { id: "read".into(), label: "Mark read".into() }],
            meta: Some(json!({ "kind": "mail", "uids": [3] })),
            item: Some("me@gmail.com:3eb".into()),
        };
        let one = a.post("gmail", notice("One")).unwrap();
        let two = a.post("gmail", notice("Two")).unwrap();
        assert_eq!(one.url, None, "only http(s) links");
        assert_eq!(one.importance, "low");
        assert_eq!(a.notifications_of("gmail")[0].meta.as_ref().unwrap()["uids"], json!([3]));
        assert_eq!(one.item.as_deref(), Some("me@gmail.com:3eb"), "the item it is about");
        // The meta goes to apps.json, and an older file loads without it.
        let saved = serde_json::to_value(a.snapshot().notifications[0].clone()).unwrap();
        assert_eq!(saved["meta"]["kind"], "mail");
        let old: Notification = serde_json::from_value(json!({ "id": "1", "app": "x", "title": "t", "importance": "low", "time": 1 })).unwrap();
        assert!(old.meta.is_none());
        assert!(serde_json::to_value(&old).unwrap().get("meta").is_none());

        a.read_and_dismiss(&[one.id.clone()], &[two.id.clone()]);
        let left = a.notifications_of("gmail");
        assert_eq!(left.len(), 1);
        assert!(left[0].read);
        a.set_acted(&one.id, Some("open"));
        a.set_acted(&one.id, None);
        assert_eq!(a.notifications_of("gmail")[0].acted, None);

        let row = ListItem { id: "me@gmail.com:3eb".into(), title: "x".repeat(250), unread: true, ..Default::default() };
        a.put_list("gmail", Some("1 unread".into()), vec![ListSection { title: Some("Work".into()), items: vec![row] }], Vec::new());
        let snap = a.snapshot();
        assert_eq!(snap.lists["gmail"].status.as_deref(), Some("1 unread"));
        assert_eq!(entry(&snap, "gmail").info.status.as_deref(), Some("1 unread"), "the pill says it too");
        a.put_list("gmail", None, Vec::new(), Vec::new());
        assert!(a.snapshot().lists.is_empty());
    }

    #[test]
    fn the_built_ins_are_always_there_in_their_order_then_the_api_apps_by_name() {
        let a = apps();
        a.register(&json!({ "id": "zed", "name": "Zed" })).unwrap();
        a.register(&json!({ "id": "gtm", "name": "gtm.js" })).unwrap();
        a.register(&json!({ "id": "claude", "name": "Claude" })).unwrap();
        let snap = a.snapshot();
        let ids: Vec<&str> = snap.apps.iter().map(|e| e.info.id.as_str()).collect();
        assert_eq!(ids, ["github", "stripe", "notion", "spotify", "gmail", "today", "claude", "gtm", "zed"]);
        let kinds: Vec<Kind> = snap.apps.iter().map(|e| e.info.kind).collect();
        assert_eq!(&kinds[..6], [Kind::Builtin; 6]);
        assert!(kinds[6..].iter().all(|k| *k == Kind::Api));
        // Each one's pill: the four that had one keep its id; Claude's posts are Claude Code's.
        let pills: Vec<&str> = snap.apps.iter().map(|e| e.pill.as_str()).collect();
        assert_eq!(pills, [
            "integration_github", "integration_stripe", "integration_notion", "integration_spotify",
            "app_gmail", "app_today", MAIN_PILL, "app_gtm", "app_zed",
        ]);
        let logos: Vec<&str> = snap.apps.iter().map(|e| e.logo.as_str()).collect();
        assert_eq!(logos, ["github", "stripe", "notion", "spotify", "gmail", "today", "claude", "gtm", "zed"]);
        // A fresh install: GitHub, Gmail and Today on, the rest off; all may open the island.
        let shown: Vec<bool> = snap.apps[..6].iter().map(|e| e.shown).collect();
        assert_eq!(shown, [true, false, false, false, true, true]);
        assert!(snap.apps.iter().all(|e| e.opens_island && e.available && e.configured && e.problem.is_none()));
        // A new API app is in the very next snapshot, and in /v1/apps' answer.
        a.register(&json!({ "id": "abc", "name": "Abc" })).unwrap();
        let sent = serde_json::to_value(a.snapshot().apps).unwrap();
        assert_eq!(sent[6]["id"], "abc");
        assert_eq!(sent[6]["kind"], "api");
        assert_eq!(sent[6]["settings"], json!({ "kind": "none" }));
        assert_eq!(sent[5]["shown"], true);
        assert_eq!(sent[5]["opensIsland"], true);
        // What outside apps read before is still there.
        assert_eq!(sent[5]["hidden"], false);
        assert_eq!(sent[5]["muted"], false);
    }

    #[test]
    fn each_app_declares_what_its_settings_row_needs() {
        let sent = serde_json::to_value(apps().snapshot().apps).unwrap();
        let setup = |i: usize| sent[i]["settings"].clone();
        assert_eq!(setup(0), json!({
            "kind": "signIn",
            "modes": ["cli", "token"],
            "key": {
                "secret": "github-token", "label": "Token", "placeholder": "ghp_…",
                "hint": "Classic token with the repo scope, or fine-grained with read access to Pull requests, Commit statuses and Actions.",
            },
        }));
        assert_eq!(setup(1), json!({ "kind": "key", "secret": "stripe-api-key", "label": "Secret key", "placeholder": "sk_live_…", "hint": null }));
        assert_eq!(setup(2), json!({ "kind": "key", "secret": "notion-api-key", "label": "Integration token", "placeholder": "ntn_…", "hint": null }));
        assert_eq!(setup(3), json!({ "kind": "none" }));
        assert_eq!(setup(4), json!({ "kind": "accounts" }));
        assert_eq!(sent[0]["kind"], "builtin");
    }

    #[test]
    fn what_a_built_in_reports_shows_in_its_entry_and_is_never_saved() {
        let a = apps();
        assert!(a.set_live("stripe", |l| l.problem = Some("Invalid API key (401)".into())));
        assert!(!a.set_live("stripe", |l| l.problem = Some("Invalid API key (401)".into())), "the same again changes nothing");
        a.set_live("notion", |l| l.note = Some(KEY_MISSING));
        a.set_live("gmail", |l| l.unavailable = true);
        let snap = a.snapshot();
        let stripe = entry(&snap, "stripe");
        assert_eq!(stripe.problem.as_deref(), Some("Invalid API key (401)"));
        assert!(stripe.configured && stripe.available);
        let notion = entry(&snap, "notion");
        assert_eq!(notion.problem.as_deref(), Some("Key not configured"));
        assert!(!notion.configured);
        // Gmail with no account: in the list, said so, no pill.
        let gmail = entry(&snap, "gmail");
        assert!(!gmail.available && gmail.shown && !gmail.configured);
        assert_eq!(gmail.problem.as_deref(), Some("Not connected"));
        // A key missing wins over an old error.
        a.set_live("stripe", |l| l.note = Some(KEY_MISSING));
        assert_eq!(entry(&a.snapshot(), "stripe").problem.as_deref(), Some("Key not configured"));
        let saved = serde_json::to_value(a.saved.lock().unwrap().clone()).unwrap();
        assert!(!saved.to_string().contains("Invalid API key"));
    }

    #[test]
    fn shown_and_quiet_are_kept_for_every_app_built_in_or_not() {
        let file = std::env::temp_dir().join(format!("winotch-apps-persist-{}.json", std::process::id()));
        let a = Apps { file: file.clone(), ..apps() };
        a.register(&json!({ "id": "gtm", "name": "gtm.js" })).unwrap();
        a.set_hidden("stripe", false);
        a.set_muted("stripe", true);
        a.set_hidden("github", true);
        a.set_muted("gtm", true);
        assert!(a.shown("stripe") && a.is_muted("stripe") && !a.shown("github"));
        // The next start reads them back, whatever the old settings say: the move is done once.
        let saved: Saved = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        let old = settings::Settings { active_integrations: vec!["integration_github".into()], ..settings::Settings::default() };
        let (b, migrated) = Apps::from_saved(saved, file.clone(), &old);
        assert!(!migrated);
        let snap = b.snapshot();
        assert!(entry(&snap, "stripe").shown && !entry(&snap, "stripe").opens_island);
        assert!(!entry(&snap, "github").shown);
        assert!(!entry(&snap, "gtm").opens_island);
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn an_old_settings_json_and_apps_json_move_to_the_registry_and_lose_nothing() {
        // settings.json as the last build before the registry wrote it.
        let settings: settings::Settings = serde_json::from_str(r#"{
            "activeIntegrations": ["integration_notion", "integration_spotify", "agent_cursor"],
            "quietApps": ["integration_spotify", "integration_github"],
            "githubAuth": "cli",
            "gmailAccounts": [{ "email": "me@gmail.com", "label": "Work", "opensIsland": false }]
        }"#).unwrap();
        // And its apps.json: an API app muted, Gmail hidden, GitHub's
        // notifications as the pill's twin, Claude's MCP posts, a list, the feed.
        let saved: Saved = serde_json::from_str(r#"{
            "apps": [
                { "id": "gtm", "name": "gtm.js", "sign": "--.", "callback": "http://127.0.0.1:5/act", "status": "3 drafts", "updated": 5, "muted": true, "hidden": false },
                { "id": "gmail", "name": "Gmail", "updated": 6, "muted": false, "hidden": true, "internal": true },
                { "id": "github", "name": "GitHub", "updated": 7, "muted": false, "hidden": false, "internal": true, "twin": "integration_github" },
                { "id": "claude", "name": "Claude", "updated": 8, "muted": false, "hidden": false }
            ],
            "notifications": [
                { "id": "2", "app": "github", "title": "Review requested", "importance": "normal", "time": 10, "meta": { "threads": [] } },
                { "id": "1", "app": "gtm", "title": "Draft", "importance": "high", "time": 9, "actions": [{ "id": "posted", "label": "Posted" }], "acted": "posted", "read": true }
            ],
            "next": 2,
            "lists": { "gtm": { "status": "1 draft", "sections": [{ "title": "Drafts", "items": [{ "id": "a", "title": "A" }] }], "updated": 11 } }
        }"#).unwrap();
        assert_eq!(saved.registry, 0);
        let file = std::env::temp_dir().join(format!("winotch-apps-migrate-{}.json", std::process::id()));
        let (a, migrated) = Apps::from_saved(saved, file.clone(), &settings);
        assert!(migrated);
        let snap = a.snapshot();
        let switches = |id: &str| {
            let e = entry(&snap, id);
            (e.shown, e.opens_island)
        };
        // The built-ins take their switches from the settings…
        assert_eq!(switches("github"), (false, false), "not in activeIntegrations, in quietApps");
        assert_eq!(switches("stripe"), (false, true));
        assert_eq!(switches("notion"), (true, true));
        assert_eq!(switches("spotify"), (true, false));
        // …Gmail and the API apps keep theirs.
        assert_eq!(switches("gmail"), (false, true));
        assert_eq!(switches("gtm"), (true, false));
        assert_eq!(switches("claude"), (true, true));
        // GitHub is one app now, a built-in, and the notifications are its own.
        let github = entry(&snap, "github");
        assert_eq!((github.info.kind, github.pill.as_str()), (Kind::Builtin, "integration_github"));
        assert_eq!(snap.apps.iter().filter(|e| e.pill == "integration_github").count(), 1);
        let feed: Vec<(&str, &str)> = snap.notifications.iter().map(|n| (n.id.as_str(), n.app.as_str())).collect();
        assert_eq!(feed, [("2", "github"), ("1", "gtm")]);
        assert_eq!(snap.notifications[1].acted.as_deref(), Some("posted"));
        assert!(snap.notifications[0].meta.is_some());
        // Nothing else of the API apps is lost.
        let gtm = entry(&snap, "gtm");
        assert_eq!(
            (gtm.info.sign.as_deref(), gtm.info.callback.as_deref(), gtm.info.status.as_deref()),
            (Some("--."), Some("http://127.0.0.1:5/act"), Some("3 drafts")),
        );
        assert_eq!(snap.lists["gtm"].sections[0].items[0].id, "a");
        // Saved at once, as done: the next start does not move them again.
        let again: Saved = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(again.registry, REGISTRY);
        assert_eq!(again.next, 2);
        let (b, migrated) = Apps::from_saved(again, file.clone(), &settings::Settings::default());
        assert!(!migrated);
        assert!(entry(&b.snapshot(), "notion").shown);
        assert!(!entry(&b.snapshot(), "github").shown, "the defaults do not undo it");
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn a_fresh_install_starts_with_the_old_defaults() {
        // No apps.json, no settings.json: GitHub on, as activeIntegrations' default had it; Gmail and Today too.
        let file = std::env::temp_dir().join(format!("winotch-apps-fresh-{}.json", std::process::id()));
        let (a, migrated) = Apps::from_saved(Saved::default(), file.clone(), &settings::Settings::default());
        assert!(migrated);
        let snap = a.snapshot();
        let on: Vec<&str> = snap.apps.iter().filter(|e| e.shown).map(|e| e.info.id.as_str()).collect();
        assert_eq!(on, ["github", "gmail", "today"]);
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn a_new_built_in_joins_an_install_from_before_it_switched_on_and_keeps_its_id() {
        // An apps.json from before Today was a built-in: Today joins, on.
        let a = with(Saved { registry: REGISTRY, ..Saved::default() });
        let today = entry(&a.snapshot(), "today");
        assert!(today.shown && today.opens_island && today.configured);
        assert_eq!((today.pill.as_str(), today.logo.as_str(), today.info.kind), ("app_today", "today", Kind::Builtin));
        assert_eq!(serde_json::to_value(&today.settings).unwrap(), json!({ "kind": "none" }));
        assert!(a.register(&json!({ "id": "today", "name": "Fake" })).is_err(), "nobody else takes its id");
    }

    #[test]
    fn a_query_is_percent_decoded() {
        let q = parse_query("q=from%3Aana+is%3Aunread&account=me%2Bwork%40gmail.com&x=100%&e=%C3%A9&flag");
        assert_eq!(q["q"], "from:ana is:unread");
        assert_eq!(q["account"], "me+work@gmail.com");
        assert_eq!(q["x"], "100%");
        assert_eq!(q["e"], "é");
        assert_eq!(q["flag"], "");
    }
}
