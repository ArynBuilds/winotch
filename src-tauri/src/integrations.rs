// Integration pollers — the Rust side of StripePoller / GithubPoller /
// NotionPoller.
//
// Same endpoints, same first-run delays and intervals as the Swift pollers. Each
// one emits an `integration` event; the island owns the badge, the sound and the
// 60 s auto-clear, exactly as the Swift handlers do.
//
// A poller only runs while its app is switched on (shown, in the registry:
// apps.rs), nothing is polled until its key exists in the Credential Manager,
// and no request goes anywhere the user has not configured. Each update is
// keyed by the app's registry id ("github"); what goes wrong is also the app's
// status line in the registry (apps::set_problem), for Settings and the cards.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

use crate::github::{self, GitHubActivity, GitHubPulse};
use crate::island::WINDOW_LABEL;
use crate::log;
use crate::secrets;

const TIMEOUT: Duration = Duration::from_secs(10);

/// What the island receives. `event` is only set when something actually changed,
/// which is what drives the pill badge and the sound.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationUpdate {
    pub id: &'static str,
    pub data: Value,
    pub error: Option<String>,
    pub event: Option<IntegrationEvent>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationEvent {
    pub success: bool,
    pub label: String,
    pub detail: Option<String>,
}

fn emit(app: &AppHandle, update: IntegrationUpdate) {
    // The registry's status line follows: an error is the app's problem, data
    // means it works again. GitHub's three loops report together (emit_github),
    // so only its stats poll speaks for it there.
    if update.error.is_some() || update.id != GITHUB_ID {
        crate::apps::set_problem(app, update.id, update.error.clone());
    }
    let _ = app.emit_to(WINDOW_LABEL, "integration", update);
}

/// One client for every poller: it keeps its connections (and TLS sessions)
/// open between polls instead of setting them up again each time.
static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .unwrap_or_default()
});

pub(crate) fn client() -> &'static reqwest::Client {
    &HTTP
}

/// Set from the tray's Pause item. While it is on, nothing reaches the network:
/// pausing winotch has to mean pausing winotch, not just hiding the island.
pub static PAUSED: AtomicBool = AtomicBool::new(false);

pub fn set_paused(on: bool) {
    PAUSED.store(on, Ordering::Relaxed);
}

/// The built-ins that have pollers, by registry id (apps.rs BUILTINS).
const STRIPE_ID: &str = "stripe";
const NOTION_ID: &str = "notion";
const POLLED: [&str; 3] = [STRIPE_ID, GITHUB_ID, NOTION_ID];

/// The tasks polling for each integration that is switched on.
static RUNNING: LazyLock<Mutex<HashMap<&'static str, Vec<JoinHandle<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// At launch and whenever an app is switched on or off (apps.rs): starts the
/// pollers of the built-ins switched on, stops those of the ones switched off,
/// and Spotify's listener with them.
pub fn sync(app: &AppHandle) {
    crate::spotify::sync(app, enabled(app, crate::spotify::APP_ID));
    let mut running = RUNNING.lock().unwrap();
    for id in POLLED {
        let on = enabled(app, id);
        if on && !running.contains_key(id) {
            running.insert(id, start_polling(app, id));
        } else if !on {
            if let Some(tasks) = running.remove(id) {
                tasks.iter().for_each(JoinHandle::abort);
                // Off: what went wrong while it ran is no longer news.
                crate::apps::set_problem(app, id, None);
            }
            if id == GITHUB_ID {
                github_stopped(app);
            }
        }
    }
}

/// Spawns the poller(s) of `id` with the macOS delays and intervals.
fn start_polling(app: &AppHandle, id: &'static str) -> Vec<JoinHandle<()>> {
    let app = app.clone();
    match id {
        STRIPE_ID => vec![spawn(app, id, 6, 30, poll_stripe)],
        GITHUB_ID => {
            let mut tasks = spawn_github_loops(app.clone());
            tasks.push(crate::github_notify::spawn(app.clone()));
            tasks.push(spawn(app, id, 7, 300, poll_github));
            tasks
        }
        NOTION_ID => vec![spawn(app, id, 9, 300, poll_notion)],
        _ => Vec::new(),
    }
}

/// True when the user has this built-in switched on (Settings → Apps).
pub(crate) fn enabled(app: &AppHandle, id: &str) -> bool {
    crate::apps::is_shown(app, id)
}

