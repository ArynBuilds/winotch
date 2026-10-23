// A mail opened on the island is read in two short fetches instead of whole:
// first its outline (ids, flags, date, headers and BODYSTRUCTURE), then only
// the one part a person reads (its text, else its HTML made readable). The
// attachments' bytes are never fetched: their names come from the outline.
// Pure functions over parsed IMAP responses, tested on recorded ones.

use std::borrow::Cow;

use async_imap::imap_proto::{AttributeValue, BodyStructure, MessageSection, Response, SectionPath};
use mail_parser::MessageParser;

use super::message::{addresses, internal_date_ms, message_link, one_line, tidy_body, FullMail, MAX_BODY_CHARS};

/// The most of a text part fetched: past it the pane says the rest is in Gmail.
pub const TEXT_BYTES: u32 = 256 * 1024;

/// The part of a mail a person reads.
#[derive(Debug, Clone, PartialEq)]
pub struct TextPart {
    /// Its section ("1.1" is [1, 1]); empty: the body of a mail of one part.
    pub section: Vec<u32>,
    /// Its size as sent (encoded).
    pub octets: u32,
}

/// What the first fetch tells of a mail.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Outline {
    pub uid: Option<u32>,
    pub msgid: Option<u64>,
    pub thrid: Option<u64>,
    pub seen: bool,
    pub internal_date: Option<String>,
    /// Its headers, as sent.
    pub header: Vec<u8>,
    /// Where its text is; None: it has none (only attachments).
    pub text: Option<TextPart>,
    pub attachments: Vec<String>,
}

/// The first fetch of a mail's opening.
pub fn outline_command(uid: u32) -> String {
    format!("UID FETCH {uid} (UID FLAGS X-GM-MSGID X-GM-THRID INTERNALDATE BODYSTRUCTURE BODY.PEEK[HEADER])")
}

/// The second: the text part, with its own headers (its charset and
/// encoding), or the body of a mail of one part.
pub fn text_command(uid: u32, part: &TextPart) -> String {
    if part.section.is_empty() {
        return format!("UID FETCH {uid} (UID BODY.PEEK[TEXT]<0.{TEXT_BYTES}>)");
    }
    let s = section_name(&part.section);
    format!("UID FETCH {uid} (UID BODY.PEEK[{s}.MIME] BODY.PEEK[{s}]<0.{TEXT_BYTES}>)")
}

fn section_name(section: &[u32]) -> String {
    section.iter().map(u32::to_string).collect::<Vec<_>>().join(".")
}

/// The outline in a FETCH response, or None for any other response.
pub fn outline_from(response: &Response) -> Option<Outline> {
    let Response::Fetch(_, attrs) = response else { return None };
    let mut out = Outline::default();
    for attr in attrs {
        match attr {
            AttributeValue::Uid(uid) => out.uid = Some(*uid),
            AttributeValue::Flags(flags) => out.seen = flags.iter().any(|f| f.eq_ignore_ascii_case("\\Seen")),
            AttributeValue::GmailMsgId(id) => out.msgid = Some(*id),
            AttributeValue::GmailThrId(id) => out.thrid = Some(*id),
            AttributeValue::InternalDate(date) => out.internal_date = Some(date.to_string()),
            AttributeValue::BodySection { section: Some(SectionPath::Full(MessageSection::Header)), data: Some(data), .. }
            | AttributeValue::Rfc822Header(Some(data)) => out.header = data.to_vec(),
            AttributeValue::BodyStructure(structure) => {
                let mut walk = Walk::default();
                walk.visit(structure, Vec::new());
                out.text = walk.plain.or(walk.html);
                out.attachments = walk.attachments;
            }
            _ => {}
        }
    }
    Some(out)
}

/// The text part in the second fetch's response: (its UID, its own headers, its bytes).
pub fn text_from(response: &Response) -> Option<(Option<u32>, Option<Vec<u8>>, Option<Vec<u8>>)> {
    let Response::Fetch(_, attrs) = response else { return None };
    let (mut uid, mut mime, mut body) = (None, None, None);
    for attr in attrs {
        match attr {
            AttributeValue::Uid(u) => uid = Some(*u),
            AttributeValue::BodySection { section: Some(SectionPath::Part(_, Some(MessageSection::Mime))), data: Some(d), .. } => {
                mime = Some(d.to_vec())
            }
            AttributeValue::BodySection { section: Some(SectionPath::Part(_, None)), data: Some(d), .. }
            | AttributeValue::BodySection { section: Some(SectionPath::Full(MessageSection::Text)), data: Some(d), .. } => {
                body = Some(d.to_vec())
            }
            _ => {}
        }
    }
    Some((uid, mime, body))
}

