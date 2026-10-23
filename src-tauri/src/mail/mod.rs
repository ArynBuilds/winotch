// Gmail (WINOTCH.md "Gmail"): every account the user added, over IMAP and
// SMTP with a Google app password. Gmail is a built-in of the app registry
// (apps.rs): its inbox is its list on the island, new mail rings the bell, and
// the bell follows Gmail (read there, read here; archived there, gone here).
//
// One watcher task per account keeps a connection in IDLE and looks at the
// inbox again whenever Gmail says something changed (and every 10 minutes, as
// IDLE must be renewed). Presses (Mark read, Archive, a draft's Send) and
// Claude Code's calls (search, read, draft) each open a short connection of
// their own, so the watcher never waits on them.
//
// Claude Code can search, read and draft; only a press on the island sends.
// Nothing about the mail itself is written to the log: counts and states only.

mod cache;
mod detail;
mod draft;
mod imap;
mod inbox;
mod message;
mod parts;
mod reader;

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use async_imap::imap_proto::NameAttribute;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

use crate::apps::{self, Action, AppItems, DetailRequest, ItemDetail, ListItem, ListSection, NewNotification, Press};
use crate::integrations::PAUSED;
use crate::settings::GmailAccount;
use crate::i18n::{t, tf};
use crate::{log, secrets};
use imap::{quote, uid_set, Conn, MailError};
use inbox::{Account, Burst, Inbox, Tracked};

pub const APP_ID: &str = "gmail";
/// IDLE is renewed this often (RFC 2177 asks for under 29 minutes); a dead
/// connection is found by then at the latest.
const REIDLE: Duration = Duration::from_secs(10 * 60);
const FIRST_RETRY: Duration = Duration::from_secs(5);
const MAX_RETRY: Duration = Duration::from_secs(5 * 60);
/// A thread read by Claude Code hands over at most its newest this many mails.
const MAX_THREAD: usize = 25;

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize)]
#[serde(rename_all = "lowercase")]
enum Phase {
    #[default]
    Connecting,
    Ok,
    Error,
}

/// What a watcher last saw of its account.
#[derive(Debug, Clone, Default, PartialEq)]
struct Live {
    phase: Phase,
    error: Option<String>,
    unread: usize,
    /// Gmail answered which of the list is in its Primary tab.
    primary: bool,
    items: Vec<ListItem>,
    /// The inbox's UIDVALIDITY and its mails' UIDs by Gmail id, as the list
    /// saw them: a mail opened is fetched by its UID, no search.
    validity: u32,
    uids: HashMap<u64, u32>,
}

/// Where the list saw a mail: the inbox's UIDVALIDITY and the mail's UID.
fn known(email: &str, msgid: u64) -> detail::Known {
    let live = LIVE.lock().unwrap();
    let l = live.get(email)?;
    Some((l.validity, *l.uids.get(&msgid)?))
}

struct Run {
    task: JoinHandle<()>,
    wake: Arc<Notify>,
}

static RUNS: LazyLock<Mutex<HashMap<String, Run>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static LIVE: LazyLock<Mutex<HashMap<String, Live>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
/// The exact bytes of the drafts made since winotch started, by X-GM-MSGID:
/// Send sends these, not what a later fetch might return.
static DRAFTS: LazyLock<Mutex<HashMap<u64, Vec<u8>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// An account as Settings shows it ("mail-accounts", mail_accounts).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    email: String,
    label: Option<String>,
    opens_island: bool,
    status: Phase,
    error: Option<String>,
    unread: usize,
}

fn accounts(app: &AppHandle) -> Vec<GmailAccount> {
    app.try_state::<crate::Shared>().map(|s| s.settings.lock().unwrap().gmail_accounts.clone()).unwrap_or_default()
}

fn find(app: &AppHandle, email: &str) -> Option<GmailAccount> {
    let email = email.trim().to_ascii_lowercase();
    accounts(app).into_iter().find(|a| a.email == email)
}

fn views(app: &AppHandle) -> Vec<AccountView> {
    let accounts = accounts(app);
    let live = LIVE.lock().unwrap();
    accounts
        .into_iter()
        .map(|a| {
            let l = live.get(&a.email).cloned().unwrap_or_default();
            AccountView { email: a.email, label: a.label, opens_island: a.opens_island, status: l.phase, error: l.error, unread: l.unread }
        })
        .collect()
}

fn password(email: &str) -> Option<String> {
    secrets::get(&secrets::mail_key(email)?)
}

// ── Starting and stopping ────────────────────────────────────────────────────

/// At launch: Gmail's presses come here, and the watchers start.
pub fn start(app: &AppHandle) {
    apps::set_internal_handler(APP_ID, Arc::new(|app, p| Box::pin(press(app, p))));
    apps::set_internal_detail(APP_ID, Arc::new(|app, r| Box::pin(open_detail(app, r))));
    sync(app);
}

