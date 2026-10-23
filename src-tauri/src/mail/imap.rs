// One connection to Gmail's IMAP: TLS (rustls with the webpki roots, as
// reqwest), LOGIN with the app password, then plain commands whose untagged
// answers come back whole. async-imap frames the protocol and does IDLE; the
// answers are read here from imap-proto's parse, which keeps Gmail's own
// attributes (X-GM-MSGID, X-GM-THRID) that async-imap's Fetch drops.
//
// Sign-in failures are told apart (wrong password, IMAP off, a browser
// sign-in needed) so the watcher can stop instead of trying again.

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use async_imap::imap_proto::{MailboxDatum, NameAttribute, Response, Status};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use tokio_rustls::rustls::{self, pki_types::ServerName, ClientConfig, RootCertStore};
use tokio_rustls::TlsConnector;

use crate::i18n::{t, tf};
use super::message::{fetched, full_from, mail_from, FullMail, Mail};

pub const IMAP_HOST: &str = "imap.gmail.com";
const IMAP_PORT: u16 = 993;
/// A command that takes longer has lost its connection.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// How much of each mail the list fetches: enough for the headers and the
/// opening text, never the attachments.
const PREVIEW_BYTES: u32 = 16 * 1024;
/// How much of a mail Claude Code's read fetches.
const FULL_BYTES: u32 = 4 * 1024 * 1024;

pub type Session = async_imap::Session<TlsStream<TcpStream>>;

/// What went wrong, and whether trying again could help.
#[derive(Debug, Clone, PartialEq)]
pub enum MailError {
    /// Google said no to this password: retrying would only lock the account.
    SignIn(String),
    /// The network, or Gmail for a moment: try again later.
    Network(String),
    /// A command was refused (a draft gone, a search Gmail did not take).
    Refused(String),
    /// Nothing was asked of Gmail: winotch is paused, or the account or its
    /// password is gone.
    Unavailable(String),
}

impl MailError {
    pub fn message(&self) -> String {
        match self {
            MailError::SignIn(m) | MailError::Network(m) | MailError::Refused(m) | MailError::Unavailable(m) => m.clone(),
        }
    }

    /// What kind of failure, for the log: never what Gmail said.
    pub fn kind(&self) -> &'static str {
        match self {
            MailError::SignIn(_) => "sign-in refused",
            MailError::Network(_) => "network",
            MailError::Refused(_) => "refused by Gmail",
            MailError::Unavailable(_) => "not set up or paused",
        }
    }
}

impl From<MailError> for String {
    fn from(e: MailError) -> String {
        e.message()
    }
}

fn network(e: impl std::fmt::Display) -> MailError {
    MailError::Network(tf("Can't reach Gmail: {error}", &[("error", &e.to_string())]))
}

/// What Google answers a refused LOGIN with, in words the user can act on.
pub fn sign_in_error(server: &str) -> String {
    let s = server.to_ascii_lowercase();
    if s.contains("application-specific password") {
        t("Gmail wants an app password: turn on 2-Step Verification, then create one at myaccount.google.com/apppasswords.")
    } else if s.contains("not enabled for imap") {
        t("IMAP is off for this account: turn it on in Gmail → Settings → Forwarding and POP/IMAP.")
    } else if s.contains("web browser") || s.contains("webalert") {
        t("Google wants a sign-in in the browser first: open Gmail in a browser, then try again.")
    } else if s.contains("authenticationfailed") || s.contains("invalid credentials") || s.contains("authenticate") {
        t("Wrong email or app password. Use a 16-character app password from myaccount.google.com/apppasswords (it needs 2-Step Verification).")
    } else {
        t("Gmail refused the sign-in. Check the address and the app password.")
    }
}

/// One TLS setup for every connection: ring, as the rest of the app.
static TLS: LazyLock<Option<Arc<ClientConfig>>> = LazyLock::new(|| {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .ok()?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Some(Arc::new(config))
});

