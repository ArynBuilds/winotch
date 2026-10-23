// Finding the user's own `claude`, and giving it winotch's tools (MCP).
//
// `claude` may be the native install (~/.local/bin/claude.exe) or npm's
// (claude.cmd on PATH); Windows only finds an .exe by its bare name, so the
// chat and the MCP setup both ask `program()`.
//
// The tools are `winotch-hook mcp` (hook/src/mcp.rs), registered for every
// project with Claude Code's own `claude mcp add --scope user`: winotch never
// writes Claude Code's config itself, and only on a click in Settings.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use serde_json::Value;

use crate::settings;

/// The name Claude Code knows the server by.
const SERVER: &str = "winotch";

/// The `claude` to run: on PATH, else where the native installer puts it.
pub fn program() -> PathBuf {
    let names: &[&str] = if cfg!(windows) { &["claude.exe", "claude.cmd"] } else { &["claude"] };
    let path = std::env::var_os("PATH").unwrap_or_default();
    for name in names {
        if let Some(found) = std::env::split_paths(&path).map(|dir| dir.join(name)).find(|p| p.is_file()) {
            return found;
        }
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_default();
    let native = home.join(".local").join("bin").join(names[0]);
    if native.is_file() {
        return native;
    }
    PathBuf::from("claude")
}

/// What Settings shows: whether Claude Code has the tools, and the command.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    /// Claude Code has a `winotch` server, for every project.
    registered: bool,
    /// …and it is this install's relay (not an old path or another copy).
    current: bool,
    /// The relay is in place, so the command works.
    relay_ready: bool,
    /// `claude` was found.
    claude_found: bool,
    /// The command to run by hand, for a terminal.
    command: String,
}

fn claude_json() -> PathBuf {
    match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(dir) => PathBuf::from(dir).join(".claude.json"),
        None => {
            let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_default();
            home.join(".claude.json")
        }
    }
}

fn same_path(a: &str, b: &Path) -> bool {
    let b = b.to_string_lossy();
    if cfg!(windows) { a.eq_ignore_ascii_case(&b) } else { a == b }
}

/// The user-scope entry, if any: Claude Code keeps it in ~/.claude.json.
fn entry() -> Option<Value> {
    let text = std::fs::read_to_string(claude_json()).ok()?;
    let config: Value = serde_json::from_str(&text).ok()?;
    config.get("mcpServers")?.get(SERVER).cloned()
}

fn quoted(path: &Path) -> String {
    let p = path.to_string_lossy();
    if p.contains(' ') { format!("\"{p}\"") } else { p.into_owned() }
}

#[tauri::command]
pub fn mcp_status() -> McpStatus {
    let relay = settings::hook_exe_path();
    let entry = entry();
    let current = entry.as_ref().is_some_and(|e| {
        e["command"].as_str().is_some_and(|c| same_path(c, &relay)) && e["args"] == serde_json::json!(["mcp"])
    });
    let claude = program();
    McpStatus {
        registered: entry.is_some(),
        current,
        relay_ready: relay.is_file(),
        claude_found: claude.is_absolute(),
        command: format!("claude mcp add --scope user {SERVER} -- {} mcp", quoted(&relay)),
    }
}

/// Registers (or re-points) the server with Claude Code's own CLI.
#[tauri::command]
pub async fn mcp_install() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let relay = settings::hook_exe_path();
        if !relay.is_file() {
            return Err(crate::i18n::t("winotch-hook is not in place yet. Restart winotch, then try again."));
        }
        let claude = program();
        if entry().is_some() {
            // An older entry (another path, or the old Node server) is replaced.
            let _ = run(&claude, &["mcp", "remove", "--scope", "user", SERVER]);
        }
        let relay = relay.to_string_lossy().into_owned();
        run(&claude, &["mcp", "add", "--scope", "user", SERVER, "--", &relay, "mcp"])
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Removes the server from Claude Code.
#[tauri::command]
pub async fn mcp_remove() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| run(&program(), &["mcp", "remove", "--scope", "user", SERVER]))
        .await
        .map_err(|e| e.to_string())?
}

fn run(claude: &Path, args: &[&str]) -> Result<(), String> {
    let mut cmd = Command::new(claude);
    cmd.args(args);
    #[cfg(windows)]
    crate::platform::no_console(&mut cmd);
    let out = cmd
        .output()
        .map_err(|_| crate::i18n::t("Claude Code (`claude`) was not found. Install it, then try again."))?;
    if out.status.success() {
        crate::log::line(format!("mcp: claude {}", args[..2].join(" ")));
        return Ok(());
    }
    let said = String::from_utf8_lossy(if out.stderr.is_empty() { &out.stdout } else { &out.stderr }).trim().to_string();
    crate::log::line(format!("mcp: claude {} failed: {said}", args[..2].join(" ")));
    Err(if said.is_empty() { format!("claude exited with {}", out.status) } else { said })
}
