// API keys live in the Windows Credential Manager or, on Linux, the Secret
// Service (GNOME Keyring, KWallet) — never on disk and never in the front end — the island can only ask whether a key is present.

use keyring::Entry;

const SERVICE: &str = "com.arynbuilds.winotch";

/// The name winotch's keys were kept under before it had its own: Coucou's,
/// whose code it began from. Read once, on an upgrade only (`move_from_fork`).
const FORK_SERVICE: &str = "fr.louisraille.coucou";

/// Every key winotch may store. Anything outside this list is refused.
pub const KNOWN_KEYS: &[&str] = &[
    // The dictation clean-up, the notes of a call and « OK Tent ».
    "anthropic-api-key",
    "github-token",
    "stripe-api-key",
    "notion-api-key",
    // « OK Tent »'s answers in an ElevenLabs voice.
    "elevenlabs-api-key",
];

/// Each Gmail account's app password sits under its own key, `gmail:` and the
/// address in lower case (mail/). Only that exact shape passes, so the prefix
/// opens no door to arbitrary names.
const MAIL_PREFIX: &str = "gmail:";

/// The key of a Gmail account's app password, or None for an address that is
/// not one (spaces, quotes, upper case, no domain…).
pub fn mail_key(email: &str) -> Option<String> {
    valid_mail_address(email).then(|| format!("{MAIL_PREFIX}{email}"))
}

/// A Gmail key: the island's generic secret commands leave these alone, so a
/// password only ever arrives through the account's own sign-in check.
pub fn is_mail_key(key: &str) -> bool {
    key.starts_with(MAIL_PREFIX)
}

/// A plain address as winotch stores it: lower case, one @, a dotted domain,
/// and only the characters an address may carry unquoted.
fn valid_mail_address(email: &str) -> bool {
    let Some((local, domain)) = email.split_once('@') else { return false };
    let local_ok = (1..=64).contains(&local.len())
        && local.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"!#$%&'*+/=?^_`{|}~.-".contains(&b))
        && !local.starts_with('.')
        && !local.ends_with('.')
        && !local.contains("..");
    let domain_ok = (3..=190).contains(&domain.len())
        && domain.contains('.')
        && domain.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
        && domain.split('.').all(|part| !part.is_empty() && !part.starts_with('-') && !part.ends_with('-'));
    local_ok && domain_ok
}

fn allowed(key: &str) -> bool {
    KNOWN_KEYS.contains(&key) || key.strip_prefix(MAIL_PREFIX).is_some_and(valid_mail_address)
}

fn entry(key: &str) -> Option<Entry> {
    if !allowed(key) {
        return None;
    }
    Entry::new(SERVICE, key).ok()
}

pub fn get(key: &str) -> Option<String> {
    entry(key)?.get_password().ok().filter(|v| !v.is_empty())
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    let entry = entry(key).ok_or_else(|| format!("unknown key {key}"))?;
    if value.is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry.set_password(value).map_err(|e| e.to_string())
}

pub fn clear(key: &str) -> Result<(), String> {
    let entry = entry(key).ok_or_else(|| format!("unknown key {key}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn present(key: &str) -> bool {
    get(key).is_some()
}

/// Copies the keys an earlier winotch kept under Coucou's name to its own, once.
/// Only on an upgrade (`upgrading`: a settings.json was there at start), so a
/// fresh install never reads another app's keys; only into keys winotch does
/// not have yet; and only copies, so a Coucou on the same computer keeps its own.
pub fn move_from_fork(upgrading: bool, mail_accounts: &[String]) {
    let marker = crate::settings::local_dir().join("keys-moved");
    if marker.exists() {
        return;
    }
    if upgrading {
        let keys = KNOWN_KEYS.iter().map(|k| k.to_string()).chain(mail_accounts.iter().filter_map(|e| mail_key(e)));
        let mut moved = 0;
        for key in keys {
            if present(&key) {
                continue;
            }
            let old = Entry::new(FORK_SERVICE, &key).ok().and_then(|e| e.get_password().ok()).filter(|v| !v.is_empty());
            if let Some(value) = old {
                if set(&key, &value).is_ok() {
                    moved += 1;
                }
            }
        }
        crate::log::line(format!("secrets: {moved} kept under winotch's own name"));
    }
    if let Some(dir) = marker.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&marker, b"");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_outside_the_list_is_refused() {
        // The keys of integrations and chat providers winotch dropped are not
        // reachable either.
        for key in [
            "n8n-api-key", "vercel-token", "phone-link-cert", "openai-api-key", "google-api-key",
            "openrouter-api-key", "openai-compatible-key", "",
        ] {
            assert!(entry(key).is_none(), "{key}");
            assert!(set(key, "x").is_err(), "{key}");
            assert!(clear(key).is_err(), "{key}");
        }
    }

    #[test]
    fn a_gmail_key_is_the_prefix_and_a_plain_lower_case_address_only() {
        assert_eq!(mail_key("me@gmail.com").as_deref(), Some("gmail:me@gmail.com"));
        assert!(allowed("gmail:first.last+work@example.co.uk"));
        assert!(is_mail_key("gmail:me@gmail.com"));
        for key in [
            "gmail:", "gmail:me", "gmail:Me@gmail.com", "gmail:me@gmail", "gmail:me@@gmail.com",
            "gmail:me @gmail.com", "gmail:\"me\"@gmail.com", "gmail:me@gmail.com
", "gmail:.me@gmail.com",
            "gmail:me..x@gmail.com", "gmail:me@-gmail.com", "gmail:me@gmail..com", "gmail:me@gmail.com/x",
            "gmail:../../x", "gmailx:me@gmail.com", "GMAIL:me@gmail.com",
        ] {
            assert!(!allowed(key), "{key}");
            assert!(entry(key).is_none(), "{key}");
        }
        assert!(mail_key("Me@Gmail.com").is_none(), "the caller lowercases first");
    }
}
