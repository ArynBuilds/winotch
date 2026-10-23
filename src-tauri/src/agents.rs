// The command line that starts the relay (winotch-hook) from Claude Code's
// hooks (hooks.rs). Claude Code runs hook commands through Git Bash on Windows
// and `sh` on Linux, so there is one way to quote on each.

use crate::settings;

/// Where the relay is and which OS the command is for. Kept apart from the
/// real install so tests can build both the Windows and the Linux command.
pub struct Relay {
    pub exe: String,
    pub windows: bool,
}

impl Relay {
    pub fn current() -> Self {
        Self {
            exe: settings::hook_exe_path().to_string_lossy().to_string(),
            windows: cfg!(windows),
        }
    }

    /// The relay followed by `args`, as one command line.
    pub fn command(&self, args: &str) -> String {
        if !self.windows {
            return format!("{} {args}", sh_quote(&self.exe));
        }
        // Git Bash reads backslashes as escapes: forward slashes, quoted.
        format!("\"{}\" {args}", self.exe.replace('\\', "/"))
    }
}

/// The relay command for the running OS, for `args`.
pub fn relay_command(args: &str) -> String {
    Relay::current().command(args)
}

/// `s` as one single-quoted POSIX shell word: `'` becomes `'\''`, nothing else
/// is special inside single quotes.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_command_is_quoted_for_the_shell_that_runs_it() {
        let linux = Relay { exe: "/home/me/.local/share/winotch/bin/winotch-hook".into(), windows: false };
        assert_eq!(linux.command("Stop"), "'/home/me/.local/share/winotch/bin/winotch-hook' Stop");
        let windows = Relay { exe: r"C:\Users\me\AppData\Local\winotch\bin\winotch-hook.exe".into(), windows: true };
        assert_eq!(windows.command("Stop"), "\"C:/Users/me/AppData/Local/winotch/bin/winotch-hook.exe\" Stop");
    }

    #[test]
    fn the_hook_path_is_one_shell_word_whatever_it_contains() {
        assert_eq!(sh_quote("/home/a b/x"), "'/home/a b/x'");
        assert_eq!(sh_quote(r#"/h/$(id)`x`\"y"#), r#"'/h/$(id)`x`\"y'"#);
        assert_eq!(sh_quote("/h/it's"), r"'/h/it'\''s'");
    }
}