async fn tls(host: &'static str, port: u16) -> Result<TlsStream<TcpStream>, MailError> {
    let config = TLS.clone().ok_or_else(|| network("no TLS"))?;
    let tcp = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((host, port)))
        .await
        .map_err(|_| network("timed out"))?
        .map_err(network)?;
    let name = ServerName::try_from(host).map_err(network)?;
    tokio::time::timeout(CONNECT_TIMEOUT, TlsConnector::from(config).connect(name, tcp))
        .await
        .map_err(|_| network("timed out"))?
        .map_err(network)
}

/// A signed-in connection.
pub struct Conn {
    pub session: Session,
}

impl Conn {
    /// Connects and signs in. The password never leaves this call but to Gmail.
    pub async fn open(email: &str, password: &str) -> Result<Conn, MailError> {
        let stream = tls(IMAP_HOST, IMAP_PORT).await?;
        let mut client = async_imap::Client::new(stream);
        // The greeting comes first.
        timed(client.read_response()).await?.map_err(network)?.ok_or_else(|| network("closed at once"))?;
        let session = match timed(client.login(email, password)).await? {
            Ok(session) => session,
            Err((async_imap::error::Error::No(info), _)) | Err((async_imap::error::Error::Bad(info), _)) => {
                return Err(MailError::SignIn(sign_in_error(&info)))
            }
            Err((e, _)) => return Err(network(e)),
        };
        Ok(Conn { session })
    }

    pub async fn logout(mut self) {
        let _ = tokio::time::timeout(Duration::from_secs(5), self.session.logout()).await;
    }

    /// Runs one command; a NO or BAD is an error.
    pub async fn run(&mut self, command: &str) -> Result<(), MailError> {
        self.run_map(command, |_| None::<()>).await.map(|_| ())
    }

    /// Runs one command and keeps what `each` takes from its untagged answers.
    pub async fn run_map<T>(&mut self, command: &str, each: impl FnMut(&Response) -> Option<T>) -> Result<Vec<T>, MailError> {
        let id = timed(self.session.run_command(command)).await?.map_err(network)?;
        self.collect(&id, each).await
    }

    /// Reads answers up to the tagged end of command `id`.
    async fn collect<T>(
        &mut self,
        id: &async_imap::imap_proto::RequestId,
        mut each: impl FnMut(&Response) -> Option<T>,
    ) -> Result<Vec<T>, MailError> {
        let mut out = Vec::new();
        loop {
            let response = timed(self.session.read_response()).await?.map_err(network)?.ok_or_else(|| network("connection lost"))?;
            if let Response::Done { tag, status, outcome } = response.parsed() {
                if tag == id {
                    return match status {
                        Status::Ok => Ok(out),
                        _ => Err(MailError::Refused(match outcome.information.as_deref() {
                            Some(info) => tf("Gmail refused it: {error}", &[("error", info)]),
                            None => tf("Gmail refused it: {error}", &[("error", &t("no reason given"))]),
                        })),
                    };
                }
            }
            if let Response::Data { status: Status::Bye, .. } = response.parsed() {
                return Err(network("Gmail closed the connection"));
            }
            out.extend(each(response.parsed()));
        }
    }

    /// Opens a mailbox read-only (nothing gets marked read by looking): its
    /// UIDVALIDITY and how many mails it holds.
    pub async fn examine(&mut self, mailbox: &str) -> Result<(u32, u32), MailError> {
        let found = timed(self.session.examine(mailbox)).await?.map_err(refused)?;
        Ok((found.uid_validity.unwrap_or(0), found.exists))
    }

    /// Opens a mailbox to change it.
    pub async fn select(&mut self, mailbox: &str) -> Result<(u32, u32), MailError> {
        let found = timed(self.session.select(mailbox)).await?.map_err(refused)?;
        Ok((found.uid_validity.unwrap_or(0), found.exists))
    }

    /// The newest `count` mails of the open mailbox (of `exists`): each UID with its \Seen.
    pub async fn window(&mut self, exists: u32, count: u32) -> Result<Vec<(u32, bool)>, MailError> {
        if exists == 0 {
            return Ok(Vec::new());
        }
        let first = exists.saturating_sub(count - 1).max(1);
        self.run_map(&format!("FETCH {first}:{exists} (UID FLAGS)"), flags_of).await
    }