/// At launch and whenever the accounts change: one watcher per account, the
/// Gmail app there while any account is, and the island told.
pub fn sync(app: &AppHandle) {
    let wanted = accounts(app);
    {
        let mut runs = RUNS.lock().unwrap();
        runs.retain(|email, run| {
            let keep = wanted.iter().any(|a| &a.email == email);
            if !keep {
                run.task.abort();
                LIVE.lock().unwrap().remove(email);
                reader::forget(email);
            }
            keep
        });
        for account in &wanted {
            if !runs.contains_key(&account.email) {
                let wake = Arc::new(Notify::new());
                let task = tauri::async_runtime::spawn(watch(app.clone(), account.email.clone(), wake.clone()));
                runs.insert(account.email.clone(), Run { task, wake });
            }
        }
    }
    // Gmail is always in the registry (a built-in): Settings → Apps → Gmail is
    // where the first account is added. With none, it has no pill.
    apps::set_available(app, APP_ID, !wanted.is_empty());
    publish(app);
}

/// Starts an account's watcher again (a new password).
fn restart(app: &AppHandle, email: &str) {
    if let Some(run) = RUNS.lock().unwrap().remove(email) {
        run.task.abort();
    }
    LIVE.lock().unwrap().remove(email);
    reader::close(email);
    sync(app);
}

/// The watcher looks again now: after a press changed the inbox, or when
/// winotch is paused or resumed.
fn wake(email: &str) {
    if let Some(run) = RUNS.lock().unwrap().get(email) {
        run.wake.notify_one();
    }
}

pub fn wake_all() {
    for run in RUNS.lock().unwrap().values() {
        run.wake.notify_one();
    }
}

// ── What the island shows ────────────────────────────────────────────────────

/// The Gmail list (one section per account, in the order they were added),
/// its status line, and Settings' view of the accounts.
fn publish(app: &AppHandle) {
    let accounts = accounts(app);
    if accounts.is_empty() {
        let _ = app.emit("mail-accounts", Vec::<AccountView>::new());
        return;
    }
    let (sections, unread, primary, failing, connecting) = {
        let live = LIVE.lock().unwrap();
        let mut sections = Vec::new();
        let (mut unread, mut failing, mut connecting) = (0, 0, false);
        let mut primary = false;
        for a in &accounts {
            let l = live.get(&a.email).cloned().unwrap_or_default();
            unread += l.unread;
            primary |= l.primary;
            connecting |= l.phase == Phase::Connecting;
            let name = Account { email: &a.email, label: a.label.as_deref(), opens_island: a.opens_island }.name().to_string();
            let items = match (l.phase, &l.error) {
                (Phase::Error, Some(error)) => {
                    failing += 1;
                    vec![ListItem {
                        id: format!("{}:error", a.email),
                        title: t("Not connected"),
                        subtitle: Some(error.clone()),
                        // In every view: whichever is chosen, the account says what is wrong.
                        ..Default::default()
                    }]
                }
                _ => l.items.clone(),
            };
            if !items.is_empty() {
                sections.push(ListSection { title: Some(name), items });
            }
        }
        (sections, unread, primary, failing, connecting)
    };
    let status = inbox::status(unread, failing, connecting);
    let list_views = inbox::views(primary);
    apps::set_internal_items(app, APP_ID, Some(AppItems { status: Some(status), sections, updated: now_ms(), views: list_views }));
    let _ = app.emit("mail-accounts", views(app));
}

/// Changes what is known of an account, and tells the island only when that
/// changed something: a look that found the inbox as it was draws nothing.
fn set_live(app: &AppHandle, email: &str, change: impl FnOnce(&mut Live)) {
    let changed = {
        let mut live = LIVE.lock().unwrap();
        let entry = live.entry(email.to_string()).or_default();
        let before = entry.clone();
        change(entry);
        *entry != before
    };
    if changed {
        publish(app);
    }
}

fn set_error(app: &AppHandle, email: &str, error: String) {
    set_live(app, email, |l| {
        l.phase = Phase::Error;
        l.error = Some(error);
    });
}

fn log_connected() {
    let live = LIVE.lock().unwrap();
    let ok = live.values().filter(|l| l.phase == Phase::Ok).count();
    log::line(format!("mail: {ok} of {} accounts connected", live.len()));
}

// ── The watcher ──────────────────────────────────────────────────────────────

/// One account, for as long as it is configured: connect, look, IDLE, look
/// again; on a dropped connection try again, waiting longer each time (up to
/// 5 minutes). A refused sign-in stops it: trying again could lock the account.
async fn watch(app: AppHandle, email: String, wake: Arc<Notify>) {
    let mut inbox = Inbox::default();
    let mut tracked = restore(&app, &email);
    let mut burst = Burst::default();
    let mut retry = FIRST_RETRY;
    loop {
        // Paused means no network at all.
        while PAUSED.load(std::sync::atomic::Ordering::Relaxed) {
            let _ = tokio::time::timeout(Duration::from_secs(30), wake.notified()).await;
        }
        let Some(pass) = password(&email) else {
            set_error(&app, &email, t("No app password saved for this account: add it again."));
            return;
        };
        let started = Instant::now();
        let failure = match Conn::open(&email, &pass).await {
            Err(MailError::SignIn(message)) => {
                log::line("mail: an account's sign-in was refused; not trying again");
                set_error(&app, &email, message);
                return;
            }
            Err(e) => e,
            Ok(conn) => {
                drop(pass);
                match session(&app, &email, conn, &mut inbox, &mut tracked, &mut burst, &wake).await {
                    Ok(()) => continue, // paused
                    Err(e) => e,
                }
            }
        };
        // A connection that held for a while starts the waits over.
        if started.elapsed() > Duration::from_secs(60) {
            retry = FIRST_RETRY;
        }
        log::line(format!("mail: an account lost its connection; again in {} s", retry.as_secs()));
        set_error(&app, &email, tf("{error} Trying again…", &[("error", &failure.message())]));
        let _ = tokio::time::timeout(retry, wake.notified()).await;
        retry = (retry * 2).min(MAX_RETRY);
        set_live(&app, &email, |l| l.phase = Phase::Connecting);
    }
}

