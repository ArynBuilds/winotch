// How winotch signs in to GitHub (WINOTCH.md, "GitHub"): through the GitHub
// CLI the user is already logged in with, or with a token kept in the
// credential store ("github-token", secrets.rs).
//
// In CLI mode the token is asked of `gh auth token` at the start of every poll
// cycle, so a `gh auth logout` or an account switch is followed at the next
// poll. It is held only for that cycle: never written anywhere, never logged.
//
// `Settings.github_auth` says which: "cli", "token", or "" (never chosen), which
// is the CLI when it answers and the stored token otherwise.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::secrets;

const HOST: &str = "github.com";
/// `gh` answers from its keyring in well under a second; past this it is stuck.
const TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Cli,
    Token,
    /// Not chosen yet: the CLI when it is signed in, else the stored token.
    Auto,
}

impl Mode {
    pub fn from_setting(raw: &str) -> Self {
        match raw {
            "cli" => Mode::Cli,
            "token" => Mode::Token,
            _ => Mode::Auto,
        }
    }
}

/// What a run of `gh` gave back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunError {
    /// No `gh` on this computer.
    NotFound,
    TimedOut,
    Failed(String),
}

/// Runs `gh` with these arguments. The real one is `GhRunner`; tests hand in
/// their own.
pub trait Runner {
    fn run(&self, args: &[&str]) -> Result<RunOutput, RunError>;
}

/// Why the CLI gave no token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliError {
    NotInstalled,
    SignedOut,
    TimedOut,
    Failed,
}

impl CliError {
    /// The line the card and Settings show.
    pub fn message(self) -> String {
        match self {
            CliError::NotInstalled => crate::i18n::t("GitHub CLI is not installed"),
            CliError::SignedOut => crate::i18n::t("GitHub CLI is signed out. Run gh auth login."),
            CliError::TimedOut | CliError::Failed => crate::i18n::t("GitHub CLI did not answer"),
        }
    }

    /// Whether this says who is signed in (nobody), rather than that `gh`
    /// could not be asked this time.
    fn is_definite(self) -> bool {
        matches!(self, CliError::NotInstalled | CliError::SignedOut)
    }
}

/// Why there is no token at all this cycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthError {
    /// Token mode (or Auto without the CLI) and no token saved: stay quiet, as
    /// before the CLI existed.
    NoToken,
    /// CLI mode and the CLI gave none: the card says why.
    Cli(CliError),
}

/// `gh auth token`'s answer → the token. Only its first line counts, and it
/// must look like one; whatever `gh` printed is never repeated anywhere.
pub fn parse_token(out: Result<RunOutput, RunError>) -> Result<String, CliError> {
    let out = match out {
        Ok(out) => out,
        Err(RunError::NotFound) => return Err(CliError::NotInstalled),
        Err(RunError::TimedOut) => return Err(CliError::TimedOut),
        Err(RunError::Failed(_)) => return Err(CliError::Failed),
    };
    if !out.success {
        // "no oauth token found for github.com", "not logged in to any hosts"…
        let err = out.stderr.to_ascii_lowercase();
        return Err(if err.contains("no oauth token") || err.contains("not logged") || err.contains("gh auth login") {
            CliError::SignedOut
        } else if err.trim().is_empty() {
            CliError::SignedOut
        } else {
            CliError::Failed
        });
    }
    let token = out.stdout.lines().next().unwrap_or("").trim();
    let plausible = (20..=512).contains(&token.len())
        && token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if plausible {
        Ok(token.to_string())
    } else if token.is_empty() {
        Err(CliError::SignedOut)
    } else {
        Err(CliError::Failed)
    }
}

/// What Settings shows next to "GitHub CLI".
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub installed: bool,
    pub signed_in: bool,
    pub login: Option<String>,
    /// Why it cannot be used, when it cannot.
    pub error: Option<String>,
}

/// `gh auth status --active --hostname github.com --json hosts` → who is
/// signed in. The token field it may carry is never read.
pub fn parse_status(out: Result<RunOutput, RunError>) -> CliStatus {
    let failed = |installed: bool, e: CliError| CliStatus {
        installed,
        signed_in: false,
        login: None,
        error: Some(e.message()),
    };
    let out = match out {
        Ok(out) => out,
        Err(RunError::NotFound) => return failed(false, CliError::NotInstalled),
        Err(RunError::TimedOut) => return failed(true, CliError::TimedOut),
        Err(RunError::Failed(_)) => return failed(true, CliError::Failed),
    };
    let Ok(root) = serde_json::from_str::<Value>(&out.stdout) else {
        return failed(true, if out.success { CliError::Failed } else { CliError::SignedOut });
    };
    let accounts = root
        .get("hosts")
        .and_then(|h| h.get(HOST))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let active = accounts
        .iter()
        .find(|a| a.get("active").and_then(Value::as_bool).unwrap_or(false))
        .or(accounts.first());
    let Some(active) = active else { return failed(true, CliError::SignedOut) };
    let ok = active.get("state").and_then(Value::as_str) == Some("success");
    let login = active.get("login").and_then(Value::as_str).filter(|l| !l.is_empty()).map(str::to_string);
    if !ok || login.is_none() {
        return CliStatus { installed: true, signed_in: false, login, error: Some(CliError::SignedOut.message()) };
    }
    CliStatus { installed: true, signed_in: true, login, error: None }
}

