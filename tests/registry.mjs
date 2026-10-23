// The app registry as Rust sends it (src-tauri/src/apps.rs `Snapshot`), for
// the tests: the six built-ins in their order, any API apps after them, with
// the same fields and the same defaults (GitHub and Gmail on; Today, on in the
// app, only when a test asks for it, so the pill lists stay short). `useRegistry`
// hands it to the island the way the "apps" event does.

import { Feed } from "../src/core/apps.ts";
import { State } from "../src/core/state.ts";

const GITHUB_HINT =
  "Classic token with the repo scope, or fine-grained with read access to Pull requests, Commit statuses and Actions.";

const BUILTINS = [
  { id: "github", name: "GitHub", pill: "integration_github", logo: "github",
    settings: { kind: "signIn", modes: ["cli", "token"], key: { secret: "github-token", label: "Token", placeholder: "ghp_…", hint: GITHUB_HINT } } },
  { id: "stripe", name: "Stripe", pill: "integration_stripe", logo: "stripe",
    settings: { kind: "key", secret: "stripe-api-key", label: "Secret key", placeholder: "sk_live_…", hint: null } },
  { id: "notion", name: "Notion", pill: "integration_notion", logo: "notion",
    settings: { kind: "key", secret: "notion-api-key", label: "Integration token", placeholder: "ntn_…", hint: null } },
  { id: "spotify", name: "Spotify", pill: "integration_spotify", logo: "spotify", settings: { kind: "none" } },
  { id: "gmail", name: "Gmail", pill: "app_gmail", logo: "gmail", settings: { kind: "accounts" } },
  { id: "today", name: "Today", pill: "app_today", logo: "today", settings: { kind: "none" } },
];

const entry = (base, extra) => ({
  sign: null, icon: null, callback: null, status: null, problem: null, updated: 1,
  shown: true, opensIsland: true, available: true, configured: true,
  ...base, ...extra,
});

/** An app from the API, as the registry lists it. */
export function apiApp(id, name, extra = {}) {
  return entry({
    id, name, kind: "api", logo: id, pill: id === "claude" ? "integration_claude" : `app_${id}`, settings: { kind: "none" },
  }, extra);
}

/**
 * A snapshot: the built-ins (`shown` lists the ones on, GitHub and Gmail by
 * default; Gmail has no account unless `gmail` is true), `builtins`
 * overriding fields per id, then `apps` sorted by name as Rust sorts them.
 */
export function registry({ shown = ["github", "gmail"], gmail = false, apps = [], builtins = {}, notifications = [], lists = {} } = {}) {
  const list = BUILTINS.map((b) => entry({ ...b, kind: "builtin" }, {
    shown: shown.includes(b.id),
    ...(b.id === "gmail" && !gmail ? { available: false, configured: false, problem: "Not connected" } : {}),
    ...builtins[b.id],
  }));
  const api = [...apps].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return { apps: [...list, ...api], notifications, lists };
}

/** The island receives this registry, as on an "apps" event: the feed, then the pills. */
export function useRegistry(options = {}) {
  Feed.set(registry(options));
  State.syncPills();
}
