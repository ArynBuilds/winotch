// One connection per account kept open for reading mails (the watcher's own
// sits in IDLE and is never borrowed): signing in to Gmail costs a TLS
// handshake and a LOGIN, often most of a second, so a click on a mail must not
// pay it. It stays on the inbox, reconnects when it fails, and checks itself
// with a NOOP when it has been quiet for a while.
//
// The newest mails of the inbox are read ahead on it, one at a time, and kept
// in memory (cache.rs), so most clicks find their mail already there. A click
// goes before the reading ahead: it waits at most for the one mail being read.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use tauri::AppHandle;

use super::cache::{to_prefetch, Cache, Cached, Location, CAPACITY};
use super::detail::{self, Known, Mailbox, Steps, DETAIL_TIMEOUT};
use super::imap::{Conn, MailError};
use super::parts::{outline_command, outline_from, text_command, text_from, Outline, TextPart};
use crate::integrations::PAUSED;
use crate::log;

/// A connection quiet longer than this is checked (NOOP) before it is used.
const QUIET: Duration = Duration::from_secs(90);
/// How long that check may take before a new connection is opened instead.
const NOOP_TIMEOUT: Duration = Duration::from_secs(3);
/// Between two mails read ahead: room for a click.
const PREFETCH_GAP: Duration = Duration::from_millis(150);

/// The mails read lately, all accounts together.
pub(super) static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(|| Mutex::new(Cache::new(CAPACITY)));

/// A signed-in connection for reads, with the mailbox it has selected.
pub(super) struct Reader {
    conn: Conn,
    selected: Option<(String, u32)>,
    all_mail: Option<String>,
    used: Instant,
}

impl Mailbox for Reader {
    async fn all_mail(&mut self) -> Result<String, MailError> {
        if let Some(name) = &self.all_mail {
            return Ok(name.clone());
        }
        let name = self.conn.special(async_imap::imap_proto::NameAttribute::All).await?;
        self.all_mail = Some(name.clone());
        Ok(name)
    }
    /// Selected already: nothing is sent (Gmail keeps a selected mailbox current).
    async fn select(&mut self, mailbox: &str) -> Result<u32, MailError> {
        if let Some((name, validity)) = &self.selected {
            if name == mailbox {
                return Ok(*validity);
            }
        }
        // A SELECT that fails leaves nothing selected.
        self.selected = None;
        let (validity, _) = self.conn.select(mailbox).await?;
        self.selected = Some((mailbox.to_string(), validity));
        Ok(validity)
    }
    async fn search(&mut self, criteria: &str) -> Result<Vec<u32>, MailError> {
        self.conn.search(criteria).await
    }
    async fn outline(&mut self, uid: u32) -> Result<Option<Outline>, MailError> {
        let found = self.conn.run_map(&outline_command(uid), outline_from).await?;
        // Gmail may slip in news of other mails: only this one's answer counts.
        Ok(found.into_iter().find(|o| o.uid == Some(uid)))
    }
    async fn text(&mut self, uid: u32, part: &TextPart) -> Result<(Option<Vec<u8>>, Option<Vec<u8>>), MailError> {
        let found = self.conn.run_map(&text_command(uid, part), text_from).await?;
        Ok(found.into_iter().find(|(u, _, _)| *u == Some(uid)).map(|(_, mime, body)| (mime, body)).unwrap_or((None, None)))
    }
    async fn run(&mut self, command: &str) -> Result<(), MailError> {
        self.conn.run(command).await
    }
}

type Slot = Arc<tokio::sync::Mutex<Option<Reader>>>;

static SLOTS: LazyLock<Mutex<HashMap<String, Slot>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn slot(email: &str) -> Slot {
    SLOTS.lock().unwrap().entry(email.to_string()).or_default().clone()
}

/// The kept connection, checked, or a new one. True: it is new (a failure on
/// it is no reason to try again).
async fn take(app: &AppHandle, email: &str, kept: &mut Option<Reader>, steps: &mut Steps) -> Result<(Reader, bool), MailError> {
    if let Some(mut r) = kept.take() {
        if r.used.elapsed() < QUIET {
            return Ok((r, false));
        }
        let started = Instant::now();
        let alive = matches!(tokio::time::timeout(NOOP_TIMEOUT, r.conn.run("NOOP")).await, Ok(Ok(())));
        steps.add("noop", started);
        if alive {
            return Ok((r, false));
        }
    }
    let started = Instant::now();
    let (_, conn) = super::open(app, email).await.map_err(|(status, message)| match status {
        502 => MailError::Network(message),
        _ => MailError::Unavailable(message),
    })?;
    steps.add("connect", started);
    Ok((Reader { conn, selected: None, all_mail: None, used: Instant::now() }, true))
}