fn spawn<F, Fut>(app: AppHandle, id: &'static str, delay_secs: u64, every_secs: u64, poll: F) -> JoinHandle<()>
where
    F: Fn(AppHandle) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send,
{
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(delay_secs)).await;
        let mut ticker = tokio::time::interval(Duration::from_secs(every_secs));
        loop {
            ticker.tick().await;
            // The ticker keeps its cadence; we just decline to do the work. A
            // paused app, or an integration switched off a moment ago, must
            // make no network calls at all — CLAUDE.md allows talking only to
            // services the user configured, and a disabled one is not configured.
            if PAUSED.load(Ordering::Relaxed) || !enabled(&app, id) {
                continue;
            }
            poll(app.clone()).await;
        }
    })
}

/// One-shot refresh from the Refresh buttons in the island, by registry id.
pub async fn poll_once(app: AppHandle, id: &str) {
    match id {
        STRIPE_ID => poll_stripe(app).await,
        GITHUB_ID => {
            wake_github_pulse();
            github_refresh_if_stale("activity");
            poll_github(app).await
        }
        NOTION_ID => poll_notion(app).await,
        _ => {}
    }
}

/// Remembers the newest id per integration so an event fires once, not on every poll.
struct Seen(Mutex<HashMap<&'static str, String>>);

static SEEN: LazyLock<Seen> = LazyLock::new(|| Seen(Mutex::new(HashMap::new())));

/// Returns true the first time a given id is seen (and false on the very first
/// load, which only fills the card).
fn is_new(key: &'static str, id: &str) -> bool {
    let mut map = SEEN.0.lock().unwrap();
    match map.insert(key, id.to_string()) {
        Some(previous) => previous != id,
        None => false, // first poll: populate silently, like the Swift pollers
    }
}

/// The card's error line, in the interface language (i18n.rs);
/// `unauthorised_hint` comes translated.
fn status_error(code: u16, unauthorised_hint: &str) -> String {
    match code {
        401 => crate::i18n::t("Invalid API key (401)"),
        403 => unauthorised_hint.to_string(),
        _ => crate::i18n::tf("API error {code}", &[("code", &code.to_string())]),
    }
}

// ── Stripe ────────────────────────────────────────────────────────────────────

async fn poll_stripe(app: AppHandle) {
    let Some(key) = secrets::get("stripe-api-key") else { return };
    let auth = format!("Basic {}", crate::claude::base64_for(format!("{key}:").as_bytes()));
    let http = client();

    let balance = http
        .get("https://api.stripe.com/v1/balance")
        .header("Authorization", &auth)
        .send()
        .await;

    let (amount, currency) = match balance {
        Ok(r) if r.status().is_success() => {
            let json: Value = r.json().await.unwrap_or(json!({}));
            let mut buckets: Vec<Value> = Vec::new();
            for k in ["available", "pending"] {
                if let Some(arr) = json.get(k).and_then(Value::as_array) {
                    buckets.extend(arr.iter().cloned());
                }
            }
            let currency = buckets
                .first()
                .and_then(|b| b.get("currency"))
                .and_then(Value::as_str)
                .unwrap_or("eur")
                .to_string();
            let amount: i64 = buckets
                .iter()
                .filter_map(|b| b.get("amount").and_then(Value::as_i64))
                .sum();
            (amount, currency)
        }
        Ok(r) => {
            let code = r.status().as_u16();
            emit(&app, IntegrationUpdate {
                id: STRIPE_ID,
                data: json!({}),
                error: Some(status_error(code, &crate::i18n::t("Use a secret key (sk_live_… not pk_live_…)"))),
                event: None,
            });
            return;
        }
        Err(e) => {
            emit(&app, IntegrationUpdate {
                id: STRIPE_ID,
                data: json!({}),
                error: Some(crate::i18n::tf("No connection: {error}", &[("error", &e.to_string())])),
                event: None,
            });
            return;
        }
    };

    let charges = http
        .get("https://api.stripe.com/v1/charges?limit=15")
        .header("Authorization", &auth)
        .send()
        .await;
    let Ok(response) = charges else { return };
    if !response.status().is_success() {
        return;
    }
    let json: Value = response.json().await.unwrap_or(json!({}));
    let payments: Vec<Value> = json
        .get("data")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|c| {
                    let description = c
                        .get("description")
                        .and_then(Value::as_str)
                        .or_else(|| {
                            c.get("billing_details")
                                .and_then(|b| b.get("name"))
                                .and_then(Value::as_str)
                        })
                        .map(str::to_string);
                    Some(json!({
                        "id": c.get("id")?.as_str()?,
                        "amount": c.get("amount")?.as_i64()?,
                        "currency": c.get("currency")?.as_str()?,
                        "description": description,
                        "createdAt": c.get("created").and_then(Value::as_i64).unwrap_or(0) * 1000,
                        "status": c.get("status").and_then(Value::as_str).unwrap_or("succeeded"),
                    }))
                })
                .collect()
        })
        .unwrap_or_default();

    let newest = payments
        .first()
        .and_then(|p| p.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let event = if !newest.is_empty() && is_new("stripe", &newest) {
        let label = payments[0]
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| {
                let cents = payments[0].get("amount").and_then(Value::as_i64).unwrap_or(0);
                format!("{:.2}", cents as f64 / 100.0)
            });
        Some(IntegrationEvent { success: true, label, detail: None })
    } else {
        None
    };

    emit(&app, IntegrationUpdate {
        id: STRIPE_ID,
        data: json!({ "balance": amount, "currency": currency, "payments": payments }),
        error: None,
        event,
    });
}