pub fn cli_token(runner: &dyn Runner) -> Result<String, CliError> {
    parse_token(runner.run(&["auth", "token", "--hostname", HOST]))
}

pub fn cli_status(runner: &dyn Runner) -> CliStatus {
    parse_status(runner.run(&["auth", "status", "--active", "--hostname", HOST, "--json", "hosts"]))
}

/// The mode's token: CLI, stored, or the CLI then the stored one.
pub fn pick(
    mode: Mode,
    cli: impl FnOnce() -> Result<String, CliError>,
    stored: impl FnOnce() -> Option<String>,
) -> Result<String, (AuthError, Option<CliError>)> {
    match mode {
        Mode::Token => stored().ok_or((AuthError::NoToken, None)),
        Mode::Cli => cli().map_err(|e| (AuthError::Cli(e), Some(e))),
        Mode::Auto => match cli() {
            Ok(token) => Ok(token),
            // Missing or signed out: the stored token, if there is one.
            Err(e) if e.is_definite() => stored().ok_or((AuthError::NoToken, Some(e))),
            // `gh` is there but did not answer: skip this cycle rather than
            // flip to another account and back.
            Err(e) => Err((AuthError::NoToken, Some(e))),
        },
    }
}

// ── The real `gh` ─────────────────────────────────────────────────────────────

pub struct GhRunner;

fn gh_path() -> Option<PathBuf> {
    if let Some(found) = crate::platform::find_on_path("gh") {
        return Some(found);
    }
    // Started at login, winotch may have an older PATH than a terminal: look
    // where the installers put it.
    #[cfg(windows)]
    {
        let mut places = Vec::new();
        for var in ["ProgramFiles", "ProgramW6432"] {
            if let Some(base) = std::env::var_os(var) {
                places.push(PathBuf::from(base).join("GitHub CLI").join("gh.exe"));
            }
        }
        if let Some(base) = std::env::var_os("LOCALAPPDATA") {
            places.push(PathBuf::from(base).join("Programs").join("GitHub CLI").join("gh.exe"));
        }
        if let Some(found) = places.into_iter().find(|p| p.is_file()) {
            return Some(found);
        }
    }
    None
}

impl Runner for GhRunner {
    fn run(&self, args: &[&str]) -> Result<RunOutput, RunError> {
        let path = gh_path().ok_or(RunError::NotFound)?;
        let mut cmd = Command::new(path);
        cmd.args(args)
            // Plain output, no prompt, no update check: this is not a terminal.
            .env("GH_PROMPT_DISABLED", "1")
            .env("GH_NO_UPDATE_NOTIFIER", "1")
            .env("NO_COLOR", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::platform::no_console(&mut cmd);
        let mut child = cmd.spawn().map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => RunError::NotFound,
            _ => RunError::Failed(e.kind().to_string()),
        })?;
        // Read both pipes on their own threads, so a chatty `gh` never blocks
        // on a full pipe while we wait for it.
        let pipe = |r: Option<Box<dyn Read + Send>>| {
            std::thread::spawn(move || {
                let mut text = String::new();
                if let Some(r) = r {
                    let _ = r.take(64 * 1024).read_to_string(&mut text);
                }
                text
            })
        };
        let stdout = pipe(child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
        let stderr = pipe(child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
        let started = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if started.elapsed() > TIMEOUT => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(RunError::TimedOut);
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(15)),
                Err(e) => return Err(RunError::Failed(e.kind().to_string())),
            }
        };
        Ok(RunOutput {
            success: status.success(),
            stdout: stdout.join().unwrap_or_default(),
            stderr: stderr.join().unwrap_or_default(),
        })
    }
}

// ── For the pollers ───────────────────────────────────────────────────────────

pub fn mode(app: &AppHandle) -> Mode {
    app.try_state::<crate::Shared>()
        .map(|shared| Mode::from_setting(&shared.settings.lock().unwrap().github_auth))
        .unwrap_or(Mode::Auto)
}

