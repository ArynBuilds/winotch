// A mail opened on the island (a click on its row, WINOTCH.md "Gmail"): its
// text as the expanded view's details pane shows it. Opening a mail marks it
// read, as Gmail does, once it is shown.
//
// It has to feel instant, so it is read the short way: on a connection kept
// open for reads (reader.rs), in the inbox by the UID the list already knows
// (All Mail, found by its \All flag, only for a mail gone from the inbox), and
// only its outline and its text part, never the attachments' bytes
// (parts.rs). The newest mails are read ahead and kept a while (cache.rs).
// The IMAP steps go through `Mailbox`, so their order is tested without a
// server; the whole is bounded (`DETAIL_TIMEOUT`): the pane always ends in
// the mail or one error line.

use std::time::{Duration, Instant};

use super::cache::{Cached, Location};
use super::imap::MailError;
use super::message::{days_from_civil, FullMail};
use super::parts::{full_from_parts, Outline, TextPart};
use crate::apps::{Action, ItemDetail};
use crate::i18n::{t, tf};

/// The longest a mail's opening may take, from connecting to its text. Past
/// it the pane says Gmail did not answer, rather than staying empty.
pub(super) const DETAIL_TIMEOUT: Duration = Duration::from_secs(15);

/// `f`, or Gmail's "no answer" once `limit` has passed.
pub(super) async fn within<T>(limit: Duration, f: impl std::future::Future<Output = Result<T, MailError>>) -> Result<T, MailError> {
    tokio::time::timeout(limit, f).await.unwrap_or_else(|_| Err(MailError::Network(t("Can't reach Gmail: no answer"))))
}

/// The IMAP a mail's opening needs.
pub(super) trait Mailbox {
    /// The name of All Mail, where every mail is, whatever its labels: found
    /// by its \All flag, as Gmail translates the name ("[Gmail]/Tüm Postalar").
    async fn all_mail(&mut self) -> Result<String, MailError>;
    /// Opens a mailbox to change it (to mark a mail read): its UIDVALIDITY.
    async fn select(&mut self, mailbox: &str) -> Result<u32, MailError>;
    async fn search(&mut self, criteria: &str) -> Result<Vec<u32>, MailError>;
    /// A mail's ids, flags, date, headers and BODYSTRUCTURE (parts.rs).
    async fn outline(&mut self, uid: u32) -> Result<Option<Outline>, MailError>;
    /// One part of a mail, read without marking it: its own headers, its bytes.
    async fn text(&mut self, uid: u32, part: &TextPart) -> Result<(Option<Vec<u8>>, Option<Vec<u8>>), MailError>;
    async fn run(&mut self, command: &str) -> Result<(), MailError>;
}

