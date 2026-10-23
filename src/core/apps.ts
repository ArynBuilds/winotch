// The app registry as the island sees it (src-tauri/src/apps.rs, WINOTCH.md):
// every app (the built-ins and the ones that joined over the API), the one
// feed of their notifications, and their lists. Rust sends it whole as a
// snapshot (the "apps" event) whenever anything in it changes.

import { invoke } from "@tauri-apps/api/core";

const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`[winotch] ${cmd} failed`, err);
    return null;
  }
}

/** A key in the credential store, as an app's Settings row asks for it (English labels, shown with `t()`). */
export interface KeySetup {
  /** Its name in the credential store ("stripe-api-key"). */
  secret: string;
  label: string;
  placeholder: string;
  hint: string | null;
}

/** What an app declares its Settings row needs (apps.rs `Setup`). */
export type AppSetup =
  | { kind: "none" }
  | ({ kind: "key" } & KeySetup)
  /** Accounts, each with its own sign-in and "can open the island" (Gmail). */
  | { kind: "accounts" }
  /** How to sign in: a command-line tool's login or the key (GitHub). */
  | { kind: "signIn"; modes: ("cli" | "token")[]; key: KeySetup };

/**
 * One app of the registry (src-tauri/src/apps.rs, the one source of truth):
 * a built-in (GitHub, Stripe, Notion, Spotify, Gmail) or an app that joined
 * over the local API. Every screen draws from these.
 */
export interface AppInfo {
  /** Its registry id ("github", "gmail", "gtm"). */
  id: string;
  name: string;
  kind: "builtin" | "api";
  /** Its mark in core/logos.ts; an API app's own `icon` wins. */
  logo: string;
  /** Its pill's id on the island ("integration_github", "app_gmail", "app_gtm"). */
  pill: string;
  /** Dashes and dots, at most three. */
  sign: string | null;
  /** Its own logo: a data: URL of a PNG or SVG image. */
  icon: string | null;
  callback?: string | null;
  /** What its pill says now (Gmail: "12 unread"). */
  status: string | null;
  /** What is wrong or missing ("Key not configured"), in the interface language. */
  problem?: string | null;
  updated?: number;
  /** On the island (Settings → Apps); its pill shows once it is also `available`. */
  shown: boolean;
  /** May open or peek the island; off, its news waits behind the bell. */
  opensIsland: boolean;
  /** Able to do something yet: false keeps it off the island, never out of Settings (Gmail without an account). */
  available: boolean;
  /** Its setup is done (its key saved, the app it drives installed). */
  configured: boolean;
  /** What its Settings row needs. */
  settings: AppSetup;
}

export interface AppAction {
  id: string;
  label: string;
}

export interface AppNotification {
  id: string;
  app: string;
  title: string;
  body: string | null;
  url: string | null;
  importance: "low" | "normal" | "high";
  actions: AppAction[];
  /** Milliseconds since 1970. */
  time: number;
  read: boolean;
  /** The action pressed, once it was. */
  acted: string | null;
  /** The item of its app's list it is about (a mail): a click opens the app expanded there. */
  item?: string | null;
}

/** A row of an app's list (POST /v1/items): a mail, a draft. */
export interface ListItem {
  id: string;
  title: string;
  subtitle?: string | null;
  /** Milliseconds since 1970. */
  time?: number | null;
  unread?: boolean;
  /** http:, https: or mailto: only; the API refuses anything else. */
  url?: string | null;
  actions?: AppAction[];
  /** A click opens its details (`AppsBridge.itemDetail`) instead of its url. */
  detail?: boolean;
  /** The ids of the list's views it is in; absent: all of them. */
  views?: string[] | null;
  /** Who and when ("Ana · 2026-10-17 09:05"): its details pane shows it at once (Gmail). */
  byline?: string | null;
}

/** A view of an app's list (Gmail: Inbox, Primary, Unread): a button in the expanded view's left column, only its words. */
export interface ListView {
  id: string;
  label: string;
}

/** What a click on an item with `detail` shows (apps.rs `ItemDetail`). */
export interface ItemDetail {
  title: string;
  /** One line under the title, always shown (Gmail: the sender's name and the date). */
  byline?: string | null;
  /** Header lines ("From Ana <ana@example.com>"): with a byline, behind the details chevron. */
  meta: string[];
  /** Plain text: line breaks kept, nothing in it a link. */
  body: string;
  /** The attachments' names. */
  attachments: string[];
  url?: string | null;
  /** Pressed as the item's own (`actItem`). */
  actions: AppAction[];
}