/// The notifications of this account still in the feed, oldest first: kept in
/// step with Gmail again after a restart.
fn restore(app: &AppHandle, email: &str) -> Vec<Tracked> {
    let Some(apps) = app.try_state::<apps::Apps>() else { return Vec::new() };
    let mut out: Vec<Tracked> = apps
        .notifications_of(APP_ID)
        .iter()
        .filter_map(|n| inbox::tracked_from(email, &n.id, n.read, n.meta.as_ref()?))
        .collect();
    out.reverse();
    out
}

async fn session(
    app: &AppHandle,
    email: &str,
    mut conn: Conn,
    inbox: &mut Inbox,
    tracked: &mut Vec<Tracked>,
    burst: &mut Burst,
    wake: &Notify,
) -> Result<(), MailError> {
    let mut first = true;
    loop {
        look(app, email, &mut conn, inbox, tracked, burst).await?;
        if first {
            first = false;
            log_connected();
        }
        let now = now_ms();
        if let Some(mails) = burst.take(now) {
            ring(app, email, inbox, tracked, mails);
        }
        let wait = burst.due_in(now).map(Duration::from_millis).unwrap_or(REIDLE).min(REIDLE);
        conn = idle(conn, wait, wake).await?;
        if PAUSED.load(std::sync::atomic::Ordering::Relaxed) {
            conn.logout().await;
            reader::close(email);
            set_live(app, email, |l| l.phase = Phase::Connecting);
            return Ok(());
        }
    }
}

/// Waits in IDLE until Gmail says something, `wait` runs out, or the account
/// is woken; then ends IDLE and hands the connection back.
async fn idle(conn: Conn, wait: Duration, wake: &Notify) -> Result<Conn, MailError> {
    let mut handle = conn.session.idle();
    tokio::time::timeout(Duration::from_secs(60), handle.init())
        .await
        .map_err(|_| MailError::Network(t("Can't reach Gmail: no answer")))?
        .map_err(|e| MailError::Network(tf("Can't reach Gmail: {error}", &[("error", &e.to_string())])))?;
    {
        // The library's own timeout restarts on every keep-alive; ours does not.
        let (answer, stop) = handle.wait_with_timeout(wait + Duration::from_secs(60));
        tokio::pin!(answer);
        let early = tokio::select! {
            r = &mut answer => Some(r),
            _ = wake.notified() => None,
            _ = tokio::time::sleep(wait) => None,
        };
        let result = match early {
            Some(r) => r,
            None => {
                drop(stop);
                answer.await
            }
        };
        result.map_err(|e| MailError::Network(tf("Can't reach Gmail: {error}", &[("error", &e.to_string())])))?;
    }
    let session = tokio::time::timeout(Duration::from_secs(60), handle.done())
        .await
        .map_err(|_| MailError::Network(t("Can't reach Gmail: no answer")))?
        .map_err(|e| MailError::Network(tf("Can't reach Gmail: {error}", &[("error", &e.to_string())])))?;
    Ok(Conn { session })
}

/// One look at the inbox: the newest mails and their flags, what is new, how
/// much is unread, and the bell brought in step.
async fn look(
    app: &AppHandle,
    email: &str,
    conn: &mut Conn,
    inbox: &mut Inbox,
    tracked: &mut Vec<Tracked>,
    burst: &mut Burst,
) -> Result<(), MailError> {
    // EXAMINE again each time: the count and UIDVALIDITY fresh, read-only.
    let (validity, exists) = conn.examine("INBOX").await?;
    if validity != inbox.validity {
        inbox.reset(validity);
    }
    // Notifications from before a UIDVALIDITY change point at nothing now.
    let stale: Vec<String> = tracked.iter().filter(|t| t.validity != validity).map(|t| t.notification.clone()).collect();
    tracked.retain(|t| t.validity == validity);

    let window = conn.window(exists, inbox::WINDOW).await?;
    let fetched = conn.previews(&inbox.missing(&window)).await?;
    let arrived = inbox.apply(&window, fetched);
    burst.push(arrived, now_ms());
    let unseen = conn.search("UNSEEN").await?;
    inbox.unread = unseen.len();
    // Gmail's Primary tab, for the list's Primary view: one more search per
    // look, nothing polled. A Gmail that does not take it leaves the view out.
    let primary = match conn.gmail_search(inbox::PRIMARY).await {
        Ok(uids) => Some(uids),
        Err(MailError::Refused(_)) => None,
        Err(e) => return Err(e),
    };

    // Where each tracked mail stands: in the window, or asked for.
    let mut state: HashMap<u32, bool> = window.iter().copied().collect();
    let outside: Vec<u32> = inbox::tracked_uids(tracked).into_iter().filter(|u| !state.contains_key(u)).collect();
    state.extend(conn.flags(&outside).await?);
    let mut mirror = inbox::mirror(tracked, &state);
    mirror.dismiss.extend(stale);
    if let Some(apps) = app.try_state::<apps::Apps>() {
        if !mirror.read.is_empty() || !mirror.dismiss.is_empty() {
            apps.read_and_dismiss(&mirror.read, &mirror.dismiss);
            apps::changed(app);
        }
    }

    let in_primary = |uid: u32| primary.as_ref().map(|p| p.binary_search(&uid).is_ok());
    let offset = detail::local_offset();
    let items: Vec<ListItem> = inbox.newest_first().map(|m| inbox::item(email, m, in_primary(m.uid), offset)).collect();
    let newest: Vec<u64> = inbox.newest_first().map(|m| m.msgid).collect();
    let uids: HashMap<u64, u32> = inbox.mails.values().map(|m| (m.msgid, m.uid)).collect();
    let unread = inbox.unread;
    let has_primary = primary.is_some();
    set_live(app, email, |l| {
        l.phase = Phase::Ok;
        l.error = None;
        l.unread = unread;
        l.primary = has_primary;
        l.items = items;
        l.validity = validity;
        l.uids = uids;
    });
    // The newest mails are read ahead, so a click finds them there.
    reader::want(app, email, newest);
    Ok(())
}

