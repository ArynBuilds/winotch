//! `winotch-hook mcp`: winotch for Claude Code, an MCP server (stdio, one JSON
//! message per line) over the island's local API (src-tauri/src/apps.rs).
//! Claude can read every app's notifications and post its own, a draft waiting
//! for your yes included, search, read and draft in your Gmail, keep your Today
//! (to-dos on days, with reminders, and notes, deleting included), and find
//! your Claude Code sessions and open one. It cannot press an action or send a
//! mail: only you do, in the island.
//!
//! It lives in the relay so it needs nothing installed: the app copies the
//! relay to its data folder at every start, and Settings → Claude Code adds
//! `winotch-hook mcp` to Claude Code from there.

use std::io::{BufRead, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Map, Value};

/// The tools as Claude Code lists them: names, descriptions, input schemas.
const TOOLS: &str = include_str!("mcp-tools.json");

/// Long enough for a slow mail search (the app bounds its own work at 20 s).
const TIMEOUT: Duration = Duration::from_secs(30);

pub fn run() -> ! {
    let tools: Value = serde_json::from_str(TOOLS).unwrap_or_else(|_| json!([]));
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(msg) => handle(&msg, &tools),
            Err(_) => Some(json!({ "id": null, "error": { "code": -32700, "message": "not JSON" } })),
        };
        if let Some(mut reply) = reply {
            reply["jsonrpc"] = json!("2.0");
            let mut out = std::io::stdout();
            let _ = writeln!(out, "{reply}");
            let _ = out.flush();
        }
    }
    std::process::exit(0);
}