/// A mail of the account, read on the kept connection (a new one if it
/// failed). The connection is only kept again when the reading ended well: one
/// dropped half-way (the pane's time ran out) is closed with it.
pub(super) async fn read(app: &AppHandle, email: &str, msgid: u64, known: Known, steps: &mut Steps) -> Result<Option<Cached>, MailError> {
    let slot = slot(email);
    let started = Instant::now();
    let mut kept = slot.lock().await;
    steps.add("wait", started);
    loop {
        let (mut r, fresh) = take(app, email, &mut kept, steps).await?;
        match detail::read_mail(&mut r, email, msgid, known, steps).await {
            Err(MailError::Network(_)) if !fresh => continue,
            Err(e @ MailError::Network(_)) => return Err(e),
            result => {
                r.used = Instant::now();
                *kept = Some(r);
                return result;
            }
        }
    }
}

/// Marks a mail read on the kept connection, where it was found.
pub(super) async fn mark(app: &AppHandle, email: &str, at: &Location) -> Result<bool, MailError> {
    let slot = slot(email);
    let mut kept = slot.lock().await;
    let mut steps = Steps::default();
    loop {
        let (mut r, fresh) = take(app, email, &mut kept, &mut steps).await?;
        match detail::mark_read(&mut r, at).await {
            Err(MailError::Network(_)) if !fresh => continue,
            Err(e @ MailError::Network(_)) => return Err(e),
            result => {
                r.used = Instant::now();
                *kept = Some(r);
                return result;
            }
        }
    }
}

// ── Reading ahead ────────────────────────────────────────────────────────────

/// Per account: the newest mails to read ahead (newest first), and whether a
/// task is reading them.
#[derive(Default)]
struct Ahead {
    newest: Vec<u64>,
    running: bool,
}

static AHEAD: LazyLock<Mutex<HashMap<String, Ahead>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// The inbox as the list now shows it (newest first): its head is read ahead.
pub(super) fn want(app: &AppHandle, email: &str, newest: Vec<u64>) {
    let start = {
        let mut ahead = AHEAD.lock().unwrap();
        let a = ahead.entry(email.to_string()).or_default();
        a.newest = newest;
        !std::mem::replace(&mut a.running, true)
    };
    if start {
        tauri::async_runtime::spawn(read_ahead(app.clone(), email.to_string()));
    }
}

/// A row the pointer rests on: read it next.
pub(super) fn want_first(app: &AppHandle, email: &str, msgid: u64) {
    if CACHE.lock().unwrap().contains(email, msgid) {
        return;
    }
    let newest = {
        let ahead = AHEAD.lock().unwrap();
        let mut newest = ahead.get(email).map(|a| a.newest.clone()).unwrap_or_default();
        newest.retain(|m| *m != msgid);
        newest.insert(0, msgid);
        newest
    };
    want(app, email, newest);
}

/// The next mail to read ahead, or None, the task then ending (under the same
/// lock as `want`, so no wish is missed).
fn next(email: &str) -> Option<u64> {
    let mut ahead = AHEAD.lock().unwrap();
    let a = ahead.get_mut(email)?;
    let cache = CACHE.lock().unwrap();
    let next = if PAUSED.load(std::sync::atomic::Ordering::Relaxed) {
        None
    } else {
        to_prefetch(&a.newest, |m| cache.contains(email, m)).first().copied()
    };
    if next.is_none() {
        a.running = false;
    }
    next
}

async fn read_ahead(app: AppHandle, email: String) {
    let started = Instant::now();
    let mut count = 0;
    while let Some(msgid) = next(&email) {
        tokio::time::sleep(PREFETCH_GAP).await;
        let known = super::known(&email, msgid);
        let mut steps = Steps::default();
        match detail::within(DETAIL_TIMEOUT, self::read(&app, &email, msgid, known, &mut steps)).await {
            Ok(Some(found)) => {
                CACHE.lock().unwrap().put(&email, msgid, found);
                count += 1;
            }
            // Gone since: not wished for again.
            Ok(None) => {
                if let Some(a) = AHEAD.lock().unwrap().get_mut(&email) {
                    a.newest.retain(|m| *m != msgid);
                }
            }
            Err(e) => {
                log::line(format!("mail: reading ahead stopped: {} ({})", e.kind(), steps.line()));
                if let Some(a) = AHEAD.lock().unwrap().get_mut(&email) {
                    a.running = false;
                }
                return;
            }
        }
    }
    if count > 0 {
        log::line(format!("mail: read {count} mails ahead in {} ms", started.elapsed().as_millis()));
    }
}

/// Paused: the kept connection closes (it is opened again when needed).
pub(super) fn close(email: &str) {
    SLOTS.lock().unwrap().remove(email);
}

/// An account removed: its connection closes and none of its mail stays.
pub(super) fn forget(email: &str) {
    close(email);
    AHEAD.lock().unwrap().remove(email);
    CACHE.lock().unwrap().forget(email);
}
