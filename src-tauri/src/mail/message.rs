// What winotch reads out of a mail: the few fields a row shows, a snippet,
// and for Claude Code the whole text. Pure functions over bytes and parsed
// IMAP responses, so all of it is tested without a server.

use std::borrow::Cow;

use async_imap::imap_proto::{AttributeValue, Response};
use mail_parser::{Address, MessageParser, MimeHeaders};
use serde::Serialize;
use serde_json::{json, Value};

use crate::i18n::t;

/// How long a snippet is, in characters.
pub const SNIPPET: usize = 140;
/// The most of one mail's text Claude Code gets back, in characters.
pub(super) const MAX_BODY_CHARS: usize = 20_000;

/// One mail as the island lists it.
#[derive(Debug, Clone, PartialEq)]
pub struct Mail {
    /// In the mailbox it was fetched from (the inbox, for the list).
    pub uid: u32,
    /// Gmail's own ids (X-GM-MSGID, X-GM-THRID): the same in every folder.
    pub msgid: u64,
    pub thrid: u64,
    pub seen: bool,
    /// Milliseconds since 1970: when Gmail received it.
    pub time: u64,
    pub from_name: String,
    pub from_addr: String,
    pub subject: String,
    pub message_id: Option<String>,
    pub snippet: String,
}

impl Mail {
    /// Who sent it, as a person reads it: the name, else the address.
    pub fn sender(&self) -> &str {
        if self.from_name.is_empty() { &self.from_addr } else { &self.from_name }
    }

    pub fn subject_or_none(&self) -> Cow<'_, str> {
        if self.subject.trim().is_empty() { Cow::Owned(t("(no subject)")) } else { Cow::Borrowed(&self.subject) }
    }

    /// What /v1/mail/search answers for it. Ids are strings: Gmail's are past
    /// what a JavaScript number holds exactly.
    pub fn to_json(&self, account: &str) -> Value {
        json!({
            "account": account,
            "id": self.msgid.to_string(),
            "thread": self.thrid.to_string(),
            "messageId": self.message_id,
            "from": { "name": self.from_name, "address": self.from_addr },
            "subject": self.subject,
            "date": self.time,
            "unread": !self.seen,
            "snippet": self.snippet,
            "url": message_link(account, self.msgid),
        })
    }
}

/// The fetched parts of one FETCH response, before the mail is read.
#[derive(Debug, Default)]
pub struct Fetched<'a> {
    pub uid: Option<u32>,
    pub flags: Option<Vec<String>>,
    pub msgid: Option<u64>,
    pub thrid: Option<u64>,
    pub internal_date: Option<String>,
    pub size: Option<u32>,
    pub body: Option<&'a [u8]>,
}

impl Fetched<'_> {
    pub fn seen(&self) -> bool {
        self.flags.as_ref().is_some_and(|f| f.iter().any(|f| f.eq_ignore_ascii_case("\\Seen")))
    }
}

/// The attributes of a FETCH response, or None for any other response.
pub fn fetched<'a>(response: &'a Response<'a>) -> Option<Fetched<'a>> {
    let Response::Fetch(_, attrs) = response else { return None };
    let mut out = Fetched::default();
    for attr in attrs {
        match attr {
            AttributeValue::Uid(uid) => out.uid = Some(*uid),
            AttributeValue::Flags(flags) => out.flags = Some(flags.iter().map(|f| f.to_string()).collect()),
            AttributeValue::GmailMsgId(id) => out.msgid = Some(*id),
            AttributeValue::GmailThrId(id) => out.thrid = Some(*id),
            AttributeValue::InternalDate(date) => out.internal_date = Some(date.to_string()),
            AttributeValue::Rfc822Size(size) => out.size = Some(*size),
            // BODY[] or BODY[]<0>: the message itself (or its start).
            AttributeValue::BodySection { section: None, data: Some(data), .. } => out.body = Some(data.as_ref()),
            AttributeValue::Rfc822(Some(data)) => out.body = Some(data.as_ref()),
            _ => {}
        }
    }
    Some(out)
}