/// The leaves of a BODYSTRUCTURE: the first plain text and HTML that are not
/// attachments, and the names of what is attached.
#[derive(Default)]
struct Walk {
    plain: Option<TextPart>,
    html: Option<TextPart>,
    attachments: Vec<String>,
}

impl Walk {
    fn visit(&mut self, b: &BodyStructure, section: Vec<u32>) {
        match b {
            BodyStructure::Multipart { bodies, .. } => {
                for (i, child) in bodies.iter().enumerate() {
                    let mut s = section.clone();
                    s.push(i as u32 + 1);
                    self.visit(child, s);
                }
            }
            BodyStructure::Text { common, other, .. } => {
                let attached = common.disposition.as_ref().is_some_and(|d| d.ty.eq_ignore_ascii_case("attachment"));
                let part = TextPart { section: section.clone(), octets: other.octets };
                let sub = common.ty.subtype.to_ascii_lowercase();
                if !attached && sub == "plain" && self.plain.is_none() {
                    self.plain = Some(part);
                } else if !attached && sub == "html" && self.html.is_none() {
                    self.html = Some(part);
                } else if let Some(name) = name_of(common) {
                    self.attachments.push(name);
                }
            }
            BodyStructure::Basic { common, .. } | BodyStructure::Message { common, .. } => {
                if let Some(name) = name_of(common) {
                    self.attachments.push(name);
                }
            }
        }
    }
}

/// An attached part's name: its disposition's filename, else its type's name.
fn name_of(common: &async_imap::imap_proto::BodyContentCommon) -> Option<String> {
    let find = |params: &Option<Vec<(Cow<str>, Cow<str>)>>, key: &str| -> Option<String> {
        let params = params.as_ref()?;
        // RFC 2231 first (filename*=utf-8''na%C3%AFve.pdf), then the plain one.
        if let Some((_, v)) = params.iter().find(|(k, _)| k.eq_ignore_ascii_case(&format!("{key}*"))) {
            return Some(rfc2231(v));
        }
        params.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| decode_words(v))
    };
    let name = common
        .disposition
        .as_ref()
        .and_then(|d| find(&d.params, "filename"))
        .or_else(|| find(&common.ty.params, "name"))?;
    let name = one_line(&name);
    (!name.is_empty()).then_some(name)
}

/// "=?utf-8?B?…?=" words read as text, the way a Subject is.
fn decode_words(value: &str) -> String {
    if !value.contains("=?") {
        return value.to_string();
    }
    let raw = format!("Subject: {value}\r\n\r\n");
    MessageParser::default()
        .parse(raw.as_bytes())
        .and_then(|m| m.subject().map(str::to_string))
        .unwrap_or_else(|| value.to_string())
}

