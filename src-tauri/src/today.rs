// Today (WINOTCH.md "Today"): to-dos on days, and notes. A built-in of the app
// registry (apps.rs) whose data never leaves this computer: one JSON file in
// winotch's local folder (today.json), written whole and atomically.
//
// - The island draws it itself (core/today.ts, views/today.ts): the whole
//   state comes with every change as the "today" event (and `today_state`),
//   and its edits come back through the today_* commands.
// - Claude Code reaches it over the local API, with the same token as the
//   rest (/v1/today/*, the MCP server's winotch_today_* and winotch_notes_*).
//   It may do everything the user can, deleting included.
// - Reminders: a to-do with a date and a time posts a notification then
//   (its item: a click opens its details; "Done" ticks it off). One task
//   sleeps until the next reminder or local midnight, woken early when
//   anything changes; nothing else runs while idle. A reminder missed while
//   winotch was closed rings once at start if it was due in the last hour.
//
// Dates are the user's own days ("2026-10-19") and times their wall clock
// ("15:00"): what they said, in this computer's time zone, never converted.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

use crate::apps::{self, Action, AppItems, NewNotification, Press};
use crate::i18n::{t, tf};

pub const APP_ID: &str = "today";
const MAX_TITLE: usize = 200;
const MAX_TEXT: usize = 20_000;
/// To-dos and notes together.
const MAX_ENTRIES: usize = 5000;
/// A reminder this late still rings (at start, or after the computer slept); older ones never.
const MISSED_MINUTES: i64 = 60;
/// The longest the reminder task sleeps while a reminder waits: a clock that
/// was changed, daylight saving or a computer that slept is caught by then.
const LONGEST_SLEEP: i64 = 3600;

// ── What is kept ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// YYYY-MM-DD; none: someday (the inbox).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    /// HH:MM, only with a date: its reminder rings then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<String>,
    #[serde(default)]
    pub done: bool,
    /// When it was ticked off, ms since 1970.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done_at: Option<u64>,
    /// ms since 1970.
    pub created: u64,
    /// The "date time" whose reminder was posted (or passed while it was
    /// set): each date and time rings once. Never shown, never sent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reminded: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub updated: u64,
    pub created: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Data {
    #[serde(default)]
    pub todos: Vec<Todo>,
    #[serde(default)]
    pub notes: Vec<Note>,
    /// The last id given: ids are "t12", "n3", never reused.
    #[serde(default)]
    pub next: u64,
}

/// A to-do as the island and the API see it: without its reminder record.
fn public(todo: &Todo) -> Todo {
    Todo { reminded: None, ..todo.clone() }
}

/// What the island draws: everything, with the day it is now.
#[derive(Debug, Clone, Serialize)]
pub struct TodayState {
    pub today: String,
    pub todos: Vec<Todo>,
    pub notes: Vec<Note>,
}

// ── Days and times (the user's own, in this computer's time zone) ────────────

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

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

/// "2026-10-19" → its day counted from 1970-01-01; None unless a real date.
pub fn parse_date(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| text.get(r)?.parse::<i64>().ok();
    if !text.bytes().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit()) {
        return None;
    }
    let (y, m, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    if !(1970..=9999).contains(&y) || !(1..=12).contains(&m) || d < 1 {
        return None;
    }
    let days = days_from_civil(y, m, d);
    // 31 February comes back as another day.
    (civil_from_days(days) == (y, m, d)).then_some(days)
}

