// Claude Code's sessions in the island's chat (WINOTCH.md). The chat lists the
// sessions Claude Code keeps on this computer, shows one's conversation, and
// sends it new messages by running the user's own `claude`, signed in as they
// are: `claude -p <message> --resume <session>` in the session's folder, or a
// new session in a folder they pick. The answer streams back as it is written.
//
// A session's conversation is read from Claude Code's own file
// (~/.claude/projects/<project>/<session>.jsonl). Its format is Claude Code's
// and may change between versions, so it is read defensively: only plain user
// and assistant text, one line for each tool used, and anything unknown skipped.
//
// A session open in a terminal is reached through that terminal: winotch types
// the message into the session's own console (Windows' AttachConsole and
// WriteConsoleInput), exactly as if it were typed there, and Claude Code takes
// it like any typed prompt, queued if it is busy. The console is the claude.exe
// the session's hooks come from (CLAUDE_PID, forwarded by winotch-hook).

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncReadExt};

use crate::island::WINDOW_LABEL;

/// Sessions listed in the chat, most recent first.
const LIST: usize = 30;
/// Messages shown of one session: its latest.
const KEEP: usize = 200;
/// Longest text kept of one message.
const MAX_TEXT: usize = 20_000;
/// Of a long session file only its end is read: the latest messages are there.
const READ_TAIL: u64 = 6 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SessionInfo {
    pub id: String,
    /// The folder it runs in.
    pub cwd: String,
    /// The folder's name, as the island names projects.
    pub project: String,
    /// Claude Code's own title for it, else its last prompt.
    pub title: String,
    /// Milliseconds since 1970, when it last changed.
    pub updated: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Message {
    /// "user", "assistant" or "tool".
    pub role: &'static str,
    pub text: String,
}

/// What a running send reports, as it happens.
#[derive(Debug, Clone, Serialize)]
struct Stream {
    /// The send it belongs to (the page's own number).
    request: u64,
    /// The session's id, once Claude Code has said it.
    session: String,
    /// "start", "delta" (the answer so far), "tool", "done" or "error".
    kind: &'static str,
    text: String,
}

/// Each open session's claude.exe, by session id, as its hooks report it.
#[derive(Default)]
pub struct Consoles(Mutex<HashMap<String, u32>>);

/// A hook payload: which claude.exe its session runs in; gone at SessionEnd.
pub fn observe(app: &AppHandle, payload: &Value) {
    let Some(id) = payload["session_id"].as_str().filter(|id| valid_id(id)) else { return };
    let Some(consoles) = app.try_state::<Consoles>() else { return };
    let mut map = consoles.0.lock().unwrap();
    if payload["hook_event_name"] == "SessionEnd" {
        map.remove(id);
        return;
    }
    let Some(pid) = payload["claude_pid"].as_str().and_then(|p| p.trim().parse::<u32>().ok()) else { return };
    if map.insert(id.to_string(), pid) != Some(pid) {
        crate::log::line(format!("sessions: {id} runs in claude.exe {pid}"));
    }
}

#[cfg(windows)]
fn alive(pid: u32) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return false };
        let mut code = 0u32;
        let ok = GetExitCodeProcess(h, &mut code).is_ok();
        let _ = CloseHandle(h);
        ok && code == 259 // STILL_ACTIVE
    }
}

#[cfg(not(windows))]
fn alive(_pid: u32) -> bool {
    false
}

/// Types `text` and Enter into the console of `pid`, as if typed there.
#[cfg(windows)]
fn type_into(pid: u32, text: &str) -> Result<(), String> {
    use windows::core::w;
    use windows::Win32::Foundation::{CloseHandle, GENERIC_READ, GENERIC_WRITE};
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows::Win32::System::Console::{
        AttachConsole, FreeConsole, WriteConsoleInputW, INPUT_RECORD, INPUT_RECORD_0, KEY_EVENT, KEY_EVENT_RECORD,
        KEY_EVENT_RECORD_0,
    };
    // A process has one console at a time: one typing at a time.
    static ONE: Mutex<()> = Mutex::new(());
    let _one = ONE.lock().unwrap();
    let key = |c: u16, vk: u16, down: bool| INPUT_RECORD {
        EventType: KEY_EVENT as u16,
        Event: INPUT_RECORD_0 {
            KeyEvent: KEY_EVENT_RECORD {
                bKeyDown: down.into(),
                wRepeatCount: 1,
                wVirtualKeyCode: vk,
                wVirtualScanCode: 0,
                uChar: KEY_EVENT_RECORD_0 { UnicodeChar: c },
                dwControlKeyState: 0,
            },
        },
    };
    let mut records = Vec::new();
    for c in text.encode_utf16() {
        records.push(key(c, 0, true));
        records.push(key(c, 0, false));
    }
    records.push(key(13, 0x0D, true));
    records.push(key(13, 0x0D, false));
    unsafe {
        let _ = FreeConsole();
        AttachConsole(pid).map_err(|e| format!("That session's terminal is gone ({e})."))?;
        let typed = CreateFileW(
            w!("CONIN$"),
            (GENERIC_READ | GENERIC_WRITE).0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(0),
            None,
        )
        .map_err(|e| e.to_string())
        .and_then(|input| {
            let mut written = 0u32;
            let r = WriteConsoleInputW(input, &records, &mut written).map_err(|e| e.to_string());
            let _ = CloseHandle(input);
            r
        });
        let _ = FreeConsole();
        typed
    }
}

