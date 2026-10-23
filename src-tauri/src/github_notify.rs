// GitHub's own notifications inbox in winotch's bell (WINOTCH.md, "GitHub").
//
// It mirrors github.com/notifications: the unread threads, as GitHub picks
// them (GET /notifications, no filter of ours), polled no faster than GitHub's
// X-Poll-Interval and with If-Modified-Since, so an unchanged inbox costs no
// rate limit. Then:
//
// - what is new since winotch started, and worth a ping (a review requested,
//   CI failing, an approval or changes requested on your pull request, a
//   merge, a new issue, an assignment, a mention), goes to the bell; what
//   arrives within 6 s goes as one notification, like Gmail's;
// - the backlog never pings: the threads already there when winotch starts
//   (or when the pill is switched on, or the account changes) are only listed;
// - a thread read on GitHub marks its notification read here; one marked done
//   there dismisses it;
// - the buttons do only safe things: Open, Mark as done, Re-run a failed CI
//   run. Nothing approves or merges.
//
// The bell is winotch's app registry (apps.rs), where GitHub is one built-in
// app, "github": these are its own notifications. Everything that touches the
// registry goes through `bell` below.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use reqwest::{Method, StatusCode};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Manager};

use crate::i18n::{t, tn};
use crate::log;

/// GitHub in the app registry (apps.rs BUILTINS).
pub const APP_ID: &str = "github";
const API: &str = "https://api.github.com";
/// Same window as Gmail's: what arrives within it is one notification.
pub const COALESCE_MS: u64 = 6_000;
/// GitHub asks for 60 s; we never go faster, whatever it says.
const MIN_POLL_SECS: u64 = 60;
/// Every so many polls, ask without If-Modified-Since: a thread read on
/// github.com does not always move Last-Modified.
const FULL_EVERY: u32 = 5;
/// Pull requests looked up per poll to tell an approval or a merge.
const MAX_LOOKUPS: usize = 10;
/// The unread threads asked for: the feed stays bounded.
const PAGE: usize = 50;

// ── Threads ───────────────────────────────────────────────────────────────────

/// One unread thread of the inbox, as the expanded view lists it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    pub unread: bool,
    /// GitHub's reason: review_requested, ci_activity, mention…
    pub reason: String,
    /// updated_at, milliseconds since 1970.
    pub time: u64,
    pub title: String,
    /// The subject's type: PullRequest, Issue, CheckSuite, Release…
    pub kind: String,
    /// "owner/repo"
    pub repo: String,
    /// Where it opens on github.com.
    pub url: String,
    /// A failed CI run is behind it: it can be re-run.
    pub rerun: bool,
    #[serde(skip)]
    pub subject_url: Option<String>,
    #[serde(skip)]
    pub comment_url: Option<String>,
}

fn s<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// "2026-10-17T12:34:56Z" (or with a fraction or an offset) → ms since 1970.
pub fn parse_time(raw: &str) -> Option<u64> {
    let b = raw.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |from: usize, to: usize| raw.get(from..to)?.parse::<i64>().ok();
    let (y, m, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (hh, mm, ss) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    let mut rest = &raw[19..];
    let mut millis = 0i64;
    if let Some(frac) = rest.strip_prefix('.') {
        let digits: String = frac.chars().take_while(char::is_ascii_digit).collect();
        rest = &frac[digits.len()..];
        millis = format!("{:0<3}", &digits[..digits.len().min(3)]).parse().ok()?;
    }
    let offset_min = match rest {
        "" | "Z" | "z" => 0,
        _ => {
            let sign = match rest.as_bytes()[0] {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let hm = rest[1..].replace(':', "");
            if hm.len() != 4 {
                return None;
            }
            sign * (hm[..2].parse::<i64>().ok()? * 60 + hm[2..].parse::<i64>().ok()?)
        }
    };
    // Days from civil (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + hh * 3600 + mm * 60 + ss - offset_min * 60;
    u64::try_from(secs * 1000 + millis).ok()
}

/// ms since 1970 → "2026-10-17T12:34:56Z", for `since`.
pub fn format_time(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil from days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// A subject's API address → its page on github.com.
pub fn html_url(kind: &str, subject_url: Option<&str>, repo: &str) -> String {
    let repo_page = format!("https://github.com/{repo}");
    if let Some(rest) = subject_url.and_then(|u| u.strip_prefix("https://api.github.com/repos/")) {
        let parts: Vec<&str> = rest.split('/').collect();
        if parts.len() == 4 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))) {
            let base = format!("https://github.com/{}/{}", parts[0], parts[1]);
            match parts[2] {
                "pulls" => return format!("{base}/pull/{}", parts[3]),
                "issues" => return format!("{base}/issues/{}", parts[3]),
                "commits" => return format!("{base}/commit/{}", parts[3]),
                "releases" => return format!("{base}/releases"),
                _ => {}
            }
        }
    }
    match kind {
        "CheckSuite" => format!("{repo_page}/actions"),
        "Discussion" => format!("{repo_page}/discussions"),
        "Release" => format!("{repo_page}/releases"),
        _ if repo.is_empty() => "https://github.com/notifications".into(),
        _ => repo_page,
    }
}

/// A CI thread whose run failed (GitHub titles them "<workflow> workflow run
/// failed for <branch> branch").
fn ci_failed(reason: &str, title: &str) -> bool {
    let title = title.to_ascii_lowercase();
    reason == "ci_activity" && (title.contains("failed") || title.contains("failure"))
}

fn valid_repo(repo: &str) -> bool {
    let mut parts = repo.split('/');
    let ok = |p: Option<&str>| p.is_some_and(|p| !p.is_empty() && p.len() <= 100 && p.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)) && p != "." && p != "..");
    ok(parts.next()) && ok(parts.next()) && parts.next().is_none()
}

fn valid_thread_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 32 && id.bytes().all(|b| b.is_ascii_digit())
}

/// GET /notifications → its threads; anything malformed is skipped.
pub fn parse_threads(root: &Value) -> Vec<Thread> {
    let Some(list) = root.as_array() else { return Vec::new() };
    list.iter()
        .filter_map(|n| {
            let id = match n.get("id")? {
                Value::String(id) => id.clone(),
                Value::Number(id) => id.to_string(),
                _ => return None,
            };
            if !valid_thread_id(&id) {
                return None;
            }
            let subject = n.get("subject")?;
            let repo = n.get("repository").and_then(|r| s(r, "full_name")).unwrap_or("").to_string();
            if !repo.is_empty() && !valid_repo(&repo) {
                return None;
            }
            let reason = s(n, "reason").unwrap_or("").to_string();
            let title = s(subject, "title").unwrap_or("").chars().take(200).collect::<String>();
            let kind = s(subject, "type").unwrap_or("").to_string();
            let subject_url = s(subject, "url").map(str::to_string);
            Some(Thread {
                url: html_url(&kind, subject_url.as_deref(), &repo),
                rerun: ci_failed(&reason, &title),
                id,
                unread: n.get("unread").and_then(Value::as_bool).unwrap_or(true),
                time: s(n, "updated_at").and_then(parse_time).unwrap_or(0),
                comment_url: s(subject, "latest_comment_url").map(str::to_string),
                subject_url,
                reason,
                title,
                kind,
                repo,
            })
        })
        .collect()
}

// ── What is worth a ping ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum What {
    ReviewRequested,
    CiFailed,
    Approved,
    ChangesRequested,
    Merged,
    NewIssue,
    Assigned,
    Mentioned,
}