pub fn format_date(days: i64) -> String {
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// "15:00" → minutes after midnight; None unless HH:MM within a day.
pub fn parse_time(text: &str) -> Option<i64> {
    let (h, m) = text.split_once(':')?;
    if h.len() != 2 || m.len() != 2 || !h.bytes().chain(m.bytes()).all(|c| c.is_ascii_digit()) {
        return None;
    }
    let (h, m) = (h.parse::<i64>().ok()?, m.parse::<i64>().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

const WEEKDAYS: [&str; 7] = ["Thursday", "Friday", "Saturday", "Sunday", "Monday", "Tuesday", "Wednesday"];

/// 1970-01-01 was a Thursday.
fn weekday(days: i64) -> &'static str {
    WEEKDAYS[days.rem_euclid(7) as usize]
}

/// Now on this computer's wall clock, in seconds from 1970-01-01 00:00 local.
fn local_now() -> i64 {
    let l = crate::platform::local_time();
    days_from_civil(l.year.into(), l.month.into(), l.day.into()) * 86_400
        + i64::from(l.hour) * 3600
        + i64::from(l.minute) * 60
        + i64::from(l.second)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ── Checking what comes in ───────────────────────────────────────────────────

type Failure = (u16, String);

fn bad(message: impl Into<String>) -> Failure {
    (400, message.into())
}

/// A title: one line, not blank, at most 200 characters.
fn title_of(value: &Value, field: &str) -> Result<String, Failure> {
    if value.is_null() {
        return Err(bad(format!("{field} is missing")));
    }
    let text = value.as_str().ok_or_else(|| bad(format!("{field}: a string")))?;
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.is_empty() {
        return Err(bad(format!("{field} is missing")));
    }
    if line.chars().count() > MAX_TITLE {
        return Err(bad(format!("{field}: at most {MAX_TITLE} characters")));
    }
    Ok(line)
}

/// A text of up to 20 000 characters; `null` or "" clears it.
fn text_of(value: &Value, field: &str) -> Result<Option<String>, Failure> {
    match value {
        Value::Null => Ok(None),
        Value::String(s) if s.chars().count() > MAX_TEXT => Err(bad(format!("{field}: at most {MAX_TEXT} characters"))),
        Value::String(s) => Ok((!s.trim().is_empty()).then(|| s.replace("\r\n", "\n"))),
        _ => Err(bad(format!("{field}: a string"))),
    }
}

fn date_of(value: &Value) -> Result<Option<String>, Failure> {
    match value {
        Value::Null => Ok(None),
        Value::String(s) if s.trim().is_empty() => Ok(None),
        Value::String(s) => parse_date(s.trim())
            .map(|d| Some(format_date(d)))
            .ok_or_else(|| bad("date: YYYY-MM-DD, a real day (resolve \"tomorrow\" from today's date)")),
        _ => Err(bad("date: YYYY-MM-DD")),
    }
}

fn time_of(value: &Value) -> Result<Option<String>, Failure> {
    match value {
        Value::Null => Ok(None),
        Value::String(s) if s.trim().is_empty() => Ok(None),
        Value::String(s) => parse_time(s.trim())
            .map(|m| Some(format!("{:02}:{:02}", m / 60, m % 60)))
            .ok_or_else(|| bad("time: HH:MM, 24-hour (15:00)")),
        _ => Err(bad("time: HH:MM")),
    }
}

fn object(input: &Value) -> Result<&serde_json::Map<String, Value>, Failure> {
    input.as_object().ok_or_else(|| bad("a JSON object"))
}

/// Where a reminder stands: its due minute on the local clock, for one not
/// done that has a date and a time.
fn due_minute(todo: &Todo) -> Option<i64> {
    if todo.done {
        return None;
    }
    let day = parse_date(todo.date.as_deref()?)?;
    Some(day * 1440 + parse_time(todo.time.as_deref()?)?)
}

fn reminder_key(todo: &Todo) -> Option<String> {
    Some(format!("{} {}", todo.date.as_deref()?, todo.time.as_deref()?))
}

/// A date and time set at or before now never rings: there is nothing to remind of.
fn settle_reminder(todo: &mut Todo, now_min: i64) {
    if let (Some(due), Some(key)) = (due_minute(todo), reminder_key(todo)) {
        if due <= now_min && todo.reminded.as_deref() != Some(&key) {
            todo.reminded = Some(key);
        }
    }
}

// ── The store's changes, each checked whole ─────────────────────────────────

impl Data {
    fn full(&self) -> bool {
        self.todos.len() + self.notes.len() >= MAX_ENTRIES
    }

    fn new_id(&mut self, prefix: char) -> String {
        self.next += 1;
        format!("{prefix}{}", self.next)
    }

    pub fn todo(&self, id: &str) -> Option<&Todo> {
        self.todos.iter().find(|t| t.id == id)
    }

    pub fn note(&self, id: &str) -> Option<&Note> {
        self.notes.iter().find(|n| n.id == id)
    }

    /// `{title, note?, date?, time?, done?}`.
    pub fn add_todo(&mut self, input: &Value, now: u64, now_min: i64) -> Result<Todo, Failure> {
        object(input)?;
        if self.full() {
            return Err((409, format!("Today holds at most {MAX_ENTRIES} to-dos and notes: delete some first")));
        }
        let mut todo = Todo { title: title_of(&input["title"], "title")?, created: now, ..Todo::default() };
        todo.note = text_of(&input["note"], "note")?;
        todo.date = date_of(&input["date"])?;
        todo.time = time_of(&input["time"])?;
        if todo.time.is_some() && todo.date.is_none() {
            return Err(bad("time needs a date"));
        }
        if let Some(done) = input.get("done").filter(|d| !d.is_null()) {
            todo.done = done.as_bool().ok_or_else(|| bad("done: true or false"))?;
            todo.done_at = todo.done.then_some(now);
        }
        settle_reminder(&mut todo, now_min);
        todo.id = self.new_id('t');
        self.todos.push(todo.clone());
        Ok(todo)
    }

    /// Changes the fields given (`title`, `note`, `date`, `time`, `done`);
    /// null clears note, date and time. Clearing the date clears the time.
    pub fn update_todo(&mut self, id: &str, input: &Value, now: u64, now_min: i64) -> Result<Todo, Failure> {
        let fields = object(input)?;
        let known = ["title", "note", "date", "time", "done"];
        if let Some(other) = fields.keys().find(|k| !known.contains(&k.as_str())) {
            return Err(bad(format!("{other}: not a field of a to-do (title, note, date, time, done)")));
        }
        let index = self.todos.iter().position(|t| t.id == id).ok_or((404, format!("no to-do {id}")))?;
        let mut todo = self.todos[index].clone();
        if fields.contains_key("title") {
            todo.title = title_of(&input["title"], "title")?;
        }
        if fields.contains_key("note") {
            todo.note = text_of(&input["note"], "note")?;
        }
        if fields.contains_key("date") {
            todo.date = date_of(&input["date"])?;
            if todo.date.is_none() {
                todo.time = None;
            }
        }
        if fields.contains_key("time") {
            todo.time = time_of(&input["time"])?;
        }
        if todo.time.is_some() && todo.date.is_none() {
            return Err(bad("time needs a date"));
        }
        if fields.contains_key("done") {
            let done = input["done"].as_bool().ok_or_else(|| bad("done: true or false"))?;
            if done != todo.done {
                todo.done = done;
                todo.done_at = done.then_some(now);
            }
        }
        settle_reminder(&mut todo, now_min);
        self.todos[index] = todo.clone();
        Ok(todo)
    }

    pub fn delete_todo(&mut self, id: &str) -> Result<Todo, Failure> {
        let index = self.todos.iter().position(|t| t.id == id).ok_or((404, format!("no to-do {id}")))?;
        Ok(self.todos.remove(index))
    }

    /// `{title?, body?}`: without a title, the body's first line is one.
    pub fn add_note(&mut self, input: &Value, now: u64) -> Result<Note, Failure> {
        object(input)?;
        if self.full() {
            return Err((409, format!("Today holds at most {MAX_ENTRIES} to-dos and notes: delete some first")));
        }
        let body = text_of(&input["body"], "body")?.unwrap_or_default();
        let title = match &input["title"] {
            Value::Null => first_line(&body).ok_or_else(|| bad("title or body is missing"))?,
            Value::String(s) if s.trim().is_empty() => first_line(&body).ok_or_else(|| bad("title or body is missing"))?,
            v => title_of(v, "title")?,
        };
        let note = Note { id: self.new_id('n'), title, body, updated: now, created: now };
        self.notes.push(note.clone());
        Ok(note)
    }

    /// `{title?, body?}` replaces them; `{append}` adds a paragraph to the body.
    pub fn update_note(&mut self, id: &str, input: &Value, now: u64) -> Result<Note, Failure> {
        let fields = object(input)?;
        if let Some(other) = fields.keys().find(|k| !["title", "body", "append"].contains(&k.as_str())) {
            return Err(bad(format!("{other}: not a field of a note (title, body, append)")));
        }
        let index = self.notes.iter().position(|n| n.id == id).ok_or((404, format!("no note {id}")))?;
        let mut note = self.notes[index].clone();
        if fields.contains_key("title") {
            note.title = title_of(&input["title"], "title")?;
        }
        if fields.contains_key("body") {
            note.body = text_of(&input["body"], "body")?.unwrap_or_default();
        }
        if let Some(more) = fields.get("append").filter(|v| !v.is_null()) {
            let more = more.as_str().ok_or_else(|| bad("append: a string"))?.replace("\r\n", "\n");
            let joined = if note.body.trim().is_empty() {
                more
            } else {
                format!("{}\n{}", note.body.trim_end_matches('\n'), more)
            };
            if joined.chars().count() > MAX_TEXT {
                return Err(bad(format!("body: at most {MAX_TEXT} characters with what is appended")));
            }
            note.body = joined;
        }
        note.updated = now;
        self.notes[index] = note.clone();
        Ok(note)
    }

    pub fn delete_note(&mut self, id: &str) -> Result<Note, Failure> {
        let index = self.notes.iter().position(|n| n.id == id).ok_or((404, format!("no note {id}")))?;
        Ok(self.notes.remove(index))
    }

    /// The to-dos in their one order: by day (someday last), within a day
    /// the ones without a time first, then by time, then as they were added.
    pub fn sorted(&self) -> Vec<Todo> {
        let mut out: Vec<Todo> = self.todos.iter().map(public).collect();
        out.sort_by_key(|t| {
            (
                t.date.as_deref().and_then(parse_date).unwrap_or(i64::MAX),
                t.time.as_deref().and_then(parse_time).unwrap_or(-1),
                t.created,
                t.id.clone(),
            )
        });
        out
    }

    /// GET /v1/today/todos: `from`, `to` (days, both included), `done` (1 or
    /// 0), `overdue=1` (also what is not done from before `from`), `undated=1`
    /// (also someday's). Without a range: every to-do.
    pub fn query_todos(&self, query: &HashMap<String, String>, today: i64) -> Result<Vec<Todo>, Failure> {
        let day = |name: &str| -> Result<Option<i64>, Failure> {
            match query.get(name).map(|s| s.trim()).filter(|s| !s.is_empty()) {
                None => Ok(None),
                Some(s) => parse_date(s).map(Some).ok_or_else(|| bad(format!("{name}: YYYY-MM-DD"))),
            }
        };
        let (from, to) = (day("from")?, day("to")?);
        let flag = |name: &str| query.get(name).is_some_and(|v| v == "1" || v == "true");
        let done = match query.get("done").map(String::as_str) {
            None | Some("") => None,
            Some("1" | "true") => Some(true),
            Some("0" | "false") => Some(false),
            Some(_) => return Err(bad("done: 1 or 0")),
        };
        let ranged = from.is_some() || to.is_some();
        let start = from.unwrap_or(today);
        Ok(self
            .sorted()
            .into_iter()
            .filter(|t| done.is_none_or(|d| t.done == d))
            .filter(|t| match t.date.as_deref().and_then(parse_date) {
                None => !ranged || flag("undated"),
                Some(d) => {
                    let in_range = from.is_none_or(|f| d >= f) && to.is_none_or(|e| d <= e);
                    in_range || (flag("overdue") && !t.done && d < start)
                }
            })
            .collect())
    }

    /// GET /v1/today/notes: newest first, without their text, or (with `q`)
    /// the ones whose title or text has every word of it, with a snippet.
    pub fn query_notes(&self, q: Option<&str>) -> Vec<Value> {
        let words: Vec<String> = q.unwrap_or("").split_whitespace().map(str::to_lowercase).collect();
        let mut notes: Vec<&Note> = self
            .notes
            .iter()
            .filter(|n| {
                let hay = format!("{}\n{}", n.title, n.body).to_lowercase();
                words.iter().all(|w| hay.contains(w.as_str()))
            })
            .collect();
        notes.sort_by(|a, b| b.updated.cmp(&a.updated).then_with(|| b.id.cmp(&a.id)));
        notes
            .into_iter()
            .map(|n| {
                let mut v = json!({
                    "id": n.id, "title": n.title, "updated": n.updated, "created": n.created,
                    "chars": n.body.chars().count(), "preview": preview(&n.body, 160),
                });
                if let Some(w) = words.first() {
                    if let Some(s) = snippet(&n.body, w) {
                        v["snippet"] = json!(s);
                    }
                }
                v
            })
            .collect()
    }

    /// The reminders to ring now: due within the last hour and not rung
    /// yet for that date and time.
    pub fn due_now(&self, now_min: i64) -> Vec<String> {
        self.todos
            .iter()
            .filter(|t| {
                let Some(due) = due_minute(t) else { return false };
                due <= now_min && due > now_min - MISSED_MINUTES && t.reminded != reminder_key(t)
            })
            .map(|t| t.id.clone())
            .collect()
    }

    /// Ones that will never ring (missed by more than an hour) are put to
    /// rest, so a later look does not count them again. True if any changed.
    pub fn retire_missed(&mut self, now_min: i64) -> bool {
        let mut any = false;
        for t in &mut self.todos {
            if let (Some(due), Some(key)) = (due_minute(t), reminder_key(t)) {
                if due <= now_min - MISSED_MINUTES && t.reminded.as_ref() != Some(&key) {
                    t.reminded = Some(key);
                    any = true;
                }
            }
        }
        any
    }

    pub fn mark_reminded(&mut self, id: &str) {
        if let Some(t) = self.todos.iter_mut().find(|t| t.id == id) {
            t.reminded = reminder_key(t);
        }
    }

    /// Seconds from `now` (local seconds) to the next reminder due, if any.
    pub fn next_reminder_in(&self, now: i64) -> Option<i64> {
        let now_min = now.div_euclid(60);
        self.todos
            .iter()
            .filter(|t| t.reminded != reminder_key(t))
            .filter_map(due_minute)
            .filter(|due| *due > now_min)
            .map(|due| due * 60 - now)
            .min()
    }

    /// The status line of its pill: what is left today and what is overdue.
    pub fn status(&self, today: i64) -> String {
        let open = self.todos.iter().filter(|t| !t.done);
        let (mut due, mut late) = (0usize, 0usize);
        for t in open {
            match t.date.as_deref().and_then(parse_date) {
                Some(d) if d == today => due += 1,
                Some(d) if d < today => late += 1,
                _ => {}
            }
        }
        let mut parts = Vec::new();
        if due > 0 {
            parts.push(tf("{n} to do today", &[("n", &due.to_string())]));
        }
        if late > 0 {
            parts.push(tf("{n} overdue", &[("n", &late.to_string())]));
        }
        if parts.is_empty() {
            t("Nothing due today")
        } else {
            parts.join(" · ")
        }
    }
}

/// How long the reminder task sleeps from `now` (local seconds): to the next
/// reminder or the next local midnight (the day's lists change then), never
/// longer than an hour while a reminder waits, and at least a second.
pub fn sleep_for(data: &Data, now: i64) -> i64 {
    let midnight = 86_400 - now.rem_euclid(86_400);
    let wait = match data.next_reminder_in(now) {
        Some(due) => due.min(LONGEST_SLEEP).min(midnight),
        None => midnight,
    };
    wait.max(1)
}

fn first_line(body: &str) -> Option<String> {
    let line = body.lines().map(str::trim).find(|l| !l.is_empty())?;
    Some(line.chars().take(MAX_TITLE).collect())
}

fn preview(body: &str, max: usize) -> String {
    let flat = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        flat
    } else {
        format!("{}…", flat.chars().take(max).collect::<String>().trim_end())
    }
}

/// About 60 characters on each side of the first place `word` is found.
fn snippet(body: &str, word: &str) -> Option<String> {
    let lower = body.to_lowercase();
    // Lowercasing can change byte lengths: map back through char indices.
    let at = lower.find(word)?;
    let char_at = lower[..at].chars().count();
    let chars: Vec<char> = body.chars().collect();
    let start = char_at.saturating_sub(60);
    let end = (char_at + word.chars().count() + 60).min(chars.len());
    let text: String = chars[start..end].iter().collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
    Some(format!("{}{text}{}", if start > 0 { "…" } else { "" }, if end < chars.len() { "…" } else { "" }))
}

// ── The store on disk ────────────────────────────────────────────────────────

pub struct Today {
    data: Mutex<Data>,
    file: PathBuf,
    /// Wakes the reminder task: something changed.
    wake: Arc<Notify>,
}

fn load(file: &PathBuf) -> Data {
    match std::fs::read_to_string(file) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            // Kept aside rather than overwritten by an empty list.
            let aside = file.with_extension("json.unreadable");
            let _ = std::fs::rename(file, &aside);
            crate::log::line(format!("today: today.json could not be read ({e}); kept as today.json.unreadable"));
            Data::default()
        }),
        Err(_) => Data::default(),
    }
}