/// The answer to one message; none for a notification (no id).
fn handle(msg: &Value, tools: &Value) -> Option<Value> {
    let id = msg.get("id")?.clone();
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    Some(match msg["method"].as_str().unwrap_or("") {
        "initialize" => json!({ "id": id, "result": {
            "protocolVersion": params["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "winotch", "version": env!("CARGO_PKG_VERSION") },
        }}),
        "ping" => json!({ "id": id, "result": {} }),
        "tools/list" => json!({ "id": id, "result": { "tools": tools } }),
        "tools/call" => {
            let name = params["name"].as_str().unwrap_or("");
            let args = params.get("arguments").and_then(Value::as_object).cloned().unwrap_or_default();
            match call_tool(name, &args, &mut request) {
                Ok(result) => {
                    let text = serde_json::to_string_pretty(&result).unwrap_or_default();
                    json!({ "id": id, "result": { "content": [{ "type": "text", "text": text }] } })
                }
                Err(e) => json!({ "id": id, "result": { "content": [{ "type": "text", "text": e }], "isError": true } }),
            }
        }
        method => json!({ "id": id, "error": { "code": -32601, "message": format!("no method {method}") } }),
    })
}

/// One call on the API: method, path with its query, JSON body.
type Request<'a> = dyn FnMut(&str, &str, Option<Value>) -> Result<Value, String> + 'a;

fn call_tool(name: &str, args: &Map<String, Value>, request: &mut Request) -> Result<Value, String> {
    let s = |key: &str| args.get(key).and_then(Value::as_str);
    let num = |key: &str| args.get(key).filter(|v| !v.is_null()).map(text_of).filter(|v| !v.is_empty());
    let truthy = |key: &str| args.get(key).is_some_and(|v| !matches!(v, Value::Null | Value::Bool(false)));
    let path_id = || segment(&args.get("id").map(text_of).unwrap_or_default());

    match name {
        "winotch_notifications" => {
            let mut q = Query::default();
            q.opt("app", s("app"));
            if truthy("unread_only") {
                q.set("unread", "1");
            }
            q.opt("limit", num("limit").as_deref());
            request("GET", &format!("/v1/notifications?{q}"), None)
        }
        "winotch_apps" => request("GET", "/v1/apps", None),
        "winotch_notify" => {
            // Claude Code posts as an app of its own, registered on first use.
            request("POST", "/v1/apps", Some(json!({ "id": "claude", "name": "Claude", "sign": "-." })))?;
            request("POST", "/v1/notify", Some(compact(json!({
                "app": "claude",
                "title": args.get("title"),
                "body": args.get("body"),
                "importance": s("importance").unwrap_or("normal"),
                "url": args.get("url"),
                "actions": args.get("actions").cloned().unwrap_or_else(|| json!([])),
            }))))
        }
        "winotch_mark_read" => request("POST", "/v1/read", Some(compact(json!({ "id": args.get("id"), "app": args.get("app") })))),
        "winotch_mail_accounts" => request("GET", "/v1/mail/accounts", None),
        "winotch_mail_search" => {
            let mut q = Query::default();
            q.set("q", s("query").unwrap_or(""));
            q.opt("account", s("account"));
            q.opt("limit", num("limit").as_deref());
            request("GET", &format!("/v1/mail/search?{q}"), None)
        }
        "winotch_mail_read" => {
            let mut q = Query::default();
            q.set("account", s("account").unwrap_or(""));
            q.set("id", &args.get("id").map(text_of).unwrap_or_default());
            if truthy("thread") {
                q.set("thread", "1");
            }
            request("GET", &format!("/v1/mail/message?{q}"), None)
        }
        // Saved as a draft and put on the island; there is no way to send from here.
        "winotch_mail_draft" => request("POST", "/v1/mail/draft", Some(compact(json!({
            "account": args.get("account"),
            "to": args.get("to").cloned().unwrap_or_else(|| json!([])),
            "cc": args.get("cc").cloned().unwrap_or_else(|| json!([])),
            "subject": s("subject").unwrap_or(""),
            "body": args.get("body"),
            "reply_to": args.get("reply_to"),
        })))),
        "winotch_today_list" => today_list(args, request),
        "winotch_today_add" => request("POST", "/v1/today/todos", Some(given(args, &["title", "date", "time", "note"]))),
        "winotch_today_update" => request(
            "PATCH",
            &format!("/v1/today/todos/{}", path_id()),
            Some(given(args, &["title", "note", "date", "time", "done"])),
        ),
        "winotch_today_delete" => request("DELETE", &format!("/v1/today/todos/{}", path_id()), None),
        "winotch_notes_list" => {
            let mut q = Query::default();
            q.opt("q", s("query").filter(|v| !v.is_empty()));
            request("GET", &format!("/v1/today/notes?{q}"), None)
        }
        "winotch_notes_read" => request("GET", &format!("/v1/today/notes/{}", path_id()), None),
        // With an id it replaces that note's fields; without, a new note.
        "winotch_notes_write" => match s("id").filter(|v| !v.is_empty()) {
            Some(_) => request("PATCH", &format!("/v1/today/notes/{}", path_id()), Some(given(args, &["title", "body"]))),
            None => request("POST", "/v1/today/notes", Some(given(args, &["title", "body"]))),
        },
        "winotch_notes_append" => request(
            "PATCH",
            &format!("/v1/today/notes/{}", path_id()),
            Some(compact(json!({ "append": args.get("text") }))),
        ),
        "winotch_notes_delete" => request("DELETE", &format!("/v1/today/notes/{}", path_id()), None),
        "winotch_sessions" => {
            let mut q = Query::default();
            q.opt("folder", s("folder").filter(|v| !v.is_empty()));
            q.opt("limit", num("limit").as_deref());
            request("GET", &format!("/v1/sessions?{q}"), None)
        }
        "winotch_open_session" => request(
            "POST",
            "/v1/sessions/open",
            Some(compact(json!({ "id": args.get("id"), "in": s("in").unwrap_or("chat") }))),
        ),
        "winotch_open_folder" => request("POST", "/v1/folders/open", Some(compact(json!({ "path": args.get("path") })))),
        _ => Err(format!("no tool {name}")),
    }
}

/// Today and the 7 days after by default, with what is late and someday's apart.
fn today_list(args: &Map<String, Value>, request: &mut Request) -> Result<Value, String> {
    let mut q = Query::default();
    if let Some(done) = args.get("done").and_then(Value::as_bool) {
        q.set("done", if done { "1" } else { "0" });
    }
    if args.get("all").and_then(Value::as_bool).unwrap_or(false) {
        return request("GET", &format!("/v1/today/todos?{q}"), None);
    }
    let from = args.get("from").and_then(Value::as_str).map(str::to_string).unwrap_or_else(local_today);
    let to = args.get("to").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| add_days(&from, 7));
    q.set("from", &from);
    q.set("to", &to);
    q.set("overdue", "1");
    q.set("undated", "1");
    let answer = request("GET", &format!("/v1/today/todos?{q}"), None)?;
    let todos = answer["todos"].as_array().cloned().unwrap_or_default();
    let date = |t: &Value| t["date"].as_str().filter(|d| !d.is_empty()).map(str::to_string);
    let late = |t: &Value| date(t).is_some_and(|d| d < from);
    Ok(json!({
        "today": answer["today"],
        "weekday": answer["weekday"],
        "now": answer["now"],
        "range": { "from": from, "to": to },
        "todos": todos.iter().filter(|t| date(t).is_some() && !late(t)).collect::<Vec<_>>(),
        "overdue": todos.iter().filter(|t| late(t)).collect::<Vec<_>>(),
        "someday": todos.iter().filter(|t| date(t).is_none()).collect::<Vec<_>>(),
    }))
}