impl What {
    /// What happened, in the bell's words.
    pub fn label(self) -> String {
        match self {
            What::ReviewRequested => t("Review requested"),
            What::CiFailed => t("CI failed"),
            What::Approved => t("Approved"),
            What::ChangesRequested => t("Changes requested"),
            What::Merged => t("Merged"),
            What::NewIssue => t("New issue"),
            What::Assigned => t("Assigned to you"),
            What::Mentioned => t("Mentioned you"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Candidate {
    Now(What),
    /// A pull request of yours, or one you follow closely: the pull request
    /// says whether it was approved, sent back or merged.
    LookUp,
}

/// From the thread alone: what it is, whether the pull request must be looked
/// at, or nothing worth a ping (it is still listed).
pub fn candidate(thread: &Thread) -> Option<Candidate> {
    match thread.reason.as_str() {
        "review_requested" => Some(Candidate::Now(What::ReviewRequested)),
        "ci_activity" => thread.rerun.then_some(Candidate::Now(What::CiFailed)),
        "mention" | "team_mention" => Some(Candidate::Now(What::Mentioned)),
        "assign" => Some(Candidate::Now(What::Assigned)),
        // Watching the repository: only a newly opened issue (nothing said
        // under it yet) is news; each comment on every issue would not be.
        "subscribed" if thread.kind == "Issue" => {
            let fresh = thread.comment_url.is_none() || thread.comment_url == thread.subject_url;
            fresh.then_some(Candidate::Now(What::NewIssue))
        }
        "author" | "state_change" | "comment" | "manual" if thread.kind == "PullRequest" && thread.subject_url.is_some() => {
            Some(Candidate::LookUp)
        }
        _ => None,
    }
}

/// How close an event must be to the thread's update to be what moved it.
const NEAR_MS: u64 = 10 * 60 * 1000;

fn near(a: u64, b: u64) -> bool {
    a.abs_diff(b) <= NEAR_MS
}

/// A pull request thread, read with the pull request (GET pulls/n) and its
/// reviews (GET pulls/n/reviews, oldest first): merged, or (yours) approved
/// or sent back, just now.
pub fn pr_event(thread: &Thread, pr: &Value, reviews: &Value) -> Option<What> {
    let merged = pr.get("merged").and_then(Value::as_bool).unwrap_or(false)
        || pr.get("merged_at").is_some_and(|m| m.is_string());
    if merged && s(pr, "merged_at").and_then(parse_time).is_some_and(|at| near(at, thread.time)) {
        return Some(What::Merged);
    }
    // Only on your own pull request ("author"), where the reviewer is never you.
    if thread.reason != "author" {
        return None;
    }
    let last = reviews.as_array()?.iter().rev().find(|r| {
        matches!(s(r, "state"), Some("APPROVED") | Some("CHANGES_REQUESTED"))
    })?;
    let at = s(last, "submitted_at").and_then(parse_time)?;
    if !near(at, thread.time) {
        return None;
    }
    match s(last, "state") {
        Some("APPROVED") => Some(What::Approved),
        Some("CHANGES_REQUESTED") => Some(What::ChangesRequested),
        _ => None,
    }
}

// ── The backlog rule ──────────────────────────────────────────────────────────

/// The unread threads, and what of them was already seen.
#[derive(Debug, Default)]
pub struct Inbox {
    /// When winotch (or the pill, or this account) started: nothing updated
    /// before it ever pings.
    pub started: u64,
    /// Each unread thread's updated_at when it was last seen.
    seen: HashMap<String, u64>,
    pub unread: Vec<Thread>,
}

impl Inbox {
    pub fn new(started: u64) -> Self {
        Inbox { started, ..Default::default() }
    }

    /// Takes the inbox as GitHub has it now; returns the threads new or
    /// updated since the last look and since winotch started.
    pub fn update(&mut self, threads: Vec<Thread>) -> Vec<Thread> {
        let unread: Vec<Thread> = threads.into_iter().filter(|t| t.unread).collect();
        let fresh = unread
            .iter()
            .filter(|t| t.time > self.started && self.seen.get(&t.id).is_none_or(|&before| t.time > before))
            .cloned()
            .collect();
        self.seen = unread.iter().map(|t| (t.id.clone(), t.time)).collect();
        self.unread = unread;
        fresh
    }

    pub fn ids(&self) -> HashSet<String> {
        self.unread.iter().map(|t| t.id.clone()).collect()
    }

    /// Marked done or read from winotch: gone from the list at once.
    pub fn drop_thread(&mut self, id: &str) {
        self.unread.retain(|t| t.id != id);
        self.seen.remove(id);
    }
}

// ── Coalescing ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub thread: Thread,
    pub what: What,
}

/// What waits for the 6 s window to close.
#[derive(Debug, Default)]
pub struct Burst {
    pending: Vec<Event>,
    opened: Option<u64>,
}

impl Burst {
    /// Adds events; true when this opened the window (the caller flushes it
    /// COALESCE_MS later).
    pub fn add(&mut self, events: Vec<Event>, now: u64) -> bool {
        if events.is_empty() {
            return false;
        }
        for e in events {
            // A thread updated twice within the window is one item, the last.
            self.pending.retain(|p| p.thread.id != e.thread.id);
            self.pending.push(e);
        }
        if self.opened.is_none() {
            self.opened = Some(now);
            return true;
        }
        false
    }

    /// The window's timer (COALESCE_MS after it opened) ran out: all it
    /// gathered, as one notification.
    pub fn take_all(&mut self) -> Vec<Event> {
        self.opened = None;
        std::mem::take(&mut self.pending)
    }

    /// Read on GitHub before the window closed: no need to ping.
    pub fn keep_unread(&mut self, unread: &HashSet<String>) {
        self.pending.retain(|e| unread.contains(&e.thread.id));
    }
}

// ── The notification ──────────────────────────────────────────────────────────

/// What goes to the bell, before the bell's own types (`bell::post`).
#[derive(Debug, Clone, PartialEq)]
pub struct Bell {
    pub title: String,
    pub body: String,
    pub url: String,
    pub importance: &'static str,
    /// (id, label), primary first.
    pub actions: Vec<(&'static str, String)>,
    /// The threads it stands for, with their updated_at.
    pub threads: Vec<(String, u64)>,
    /// The failed CI thread a Re-run press reruns.
    pub ci: Option<Value>,
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// One event: the repository, then what happened and to what, with its
/// buttons. Several: counted, and listed in a line, like Gmail's.
pub fn bell(events: &[Event], quiet: bool) -> Option<Bell> {
    if events.is_empty() {
        return None;
    }
    let importance = if quiet { "low" } else { "normal" };
    let threads = events.iter().map(|e| (e.thread.id.clone(), e.thread.time)).collect();
    if let [only] = events {
        let th = &only.thread;
        let mut actions = vec![("open", t("Open")), ("done", t("Mark as done"))];
        let mut ci = None;
        if only.what == What::CiFailed {
            actions.insert(0, ("rerun", t("Re-run")));
            ci = Some(json!({ "repo": th.repo, "title": th.title, "time": th.time }));
        }
        let body = if th.title.is_empty() { only.what.label() } else { format!("{} — {}", only.what.label(), th.title) };
        return Some(Bell {
            title: if th.repo.is_empty() { "GitHub".into() } else { th.repo.clone() },
            body,
            url: th.url.clone(),
            importance,
            actions,
            threads,
            ci,
        });
    }
    let shown = 4;
    let mut items: Vec<String> = events
        .iter()
        .take(shown)
        .map(|e| {
            let name = e.thread.repo.rsplit('/').next().unwrap_or("");
            if name.is_empty() {
                e.what.label()
            } else {
                crate::i18n::tf("{what} in {repo}", &[("what", &e.what.label()), ("repo", name)])
            }
        })
        .collect();
    if events.len() > shown {
        items.push(crate::i18n::tf("{count} more", &[("count", &(events.len() - shown).to_string())]));
    }
    Some(Bell {
        title: tn("{count} GitHub update", "{count} GitHub updates", events.len() as u64, &[]),
        body: items.join(" · "),
        url: "https://github.com/notifications".into(),
        importance,
        actions: Vec::new(),
        threads,
        ci: None,
    })
}

// ── Mirroring read and done ───────────────────────────────────────────────────

/// A notification in the bell and the threads it stands for.
#[derive(Debug, Clone, PartialEq)]
pub struct Posted {
    pub notification: String,
    pub threads: Vec<(String, u64)>,
}

/// The posted notifications none of whose threads is unread any more, taken
/// out of `posted`.
pub fn settled(posted: &mut Vec<Posted>, unread: &HashSet<String>) -> Vec<Posted> {
    let (gone, kept): (Vec<Posted>, Vec<Posted>) = std::mem::take(posted)
        .into_iter()
        .partition(|p| p.threads.iter().all(|(id, _)| !unread.contains(id)));
    *posted = kept;
    gone
}

/// Settled notifications → (to mark read, to dismiss). `present` is the inbox
/// with read threads too (all=true) since the oldest of them: a thread still
/// there was read; one missing was marked done. Without it (that call
/// failed), read is the safe guess.
pub fn mirror(settled: &[Posted], present: Option<&HashSet<String>>) -> (Vec<String>, Vec<String>) {
    let mut read = Vec::new();
    let mut dismiss = Vec::new();
    for p in settled {
        let done = present.is_some_and(|there| p.threads.iter().all(|(id, _)| !there.contains(id)));
        if done {
            dismiss.push(p.notification.clone());
        } else {
            read.push(p.notification.clone());
        }
    }
    (read, dismiss)
}

/// A thread re-pinged or done from winotch leaves its older notification;
/// a notification left with none is returned, to dismiss.
pub fn release(posted: &mut Vec<Posted>, thread: &str) -> Vec<String> {
    let mut empty = Vec::new();
    for p in posted.iter_mut() {
        p.threads.retain(|(id, _)| id != thread);
        if p.threads.is_empty() {
            empty.push(p.notification.clone());
        }
    }
    posted.retain(|p| !p.threads.is_empty());
    empty
}

/// The threads a notification carries in its `meta` (`bell::post`).
pub fn meta_threads(meta: &Value) -> Vec<(String, u64)> {
    meta.get("threads")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|t| Some((s(t, "id")?.to_string(), t.get("time").and_then(Value::as_u64).unwrap_or(0))))
                .filter(|(id, _)| valid_thread_id(id))
                .collect()
        })
        .unwrap_or_default()
}

// ── Re-run ────────────────────────────────────────────────────────────────────

/// "<workflow> workflow run failed for <branch> branch" → (workflow, branch).
pub fn parse_ci_title(title: &str) -> (Option<String>, Option<String>) {
    let lower = title.to_ascii_lowercase();
    let workflow = lower.find(" workflow run").map(|at| title[..at].trim().to_string()).filter(|w| !w.is_empty());
    let branch = lower.rfind(" for ").and_then(|at| {
        let rest = &title[at + 5..];
        let rest_lower = rest.to_ascii_lowercase();
        rest_lower.strip_suffix(" branch").map(|_| rest[..rest.len() - 7].trim().to_string())
    });
    (workflow, branch.filter(|b| !b.is_empty()))
}

fn run_failed(run: &Value) -> bool {
    matches!(s(run, "conclusion"), Some("failure") | Some("timed_out") | Some("startup_failure"))
}

/// GET actions/runs → the failed run a CI thread stands for: same workflow and
/// branch when the title says, closest in time to the thread, within 2 h.
pub fn pick_run(runs: &Value, workflow: Option<&str>, branch: Option<&str>, near_ms: u64) -> Option<u64> {
    let list = runs.get("workflow_runs").and_then(Value::as_array)?;
    let best = |by_name: bool| {
        list.iter()
            .filter(|r| run_failed(r))
            .filter(|r| !by_name || workflow.is_none_or(|w| s(r, "name").is_some_and(|n| n.eq_ignore_ascii_case(w))))
            .filter(|r| branch.is_none_or(|b| s(r, "head_branch") == Some(b)))
            .filter_map(|r| {
                let at = s(r, "updated_at").and_then(parse_time)?;
                Some((at.abs_diff(near_ms), r.get("id")?.as_u64()?))
            })
            .filter(|(gap, _)| *gap <= 2 * 3600 * 1000)
            .min_by_key(|(gap, _)| *gap)
            .map(|(_, id)| id)
    };
    best(true).or_else(|| best(false))
}

/// GET actions/runs?head_sha= → its failed runs.
pub fn failed_runs(runs: &Value) -> Vec<u64> {
    runs.get("workflow_runs")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter(|r| run_failed(r)).filter_map(|r| r.get("id")?.as_u64()).collect())
        .unwrap_or_default()
}

/// "owner/repo@sha", as the expanded view sends it.
pub fn parse_sha_target(id: &str) -> Option<(&str, &str)> {
    let (repo, sha) = id.rsplit_once('@')?;
    let sha_ok = (7..=40).contains(&sha.len()) && sha.bytes().all(|b| b.is_ascii_hexdigit());
    (valid_repo(repo) && sha_ok).then_some((repo, sha))
}

// ── The state ─────────────────────────────────────────────────────────────────

struct Notifier {
    inbox: Inbox,
    burst: Burst,
    posted: Vec<Posted>,
    last_modified: Option<String>,
    interval: u64,
    polls: u32,
    /// The bell's GitHub notifications from before were read back once.
    loaded: bool,
}

impl Notifier {
    fn new(started: u64) -> Self {
        Notifier {
            inbox: Inbox::new(started),
            burst: Burst::default(),
            posted: Vec::new(),
            last_modified: None,
            interval: MIN_POLL_SECS,
            polls: 0,
            loaded: false,
        }
    }
}

static STATE: LazyLock<Mutex<Notifier>> = LazyLock::new(|| Mutex::new(Notifier::new(now_ms())));
/// Bumped on a reset: an answer for the old account is dropped.
static GENERATION: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Starts over as if winotch had just started: the inbox as it is now is the
/// backlog. On a pill switched off, another account, a new token.
pub fn reset() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    // The bell's notifications stay: whose threads they stand for is read
    // back from them at the next poll (`loaded`).
    *STATE.lock().unwrap() = Notifier::new(now_ms());
}