    /// The \Seen of these UIDs; one that is not in the mailbox is absent.
    pub async fn flags(&mut self, uids: &[u32]) -> Result<Vec<(u32, bool)>, MailError> {
        if uids.is_empty() {
            return Ok(Vec::new());
        }
        self.run_map(&format!("UID FETCH {} (UID FLAGS)", uid_set(uids)), flags_of).await
    }

    /// The list's mails for these UIDs: ids, flags, date, and the start of each.
    pub async fn previews(&mut self, uids: &[u32]) -> Result<Vec<Mail>, MailError> {
        if uids.is_empty() {
            return Ok(Vec::new());
        }
        self.run_map(
            &format!("UID FETCH {} (UID FLAGS X-GM-MSGID X-GM-THRID INTERNALDATE BODY.PEEK[]<0.{PREVIEW_BYTES}>)", uid_set(uids)),
            |r| fetched(r).and_then(|f| mail_from(&f)),
        )
        .await
    }

    /// Whole mails (up to FULL_BYTES each) for these UIDs, oldest first.
    pub async fn full(&mut self, account: &str, uids: &[u32]) -> Result<Vec<FullMail>, MailError> {
        if uids.is_empty() {
            return Ok(Vec::new());
        }
        let mut out: Vec<(u32, FullMail)> = self
            .run_map(
                &format!(
                    "UID FETCH {} (UID FLAGS X-GM-MSGID X-GM-THRID INTERNALDATE RFC822.SIZE BODY.PEEK[]<0.{FULL_BYTES}>)",
                    uid_set(uids)
                ),
                |r| {
                    let f = fetched(r)?;
                    let cut = f.size.is_some_and(|s| s > FULL_BYTES);
                    Some((f.uid?, full_from(account, &f, cut)?))
                },
            )
            .await?;
        out.sort_by_key(|(uid, _)| *uid);
        Ok(out.into_iter().map(|(_, m)| m).collect())
    }

    /// The first `max` bytes of one mail: its headers, without what follows.
    pub async fn start(&mut self, uid: u32, max: u32) -> Result<Option<Vec<u8>>, MailError> {
        let found = self
            .run_map(&format!("UID FETCH {uid} (UID BODY.PEEK[]<0.{max}>)"), |r| fetched(r).and_then(|f| f.body.map(<[u8]>::to_vec)))
            .await?;
        Ok(found.into_iter().next())
    }

    /// One mail's raw bytes, whole.
    pub async fn raw(&mut self, uid: u32) -> Result<Option<Vec<u8>>, MailError> {
        let found = self
            .run_map(&format!("UID FETCH {uid} (UID BODY.PEEK[])"), |r| fetched(r).and_then(|f| f.body.map(<[u8]>::to_vec)))
            .await?;
        Ok(found.into_iter().next())
    }

    pub async fn search(&mut self, criteria: &str) -> Result<Vec<u32>, MailError> {
        let found = self.run_map(&format!("UID SEARCH {criteria}"), search_of).await?;
        Ok(sorted(found))
    }

    /// A Gmail search (X-GM-RAW, the web's own syntax) in the open mailbox.
    /// Text beyond ASCII goes as a literal, as IMAP wants it.
    pub async fn gmail_search(&mut self, query: &str) -> Result<Vec<u32>, MailError> {
        if query.is_ascii() {
            return self.search(&format!("X-GM-RAW {}", quote(query))).await;
        }
        let bytes = query.as_bytes();
        let id = timed(self.session.run_command(format!("UID SEARCH CHARSET UTF-8 X-GM-RAW {{{}}}", bytes.len())))
            .await?
            .map_err(network)?;
        let go_on = timed(self.session.read_response()).await?.map_err(network)?.ok_or_else(|| network("connection lost"))?;
        if !matches!(go_on.parsed(), Response::Continue { .. }) {
            return Err(MailError::Refused("Gmail did not take the search".into()));
        }
        let stream = self.session.get_mut();
        timed(async {
            stream.write_all(bytes).await?;
            stream.write_all(b"\r\n").await?;
            stream.flush().await
        })
        .await?
        .map_err(network)?;
        Ok(sorted(self.collect(&id, search_of).await?))
    }