// ── GitHub ────────────────────────────────────────────────────────────────────

/// The token for a GitHub poll cycle (github_auth.rs): the CLI's or the stored
/// one. In CLI mode a signed-out CLI shows on the card; with no token at all
/// nothing is polled, as before.
async fn github_token(app: &AppHandle, show_error: bool) -> Option<String> {
    match crate::github_auth::token(app).await {
        Ok(token) => Some(token),
        Err(crate::github_auth::AuthError::Cli(e)) => {
            if show_error {
                emit(app, IntegrationUpdate { id: GITHUB_ID, data: json!({}), error: Some(e.message()), event: None });
            }
            None
        }
        Err(crate::github_auth::AuthError::NoToken) => {
            if show_error {
                // Neither the CLI nor a saved token: say so in its status line.
                crate::apps::set_problem(app, GITHUB_ID, Some(crate::i18n::t("Key not configured")));
            }
            None
        }
    }
}

async fn poll_github(app: AppHandle) {
    let Some(token) = github_token(&app, true).await else { return };
    let http = client();

    let user = http
        .get("https://api.github.com/user")
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "winotch")
        .send()
        .await;
    let Ok(response) = user else { return };
    if !response.status().is_success() {
        emit(&app, IntegrationUpdate {
            id: GITHUB_ID,
            data: json!({}),
            error: Some(status_error(response.status().as_u16(), &crate::i18n::t("Token lacks the needed scope"))),
            event: None,
        });
        return;
    }
    let json: Value = response.json().await.unwrap_or(json!({}));
    let public = json.get("public_repos").and_then(Value::as_i64).unwrap_or(0);
    let private = json
        .get("owned_private_repos")
        .or_else(|| json.get("total_private_repos"))
        .and_then(Value::as_i64)
        .unwrap_or(0);

    let repos = http
        .get("https://api.github.com/user/repos?per_page=100&affiliation=owner&sort=pushed")
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "winotch")
        .send()
        .await;
    let stars: i64 = match repos {
        Ok(r) if r.status().is_success() => r
            .json::<Value>()
            .await
            .ok()
            .and_then(|v| v.as_array().cloned())
            .map(|list| {
                list.iter()
                    .filter_map(|r| r.get("stargazers_count").and_then(Value::as_i64))
                    .sum()
            })
            .unwrap_or(0),
        _ => 0,
    };

    GITHUB.cache.lock().unwrap().stats = Some((public + private, stars));
    // Signed in and answered: whatever was wrong is over.
    crate::apps::set_problem(&app, GITHUB_ID, None);
    emit_github(&app);
}

// ── GitHub pulse and activity (GithubPoller.swift) ────────────────────────────
//
// Two more loops next to the stats above, with the Mac cadence: the pulse (my
// pull requests and their CI, reviews waiting for me, default-branch CI) 10 s
// after launch, then every 60 s while some CI is running and every 5 min
// otherwise; the contribution calendar 15 s after launch, then every 30 min.
// Neither touches the network while the pill is off or winotch is paused, and
// the island wakes them when the card is opened on stale data.
//
// All three results are kept here and always sent together, so one poll never
// wipes what another one reported.

const GITHUB_ID: &str = "github";

