// What one account's watcher keeps between two looks at the inbox, and the
// decisions it takes from them: which mails are new, which notifications the
// bell should drop or mark read, what the island lists. No network here: the
// watcher (mod.rs) feeds it what IMAP answered.

use std::collections::{BTreeMap, HashMap};

use serde_json::{json, Value};

use super::message::{inbox_link, message_link, Mail};
use crate::apps::{Action, ListItem, ListView, NewNotification};
use crate::i18n::{t, tf};

/// How many of the newest inbox mails the island lists, per account.
pub const WINDOW: u32 = 50;
/// New mail is held this long, so a burst becomes one notification.
pub const BURST_MS: u64 = 6_000;
/// The notifications kept in step with Gmail, per account; older ones go.
pub const MAX_TRACKED: usize = 50;
/// The list's views (its left column on the island): the whole inbox, Gmail's
/// own Primary category, what is unread.
pub const VIEW_INBOX: &str = "inbox";
pub const VIEW_PRIMARY: &str = "primary";
pub const VIEW_UNREAD: &str = "unread";
/// Gmail's search for its Primary tab, run on the inbox at every look.
pub const PRIMARY: &str = "category:primary";

/// The newest inbox mails, by UID.
#[derive(Debug, Default)]
pub struct Inbox {
    pub validity: u32,
    pub mails: BTreeMap<u32, Mail>,
    /// The highest UID seen: anything above it arrived since.
    pub last_uid: u32,
    /// Unread mail in the whole inbox, not only the newest fifty.
    pub unread: usize,
    /// Filled once: until then nothing counts as new, so connecting never
    /// announces the backlog.
    primed: bool,
}

impl Inbox {
    /// Starts over for another UIDVALIDITY: every UID known so far means
    /// nothing now.
    pub fn reset(&mut self, validity: u32) {
        *self = Inbox { validity, ..Default::default() };
    }

    /// The UIDs of the window this inbox does not hold yet: to fetch whole.
    pub fn missing(&self, window: &[(u32, bool)]) -> Vec<u32> {
        window.iter().map(|(uid, _)| *uid).filter(|uid| !self.mails.contains_key(uid)).collect()
    }

    /// Takes the window (each UID with its \Seen) and the mails fetched for
    /// the missing ones. Returns the mails that arrived since the last look,
    /// unread: what the bell may announce.
    pub fn apply(&mut self, window: &[(u32, bool)], fetched: Vec<Mail>) -> Vec<Mail> {
        let mut fetched: HashMap<u32, Mail> = fetched.into_iter().map(|m| (m.uid, m)).collect();
        let mut next = BTreeMap::new();
        for &(uid, seen) in window {
            let mail = self.mails.remove(&uid).or_else(|| fetched.remove(&uid));
            if let Some(mut mail) = mail {
                mail.seen = seen;
                next.insert(uid, mail);
            }
        }
        self.mails = next;
        let arrived: Vec<Mail> = if self.primed {
            self.mails.values().filter(|m| m.uid > self.last_uid && !m.seen).cloned().collect()
        } else {
            Vec::new()
        };
        self.last_uid = self.last_uid.max(self.mails.keys().next_back().copied().unwrap_or(0));
        self.primed = true;
        arrived
    }

    /// Newest first, as the island lists them.
    pub fn newest_first(&self) -> impl Iterator<Item = &Mail> {
        self.mails.values().rev()
    }
}

// ── Bursts ───────────────────────────────────────────────────────────────────

/// New mail waiting to be announced: the first one starts a 6 s wait, and
/// whatever comes in meanwhile joins it.
#[derive(Debug, Default)]
pub struct Burst {
    pending: Vec<Mail>,
    since: Option<u64>,
}

impl Burst {
    pub fn push(&mut self, mails: Vec<Mail>, now: u64) {
        if mails.is_empty() {
            return;
        }
        self.since.get_or_insert(now);
        for mail in mails {
            if !self.pending.iter().any(|p| p.uid == mail.uid) {
                self.pending.push(mail);
            }
        }
    }