fn save(file: &PathBuf, data: &Data) {
    let Ok(text) = serde_json::to_string(data) else { return };
    let tmp = file.with_extension("json.tmp");
    if std::fs::write(&tmp, text).is_ok() {
        if let Err(e) = std::fs::rename(&tmp, file) {
            crate::log::line(format!("today: could not save today.json: {e}"));
        }
    }
}

impl Today {
    fn read<T>(&self, f: impl FnOnce(&Data) -> T) -> T {
        f(&self.data.lock().unwrap())
    }

    /// A change, saved at once when it worked; the reminder task looks again.
    fn change<T>(&self, f: impl FnOnce(&mut Data) -> Result<T, Failure>) -> Result<T, Failure> {
        let mut data = self.data.lock().unwrap();
        let mut copy = data.clone();
        let out = f(&mut copy)?;
        *data = copy;
        save(&self.file, &data);
        drop(data);
        self.wake.notify_one();
        Ok(out)
    }
}

fn state(app: &AppHandle) -> Option<tauri::State<'_, Today>> {
    app.try_state::<Today>()
}

fn today_days() -> i64 {
    local_now().div_euclid(86_400)
}

/// Tells the island: the whole state (the "today" event) and the pill's status.
fn publish(app: &AppHandle) {
    let Some(store) = state(app) else { return };
    let today = today_days();
    let (snapshot, status) = store.read(|d| {
        (TodayState { today: format_date(today), todos: d.sorted(), notes: d.notes.clone() }, d.status(today))
    });
    let _ = app.emit("today", snapshot);
    apps::set_internal_items(app, APP_ID, Some(AppItems { status: Some(status), sections: Vec::new(), updated: now_ms(), views: Vec::new() }));
}