#[derive(Default)]
struct GitHubCache {
    /// (repositories, stars)
    stats: Option<(i64, i64)>,
    pulse: Option<GitHubPulse>,
    activity: Option<GitHubActivity>,
    /// The unread threads of GitHub's inbox (github_notify.rs).
    notifications: Option<Value>,
}

struct GitHubLoops {
    cache: Mutex<GitHubCache>,
    /// Bumped when the token changes: a response for the old token is dropped.
    generation: AtomicU64,
    pulse_wake: Notify,
    activity_wake: Notify,
    pulse_busy: AtomicBool,
    activity_busy: AtomicBool,
}

static GITHUB: LazyLock<GitHubLoops> = LazyLock::new(|| GitHubLoops {
    cache: Mutex::new(GitHubCache::default()),
    generation: AtomicU64::new(0),
    pulse_wake: Notify::new(),
    activity_wake: Notify::new(),
    pulse_busy: AtomicBool::new(false),
    activity_busy: AtomicBool::new(false),
});

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// What the island's GitHub card receives: whichever of the three is known.
fn github_card_data(cache: &GitHubCache) -> Value {
    let mut data = serde_json::Map::new();
    if let Some((repos, stars)) = cache.stats {
        data.insert("totalRepos".into(), json!(repos));
        data.insert("totalStars".into(), json!(stars));
    }
    if let Some(pulse) = &cache.pulse {
        data.insert("pulse".into(), serde_json::to_value(pulse).unwrap_or(Value::Null));
    }
    if let Some(activity) = &cache.activity {
        data.insert("activity".into(), serde_json::to_value(activity).unwrap_or(Value::Null));
    }
    if let Some(notifications) = cache.notifications.as_ref().filter(|n| n.is_array()) {
        data.insert("notifications".into(), notifications.clone());
    }
    Value::Object(data)
}

fn emit_github(app: &AppHandle) {
    let data = github_card_data(&GITHUB.cache.lock().unwrap());
    emit(app, IntegrationUpdate { id: GITHUB_ID, data, error: None, event: None });
}

fn spawn_github_loops(app: AppHandle) -> Vec<JoinHandle<()>> {
    let pulse_app = app.clone();
    let pulse = tauri::async_runtime::spawn(async move {
        let mut wait = Duration::from_secs(10);
        loop {
            // Sleeps for `wait`, or less when the island asks for fresh data.
            let _ = tokio::time::timeout(wait, GITHUB.pulse_wake.notified()).await;
            let pending = run_github_pulse(&pulse_app).await;
            wait = Duration::from_secs(if pending { 60 } else { 300 });
        }
    });
    let activity = tauri::async_runtime::spawn(async move {
        let mut wait = Duration::from_secs(15);
        loop {
            let _ = tokio::time::timeout(wait, GITHUB.activity_wake.notified()).await;
            run_github_activity(&app).await;
            wait = Duration::from_secs(1800);
        }
    });
    vec![pulse, activity]
}

/// One authenticated GraphQL call. Partial errors are logged (as a count) and the
/// data parsed anyway; only a response without `data` is dropped.
async fn github_graphql(token: &str, query: &str, what: &str) -> Option<Value> {
    let response = client()
        .post("https://api.github.com/graphql")
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .header("User-Agent", "winotch")
        .json(&json!({ "query": query }))
        .send()
        .await;
    let Ok(response) = response else {
        log::line(format!("github {what}: no connection"));
        return None;
    };
    if !response.status().is_success() {
        log::line(format!("github {what} HTTP {}", response.status().as_u16()));
        return None;
    }
    let root: Value = response.json().await.ok()?;
    let errors = github::graphql_error_count(&root);
    if errors > 0 {
        log::line(format!("github {what} GraphQL errors: {errors}"));
    }
    root.get("data").filter(|d| d.is_object())?;
    Some(root)
}

/// Returns whether some CI is still running, which sets the next interval.
async fn run_github_pulse(app: &AppHandle) -> bool {
    if PAUSED.load(Ordering::Relaxed) || !enabled(app, GITHUB_ID) {
        return false;
    }
    let Some(token) = github_token(app, false).await else { return false };
    let generation = GITHUB.generation.load(Ordering::SeqCst);
    GITHUB.pulse_busy.store(true, Ordering::SeqCst);
    let root = github_graphql(&token, github::PULSE_QUERY, "pulse").await;
    GITHUB.pulse_busy.store(false, Ordering::SeqCst);
    let Some(pulse) = root.and_then(|r| GitHubPulse::parse(&r, now_ms())) else { return false };
    let pending = pulse.has_pending();

    let events = {
        let mut cache = GITHUB.cache.lock().unwrap();
        // The token changed while this was in flight: it answers for someone else.
        if GITHUB.generation.load(Ordering::SeqCst) != generation {
            return pending;
        }
        let events = GitHubPulse::events(cache.pulse.as_ref(), &pulse);
        cache.pulse = Some(pulse);
        events
    };
    emit_github(app);
    if !events.is_empty() {
        let _ = app.emit_to(WINDOW_LABEL, "github-alerts", &events);
    }
    pending
}