/// Announces a burst: what of it is still unread in the inbox.
fn ring(app: &AppHandle, email: &str, inbox: &Inbox, tracked: &mut Vec<Tracked>, mails: Vec<message::Mail>) {
    let still: Vec<message::Mail> =
        mails.into_iter().filter(|m| inbox.mails.get(&m.uid).is_some_and(|now| !now.seen)).collect();
    let all = accounts(app);
    let Some(position) = all.iter().position(|a| a.email == email) else { return };
    let a = &all[position];
    let account = Account { email: &a.email, label: a.label.as_deref(), opens_island: a.opens_island };
    // The first account is the default one; another is named in the count.
    let name_account = all.len() > 1 && position > 0;
    let Some(notice) = inbox::notice(&account, name_account, inbox.validity, &still) else { return };
    match apps::post_internal(app, APP_ID, notice) {
        Ok(id) => {
            tracked.push(Tracked { notification: id, validity: inbox.validity, uids: still.iter().map(|m| m.uid).collect(), read: false });
            for old in inbox::bound(tracked) {
                apps::dismiss_internal(app, &old);
            }
        }
        Err(e) => log::line(format!("mail: could not post a notification: {e}")),
    }
}

// ── Presses ──────────────────────────────────────────────────────────────────

/// A short connection of its own, for a press or a call from Claude Code.
async fn open(app: &AppHandle, email: &str) -> Result<(GmailAccount, Conn), (u16, String)> {
    if PAUSED.load(std::sync::atomic::Ordering::Relaxed) {
        return Err((409, "winotch is paused: resume it to reach Gmail".into()));
    }
    let account = find(app, email).ok_or_else(|| (404, "no such Gmail account in winotch".to_string()))?;
    let pass = password(&account.email).ok_or((409, "no app password saved for this account".to_string()))?;
    let conn = Conn::open(&account.email, &pass).await.map_err(|e| (502, e.message()))?;
    Ok((account, conn))
}

fn msg(e: (u16, String)) -> String {
    e.1
}

async fn press(app: AppHandle, press: Press) -> Result<(), String> {
    match press {
        Press::Item { item, action } => {
            let (account, msgid) = inbox::parse_item_id(&item.id).ok_or("that is not a mail")?;
            if action == "open" {
                // An opened mail's Open in Gmail: only a link.
                crate::platform::open_url(&message::message_link(account, msgid));
                return Ok(());
            }
            inbox_action(&app, account, &[msgid], &action).await
        }
        Press::Notification { notification, action } => {
            let meta = notification.meta.clone().unwrap_or(Value::Null);
            let account = meta["account"].as_str().unwrap_or_default().to_string();
            match meta["kind"].as_str() {
                Some("mail") => {
                    let ids: Vec<u64> = meta["ids"]
                        .as_array()
                        .map(|a| a.iter().filter_map(|i| i.as_str()?.parse().ok()).collect())
                        .unwrap_or_default();
                    inbox_action(&app, &account, &ids, &action).await
                }
                Some("draft") => {
                    let id: u64 = meta["id"].as_str().and_then(|i| i.parse().ok()).ok_or("that draft has no id")?;
                    draft_action(&app, &notification.id, &account, id, &action).await
                }
                _ => Err("that notification has nothing to act on".into()),
            }
        }
    }
}