/// "utf-8'en'na%C3%AFve.pdf" read as text.
fn rfc2231(value: &str) -> String {
    let encoded = value.splitn(3, '\'').nth(2).unwrap_or(value);
    let bytes = encoded.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(b) = u8::from_str_radix(hex, 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The mail as the details pane shows it, from its outline and its text part
/// (`mime`: the part's own headers; absent for a mail of one part, whose
/// headers are the mail's).
pub fn full_from_parts(account: &str, outline: &Outline, mime: Option<&[u8]>, text: Option<&[u8]>) -> FullMail {
    let head = MessageParser::default().parse(&outline.header);
    let mut body = String::new();
    if let Some(text) = text {
        let headers = mime.unwrap_or(&outline.header);
        let mut raw = Vec::with_capacity(headers.len() + text.len() + 4);
        raw.extend_from_slice(headers);
        if !raw.ends_with(b"\r\n\r\n") && !raw.ends_with(b"\n\n") {
            raw.extend_from_slice(b"\r\n");
        }
        raw.extend_from_slice(text);
        if let Some(part) = MessageParser::default().parse(&raw) {
            body = tidy_body(&part.body_text(0).unwrap_or_default());
        }
    }
    let mut truncated = outline.text.as_ref().is_some_and(|t| t.octets > TEXT_BYTES);
    if body.chars().count() > MAX_BODY_CHARS {
        body = body.chars().take(MAX_BODY_CHARS).collect();
        truncated = true;
    }
    let msgid = outline.msgid.unwrap_or(0);
    FullMail {
        id: msgid.to_string(),
        thread: outline.thrid.unwrap_or(0).to_string(),
        message_id: head.as_ref().and_then(|m| m.message_id()).map(str::to_string),
        from: addresses(head.as_ref().and_then(|m| m.from())),
        to: addresses(head.as_ref().and_then(|m| m.to())),
        cc: addresses(head.as_ref().and_then(|m| m.cc())),
        date: outline
            .internal_date
            .as_deref()
            .and_then(internal_date_ms)
            .or_else(|| head.as_ref().and_then(|m| m.date()).map(|d| d.to_timestamp().max(0) as u64 * 1000))
            .unwrap_or(0),
        subject: head.as_ref().and_then(|m| m.subject()).map(one_line).unwrap_or_default(),
        unread: !outline.seen,
        body,
        attachments: outline.attachments.clone(),
        truncated,
        url: message_link(account, msgid),
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    /// A literal as IMAP sends it: its length, then its bytes.
    fn literal(bytes: &str) -> String {
        format!("{{{}}}\r\n{bytes}", bytes.len())
    }

    pub const HEADER: &str = "From: =?utf-8?q?Ana_M=C3=BCller?= <ana@example.com>\r\nTo: Me <me@gmail.com>, bo@example.com\r\n\
Cc: cy@example.com\r\nSubject: Plan\r\nMessage-ID: <p1@example.com>\r\nDate: Sat, 17 Oct 2026 09:05:00 +0200\r\n\
Content-Type: multipart/mixed; boundary=\"b0\"\r\n\r\n";

    /// Gmail's answer to the outline of a mail with a text, its HTML twin and
    /// a 3 MB PDF (recorded shape: alternative inside mixed).
    pub fn outline_answer(uid: u32, msgid: u64) -> Vec<u8> {
        format!(
            "* 12 FETCH (X-GM-THRID 1812 X-GM-MSGID {msgid} UID {uid} FLAGS () INTERNALDATE \"17-Oct-2026 09:05:00 +0200\" \
BODYSTRUCTURE (((\"TEXT\" \"PLAIN\" (\"CHARSET\" \"UTF-8\") NIL NIL \"QUOTED-PRINTABLE\" 120 4 NIL NIL NIL)\
(\"TEXT\" \"HTML\" (\"CHARSET\" \"UTF-8\") NIL NIL \"QUOTED-PRINTABLE\" 400 8 NIL NIL NIL) \"ALTERNATIVE\" (\"BOUNDARY\" \"b1\") NIL NIL)\
(\"APPLICATION\" \"PDF\" (\"NAME\" \"plan.pdf\") \"<f1>\" NIL \"BASE64\" 3000000 NIL (\"ATTACHMENT\" (\"FILENAME\" \"plan.pdf\")) NIL)\
(\"IMAGE\" \"PNG\" (\"NAME\" \"=?UTF-8?B?a2FydGUucG5n?=\") NIL NIL \"BASE64\" 2000 NIL (\"ATTACHMENT\" (\"FILENAME*\" \"utf-8''Kr%C3%BCger.png\")) NIL) \
\"MIXED\" (\"BOUNDARY\" \"b0\") NIL NIL) BODY[HEADER] {})\r\n",
            literal(HEADER)
        )
        .into_bytes()
    }

    pub fn text_answer(uid: u32) -> Vec<u8> {
        let mime = "Content-Type: text/plain; charset=\"UTF-8\"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n";
        let body = "Hi,\r\n\r\nThe island ships on Monday. Gr=C3=BC=C3=9Fe\r\n";
        format!("* 12 FETCH (UID {uid} BODY[1.1.MIME] {} BODY[1.1]<0> {})\r\n", literal(mime), literal(body)).into_bytes()
    }

    fn parse(raw: &[u8]) -> Response<'_> {
        Response::parse(raw).expect("parses").1
    }

    #[test]
    fn the_outline_points_at_the_plain_text_and_names_the_attachments_without_their_bytes() {
        let raw = outline_answer(42, 1813);
        let o = outline_from(&parse(&raw)).unwrap();
        assert_eq!((o.uid, o.msgid, o.thrid, o.seen), (Some(42), Some(1813), Some(1812), false));
        assert_eq!(o.text, Some(TextPart { section: vec![1, 1], octets: 120 }), "the plain text, not its HTML twin");
        assert_eq!(o.attachments, ["plan.pdf", "Krüger.png"]);
        assert!(o.header.starts_with(b"From:"));
        assert_eq!(text_command(42, o.text.as_ref().unwrap()), "UID FETCH 42 (UID BODY.PEEK[1.1.MIME] BODY.PEEK[1.1]<0.262144>)");
        assert!(!text_command(42, o.text.as_ref().unwrap()).contains("BODY.PEEK[]"), "never the whole mail");
    }

    #[test]
    fn the_text_part_reads_with_its_own_charset_and_encoding() {
        let o = outline_from(&parse(&outline_answer(42, 1813))).unwrap();
        let raw = text_answer(42);
        let (uid, mime, body) = text_from(&parse(&raw)).unwrap();
        assert_eq!(uid, Some(42));
        let mail = full_from_parts("me@gmail.com", &o, mime.as_deref(), body.as_deref());
        assert_eq!(mail.body, "Hi,\n\nThe island ships on Monday. Grüße");
        assert_eq!(mail.from, ["Ana Müller <ana@example.com>"]);
        assert_eq!(mail.to, ["Me <me@gmail.com>", "bo@example.com"]);
        assert_eq!(mail.cc, ["cy@example.com"]);
        assert_eq!(mail.subject, "Plan");
        assert_eq!(mail.id, "1813");
        assert!(mail.unread && !mail.truncated);
        assert_eq!(mail.attachments, ["plan.pdf", "Krüger.png"]);
        assert_eq!(mail.date, 1_792_220_700_000);
    }

    #[test]
    fn an_html_only_mail_of_one_part_reads_as_text_and_a_long_one_says_so() {
        let header = "From: Shop <news@example.com>\r\nSubject: Sale\r\nContent-Type: text/html; charset=utf-8\r\n\r\n";
        let raw = format!(
            "* 3 FETCH (UID 9 X-GM-MSGID 77 FLAGS (\\Seen) BODYSTRUCTURE (\"TEXT\" \"HTML\" (\"CHARSET\" \"utf-8\") NIL NIL \"7BIT\" 900000 20 NIL NIL NIL) BODY[HEADER] {})\r\n",
            literal(header)
        );
        let o = outline_from(&parse(raw.as_bytes())).unwrap();
        assert_eq!(o.text, Some(TextPart { section: vec![], octets: 900_000 }));
        assert_eq!(text_command(9, o.text.as_ref().unwrap()), "UID FETCH 9 (UID BODY.PEEK[TEXT]<0.262144>)");
        let text = "<p>Big</p><style>p{}</style><p>sale</p>";
        let answer = format!("* 3 FETCH (UID 9 BODY[TEXT]<0> {})\r\n", literal(text));
        let (_, mime, body) = text_from(&parse(answer.as_bytes())).unwrap();
        assert!(mime.is_none());
        let mail = full_from_parts("me@gmail.com", &o, None, body.as_deref());
        assert!(mail.body.contains("Big") && mail.body.contains("sale") && !mail.body.contains('<'), "{:?}", mail.body);
        assert!(mail.truncated, "past what is fetched: the rest is in Gmail");
        assert!(!mail.unread);
    }

    #[test]
    fn a_mail_with_only_an_attachment_has_no_text_part() {
        let raw = format!(
            "* 3 FETCH (UID 9 BODYSTRUCTURE (\"APPLICATION\" \"PDF\" (\"NAME\" \"a.pdf\") NIL NIL \"BASE64\" 10 NIL NIL NIL) BODY[HEADER] {})\r\n",
            literal("Subject: x\r\n\r\n")
        );
        let o = outline_from(&parse(raw.as_bytes())).unwrap();
        assert_eq!(o.text, None);
        assert_eq!(o.attachments, ["a.pdf"]);
        assert_eq!(full_from_parts("me@gmail.com", &o, None, None).body, "");
    }
}