#[cfg(not(windows))]
fn type_into(_pid: u32, _text: &str) -> Result<(), String> {
    Err("Typing into a terminal is only on Windows for now.".into())
}

/// The open sessions winotch can type into now.
#[tauri::command]
pub fn sessions_reachable(consoles: tauri::State<Consoles>) -> Vec<String> {
    let mut map = consoles.0.lock().unwrap();
    map.retain(|_, pid| alive(*pid));
    map.keys().cloned().collect()
}

/// Sends `text` to the session `id` through its own terminal: typed into its
/// console and entered, as if the user had typed it there.
#[tauri::command]
pub async fn session_type(consoles: tauri::State<'_, Consoles>, id: String, text: String) -> Result<(), String> {
    let pid = consoles.0.lock().unwrap().get(&id).copied().ok_or("winotch does not know this session's terminal yet.")?;
    // The prompt is one line: Enter sends it.
    let text = clip(&text.split_whitespace().collect::<Vec<_>>().join(" "), 8000);
    if text.is_empty() {
        return Err("Nothing to send.".into());
    }
    crate::log::line(format!("chat: typing into {id} (claude.exe {pid})"));
    let result = tauri::async_runtime::spawn_blocking(move || type_into(pid, &text)).await.map_err(|e| e.to_string())?;
    if let Err(e) = &result {
        crate::log::line(format!("chat: typing failed: {e}"));
    }
    result
}

/// Sessions with a send in flight: one at a time each.
#[derive(Default)]
pub struct Sending(Mutex<HashMap<String, u64>>);

fn claude_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default();
    PathBuf::from(home).join(".claude")
}

/// A session id is a UUID: anything else is refused before it reaches a path.
fn valid_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

fn clip(text: &str, max: usize) -> String {
    let t = text.trim();
    if t.chars().count() <= max {
        t.to_string()
    } else {
        let mut s: String = t.chars().take(max).collect();
        s.push('…');
        s
    }
}

fn one_line(text: &str, max: usize) -> String {
    clip(&text.split_whitespace().collect::<Vec<_>>().join(" "), max)
}

/// Every session file, newest first.
fn session_files() -> Vec<(PathBuf, u64)> {
    let mut out = Vec::new();
    let Ok(projects) = std::fs::read_dir(claude_dir().join("projects")) else { return out };
    for project in projects.flatten() {
        let Ok(files) = std::fs::read_dir(project.path()) else { continue };
        for f in files.flatten() {
            let path = f.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let modified = f
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.push((path, modified));
        }
    }
    out.sort_by(|a, b| b.1.cmp(&a.1));
    out
}

fn find_file(id: &str) -> Option<PathBuf> {
    if !valid_id(id) {
        return None;
    }
    // Remembered: the chat asks for the same session every few seconds.
    static FOUND: Mutex<Option<HashMap<String, PathBuf>>> = Mutex::new(None);
    if let Some(path) = FOUND.lock().unwrap().as_ref().and_then(|m| m.get(id)).filter(|p| p.is_file()) {
        return Some(path.clone());
    }
    let name = format!("{id}.jsonl");
    let projects = std::fs::read_dir(claude_dir().join("projects")).ok()?;
    let path = projects.flatten().map(|p| p.path().join(&name)).find(|p| p.is_file())?;
    FOUND.lock().unwrap().get_or_insert_with(HashMap::new).insert(id.to_string(), path.clone());
    Some(path)
}

/// The first `len` bytes and the last `len` bytes of a file, as lines.
fn head_and_tail(path: &Path, len: u64) -> (Vec<String>, Vec<String>) {
    let Ok(mut f) = std::fs::File::open(path) else { return (vec![], vec![]) };
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    let mut head = vec![0u8; len.min(size) as usize];
    let _ = f.read_exact(&mut head);
    let mut tail = Vec::new();
    if size > len {
        let _ = f.seek(SeekFrom::Start(size - len));
        let _ = f.read_to_end(&mut tail);
    } else {
        tail = head.clone();
    }
    let lines = |b: &[u8]| String::from_utf8_lossy(b).lines().map(str::to_string).collect::<Vec<_>>();
    (lines(&head), lines(&tail))
}