/// A mail clicked on the island: its text, from what was read ahead when it
/// was (cache.rs), else read now on the account's kept connection (reader.rs),
/// all of it within `detail::DETAIL_TIMEOUT`: the pane shows the mail or one
/// error line, never nothing. Once shown, an unread mail is marked read, as
/// Gmail does when a mail is opened; the list and the bell follow at once.
///
/// A pointer resting on a row (`prefetch`) only asks for it to be read next.
/// The log says how it went and how long each step took, never anything of
/// the mail.
async fn open_detail(app: AppHandle, request: DetailRequest) -> Result<ItemDetail, String> {
    let id = request.item.id.clone();
    let (email, msgid) = inbox::parse_item_id(&id).ok_or("that is not a mail")?;
    if request.prefetch {
        reader::want_first(&app, email, msgid);
        return Ok(ItemDetail::default());
    }
    let started = Instant::now();
    let mut steps = detail::Steps::default();
    let cached = reader::CACHE.lock().unwrap().get(email, msgid);
    let (found, how) = match cached {
        Some(found) => (found, "read ahead"),
        None => {
            let read = detail::within(detail::DETAIL_TIMEOUT, reader::read(&app, email, msgid, known(email, msgid), &mut steps)).await;
            match read {
                Ok(Some(found)) => {
                    reader::CACHE.lock().unwrap().put(email, msgid, found.clone());
                    (found, "read now")
                }
                Ok(None) => {
                    log::line(format!("mail: a mail's details: not in Gmail ({} ms; {})", started.elapsed().as_millis(), steps.line()));
                    return Err(t("This mail is no longer in Gmail."));
                }
                Err(e) => {
                    let what = if started.elapsed() >= detail::DETAIL_TIMEOUT { "no answer in time" } else { e.kind() };
                    log::line(format!("mail: a mail's details failed: {what} ({} ms; {})", started.elapsed().as_millis(), steps.line()));
                    return Err(e.message());
                }
            }
        }
    };
    log::line(format!("mail: a mail's details shown, {how}, in {} ms ({})", started.elapsed().as_millis(), steps.line()));
    if request.item.unread {
        // Read here at once; in Gmail just after, on the kept connection.
        set_live(&app, email, |l| {
            if inbox::seen_here(&mut l.items, &id) {
                l.unread = l.unread.saturating_sub(1);
            }
        });
        let (app, email, at) = (app.clone(), email.to_string(), found.at.clone());
        tauri::async_runtime::spawn(async move {
            match detail::within(detail::DETAIL_TIMEOUT, reader::mark(&app, &email, &at)).await {
                Ok(true) => {}
                Ok(false) => log::line("mail: an opened mail was not marked read: its mailbox changed"),
                Err(e) => log::line(format!("mail: an opened mail was not marked read: {}", e.kind())),
            }
            wake(&email);
        });
    }
    Ok(detail::item_detail(&found.mail, detail::local_offset()))
}

/// Mark read or Archive, on the inbox, for these Gmail ids.
async fn inbox_action(app: &AppHandle, email: &str, ids: &[u64], action: &str) -> Result<(), String> {
    if !matches!(action, "read" | "archive") {
        return Err(format!("no action {action}"));
    }
    let (account, mut conn) = open(app, email).await.map_err(msg)?;
    let result = async {
        conn.select("INBOX").await?;
        let mut uids = Vec::new();
        for id in ids {
            uids.extend(conn.search(&format!("X-GM-MSGID {id}")).await?);
        }
        // Already gone from the inbox: nothing left to do.
        if uids.is_empty() {
            return Ok(());
        }
        let set = uid_set(&uids);
        if action == "read" {
            conn.run(&format!("UID STORE {set} +FLAGS.SILENT (\\Seen)")).await?;
        } else if conn.run(&format!("UID STORE {set} -X-GM-LABELS (\\Inbox)")).await.is_err() {
            // Gmail's own way failed: move it to All Mail, which is archiving.
            let all = conn.special(NameAttribute::All).await?;
            conn.run(&format!("UID MOVE {set} {}", quote(&all))).await?;
        }
        Ok::<(), MailError>(())
    }
    .await;
    conn.logout().await;
    wake(&account.email);
    result.map_err(String::from)
}

async fn draft_action(app: &AppHandle, notification: &str, email: &str, id: u64, action: &str) -> Result<(), String> {
    match action {
        "open" => {
            crate::platform::open_url(&message::drafts_link(email));
            // Only a link: Send and Discard stay.
            if let Some(apps) = app.try_state::<apps::Apps>() {
                apps.set_acted(notification, None);
                apps::changed(app);
            }
            Ok(())
        }
        "send" => send_draft(app, email, id).await,
        "discard" => {
            let (_, mut conn) = open(app, email).await.map_err(msg)?;
            let result = async {
                if let Some(uid) = find_draft(&mut conn, id).await? {
                    trash(&mut conn, uid).await?;
                }
                Ok::<(), MailError>(())
            }
            .await;
            conn.logout().await;
            DRAFTS.lock().unwrap().remove(&id);
            result.map_err(String::from)
        }
        _ => Err(format!("no action {action}")),
    }
}

/// Opens the Drafts folder to change it, and finds the draft by its Gmail id.
async fn find_draft(conn: &mut Conn, id: u64) -> Result<Option<u32>, MailError> {
    let drafts = conn.special(NameAttribute::Drafts).await?;
    conn.select(&drafts).await?;
    Ok(conn.search(&format!("X-GM-MSGID {id}")).await?.into_iter().next())
}

/// Takes a draft out of Drafts: to the bin, as Gmail's Discard does.
async fn trash(conn: &mut Conn, uid: u32) -> Result<(), MailError> {
    match conn.special(NameAttribute::Trash).await {
        Ok(bin) => conn.run(&format!("UID MOVE {uid} {}", quote(&bin))).await,
        Err(_) => {
            conn.run(&format!("UID STORE {uid} +FLAGS.SILENT (\\Deleted)")).await?;
            conn.run(&format!("UID EXPUNGE {uid}")).await
        }
    }
}