/// Only the fields the caller gave, nulls included (they clear).
fn given(args: &Map<String, Value>, fields: &[&str]) -> Value {
    Value::Object(fields.iter().filter_map(|f| args.get(*f).map(|v| (f.to_string(), v.clone()))).collect())
}

/// A body without the fields the caller left out, as JSON.stringify drops `undefined`.
fn compact(mut body: Value) -> Value {
    if let Some(map) = body.as_object_mut() {
        map.retain(|_, v| !v.is_null());
    }
    body
}

/// A JSON value as the text a URL carries: strings as they are, numbers written out.
fn text_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

// ── The local API ────────────────────────────────────────────────────────────

/// Where winotch listens and its token, written by the app at every start.
fn api() -> Result<(String, String), String> {
    let not_running = || "winotch is not running (no api.json). Start winotch, then try again.".to_string();
    let text = std::fs::read_to_string(data_dir().join("api.json")).map_err(|_| not_running())?;
    let info: Value = serde_json::from_str(&text).map_err(|_| not_running())?;
    let url = info["url"].as_str().ok_or_else(not_running)?;
    let token = info["token"].as_str().ok_or_else(not_running)?;
    // The API is plain HTTP on loopback only (apps.rs); anything else is not ours.
    let host = url.strip_prefix("http://").ok_or_else(not_running)?.trim_end_matches('/');
    Ok((host.to_string(), token.to_string()))
}

fn data_dir() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(".")).join("winotch")
    }
    #[cfg(not(windows))]
    {
        let base = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local").join("share")
        });
        base.join("winotch")
    }
}

fn request(method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    let (host, token) = api()?;
    let no_answer = || "winotch did not answer. Is it running?".to_string();
    let mut stream = TcpStream::connect(&host).map_err(|_| no_answer())?;
    let _ = stream.set_read_timeout(Some(TIMEOUT));
    let _ = stream.set_write_timeout(Some(TIMEOUT));
    let body = body.map(|b| b.to_string()).unwrap_or_default();
    let head = format!(
        "{method} {path} HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).and_then(|_| stream.write_all(body.as_bytes())).map_err(|_| no_answer())?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|_| no_answer())?;

    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or_else(no_answer)?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let status: u16 = head.split_whitespace().nth(1).and_then(|s| s.parse().ok()).ok_or_else(no_answer)?;
    let mut body = raw[split + 4..].to_vec();
    if head.lines().any(|l| l.to_ascii_lowercase().starts_with("transfer-encoding:") && l.to_ascii_lowercase().contains("chunked")) {
        body = unchunk(&body);
    }
    let data: Value = serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
    if !(200..300).contains(&status) {
        return Err(data["error"].as_str().map(str::to_string).unwrap_or_else(|| format!("winotch answered {status}")));
    }
    Ok(data)
}

/// A chunked body put back together. winotch sends a length, but anything in
/// front of it (a proxy, a test's stand-in) may not.
fn unchunk(mut raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(end) = raw.windows(2).position(|w| w == b"\r\n") {
        let size = std::str::from_utf8(&raw[..end]).ok().and_then(|l| usize::from_str_radix(l.split(';').next()?.trim(), 16).ok());
        let Some(size) = size.filter(|&n| n > 0 && end + 2 + n <= raw.len()) else { break };
        out.extend_from_slice(&raw[end + 2..end + 2 + size]);
        raw = raw.get(end + 2 + size + 2..).unwrap_or_default();
    }
    out
}

/// A query string, in the order the fields were set.
#[derive(Default)]
struct Query(Vec<(String, String)>);

impl Query {
    fn set(&mut self, key: &str, value: &str) {
        self.0.push((key.to_string(), value.to_string()));
    }
    fn opt(&mut self, key: &str, value: Option<&str>) {
        if let Some(v) = value {
            self.set(key, v);
        }
    }
}

impl std::fmt::Display for Query {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let pairs: Vec<String> = self.0.iter().map(|(k, v)| format!("{}={}", form(k), form(v))).collect();
        f.write_str(&pairs.join("&"))
    }
}