// ── Starting, and the one timer ──────────────────────────────────────────────

/// At launch, after the registry: loads today.json, takes the presses of its
/// reminders, rings what was missed in the last hour, and starts the timer.
pub fn start(app: &AppHandle) {
    let dir = crate::settings::local_dir();
    let _ = crate::platform::ensure_private_dir(&dir);
    let file = dir.join("today.json");
    let wake = Arc::new(Notify::new());
    app.manage(Today { data: Mutex::new(load(&file)), file, wake: wake.clone() });
    apps::set_internal_handler(APP_ID, Arc::new(|app, p| Box::pin(press(app, p))));
    publish(app);
    tauri::async_runtime::spawn(reminders(app.clone(), wake));
}

/// Sleeps until the next reminder (or midnight), rings what is due, and
/// sleeps again; any change wakes it to look again. Nothing else runs.
async fn reminders(app: AppHandle, wake: Arc<Notify>) {
    let mut day = today_days();
    loop {
        let now = local_now();
        ring(&app, now.div_euclid(60));
        if now.div_euclid(86_400) != day {
            // A new day: today's list and the pill's status move with it.
            day = now.div_euclid(86_400);
            publish(&app);
        }
        let wait = match state(&app) {
            Some(store) => store.read(|d| sleep_for(d, now)),
            None => return,
        };
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(wait as u64)) => {}
            _ = wake.notified() => {}
        }
    }
}

/// Posts the reminders due now, each once, and puts the long-missed ones to rest.
fn ring(app: &AppHandle, now_min: i64) {
    let Some(store) = state(app) else { return };
    let (due, retired) = {
        let mut data = store.data.lock().unwrap();
        let due: Vec<Todo> = data.due_now(now_min).iter().filter_map(|id| data.todo(id).cloned()).collect();
        for t in &due {
            data.mark_reminded(&t.id);
        }
        let retired = data.retire_missed(now_min);
        if !due.is_empty() || retired {
            save(&store.file, &data);
        }
        (due, retired)
    };
    for todo in due {
        let when = todo.time.clone().unwrap_or_default();
        let body = match todo.note.as_deref().and_then(first_line) {
            Some(line) => format!("{when} · {line}"),
            None => when,
        };
        let posted = apps::post_internal(app, APP_ID, NewNotification {
            title: todo.title.clone(),
            body: Some(body),
            url: None,
            importance: "normal",
            actions: vec![Action { id: "done".into(), label: t("Done") }],
            meta: Some(json!({ "kind": "todo", "id": todo.id })),
            item: Some(todo.id.clone()),
        });
        if let Err(e) = posted {
            crate::log::line(format!("today: could not post a reminder: {e}"));
        }
    }
    if retired {
        crate::log::line("today: reminders missed by more than an hour were put to rest");
    }
}