    /// How long until the burst is due, if one is waiting.
    pub fn due_in(&self, now: u64) -> Option<u64> {
        self.since.map(|since| (since + BURST_MS).saturating_sub(now))
    }

    /// The burst, once its time has come.
    pub fn take(&mut self, now: u64) -> Option<Vec<Mail>> {
        if self.due_in(now)? > 0 {
            return None;
        }
        self.since = None;
        Some(std::mem::take(&mut self.pending))
    }
}

// ── The bell, kept in step with Gmail ────────────────────────────────────────

/// A notification and the inbox mails it stands for.
#[derive(Debug, Clone, PartialEq)]
pub struct Tracked {
    pub notification: String,
    pub validity: u32,
    pub uids: Vec<u32>,
    pub read: bool,
}

/// What the bell does after a look at the inbox.
#[derive(Debug, Default, PartialEq)]
pub struct Mirror {
    pub read: Vec<String>,
    pub dismiss: Vec<String>,
}

/// `state` holds each tracked mail still in the inbox with its \Seen; a mail
/// absent from it left the inbox (archived, deleted). A notification whose
/// mails are all gone is dismissed; one whose mails are all read is marked
/// read. Past MAX_TRACKED the oldest go, so the feed stays bounded.
pub fn mirror(tracked: &mut Vec<Tracked>, state: &HashMap<u32, bool>) -> Mirror {
    let mut out = Mirror::default();
    tracked.retain_mut(|t| {
        let present: Vec<bool> = t.uids.iter().filter_map(|uid| state.get(uid).copied()).collect();
        if present.is_empty() {
            out.dismiss.push(t.notification.clone());
            return false;
        }
        if !t.read && present.iter().all(|seen| *seen) {
            t.read = true;
            out.read.push(t.notification.clone());
        }
        true
    });
    out.dismiss.extend(bound(tracked));
    out
}

/// Keeps the newest MAX_TRACKED (the list is oldest first) and returns the
/// notifications of the others.
pub fn bound(tracked: &mut Vec<Tracked>) -> Vec<String> {
    let over = tracked.len().saturating_sub(MAX_TRACKED);
    tracked.drain(..over).map(|t| t.notification).collect()
}

/// Every UID the tracked notifications stand for.
pub fn tracked_uids(tracked: &[Tracked]) -> Vec<u32> {
    let mut uids: Vec<u32> = tracked.iter().flat_map(|t| t.uids.iter().copied()).collect();
    uids.sort_unstable();
    uids.dedup();
    uids
}

/// The meta a mail notification carries, so the bell is kept in step again
/// after a restart: the account, the inbox's UIDVALIDITY, the mails.
pub fn mail_meta(account: &str, validity: u32, mails: &[Mail]) -> Value {
    json!({
        "kind": "mail",
        "account": account,
        "validity": validity,
        "uids": mails.iter().map(|m| m.uid).collect::<Vec<_>>(),
        "ids": mails.iter().map(|m| m.msgid.to_string()).collect::<Vec<_>>(),
    })
}

/// The tracking a mail notification's meta describes, if it is one of this account's.
pub fn tracked_from(account: &str, id: &str, read: bool, meta: &Value) -> Option<Tracked> {
    if meta["kind"] != "mail" || meta["account"] != account {
        return None;
    }
    Some(Tracked {
        notification: id.to_string(),
        validity: meta["validity"].as_u64()? as u32,
        uids: meta["uids"].as_array()?.iter().filter_map(|u| u.as_u64().map(|u| u as u32)).collect(),
        read,
    })
}

// ── What the island shows ────────────────────────────────────────────────────

/// An account as the island names it.
pub struct Account<'a> {
    pub email: &'a str,
    pub label: Option<&'a str>,
    pub opens_island: bool,
}

impl Account<'_> {
    pub fn name(&self) -> &str {
        self.label.map(str::trim).filter(|l| !l.is_empty()).unwrap_or(self.email)
    }
}

/// A list item's id: the account and the mail, unique across sections.
pub fn item_id(account: &str, msgid: u64) -> String {
    format!("{account}:{msgid:x}")
}