fn summary(path: &Path, updated: u64) -> Option<SessionInfo> {
    let id = path.file_stem()?.to_str()?.to_string();
    if !valid_id(&id) {
        return None;
    }
    let (head, tail) = head_and_tail(path, 256 * 1024);
    let parsed = |l: &String| serde_json::from_str::<Value>(l).ok();
    let cwd = head
        .iter()
        .chain(tail.iter())
        .filter_map(parsed)
        .find_map(|j| j["cwd"].as_str().map(str::to_string))?;
    let title = tail
        .iter()
        .rev()
        .filter_map(parsed)
        .find_map(|j| match j["type"].as_str() {
            Some("ai-title") => j["aiTitle"].as_str().map(|t| one_line(t, 80)),
            Some("last-prompt") => j["lastPrompt"].as_str().map(|t| one_line(t, 80)),
            _ => None,
        })
        .unwrap_or_else(|| "Untitled".into());
    let project = Path::new(&cwd).file_name().and_then(|n| n.to_str()).unwrap_or(&cwd).to_string();
    Some(SessionInfo { id, cwd, project, title, updated })
}

/// A tool use as one short line: its name and what it worked on.
fn tool_line(block: &Value) -> String {
    let name = block["name"].as_str().unwrap_or("Tool");
    let input = &block["input"];
    let what = ["file_path", "command", "pattern", "url", "description", "path", "query", "prompt"]
        .iter()
        .find_map(|k| input[*k].as_str())
        .unwrap_or("");
    let what = what.rsplit(['\\', '/']).next().filter(|_| input["file_path"].is_string()).unwrap_or(what);
    one_line(&format!("{name} {what}"), 90)
}