/// Form encoding, as a browser's URLSearchParams writes it (a space is "+").
fn form(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// An id as one segment of a path, whatever it holds.
fn segment(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'!' | b'*' | b'\'' | b'(' | b')' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// ── Days on this computer's clock ────────────────────────────────────────────

/// Today, as YYYY-MM-DD, on this computer's clock (the island's own).
fn local_today() -> String {
    let (y, m, d) = local_ymd();
    format!("{y:04}-{m:02}-{d:02}")
}

#[cfg(windows)]
fn local_ymd() -> (i64, i64, i64) {
    // SAFETY: GetLocalTime only writes the struct it is given.
    let t = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
    (t.wYear as i64, t.wMonth as i64, t.wDay as i64)
}

#[cfg(target_os = "linux")]
fn local_ymd() -> (i64, i64, i64) {
    // SAFETY: time and localtime_r only write the values they are given.
    unsafe {
        let now = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&now, &mut tm);
        (tm.tm_year as i64 + 1900, tm.tm_mon as i64 + 1, tm.tm_mday as i64)
    }
}

/// "2026-10-18" plus n days; anything that is not such a day comes back as it was.
fn add_days(iso: &str, n: i64) -> String {
    let parts: Vec<i64> = iso.split('-').filter_map(|p| p.parse().ok()).collect();
    let [y, m, d] = parts[..] else { return iso.to_string() };
    if iso.len() != 10 || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return iso.to_string();
    }
    let (y, m, d) = civil_from_days(days_from_civil(y, m, d) + n);
    format!("{y:04}-{m:02}-{d:02}")
}

// Howard Hinnant's day-count algorithms (public domain).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
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
    (yoe + era * 400 + if m <= 2 { 1 } else { 0 }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_move_across_months_years_and_leap_days() {
        assert_eq!(add_days("2026-10-18", 7), "2026-10-25");
        assert_eq!(add_days("2026-12-28", 7), "2027-01-04");
        assert_eq!(add_days("2028-02-27", 2), "2028-02-29");
        assert_eq!(add_days("2026-03-01", -1), "2026-02-28");
        assert_eq!(add_days("someday", 7), "someday");
    }

    #[test]
    fn queries_and_segments_are_encoded_like_the_browser_does() {
        let mut q = Query::default();
        q.set("q", "hotel river");
        q.set("account", "a+b@example.com");
        assert_eq!(q.to_string(), "q=hotel+river&account=a%2Bb%40example.com");
        assert_eq!(segment("../todos"), "..%2Ftodos");
    }

    /// Runs a tool against a stand-in for winotch; what it was asked, in order.
    fn asked(name: &str, args: Value, answer: Value) -> (Result<Value, String>, Vec<(String, String, Option<Value>)>) {
        let mut log = Vec::new();
        let args = args.as_object().cloned().unwrap_or_default();
        let result = call_tool(name, &args, &mut |m: &str, p: &str, b: Option<Value>| {
            log.push((m.to_string(), p.to_string(), b));
            Ok(answer.clone())
        });
        (result, log)
    }

    #[test]
    fn every_tool_is_listed_with_a_schema_and_has_a_call() {
        let tools: Value = serde_json::from_str(TOOLS).unwrap();
        let tools = tools.as_array().unwrap();
        assert_eq!(tools.len(), 20);
        for t in tools {
            let name = t["name"].as_str().unwrap();
            assert!(t["inputSchema"]["type"] == "object", "{name}");
            let (result, log) = asked(name, json!({ "id": "x" }), json!({ "todos": [] }));
            assert!(result.is_ok() && !log.is_empty(), "{name}");
        }
        assert_eq!(asked("winotch_nope", json!({}), json!({})).0.unwrap_err(), "no tool winotch_nope");
    }

    #[test]
    fn bodies_leave_out_what_was_not_given_but_keep_the_nulls_that_clear() {
        let (_, log) = asked("winotch_mark_read", json!({ "app": "gmail" }), json!({}));
        assert_eq!(log[0].2, Some(json!({ "app": "gmail" })));
        let (_, log) = asked("winotch_today_update", json!({ "id": "t2", "date": null, "done": true }), json!({}));
        assert_eq!(log[0], ("PATCH".into(), "/v1/today/todos/t2".into(), Some(json!({ "date": null, "done": true }))));
        let (_, log) = asked("winotch_notify", json!({ "title": "Hi" }), json!({}));
        assert_eq!(log[0].1, "/v1/apps");
        assert_eq!(log[1].2, Some(json!({ "app": "claude", "title": "Hi", "importance": "normal", "actions": [] })));
    }
}