    /// The mailbox of a special use (RFC 6154): \All, \Drafts, \Trash. Found
    /// by its flag, never by its name, which Gmail translates.
    pub async fn special(&mut self, which: NameAttribute<'static>) -> Result<String, MailError> {
        let found = self.run_map("LIST \"\" \"*\"", |r| special_of(r, &which)).await?;
        found.into_iter().next().ok_or_else(|| MailError::Refused("Gmail did not name that folder".into()))
    }

    /// APPENDs a message to a mailbox with these flags ("(\\Draft)").
    pub async fn append(&mut self, mailbox: &str, flags: &str, message: &[u8]) -> Result<(), MailError> {
        timed(self.session.append(mailbox, Some(flags), None, message)).await?.map_err(refused)
    }
}

fn refused(e: async_imap::error::Error) -> MailError {
    match e {
        async_imap::error::Error::No(info) | async_imap::error::Error::Bad(info) => {
            MailError::Refused(tf("Gmail refused it: {error}", &[("error", &info.to_string())]))
        }
        e => network(e),
    }
}

async fn timed<T>(f: impl std::future::Future<Output = T>) -> Result<T, MailError> {
    tokio::time::timeout(COMMAND_TIMEOUT, f).await.map_err(|_| network("no answer"))
}

/// An IMAP quoted string.
pub fn quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        if c == '"' || c == '\\' {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    out
}

/// UIDs as an IMAP set, runs folded ("1:4,9").
pub fn uid_set(uids: &[u32]) -> String {
    let mut sorted = uids.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    let mut parts = Vec::new();
    let mut i = 0;
    while i < sorted.len() {
        let start = sorted[i];
        let mut end = start;
        while i + 1 < sorted.len() && sorted[i + 1] == end + 1 {
            i += 1;
            end = sorted[i];
        }
        parts.push(if start == end { start.to_string() } else { format!("{start}:{end}") });
        i += 1;
    }
    parts.join(",")
}

fn flags_of(r: &Response) -> Option<(u32, bool)> {
    fetched(r).and_then(|f| Some((f.uid?, f.seen())))
}

fn search_of(r: &Response) -> Option<Vec<u32>> {
    match r {
        Response::MailboxData(MailboxDatum::Search(ids)) => Some(ids.clone()),
        _ => None,
    }
}

fn sorted(found: Vec<Vec<u32>>) -> Vec<u32> {
    let mut uids: Vec<u32> = found.into_iter().flatten().collect();
    uids.sort_unstable();
    uids
}

