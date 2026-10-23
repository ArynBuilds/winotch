// Settings → Apps, as data: one row per app of the registry
// (src-tauri/src/apps.rs, core/apps.ts), in the registry's order — the
// built-ins first, then the apps that joined over the local API, by name.
// Claude Code is the main pill, always there, and is not an app; what Claude
// posts through MCP speaks through its pill and has no row either.
//
// Every row has the same parts, whatever the app:
// - shown: it has a pill on the island (a built-in also polls only then);
// - opensIsland: its news may open or peek the island;
// - its status line: what is wrong or missing, else what its pill says;
// - what its setup needs, as the app declares it (`AppSetup`): nothing, a
//   key, accounts (Gmail), or a choice of sign-in (GitHub: the GitHub CLI or
//   a token, src-tauri/src/github_auth.rs). hub/pages/apps.ts renders each kind.
// Only apps from the API can be removed: the built-ins are turned off.
// A new app is in the next snapshot, so it shows here as soon as it joins.

import { Bridge, type GitHubCliStatus } from "./bridge";
import { AppsBridge, Feed, type AppInfo, type AppSetup } from "./apps";
import { MAIN_PILL } from "./pills";
import { DEFAULT_SETTINGS, type Settings } from "./state";

/** How GitHub signs in, for its row in Settings. */
export interface AppAuth {
  /** What is in use: the setting, or (never chosen) the CLI when it is signed in. */
  mode: "cli" | "token";
  /** False while the setting was never set: `mode` is then the automatic pick. */
  chosen: boolean;
  /** The GitHub CLI and who it is signed in as; null outside the app. */
  cli: GitHubCliStatus | null;
}

export interface AppRow {
  /** The app's registry id ("github", "gmail", "gtm"). */
  id: string;
  name: string;
  kind: "builtin" | "api";
  /** Its pill, for views/logo.ts logoElement. */
  logoId: string;
  /** One line about it, or null when there is nothing to say. */
  status: string | null;
  shown: boolean;
  opensIsland: boolean;
  /** What its setup needs, as the app declared it. */
  setup: AppSetup;
  /** Only apps from the API: a built-in is turned off, never removed. */
  removable: boolean;
}

/** Where AppList reads and saves the island's settings (GitHub's sign-in). */
export interface SettingsStore {
  readonly value: Settings;
  update(change: (s: Settings) => void): Promise<void>;
}

/** Settings → Apps' rows, from a registry snapshot and nothing else. */
export function appRows(apps: readonly AppInfo[]): AppRow[] {
  return apps
    // Claude's MCP posts are Claude Code's, under its pill.
    .filter((a) => a.pill !== MAIN_PILL)
    .map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      logoId: a.pill,
      status: a.problem ?? a.status ?? null,
      shown: a.shown,
      opensIsland: a.opensIsland,
      setup: a.settings ?? { kind: "none" },
      removable: a.kind === "api",
    }));
}

/** Until a page hands over its own store: the settings as Rust has them. */
let fallback: Settings | null = null;
const bootStore: SettingsStore = {
  get value() {
    return fallback ?? DEFAULT_SETTINGS;
  },
  async update(change) {
    const next = { ...(fallback ?? (await Bridge.boot())?.settings ?? DEFAULT_SETTINGS) };
    change(next);
    fallback = next;
    await Bridge.saveSettings(next);
  },
};
let store: SettingsStore = bootStore;

/** The sign-in in use: the one picked, else the CLI when it is signed in. */
export function githubAuthMode(setting: Settings["githubAuth"] | undefined, cli: GitHubCliStatus | null): "cli" | "token" {
  if (setting === "cli" || setting === "token") return setting;
  return cli?.signedIn ? "cli" : "token";
}

/** The key an app's setup asks for, if any (for a sign-in, the one of token mode). */
function keyOf(id: string) {
  const setup = Feed.app(id)?.settings;
  if (setup?.kind === "key") return setup;
  if (setup?.kind === "signIn") return setup.key;
  return null;
}

export const AppList = {
  /**
   * The settings copy to edit, so a page that holds one (hub/island-settings.ts)
   * never saves over what AppList changed. Without it AppList reads Rust's.
   */
  use(s: SettingsStore) {
    store = s;
  },

  /** The rows of the registry as Rust has it now (and the feed with it, for the logos). */
  async rows(): Promise<AppRow[]> {
    const snapshot = await AppsBridge.snapshot();
    if (snapshot) Feed.set(snapshot);
    return appRows(Feed.apps);
  },

  /** Puts the app's pill on the island, or takes it off (a built-in's poller with it). */
  async setShown(id: string, on: boolean) {
    await AppsBridge.setHidden(id, !on);
  },

  /** Lets the app's news open or peek the island, or keeps it behind the bell. */
  async setOpensIsland(id: string, on: boolean) {
    await AppsBridge.setMuted(id, !on);
  },

  /** Whether the key the app's setup asks for is saved. */
  async keyIsSet(id: string): Promise<boolean> {
    const key = keyOf(id);
    return key ? ((await Bridge.secretPresent(key.secret)) ?? false) : false;
  },

  /** Saves the key the app's setup asks for (an empty value removes it). Throws when the store refuses. */
  async saveKey(id: string, value: string) {
    const key = keyOf(id);
    if (!key) return;
    const v = value.trim();
    if (!v) return AppList.removeKey(id);
    await Bridge.secretSet(key.secret, v);
    // Shown: poll it now rather than at its next turn.
    if (Feed.app(id)?.shown) void Bridge.refreshIntegration(id);
  },

  async removeKey(id: string) {
    const key = keyOf(id);
    if (key) await Bridge.secretClear(key.secret);
  },

  /** How GitHub signs in now: the setting, and the GitHub CLI as it is. */
  async githubAuth(): Promise<AppAuth> {
    if (store === bootStore && !fallback) fallback = (await Bridge.boot())?.settings ?? null;
    const cli = await Bridge.githubCliStatus();
    const setting = store.value.githubAuth ?? "";
    return { mode: githubAuthMode(setting, cli), chosen: setting !== "", cli };
  },

  /** GitHub signs in through the GitHub CLI, or with the saved token. */
  async setGithubAuth(mode: "cli" | "token") {
    if (store.value.githubAuth === mode) return;
    await store.update((s) => (s.githubAuth = mode));
  },

  /** Forgets an API app and its notifications. Built-ins cannot be removed, only turned off. */
  async remove(id: string) {
    if (Feed.app(id)?.kind !== "api") return;
    await AppsBridge.remove(id);
  },
};
