// The mails read lately, so opening one again (or one read ahead of the
// click) is instant. In memory only: never written to disk, never logged,
// emptied of an account when it is removed. Bounded: the least recently used
// mail goes first.

use std::collections::VecDeque;

use super::message::FullMail;

/// How many mails are kept, across accounts.
pub const CAPACITY: usize = 50;
/// How many of the newest inbox mails are read ahead, one at a time.
pub const PREFETCH: usize = 10;

/// Where a mail was found, so marking it read needs no search: the mailbox,
/// its UIDVALIDITY and the mail's UID there.
#[derive(Debug, Clone, PartialEq)]
pub struct Location {
    pub mailbox: String,
    pub validity: u32,
    pub uid: u32,
}

#[derive(Debug, Clone)]
pub struct Cached {
    pub mail: FullMail,
    pub at: Location,
}

/// A mail of an account, by its Gmail id.
type Key = (String, u64);

pub struct Cache {
    capacity: usize,
    /// Least recently used first.
    entries: VecDeque<(Key, Cached)>,
}

impl Cache {
    pub const fn new(capacity: usize) -> Cache {
        Cache { capacity, entries: VecDeque::new() }
    }

    /// The mail, now the most recently used.
    pub fn get(&mut self, account: &str, msgid: u64) -> Option<Cached> {
        let i = self.entries.iter().position(|((a, m), _)| a == account && *m == msgid)?;
        let entry = self.entries.remove(i)?;
        let found = entry.1.clone();
        self.entries.push_back(entry);
        Some(found)
    }

    pub fn contains(&self, account: &str, msgid: u64) -> bool {
        self.entries.iter().any(|((a, m), _)| a == account && *m == msgid)
    }

    pub fn put(&mut self, account: &str, msgid: u64, cached: Cached) {
        self.entries.retain(|((a, m), _)| !(a == account && *m == msgid));
        self.entries.push_back(((account.to_string(), msgid), cached));
        while self.entries.len() > self.capacity {
            self.entries.pop_front();
        }
    }

    /// An account removed: none of its mail stays.
    pub fn forget(&mut self, account: &str) {
        self.entries.retain(|((a, _), _)| a != account);
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

/// What to read ahead of the newest mails (newest first): those not read
/// yet, at most PREFETCH of the list's head.
pub fn to_prefetch(newest: &[u64], cached: impl Fn(u64) -> bool) -> Vec<u64> {
    newest.iter().take(PREFETCH).copied().filter(|m| !cached(*m)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mail(id: u64) -> Cached {
        Cached {
            mail: FullMail {
                id: id.to_string(),
                thread: String::new(),
                message_id: None,
                from: Vec::new(),
                to: Vec::new(),
                cc: Vec::new(),
                date: 0,
                subject: format!("m{id}"),
                unread: true,
                body: String::new(),
                attachments: Vec::new(),
                truncated: false,
                url: String::new(),
            },
            at: Location { mailbox: "INBOX".into(), validity: 7, uid: id as u32 },
        }
    }

    #[test]
    fn a_mail_read_once_is_there_again_and_the_least_used_goes_first() {
        let mut c = Cache::new(3);
        assert!(c.get("me@gmail.com", 1).is_none(), "a miss");
        for id in 1..=3 {
            c.put("me@gmail.com", id, mail(id));
        }
        assert_eq!(c.get("me@gmail.com", 1).unwrap().mail.subject, "m1", "a hit");
        // 1 was just used: 2 is the least recently used, and goes.
        c.put("me@gmail.com", 4, mail(4));
        assert_eq!(c.len(), 3);
        assert!(!c.contains("me@gmail.com", 2));
        assert!(c.contains("me@gmail.com", 1) && c.contains("me@gmail.com", 3) && c.contains("me@gmail.com", 4));
        // The same mail again replaces itself, never twice.
        c.put("me@gmail.com", 4, mail(4));
        assert_eq!(c.len(), 3);
        // Accounts are apart, and a removed one leaves nothing behind.
        assert!(c.get("other@gmail.com", 1).is_none());
        c.put("other@gmail.com", 9, mail(9));
        c.forget("me@gmail.com");
        assert_eq!(c.len(), 1);
        assert!(c.contains("other@gmail.com", 9));
        assert_eq!(Cache::new(CAPACITY).capacity, 50);
    }

    #[test]
    fn read_ahead_is_the_newest_ten_not_read_yet() {
        let newest: Vec<u64> = (1..=30).collect();
        let all = to_prefetch(&newest, |_| false);
        assert_eq!(all, (1..=10).collect::<Vec<_>>(), "bounded to the head of the list");
        let some = to_prefetch(&newest, |m| m % 2 == 0);
        assert_eq!(some, [1, 3, 5, 7, 9], "what is read already is not read again");
        assert!(to_prefetch(&newest, |_| true).is_empty());
        assert!(to_prefetch(&[], |_| false).is_empty());
    }
}