async fn run_github_activity(app: &AppHandle) {
    if PAUSED.load(Ordering::Relaxed) || !enabled(app, GITHUB_ID) {
        return;
    }
    let Some(token) = github_token(app, false).await else { return };
    let generation = GITHUB.generation.load(Ordering::SeqCst);
    GITHUB.activity_busy.store(true, Ordering::SeqCst);
    let root = github_graphql(&token, github::ACTIVITY_QUERY, "activity").await;
    GITHUB.activity_busy.store(false, Ordering::SeqCst);
    let Some(activity) = root.and_then(|r| GitHubActivity::parse(&r, now_ms())) else { return };
    {
        let mut cache = GITHUB.cache.lock().unwrap();
        if GITHUB.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        cache.activity = Some(activity);
    }
    emit_github(app);
}

pub(crate) fn wake_github_pulse() {
    if !GITHUB.pulse_busy.load(Ordering::SeqCst) {
        GITHUB.pulse_wake.notify_one();
    }
}

/// The card was opened: fetch now if what it shows is older than the Mac's
/// limits (1 min for the pulse, 5 min for the activity grid). No-op while a
/// request is already in flight.
pub fn github_refresh_if_stale(section: &str) {
    let now = now_ms();
    let cache = GITHUB.cache.lock().unwrap();
    match section {
        "pulse" => {
            let fetched = cache.pulse.as_ref().map(|p| p.fetched_at);
            if !GITHUB.pulse_busy.load(Ordering::SeqCst) && github::is_stale(fetched, now, 60) {
                GITHUB.pulse_wake.notify_one();
            }
        }
        "activity" => {
            let fetched = cache.activity.as_ref().map(|a| a.fetched_at);
            if !GITHUB.activity_busy.load(Ordering::SeqCst) && github::is_stale(fetched, now, 300) {
                GITHUB.activity_wake.notify_one();
            }
        }
        _ => {}
    }
}

/// The GitHub token was saved or removed, or the sign-in mode changed: forget
/// what the old one fetched, drop its requests still in flight, and fetch
/// again right away.
pub fn github_token_changed(app: &AppHandle) {
    crate::github_auth::forget_identity();
    forget_github_account(app);
    // In token mode only the stored token counts; the CLI is asked at the poll.
    let has_token = crate::github_auth::mode(app) != crate::github_auth::Mode::Token || secrets::present("github-token");
    if !has_token {
        GITHUB.cache.lock().unwrap().stats = None;
    }
    emit_github(app);
    GITHUB.pulse_wake.notify_one();
    GITHUB.activity_wake.notify_one();
    if has_token && !PAUSED.load(Ordering::Relaxed) && enabled(app, GITHUB_ID) {
        tauri::async_runtime::spawn(poll_github(app.clone()));
    }
}

/// What one account fetched is dropped, with its requests in flight; its
/// inbox's backlog will not ping for the next one.
fn forget_github_account(app: &AppHandle) {
    GITHUB.generation.fetch_add(1, Ordering::SeqCst);
    {
        let mut cache = GITHUB.cache.lock().unwrap();
        cache.pulse = None;
        cache.activity = None;
        cache.notifications = None;
    }
    crate::github_notify::reset();
    emit_github(app);
}

/// A poll cycle found another account than the last one (`gh auth switch`, a
/// logout): start over for it. The cycle that noticed carries on with it.
pub(crate) fn github_identity_changed(app: &AppHandle) {
    forget_github_account(app);
    GITHUB.cache.lock().unwrap().stats = None;
    emit_github(app);
    GITHUB.pulse_wake.notify_one();
    GITHUB.activity_wake.notify_one();
}

/// The inbox's unread threads, for the card and the expanded view.
pub(crate) fn set_github_notifications(app: &AppHandle, threads: Value) {
    GITHUB.cache.lock().unwrap().notifications = threads.is_array().then_some(threads);
    emit_github(app);
}