/// At launch, once the bell exists (apps::start): GitHub's notifications
/// from before answer their buttons even while the pill is off.
pub fn setup(app: &AppHandle) {
    bell::register(app);
}

/// The poller, next to the pulse's (integrations.rs starts and stops it).
pub fn spawn(app: AppHandle) -> JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        reset();
        let mut wait = Duration::from_secs(12);
        loop {
            tokio::time::sleep(wait).await;
            let next = poll(&app).await;
            wait = Duration::from_secs(next.max(MIN_POLL_SECS));
        }
    })
}

fn gh(method: Method, url: &str, token: &str) -> reqwest::RequestBuilder {
    crate::integrations::client()
        .request(method, url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "winotch")
}

async fn get_json(url: &str, token: &str) -> Result<Value, String> {
    let response = gh(Method::GET, url, token).send().await.map_err(|_| t("No connection"))?;
    if !response.status().is_success() {
        return Err(crate::i18n::tf("API error {code}", &[("code", &response.status().as_u16().to_string())]));
    }
    let body = crate::net::read_capped(response, crate::net::MAX_BODY).await?;
    serde_json::from_slice(&body).map_err(|e| e.to_string())
}

/// GitHub may not open the island (Settings → Apps): its news waits behind the bell.
fn quiet(app: &AppHandle) -> bool {
    crate::apps::is_muted(app, APP_ID)
}