/// The user pressed Send: the draft goes out exactly as drafted, over SMTP,
/// then leaves Drafts. Gmail files the sent copy itself.
async fn send_draft(app: &AppHandle, email: &str, id: u64) -> Result<(), String> {
    let (account, mut conn) = open(app, email).await.map_err(msg)?;
    let found = async {
        let Some(uid) = find_draft(&mut conn, id).await? else { return Ok(None) };
        let kept = DRAFTS.lock().unwrap().get(&id).cloned();
        let bytes = match kept {
            Some(bytes) => Some(bytes),
            None => conn.raw(uid).await?,
        };
        Ok::<_, MailError>(bytes.map(|b| (uid, b)))
    }
    .await;
    let (uid, bytes) = match found {
        Ok(Some(found)) => found,
        Ok(None) => {
            conn.logout().await;
            return Err(t("That draft is gone from Gmail, or was changed there: send it from Gmail."));
        }
        Err(e) => {
            conn.logout().await;
            return Err(e.message());
        }
    };
    let Some(pass) = password(&account.email) else {
        conn.logout().await;
        return Err("no app password saved for this account".into());
    };
    let sent = draft::send(&account.email, &pass, &message::recipients(&bytes), &bytes).await;
    drop(pass);
    if let Err(e) = sent {
        conn.logout().await;
        return Err(e);
    }
    log::line("mail: a draft was sent");
    // Sent: a draft left behind would only be sent twice by mistake.
    let cleaned = trash(&mut conn, uid).await;
    conn.logout().await;
    DRAFTS.lock().unwrap().remove(&id);
    if let Err(e) = cleaned {
        log::line(format!("mail: a sent draft stayed in Drafts: {}", e.message()));
    }
    Ok(())
}

// ── Claude Code's side: /v1/mail/* ───────────────────────────────────────────

/// GET /v1/mail/accounts, GET /v1/mail/search, GET /v1/mail/message,
/// POST /v1/mail/draft. Errors carry their HTTP status.
pub async fn route(
    app: &AppHandle,
    method: &str,
    path: &str,
    query: &HashMap<String, String>,
    body: &[u8],
) -> Result<Value, (u16, String)> {
    match (method, path) {
        ("GET", "/v1/mail/accounts") => Ok(json!(views(app)
            .into_iter()
            .map(|v| json!({ "email": v.email, "label": v.label, "status": v.status, "error": v.error, "unread": v.unread }))
            .collect::<Vec<_>>())),
        ("GET", "/v1/mail/search") => search(app, query).await,
        ("GET", "/v1/mail/message") => read(app, query).await,
        ("POST", "/v1/mail/draft") => {
            let input: Value = serde_json::from_slice(body).map_err(|e| (400, format!("JSON: {e}")))?;
            make_draft(app, &input).await
        }
        _ => Err((404, format!("no {method} {path}"))),
    }
}

fn mail_error(e: MailError) -> (u16, String) {
    match e {
        MailError::Refused(m) => (400, m),
        MailError::Unavailable(m) => (409, m),
        e => (502, e.message()),
    }
}

async fn search(app: &AppHandle, query: &HashMap<String, String>) -> Result<Value, (u16, String)> {
    let q = query.get("q").map(|q| q.trim()).filter(|q| !q.is_empty()).ok_or((400, "q is missing: a Gmail search".to_string()))?;
    if q.chars().count() > 1000 || q.contains(['\r', '\n']) {
        return Err((400, "q: one line, at most 1000 characters".into()));
    }
    let limit = query.get("limit").and_then(|l| l.parse::<usize>().ok()).unwrap_or(20).clamp(1, 50);
    let targets: Vec<String> = match query.get("account").map(|a| a.trim()).filter(|a| !a.is_empty()) {
        Some(a) => vec![find(app, a).ok_or((404, "no such Gmail account in winotch".to_string()))?.email],
        None => accounts(app).into_iter().map(|a| a.email).collect(),
    };
    if targets.is_empty() {
        return Err((404, "no Gmail account in winotch: add one in Settings → Apps".into()));
    }
    let mut messages = Vec::new();
    let mut errors = Vec::new();
    for email in &targets {
        let found = async {
            let (_, mut conn) = open(app, email).await?;
            let result = async {
                // All Mail: everything, as a search on the web finds it.
                let all = conn.special(NameAttribute::All).await?;
                conn.examine(&all).await?;
                let uids = conn.gmail_search(q).await?;
                let newest: Vec<u32> = uids.iter().rev().take(limit).copied().collect();
                conn.previews(&newest).await
            }
            .await;
            conn.logout().await;
            result.map_err(mail_error)
        }
        .await;
        match found {
            Ok(mails) => messages.extend(mails.iter().map(|m| (m.time, m.to_json(email)))),
            Err((_, e)) => errors.push(json!({ "account": email, "error": e })),
        }
    }
    if messages.is_empty() && !errors.is_empty() && targets.len() == 1 {
        return Err((502, errors[0]["error"].as_str().unwrap_or_default().to_string()));
    }
    messages.sort_by(|a, b| b.0.cmp(&a.0));
    let messages: Vec<Value> = messages.into_iter().take(limit).map(|(_, m)| m).collect();
    let mut out = json!({ "messages": messages });
    if !errors.is_empty() {
        out["errors"] = json!(errors);
    }
    Ok(out)
}