/// The conversation of the session file `path`: its latest `KEEP` messages.
fn read_messages(path: &Path) -> Vec<Message> {
    let Ok(mut file) = std::fs::File::open(path) else { return vec![] };
    // A long session: start near the end, past the line cut in half.
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let skip_first = size > READ_TAIL;
    if skip_first {
        let _ = file.seek(SeekFrom::Start(size - READ_TAIL));
    }
    let mut out: VecDeque<Message> = VecDeque::new();
    let mut push = |m: Message| {
        if out.len() == KEEP {
            out.pop_front();
        }
        out.push_back(m);
    };
    for line in BufReader::new(file).lines().skip(usize::from(skip_first)).map_while(Result::ok) {
        // Most lines are Claude Code's own bookkeeping: skip them unread.
        let user = line.contains(r#""type":"user""#);
        let assistant = line.contains(r#""type":"assistant""#);
        if !user && !assistant {
            continue;
        }
        let Ok(j) = serde_json::from_str::<Value>(&line) else { continue };
        if j["isSidechain"].as_bool() == Some(true) || j["isMeta"].as_bool() == Some(true) {
            continue;
        }
        let content = &j["message"]["content"];
        match (j["type"].as_str(), content) {
            (Some("user"), Value::String(text)) => {
                // Commands and Claude Code's own notes come wrapped in tags.
                if !text.trim_start().starts_with('<') && !text.trim().is_empty() {
                    push(Message { role: "user", text: clip(text, MAX_TEXT) });
                }
            }
            (Some("user"), Value::Array(blocks)) => {
                for b in blocks {
                    if b["type"] == "text" {
                        let text = b["text"].as_str().unwrap_or("");
                        if !text.trim_start().starts_with('<') && !text.trim().is_empty() {
                            push(Message { role: "user", text: clip(text, MAX_TEXT) });
                        }
                    }
                }
            }
            (Some("assistant"), Value::Array(blocks)) => {
                for b in blocks {
                    match b["type"].as_str() {
                        Some("text") => {
                            if let Some(text) = b["text"].as_str().filter(|t| !t.trim().is_empty()) {
                                push(Message { role: "assistant", text: clip(text, MAX_TEXT) });
                            }
                        }
                        Some("tool_use") => push(Message { role: "tool", text: tool_line(b) }),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    out.into()
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn sessions_list() -> Vec<SessionInfo> {
    tauri::async_runtime::spawn_blocking(|| recent(None, LIST)).await.unwrap_or_default()
}

/// The latest sessions, newest first, `limit` of them; with `folder`, only
/// those run in a folder of that name (as the chat names projects, any case,
/// "tent.js" or "tent-js" alike). Never a throwaway run from the temp folder.
pub fn recent(folder: Option<&str>, limit: usize) -> Vec<SessionInfo> {
    let temp = project_dir_name(&std::env::temp_dir());
    let wanted = folder.map(|f| project_dir_name(Path::new(f.trim())).to_ascii_lowercase()).filter(|f| !f.is_empty());
    session_files()
        .into_iter()
        // A script's throwaway run (gtm.js asks Claude Code from a fresh
        // folder in the temp folder each time): hundreds of them, none a
        // conversation to go back to. Told by its project folder's name,
        // before its file is read.
        .filter(|(p, _)| !p.parent().and_then(|d| d.file_name()).is_some_and(|d| in_temp(&d.to_string_lossy(), &temp)))
        // A folder asked for: its project folder's name holds it, before the file is read.
        .filter(|(p, _)| {
            wanted.as_deref().is_none_or(|w| {
                p.parent().and_then(|d| d.file_name()).is_some_and(|d| d.to_string_lossy().to_ascii_lowercase().contains(w))
            })
        })
        .take(limit * 2)
        .filter_map(|(p, t)| summary(&p, t))
        .filter(|s| wanted.as_deref().is_none_or(|w| project_dir_name(Path::new(&s.project)).to_ascii_lowercase() == *w))
        .take(limit)
        .collect()
}

/// The session `id` as `recent` lists it, wherever it is.
pub fn one(id: &str) -> Option<SessionInfo> {
    let path = find_file(id)?;
    let updated = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    summary(&path, updated)
}

/// The sessions with a terminal winotch can reach now.
pub fn live(app: &AppHandle) -> Vec<String> {
    let Some(consoles) = app.try_state::<Consoles>() else { return vec![] };
    let mut map = consoles.0.lock().unwrap();
    map.retain(|_, pid| alive(*pid));
    map.keys().cloned().collect()
}

/// The name Claude Code gives a folder's project (~/.claude/projects): every
/// character that is not a letter or a digit becomes "-".
fn project_dir_name(dir: &Path) -> String {
    dir.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// A project folder `name` is the temp folder's (`temp`, as project_dir_name gives it), or one inside it.
fn in_temp(name: &str, temp: &str) -> bool {
    let temp = temp.trim_end_matches('-');
    !temp.is_empty() && name.len() >= temp.len() && name[..temp.len()].eq_ignore_ascii_case(temp)
}

#[tauri::command]
pub async fn session_messages(id: String, seen: Option<String>) -> Result<Messages, String> {
    let path = find_file(&id).ok_or("That session is not on this computer.")?;
    // The chat refreshes every few seconds: a file that has not changed since
    // its last read is not read again.
    let stamp = stamp(&path);
    if seen.as_deref() == Some(stamp.as_str()) {
        return Ok(Messages { stamp, messages: None });
    }
    let messages =
        tauri::async_runtime::spawn_blocking(move || read_messages(&path)).await.map_err(|e| e.to_string())?;
    Ok(Messages { stamp, messages: Some(messages) })
}

/// A session's conversation, or `None` when it is as `stamp` was last time.
#[derive(Serialize)]
pub struct Messages {
    stamp: String,
    messages: Option<Vec<Message>>,
}

/// The file's size and modification time: it changes whenever Claude Code writes.
fn stamp(path: &Path) -> String {
    let Ok(meta) = std::fs::metadata(path) else { return String::new() };
    let time = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    format!("{}:{time}", meta.len())
}

/// Sends `text` to the session `id`, or starts a new session in `cwd`. Resolves
/// with the session's id once Claude Code has answered; the answer itself
/// streams to the island as `session-stream` events meanwhile.
#[tauri::command]
pub async fn session_send(
    app: AppHandle,
    request: u64,
    id: Option<String>,
    cwd: Option<String>,
    text: String,
    model: Option<String>,
    effort: Option<String>,
) -> Result<String, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("Nothing to send.".into());
    }
    let (dir, mut args) = match &id {
        Some(id) => {
            let path = find_file(id).ok_or("That session is not on this computer.")?;
            let info = summary(&path, 0).ok_or("That session's folder is unknown.")?;
            (info.cwd, vec!["--resume".to_string(), id.clone()])
        }
        None => {
            let dir = cwd.ok_or("Pick a folder for the new session.")?;
            if !Path::new(&dir).is_dir() {
                return Err(format!("{dir} is not a folder."));
            }
            (dir, vec![])
        }
    };
    if !Path::new(&dir).is_dir() {
        return Err(format!("The session's folder, {dir}, is gone."));
    }
    let key = id.clone().unwrap_or_else(|| format!("new:{request}"));
    {
        let sending = app.state::<Sending>();
        let mut busy = sending.0.lock().unwrap();
        if busy.contains_key(&key) {
            return Err("Claude Code is still answering in this session.".into());
        }
        busy.insert(key.clone(), request);
    }
    args.extend(
        ["-p", &text, "--output-format", "stream-json", "--verbose", "--include-partial-messages"].map(String::from),
    );
    args.extend(model_args(model.as_deref().unwrap_or(""), effort.as_deref().unwrap_or("")));
    crate::log::line(format!("chat: sending to {} in {dir}", if key.starts_with("new:") { "a new session" } else { key.as_str() }));
    let result = run(&app, request, id.unwrap_or_default(), &dir, &args).await;
    app.state::<Sending>().0.lock().unwrap().remove(&key);
    match &result {
        Ok(session) => crate::log::line(format!("chat: answered in {session}")),
        Err(e) => crate::log::line(format!("chat: failed: {e}")),
    }
    result
}

/// How the chat's sends report: `session-stream` events for the send `request`.
fn emitter(app: &AppHandle, request: u64) -> impl Fn(&str, &'static str, String) + '_ {
    move |session: &str, kind: &'static str, text: String| {
        let _ = app.emit_to(WINDOW_LABEL, "session-stream", Stream { request, session: session.to_string(), kind, text });
    }
}

/// One answer, read line by line from Claude Code's stream-json output and
/// reported as it comes: the text so far, each tool it uses, how it ended.
struct Answer {
    session: String,
    /// The answer's text so far, rebuilt from its streamed pieces.
    text: String,
    error: Option<String>,
}

impl Answer {
    fn new(session: String) -> Self {
        Self { session, text: String::new(), error: None }
    }

    /// Reads one line of output. True when it was the answer's end (`result`).
    fn read(&mut self, line: &str, emit: &impl Fn(&str, &'static str, String)) -> bool {
        let Ok(j) = serde_json::from_str::<Value>(line) else { return false };
        match j["type"].as_str() {
            Some("system") if j["subtype"] == "init" => {
                if let Some(id) = j["session_id"].as_str() {
                    self.session = id.to_string();
                }
                emit(&self.session, "start", String::new());
            }
            Some("stream_event") => {
                let e = &j["event"];
                if e["type"] == "content_block_start" && e["content_block"]["type"] == "text" && !self.text.is_empty() {
                    self.text.push_str("\n\n");
                }
                if e["type"] == "content_block_delta" && e["delta"]["type"] == "text_delta" {
                    self.text.push_str(e["delta"]["text"].as_str().unwrap_or(""));
                    emit(&self.session, "delta", self.text.clone());
                }
            }
            Some("assistant") => {
                for b in j["message"]["content"].as_array().into_iter().flatten() {
                    if b["type"] == "tool_use" {
                        emit(&self.session, "tool", tool_line(b));
                    }
                }
            }
            Some("result") => {
                if j["is_error"].as_bool() == Some(true) {
                    self.error = Some(one_line(j["result"].as_str().unwrap_or("Claude Code stopped with an error."), 400));
                } else if let Some(text) = j["result"].as_str() {
                    self.text = text.to_string();
                }
                return true;
            }
            _ => {}
        }
        false
    }

    /// Says how it ended ("done" or "error"): the session's id, or why not.
    fn finish(self, emit: &impl Fn(&str, &'static str, String)) -> Result<String, String> {
        match self.error {
            Some(e) => {
                emit(&self.session, "error", e.clone());
                Err(e)
            }
            None => {
                emit(&self.session, "done", self.text);
                Ok(self.session)
            }
        }
    }
}

/// `claude` with no console window of its own, its output piped back.
fn claude(dir: &str, args: &[String]) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(crate::claude_code::program());
    cmd.args(args).current_dir(dir).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashes up.
    cmd
}

/// What `claude` said on its way out, or a plain line when it said nothing.
fn stopped(err: &str) -> String {
    one_line(if err.trim().is_empty() { "Claude Code stopped." } else { err }, 400)
}

/// The model aliases and effort levels `claude --model` / `--effort` take
/// (claude --help, 2.1). Anything else is left out, never passed on.
const MODELS: [&str; 3] = ["opus", "sonnet", "fable"];
const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// `--model <alias> --effort <level>`, each only when picked (none: Claude
/// Code's own default).
fn model_args(model: &str, effort: &str) -> Vec<String> {
    let mut args = Vec::new();
    if MODELS.contains(&model) {
        args.extend(["--model".to_string(), model.to_string()]);
    }
    if EFFORTS.contains(&effort) {
        args.extend(["--effort".to_string(), effort.to_string()]);
    }
    args
}

async fn run(app: &AppHandle, request: u64, session: String, dir: &str, args: &[String]) -> Result<String, String> {
    let emit = emitter(app, request);
    let mut child = claude(dir, args)
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not start Claude Code (`claude`): {e}"))?;
    let stdout = child.stdout.take().ok_or("no output from claude")?;
    let mut stderr = child.stderr.take();
    let mut lines = tokio::io::BufReader::new(stdout).lines();
    let mut answer = Answer::new(session);
    while let Ok(Some(line)) = lines.next_line().await {
        answer.read(&line, &emit);
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    if answer.error.is_none() && !status.success() {
        let mut err = String::new();
        if let Some(e) = stderr.as_mut() {
            let _ = e.read_to_string(&mut err).await;
        }
        answer.error = Some(stopped(&err));
    }
    answer.finish(&emit)
}

// ── Quick questions ───────────────────────────────────────────────────────────
//
// A quick question is not saved: no session file, nothing to resume. One
// `claude` runs per quick conversation and keeps its context in memory, each
// message written to it as a stream-json line, each answer streamed back like
// a session's. It runs in the user's home folder and ends when the user starts
// another quick question or picks a session, after `QUICK_IDLE` without a
// message, or with winotch (`quick_shutdown`; else its input closes and it
// stops by itself).

/// A quick conversation left alone this long ends.
const QUICK_IDLE: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// The quick conversation, while there is one.
#[derive(Default)]
pub struct Quick(Mutex<Option<QuickChat>>);

struct QuickChat {
    /// Which conversation this is: a newer one replaces it.
    id: u64,
    model: String,
    effort: String,
    turns: tokio::sync::mpsc::Sender<QuickTurn>,
    /// Killed when this is dropped (kill_on_drop).
    _child: tokio::process::Child,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl Drop for QuickChat {
    fn drop(&mut self) {
        self.task.abort();
    }
}

struct QuickTurn {
    request: u64,
    text: String,
    done: tokio::sync::oneshot::Sender<Result<(), String>>,
}

/// The line Claude Code reads one message from (`--input-format stream-json`).
fn quick_line(text: &str) -> String {
    let mut line = serde_json::json!({ "type": "user", "message": { "role": "user", "content": text } }).to_string();
    line.push('\n');
    line
}

/// What a quick question's answers must be (the user's call): the chat in the
/// notch has room for a few lines, so the answer comes first and stays short.
/// Only the quick conversation gets it; the user's own sessions answer as they do.
const QUICK_STYLE: &str = "You are answering a quick question in a small window at the top of the screen with room for only a few lines. Be precise and as short as possible: the answer first, straight to the point. No preamble, no restating the question, no summary or offer at the end. One to three short sentences, or a short list when there are steps. Code only when it is asked for, and only the lines that matter.";

/// winotch's own tools the quick question may use without asking first (the
/// user's call: "open my last tent.js session" works at once). They only read
/// the session list and open things on this screen; every other tool asks.
const QUICK_TOOLS: &str = "mcp__winotch__winotch_sessions,mcp__winotch__winotch_open_session,mcp__winotch__winotch_open_folder";

fn quick_args(model: &str, effort: &str) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--no-session-persistence",
        "--append-system-prompt",
        QUICK_STYLE,
        "--allowedTools",
        QUICK_TOOLS,
    ]
    .map(String::from)
    .into();
    args.extend(model_args(model, effort));
    args
}

fn quick_start(app: &AppHandle, id: u64, model: &str, effort: &str) -> Result<QuickChat, String> {
    let dir = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_else(|_| ".".into());
    let mut child = claude(&dir, &quick_args(model, effort))
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start Claude Code (`claude`): {e}"))?;
    let stdin = child.stdin.take().ok_or("no input to claude")?;
    let stdout = child.stdout.take().ok_or("no output from claude")?;
    let stderr = child.stderr.take().ok_or("no output from claude")?;
    let (turns, rx) = tokio::sync::mpsc::channel(1);
    let task = tauri::async_runtime::spawn(quick_converse(app.clone(), id, rx, stdin, stdout, stderr));
    crate::log::line(format!("chat: quick conversation {id} started in {dir}"));
    Ok(QuickChat { id, model: model.to_string(), effort: effort.to_string(), turns, _child: child, task })
}

async fn quick_converse(
    app: AppHandle,
    id: u64,
    mut turns: tokio::sync::mpsc::Receiver<QuickTurn>,
    mut stdin: tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
    stderr: tokio::process::ChildStderr,
) {
    use tokio::io::AsyncWriteExt;
    // Read as it comes, so a chatty stderr never blocks claude; its end says
    // why claude stopped, if it did.
    let mut said = Some(tauri::async_runtime::spawn(async move {
        let mut tail = String::new();
        let mut lines = tokio::io::BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            tail.push_str(&line);
            tail.push('\n');
            if tail.len() > 4000 {
                let cut = tail.len() - 2000;
                let cut = (cut..tail.len()).find(|&i| tail.is_char_boundary(i)).unwrap_or(0);
                tail.drain(..cut);
            }
        }
        tail
    }));
    let mut lines = tokio::io::BufReader::new(stdout).lines();
    let mut session = String::new();
    loop {
        let turn = match tokio::time::timeout(QUICK_IDLE, turns.recv()).await {
            Ok(Some(turn)) => turn,
            Ok(None) => break,
            Err(_) => {
                crate::log::line(format!("chat: quick conversation {id} idle for 10 min, ended"));
                break;
            }
        };
        let emit = emitter(&app, turn.request);
        let line = quick_line(&turn.text);
        let written = match stdin.write_all(line.as_bytes()).await {
            Ok(()) => stdin.flush().await,
            Err(e) => Err(e),
        };
        let mut answer = Answer::new(session.clone());
        let mut ended = true;
        if written.is_ok() {
            while let Ok(Some(line)) = lines.next_line().await {
                if answer.read(&line, &emit) {
                    ended = false;
                    break;
                }
            }
        }
        session.clone_from(&answer.session);
        if ended {
            // claude is gone: what it said last says why.
            let err = match said.take() {
                Some(said) => tokio::time::timeout(std::time::Duration::from_secs(2), said)
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .unwrap_or_default(),
                None => String::new(),
            };
            answer.error = Some(stopped(&err));
            crate::log::line(format!("chat: quick conversation {id} stopped: {}", stopped(&err)));
            let _ = turn.done.send(answer.finish(&emit).map(|_| ()));
            break;
        }
        let _ = turn.done.send(answer.finish(&emit).map(|_| ()));
    }
    // This conversation is over, and its claude with it (unless a newer one
    // took its place already).
    let quick = app.state::<Quick>();
    let ended = {
        let mut slot = quick.0.lock().unwrap();
        if slot.as_ref().is_some_and(|q| q.id == id) { slot.take() } else { None }
    };
    drop(ended);
}

/// Asks the quick conversation `text`, starting one when there is none, or
/// only one with another model or effort. Resolves once Claude Code has
/// answered, the answer streaming as `session-stream` events meanwhile; with
/// `true` when a new conversation was started for it.
#[tauri::command]
pub async fn quick_send(
    app: AppHandle,
    request: u64,
    text: String,
    model: Option<String>,
    effort: Option<String>,
) -> Result<bool, String> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("Nothing to send.".into());
    }
    let model = model.unwrap_or_default();
    let effort = effort.unwrap_or_default();
    let (turns, fresh, replaced) = {
        let quick = app.state::<Quick>();
        let mut slot = quick.0.lock().unwrap();
        let same = slot.as_ref().is_some_and(|q| q.model == model && q.effort == effort && !q.turns.is_closed());
        let mut replaced = None;
        if !same {
            replaced = slot.take();
            let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            *slot = Some(quick_start(&app, id, &model, &effort)?);
        }
        (slot.as_ref().map(|q| q.turns.clone()).ok_or("no quick conversation")?, !same, replaced)
    };
    drop(replaced);
    let (done, answered) = tokio::sync::oneshot::channel();
    let gone = || "The quick conversation ended.".to_string();
    turns.send(QuickTurn { request, text, done }).await.map_err(|_| gone())?;
    answered.await.map_err(|_| gone())??;
    Ok(fresh)
}

/// Ends the quick conversation, if there is one, and its claude with it.
#[tauri::command]
pub fn quick_reset(app: AppHandle) {
    quick_shutdown(&app);
}

/// The quick conversation is no longer wanted, or winotch is quitting.
pub fn quick_shutdown(app: &AppHandle) {
    let Some(quick) = app.try_state::<Quick>() else { return };
    let ended = quick.0.lock().unwrap().take();
    if let Some(q) = ended {
        crate::log::line(format!("chat: quick conversation {} ended", q.id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch path of the test's own in the temp folder, removed when the
    /// test ends, passed or failed: they were left behind by the hundred.
    struct Scratch(PathBuf);

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = if self.0.is_dir() { std::fs::remove_dir_all(&self.0) } else { std::fs::remove_file(&self.0) };
        }
    }

    impl std::ops::Deref for Scratch {
        type Target = Path;
        fn deref(&self) -> &Path {
            &self.0
        }
    }

    impl AsRef<Path> for Scratch {
        fn as_ref(&self) -> &Path {
            &self.0
        }
    }

    fn scratch(lines: &[&str]) -> Scratch {
        let path = std::env::temp_dir().join(format!("winotch-session-{}.jsonl", std::process::id()));
        std::fs::write(&path, lines.join("\n")).unwrap();
        Scratch(path)
    }

    #[test]
    fn a_conversation_is_its_text_and_one_line_per_tool() {
        let path = scratch(&[
            r#"{"type":"mode","mode":"normal"}"#,
            r#"{"type":"user","message":{"role":"user","content":"Fix the login bug"},"cwd":"C:\\DEV\\app"}"#,
            r#"{"type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"..."},{"type":"text","text":"Looking at it."},{"type":"tool_use","name":"Edit","input":{"file_path":"C:\\DEV\\app\\login.ts"}}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}"#,
            r#"{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"a subagent"}]}}"#,
            r#"not json"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Fixed."}]}}"#,
        ]);
        let m = read_messages(&path);
        let shown: Vec<(&str, &str)> = m.iter().map(|m| (m.role, m.text.as_str())).collect();
        assert_eq!(shown, vec![
            ("user", "Fix the login bug"),
            ("assistant", "Looking at it."),
            ("tool", "Edit login.ts"),
            ("assistant", "Fixed."),
        ]);
    }

    #[test]
    fn an_answer_streams_its_text_and_tools_and_ends_at_its_result() {
        let seen = std::cell::RefCell::new(Vec::new());
        let emit = |session: &str, kind: &'static str, text: String| seen.borrow_mut().push((session.to_string(), kind, text));
        let mut answer = Answer::new(String::new());
        let lines = [
            r#"{"type":"system","subtype":"hook_started","session_id":"q1"}"#,
            r#"{"type":"system","subtype":"init","session_id":"q1"}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"text"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"O"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"K"}}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"C:/work/b.txt"}}]}}"#,
            "not json",
        ];
        assert!(lines.iter().all(|l| !answer.read(l, &emit)));
        assert!(answer.read(r#"{"type":"result","subtype":"success","is_error":false,"result":"OK"}"#, &emit));
        assert_eq!(answer.finish(&emit), Ok("q1".to_string()));
        let kinds: Vec<(&str, String)> = seen.borrow().iter().map(|(_, k, t)| (*k, t.clone())).collect();
        assert_eq!(kinds, vec![
            ("start", String::new()),
            ("delta", "O".into()),
            ("delta", "OK".into()),
            ("tool", "Read b.txt".into()),
            ("done", "OK".into()),
        ]);

        let mut failed = Answer::new("q1".into());
        assert!(failed.read(r#"{"type":"result","is_error":true,"result":"Prompt is too long"}"#, &emit));
        assert_eq!(failed.finish(&emit), Err("Prompt is too long".to_string()));
    }

    #[test]
    fn a_quick_message_is_one_stream_json_user_line() {
        let line = quick_line("Say \"hi\"\nthen stop");
        assert!(line.ends_with('\n') && line.matches('\n').count() == 1);
        let j: Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(j, serde_json::json!({ "type": "user", "message": { "role": "user", "content": "Say \"hi\"\nthen stop" } }));
    }

    #[test]
    fn a_quick_conversation_is_not_saved_and_only_known_flags_pass() {
        let args = quick_args("sonnet", "");
        for flag in ["-p", "--no-session-persistence", "--input-format"] {
            assert!(args.iter().any(|a| a == flag), "{flag}");
        }
        // Its answers are told to be short, and its instruction is one argument.
        let style = args.iter().position(|a| a == "--append-system-prompt").expect("the quick style");
        assert_eq!(args[style + 1], QUICK_STYLE);
        // Its own session tools are allowed, as one argument, and only those.
        let tools = args.iter().position(|a| a == "--allowedTools").expect("the quick tools");
        assert_eq!(args[tools + 1].split(',').count(), 3);
        assert!(args[tools + 1].split(',').all(|t| t.starts_with("mcp__winotch__winotch_")));
        assert!(!QUICK_STYLE.contains('\n'));
        assert!(args.ends_with(&["--model".to_string(), "sonnet".to_string()]));
        assert_eq!(model_args("", ""), Vec::<String>::new());
        assert_eq!(model_args("opus", "max"), ["--model", "opus", "--effort", "max"]);
        assert_eq!(model_args("--dangerously-skip-permissions", "huge"), Vec::<String>::new());
    }

    #[test]
    fn a_session_in_the_temp_folder_is_a_throwaway_and_not_listed() {
        let temp = project_dir_name(Path::new(r"C:\Users\me\AppData\Local\Temp\"));
        assert_eq!(temp, "C--Users-me-AppData-Local-Temp-");
        assert!(in_temp("C--Users-me-AppData-Local-Temp-gtm-00ri66", &temp));
        assert!(in_temp("c--users-me-appdata-local-temp", &temp));
        assert!(!in_temp("C--DEV-gtm-js", &temp));
        assert!(!in_temp("C--Users-me", &temp));
        assert!(!in_temp("anything", ""));
    }

    #[test]
    fn a_folder_asked_for_matches_however_it_is_written() {
        let key = |f: &str| project_dir_name(Path::new(f)).to_ascii_lowercase();
        assert_eq!(key("tent.js"), key("Tent-JS"));
        assert_eq!(key("tent.js"), "tent-js");
        assert_ne!(key("tent.js"), key("tent.js-mirror"));
    }

    #[test]
    fn only_a_session_id_reaches_a_path() {
        assert!(valid_id("c4322883-6696-4122-9c92-c20f57acac13"));
        assert!(!valid_id("../../etc/passwd"));
        assert!(!valid_id("abc"));
        assert!(find_file("..\\x").is_none());
    }
}