/// The account and Gmail id an item id names.
pub fn parse_item_id(id: &str) -> Option<(&str, u64)> {
    let (account, hex) = id.rsplit_once(':')?;
    Some((account, u64::from_str_radix(hex, 16).ok()?))
}

/// A mail of the list. `primary`: whether Gmail files it under Primary
/// (None when Gmail did not say). Every mail has details: its whole text,
/// under a byline (who, when: `offset` is this computer's time zone) the pane
/// shows before the text came.
pub fn item(account: &str, mail: &Mail, primary: Option<bool>, offset: i64) -> ListItem {
    let subtitle = if mail.snippet.is_empty() {
        mail.sender().to_string()
    } else {
        format!("{} · {}", mail.sender(), mail.snippet)
    };
    let mut actions = Vec::new();
    if !mail.seen {
        actions.push(Action { id: "read".into(), label: t("Mark read") });
    }
    actions.push(Action { id: "archive".into(), label: t("Archive") });
    let mut views = vec![VIEW_INBOX.to_string()];
    if primary == Some(true) {
        views.push(VIEW_PRIMARY.into());
    }
    if !mail.seen {
        views.push(VIEW_UNREAD.into());
    }
    ListItem {
        id: item_id(account, mail.msgid),
        title: clip(&mail.subject_or_none(), 200),
        subtitle: Some(clip(&subtitle, 300)),
        time: Some(mail.time),
        unread: !mail.seen,
        url: Some(message_link(account, mail.msgid)),
        actions,
        detail: true,
        views: Some(views),
        byline: Some(super::detail::byline(mail.sender(), mail.time, offset)),
    }
}

/// The list's views: Inbox, Primary (when Gmail told it for an account),
/// Unread. Only their words: no counts (the pill says what is unread).
pub fn views(primary: bool) -> Vec<ListView> {
    let mut out = vec![ListView { id: VIEW_INBOX.into(), label: t("Inbox") }];
    if primary {
        out.push(ListView { id: VIEW_PRIMARY.into(), label: t("Primary") });
    }
    out.push(ListView { id: VIEW_UNREAD.into(), label: t("Unread") });
    out
}

/// A mail opened on the island, before Gmail is looked at again: read, its
/// Mark read gone, out of Unread. Returns whether it was unread.
pub fn seen_here(items: &mut [ListItem], id: &str) -> bool {
    let Some(item) = items.iter_mut().find(|i| i.id == id && i.unread) else { return false };
    item.unread = false;
    item.actions.retain(|a| a.id != "read");
    if let Some(views) = item.views.as_mut() {
        views.retain(|v| v != VIEW_UNREAD);
    }
    true
}

/// The pill's line: the unread mail of every account, and whether one needs
/// the user.
pub fn status(unread: usize, failing: usize, connecting: bool) -> String {
    let count = match unread {
        0 if connecting => t("Connecting…"),
        0 => t("No unread mail"),
        n => tf("{n} unread", &[("n", &n.to_string())]),
    };
    match failing {
        0 => count,
        1 => tf("{count} · 1 account needs attention", &[("count", &count)]),
        n => tf("{count} · {n} accounts need attention", &[("count", &count), ("n", &n.to_string())]),
    }
}

