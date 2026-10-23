## What and why

<!-- What does this change, and what problem does it solve? Link issues with "Fixes #123". -->

## How it was tested

<!-- Steps you took in the running app (npm run tauri dev), and screenshots or a short recording for anything you can see. -->

## Checklist

- [ ] `npx tsc --noEmit`, `npm test` and `cargo test --workspace` pass
- [ ] I tried the change in the running app, the way a person would use it
- [ ] Nothing is sent, approved, posted or written to Claude Code's config without an explicit click
- [ ] A hook still never blocks Claude Code: if winotch does not answer, the session carries on
- [ ] Nothing new draws, polls or wakes while nothing changes (idle stays near 0 % CPU)
- [ ] New text goes through `t()` and is translated in `src/i18n/extra.json`
- [ ] Docs updated (`README.md`, `docs/`) if behaviour, settings or the API changed