/// One look at the inbox. Returns the seconds until the next one.
async fn poll(app: &AppHandle) -> u64 {
    if crate::integrations::PAUSED.load(Ordering::Relaxed) || !crate::integrations::enabled(app, APP_ID) {
        return MIN_POLL_SECS;
    }
    let Ok(token) = crate::github_auth::token(app).await else { return MIN_POLL_SECS };
    let generation = GENERATION.load(Ordering::SeqCst);

    // The bell's GitHub notifications from the last run: still mirrored.
    let needs_load = !STATE.lock().unwrap().loaded;
    if needs_load {
        let before = bell::existing(app);
        let mut state = STATE.lock().unwrap();
        state.loaded = true;
        for (notification, threads) in before {
            if !state.posted.iter().any(|p| p.notification == notification) && !threads.is_empty() {
                state.posted.push(Posted { notification, threads });
            }
        }
    }

    let (since, full) = {
        let mut state = STATE.lock().unwrap();
        state.polls = state.polls.wrapping_add(1);
        (state.last_modified.clone(), state.polls % FULL_EVERY == 1)
    };
    let mut request = gh(Method::GET, &format!("{API}/notifications?per_page={PAGE}"), &token);
    if let (Some(since), false) = (&since, full) {
        request = request.header("If-Modified-Since", since);
    }
    let response = match request.send().await {
        Ok(r) => r,
        Err(_) => {
            log::line("github notifications: no connection");
            return STATE.lock().unwrap().interval;
        }
    };
    let interval = response
        .headers()
        .get("X-Poll-Interval")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(MIN_POLL_SECS)
        .max(MIN_POLL_SECS);
    let last_modified = response.headers().get("Last-Modified").and_then(|v| v.to_str().ok()).map(str::to_string);
    STATE.lock().unwrap().interval = interval;
    if response.status() == StatusCode::NOT_MODIFIED {
        return interval;
    }
    if !response.status().is_success() {
        log::line(format!("github notifications HTTP {}", response.status().as_u16()));
        return interval;
    }
    let Ok(body) = crate::net::read_capped(response, crate::net::MAX_BODY).await else { return interval };
    let Ok(root) = serde_json::from_slice::<Value>(&body) else { return interval };
    let threads = parse_threads(&root);

    let (fresh, gone, unread_ids) = {
        let mut state = STATE.lock().unwrap();
        if GENERATION.load(Ordering::SeqCst) != generation {
            return interval;
        }
        state.last_modified = last_modified;
        let fresh = state.inbox.update(threads);
        let ids = state.inbox.ids();
        state.burst.keep_unread(&ids);
        let gone = settled(&mut state.posted, &ids);
        (fresh, gone, ids)
    };
    publish(app);

    // Read on GitHub, or done there?
    if !gone.is_empty() {
        let oldest = gone.iter().flat_map(|p| p.threads.iter().map(|(_, at)| *at)).min().unwrap_or(0);
        let since = format_time(oldest.saturating_sub(1000));
        let url = format!("{API}/notifications?all=true&per_page={PAGE}&since={since}");
        // A full page may have left some out: then missing proves nothing,
        // and read is the safe guess for all of them.
        let present = get_json(&url, &token)
            .await
            .ok()
            .map(|root| parse_threads(&root))
            .filter(|list| list.len() < PAGE)
            .map(|list| list.into_iter().map(|t| t.id).filter(|id| !unread_ids.contains(id)).collect::<HashSet<_>>());
        let (read, dismiss) = mirror(&gone, present.as_ref());
        bell::read_and_dismiss(app, &read, &dismiss);
    }

    // What is new: some pull requests are looked at first.
    let mut events = Vec::new();
    let mut lookups = 0;
    for thread in fresh {
        match candidate(&thread) {
            Some(Candidate::Now(what)) => events.push(Event { thread, what }),
            Some(Candidate::LookUp) if lookups < MAX_LOOKUPS => {
                lookups += 1;
                let Some(pr_url) = thread.subject_url.clone().filter(|u| u.starts_with("https://api.github.com/repos/")) else { continue };
                let Ok(pr) = get_json(&pr_url, &token).await else { continue };
                let reviews = if thread.reason == "author" {
                    get_json(&format!("{pr_url}/reviews?per_page=100"), &token).await.unwrap_or(Value::Null)
                } else {
                    Value::Null
                };
                if let Some(what) = pr_event(&thread, &pr, &reviews) {
                    events.push(Event { thread, what });
                }
            }
            _ => {}
        }
    }
    let opened = {
        let mut state = STATE.lock().unwrap();
        if GENERATION.load(Ordering::SeqCst) != generation {
            return interval;
        }
        state.burst.add(events, now_ms())
    };
    if opened {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(COALESCE_MS)).await;
            if GENERATION.load(Ordering::SeqCst) == generation {
                flush(&app);
            }
        });
    }
    interval
}

/// The window closed: one notification for what it gathered.
fn flush(app: &AppHandle) {
    let events = STATE.lock().unwrap().burst.take_all();
    let Some(b) = bell(&events, quiet(app)) else { return };
    // A thread pinged again leaves its older notification.
    let stale: Vec<String> = {
        let mut state = STATE.lock().unwrap();
        b.threads.iter().flat_map(|(id, _)| release(&mut state.posted, id)).collect()
    };
    bell::read_and_dismiss(app, &[], &stale);
    if let Some(id) = bell::post(app, &b) {
        STATE.lock().unwrap().posted.push(Posted { notification: id, threads: b.threads });
    }
}

/// The unread threads to the GitHub card (the expanded view's first section)
/// and to the app's list (what Claude Code reads through MCP).
fn publish(app: &AppHandle) {
    let unread = STATE.lock().unwrap().inbox.unread.clone();
    crate::integrations::set_github_notifications(app, serde_json::to_value(&unread).unwrap_or(Value::Null));
    bell::set_items(app, &unread);
}

/// Pill switched off: nothing is kept but the bell's notifications; switched
/// on again, it starts silent (integrations.rs clears the card's list).
pub fn stopped() {
    reset();
}

// ── Buttons ───────────────────────────────────────────────────────────────────

async fn act_token(app: &AppHandle) -> Result<String, String> {
    crate::github_auth::token(app).await.map_err(|e| match e {
        crate::github_auth::AuthError::Cli(e) => e.message(),
        crate::github_auth::AuthError::NoToken => t("Key not configured"),
    })
}

/// Mark as done: done on GitHub (DELETE), or read where done is refused.
async fn mark_done(token: &str, thread: &str) -> Result<(), String> {
    let url = format!("{API}/notifications/threads/{thread}");
    let response = gh(Method::DELETE, &url, token).send().await.map_err(|_| t("No connection"))?;
    if response.status().is_success() {
        return Ok(());
    }
    let code = response.status().as_u16();
    if matches!(code, 404 | 405 | 422) {
        let read = gh(Method::PATCH, &url, token).send().await.map_err(|_| t("No connection"))?;
        if read.status().is_success() {
            return Ok(());
        }
        return Err(crate::i18n::tf("API error {code}", &[("code", &read.status().as_u16().to_string())]));
    }
    Err(crate::i18n::tf("API error {code}", &[("code", &code.to_string())]))
}