/// The notification for a burst of new mail on one account: one mail is the
/// mail itself with its buttons, several are counted. `name_account` (an
/// account other than the first, the default one) adds its name to the count,
/// so the user knows which inbox it is.
pub fn notice(account: &Account, name_account: bool, validity: u32, mails: &[Mail]) -> Option<NewNotification> {
    let first = mails.first()?;
    let importance = if account.opens_island { "normal" } else { "low" };
    let meta = Some(mail_meta(account.email, validity, mails));
    if mails.len() == 1 {
        let body = if first.snippet.is_empty() {
            first.subject_or_none().to_string()
        } else {
            format!("{} — {}", first.subject_or_none(), first.snippet)
        };
        return Some(NewNotification {
            title: first.sender().to_string(),
            body: Some(body),
            url: Some(message_link(account.email, first.msgid)),
            importance,
            actions: vec![
                Action { id: "read".into(), label: t("Mark read") },
                Action { id: "archive".into(), label: t("Archive") },
            ],
            meta,
            // The mail's row: a click on the notification opens it on the island.
            item: Some(item_id(account.email, first.msgid)),
        });
    }
    let mut senders: Vec<&str> = Vec::new();
    for mail in mails {
        if !senders.contains(&mail.sender()) {
            senders.push(mail.sender());
        }
    }
    let shown = 5;
    let mut body = senders.iter().take(shown).copied().collect::<Vec<_>>().join(" · ");
    if senders.len() > shown {
        body.push_str(" · ");
        body.push_str(&tf("{count} more", &[("count", &(senders.len() - shown).to_string())]));
    }
    let n = mails.len().to_string();
    let title = if name_account {
        tf("{n} new emails · {label}", &[("n", &n), ("label", account.name())])
    } else {
        tf("{n} new emails", &[("n", &n)])
    };
    Some(NewNotification {
        title,
        body: Some(body),
        url: Some(inbox_link(account.email)),
        importance,
        actions: Vec::new(),
        meta,
        item: None,
    })
}