async fn read(app: &AppHandle, query: &HashMap<String, String>) -> Result<Value, (u16, String)> {
    let email = query.get("account").ok_or((400, "account is missing".to_string()))?;
    let id: u64 = query
        .get("id")
        .and_then(|i| i.trim().parse().ok())
        .ok_or((400, "id: a message's id, as search returns it".to_string()))?;
    let thread = query.get("thread").is_some_and(|t| t == "1" || t == "true");
    let (account, mut conn) = open(app, email).await?;
    let result = async {
        let all = conn.special(NameAttribute::All).await?;
        conn.examine(&all).await?;
        let Some(uid) = conn.search(&format!("X-GM-MSGID {id}")).await?.into_iter().next() else {
            return Ok(None);
        };
        let mut uids = vec![uid];
        if thread {
            let thrid = conn
                .run_map(&format!("UID FETCH {uid} (UID X-GM-THRID)"), |r| message::fetched(r).and_then(|f| f.thrid))
                .await?
                .into_iter()
                .next();
            if let Some(thrid) = thrid {
                let all = conn.search(&format!("X-GM-THRID {thrid}")).await?;
                uids = all.iter().rev().take(MAX_THREAD).copied().collect();
            }
        }
        conn.full(&account.email, &uids).await.map(Some)
    }
    .await;
    conn.logout().await;
    match result.map_err(mail_error)? {
        Some(messages) => Ok(json!({ "account": account.email, "thread": thread, "messages": messages })),
        None => Err((404, "no such message in this account".into())),
    }
}

/// A list of addresses: an array of strings, or one string with commas.
fn address_list(value: &Value, field: &str) -> Result<Vec<String>, (u16, String)> {
    let list: Vec<String> = match value {
        Value::Null => Vec::new(),
        Value::String(s) => s.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect(),
        Value::Array(a) => a.iter().map(|v| v.as_str().map(|s| s.trim().to_string()).ok_or((400, format!("{field}: addresses as strings")))).collect::<Result<_, _>>()?,
        _ => return Err((400, format!("{field}: a list of addresses"))),
    };
    if list.len() > 50 {
        return Err((400, format!("{field}: at most 50 addresses")));
    }
    Ok(list)
}

/// POST /v1/mail/draft: builds the message, puts it in the account's Drafts,
/// and asks the user on the island. Never sends.
async fn make_draft(app: &AppHandle, input: &Value) -> Result<Value, (u16, String)> {
    let email = input["account"].as_str().ok_or((400, "account is missing".to_string()))?;
    let mut to = address_list(&input["to"], "to")?;
    let cc = address_list(&input["cc"], "cc")?;
    let mut subject = input["subject"].as_str().unwrap_or_default().trim().to_string();
    let body = input["body"].as_str().ok_or((400, "body is missing: the text of the mail".to_string()))?;
    if body.chars().count() > 100_000 || subject.chars().count() > 300 {
        return Err((400, "body: at most 100000 characters; subject: at most 300".into()));
    }
    let reply_to: Option<u64> = match &input["reply_to"] {
        Value::Null => None,
        v => Some(
            v.as_str()
                .and_then(|s| s.trim().parse().ok())
                .or_else(|| v.as_u64())
                .ok_or((400, "reply_to: the id of the mail answered, as search returns it".to_string()))?,
        ),
    };
    let (account, mut conn) = open(app, email).await?;
    let result = async {
        let original = match reply_to {
            Some(id) => {
                let all = conn.special(NameAttribute::All).await?;
                conn.examine(&all).await?;
                let uid = conn.search(&format!("X-GM-MSGID {id}")).await?.into_iter().next();
                let Some(uid) = uid else { return Err(MailError::Refused("reply_to: no such message in this account".into())) };
                // Its headers are all a reply needs, never its attachments.
                let bytes = conn.start(uid, 64 * 1024).await?.unwrap_or_default();
                message::original_from(&bytes)
            }
            None => None,
        };
        if let Some(o) = &original {
            subject = draft::reply_subject(&subject, &o.subject);
            if to.is_empty() {
                to = o.reply_to.clone();
            }
        }
        let spec = draft::Spec { from: account.email.clone(), to: to.clone(), cc: cc.clone(), subject: subject.clone(), body: body.to_string() };
        let message_id = draft::new_message_id(&account.email);
        let bytes = draft::build(&spec, original.as_ref(), &message_id).map_err(MailError::Refused)?;
        let drafts = conn.special(NameAttribute::Drafts).await?;
        conn.append(&drafts, "(\\Draft)", &bytes).await?;
        // Found again by the Message-ID we gave it, for Gmail's id.
        conn.examine(&drafts).await?;
        let header = format!("HEADER Message-ID {}", quote(&message_id));
        let mut uid = conn.search(&header).await?.into_iter().next_back();
        if uid.is_none() {
            // Gmail's own search knows it by the same id.
            let bare = message_id.trim_matches(['<', '>']);
            uid = conn.gmail_search(&format!("rfc822msgid:{bare}")).await?.into_iter().next_back();
        }
        let mut msgid = None;
        if let Some(uid) = uid {
            msgid = conn
                .run_map(&format!("UID FETCH {uid} (UID X-GM-MSGID)"), |r| message::fetched(r).and_then(|f| f.msgid))
                .await?
                .into_iter()
                .next();
        }
        let msgid = msgid.ok_or_else(|| MailError::Refused("the draft was saved but Gmail did not give its id".into()))?;
        Ok((msgid, bytes, original))
    }
    .await;
    conn.logout().await;
    let (msgid, bytes, original) = result.map_err(mail_error)?;
    DRAFTS.lock().unwrap().insert(msgid, bytes);
    log::line("mail: a draft was saved for the user's press");

    let title = match &original {
        Some(o) if !o.sender_name.is_empty() => tf("Draft reply to {name}", &[("name", &o.sender_name)]),
        _ => t("Draft ready"),
    };
    let shown_subject = if subject.is_empty() { t("(no subject)") } else { subject.clone() };
    let notification = apps::post_internal(
        app,
        APP_ID,
        NewNotification {
            title,
            body: Some(tf(
                "To: {to} — {subject}",
                &[("to", &to.iter().chain(&cc).cloned().collect::<Vec<_>>().join(", ")), ("subject", &shown_subject)],
            )),
            url: Some(message::drafts_link(&account.email)),
            importance: if account.opens_island { "normal" } else { "low" },
            actions: vec![
                Action { id: "send".into(), label: t("Send") },
                Action { id: "open".into(), label: t("Open in Gmail") },
                Action { id: "discard".into(), label: t("Discard") },
            ],
            meta: Some(json!({ "kind": "draft", "account": account.email, "id": msgid.to_string(), "messageId": message_id_of(&original) })),
            item: None,
        },
    )
    .map_err(|e| (500, e))?;
    Ok(json!({
        "id": msgid.to_string(),
        "account": account.email,
        "to": to,
        "cc": cc,
        "subject": subject,
        "notification": notification,
        "sent": false,
    }))
}