export interface ListSection {
  title?: string | null;
  items: ListItem[];
}

/** What an app has open now, shown when it is expanded. Replaced whole on each publish. */
export interface AppItems {
  status: string | null;
  sections: ListSection[];
  updated: number;
  /** Its views, in order; absent or empty: the list is shown whole. */
  views?: ListView[];
}

export interface AppsSnapshot {
  apps: AppInfo[];
  notifications: AppNotification[];
  /** Each app's list, by app id; apps without one are absent. */
  lists: Record<string, AppItems>;
}

/** What the island knows of the apps; State.notify() follows every change. */
export const Feed = {
  /** The registry, in its one order: the built-ins, then the API apps by name. */
  apps: [] as AppInfo[],
  notifications: [] as AppNotification[],
  lists: {} as Record<string, AppItems>,
  /** The app the feed is filtered to, or null for all of them. */
  filter: null as string | null,
  /** An action press that failed, shown until the next one. */
  error: null as string | null,

  set(s: AppsSnapshot) {
    this.apps = s.apps ?? [];
    this.notifications = s.notifications ?? [];
    this.lists = s.lists ?? {};
    if (this.filter && !this.apps.some((a) => a.id === this.filter)) this.filter = null;
  },

  /** Unread, apps kept from opening the island left out: they wait in the feed without a count. */
  get unread(): number {
    const quiet = new Set(this.apps.filter((a) => !a.opensIsland).map((a) => a.id));
    return this.notifications.filter((n) => !n.read && !quiet.has(n.app)).length;
  },

  app(id: string): AppInfo | undefined {
    return this.apps.find((a) => a.id === id);
  },

  /** The app whose pill this is, if it is an app's (Claude Code's is not). */
  byPill(pill: string): AppInfo | undefined {
    return this.apps.find((a) => a.pill === pill);
  },

  /** The feed as shown: filtered, newest first. */
  get shown(): AppNotification[] {
    return this.filter ? this.notifications.filter((n) => n.app === this.filter) : this.notifications;
  },
};

export const AppsBridge = {
  snapshot: () => call<AppsSnapshot>("apps_snapshot"),
  read: (id: string | null, ofApp: string | null = null) =>
    call<void>("notification_read", { id, ofApp }),
  dismiss: (id: string) => call<void>("notification_dismiss", { id }),
  setMuted: (id: string, muted: boolean) => call<void>("app_set_muted", { id, muted }),
  setHidden: (id: string, hidden: boolean) => call<void>("app_set_hidden", { id, hidden }),
  remove: (id: string) => call<void>("app_remove", { id }),
  /** Settings → Apps opened: Rust looks again at what each built-in needs. */
  refreshSetup: () => call<void>("apps_refresh_setup"),
  /** Where api.json is: the address and token apps use. */
  apiFile: () => call<string>("apps_api_file"),
  /** Rejects with the app's answer when it fails, so the feed can say so. */
  act: (id: string, action: string) =>
    IS_TAURI ? invoke<void>("notification_act", { id, action }) : Promise.resolve(),
  /** An action on an item of an app's list; rejects like `act`. */
  actItem: (app: string, item: string, action: string) =>
    IS_TAURI ? invoke<void>("app_item_act", { app, item, action }) : Promise.resolve(),
  /** An item's details (a mail opened: Gmail marks it read); rejects with what went wrong. */
  itemDetail: (app: string, item: string) =>
    IS_TAURI ? invoke<ItemDetail>("app_item_detail", { app, item }) : Promise.reject(new Error("no details outside winotch")),
  /** The pointer rests on a row with details: a built-in may read them ahead (Gmail). */
  prefetchItem: (app: string, item: string) => call<void>("app_item_prefetch", { app, item }),
};

/** "now", "5 min", "3 h", "2 d": how long ago, short enough for a row. */
export function ago(time: number, now = Date.now()): string {
  const s = Math.max(0, (now - time) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

/** The pill an app's notifications wear (its logo, its flash): the registry's, else app_<id>. */
export const pillOfApp = (id: string) => Feed.app(id)?.pill ?? `app_${id}`;