async fn mark_read(token: &str, thread: &str) -> Result<(), String> {
    let url = format!("{API}/notifications/threads/{thread}");
    let response = gh(Method::PATCH, &url, token).send().await.map_err(|_| t("No connection"))?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(crate::i18n::tf("API error {code}", &[("code", &response.status().as_u16().to_string())]))
    }
}

async fn rerun_run(token: &str, repo: &str, run: u64) -> Result<(), String> {
    let url = format!("{API}/repos/{repo}/actions/runs/{run}/rerun-failed-jobs");
    let response = gh(Method::POST, &url, token).send().await.map_err(|_| t("No connection"))?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(crate::i18n::tf("API error {code}", &[("code", &response.status().as_u16().to_string())]))
    }
}

fn nothing_to_rerun() -> String {
    t("No failed GitHub Actions run to re-run")
}

/// Re-runs the failed jobs of the run a CI thread stands for.
async fn rerun_ci(token: &str, repo: &str, title: &str, time: u64) -> Result<(), String> {
    if !valid_repo(repo) {
        return Err(nothing_to_rerun());
    }
    let (workflow, branch) = parse_ci_title(title);
    let mut url = format!("{API}/repos/{repo}/actions/runs?status=failure&per_page=30");
    if let Some(b) = &branch {
        url.push_str("&branch=");
        url.push_str(&urlencode(b));
    }
    let runs = get_json(&url, token).await?;
    let run = pick_run(&runs, workflow.as_deref(), branch.as_deref(), time).ok_or_else(nothing_to_rerun)?;
    rerun_run(token, repo, run).await
}

/// Re-runs the failed runs of a commit (a pull request's head, a default branch).
async fn rerun_sha(token: &str, repo: &str, sha: &str) -> Result<(), String> {
    let runs = get_json(&format!("{API}/repos/{repo}/actions/runs?head_sha={sha}&per_page=30"), token).await?;
    let failed = failed_runs(&runs);
    if failed.is_empty() {
        return Err(nothing_to_rerun());
    }
    for run in failed {
        rerun_run(token, repo, run).await?;
    }
    Ok(())
}

fn urlencode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Done from winotch: off the list, its notification dismissed.
fn forget_done(app: &AppHandle, thread: &str) {
    let stale = {
        let mut state = STATE.lock().unwrap();
        state.inbox.drop_thread(thread);
        let ids = state.inbox.ids();
        state.burst.keep_unread(&ids);
        release(&mut state.posted, thread)
    };
    bell::read_and_dismiss(app, &[], &stale);
    publish(app);
}

/// A CI thread still listed, for its Re-run.
fn ci_thread(thread: &str) -> Option<(String, String, u64)> {
    let state = STATE.lock().unwrap();
    state.inbox.unread.iter().find(|t| t.id == thread && t.rerun).map(|t| (t.repo.clone(), t.title.clone(), t.time))
}

/// One button, wherever it was pressed: "done" and "read" take a thread id,
/// "rerun" a CI thread's id, "rerun-sha" "owner/repo@sha".
async fn act(app: &AppHandle, kind: &str, id: &str) -> Result<(), String> {
    match kind {
        "done" | "read" => {
            if !valid_thread_id(id) {
                return Err(t("That notification is gone"));
            }
            let token = act_token(app).await?;
            if kind == "done" {
                mark_done(&token, id).await?;
            } else {
                mark_read(&token, id).await?;
            }
            forget_done(app, id);
            Ok(())
        }
        "rerun" => {
            let (repo, title, time) = ci_thread(id).ok_or_else(nothing_to_rerun)?;
            let token = act_token(app).await?;
            rerun_ci(&token, &repo, &title, time).await?;
            crate::integrations::wake_github_pulse();
            Ok(())
        }
        "rerun-sha" => {
            let (repo, sha) = parse_sha_target(id).ok_or_else(nothing_to_rerun)?;
            let token = act_token(app).await?;
            rerun_sha(&token, repo, sha).await?;
            crate::integrations::wake_github_pulse();
            Ok(())
        }
        _ => Err(format!("unknown action {kind}")),
    }
}

/// The expanded view's buttons (core/app-detail.ts).
#[tauri::command]
pub async fn github_act(app: AppHandle, kind: String, id: String) -> Result<(), String> {
    act(&app, &kind, &id).await
}

/// A press in the bell on one of GitHub's notifications: `notification` is
/// its id, `url` and `meta` what it was posted with.
pub async fn press_notification(
    app: &AppHandle,
    notification: &str,
    action: &str,
    url: Option<&str>,
    meta: Option<&Value>,
) -> Result<(), String> {
    let threads = meta.map(meta_threads).unwrap_or_default();
    match action {
        "open" => {
            if let Some(url) = url.filter(|u| u.starts_with("https://github.com/")) {
                crate::platform::open_url(url);
            }
            // Only a link: the buttons stay.
            bell::keep_buttons(app, notification);
            Ok(())
        }
        "done" => {
            let token = act_token(app).await?;
            for (thread, _) in &threads {
                mark_done(&token, thread).await?;
            }
            for (thread, _) in &threads {
                forget_done(app, thread);
            }
            bell::read_and_dismiss(app, &[], &[notification.to_string()]);
            Ok(())
        }
        "rerun" => {
            let ci = meta.and_then(|m| m.get("ci")).ok_or_else(nothing_to_rerun)?;
            let repo = s(ci, "repo").unwrap_or("");
            let title = s(ci, "title").unwrap_or("");
            let time = ci.get("time").and_then(Value::as_u64).unwrap_or(0);
            let token = act_token(app).await?;
            rerun_ci(&token, repo, title, time).await?;
            crate::integrations::wake_github_pulse();
            // Re-run once: the buttons stay for Open and Mark as done.
            bell::keep_buttons(app, notification);
            Ok(())
        }
        _ => Err(format!("unknown action {action}")),
    }
}

/// A press on an item of the app's list (a thread): same as the expanded view.
pub async fn press_item(app: &AppHandle, item: &str, action: &str) -> Result<(), String> {
    act(app, action, item).await
}

// ── The bell (apps.rs) ────────────────────────────────────────────────────────
//
// The one place that knows apps.rs's API: when it changes, only this changes.

mod bell {
    use super::*;
    use crate::apps::{self, Action, AppItems, Apps, ListItem, ListSection, NewNotification, Press};

    /// GitHub is always in the registry (a built-in); its presses come here.
    pub fn register(_app: &AppHandle) {
        apps::set_internal_handler(
            APP_ID,
            std::sync::Arc::new(|app, press| Box::pin(async move { on_press(&app, press).await })),
        );
    }

    async fn on_press(app: &AppHandle, press: Press) -> Result<(), String> {
        match press {
            Press::Notification { notification, action } => {
                press_notification(app, &notification.id, &action, notification.url.as_deref(), notification.meta.as_ref()).await
            }
            Press::Item { item, action } => match action.as_str() {
                "open" => {
                    if let Some(url) = item.url.as_deref().filter(|u| u.starts_with("https://github.com/")) {
                        crate::platform::open_url(url);
                    }
                    Ok(())
                }
                _ => press_item(app, &item.id, &action).await,
            },
        }
    }