/// A mail from a FETCH of UID, FLAGS, X-GM-MSGID, X-GM-THRID, INTERNALDATE and
/// the start of BODY[].
pub fn mail_from(f: &Fetched) -> Option<Mail> {
    let uid = f.uid?;
    let parsed = f.body.and_then(|b| MessageParser::default().parse(b));
    let (from_name, from_addr) = parsed.as_ref().and_then(|m| first_address(m.from())).unwrap_or_default();
    let time = f
        .internal_date
        .as_deref()
        .and_then(internal_date_ms)
        .or_else(|| parsed.as_ref().and_then(|m| m.date()).map(|d| d.to_timestamp().max(0) as u64 * 1000))
        .unwrap_or(0);
    Some(Mail {
        uid,
        msgid: f.msgid.unwrap_or(0),
        thrid: f.thrid.unwrap_or(0),
        seen: f.seen(),
        time,
        from_name,
        from_addr,
        subject: parsed.as_ref().and_then(|m| m.subject()).map(one_line).unwrap_or_default(),
        message_id: parsed.as_ref().and_then(|m| m.message_id()).map(str::to_string),
        snippet: parsed.as_ref().map(|m| snippet(&m.body_text(0).unwrap_or_default(), SNIPPET)).unwrap_or_default(),
    })
}

/// The name and address of an address field's first mailbox.
fn first_address(address: Option<&Address>) -> Option<(String, String)> {
    let first = address?.first()?;
    Some((first.name().map(one_line).unwrap_or_default(), first.address().unwrap_or_default().to_string()))
}

/// Every mailbox of an address field, as "Name <address>" (or the address).
pub(super) fn addresses(address: Option<&Address>) -> Vec<String> {
    let Some(address) = address else { return Vec::new() };
    address
        .iter()
        .filter_map(|a| {
            let addr = a.address()?;
            Some(match a.name().map(one_line).filter(|n| !n.is_empty()) {
                Some(name) => format!("{name} <{addr}>"),
                None => addr.to_string(),
            })
        })
        .collect()
}

pub(super) fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A mail's opening words: whitespace folded, quoted replies and invisible
/// padding (newsletters pad their preview with zero-width characters) left
/// out, cut at `max` characters with an ellipsis.
pub fn snippet(text: &str, max: usize) -> String {
    let invisible = |c: char| matches!(c, '\u{200b}'..='\u{200f}' | '\u{00ad}' | '\u{034f}' | '\u{2060}' | '\u{feff}');
    let kept: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.starts_with('>'))
        .collect();
    let joined: String = kept.join(" ").chars().filter(|c| !invisible(*c)).collect();
    let folded = one_line(&joined);
    if folded.chars().count() <= max {
        return folded;
    }
    let cut: String = folded.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
}

/// INTERNALDATE ("17-Oct-2026 09:05:00 +0200") as milliseconds since 1970.
pub fn internal_date_ms(date: &str) -> Option<u64> {
    let mut parts = date.trim().split_whitespace();
    let (day_part, time_part, zone) = (parts.next()?, parts.next()?, parts.next()?);
    let mut dmy = day_part.split('-');
    let day: i64 = dmy.next()?.trim().parse().ok()?;
    let name = dmy.next()?;
    let month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
        .iter()
        .position(|m| m.eq_ignore_ascii_case(name))? as i64
        + 1;
    let year: i64 = dmy.next()?.parse().ok()?;
    let mut hms = time_part.split(':').map(|n| n.parse::<i64>().ok());
    let (h, m, s) = (hms.next()??, hms.next()??, hms.next()??);
    let sign = match zone.as_bytes().first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let zone: i64 = zone.get(1..)?.parse().ok()?;
    let offset = sign * ((zone / 100) * 3600 + (zone % 100) * 60);
    let seconds = days_from_civil(year, month, day) * 86_400 + h * 3600 + m * 60 + s - offset;
    u64::try_from(seconds).ok().map(|s| s * 1000)
}

/// Days since 1970-01-01 of a date in the proleptic Gregorian calendar.
pub(super) fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

// ── Links into Gmail on the web ──────────────────────────────────────────────

/// `authuser` picks the right signed-in account, whatever its place (/u/0, /u/1…).
fn gmail_base(account: &str) -> String {
    format!("https://mail.google.com/mail/?authuser={}", query_value(account))
}

/// The message in Gmail: its X-GM-MSGID in hex is the id Gmail's web app uses.
pub fn message_link(account: &str, msgid: u64) -> String {
    format!("{}#all/{msgid:x}", gmail_base(account))
}

pub fn inbox_link(account: &str) -> String {
    format!("{}#inbox", gmail_base(account))
}