/// A hash of the token last used, to notice an account switch or a logout
/// without keeping the token. Outer None: no cycle has asked yet.
static LAST: Mutex<Option<Option<u64>>> = Mutex::new(None);

fn fingerprint(token: &str) -> u64 {
    let mut h = DefaultHasher::new();
    token.hash(&mut h);
    h.finish()
}

/// Records who this cycle runs as; true when it is someone else than last time
/// (another account, signed out, signed back in).
fn identity_changed(now: Option<u64>) -> bool {
    let mut last = LAST.lock().unwrap();
    let changed = matches!(*last, Some(before) if before != now);
    *last = Some(now);
    changed
}

/// Forgets who the last cycle ran as (the token was changed on purpose: the
/// caller already resets what the old one fetched).
pub fn forget_identity() {
    *LAST.lock().unwrap() = None;
}

/// The token for the poll cycle that starts now. Runs `gh` in CLI and Auto
/// mode, so call it from a blocking-safe place (it is quick, and bounded).
pub async fn token(app: &AppHandle) -> Result<String, AuthError> {
    let mode = mode(app);
    let result = tauri::async_runtime::spawn_blocking(move || {
        pick(mode, || cli_token(&GhRunner), || secrets::get("github-token"))
    })
    .await
    .unwrap_or(Err((AuthError::NoToken, None)));
    let seen = match &result {
        Ok(token) => Some(Some(fingerprint(token))),
        // Nobody is signed in: that is an identity too (a logout).
        Err((_, cli)) if cli.is_none_or(|e| e.is_definite()) => Some(None),
        // `gh` could not be asked this time: learn nothing from it.
        Err(_) => None,
    };
    if let Some(now) = seen {
        if identity_changed(now) {
            crate::integrations::github_identity_changed(app);
        }
    }
    result.map_err(|(e, _)| e)
}