    pub fn post(app: &AppHandle, b: &Bell) -> Option<String> {
        let mut meta = json!({
            "threads": b.threads.iter().map(|(id, time)| json!({ "id": id, "time": time })).collect::<Vec<_>>(),
        });
        if let Some(ci) = &b.ci {
            meta["ci"] = ci.clone();
        }
        let notice = NewNotification {
            title: b.title.clone(),
            body: Some(b.body.clone()),
            url: Some(b.url.clone()),
            importance: b.importance,
            actions: b.actions.iter().map(|(id, label)| Action { id: (*id).into(), label: label.clone() }).collect(),
            meta: Some(meta),
            // One thread: the row of the list it is (a click opens GitHub expanded there).
            item: match b.threads.as_slice() {
                [(id, _)] => Some(id.clone()),
                _ => None,
            },
        };
        match apps::post_internal(app, APP_ID, notice) {
            Ok(id) => Some(id),
            Err(e) => {
                log::line(format!("github notifications: not posted: {e}"));
                None
            }
        }
    }

    pub fn read_and_dismiss(app: &AppHandle, read: &[String], dismiss: &[String]) {
        if read.is_empty() && dismiss.is_empty() {
            return;
        }
        if read.len() + dismiss.len() == 1 {
            match (read.first(), dismiss.first()) {
                (Some(id), _) => apps::read_internal(app, id),
                (_, Some(id)) => apps::dismiss_internal(app, id),
                _ => {}
            }
            return;
        }
        if let Some(apps) = app.try_state::<Apps>() {
            apps.read_and_dismiss(read, dismiss);
            apps::changed(app);
        }
    }