/// A reminder's "Done": the to-do is ticked off.
async fn press(app: AppHandle, press: Press) -> Result<(), String> {
    let id = match &press {
        Press::Notification { notification, action } if action == "done" => {
            notification.meta.as_ref().and_then(|m| m["id"].as_str()).map(str::to_string)
        }
        Press::Item { item, action } if action == "done" => Some(item.id.clone()),
        _ => None,
    }
    .ok_or("nothing to do with that press")?;
    update_todo(&app, &id, &json!({ "done": true })).map(|_| ()).map_err(|e| e.1)
}

/// The bell follows the to-do: done, its reminder is read; deleted, gone.
fn follow_bell(app: &AppHandle, todo: &str, deleted: bool) {
    let Some(registry) = app.try_state::<apps::Apps>() else { return };
    let mine: Vec<String> = registry
        .notifications_of(APP_ID)
        .into_iter()
        .filter(|n| n.meta.as_ref().is_some_and(|m| m["id"] == todo) && (deleted || !n.read))
        .map(|n| n.id)
        .collect();
    if mine.is_empty() {
        return;
    }
    if deleted {
        registry.read_and_dismiss(&[], &mine);
    } else {
        registry.read_and_dismiss(&mine, &[]);
    }
    apps::changed(app);
}

// ── Every change, from the island or the API ─────────────────────────────────

fn with_store<T>(app: &AppHandle, f: impl FnOnce(&Today) -> Result<T, Failure>) -> Result<T, Failure> {
    let store = state(app).ok_or((503, "Today is not ready".to_string()))?;
    f(&store)
}

fn now_min() -> i64 {
    local_now().div_euclid(60)
}

fn add_todo(app: &AppHandle, input: &Value) -> Result<Todo, Failure> {
    let todo = with_store(app, |s| s.change(|d| d.add_todo(input, now_ms(), now_min())))?;
    publish(app);
    Ok(public(&todo))
}

fn update_todo(app: &AppHandle, id: &str, input: &Value) -> Result<Todo, Failure> {
    let todo = with_store(app, |s| s.change(|d| d.update_todo(id, input, now_ms(), now_min())))?;
    if todo.done {
        follow_bell(app, id, false);
    }
    publish(app);
    Ok(public(&todo))
}

fn delete_todo(app: &AppHandle, id: &str) -> Result<Todo, Failure> {
    let todo = with_store(app, |s| s.change(|d| d.delete_todo(id)))?;
    follow_bell(app, id, true);
    publish(app);
    Ok(public(&todo))
}

fn add_note(app: &AppHandle, input: &Value) -> Result<Note, Failure> {
    let note = with_store(app, |s| s.change(|d| d.add_note(input, now_ms())))?;
    publish(app);
    Ok(note)
}

fn update_note(app: &AppHandle, id: &str, input: &Value) -> Result<Note, Failure> {
    let note = with_store(app, |s| s.change(|d| d.update_note(id, input, now_ms())))?;
    publish(app);
    Ok(note)
}

fn delete_note(app: &AppHandle, id: &str) -> Result<Note, Failure> {
    let note = with_store(app, |s| s.change(|d| d.delete_note(id)))?;
    publish(app);
    Ok(note)
}

// ── The island's side ────────────────────────────────────────────────────────

#[tauri::command]
pub fn today_state(app: AppHandle) -> Option<TodayState> {
    let store = state(&app)?;
    let today = today_days();
    Some(store.read(|d| TodayState { today: format_date(today), todos: d.sorted(), notes: d.notes.clone() }))
}

#[tauri::command]
pub fn today_todo_add(app: AppHandle, input: Value) -> Result<Todo, String> {
    add_todo(&app, &input).map_err(|e| e.1)
}

#[tauri::command]
pub fn today_todo_update(app: AppHandle, id: String, input: Value) -> Result<Todo, String> {
    update_todo(&app, &id, &input).map_err(|e| e.1)
}

#[tauri::command]
pub fn today_todo_delete(app: AppHandle, id: String) -> Result<(), String> {
    delete_todo(&app, &id).map(|_| ()).map_err(|e| e.1)
}

#[tauri::command]
pub fn today_note_add(app: AppHandle, input: Value) -> Result<Note, String> {
    add_note(&app, &input).map_err(|e| e.1)
}

#[tauri::command]
pub fn today_note_update(app: AppHandle, id: String, input: Value) -> Result<Note, String> {
    update_note(&app, &id, &input).map_err(|e| e.1)
}

#[tauri::command]
pub fn today_note_delete(app: AppHandle, id: String) -> Result<(), String> {
    delete_note(&app, &id).map(|_| ()).map_err(|e| e.1)
}

// ── Claude Code's side: /v1/today/* ──────────────────────────────────────────

/// What a list of to-dos says about now, so a caller can resolve "tomorrow".
fn clock() -> Value {
    let now = local_now();
    let day = now.div_euclid(86_400);
    let minute = now.rem_euclid(86_400) / 60;
    json!({ "today": format_date(day), "weekday": weekday(day), "now": format!("{:02}:{:02}", minute / 60, minute % 60) })
}

/// The id after a collection's path: "/v1/today/todos/t3" → "t3".
fn id_in<'a>(path: &'a str, base: &str) -> Option<&'a str> {
    path.strip_prefix(base)?.strip_prefix('/').filter(|id| !id.is_empty() && !id.contains('/'))
}