/// Settings → Apps → GitHub: is the CLI there, and who is signed in.
#[tauri::command]
pub async fn github_cli_status() -> CliStatus {
    tauri::async_runtime::spawn_blocking(|| cli_status(&GhRunner))
        .await
        .unwrap_or(CliStatus { installed: false, signed_in: false, login: None, error: None })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// A `gh` that answers what the test says, and remembers what it was asked.
    struct Fake {
        answer: Result<RunOutput, RunError>,
        asked: RefCell<Vec<String>>,
    }

    impl Runner for Fake {
        fn run(&self, args: &[&str]) -> Result<RunOutput, RunError> {
            self.asked.borrow_mut().push(args.join(" "));
            self.answer.clone()
        }
    }

    fn fake(answer: Result<RunOutput, RunError>) -> Fake {
        Fake { answer, asked: RefCell::new(Vec::new()) }
    }

    fn out(success: bool, stdout: &str, stderr: &str) -> Result<RunOutput, RunError> {
        Ok(RunOutput { success, stdout: stdout.into(), stderr: stderr.into() })
    }

    const TOKEN: &str = "gho_0123456789abcdefABCDEF0123456789abcd";

    #[test]
    fn the_token_is_the_first_line_gh_prints() {
        let gh = fake(out(true, &format!("{TOKEN}\n"), ""));
        assert_eq!(cli_token(&gh), Ok(TOKEN.to_string()));
        assert_eq!(gh.asked.borrow().as_slice(), ["auth token --hostname github.com"]);
        assert_eq!(parse_token(out(true, &format!("  {TOKEN}\r\nextra"), "")), Ok(TOKEN.to_string()));
    }

    #[test]
    fn a_signed_out_or_missing_gh_gives_no_token_and_says_why() {
        assert_eq!(parse_token(out(false, "", "no oauth token found for github.com\n")), Err(CliError::SignedOut));
        assert_eq!(
            parse_token(out(false, "", "You are not logged into any GitHub hosts. To log in, run: gh auth login")),
            Err(CliError::SignedOut)
        );
        assert_eq!(parse_token(out(true, "\n", "")), Err(CliError::SignedOut));
        assert_eq!(parse_token(Err(RunError::NotFound)), Err(CliError::NotInstalled));
        assert_eq!(parse_token(Err(RunError::TimedOut)), Err(CliError::TimedOut));
        assert_eq!(parse_token(Err(RunError::Failed("denied".into()))), Err(CliError::Failed));
        assert_eq!(parse_token(out(false, "", "HTTP 502")), Err(CliError::Failed));
    }

    #[test]
    fn something_that_is_not_a_token_is_refused() {
        assert_eq!(parse_token(out(true, "Welcome to GitHub CLI! <html>", "")), Err(CliError::Failed));
        assert_eq!(parse_token(out(true, "short", "")), Err(CliError::Failed));
    }

    #[test]
    fn the_status_names_the_active_account_and_ignores_the_token() {
        let json = r#"{"hosts":{"github.com":[
            {"active":false,"host":"github.com","login":"other","state":"success","token":"gho_****"},
            {"active":true,"gitProtocol":"https","host":"github.com","login":"BL4X3","scopes":"gist, read:org, repo","state":"success","tokenSource":"keyring","token":"gho_****"}
        ]}}"#;
        let gh = fake(out(true, json, ""));
        let status = cli_status(&gh);
        assert_eq!(status, CliStatus { installed: true, signed_in: true, login: Some("BL4X3".into()), error: None });
        assert_eq!(gh.asked.borrow().as_slice(), ["auth status --active --hostname github.com --json hosts"]);
        assert!(!serde_json::to_string(&status).unwrap().contains("gho_"));
    }

    #[test]
    fn the_status_says_when_gh_is_missing_signed_out_or_broken() {
        let missing = parse_status(Err(RunError::NotFound));
        assert!(!missing.installed && !missing.signed_in);
        assert_eq!(missing.error.as_deref(), Some("GitHub CLI is not installed"));

        let none = parse_status(out(true, r#"{"hosts":{}}"#, ""));
        assert!(none.installed && !none.signed_in);
        assert_eq!(none.error.as_deref(), Some("GitHub CLI is signed out. Run gh auth login."));

        let expired = parse_status(out(true, r#"{"hosts":{"github.com":[{"active":true,"login":"me","state":"error"}]}}"#, ""));
        assert!(!expired.signed_in);
        assert_eq!(expired.login.as_deref(), Some("me"));

        // An old gh without --json: unknown flag, not JSON.
        let old = parse_status(out(false, "", "unknown flag: --json"));
        assert!(old.installed && !old.signed_in);
        assert!(parse_status(Err(RunError::TimedOut)).error.is_some());
    }

    #[test]
    fn each_mode_takes_its_token_and_auto_falls_back_to_the_stored_one() {
        let cli_ok = || Ok::<_, CliError>("cli".to_string());
        let cli_out = || Err::<String, _>(CliError::SignedOut);
        let stored = || Some("stored".to_string());
        let nothing = || None::<String>;

        assert_eq!(pick(Mode::Cli, cli_ok, stored), Ok("cli".into()));
        assert_eq!(pick(Mode::Cli, cli_out, stored), Err((AuthError::Cli(CliError::SignedOut), Some(CliError::SignedOut))));
        assert_eq!(pick(Mode::Token, cli_ok, stored), Ok("stored".into()));
        assert_eq!(pick(Mode::Token, cli_ok, nothing), Err((AuthError::NoToken, None)));
        assert_eq!(pick(Mode::Auto, cli_ok, stored), Ok("cli".into()));
        assert_eq!(pick(Mode::Auto, cli_out, stored), Ok("stored".into()));
        assert_eq!(pick(Mode::Auto, cli_out, nothing), Err((AuthError::NoToken, Some(CliError::SignedOut))));
        let missing = || Err::<String, _>(CliError::NotInstalled);
        assert_eq!(pick(Mode::Auto, missing, stored), Ok("stored".into()));
        // A gh that is stuck this once is not a reason to switch accounts.
        let stuck = || Err::<String, _>(CliError::TimedOut);
        assert_eq!(pick(Mode::Auto, stuck, stored), Err((AuthError::NoToken, Some(CliError::TimedOut))));
    }

    #[test]
    fn token_mode_never_runs_gh() {
        let mut ran = false;
        let _ = pick(Mode::Token, || { ran = true; Ok("x".into()) }, || Some("stored".into()));
        assert!(!ran);
    }

    #[test]
    fn the_setting_reads_as_a_mode_and_anything_else_is_auto() {
        assert_eq!(Mode::from_setting("cli"), Mode::Cli);
        assert_eq!(Mode::from_setting("token"), Mode::Token);
        assert_eq!(Mode::from_setting(""), Mode::Auto);
        assert_eq!(Mode::from_setting("oauth"), Mode::Auto);
    }

    #[test]
    fn an_account_switch_or_a_logout_is_a_new_identity() {
        forget_identity();
        let a = Some(fingerprint("token-a"));
        assert!(!identity_changed(a), "the first cycle only learns who it is");
        assert!(!identity_changed(a));
        assert!(identity_changed(Some(fingerprint("token-b"))));
        assert!(identity_changed(None), "signed out");
        assert!(!identity_changed(None));
        assert!(identity_changed(a), "signed back in");
        forget_identity();
        assert!(!identity_changed(Some(fingerprint("token-c"))));
        forget_identity();
    }
}
