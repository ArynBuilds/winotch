// Drafts: the MIME message Claude Code asked for, built by lettre (UTF-8,
// encoded headers, the reply's threading), and its sending over SMTP, which
// only a press on the island starts. Gmail files the sent copy itself.

use std::time::Duration;

use lettre::address::Envelope;
use lettre::message::header::ContentType;
use lettre::message::{Mailbox, Message};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{Address, AsyncSmtpTransport, AsyncTransport, Tokio1Executor};

use super::message::Original;
use crate::i18n::tf;

const SMTP_HOST: &str = "smtp.gmail.com";

/// What a draft says.
#[derive(Debug, Clone, Default)]
pub struct Spec {
    /// The account: the draft is from it.
    pub from: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub subject: String,
    /// Plain text.
    pub body: String,
}

/// The subject of a reply: the one given, else the original's, with one "Re:".
pub fn reply_subject(given: &str, original: &str) -> String {
    let base = if given.trim().is_empty() { original.trim() } else { given.trim() };
    let lower = base.to_ascii_lowercase();
    if lower.starts_with("re:") || lower.starts_with("re :") {
        base.to_string()
    } else {
        format!("Re: {base}")
    }
}

/// A Message-ID of our own, on the account's domain, so the draft can be found
/// again in the Drafts folder.
pub fn new_message_id(from: &str) -> String {
    use ring::rand::{SecureRandom, SystemRandom};
    let mut bytes = [0u8; 12];
    let _ = SystemRandom::new().fill(&mut bytes);
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let domain = from.rsplit_once('@').map_or("winotch.local", |(_, d)| d);
    format!("<{token}.winotch@{domain}>")
}

fn mailbox(text: &str, field: &str) -> Result<Mailbox, String> {
    text.trim().parse::<Mailbox>().map_err(|_| tf("{field}: {text} is not an email address", &[("field", field), ("text", &format!("{text:?}"))]))
}

/// The message, as bytes ready to APPEND and later to send unchanged.
/// `reply` threads it under the mail it answers (In-Reply-To, References).
pub fn build(spec: &Spec, reply: Option<&Original>, message_id: &str) -> Result<Vec<u8>, String> {
    if spec.to.is_empty() && spec.cc.is_empty() {
        return Err("to: at least one address".into());
    }
    let mut builder = Message::builder()
        .from(mailbox(&spec.from, "from")?)
        .subject(spec.subject.trim())
        .message_id(Some(message_id.to_string()));
    for to in &spec.to {
        builder = builder.to(mailbox(to, "to")?);
    }
    for cc in &spec.cc {
        builder = builder.cc(mailbox(cc, "cc")?);
    }
    if let Some(original) = reply {
        if let Some(id) = &original.message_id {
            let angle = |id: &str| if id.starts_with('<') { id.to_string() } else { format!("<{id}>") };
            builder = builder.in_reply_to(angle(id));
            let mut chain: Vec<String> = original.references.iter().map(|r| angle(r)).collect();
            chain.push(angle(id));
            builder = builder.references(chain.join(" "));
        }
    }
    // Line ends as mail wants them, whatever the text came with.
    let body = spec.body.replace("\r\n", "\n").replace('\n', "\r\n");
    let message = builder.header(ContentType::TEXT_PLAIN).body(body).map_err(|e| e.to_string())?;
    Ok(message.formatted())
}