fn special_of(response: &Response, which: &NameAttribute) -> Option<String> {
    match response {
        Response::MailboxData(MailboxDatum::List(list)) if list.name_attributes.contains(which) => {
            Some(list.name.to_string())
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_in_refusals_read_as_what_to_do() {
        assert!(sign_in_error("code: Some(Alert), info: Some(\"Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)\")").contains("2-Step Verification"));
        assert!(sign_in_error("[AUTHENTICATIONFAILED] Invalid credentials (Failure)").starts_with("Wrong email or app password"));
        assert!(sign_in_error("[ALERT] Your account is not enabled for IMAP use.").starts_with("IMAP is off"));
        assert!(sign_in_error("[ALERT] Please log in via your web browser").contains("browser"));
        assert!(sign_in_error("something else").starts_with("Gmail refused"));
    }

    #[test]
    fn quoting_and_uid_sets_are_what_imap_reads() {
        assert_eq!(quote(r#"from:"Ana" in:a\b"#), r#""from:\"Ana\" in:a\\b""#);
        assert_eq!(uid_set(&[9, 1, 2, 3, 4, 7, 3]), "1:4,7,9");
        assert_eq!(uid_set(&[5]), "5");
    }

    #[test]
    fn gmails_primary_search_reads_as_its_uids() {
        use super::super::inbox::PRIMARY;
        // What gmail_search sends: X-GM-RAW with the query quoted.
        assert_eq!(format!("X-GM-RAW {}", quote(PRIMARY)), "X-GM-RAW \"category:primary\"");
        // Recorded answers: Gmail lists the UIDs in no promised order; none is a bare SEARCH.
        let uids = |raw: &[u8]| sorted(vec![search_of(&Response::parse(raw).unwrap().1).expect("a search answer")]);
        let primary = uids(b"* SEARCH 12 3 7 40\r\n");
        assert_eq!(primary, [3, 7, 12, 40]);
        assert!(uids(b"* SEARCH\r\n").is_empty());
        // Anything else in the answer is not a search's.
        assert!(search_of(&Response::parse(b"* 4 EXISTS\r\n").unwrap().1).is_none());
    }

    #[test]
    fn special_use_folders_are_found_by_their_flag_not_their_name() {
        let lines: [&[u8]; 3] = [
            b"* LIST (\\HasNoChildren) \"/\" \"INBOX\"\r\n",
            b"* LIST (\\All \\HasNoChildren) \"/\" \"[Gmail]/Alle Nachrichten\"\r\n",
            b"* LIST (\\Drafts \\HasNoChildren) \"/\" \"[Gmail]/Entw&APw-rfe\"\r\n",
        ];
        let parsed: Vec<Response> = lines.iter().map(|l| Response::parse(l).unwrap().1).collect();
        let find = |which| parsed.iter().find_map(|r| special_of(r, &which));
        assert_eq!(find(NameAttribute::All).as_deref(), Some("[Gmail]/Alle Nachrichten"));
        assert_eq!(find(NameAttribute::Drafts).as_deref(), Some("[Gmail]/Entw&APw-rfe"));
        assert_eq!(find(NameAttribute::Trash), None);
    }

    #[test]
    fn all_mail_is_found_by_its_flag_in_a_turkish_gmail() {
        // LIST "" "*" of a Gmail whose language is Turkish: every [Gmail]
        // folder translated, in IMAP's modified UTF-7 ("Tüm Postalar").
        let answer: [&[u8]; 9] = [
            b"* LIST (\\HasNoChildren) \"/\" \"INBOX\"\r\n",
            b"* LIST (\\HasChildren \\Noselect) \"/\" \"[Gmail]\"\r\n",
            b"* LIST (\\All \\HasNoChildren) \"/\" \"[Gmail]/T&APw-m Postalar\"\r\n",
            b"* LIST (\\Drafts \\HasNoChildren) \"/\" \"[Gmail]/Taslaklar\"\r\n",
            b"* LIST (\\HasNoChildren \\Important) \"/\" \"[Gmail]/&ANY-nemli\"\r\n",
            b"* LIST (\\HasNoChildren \\Sent) \"/\" \"[Gmail]/G&APY-nderilmi&AV8- Postalar\"\r\n",
            b"* LIST (\\Flagged \\HasNoChildren) \"/\" \"[Gmail]/Y&ATE-ld&ATE-zl&ATE-\"\r\n",
            b"* LIST (\\HasNoChildren \\Trash) \"/\" \"[Gmail]/&AMcA9g-p Kutusu\"\r\n",
            b"* LIST (\\HasNoChildren \\Junk) \"/\" \"[Gmail]/Spam\"\r\n",
        ];
        let parsed: Vec<Response> = answer.iter().map(|l| Response::parse(l).unwrap().1).collect();
        let find = |which| parsed.iter().find_map(|r| special_of(r, &which));
        // The name as Gmail sent it, encoded, which is what SELECT and MOVE want back.
        let all = find(NameAttribute::All).expect("All Mail, by \\All");
        assert_eq!(all, "[Gmail]/T&APw-m Postalar");
        assert_eq!(quote(&all), "\"[Gmail]/T&APw-m Postalar\"");
        assert_eq!(find(NameAttribute::Trash).as_deref(), Some("[Gmail]/&AMcA9g-p Kutusu"));
        assert_eq!(find(NameAttribute::Drafts).as_deref(), Some("[Gmail]/Taslaklar"));
        // The English name is nowhere in it.
        assert!(!parsed.iter().any(|r| matches!(r, Response::MailboxData(MailboxDatum::List(l)) if l.name.contains("All Mail"))));
    }
}