pub fn drafts_link(account: &str) -> String {
    format!("{}#drafts", gmail_base(account))
}

/// Percent-encodes everything but the unreserved characters ("+" in an
/// address must not turn into a space).
fn query_value(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

// ── A whole mail, for Claude Code ────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FullMail {
    pub id: String,
    pub thread: String,
    pub message_id: Option<String>,
    pub from: Vec<String>,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub date: u64,
    pub subject: String,
    pub unread: bool,
    /// Plain text: the text part, else the HTML part made readable.
    pub body: String,
    /// The attachments' names only.
    pub attachments: Vec<String>,
    /// Part of it was left out: it was larger than winotch reads, or the text
    /// was longer than it hands over.
    pub truncated: bool,
    pub url: String,
}

/// A whole mail from a FETCH of its BODY[] (or the start of it, `cut` when the
/// mail was larger than what was fetched).
pub fn full_from(account: &str, f: &Fetched, cut: bool) -> Option<FullMail> {
    let parsed = MessageParser::default().parse(f.body?)?;
    let text = parsed.body_text(0).unwrap_or_default();
    let mut body = tidy_body(&text);
    let mut truncated = cut;
    if body.chars().count() > MAX_BODY_CHARS {
        body = body.chars().take(MAX_BODY_CHARS).collect();
        truncated = true;
    }
    let msgid = f.msgid.unwrap_or(0);
    Some(FullMail {
        id: msgid.to_string(),
        thread: f.thrid.unwrap_or(0).to_string(),
        message_id: parsed.message_id().map(str::to_string),
        from: addresses(parsed.from()),
        to: addresses(parsed.to()),
        cc: addresses(parsed.cc()),
        date: f
            .internal_date
            .as_deref()
            .and_then(internal_date_ms)
            .or_else(|| parsed.date().map(|d| d.to_timestamp().max(0) as u64 * 1000))
            .unwrap_or(0),
        subject: parsed.subject().map(one_line).unwrap_or_default(),
        unread: !f.seen(),
        body,
        attachments: parsed.attachments().filter_map(|a| a.attachment_name().map(str::to_string)).collect(),
        truncated,
        url: message_link(account, msgid),
    })
}