/// Sends `bytes` exactly as drafted, from `from` to `recipients`, over
/// smtp.gmail.com:465 (TLS from the first byte) with the app password.
pub async fn send(from: &str, password: &str, recipients: &[String], bytes: &[u8]) -> Result<(), String> {
    let sender: Address = from.parse().map_err(|_| "the account's address is not valid".to_string())?;
    let to: Vec<Address> = recipients.iter().filter_map(|r| r.parse().ok()).collect();
    if to.is_empty() {
        return Err("the draft has no recipient".into());
    }
    let envelope = Envelope::new(Some(sender), to).map_err(|e| e.to_string())?;
    let mailer = AsyncSmtpTransport::<Tokio1Executor>::relay(SMTP_HOST)
        .map_err(|e| e.to_string())?
        .port(465)
        .credentials(Credentials::new(from.to_string(), password.to_string()))
        .timeout(Some(Duration::from_secs(60)))
        .build();
    mailer.send_raw(&envelope, bytes).await.map(|_| ()).map_err(|e| {
        if e.is_permanent() {
            tf("Gmail refused to send it: {error}", &[("error", &e.to_string())])
        } else {
            tf("Could not send it: {error}", &[("error", &e.to_string())])
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use mail_parser::MessageParser;

    fn spec() -> Spec {
        Spec {
            from: "me@gmail.com".into(),
            to: vec!["Ana Müller <ana@example.com>".into()],
            cc: vec!["bo@example.com".into()],
            subject: "Café ☕ on Friday".into(),
            body: "Hi Ana,\nsee you there — Ünïcode.\n".into(),
        }
    }

    #[test]
    fn a_draft_is_utf8_with_its_subject_encoded_and_reads_back_the_same() {
        let bytes = build(&spec(), None, "<x1.winotch@gmail.com>").unwrap();
        let text = String::from_utf8_lossy(&bytes);
        // Headers stay ASCII: the subject travels as an encoded word.
        let head = text.split("\r\n\r\n").next().unwrap();
        assert!(head.is_ascii(), "{head}");
        assert!(head.contains("Subject: =?utf-8?"), "{head}");
        assert!(head.contains("Message-ID: <x1.winotch@gmail.com>"));
        assert!(head.contains("charset=utf-8"));
        assert!(!head.contains("In-Reply-To"));
        let parsed = MessageParser::default().parse(&bytes).unwrap();
        assert_eq!(parsed.subject(), Some("Café ☕ on Friday"));
        assert_eq!(parsed.from().unwrap().first().unwrap().address(), Some("me@gmail.com"));
        assert_eq!(parsed.to().unwrap().first().unwrap().name(), Some("Ana Müller"));
        assert_eq!(parsed.body_text(0).unwrap().trim_end(), "Hi Ana,\r\nsee you there — Ünïcode.".replace("\r\n", "\r\n"));
        assert_eq!(super::super::message::recipients(&bytes), ["ana@example.com", "bo@example.com"]);
    }

    #[test]
    fn a_reply_threads_under_the_mail_it_answers() {
        let original = Original {
            message_id: Some("p2@example.com".into()),
            references: vec!["p0@example.com".into(), "p1@example.com".into()],
            subject: "Plan".into(),
            ..Default::default()
        };
        let mut s = spec();
        s.subject = reply_subject("", &original.subject);
        let bytes = build(&s, Some(&original), "<r.winotch@gmail.com>").unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("In-Reply-To: <p2@example.com>"), "{text}");
        assert!(text.contains("References: <p0@example.com> <p1@example.com> <p2@example.com>"), "{text}");
        assert!(text.contains("Subject: Re: Plan"));
    }

    #[test]
    fn a_reply_subject_gets_one_re() {
        assert_eq!(reply_subject("", "Plan"), "Re: Plan");
        assert_eq!(reply_subject("", "RE: Plan"), "RE: Plan");
        assert_eq!(reply_subject("New plan", "Plan"), "Re: New plan");
        assert_eq!(reply_subject(" re: x ", "Plan"), "re: x");
    }

    #[test]
    fn a_draft_needs_real_addresses_and_someone_to_go_to() {
        let mut s = spec();
        s.to = vec!["not an address".into()];
        assert!(build(&s, None, "<a@b>").unwrap_err().starts_with("to:"));
        let mut s = spec();
        s.to.clear();
        s.cc.clear();
        assert!(build(&s, None, "<a@b>").is_err());
        let id = new_message_id("me@work.example");
        assert!(id.starts_with('<') && id.ends_with(".winotch@work.example>"), "{id}");
    }
}
