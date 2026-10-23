# winotch — guide for coding agents

winotch is a Dynamic Island for Windows built on Claude Code: a Tauri 2 app (Rust in `src-tauri/`, TypeScript in `src/`) and `winotch-hook` (`hook/`), the relay Claude Code runs on each hook event and the MCP server for Claude Code. Read [docs/architecture.md](docs/architecture.md) for the pieces and [docs/api.md](docs/api.md) for the local API before changing either.

## Where things are

- `src/island/` the window's shell and motion, and the handlers for hook events, apps, shortcuts and voice. `src/views/` the views of the open island. `src/core/` state and data, no DOM. `src/mark/` the mark (the island's character), drawn in SVG. `src/hub/` the Settings pages, drawn inside the island.
- `src-tauri/src/apps.rs` the app registry and the local API. `hooks.rs` installing the hooks. `sessions.rs` Claude Code's sessions and the chat. `claude_code.rs` finding `claude` and adding the MCP server. `mail/`, `github*.rs`, `today.rs`, `spotify.rs`, `integrations.rs` the built-in apps. `speech/`, `flow/`, `notes/`, `voice/` voice.
- `hook/src/main.rs` the relay. `hook/src/mcp.rs` and `mcp-tools.json` the MCP server.
- `dev/` preview pages: one view in a real island on sample data (`npx vite`).

## Commands

```sh
npm run tauri dev                        # the app, front end reloading live
npx tsc --noEmit                         # type check
cargo build --release -p winotch-hook    # the relay; the MCP tests run it
npm test                                 # island and MCP tests
cargo test --workspace                   # Rust tests
npm run pack                             # the installers, in release/
```

Close a running winotch before building: Windows locks a running exe.

## Rules

- **Nothing on the user's behalf without an explicit click.** Never approve a permission, answer a question, send mail, press an app's action or change Claude Code's configuration by itself. `~/.claude/settings.json` is never overwritten: dated backup, merge, show the diff, write only after the click and only if the file still matches what was shown. MCP tools may draft and read; they never send, approve or press.
- **Never block Claude Code.** If the app does not answer, the hook exits at once with "no opinion". Every step in the relay runs under a deadline.
- **Two paths never cross.** Claude Code's sessions come through the hooks and drive the island's own views; the feed (the bell) is for apps and for what Claude posts on purpose. A waiting approval or question always wins over a notification.
- **Quiet while Claude works.** A prompt or a tool call never opens the island; a session finishing, failing or needing an answer does.
- **0 % CPU when nothing happens.** Nothing draws while nothing changes; endless loops run at 24 fps; no infinite CSS animation on anything off screen; polls stop when their view is gone and skip unchanged data; the pointer wakes nothing far from the island. One window only.
- **Apps come from one registry** (`apps.rs`). Every screen draws from its snapshot; nothing on the front end decides which apps exist. The built-ins' ids and pill ids are stable contract values (settings, apps.json): never rename one.
- **Secrets live in Windows Credential Manager**, never on disk, in settings.json or in the log. The log holds states and counts, never mail, prompts or commands.
- **No telemetry.** Network calls only to services the user configured.
- **Text through `t()`**, keyed by its English wording, translated in `src/i18n/extra.json` for all ten languages. `npm test` fails on a missing translation, an unused entry, or known English left outside `t()`.
- **Settings stay simple.** A title, no banner; settings in grouped rows (`section()` in `hub/ui.ts`); at most one short note under a group; secondary text readable.
- **The look.** The system font (Segoe UI Variable), the icons in `src/views/icons.ts`, one colour (`#ECECEC` on `#141414`, panels `#1B1B1B`). New views follow the existing ones. The mark is a dash and a dot: the dash never moves on its own; the dot travels, pulses and arrives.
- **Read Claude Code's own files defensively.** Session transcripts (`~/.claude/projects/…`) and settings are Claude Code's formats and may change.
- **Releases** bump the version in `package.json`, `Cargo.toml` and `src-tauri/tauri.conf.json` together.

## Style

- Comments say why, in plain sentences, at the density of the surrounding code; never what the next line does.
- Rust: no new dependency without a strong reason; the relay stays on `serde_json` alone. TypeScript: no framework, the DOM helpers in `views/dom.ts`.
- A feature is done when a person can use it: backend and UI together, translated, tested, and in the docs if it changes behaviour, settings or the API.