/// Switching the pill off forgets the pulse, so switching it back on starts
/// silent instead of alerting on everything that changed in between.
fn github_stopped(app: &AppHandle) {
    // A loop stopped mid-request never clears its flag itself.
    GITHUB.pulse_busy.store(false, Ordering::SeqCst);
    GITHUB.activity_busy.store(false, Ordering::SeqCst);
    crate::github_notify::stopped();
    let had_data = {
        let mut cache = GITHUB.cache.lock().unwrap();
        let had = cache.pulse.is_some() || cache.activity.is_some() || cache.notifications.is_some();
        cache.pulse = None;
        cache.activity = None;
        cache.notifications = None;
        had
    };
    if had_data {
        emit_github(app);
    }
}

// ── Notion ────────────────────────────────────────────────────────────────────

async fn poll_notion(app: AppHandle) {
    let Some(token) = secrets::get("notion-api-key") else { return };
    let response = client()
        .post("https://api.notion.com/v1/search")
        .header("Authorization", format!("Bearer {token}"))
        .header("Notion-Version", "2022-06-28")
        .header("Content-Type", "application/json")
        .json(&json!({
            "sort": { "direction": "descending", "timestamp": "last_edited_time" },
            "page_size": 15
        }))
        .send()
        .await;
    let Ok(response) = response else { return };
    if !response.status().is_success() {
        emit(&app, IntegrationUpdate {
            id: NOTION_ID,
            data: json!({}),
            error: Some(status_error(response.status().as_u16(), &crate::i18n::t("Integration lacks access"))),
            event: None,
        });
        return;
    }
    let json: Value = response.json().await.unwrap_or(json!({}));
    let pages: Vec<Value> = json
        .get("results")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(parse_notion_page).collect())
        .unwrap_or_default();

    emit(&app, IntegrationUpdate {
        id: NOTION_ID,
        data: json!({ "pages": pages }),
        error: None,
        event: None,
    });
}

fn parse_notion_page(obj: &Value) -> Option<Value> {
    let id = obj.get("id")?.as_str()?;
    let is_database = obj.get("object").and_then(Value::as_str) == Some("database");

    let mut title = "Untitled".to_string();
    if is_database {
        if let Some(text) = obj
            .get("title")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(|t| t.get("plain_text"))
            .and_then(Value::as_str)
        {
            if !text.is_empty() {
                title = text.to_string();
            }
        }
    } else if let Some(props) = obj.get("properties").and_then(Value::as_object) {
        for prop in props.values() {
            if prop.get("type").and_then(Value::as_str) != Some("title") {
                continue;
            }
            if let Some(text) = prop
                .get("title")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(|t| t.get("plain_text"))
                .and_then(Value::as_str)
            {
                if !text.is_empty() {
                    title = text.to_string();
                    break;
                }
            }
        }
    }

    let emoji = obj
        .get("icon")
        .filter(|i| i.get("type").and_then(Value::as_str) == Some("emoji"))
        .and_then(|i| i.get("emoji"))
        .and_then(Value::as_str);

    Some(json!({
        "id": id,
        "title": title,
        "emoji": emoji,
        "lastEditedAt": obj.get("last_edited_time").and_then(Value::as_str)?,
        "url": obj.get("url").and_then(Value::as_str).unwrap_or("https://notion.so"),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_card_data_sends_only_what_is_known() {
        let mut cache = GitHubCache::default();
        assert_eq!(github_card_data(&cache), json!({}));
        cache.stats = Some((12, 3400));
        assert_eq!(github_card_data(&cache), json!({ "totalRepos": 12, "totalStars": 3400 }));
        cache.activity = Some(GitHubActivity { total: 5, weeks: vec![], fetched_at: 9 });
        let data = github_card_data(&cache);
        assert_eq!(data["totalRepos"], json!(12));
        assert_eq!(data["activity"], json!({ "total": 5, "weeks": [], "fetchedAt": 9 }));
        assert!(data.get("pulse").is_none());
        assert!(data.get("notifications").is_none());
        cache.notifications = Some(json!([{ "id": "1" }]));
        assert_eq!(github_card_data(&cache)["notifications"], json!([{ "id": "1" }]));
        cache.notifications = Some(json!({ "not": "a list" }));
        assert!(github_card_data(&cache).get("notifications").is_none());
    }
}