fn message_id_of(original: &Option<message::Original>) -> Value {
    json!(original.as_ref().and_then(|o| o.message_id.clone()))
}

// ── Settings' side ───────────────────────────────────────────────────────────

fn save_accounts(app: &AppHandle, change: impl FnOnce(&mut Vec<GmailAccount>)) {
    let Some(shared) = app.try_state::<crate::Shared>() else { return };
    let updated = {
        let mut settings = shared.settings.lock().unwrap();
        change(&mut settings.gmail_accounts);
        if let Err(e) = crate::settings::save(&settings) {
            log::line(format!("could not save settings: {e}"));
        }
        settings.clone()
    };
    let _ = app.emit("settings-changed", updated);
}

/// The accounts, for Settings.
#[tauri::command]
pub fn mail_accounts(app: AppHandle) -> Vec<AccountView> {
    views(&app)
}

/// Adds an account (or gives an existing one a new password) once Gmail has
/// taken the password: one sign-in, then the password goes to the credential
/// store and the account starts.
#[tauri::command]
pub async fn mail_add_account(app: AppHandle, email: String, label: Option<String>, password: String) -> Result<AccountView, String> {
    let email = email.trim().to_ascii_lowercase();
    let key = secrets::mail_key(&email).ok_or_else(|| t("That is not an email address winotch can use."))?;
    // Google shows app passwords in groups of four; the spaces are not part of it.
    let password: String = password.chars().filter(|c| !c.is_whitespace()).collect();
    if password.is_empty() {
        return Err(t("The app password is missing."));
    }
    match Conn::open(&email, &password).await {
        Ok(conn) => conn.logout().await,
        Err(e) => return Err(e.message()),
    }
    secrets::set(&key, &password)?;
    let label = label.map(|l| l.trim().chars().take(40).collect::<String>()).filter(|l| !l.is_empty());
    save_accounts(&app, |list| match list.iter_mut().find(|a| a.email == email) {
        Some(existing) => {
            if label.is_some() {
                existing.label = label.clone();
            }
        }
        None => list.push(GmailAccount { email: email.clone(), label: label.clone(), opens_island: true }),
    });
    log::line("mail: an account was added");
    restart(&app, &email);
    views(&app).into_iter().find(|v| v.email == email).ok_or_else(|| "the account was not saved".into())
}

#[tauri::command]
pub fn mail_remove_account(app: AppHandle, email: String) -> Result<(), String> {
    let email = email.trim().to_ascii_lowercase();
    save_accounts(&app, |list| list.retain(|a| a.email != email));
    if let Some(key) = secrets::mail_key(&email) {
        secrets::clear(&key)?;
    }
    // Its notifications go with it.
    if let Some(apps) = app.try_state::<apps::Apps>() {
        let mine: Vec<String> = apps
            .notifications_of(APP_ID)
            .into_iter()
            .filter(|n| n.meta.as_ref().is_some_and(|m| m["account"] == email.as_str()))
            .map(|n| n.id)
            .collect();
        apps.read_and_dismiss(&[], &mine);
        apps::changed(&app);
    }
    log::line("mail: an account was removed");
    sync(&app);
    Ok(())
}

/// Renames an account (an empty label shows the address) or lets it open the
/// island or not.
#[tauri::command]
pub fn mail_set_account(app: AppHandle, email: String, label: Option<String>, opens_island: Option<bool>) -> Result<(), String> {
    let email = email.trim().to_ascii_lowercase();
    find(&app, &email).ok_or("no such Gmail account in winotch")?;
    save_accounts(&app, |list| {
        if let Some(a) = list.iter_mut().find(|a| a.email == email) {
            if let Some(label) = label {
                let label: String = label.trim().chars().take(40).collect();
                a.label = (!label.is_empty()).then_some(label);
            }
            if let Some(on) = opens_island {
                a.opens_island = on;
            }
        }
    });
    publish(&app);
    Ok(())
}