/// GET/POST /v1/today/todos, PATCH/DELETE /v1/today/todos/{id}, GET/POST
/// /v1/today/notes, GET/PATCH/DELETE /v1/today/notes/{id}. Errors carry
/// their HTTP status; the token was checked by the caller.
pub fn route(app: &AppHandle, method: &str, path: &str, query: &HashMap<String, String>, body: &[u8]) -> Result<Value, Failure> {
    let input = || -> Result<Value, Failure> { serde_json::from_slice(body).map_err(|e| bad(format!("JSON: {e}"))) };
    const TODOS: &str = "/v1/today/todos";
    const NOTES: &str = "/v1/today/notes";
    match (method, path) {
        ("GET", TODOS) => {
            let todos = with_store(app, |s| s.read(|d| d.query_todos(query, today_days())))?;
            let mut out = clock();
            out["todos"] = json!(todos);
            Ok(out)
        }
        ("POST", TODOS) => Ok(json!(add_todo(app, &input()?)?)),
        ("GET", NOTES) => {
            let q = query.get("q").map(|q| q.trim()).filter(|q| !q.is_empty());
            if q.is_some_and(|q| q.chars().count() > 200) {
                return Err(bad("q: at most 200 characters"));
            }
            let notes = with_store(app, |s| Ok(s.read(|d| d.query_notes(q))))?;
            Ok(json!({ "notes": notes }))
        }
        ("POST", NOTES) => Ok(json!(add_note(app, &input()?)?)),
        _ => {
            if let Some(id) = id_in(path, TODOS) {
                return match method {
                    "GET" => with_store(app, |s| s.read(|d| d.todo(id).map(public)).map(|t| json!(t)).ok_or((404, format!("no to-do {id}")))),
                    "PATCH" => Ok(json!(update_todo(app, id, &input()?)?)),
                    "DELETE" => delete_todo(app, id).map(|t| json!({ "ok": true, "deleted": t.id })),
                    _ => Err((404, format!("no {method} {path}"))),
                };
            }
            if let Some(id) = id_in(path, NOTES) {
                return match method {
                    "GET" => with_store(app, |s| s.read(|d| d.note(id).cloned()).map(|n| json!(n)).ok_or((404, format!("no note {id}")))),
                    "PATCH" => Ok(json!(update_note(app, id, &input()?)?)),
                    "DELETE" => delete_note(app, id).map(|n| json!({ "ok": true, "deleted": n.id })),
                    _ => Err((404, format!("no {method} {path}"))),
                };
            }
            Err((404, format!("no {method} {path}")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_792_300_000_000;
    /// 2026-10-18 14:00 on the local clock, in minutes.
    fn at(date: &str, time: &str) -> i64 {
        parse_date(date).unwrap() * 1440 + parse_time(time).unwrap()
    }

    fn add(d: &mut Data, input: Value) -> Todo {
        d.add_todo(&input, NOW, at("2026-10-18", "14:00")).unwrap()
    }

    #[test]
    fn days_and_times_are_checked_and_written_one_way() {
        assert_eq!(parse_date("2026-10-18").map(format_date).as_deref(), Some("2026-10-18"));
        assert_eq!(parse_date("2028-02-29").map(format_date).as_deref(), Some("2028-02-29"));
        for bad in ["2026-02-29", "2026-13-01", "2026-1-01", "26-10-18", "2026/10/18", "tomorrow", "", "1969-12-31", "2026-10-1x"] {
            assert_eq!(parse_date(bad), None, "{bad}");
        }
        assert_eq!(parse_time("09:05"), Some(545));
        for bad in ["9:05", "24:00", "12:60", "12:5", "noon", "12-00"] {
            assert_eq!(parse_time(bad), None, "{bad}");
        }
        assert_eq!(weekday(parse_date("2026-10-18").unwrap()), "Sunday");
        assert_eq!(weekday(parse_date("1970-01-01").unwrap()), "Thursday");
    }

    #[test]
    fn the_store_round_trips_through_its_file() {
        let mut d = Data::default();
        let a = add(&mut d, json!({ "title": "Call Sarah", "date": "2026-10-19", "time": "15:00", "note": "about the deck" }));
        add(&mut d, json!({ "title": "Someday: learn the cello" }));
        d.add_note(&json!({ "title": "Ideas", "body": "One\nTwo" }), NOW).unwrap();
        assert_eq!(a.id, "t1");
        let file = std::env::temp_dir().join(format!("winotch-today-test-{}.json", std::process::id()));
        save(&file, &d);
        assert!(!file.with_extension("json.tmp").exists(), "written aside, then moved into place");
        let back = load(&file);
        assert_eq!(back, d);
        assert_eq!(back.next, 3);
        // An unreadable file is kept aside, never overwritten by an empty one.
        std::fs::write(&file, "{ not json").unwrap();
        assert_eq!(load(&file), Data::default());
        let aside = file.with_extension("json.unreadable");
        assert!(aside.exists());
        let _ = std::fs::remove_file(&aside);
        let _ = std::fs::remove_file(&file);
        // A file from a later version with fields we do not know still loads.
        let later: Data = serde_json::from_value(json!({ "todos": [{ "id": "t9", "title": "x", "created": 1, "colour": "red" }], "next": 9 })).unwrap();
        assert_eq!(later.todos[0].title, "x");
    }

    #[test]
    fn what_comes_in_is_checked_with_its_bounds() {
        let mut d = Data::default();
        let err = |d: &mut Data, v: Value| d.add_todo(&v, NOW, 0).unwrap_err();
        assert_eq!(err(&mut d, json!({})).1, "title is missing");
        assert_eq!(err(&mut d, json!({ "title": 3 })).1, "title: a string");
        assert_eq!(err(&mut d, json!({ "title": "   " })).1, "title is missing");
        assert!(err(&mut d, json!({ "title": "x".repeat(201) })).1.contains("at most 200"));
        assert!(d.add_todo(&json!({ "title": "x".repeat(200) }), NOW, 0).is_ok());
        assert!(err(&mut d, json!({ "title": "x", "note": "n".repeat(20_001) })).1.contains("at most 20000"));
        assert!(err(&mut d, json!({ "title": "x", "date": "tomorrow" })).1.starts_with("date:"));
        assert!(err(&mut d, json!({ "title": "x", "date": "2026-10-19", "time": "3pm" })).1.starts_with("time:"));
        assert_eq!(err(&mut d, json!({ "title": "x", "time": "15:00" })).1, "time needs a date");
        assert_eq!(err(&mut d, json!({ "title": "x", "done": "yes" })).1, "done: true or false");
        assert_eq!(err(&mut d, json!("x")).1, "a JSON object");
        // A title is one line.
        let t = d.add_todo(&json!({ "title": "  two\nlines  " }), NOW, 0).unwrap();
        assert_eq!(t.title, "two lines");
        // Notes: a title, or the body's first line; the body's bound.
        assert_eq!(d.add_note(&json!({ "body": "\n  First line \nmore" }), NOW).unwrap().title, "First line");
        assert_eq!(d.add_note(&json!({}), NOW).unwrap_err().1, "title or body is missing");
        assert!(d.add_note(&json!({ "title": "x", "body": "b".repeat(20_001) }), NOW).unwrap_err().1.contains("at most 20000"));
    }

    #[test]
    fn at_most_five_thousand_entries() {
        let mut d = Data::default();
        d.todos = (0..4999).map(|i| Todo { id: format!("t{i}"), title: "x".into(), created: 1, ..Todo::default() }).collect();
        d.add_note(&json!({ "title": "the last one" }), NOW).unwrap();
        let (status, message) = d.add_todo(&json!({ "title": "one more" }), NOW, 0).unwrap_err();
        assert_eq!(status, 409);
        assert!(message.contains("5000"));
        assert_eq!(d.add_note(&json!({ "title": "one more" }), NOW).unwrap_err().0, 409);
    }

    #[test]
    fn updates_change_only_what_they_name() {
        let mut d = Data::default();
        let a = add(&mut d, json!({ "title": "Call Sarah", "date": "2026-10-19", "time": "15:00", "note": "deck" }));
        let now = at("2026-10-18", "14:00");
        let moved = d.update_todo(&a.id, &json!({ "date": "2026-10-20" }), NOW, now).unwrap();
        assert_eq!((moved.date.as_deref(), moved.time.as_deref(), moved.note.as_deref()), (Some("2026-10-20"), Some("15:00"), Some("deck")));
        let done = d.update_todo(&a.id, &json!({ "done": true }), NOW + 5, now).unwrap();
        assert!(done.done && done.done_at == Some(NOW + 5));
        let undone = d.update_todo(&a.id, &json!({ "done": false }), NOW + 9, now).unwrap();
        assert!(!undone.done && undone.done_at.is_none());
        // Clearing the date takes the time with it; clearing the note empties it.
        let someday = d.update_todo(&a.id, &json!({ "date": null, "note": "" }), NOW, now).unwrap();
        assert_eq!((someday.date, someday.time, someday.note), (None, None, None));
        assert_eq!(d.update_todo(&a.id, &json!({ "time": "09:00" }), NOW, now).unwrap_err().1, "time needs a date");
        assert!(d.update_todo(&a.id, &json!({ "colour": "red" }), NOW, now).unwrap_err().1.starts_with("colour"));
        assert_eq!(d.update_todo("t99", &json!({ "done": true }), NOW, now).unwrap_err().0, 404);
        // A refused update changes nothing.
        assert_eq!(d.todo(&a.id).unwrap().title, "Call Sarah");
        assert_eq!(d.delete_todo(&a.id).unwrap().id, a.id);
        assert_eq!(d.delete_todo(&a.id).unwrap_err().0, 404);
    }

    #[test]
    fn notes_are_replaced_appended_searched_and_deleted() {
        let mut d = Data::default();
        let n = d.add_note(&json!({ "title": "Groceries", "body": "milk" }), NOW).unwrap();
        let more = d.update_note(&n.id, &json!({ "append": "eggs" }), NOW + 1).unwrap();
        assert_eq!(more.body, "milk\neggs");
        assert_eq!(more.updated, NOW + 1);
        let replaced = d.update_note(&n.id, &json!({ "title": "Shop", "body": "bread" }), NOW + 2).unwrap();
        assert_eq!((replaced.title.as_str(), replaced.body.as_str()), ("Shop", "bread"));
        let empty = d.update_note(&n.id, &json!({ "body": "" }), NOW + 3).unwrap();
        assert_eq!(empty.body, "");
        assert_eq!(d.update_note(&n.id, &json!({ "append": "first" }), NOW + 4).unwrap().body, "first");
        d.update_note(&n.id, &json!({ "body": "x".repeat(19_999) }), NOW).unwrap();
        assert!(d.update_note(&n.id, &json!({ "append": "yy" }), NOW).unwrap_err().1.contains("appended"));
        d.add_note(&json!({ "title": "Trip to Lisbon", "body": "Flights on Friday. Hotel near the river." }), NOW + 10).unwrap();
        let found = d.query_notes(Some("HOTEL river"));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0]["title"], "Trip to Lisbon");
        assert!(found[0]["snippet"].as_str().unwrap().contains("Hotel"));
        assert!(found[0].get("body").is_none(), "a list never carries the whole text");
        assert_eq!(d.query_notes(None).len(), 2);
        assert_eq!(d.query_notes(None)[0]["title"], "Trip to Lisbon", "newest first");
        assert!(d.query_notes(Some("nowhere")).is_empty());
        assert_eq!(d.delete_note(&n.id).unwrap().id, n.id);
        assert_eq!(d.update_note(&n.id, &json!({ "append": "x" }), NOW).unwrap_err().0, 404);
    }

    #[test]
    fn a_range_filters_the_days_and_can_bring_the_overdue_and_someday() {
        let mut d = Data::default();
        add(&mut d, json!({ "title": "late", "date": "2026-10-16" }));
        add(&mut d, json!({ "title": "late but done", "date": "2026-10-15", "done": true }));
        add(&mut d, json!({ "title": "today 15", "date": "2026-10-18", "time": "15:00" }));
        add(&mut d, json!({ "title": "today", "date": "2026-10-18" }));
        add(&mut d, json!({ "title": "next week", "date": "2026-10-26" }));
        add(&mut d, json!({ "title": "someday" }));
        let today = parse_date("2026-10-18").unwrap();
        let q = |pairs: &[(&str, &str)]| {
            let query: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
            d.query_todos(&query, today).unwrap().into_iter().map(|t| t.title).collect::<Vec<_>>()
        };
        assert_eq!(q(&[]), ["late but done", "late", "today", "today 15", "next week", "someday"], "untimed before timed within a day");
        assert_eq!(q(&[("from", "2026-10-18"), ("to", "2026-10-25")]), ["today", "today 15"]);
        assert_eq!(q(&[("from", "2026-10-18"), ("to", "2026-10-25"), ("overdue", "1"), ("undated", "1")]), ["late", "today", "today 15", "someday"]);
        assert_eq!(q(&[("done", "1")]), ["late but done"]);
        assert!(d.query_todos(&HashMap::from([("from".into(), "monday".into())]), today).is_err());
        assert!(d.query_todos(&HashMap::from([("done".into(), "maybe".into())]), today).is_err());
    }

    #[test]
    fn the_next_reminder_is_the_nearest_one_not_rung_yet() {
        let mut d = Data::default();
        let now = at("2026-10-18", "14:00");
        assert_eq!(d.next_reminder_in(now * 60), None);
        add(&mut d, json!({ "title": "later", "date": "2026-10-18", "time": "18:00" }));
        let soon = add(&mut d, json!({ "title": "soon", "date": "2026-10-18", "time": "14:30" }));
        add(&mut d, json!({ "title": "no time", "date": "2026-10-18" }));
        assert_eq!(d.next_reminder_in(now * 60 + 15), Some(30 * 60 - 15));
        // Done, or rung already: the next one is the one after.
        d.update_todo(&soon.id, &json!({ "done": true }), NOW, now).unwrap();
        assert_eq!(d.next_reminder_in(now * 60), Some(4 * 3600));
        // The timer: to the reminder, at most an hour while one waits, else to midnight.
        assert_eq!(sleep_for(&d, now * 60), 3600);
        assert_eq!(sleep_for(&d, at("2026-10-18", "17:50") * 60), 600);
        assert_eq!(sleep_for(&Data::default(), at("2026-10-18", "23:00") * 60), 3600, "to midnight");
        assert_eq!(sleep_for(&Data::default(), at("2026-10-18", "23:59") * 60 + 59), 1);
        assert_eq!(sleep_for(&d, at("2026-10-18", "17:59") * 60 + 59), 1, "never zero");
    }

    #[test]
    fn a_reminder_rings_once_at_its_time_and_again_only_for_a_new_time() {
        let mut d = Data::default();
        let now = at("2026-10-18", "14:00");
        let a = add(&mut d, json!({ "title": "Call Sarah", "date": "2026-10-18", "time": "14:30" }));
        assert!(d.due_now(now + 29).is_empty());
        assert_eq!(d.due_now(now + 30), [a.id.clone()]);
        d.mark_reminded(&a.id);
        assert!(d.due_now(now + 31).is_empty(), "once");
        assert_eq!(d.next_reminder_in((now + 31) * 60), None);
        // Moved to a new time: it rings again then.
        d.update_todo(&a.id, &json!({ "time": "16:00" }), NOW, now + 31).unwrap();
        assert_eq!(d.next_reminder_in((now + 31) * 60), Some(89 * 60));
        assert_eq!(d.due_now(now + 120), [a.id.clone()]);
        // Done: never.
        d.update_todo(&a.id, &json!({ "done": true }), NOW, now + 100).unwrap();
        assert!(d.due_now(now + 120).is_empty());
    }

    #[test]
    fn a_time_set_in_the_past_never_rings() {
        let mut d = Data::default();
        let now = at("2026-10-18", "14:00");
        // Added (by Claude, say) at 14:00 for 13:45: nothing to remind of.
        let a = d.add_todo(&json!({ "title": "x", "date": "2026-10-18", "time": "13:45" }), NOW, now).unwrap();
        assert!(d.due_now(now).is_empty());
        // Moved to a time ahead: it rings then.
        d.update_todo(&a.id, &json!({ "time": "14:10" }), NOW, now).unwrap();
        assert_eq!(d.due_now(now + 10), [a.id]);
    }

    #[test]
    fn missed_while_closed_rings_once_within_the_hour_and_older_ones_never() {
        // As today.json was left when winotch closed at 09:00.
        let mut d = Data::default();
        let closed = at("2026-10-18", "09:00");
        let recent = d.add_todo(&json!({ "title": "recent", "date": "2026-10-18", "time": "13:20" }), NOW, closed).unwrap();
        let old = d.add_todo(&json!({ "title": "old", "date": "2026-10-18", "time": "11:00" }), NOW, closed).unwrap();
        let edge = d.add_todo(&json!({ "title": "edge", "date": "2026-10-18", "time": "13:00" }), NOW, closed).unwrap();
        d.add_todo(&json!({ "title": "ahead", "date": "2026-10-18", "time": "17:00" }), NOW, closed).unwrap();
        // Started again at 14:00: what was due in the last hour rings, once.
        let start = at("2026-10-18", "14:00");
        assert_eq!(d.due_now(start), [recent.id.clone()]);
        assert!(!d.due_now(start).contains(&edge.id), "exactly an hour ago is too old");
        for id in d.due_now(start) {
            d.mark_reminded(&id);
        }
        assert!(d.retire_missed(start));
        assert!(d.due_now(start).is_empty());
        assert!(!d.retire_missed(start), "nothing left to put to rest");
        assert_eq!(d.todo(&old.id).unwrap().reminded.as_deref(), Some("2026-10-18 11:00"));
        // A minute later, a second start: nothing again.
        assert!(d.due_now(start + 1).is_empty());
        assert_eq!(d.next_reminder_in(start * 60), Some(3 * 3600));
    }

    #[test]
    fn the_reminder_record_stays_in_the_file_and_out_of_what_is_shown() {
        let mut d = Data::default();
        let a = add(&mut d, json!({ "title": "x", "date": "2026-10-18", "time": "14:30" }));
        d.mark_reminded(&a.id);
        assert!(serde_json::to_value(&d).unwrap()["todos"][0]["reminded"].is_string());
        let shown = serde_json::to_value(d.sorted()).unwrap();
        assert!(shown[0].get("reminded").is_none());
        assert_eq!(shown[0]["date"], "2026-10-18");
        assert!(shown[0].get("doneAt").is_none() && shown[0].get("note").is_none(), "absent, not null");
    }

    #[test]
    fn the_status_says_what_is_left_today_and_what_is_late() {
        crate::i18n::set_for_test("en");
        let mut d = Data::default();
        let today = parse_date("2026-10-18").unwrap();
        assert_eq!(d.status(today), "Nothing due today");
        add(&mut d, json!({ "title": "a", "date": "2026-10-18" }));
        add(&mut d, json!({ "title": "b", "date": "2026-10-18", "done": true }));
        assert_eq!(d.status(today), "1 to do today");
        add(&mut d, json!({ "title": "c", "date": "2026-10-17" }));
        assert_eq!(d.status(today), "1 to do today · 1 overdue");
    }

    #[test]
    fn paths_name_their_ids() {
        assert_eq!(id_in("/v1/today/todos/t3", "/v1/today/todos"), Some("t3"));
        assert_eq!(id_in("/v1/today/todos/", "/v1/today/todos"), None);
        assert_eq!(id_in("/v1/today/todos/t3/x", "/v1/today/todos"), None);
        assert_eq!(id_in("/v1/today/todosx", "/v1/today/todos"), None);
        assert_eq!(snippet("Some long text about the hotel near the river", "hotel").as_deref(), Some("Some long text about the hotel near the river"));
        assert_eq!(preview("a\n\nb   c", 160), "a b c");
        assert_eq!(preview(&"word ".repeat(100), 10), "word word…");
    }
}