/// How long each step of an opening took, for the log (never what it read).
#[derive(Debug, Default)]
pub(super) struct Steps(Vec<(&'static str, Duration)>);

impl Steps {
    pub fn add(&mut self, step: &'static str, since: Instant) {
        self.0.push((step, since.elapsed()));
    }

    /// "connect 612 ms, select 41 ms, find 63 ms, text 88 ms".
    pub fn line(&self) -> String {
        if self.0.is_empty() {
            return "no step".into();
        }
        self.0.iter().map(|(s, d)| format!("{s} {} ms", d.as_millis())).collect::<Vec<_>>().join(", ")
    }
}

/// Where the list saw the mail: the inbox's UIDVALIDITY and its UID there.
pub(super) type Known = Option<(u32, u32)>;

/// Finds the mail and reads its outline and text, without marking it read
/// (the pane marks it once shown, `mark_read`). None: no such mail.
///
/// In the inbox by the UID the list knows, while the inbox is the one the list
/// saw (its UIDVALIDITY) and the UID still names this mail; else by its Gmail
/// id there; else, gone from the inbox (archived), by its id in All Mail.
pub(super) async fn read_mail(m: &mut impl Mailbox, account: &str, msgid: u64, known: Known, steps: &mut Steps) -> Result<Option<Cached>, MailError> {
    let started = Instant::now();
    let validity = m.select("INBOX").await?;
    steps.add("select", started);
    let started = Instant::now();
    let mut found: Option<(Location, Outline)> = None;
    if let Some((_, uid)) = known.filter(|(v, _)| *v == validity) {
        if let Some(o) = m.outline(uid).await?.filter(|o| o.msgid == Some(msgid)) {
            found = Some((Location { mailbox: "INBOX".into(), validity, uid }, o));
        }
    }
    let by_id = format!("X-GM-MSGID {msgid}");
    if found.is_none() {
        if let Some(uid) = m.search(&by_id).await?.into_iter().next() {
            found = m.outline(uid).await?.map(|o| (Location { mailbox: "INBOX".into(), validity, uid }, o));
        }
    }
    if found.is_none() {
        let all = m.all_mail().await?;
        let validity = m.select(&all).await?;
        if let Some(uid) = m.search(&by_id).await?.into_iter().next() {
            found = m.outline(uid).await?.map(|o| (Location { mailbox: all, validity, uid }, o));
        }
    }
    steps.add("find", started);
    let Some((at, outline)) = found else { return Ok(None) };
    let started = Instant::now();
    let (mime, text) = match &outline.text {
        Some(part) => m.text(at.uid, part).await?,
        None => (None, None),
    };
    steps.add("text", started);
    let mail = full_from_parts(account, &outline, mime.as_deref(), text.as_deref());
    Ok(Some(Cached { mail, at }))
}

/// Marks a mail read where it was found. False: that mailbox is not the one
/// it was found in any more (its UID could name another mail now).
pub(super) async fn mark_read(m: &mut impl Mailbox, at: &Location) -> Result<bool, MailError> {
    if m.select(&at.mailbox).await? != at.validity {
        return Ok(false);
    }
    m.run(&format!("UID STORE {} +FLAGS.SILENT (\\Seen)", at.uid)).await?;
    Ok(true)
}

/// Who sent it, as a person reads it: "Ana Müller" of "Ana Müller <ana@…>".
fn sender_name(from: &str) -> &str {
    match from.rsplit_once(" <") {
        Some((name, _)) if from.ends_with('>') && !name.trim().is_empty() => name.trim(),
        _ => from,
    }
}

/// The line under a mail's subject, shown at once: who and when
/// ("Ana Müller · 2026-10-17 09:05"). The list gives it before the mail came.
pub(super) fn byline(sender: &str, date_ms: u64, offset: i64) -> String {
    let sender = clip(sender, 120);
    if date_ms == 0 {
        return sender;
    }
    if sender.is_empty() {
        return local_date(date_ms, offset);
    }
    format!("{sender} · {}", local_date(date_ms, offset))
}

/// The details pane of a mail: its subject; the sender's name and the date
/// (in this computer's time, `offset` seconds from UTC) under it; From, To
/// and Cc in full behind the pane's details chevron; its text; its
/// attachments' names; Archive and Open in Gmail.
pub(super) fn item_detail(mail: &FullMail, offset: i64) -> ItemDetail {
    let line = |text: String| clip(&text, 300);
    let mut meta = Vec::new();
    if !mail.from.is_empty() {
        meta.push(line(tf("From {from}", &[("from", &mail.from.join(", "))])));
    }
    if !mail.to.is_empty() {
        meta.push(line(tf("To {to}", &[("to", &mail.to.join(", "))])));
    }
    if !mail.cc.is_empty() {
        meta.push(line(tf("Cc {cc}", &[("cc", &mail.cc.join(", "))])));
    }
    let mut body = mail.body.clone();
    if mail.truncated {
        body.push_str("\n\n");
        body.push_str(&t("The rest of this mail is in Gmail."));
    }
    let sender = mail.from.first().map(|f| sender_name(f)).unwrap_or_default();
    ItemDetail {
        title: if mail.subject.trim().is_empty() { t("(no subject)") } else { clip(&mail.subject, 200) },
        byline: Some(byline(sender, mail.date, offset)).filter(|b| !b.is_empty()),
        meta,
        body,
        attachments: mail.attachments.iter().take(20).map(|a| clip(a, 200)).collect(),
        url: Some(mail.url.clone()),
        actions: vec![
            Action { id: "archive".into(), label: t("Archive") },
            Action { id: "open".into(), label: t("Open in Gmail") },
        ],
    }
}

fn clip(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// "2026-10-17 09:05": the same in every language, in this computer's time.
pub(super) fn local_date(ms: u64, offset: i64) -> String {
    let secs = (ms / 1000) as i64 + offset;
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}", rest / 3600, rest % 3600 / 60)
}

/// The date of a day counted from 1970-01-01 (the inverse of `days_from_civil`).
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// How far this computer's clock is from UTC now, in seconds (to the quarter
/// hour): the time zone a mail's date is shown in.
pub(super) fn local_offset() -> i64 {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let l = crate::platform::local_time();
    let local = days_from_civil(l.year.into(), l.month.into(), l.day.into()) * 86_400
        + i64::from(l.hour) * 3600
        + i64::from(l.minute) * 60
        + i64::from(l.second);
    ((local - now) as f64 / 900.0).round() as i64 * 900
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mail::parts::tests::{outline_answer, text_answer};
    use crate::mail::parts::{outline_command, outline_from, text_command, text_from};
    use async_imap::imap_proto::Response;

    /// A Gmail that answers with recorded responses and writes down every
    /// command it was sent. Its mails are (UID, Gmail id) in the inbox and in
    /// All Mail.
    struct Fake {
        inbox: Vec<(u32, u64)>,
        inbox_validity: u32,
        all: Vec<(u32, u64)>,
        /// What LIST says All Mail is called (Gmail translates it).
        all_name: &'static str,
        selected: String,
        refuse_store: bool,
        /// The connection goes quiet: nothing ever answers.
        silent: bool,
        log: Vec<String>,
    }

    impl Fake {
        fn mails(&self) -> &[(u32, u64)] {
            if self.selected == "INBOX" { &self.inbox } else { &self.all }
        }
        async fn quiet(&self) {
            if self.silent {
                std::future::pending::<()>().await;
            }
        }
    }

    impl Mailbox for Fake {
        async fn all_mail(&mut self) -> Result<String, MailError> {
            self.log.push("LIST \"\" \"*\"".into());
            Ok(self.all_name.into())
        }
        async fn select(&mut self, mailbox: &str) -> Result<u32, MailError> {
            self.log.push(format!("SELECT {mailbox}"));
            self.quiet().await;
            self.selected = mailbox.to_string();
            Ok(if mailbox == "INBOX" { self.inbox_validity } else { 3 })
        }
        async fn search(&mut self, criteria: &str) -> Result<Vec<u32>, MailError> {
            self.log.push(format!("UID SEARCH {criteria}"));
            let id: u64 = criteria.trim_start_matches("X-GM-MSGID ").parse().unwrap();
            Ok(self.mails().iter().filter(|(_, m)| *m == id).map(|(u, _)| *u).collect())
        }
        async fn outline(&mut self, uid: u32) -> Result<Option<Outline>, MailError> {
            self.log.push(outline_command(uid));
            let Some(&(_, msgid)) = self.mails().iter().find(|(u, _)| *u == uid) else { return Ok(None) };
            let raw = outline_answer(uid, msgid);
            Ok(outline_from(&Response::parse(&raw).unwrap().1))
        }
        async fn text(&mut self, uid: u32, part: &TextPart) -> Result<(Option<Vec<u8>>, Option<Vec<u8>>), MailError> {
            self.log.push(text_command(uid, part));
            let raw = text_answer(uid);
            let (_, mime, body) = text_from(&Response::parse(&raw).unwrap().1).unwrap();
            Ok((mime, body))
        }
        async fn run(&mut self, command: &str) -> Result<(), MailError> {
            self.log.push(command.to_string());
            if self.refuse_store { Err(MailError::Refused("no".into())) } else { Ok(()) }
        }
    }

    /// Mail 255 in the inbox at UID 42 (UIDVALIDITY 7), as the list saw it.
    fn gmail() -> Fake {
        Fake {
            inbox: vec![(41, 254), (42, 255)],
            inbox_validity: 7,
            all: vec![(9000, 254), (9001, 255)],
            all_name: "[Gmail]/All Mail",
            selected: String::new(),
            refuse_store: false,
            silent: false,
            log: Vec::new(),
        }
    }

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap().block_on(f)
    }

    fn read(m: &mut Fake, known: Known) -> Option<Cached> {
        block_on(read_mail(m, "me@gmail.com", 255, known, &mut Steps::default())).unwrap()
    }

    #[test]
    fn a_mail_the_list_knows_is_read_by_its_uid_in_two_short_fetches() {
        let mut g = gmail();
        let mut steps = Steps::default();
        let found = block_on(read_mail(&mut g, "me@gmail.com", 255, Some((7, 42)), &mut steps)).unwrap().unwrap();
        assert_eq!(g.log, [
            "SELECT INBOX",
            "UID FETCH 42 (UID FLAGS X-GM-MSGID X-GM-THRID INTERNALDATE BODYSTRUCTURE BODY.PEEK[HEADER])",
            "UID FETCH 42 (UID BODY.PEEK[1.1.MIME] BODY.PEEK[1.1]<0.262144>)",
        ]);
        assert!(!g.log.iter().any(|c| c.contains("BODY.PEEK[]") || c.contains("LIST") || c.contains("SEARCH")), "no search, no whole mail");
        assert_eq!(found.at, Location { mailbox: "INBOX".into(), validity: 7, uid: 42 });
        assert_eq!(found.mail.body, "Hi,\n\nThe island ships on Monday. Grüße");
        assert_eq!(found.mail.attachments, ["plan.pdf", "Krüger.png"]);
        assert!(!g.log.iter().any(|c| c.contains("STORE")), "reading marks nothing");
        assert_eq!(steps.0.iter().map(|(s, _)| *s).collect::<Vec<_>>(), ["select", "find", "text"]);
    }

    #[test]
    fn a_uid_the_list_saw_in_another_inbox_or_on_another_mail_is_not_trusted() {
        // UIDVALIDITY changed since the list was drawn: found by its Gmail id.
        let mut g = gmail();
        g.inbox_validity = 8;
        let found = read(&mut g, Some((7, 42))).unwrap();
        assert_eq!(g.log[1], "UID SEARCH X-GM-MSGID 255");
        assert_eq!(found.at.validity, 8);
        // The UID names another mail now: the same.
        let mut g = gmail();
        let found = read(&mut g, Some((7, 41))).unwrap();
        assert!(g.log.contains(&"UID SEARCH X-GM-MSGID 255".to_string()));
        assert_eq!(found.at.uid, 42);
        assert_eq!(found.mail.id, "255");
    }

    #[test]
    fn a_mail_archived_since_is_read_from_all_mail_found_by_its_flag_in_any_language() {
        // A Turkish Gmail: All Mail is "[Gmail]/Tüm Postalar", in modified UTF-7.
        let mut g = gmail();
        g.inbox.retain(|(_, m)| *m != 255);
        g.all_name = "[Gmail]/T&APw-m Postalar";
        let found = read(&mut g, Some((7, 42))).unwrap();
        assert_eq!(g.log, [
            "SELECT INBOX",
            "UID FETCH 42 (UID FLAGS X-GM-MSGID X-GM-THRID INTERNALDATE BODYSTRUCTURE BODY.PEEK[HEADER])",
            "UID SEARCH X-GM-MSGID 255",
            "LIST \"\" \"*\"",
            "SELECT [Gmail]/T&APw-m Postalar",
            "UID SEARCH X-GM-MSGID 255",
            "UID FETCH 9001 (UID FLAGS X-GM-MSGID X-GM-THRID INTERNALDATE BODYSTRUCTURE BODY.PEEK[HEADER])",
            "UID FETCH 9001 (UID BODY.PEEK[1.1.MIME] BODY.PEEK[1.1]<0.262144>)",
        ]);
        assert!(!g.log.iter().any(|c| c.contains("All Mail")), "never by its English name");
        assert_eq!(found.at, Location { mailbox: "[Gmail]/T&APw-m Postalar".into(), validity: 3, uid: 9001 });

        // Nowhere: nothing read, nothing marked.
        let mut gone = gmail();
        gone.inbox.clear();
        gone.all.clear();
        assert!(read(&mut gone, None).is_none());
        assert!(!gone.log.iter().any(|c| c.contains("BODY.PEEK[1") || c.contains("STORE")));
    }

    #[test]
    fn a_mail_is_marked_read_where_it_was_found_and_only_there() {
        let mut g = gmail();
        let at = Location { mailbox: "INBOX".into(), validity: 7, uid: 42 };
        assert!(block_on(mark_read(&mut g, &at)).unwrap());
        assert_eq!(g.log, ["SELECT INBOX", "UID STORE 42 +FLAGS.SILENT (\\Seen)"]);
        // The inbox is another one now: UID 42 may be another mail.
        let mut g = gmail();
        g.inbox_validity = 8;
        assert!(!block_on(mark_read(&mut g, &at)).unwrap());
        assert!(!g.log.iter().any(|c| c.contains("STORE")));
        // Gmail refused: an error, for the log.
        let mut g = gmail();
        g.refuse_store = true;
        assert!(block_on(mark_read(&mut g, &at)).is_err());
    }

    #[test]
    fn a_gmail_that_goes_quiet_ends_in_an_error_not_an_empty_pane() {
        let mut g = gmail();
        g.silent = true;
        let started = Instant::now();
        let result = block_on(within(Duration::from_millis(50), read_mail(&mut g, "me@gmail.com", 255, Some((7, 42)), &mut Steps::default())));
        let err = result.err().expect("no answer is an error");
        assert_eq!(err, MailError::Network("Can't reach Gmail: no answer".into()));
        assert_eq!(err.kind(), "network");
        assert!(started.elapsed() < Duration::from_secs(5));
        // An answer in time comes through as it is.
        let mut quick = gmail();
        let found = block_on(within(DETAIL_TIMEOUT, read_mail(&mut quick, "me@gmail.com", 255, None, &mut Steps::default())));
        assert!(found.unwrap().is_some());
    }

    fn mail() -> FullMail {
        FullMail {
            id: "255".into(),
            thread: "254".into(),
            message_id: None,
            from: vec!["Ana Müller <ana@example.com>".into()],
            to: vec!["Me <me@gmail.com>".into(), "bo@example.com".into()],
            cc: Vec::new(),
            date: 1_792_220_700_000,
            subject: "Plan".into(),
            unread: true,
            body: "First\n\nSecond https://example.com".into(),
            attachments: vec!["plan.pdf".into()],
            truncated: false,
            url: "https://mail.google.com/mail/?authuser=me%40gmail.com#all/ff".into(),
        }
    }

    #[test]
    fn a_mails_details_are_its_byline_headers_text_attachments_and_two_buttons() {
        let d = item_detail(&mail(), 2 * 3600);
        assert_eq!(d.title, "Plan");
        assert_eq!(d.byline.as_deref(), Some("Ana Müller · 2026-10-17 09:05"), "the name and the date, shown at once");
        assert_eq!(d.meta, ["From Ana Müller <ana@example.com>", "To Me <me@gmail.com>, bo@example.com"], "the addresses, behind the chevron");
        assert_eq!(d.body, "First\n\nSecond https://example.com", "line breaks kept, links left as text");
        assert_eq!(d.attachments, ["plan.pdf"]);
        assert!(d.url.unwrap().ends_with("#all/ff"));
        assert_eq!(d.actions.iter().map(|a| (a.id.as_str(), a.label.as_str())).collect::<Vec<_>>(), [("archive", "Archive"), ("open", "Open in Gmail")]);

        let mut other = mail();
        other.subject = "  ".into();
        other.from = vec!["bo@example.com".into()];
        other.cc = vec!["cy@example.com".into()];
        other.truncated = true;
        other.date = 0;
        let d = item_detail(&other, 0);
        assert_eq!(d.title, "(no subject)");
        assert_eq!(d.byline.as_deref(), Some("bo@example.com"), "no name: the address; no date when Gmail gave none");
        assert_eq!(d.meta.last().unwrap(), "Cc cy@example.com");
        assert!(d.body.ends_with("The rest of this mail is in Gmail."));
        assert_eq!(byline("", 1_792_220_700_000, 0), "2026-10-17 07:05");
    }

    #[test]
    fn dates_read_the_same_everywhere_in_the_computers_time() {
        assert_eq!(local_date(0, 0), "1970-01-01 00:00");
        assert_eq!(local_date(1_792_220_700_000, 0), "2026-10-17 07:05");
        assert_eq!(local_date(1_792_220_700_000, -8 * 3600), "2026-10-16 23:05");
        assert_eq!(local_date(951_825_600_000, 0), "2000-02-29 12:00", "a leap day");
        for days in [-1, 0, 59, 11_016, 20_743, 60_000] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
        let offset = local_offset();
        assert!(offset.abs() <= 14 * 3600 && offset % 900 == 0, "{offset}");
    }
}