fn clip(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mail(uid: u32, seen: bool) -> Mail {
        Mail {
            uid,
            msgid: 1000 + uid as u64,
            thrid: 1,
            seen,
            time: uid as u64,
            from_name: format!("Sender {uid}"),
            from_addr: format!("s{uid}@example.com"),
            subject: format!("Subject {uid}"),
            message_id: None,
            snippet: format!("snippet {uid}"),
        }
    }

    #[test]
    fn connecting_never_announces_the_backlog_and_new_unread_mail_is_announced_once() {
        let mut inbox = Inbox::default();
        inbox.reset(7);
        let window = [(1, false), (2, true)];
        assert_eq!(inbox.missing(&window), [1, 2]);
        assert!(inbox.apply(&window, vec![mail(1, false), mail(2, true)]).is_empty(), "the backlog");
        assert_eq!(inbox.last_uid, 2);

        // Two arrive, one already read elsewhere: only the unread one is news.
        let window = [(1, false), (2, true), (3, false), (4, true)];
        assert_eq!(inbox.missing(&window), [3, 4]);
        let arrived = inbox.apply(&window, vec![mail(3, false), mail(4, true)]);
        assert_eq!(arrived.iter().map(|m| m.uid).collect::<Vec<_>>(), [3]);
        // The same look again: nothing new.
        assert!(inbox.apply(&window, Vec::new()).is_empty());
        assert_eq!(inbox.newest_first().map(|m| m.uid).collect::<Vec<_>>(), [4, 3, 2, 1]);
    }

    #[test]
    fn flags_follow_the_window_and_mails_out_of_it_leave_the_list() {
        let mut inbox = Inbox::default();
        inbox.apply(&[(1, false), (2, false)], vec![mail(1, false), mail(2, false)]);
        // 1 was archived, 2 was read.
        inbox.apply(&[(2, true)], Vec::new());
        assert_eq!(inbox.mails.len(), 1);
        assert!(inbox.mails[&2].seen);
        // A new UIDVALIDITY forgets everything, and is a backlog again.
        inbox.reset(8);
        assert!(inbox.apply(&[(9, false)], vec![mail(9, false)]).is_empty());
    }

    #[test]
    fn a_burst_waits_six_seconds_from_its_first_mail_and_collects_the_rest() {
        let mut burst = Burst::default();
        assert_eq!(burst.due_in(0), None);
        burst.push(Vec::new(), 0);
        assert_eq!(burst.due_in(0), None, "nothing to wait for");
        burst.push(vec![mail(1, false)], 1_000);
        assert_eq!(burst.due_in(1_000), Some(6_000));
        burst.push(vec![mail(2, false), mail(1, false)], 4_000);
        assert_eq!(burst.due_in(4_000), Some(3_000), "a later mail does not push the time back");
        assert!(burst.take(6_999).is_none());
        let due = burst.take(7_000).unwrap();
        assert_eq!(due.iter().map(|m| m.uid).collect::<Vec<_>>(), [1, 2]);
        assert_eq!(burst.due_in(7_000), None);
        assert!(burst.take(99_000).is_none());
    }

    fn tracked(id: &str, uids: &[u32]) -> Tracked {
        Tracked { notification: id.into(), validity: 7, uids: uids.to_vec(), read: false }
    }

    #[test]
    fn the_bell_marks_read_what_was_read_and_drops_what_left_the_inbox() {
        let mut list = vec![tracked("a", &[1]), tracked("b", &[2, 3]), tracked("c", &[4]), tracked("d", &[5, 6])];
        // 1 read in Gmail; 2 read but 3 not; 4 archived; 5 archived, 6 read.
        let state = HashMap::from([(1, true), (2, true), (3, false), (6, true)]);
        let out = mirror(&mut list, &state);
        assert_eq!(out.read, ["a", "d"]);
        assert_eq!(out.dismiss, ["c"]);
        assert_eq!(list.iter().map(|t| t.notification.as_str()).collect::<Vec<_>>(), ["a", "b", "d"]);
        // Marked read once only.
        assert_eq!(mirror(&mut list, &state), Mirror::default());
        // Everything archived: all go.
        let out = mirror(&mut list, &HashMap::new());
        assert_eq!(out.dismiss, ["a", "b", "d"]);
        assert!(list.is_empty());
    }

    #[test]
    fn the_bell_keeps_at_most_fifty_per_account() {
        let mut list: Vec<Tracked> = (0..MAX_TRACKED as u32 + 2).map(|i| tracked(&i.to_string(), &[i])).collect();
        let state: HashMap<u32, bool> = (0..MAX_TRACKED as u32 + 2).map(|i| (i, false)).collect();
        let out = mirror(&mut list, &state);
        assert_eq!(out.dismiss, ["0", "1"], "the oldest");
        assert_eq!(list.len(), MAX_TRACKED);
        assert_eq!(tracked_uids(&[tracked("x", &[3, 1]), tracked("y", &[1])]), [1, 3]);
    }

    #[test]
    fn a_notifications_meta_brings_its_tracking_back_after_a_restart() {
        let meta = mail_meta("me@gmail.com", 7, &[mail(3, false), mail(4, false)]);
        let t = tracked_from("me@gmail.com", "12", false, &meta).unwrap();
        assert_eq!(t, Tracked { notification: "12".into(), validity: 7, uids: vec![3, 4], read: false });
        assert!(tracked_from("other@gmail.com", "12", false, &meta).is_none());
        assert!(tracked_from("me@gmail.com", "12", false, &json!({ "kind": "draft" })).is_none());
    }

    #[test]
    fn one_new_mail_is_the_mail_with_its_buttons_and_several_are_counted() {
        let work = Account { email: "me@work.com", label: Some("Work"), opens_island: true };
        let one = notice(&work, false, 7, &[mail(3, false)]).unwrap();
        assert_eq!(one.title, "Sender 3");
        assert_eq!(one.body.as_deref(), Some("Subject 3 — snippet 3"));
        assert_eq!(one.importance, "normal");
        assert_eq!(one.actions.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["read", "archive"]);
        assert!(one.url.unwrap().ends_with(&format!("#all/{:x}", 1003)));
        assert_eq!(one.item.as_deref(), Some("me@work.com:3eb"), "a click opens that mail");
        assert_eq!(one.meta.unwrap()["uids"], json!([3]));

        let mut same_sender = mail(5, false);
        same_sender.from_name = "Sender 3".into();
        let many = notice(&work, true, 7, &[mail(3, false), mail(4, false), same_sender]).unwrap();
        assert_eq!(many.title, "3 new emails · Work");
        assert_eq!(many.body.as_deref(), Some("Sender 3 · Sender 4"));
        assert!(many.actions.is_empty());
        assert_eq!(many.item, None, "several mails: the inbox, not one of them");
        assert!(many.url.unwrap().ends_with("#inbox"));

        // An account that may not open the island posts quietly.
        let quiet = Account { email: "me@gmail.com", label: None, opens_island: false };
        let n = notice(&quiet, true, 7, &[mail(3, false)]).unwrap();
        assert_eq!(n.importance, "low");
        assert_eq!(n.title, "Sender 3", "one mail is its sender, whichever account");
        let n = notice(&quiet, false, 7, &[mail(3, false), mail(4, false)]).unwrap();
        assert_eq!(n.title, "2 new emails", "the default account is not named");
        assert!(notice(&quiet, false, 7, &[]).is_none());

        let senders: Vec<Mail> = (0..8).map(|i| mail(i, false)).collect();
        assert!(notice(&quiet, false, 7, &senders).unwrap().body.unwrap().ends_with(" · 3 more"));
    }

    #[test]
    fn a_list_item_is_the_mail_with_an_id_unique_across_accounts() {
        let unread = item("me@gmail.com", &mail(3, false), Some(true), 0);
        assert_eq!(unread.id, "me@gmail.com:3eb");
        assert!(unread.detail, "every mail opens on the island");
        assert_eq!(unread.views.as_deref().unwrap(), ["inbox", "primary", "unread"]);
        assert_eq!(parse_item_id(&unread.id), Some(("me@gmail.com", 1003)));
        assert_eq!(unread.title, "Subject 3");
        assert_eq!(unread.subtitle.as_deref(), Some("Sender 3 · snippet 3"));
        assert_eq!(unread.byline.as_deref(), Some("Sender 3 · 1970-01-01 00:00"), "who and when, for the pane at once");
        assert!(unread.unread);
        assert_eq!(unread.actions.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["read", "archive"]);
        let mut read = mail(4, true);
        read.subject = " ".into();
        let read = item("me@gmail.com", &read, Some(false), 0);
        assert_eq!(read.title, "(no subject)");
        assert_eq!(read.views.as_deref().unwrap(), ["inbox"]);
        // Gmail did not say which tab: never in Primary, still in the others.
        assert_eq!(item("me@gmail.com", &mail(5, false), None, 0).views.as_deref().unwrap(), ["inbox", "unread"]);
        assert_eq!(read.actions.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["archive"]);
        assert_eq!(parse_item_id("nonsense"), None);
    }

    #[test]
    fn the_views_are_only_words_and_primary_only_when_gmail_said() {
        let ids = |v: &[ListView]| v.iter().map(|v| v.id.clone()).collect::<Vec<_>>();
        let all = views(true);
        assert_eq!(ids(&all), ["inbox", "primary", "unread"]);
        assert_eq!(all.iter().map(|v| v.label.as_str()).collect::<Vec<_>>(), ["Inbox", "Primary", "Unread"]);
        // On the wire: an id and its words, no count.
        assert_eq!(serde_json::to_value(&all[0]).unwrap(), serde_json::json!({ "id": "inbox", "label": "Inbox" }));
        assert_eq!(ids(&views(false)), ["inbox", "unread"]);
    }

    #[test]
    fn a_mail_opened_here_reads_as_read_at_once() {
        let mut items = vec![item("me@gmail.com", &mail(3, false), Some(true), 0), item("me@gmail.com", &mail(4, true), Some(false), 0)];
        assert!(seen_here(&mut items, "me@gmail.com:3eb"), "it was unread");
        assert!(!items[0].unread);
        assert_eq!(items[0].actions.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["archive"]);
        assert_eq!(items[0].views.as_deref().unwrap(), ["inbox", "primary"]);
        assert!(!seen_here(&mut items, "me@gmail.com:3eb"), "once only");
        assert!(!seen_here(&mut items, "me@gmail.com:3ec"), "already read");
    }

    #[test]
    fn the_status_counts_unread_mail_and_accounts_that_need_the_user() {
        assert_eq!(status(12, 0, false), "12 unread");
        assert_eq!(status(0, 0, false), "No unread mail");
        assert_eq!(status(0, 0, true), "Connecting…");
        assert_eq!(status(3, 1, false), "3 unread · 1 account needs attention");
        assert_eq!(status(0, 2, false), "No unread mail · 2 accounts need attention");
    }
}
