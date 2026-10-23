// winotch's settings: a sidebar, and the page on the right. Eight pages, in
// two groups: the island's (Get started, General, Claude Code, Apps, OK Tent)
// and Flow's (Dictation, Notetaker, Words). Each page starts with its title and holds its
// settings in Apple-style groups (ui.ts section). They live inside the island:
// the gear grows the notch around them (views/settings.ts), the back button or
// Esc returns. Port of FlowHub.swift, cut down from Coucou's fifteen pages.

import "./hub.css";
import { h, clear } from "../views/dom";
import { t } from "../i18n/i18n";
import { onEvent } from "../core/bridge";
import { FlowBridge, type FlowPrefs, type FlowStatus, type ModelsStatus } from "../core/flow";
import { icon, keyLabel } from "./ui";

export type PageId = "welcome" | "general" | "claude" | "apps" | "voice" | "dictation" | "notes" | "words";

interface PageDef {
  id: PageId;
  icon: string;
  title: () => string;
}

const ISLAND_PAGES: PageDef[] = [
  { id: "welcome", icon: "bolt", title: () => t("Get started") },
  { id: "general", icon: "gear", title: () => t("General") },
  { id: "claude", icon: "terminal", title: () => "Claude Code" },
  { id: "apps", icon: "grid", title: () => t("Apps") },
  { id: "voice", icon: "wave", title: () => "OK Tent" },
];

const FLOW_PAGES: PageDef[] = [
  { id: "dictation", icon: "mic", title: () => t("Dictation") },
  { id: "notes", icon: "record", title: () => t("Notetaker") },
  { id: "words", icon: "book", title: () => t("Words") },
];

const ALL = [...ISLAND_PAGES, ...FLOW_PAGES];

/**
 * Coucou's page names, still used by Rust (show_hub), old links and the Flow
 * pill: the page each one lives on now, and on which of its tabs.
 */
const MOVED: Record<string, [PageId, string?]> = {
  settings: ["dictation", "settings"],
  flowsettings: ["dictation", "settings"],
  styles: ["dictation", "settings"],
  insights: ["dictation", "stats"],
  dictionary: ["words"],
  snippets: ["words"],
  pills: ["apps"],
  integrations: ["apps"],
  agents: ["claude"],
  chat: ["claude"],
  shortcuts: ["general"],
};

/** A page name from anywhere, as a page and a tab here. */
function resolve(name: string | null | undefined): [PageId, string?] | null {
  if (!name) return null;
  if (ALL.some((p) => p.id === name)) return [name as PageId];
  return MOVED[name] ?? null;
}

/** What a page gets to draw itself and reach the rest of the window. */
export interface HubContext {
  status: FlowStatus;
  /** Shows `page`, on `tab` for a page that has tabs. */
  navigate(page: PageId, tab?: string): void;
  /** The tab asked for when this page was opened, if any. */
  tab?: string;
  /** Reads the status again (prefs, models) and redraws the sidebar's line. */
  refresh(): Promise<FlowStatus>;
  /** Saves new preferences and keeps them as the window's. */
  setPrefs(change: (p: FlowPrefs) => void): Promise<void>;
  /** Set by a page: called when the page is left. */
  onLeave?: () => void;
}

export type PageRenderer = (container: HTMLElement, ctx: HubContext) => void | Promise<void>;
/** Kept for the Flow pages' signatures. */
export type FlowPageRenderer = PageRenderer;

export interface HubOptions {
  version: string;
  pages: Record<PageId, PageRenderer>;
  /** The back button's press: back to the island. */
  onBack(): void;
}

/** What the island holds of its settings once they are drawn. */
export interface HubHandle {
  /** Shows `page` (any name, old ones too: "settings", "notes"…), on its tab if it has tabs. */
  open(name: string): void;
  redraw(): void;
  current(): PageId;
  /** Called when the settings are left: the page's own listeners stop. */
  leave(): void;
}

const DEFAULT_STATUS: FlowStatus = {
  prefs: {
    enabled: false, key: "right_ctrl", mic: "", keepDays: 30, cleanup: false,
    defaultStyle: "natural", summaryEngine: "claude", openAtLaunch: true, voice: false, voiceOutput: "system", voiceGender: "female",
  },
  models: { parakeet: { state: "missing" }, downloadMb: 700 },
  keys: "ok",
  hasClaudeKey: false,
  mics: [],
  platform: navigator.userAgent.includes("Windows") ? "windows" : "linux",
  autostarted: false,
};

