# Running winotch

Everything about using winotch day to day: setting it up, each app, voice, where your data lives, and what to do when something is off. To build it yourself, see [CONTRIBUTING.md](../CONTRIBUTING.md).

- [Install](#install)
- [The first start](#the-first-start)
- [Connecting Claude Code](#connecting-claude-code)
- [Using the island](#using-the-island)
- [Apps](#apps)
- [Voice: dictation, Notetaker, « OK Tent »](#voice-dictation-notetaker--ok-tent-)
- [Your own apps](#your-own-apps)
- [Where your data lives](#where-your-data-lives)
- [Updating and uninstalling](#updating-and-uninstalling)
- [Troubleshooting](#troubleshooting)

## Install

You need Windows 10 (1809 or newer) or Windows 11, and [Claude Code](https://docs.claude.com/en/docs/claude-code) for the sessions, the chat and the tools. The WebView2 runtime ships with Windows 11; on Windows 10 the installer fetches it if it is missing.

Download [**winotch-setup.exe**](https://github.com/ArynBuilds/winotch/releases/latest/download/winotch-setup.exe), which installs for your user only with no admin prompt, or [**winotch.msi**](https://github.com/ArynBuilds/winotch/releases/latest/download/winotch.msi) for a Windows Installer package.

The installers are not code-signed yet, so the first time **Windows protected your PC** appears, with *Unknown publisher*. Click **More info**, then **Run anyway**.

## The first start

The mark wells up in the middle of the top of your screen, then settles into the island, a small notch at the top centre. **Get started** opens inside it once, with what to set up first. It is always in Settings (the gear, or `Ctrl+,` with the island open).

## Connecting Claude Code

Everything is in **Settings → Claude Code**. Nothing in Claude Code's configuration changes until you click.

### Sessions in the island (hooks)

**Install hooks…** shows the exact change to `~/.claude/settings.json` as a diff. **Back up and write** saves a dated copy of the file first, then adds winotch's hooks next to yours; your own hooks are left as they are. Open a new Claude Code session afterwards.

From then on, every Claude Code session in any terminal shows in the island: each prompt, file read or edit, command, permission request and question, and when it finishes. Approvals and questions can be answered from the island. The hooks never block Claude Code: if winotch is closed or does not answer, the session carries on and asks in its terminal as usual.

The island stays quiet while Claude works. It opens only when a session finishes, fails or needs you.

### Tools for Claude Code (MCP)

**Add to Claude Code** runs Claude Code's own `claude mcp add --scope user winotch …`, for every project. Claude Code can then read your notifications and post its own (a draft waiting for your yes, for example), search and read your Gmail and save drafts, keep your to-dos and notes, and find and open your sessions:

> "What came in from GitHub today?" · "Draft a reply to Ada's last mail" · "Remind me to call the bank tomorrow at 3pm" · "Open my last my-app session"

Claude drafts and you decide: it cannot press a button for you, and nothing can send a mail but your press on **Send**. The command is shown under the button if you prefer to run it in a terminal yourself.

### Plan usage

**Show plan usage in the island** shows your Pro or Max plan's limits. It installs a small status line relay in `~/.claude/settings.json`, shown as a diff first. If you already have a status line, it keeps working: the relay runs it for you.

### Claude API key

Optional. Dictation clean-up, call summaries in the Notetaker and « OK Tent » call the Claude API with your own key. The sessions, the chat and the tools use your Claude Code login instead and need no key. The key is kept in Windows Credential Manager, never in a file.

## Using the island

| What you do | What happens |
| --- | --- |
| Move the pointer to the top centre of the screen | The island peeks out |
| Click it | It opens. With **Settings → General → Open on hover**, resting the pointer on it is enough |
| Leave it | It folds back after 3, 5 or 10 seconds (Settings → General) |
| Click a card or app | It opens big with that app's whole list; `Esc` or the back arrow returns |
| The bell | Every app's notifications in one feed, filtered by app |
| Click a file in a session's ticker | Its diff opens in the island |
| Drag a file onto the island | It is handed to the chat |

| Shortcut | Does |
| --- | --- |
| `Ctrl+Alt+Space` | Opens the chat |
| `Ctrl+Alt+A` | Jumps to the waiting permission or question |
| `Ctrl+Alt+T` | Brings the session's terminal forward |
| `Ctrl+Alt+→` / `Ctrl+Alt+←` | Next / previous pill |
| `Ctrl+Alt+S` | Mutes or unmutes winotch |
| `Ctrl+Alt+N` | Opens or closes the island (off until you turn it on) |
| In the open island: `Ctrl+,` · `Ctrl+P` · `Esc` | Settings · keep it open · close it |

Every global shortcut can be changed or turned off in Settings → General.

### The chat

The chat (second button in the island's header) talks to your Claude Code sessions. Pick one of your sessions, or a recent folder for a new one. A message to a closed session runs your own `claude` in its folder and the answer streams in; the turn is there when you resume the session in a terminal. A session open in a terminal gets the message typed into that terminal, exactly as if you had typed it; those are marked **● live** once their first hook event has reached winotch.

## Apps

**Settings → Apps** lists every app, built in or joined through the API. For each one: on the island or not, whether it may open the island, and its setup.

| App | Setup |
| --- | --- |
| **GitHub** | Signs in with the [GitHub CLI](https://cli.github.com) (`gh auth login`) or a token. Shows review requests, your pull requests, CI on main branches and GitHub's own notifications, with Open, Mark as done and Re-run for failed CI. Approving and merging stay on github.com |
| **Gmail** | An [app password](https://myaccount.google.com/apppasswords) (it needs 2-Step Verification) for each account, over IMAP and SMTP. New mail arrives at once (IMAP IDLE); Inbox, Primary and Unread views; Mark read, Archive, Open in Gmail. The password is kept in Credential Manager |
| **Spotify** | Nothing to set up: what the Spotify desktop app plays is read from Windows' media controls, with play, pause and skip |
| **Notion** | An [integration token](https://www.notion.so/my-integrations), shared with the pages you want to see |
| **Stripe** | A secret key. Experimental: tested less than the others |
| **Today** | Nothing to set up: to-dos on days with reminders, a calendar and notes, kept on this computer |

An app's news peeks or opens the island unless you turn **Can open the island** off; then it waits behind the bell. A waiting approval or question always comes first.

## Voice: dictation, Notetaker, « OK Tent »

Speech is recognised on this computer with NVIDIA's Parakeet model, downloaded once (about 700 MB) from **Settings → Dictation → Settings**. Nothing you say is sent anywhere to be recognised.

- **Dictation**: hold the dictation key (right `Ctrl` by default) anywhere and speak; let go and the text is pasted where you type. Tap it twice for hands-free, tap again to paste, `Esc` cancels. With a Claude API key, the text can be cleaned up and written in a style per app. **Words** holds your dictionary, replacements and snippets.
- **Notetaker**: records a call from the **Notetaker** page and writes its transcript, person by person, then a summary with your Claude API key.
- **« OK Tent »**: with **Listen** on, say « OK Tent » and a question. The answer is written in the island line by line and can be said out loud. It uses your Claude API key.

## Your own apps

Any program can put itself on the island through winotch's local API: a pill, notifications with buttons, a list, details. Start with [`examples/hello-app.mjs`](../examples/hello-app.mjs) and [docs/api.md](api.md).

## Where your data lives

Nothing leaves your computer except the calls to the services you connected (GitHub, Gmail, Notion, Stripe, the Claude API with your key). There is no telemetry.

| What | Where |
| --- | --- |
| Preferences, custom sounds | `%APPDATA%\winotch\` (`settings.json`, `sounds\`) |
| The feed and apps, Today, the API address | `%LOCALAPPDATA%\winotch\` (`apps.json`, `today.json`, `api.json`) |
| Dictation history and statistics, the voice model, call notes | `%LOCALAPPDATA%\winotch\` (`Flow\`, `Models\`, `Notes\`) |
| The weekly recap | `%LOCALAPPDATA%\winotch\recap.json`: counts and project names only, 12 weeks |
| The hook relay and the log | `%LOCALAPPDATA%\winotch\bin\`, `%LOCALAPPDATA%\winotch\winotch.log` |
| Keys, tokens, app passwords | Windows Credential Manager, never a file |

The log holds states and counts, never your mail, prompts or commands.

To use your own sounds, put a file named like one of winotch's (`finish.wav`, `approval.wav`…) in the sounds folder and press **Reload sounds** in Settings → General.

## Updating and uninstalling

To update, install the newer release over the old one; your data and settings stay.

Before uninstalling, open **Settings → Claude Code** and click **Uninstall hooks…** and **Remove** next to the tools: the uninstaller never edits Claude Code's configuration by itself. A hook left behind does no harm (it exits at once without winotch), but Claude Code would list a missing MCP server. You can also remove it later with `claude mcp remove --scope user winotch`.

The uninstaller removes the app, the relay and the log. Your data (`apps.json`, `today.json`, notes and the voice model) stays in the folders above until you delete them.

## Troubleshooting

| Symptom | What to try |
| --- | --- |
| No island at the top of the screen | It is a 3 px line when hidden: move the pointer to the very top centre. With several screens, pick one in Settings → General → Display. Check the tray icon: **Pause** may be on |
| Sessions do not show | Install the hooks (Settings → Claude Code), then start a *new* Claude Code session. A session already running is picked up at its next step |
| "winotch-hook.exe is not in place yet" | Restart winotch: it copies the relay to `%LOCALAPPDATA%\winotch\bin\` at every start |
| Claude Code says the `winotch` MCP server failed | winotch must be running for its tools. If you moved or reinstalled it, click **Update** in Settings → Claude Code |
| "Claude Code (`claude`) was not found" | Install Claude Code and open a new terminal once, so `claude` is on your PATH, then come back to Settings |
| A message to a live session does nothing | It is typed into that session's console; a session started before winotch is reachable after its next hook event |
| Dictation does nothing | Download the voice model (Settings → Dictation → Settings) and check the microphone there |
| Windows Defender blocks the installer | Update its definitions (`Update-MpSignature` in PowerShell) and try again; an unsigned installer can trip its machine-learning model |

Still stuck? [Open an issue](https://github.com/ArynBuilds/winotch/issues/new/choose) with the end of `%LOCALAPPDATA%\winotch\winotch.log`.