/// Text as a person reads it: line ends made one kind, runs of blank lines
/// (HTML converted to text leaves many) folded to one.
pub(super) fn tidy_body(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut blank = 0;
    for line in text.replace("\r\n", "\n").lines() {
        let line = line.trim_end();
        if line.trim().is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.trim().to_string()
}

/// What a reply needs from the mail it answers.
#[derive(Debug, Default, PartialEq)]
pub struct Original {
    pub message_id: Option<String>,
    pub references: Vec<String>,
    pub subject: String,
    /// Reply-To, else From: where a reply goes.
    pub reply_to: Vec<String>,
    pub sender_name: String,
}

pub fn original_from(bytes: &[u8]) -> Option<Original> {
    let parsed = MessageParser::default().parse(bytes)?;
    let references = match parsed.references() {
        mail_parser::HeaderValue::Text(t) => vec![t.to_string()],
        mail_parser::HeaderValue::TextList(list) => list.iter().map(|t| t.to_string()).collect(),
        _ => Vec::new(),
    };
    let reply_to = addresses(parsed.reply_to());
    let from = first_address(parsed.from());
    Some(Original {
        message_id: parsed.message_id().map(str::to_string),
        references,
        subject: parsed.subject().map(one_line).unwrap_or_default(),
        reply_to: if reply_to.is_empty() { addresses(parsed.from()) } else { reply_to },
        sender_name: from.map(|(name, addr)| if name.is_empty() { addr } else { name }).unwrap_or_default(),
    })
}

/// The bare addresses a message goes to (To, Cc and Bcc), for SMTP's envelope.
pub fn recipients(bytes: &[u8]) -> Vec<String> {
    let Some(parsed) = MessageParser::default().parse(bytes) else { return Vec::new() };
    let mut out: Vec<String> = Vec::new();
    for field in [parsed.to(), parsed.cc(), parsed.bcc()] {
        for a in field.iter().flat_map(|a| a.iter()) {
            if let Some(addr) = a.address() {
                if !out.iter().any(|o| o.eq_ignore_ascii_case(addr)) {
                    out.push(addr.to_string());
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A raw IMAP response, parsed as the connection would.
    fn response(raw: &[u8]) -> Response<'_> {
        Response::parse(raw).expect("parses").1
    }

    fn fetch_line(attrs: &str, body: &str) -> Vec<u8> {
        format!("* 7 FETCH ({attrs} BODY[]<0> {{{}}}\r\n{body})\r\n", body.len()).into_bytes()
    }

    const PLAIN: &str = "From: =?utf-8?q?Ana_M=C3=BCller?= <ana@example.com>\r\n\
To: me@gmail.com\r\n\
Subject: Lunch =?utf-8?b?4piV?=\r\n\
Message-ID: <abc@example.com>\r\n\
Date: Sat, 17 Oct 2026 09:05:00 +0200\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
\r\n\
Are you free\r\n\
  on Friday?\r\n\
> an old quoted line\r\n";

    #[test]
    fn a_fetch_becomes_a_mail_with_its_ids_flags_sender_and_snippet() {
        let raw = fetch_line(
            "UID 42 FLAGS (\\Seen \\Flagged) X-GM-MSGID 1780000000000000001 X-GM-THRID 1780000000000000000 INTERNALDATE \"17-Oct-2026 09:05:00 +0200\"",
            PLAIN,
        );
        let r = response(&raw);
        let f = fetched(&r).unwrap();
        let mail = mail_from(&f).unwrap();
        assert_eq!(mail.uid, 42);
        assert_eq!(mail.msgid, 1_780_000_000_000_000_001);
        assert_eq!(mail.thrid, 1_780_000_000_000_000_000);
        assert!(mail.seen);
        assert_eq!(mail.from_name, "Ana Müller");
        assert_eq!(mail.from_addr, "ana@example.com");
        assert_eq!(mail.sender(), "Ana Müller");
        assert_eq!(mail.subject, "Lunch ☕");
        assert_eq!(mail.message_id.as_deref(), Some("abc@example.com"));
        assert_eq!(mail.snippet, "Are you free on Friday?");
        assert_eq!(mail.time, 1_792_220_700_000);
        // Ids leave as strings, which JavaScript reads exactly.
        assert_eq!(mail.to_json("me@gmail.com")["id"], "1780000000000000001");
    }

    #[test]
    fn a_flags_only_fetch_reads_as_seen_or_not() {
        let unseen = response(b"* 3 FETCH (UID 9 FLAGS (\\Answered))\r\n");
        let f = fetched(&unseen).unwrap();
        assert_eq!((f.uid, f.seen()), (Some(9), false));
        let seen = response(b"* 3 FETCH (FLAGS (\\Seen) UID 9)\r\n");
        assert!(fetched(&seen).unwrap().seen());
        assert!(fetched(&response(b"* 4 EXISTS\r\n")).is_none());
    }

    #[test]
    fn an_html_only_mail_gives_readable_text_without_tags_styles_or_padding() {
        let html = "From: News <news@example.com>\r\nSubject: Weekly\r\nContent-Type: text/html; charset=utf-8\r\n\r\n\
<html><head><style>p { color: red }</style></head><body>\
<div style=\"display:none\">\u{200c}\u{200c}\u{200c}</div>\
<p>Hello&nbsp;<b>there</b> &amp; welcome</p><p>Second   line</p></body></html>";
        let raw = fetch_line("UID 1 FLAGS () X-GM-MSGID 1 X-GM-THRID 1", html);
        let r = response(&raw);
        let mail = mail_from(&fetched(&r).unwrap()).unwrap();
        assert!(!mail.seen);
        assert!(!mail.snippet.contains('<') && !mail.snippet.contains("color"), "{}", mail.snippet);
        assert!(mail.snippet.starts_with("Hello there & welcome"), "{}", mail.snippet);
        assert!(mail.snippet.contains("Second line"), "{}", mail.snippet);
    }

    #[test]
    fn a_mail_cut_short_by_a_partial_fetch_still_gives_its_text() {
        // BODY.PEEK[]<0.16384> stops mid-part; the closing boundary never comes.
        let cut = "From: a@b.co\r\nSubject: Big\r\nContent-Type: multipart/mixed; boundary=\"XX\"\r\n\r\n\
--XX\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nThe text comes first.\r\n\
--XX\r\nContent-Type: application/pdf; name=\"a.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK";
        let raw = fetch_line("UID 2 FLAGS () X-GM-MSGID 2 X-GM-THRID 2", cut);
        let r = response(&raw);
        let mail = mail_from(&fetched(&r).unwrap()).unwrap();
        assert_eq!(mail.snippet, "The text comes first.");
        assert_eq!(mail.subject_or_none(), "Big");
    }

    #[test]
    fn snippets_are_cut_with_an_ellipsis_and_never_mid_character() {
        let long = "é".repeat(200);
        let s = snippet(&long, 140);
        assert_eq!(s.chars().count(), 140);
        assert!(s.ends_with('…'));
        assert_eq!(snippet("  short\n\n text ", 140), "short text");
        assert_eq!(snippet("", 140), "");
    }

    #[test]
    fn internal_dates_read_with_their_zone() {
        assert_eq!(internal_date_ms("01-Jan-1970 00:00:00 +0000"), Some(0));
        assert_eq!(internal_date_ms("17-Oct-2026 09:05:00 +0200"), Some(1_792_220_700_000));
        assert_eq!(internal_date_ms(" 1-Mar-2024 12:00:00 -0130"), Some(1_709_299_800_000));
        assert_eq!(internal_date_ms("garbage"), None);
    }

    #[test]
    fn gmail_links_name_the_account_and_the_message_in_hex() {
        assert_eq!(
            message_link("first.last+work@gmail.com", 0x18a2b3c4d5e6f701),
            "https://mail.google.com/mail/?authuser=first.last%2Bwork%40gmail.com#all/18a2b3c4d5e6f701"
        );
        assert_eq!(drafts_link("me@gmail.com"), "https://mail.google.com/mail/?authuser=me%40gmail.com#drafts");
        assert!(inbox_link("me@gmail.com").ends_with("#inbox"));
    }

    #[test]
    fn a_whole_mail_has_its_headers_text_and_attachment_names() {
        let mail = "From: Ana <ana@example.com>\r\nTo: Me <me@gmail.com>, bo@example.com\r\nCc: cy@example.com\r\n\
Subject: Plan\r\nMessage-ID: <p1@example.com>\r\nContent-Type: multipart/mixed; boundary=\"B\"\r\n\r\n\
--B\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>First</p><br><br><br><p>Second</p>\r\n\
--B\r\nContent-Type: application/pdf; name=\"plan.pdf\"\r\nContent-Disposition: attachment; filename=\"plan.pdf\"\r\n\
Content-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK\r\n--B--\r\n";
        let raw = fetch_line("UID 5 FLAGS (\\Seen) X-GM-MSGID 255 X-GM-THRID 254", mail);
        let r = response(&raw);
        let full = full_from("me@gmail.com", &fetched(&r).unwrap(), false).unwrap();
        assert_eq!(full.from, ["Ana <ana@example.com>"]);
        assert_eq!(full.to, ["Me <me@gmail.com>", "bo@example.com"]);
        assert_eq!(full.cc, ["cy@example.com"]);
        assert_eq!(full.subject, "Plan");
        assert_eq!(full.message_id.as_deref(), Some("p1@example.com"));
        assert_eq!(full.attachments, ["plan.pdf"]);
        assert!(full.body.contains("First") && full.body.contains("Second") && !full.body.contains('<'));
        assert!(!full.body.contains("\n\n\n"), "{:?}", full.body);
        assert!(full.url.ends_with("#all/ff"));
        assert!(!full.unread && !full.truncated);
    }

    #[test]
    fn a_reply_knows_where_it_goes_and_what_it_answers() {
        let raw = "From: Ana <ana@example.com>\r\nReply-To: team@example.com\r\nSubject: Plan\r\n\
Message-ID: <p2@example.com>\r\nReferences: <p0@example.com> <p1@example.com>\r\n\r\nHi";
        let o = original_from(raw.as_bytes()).unwrap();
        assert_eq!(o.message_id.as_deref(), Some("p2@example.com"));
        assert_eq!(o.references, ["p0@example.com", "p1@example.com"]);
        assert_eq!(o.reply_to, ["team@example.com"]);
        assert_eq!(o.sender_name, "Ana");
        assert_eq!(recipients(b"To: a@b.co, C <c@d.co>\r\nCc: a@b.co\r\nBcc: e@f.co\r\n\r\nx"), ["a@b.co", "c@d.co", "e@f.co"]);
    }
}