export async function startHub(root: HTMLElement, opts: HubOptions, first = "general"): Promise<HubHandle> {
  const [firstPage, firstTab] = resolve(first) ?? ["general"];
  let current: PageId = firstPage;
  let status: FlowStatus = (await FlowBridge.status()) ?? DEFAULT_STATUS;
  const items = new Map<PageId, HTMLElement>();
  const statusLine = h("div", { class: "hub-status" });
  const scroll = h("div", { class: "hub-scroll" });
  let rendering = 0;

  const ctx: HubContext = {
    get status() {
      return status;
    },
    navigate: (page, tab) => void show(page, tab),
    refresh: async () => {
      status = (await FlowBridge.status()) ?? status;
      drawStatus();
      return status;
    },
    setPrefs: async (change) => {
      const next = { ...status.prefs };
      change(next);
      status = { ...status, prefs: next };
      drawStatus();
      await FlowBridge.setPrefs(next);
    },
  };

  /** The sidebar's last line: whether dictation is ready, only when it is on. */
  function drawStatus() {
    clear(statusLine);
    if (!status.prefs.enabled) return;
    const models = status.models.parakeet.state;
    let text: string;
    if (models !== "ready") {
      text = models === "downloading" ? t("Downloading the voice model…") : t("Download the voice model to dictate");
    } else if (status.keys !== "ok" && status.keys !== "wayland") {
      text = t("Dictation can't use the keyboard here");
    } else {
      text = t("Ready · hold {0}", { 0: keyLabel(status.keys === "wayland" ? "wayland" : status.prefs.key, status.platform) });
    }
    statusLine.append(h("i", { class: "dot" }), h("span", { text }));
  }

  async function show(page: PageId, tab?: string) {
    const def = ALL.find((p) => p.id === page) ?? ALL[0];
    ctx.onLeave?.();
    ctx.onLeave = undefined;
    current = def.id;
    for (const [id, el] of items) el.classList.toggle("on", id === current);
    const token = ++rendering;
    const page_ = h("div", { class: "hub-page" });
    ctx.tab = tab;
    await opts.pages[def.id](page_, ctx);
    ctx.tab = undefined;
    if (token !== rendering) return;
    clear(scroll);
    scroll.append(page_);
    scroll.scrollTop = 0;
  }

  // ── The sidebar ──
  // Its head: back to the island. The island's own mark stands left of it.
  const side = h("nav", { class: "hub-side" });
  const back = h("button", { class: "hub-back", title: t("Back"), "aria-label": t("Back"), onclick: () => opts.onBack() });
  back.append(icon("chevron"), h("span", { text: t("Settings") }));
  side.append(h("div", { class: "hub-brand" }, back));
  const group = (title: string | null, pages: PageDef[]) => {
    side.append(h("div", { class: "hub-group", text: title ?? "" }));
    for (const p of pages) {
      const b = h("button", { class: "hub-item", onclick: () => void show(p.id) });
      b.append(icon(p.icon), h("span", { text: p.title() }));
      items.set(p.id, b);
      side.append(b);
    }
  };
  group(null, ISLAND_PAGES);
  group("Flow", FLOW_PAGES);
  // The name as its wordmark, in bold.
  side.append(h("div", { class: "spacer" }), statusLine,
    h("div", { class: "hub-version" }, h("b", { text: "winotch" }), ` ${opts.version}`));

  clear(root);
  root.classList.add("hub-root");
  root.append(side, h("main", { class: "hub-panel" }, scroll));
  drawStatus();
  await show(current, firstTab);

  void onEvent<FlowPrefs>("flow-prefs", (prefs) => {
    status = { ...status, prefs };
    drawStatus();
  });
  void onEvent<ModelsStatus>("speech-models", (models) => {
    status = { ...status, models };
    drawStatus();
  });
  return {
    open: (name) => {
      const target = resolve(name);
      if (target) void show(target[0], target[1]);
    },
    redraw: () => void show(current),
    current: () => current,
    leave: () => {
      ctx.onLeave?.();
      ctx.onLeave = undefined;
    },
  };
}