    /// Its notifications still in the bell, with the threads each stands for.
    pub fn existing(app: &AppHandle) -> Vec<(String, Vec<(String, u64)>)> {
        app.try_state::<Apps>()
            .map(|apps| {
                apps.notifications_of(APP_ID)
                    .into_iter()
                    .map(|n| (n.id, n.meta.as_ref().map(meta_threads).unwrap_or_default()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// A press that only opened a link: its buttons stay.
    pub fn keep_buttons(app: &AppHandle, notification: &str) {
        if let Some(apps) = app.try_state::<Apps>() {
            apps.set_acted(notification, None);
            apps::changed(app);
        }
    }

    /// The unread threads as the app's list (what Claude Code reads through MCP).
    pub fn set_items(app: &AppHandle, unread: &[Thread]) {
        let items: Vec<ListItem> = unread.iter().take(50).map(item).collect();
        let status = if items.is_empty() {
            t("No unread notifications")
        } else {
            tn("{count} unread notification", "{count} unread notifications", unread.len() as u64, &[])
        };
        let sections = if items.is_empty() { Vec::new() } else { vec![ListSection { title: None, items }] };
        apps::set_internal_items(app, APP_ID, Some(AppItems { status: Some(status), sections, updated: now_ms(), views: Vec::new() }));
    }

    fn item(th: &Thread) -> ListItem {
        let mut actions = vec![
            Action { id: "open".into(), label: t("Open") },
            Action { id: "done".into(), label: t("Mark as done") },
        ];
        if th.rerun {
            actions.insert(0, Action { id: "rerun".into(), label: t("Re-run") });
        }
        ListItem {
            id: th.id.clone(),
            title: clip(&th.title, 200),
            subtitle: Some(clip(&format!("{} · {}", th.repo, th.reason), 300)),
            time: Some(th.time),
            unread: true,
            url: Some(th.url.clone()),
            actions,
            ..Default::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const START: u64 = 1_800_000_000_000;

    fn thread(id: &str, reason: &str, kind: &str, time: u64) -> Thread {
        let subject_url = match kind {
            "PullRequest" => Some(format!("https://api.github.com/repos/me/app/pulls/{id}")),
            "Issue" => Some(format!("https://api.github.com/repos/me/app/issues/{id}")),
            _ => None,
        };
        Thread {
            id: id.into(),
            unread: true,
            reason: reason.into(),
            time,
            title: format!("Thread {id}"),
            kind: kind.into(),
            repo: "me/app".into(),
            url: html_url(kind, subject_url.as_deref(), "me/app"),
            rerun: false,
            comment_url: subject_url.clone(),
            subject_url,
        }
    }

    fn ev(id: &str, what: What) -> Event {
        Event { thread: thread(id, "review_requested", "PullRequest", START + 1), what }
    }

    // Times and links ─────────────────────────────────────────────────────────

    #[test]
    fn reads_and_writes_github_times() {
        assert_eq!(parse_time("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_time("2026-10-17T12:34:56Z"), Some(1_792_240_496_000));
        assert_eq!(parse_time("2026-10-17T12:34:56.250Z"), Some(1_792_240_496_250));
        assert_eq!(parse_time("2026-10-17T14:34:56+02:00"), Some(1_792_240_496_000));
        assert_eq!(parse_time("2024-02-29T00:00:00Z"), Some(1_709_164_800_000));
        assert_eq!(parse_time("yesterday"), None);
        assert_eq!(parse_time("2026-13-01T00:00:00Z"), None);
        for ms in [0, 1_709_164_800_000, 1_792_240_496_000] {
            assert_eq!(parse_time(&format_time(ms)), Some(ms));
        }
        assert_eq!(format_time(1_792_240_496_000), "2026-10-17T12:34:56Z");
    }

    #[test]
    fn subjects_open_on_github_com() {
        let api = |rest: &str| format!("https://api.github.com/repos/me/app/{rest}");
        assert_eq!(html_url("PullRequest", Some(&api("pulls/12")), "me/app"), "https://github.com/me/app/pull/12");
        assert_eq!(html_url("Issue", Some(&api("issues/7")), "me/app"), "https://github.com/me/app/issues/7");
        assert_eq!(html_url("Commit", Some(&api("commits/abc123")), "me/app"), "https://github.com/me/app/commit/abc123");
        assert_eq!(html_url("Release", Some(&api("releases/99")), "me/app"), "https://github.com/me/app/releases");
        assert_eq!(html_url("CheckSuite", None, "me/app"), "https://github.com/me/app/actions");
        assert_eq!(html_url("Discussion", None, "me/app"), "https://github.com/me/app/discussions");
        assert_eq!(html_url("PullRequest", Some("https://evil.example/repos/me/app/pulls/1"), "me/app"), "https://github.com/me/app");
        assert_eq!(html_url("Issue", Some(&api("issues/7?x=<script>")), "me/app"), "https://github.com/me/app");
        assert_eq!(html_url("Issue", None, ""), "https://github.com/notifications");
    }

    #[test]
    fn parses_the_inbox_and_skips_what_is_malformed() {
        let root = json!([
            {
                "id": "123", "unread": true, "reason": "ci_activity", "updated_at": "2026-10-17T12:34:56Z",
                "subject": { "title": "CI workflow run failed for main branch", "type": "CheckSuite", "url": null, "latest_comment_url": null },
                "repository": { "full_name": "me/app" }
            },
            {
                "id": "124", "unread": false, "reason": "review_requested", "updated_at": "2026-10-17T12:00:00Z",
                "subject": { "title": "Fix login", "type": "PullRequest", "url": "https://api.github.com/repos/me/app/pulls/5" },
                "repository": { "full_name": "me/app" }
            },
            { "id": "../etc", "subject": {}, "repository": { "full_name": "me/app" } },
            { "id": "125", "subject": {}, "repository": { "full_name": "me/app/../x" } },
            { "id": "126" }
        ]);
        let threads = parse_threads(&root);
        assert_eq!(threads.len(), 2);
        assert_eq!(threads[0].id, "123");
        assert!(threads[0].rerun);
        assert_eq!(threads[0].url, "https://github.com/me/app/actions");
        assert_eq!(threads[0].time, 1_792_240_496_000);
        assert!(!threads[1].unread);
        assert_eq!(threads[1].url, "https://github.com/me/app/pull/5");
        assert!(parse_threads(&json!({ "message": "Bad credentials" })).is_empty());
    }

    // Reasons ─────────────────────────────────────────────────────────────────

    #[test]
    fn reasons_map_to_what_happened() {
        let at = START + 1;
        assert_eq!(candidate(&thread("1", "review_requested", "PullRequest", at)), Some(Candidate::Now(What::ReviewRequested)));
        assert_eq!(candidate(&thread("1", "mention", "Issue", at)), Some(Candidate::Now(What::Mentioned)));
        assert_eq!(candidate(&thread("1", "team_mention", "PullRequest", at)), Some(Candidate::Now(What::Mentioned)));
        assert_eq!(candidate(&thread("1", "assign", "Issue", at)), Some(Candidate::Now(What::Assigned)));
        assert_eq!(candidate(&thread("1", "author", "PullRequest", at)), Some(Candidate::LookUp));
        assert_eq!(candidate(&thread("1", "state_change", "PullRequest", at)), Some(Candidate::LookUp));

        // CI: only a failure.
        let mut ci = thread("1", "ci_activity", "CheckSuite", at);
        ci.title = "CI workflow run succeeded for main branch".into();
        ci.rerun = ci_failed(&ci.reason, &ci.title);
        assert_eq!(candidate(&ci), None);
        ci.title = "CI workflow run failed for main branch".into();
        ci.rerun = ci_failed(&ci.reason, &ci.title);
        assert_eq!(candidate(&ci), Some(Candidate::Now(What::CiFailed)));

        // Watching a repository: a new issue, not every comment.
        let new_issue = thread("1", "subscribed", "Issue", at);
        assert_eq!(candidate(&new_issue), Some(Candidate::Now(What::NewIssue)));
        let mut commented = new_issue.clone();
        commented.comment_url = Some("https://api.github.com/repos/me/app/issues/comments/9".into());
        assert_eq!(candidate(&commented), None);
        // Nor every pull request of a watched repository, nor a release.
        assert_eq!(candidate(&thread("1", "subscribed", "PullRequest", at)), None);
        assert_eq!(candidate(&thread("1", "subscribed", "Release", at)), None);
        assert_eq!(candidate(&thread("1", "security_alert", "RepositoryVulnerabilityAlert", at)), None);
    }

    #[test]
    fn a_pull_request_says_whether_it_was_approved_sent_back_or_merged() {
        let at = parse_time("2026-10-17T12:00:00Z").unwrap();
        let mine = Thread { time: at, ..thread("5", "author", "PullRequest", at) };
        let open = json!({ "merged": false, "merged_at": null });
        let reviews = |state: &str, when: &str| json!([
            { "state": "COMMENTED", "submitted_at": "2026-10-17T11:00:00Z" },
            { "state": state, "submitted_at": when }
        ]);
        assert_eq!(pr_event(&mine, &open, &reviews("APPROVED", "2026-10-17T11:59:30Z")), Some(What::Approved));
        assert_eq!(pr_event(&mine, &open, &reviews("CHANGES_REQUESTED", "2026-10-17T12:00:00Z")), Some(What::ChangesRequested));
        // An approval from yesterday did not move this thread.
        assert_eq!(pr_event(&mine, &open, &reviews("APPROVED", "2026-10-16T12:00:00Z")), None);
        assert_eq!(pr_event(&mine, &open, &json!([{ "state": "COMMENTED", "submitted_at": "2026-10-17T12:00:00Z" }])), None);

        let merged = json!({ "merged": true, "merged_at": "2026-10-17T11:58:00Z" });
        assert_eq!(pr_event(&mine, &merged, &Value::Null), Some(What::Merged));
        // Someone else's pull request: a merge counts, its reviews do not.
        let theirs = Thread { reason: "state_change".into(), ..mine.clone() };
        assert_eq!(pr_event(&theirs, &merged, &Value::Null), Some(What::Merged));
        assert_eq!(pr_event(&theirs, &open, &reviews("APPROVED", "2026-10-17T12:00:00Z")), None);
    }

    #[test]
    fn every_kind_has_its_words() {
        assert_eq!(What::ReviewRequested.label(), "Review requested");
        assert_eq!(What::CiFailed.label(), "CI failed");
        assert_eq!(What::Approved.label(), "Approved");
        assert_eq!(What::ChangesRequested.label(), "Changes requested");
        assert_eq!(What::Merged.label(), "Merged");
        assert_eq!(What::NewIssue.label(), "New issue");
        assert_eq!(What::Assigned.label(), "Assigned to you");
        assert_eq!(What::Mentioned.label(), "Mentioned you");
    }

    // The backlog ─────────────────────────────────────────────────────────────

    #[test]
    fn the_backlog_never_pings_and_new_threads_ping_once() {
        let mut inbox = Inbox::new(START);
        // Already there when winotch started: listed, silent.
        let backlog = vec![thread("1", "review_requested", "PullRequest", START - 60_000), thread("2", "mention", "Issue", START - 1)];
        assert!(inbox.update(backlog.clone()).is_empty());
        assert_eq!(inbox.unread.len(), 2);

        // A new one arrives: it pings, once.
        let mut now = backlog.clone();
        now.push(thread("3", "assign", "Issue", START + 5_000));
        let fresh = inbox.update(now.clone());
        assert_eq!(fresh.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["3"]);
        assert!(inbox.update(now.clone()).is_empty());

        // An old thread updated after the start pings; read ones are not listed.
        now[0].time = START + 10_000;
        now[1].unread = false;
        let fresh = inbox.update(now);
        assert_eq!(fresh.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["1"]);
        assert_eq!(inbox.ids(), HashSet::from(["1".to_string(), "3".to_string()]));
    }

    #[test]
    fn a_first_look_after_a_slow_start_still_pings_what_came_after_it() {
        let mut inbox = Inbox::new(START);
        let fresh = inbox.update(vec![thread("1", "mention", "Issue", START - 5), thread("2", "mention", "Issue", START + 5)]);
        assert_eq!(fresh.len(), 1);
        assert_eq!(fresh[0].id, "2");
    }

    #[test]
    fn a_thread_read_then_active_again_pings_again() {
        let mut inbox = Inbox::new(START);
        assert_eq!(inbox.update(vec![thread("1", "mention", "Issue", START + 1)]).len(), 1);
        assert!(inbox.update(vec![]).is_empty(), "read on GitHub");
        assert_eq!(inbox.update(vec![thread("1", "mention", "Issue", START + 2)]).len(), 1);
    }

    // Coalescing ──────────────────────────────────────────────────────────────

    #[test]
    fn a_burst_within_six_seconds_is_one_notification() {
        let mut burst = Burst::default();
        assert!(burst.add(vec![ev("1", What::ReviewRequested)], 1_000), "the first opens the window");
        assert!(!burst.add(vec![ev("2", What::Mentioned), ev("3", What::Merged)], 4_000), "the window is open");
        assert!(!burst.add(vec![], 5_000));
        let due = burst.take_all();
        assert_eq!(due.iter().map(|e| e.thread.id.as_str()).collect::<Vec<_>>(), ["1", "2", "3"]);
        assert!(burst.take_all().is_empty());
        // The next one opens a new window; nothing opens one for nothing.
        assert!(!burst.add(vec![], 30_000));
        assert!(burst.add(vec![ev("4", What::Assigned)], 30_001));
        assert_eq!(COALESCE_MS, 6_000, "Gmail's window");
    }

    #[test]
    fn a_thread_twice_in_a_burst_is_one_item_and_one_read_meanwhile_is_dropped() {
        let mut burst = Burst::default();
        burst.add(vec![ev("1", What::ReviewRequested), ev("2", What::Mentioned)], 0);
        burst.add(vec![ev("1", What::Approved)], 1);
        burst.keep_unread(&HashSet::from(["1".to_string()]));
        let due = burst.take_all();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].what, What::Approved);
    }

    #[test]
    fn one_event_is_its_repository_what_happened_and_its_buttons() {
        let b = bell(&[ev("5", What::ReviewRequested)], false).unwrap();
        assert_eq!(b.title, "me/app");
        assert_eq!(b.body, "Review requested — Thread 5");
        assert_eq!(b.url, "https://github.com/me/app/pull/5");
        assert_eq!(b.importance, "normal");
        assert_eq!(b.actions.iter().map(|(id, label)| (*id, label.as_str())).collect::<Vec<_>>(), [("open", "Open"), ("done", "Mark as done")]);
        assert_eq!(b.threads, [("5".to_string(), START + 1)]);
        assert!(b.ci.is_none());
        assert_eq!(bell(&[ev("5", What::Merged)], true).unwrap().importance, "low");
    }

    #[test]
    fn a_failed_run_leads_with_re_run() {
        let mut e = ev("9", What::CiFailed);
        e.thread.title = "CI workflow run failed for main branch".into();
        let b = bell(&[e], false).unwrap();
        assert_eq!(b.actions.iter().map(|(id, _)| *id).collect::<Vec<_>>(), ["rerun", "open", "done"]);
        assert_eq!(b.actions[0].1, "Re-run");
        assert_eq!(b.ci.unwrap()["repo"], "me/app");
    }

    #[test]
    fn several_events_are_counted_and_listed() {
        let events: Vec<Event> = (1..=6).map(|i| ev(&i.to_string(), What::Mentioned)).collect();
        let b = bell(&events[..3], false).unwrap();
        assert_eq!(b.title, "3 GitHub updates");
        assert_eq!(b.body, "Mentioned you in app · Mentioned you in app · Mentioned you in app");
        assert_eq!(b.url, "https://github.com/notifications");
        assert!(b.actions.is_empty());
        assert_eq!(b.threads.len(), 3);
        let many = bell(&events, false).unwrap();
        assert!(many.body.ends_with(" · 2 more"), "{}", many.body);
        assert!(bell(&[], false).is_none());
    }

    // Mirroring ───────────────────────────────────────────────────────────────

    fn posted(id: &str, threads: &[&str]) -> Posted {
        Posted { notification: id.into(), threads: threads.iter().map(|t| (t.to_string(), START)).collect() }
    }

    #[test]
    fn read_on_github_reads_here_and_done_there_dismisses_here() {
        let mut list = vec![posted("n1", &["1"]), posted("n2", &["2", "3"]), posted("n3", &["4"]), posted("n4", &["5", "6"])];
        // Still unread on GitHub: 3. Gone from the unread list: 1, 2, 4, 5, 6.
        let gone = settled(&mut list, &HashSet::from(["3".to_string()]));
        assert_eq!(list, [posted("n2", &["2", "3"])], "one of its threads is still unread");
        assert_eq!(gone.iter().map(|p| p.notification.as_str()).collect::<Vec<_>>(), ["n1", "n3", "n4"]);
        // In the inbox with read ones too: 1 (read) and 6 (read). 4 and 5 are done.
        let present = HashSet::from(["1".to_string(), "6".to_string()]);
        let (read, dismiss) = mirror(&gone, Some(&present));
        assert_eq!(read, ["n1", "n4"]);
        assert_eq!(dismiss, ["n3"]);
        // Without that answer, read is the safe guess.
        let (read, dismiss) = mirror(&gone, None);
        assert_eq!(read, ["n1", "n3", "n4"]);
        assert!(dismiss.is_empty());
    }

    #[test]
    fn a_thread_pinged_again_or_done_leaves_its_older_notification() {
        let mut list = vec![posted("n1", &["1"]), posted("n2", &["2", "3"])];
        assert_eq!(release(&mut list, "1"), ["n1"]);
        assert!(release(&mut list, "2").is_empty());
        assert_eq!(list, [posted("n2", &["3"])]);
        assert_eq!(release(&mut list, "3"), ["n2"]);
        assert!(list.is_empty());
    }

    #[test]
    fn a_notification_carries_its_threads_across_restarts() {
        let meta = json!({ "threads": [{ "id": "11", "time": 5 }, { "id": "x/../y" }, { "time": 3 }], "ci": {} });
        assert_eq!(meta_threads(&meta), [("11".to_string(), 5)]);
        assert!(meta_threads(&json!({ "account": "me@gmail.com" })).is_empty());
    }

    // Re-run ──────────────────────────────────────────────────────────────────

    #[test]
    fn a_ci_title_names_its_workflow_and_branch() {
        assert_eq!(parse_ci_title("CI workflow run failed for main branch"), (Some("CI".into()), Some("main".into())));
        assert_eq!(
            parse_ci_title("Build & test workflow run failed for feature/login branch"),
            (Some("Build & test".into()), Some("feature/login".into()))
        );
        assert_eq!(parse_ci_title("Something failed"), (None, None));
    }

    #[test]
    fn the_run_to_re_run_is_the_failed_one_closest_to_the_thread() {
        let near = parse_time("2026-10-17T12:00:00Z").unwrap();
        let runs = json!({ "workflow_runs": [
            { "id": 1, "name": "CI", "head_branch": "main", "conclusion": "failure", "updated_at": "2026-10-17T08:00:00Z" },
            { "id": 2, "name": "CI", "head_branch": "main", "conclusion": "failure", "updated_at": "2026-10-17T11:59:00Z" },
            { "id": 3, "name": "CI", "head_branch": "main", "conclusion": "success", "updated_at": "2026-10-17T12:00:00Z" },
            { "id": 4, "name": "Lint", "head_branch": "main", "conclusion": "failure", "updated_at": "2026-10-17T12:00:00Z" },
            { "id": 5, "name": "CI", "head_branch": "dev", "conclusion": "failure", "updated_at": "2026-10-17T12:00:00Z" }
        ]});
        assert_eq!(pick_run(&runs, Some("CI"), Some("main"), near), Some(2));
        assert_eq!(pick_run(&runs, Some("Lint"), Some("main"), near), Some(4));
        // Workflow renamed since: the closest failure on that branch.
        assert_eq!(pick_run(&runs, Some("Old"), Some("main"), near), Some(4));
        assert_eq!(pick_run(&runs, None, Some("nope"), near), None);
        assert_eq!(pick_run(&json!({}), None, None, near), None);
        assert_eq!(failed_runs(&runs), [1, 2, 4, 5]);
    }

    #[test]
    fn only_a_repository_and_a_commit_can_be_re_run_by_sha() {
        assert_eq!(parse_sha_target("me/app@0123abc"), Some(("me/app", "0123abc")));
        assert_eq!(parse_sha_target("me/app@nothex!"), None);
        assert_eq!(parse_sha_target("me/../x@0123abc"), None);
        assert_eq!(parse_sha_target("me/app"), None);
        assert!(valid_thread_id("123") && !valid_thread_id("12/../3") && !valid_thread_id(""));
    }
}
