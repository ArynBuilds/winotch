# Contributing to winotch

Thank you for helping. winotch sits between Claude Code and the person using it, and stays on screen all day, so we value small, well-explained, tested changes, and changes that keep it quiet and light.

## Ways to contribute

- **Report a bug** with the bug report template. Include steps, what you expected and what happened, your Windows version, and the end of `%LOCALAPPDATA%\winotch\winotch.log`.
- **Propose a feature** with the feature request template before writing a large change, so we can agree on the approach. Many ideas fit better as an app of their own on the [local API](docs/api.md), with no change to winotch at all.
- **Improve the docs.** If something in `docs/` does not match the code, the code wins; please fix the doc.
- **Translate.** The interface has ten languages; `src/i18n/extra.json` holds the strings written for winotch.
- **Security issues** go through private reporting, never public issues. See [SECURITY.md](SECURITY.md).

Good first areas: translations, Linux testing, a new built-in app, and more [preview pages](dev/) for views that have none.

## Development setup

You need Windows 10 or 11, Node.js 22.18 or newer, Rust (stable), and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) (the MSVC build tools; WebView2 ships with Windows 11).

```sh
git clone <your fork> winotch && cd winotch
npm install
npm run tauri dev
```

`npm run tauri dev` builds the relay (`winotch-hook`), starts Vite and runs the app; the front end reloads live, and Rust rebuilds on save. Close a running winotch first: only one runs at a time, and Windows locks a running exe.

Most views can be worked on without the app: `npx vite`, then open a page from `dev/` (for example `http://localhost:1420/dev/session-preview.html?state=approval`). Each one shows a view in a real island on sample data.

To build the installers: `npm run pack`. They land in `release/`.

## Checks

Run these before every pull request; CI runs the same:

```sh
npx tsc --noEmit
cargo build --release -p winotch-hook   # the MCP tests run it
npm test
cargo test --workspace
```

No test needs Claude Code, a network or a running winotch. The MCP tests run `winotch-hook mcp` against a stand-in for the API; Rust tests write to temporary folders.

## Rules

[AGENTS.md](AGENTS.md) holds the project's rules, for people and for coding agents alike. The ones that matter most:

- **Nothing on the user's behalf without a click.** No approval, no sent mail, no pressed button, no write to Claude Code's configuration. Changes to `~/.claude/settings.json` are shown as a diff, backed up, and written only if the file still matches.
- **Never block Claude Code.** A hook that cannot reach winotch exits at once.
- **Quiet and light.** Nothing new pops the island while Claude works, and nothing draws, polls or wakes while nothing changes.
- **Secrets in Credential Manager**, never in a file or the log. No telemetry; network calls only to services the user set up.
- **Text through `t()`**, translated in `src/i18n/extra.json` for every language.
- **New views follow the existing style**: the system font, the icons in `src/views/icons.ts`, one colour on dark.

## Commits and pull requests

- Branch from `main`; keep one logical change per pull request.
- Write commit messages as a plain sentence about what changed for the user (`The chat keeps its draft when the island folds`). Reference issues with `Fixes #123`.
- Fill in the pull request template: what changed, why, how you tested it, and a screenshot or short recording for anything you can see.
- Update `README.md` and `docs/` when behaviour, settings or the API change.

## Releases

Maintainers bump the version in `package.json`, `Cargo.toml` and `src-tauri/tauri.conf.json`, then push a `v*` tag. The Release workflow checks the three agree, runs the tests, builds the installers and publishes them.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
