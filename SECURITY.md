# Security policy

## Supported versions

winotch runs on your own computer. Security fixes land on the default branch and in the next release; please run the latest release.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private vulnerability reporting ("Security" tab, "Report a vulnerability") on this repository. Include the affected version or commit, the file or screen, reproduction steps and the impact you observed.

We aim to acknowledge reports within 3 working days and to agree on a disclosure date with you once a fix is available. We are happy to credit reporters in the release notes.

---

## Security model

winotch is designed for one person on their own Windows account. It sits between Claude Code and you: it sees what Claude Code does, and can say yes to it on your behalf when you click. The main questions are who can reach it, and what Claude Code can make it do.

### Actors

| Actor | Reaches winotch through | Can do |
| --- | --- | --- |
| You | The island, Settings, the tray | Everything |
| Claude Code's hooks | `winotch-hook`, over a named pipe | Report what a session does; ask for a permission or an answer and wait for it |
| Claude Code's tools (MCP) | `winotch-hook mcp`, over the local API | Read the feed, mail, to-dos and sessions; post notifications; save mail drafts; add, change and delete to-dos and notes; open a session or a folder |
| Your own programs | The local API, with the token from `api.json` | Register as an app, post notifications and lists, receive the presses on their own buttons |

### What only your click does

- **Approving a permission or answering a question.** The card's buttons are the only way an approval leaves winotch. Without an answer, Claude Code asks in its terminal as usual.
- **Sending mail.** There is no API call and no MCP tool that sends. A draft is sent only by your press on **Send**, with the exact bytes that were drafted.
- **Pressing an app's buttons.** Claude Code's tools can read which button you pressed (`acted`), never press one.
- **Changing Claude Code's configuration.** Installing or removing the hooks or the status line relay shows the change to `~/.claude/settings.json` as a diff, backs the file up, and writes only if the file still matches what you saw. Adding the tools runs Claude Code's own `claude mcp add`, on a click. The uninstaller touches neither.

GitHub's buttons are limited to safe actions (Open, Mark as done, Re-run failed CI); approving and merging stay on github.com.

### The hooks never block Claude Code

If winotch is closed, paused or slow, the relay exits at once with "no opinion" and the session carries on. Every step of the relay runs under a deadline; only a permission request waits, for at most 110 seconds, and then the terminal asks.

### The named pipe

Hook events travel over `\\.\pipe\winotch-<your SID>`. Named pipes share one namespace on a machine, so:

- the pipe's name carries your account's SID, so two accounts never share one;
- winotch creates it as the first instance and refuses to serve on top of a pipe someone else created;
- the relay checks that the process serving the pipe belongs to your account before it sends anything.

### The local API

- It listens on `127.0.0.1` only. A new random token is written to `%LOCALAPPDATA%\winotch\api.json` at every start, in a folder only your account can read, and every call but `/v1/health` must carry it.
- An app's callback must be `http://` on `127.0.0.1` or `localhost`; links shown in the island must be `http`, `https` or `mailto`.
- The built-in apps' ids are reserved: no program can post as GitHub or Gmail.
- Every field has a length limit, and lists and details past a limit are refused.

**Anything running as your Windows user can read `api.json`** and use the API, as it could read your other files. The API gives no more than that user already has, but it does let such a program put a notification on your screen that looks like any other app's. Read a notification's app before acting on its link.

### Typing into a terminal

The chat can type a message into a Claude Code session that is open in a terminal, as if you had typed it (`AttachConsole` and `WriteConsoleInputW`). It only does so into a `claude.exe` process that a hook of that session reported, only one line at a time, and only when you press Send in the chat.

### Secrets

| Secret | Protects | Kept in |
| --- | --- | --- |
| Claude API key | Your Anthropic API account | Windows Credential Manager |
| GitHub token (token mode) | Your GitHub account | Windows Credential Manager. In GitHub CLI mode, `gh auth token` is asked at each poll and never stored |
| Gmail app passwords | Your Gmail accounts | Windows Credential Manager, one per account |
| Notion and Stripe keys | Those accounts | Windows Credential Manager |
| The API token | The local API | `api.json`, new at every start |

Settings show whether a secret is set, never the secret. No secret is written to `settings.json` or to the log. The log holds states and counts, never mail, prompts or commands.

### The network

winotch calls only the services you set up: GitHub, Gmail (IMAP and SMTP), Notion, Stripe, Spotify (read from Windows' media controls; the cover art from Spotify's image server), the Claude API with your key, and Hugging Face once, when you download the voice model. There is no telemetry. Dictation, call transcripts and « OK Tent »'s listening are recognised on your computer; only « OK Tent »'s question, the dictation clean-up and call summaries go to the Claude API, and only with your key.

### What this does not protect against

- **Prompt injection.** Through its tools, Claude Code can read your mail and your apps' notifications, which can contain text written to steer it. It can then save drafts, post notifications and change your to-dos and notes, but cannot send, approve or press anything. Read a draft before you press Send.
- **Code running as you.** Malware running under your account can read `api.json`, your Claude Code settings and anything else you can.
- **Unsigned installers.** The releases are not code-signed yet. Download them only from this repository's Releases page, or build from source.
