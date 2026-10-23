// Dictation: one page for everything about it. History (search, copy,
// delete), Statistics (words, speed, time saved, where), and Settings (the
// key, the microphone, the speech model, the clean-up and its styles, how long
// the history is kept). Merges Coucou's Dictation, Statistics, Styles and Flow
// Settings pages (FlowHubHome / Insights / Words / Settings.swift).

import { h, clear } from "../../views/dom";
import { t } from "../../i18n/i18n";
import { onEvent } from "../../core/bridge";
import {
  FlowBridge, type AppStyle, type FlowEntry, type FlowKey, type FlowStats, type Style, type Totals,
} from "../../core/flow";
import type { HubContext } from "../shell";
import { emptyState } from "../hero";
import {
  button, iconButton, keyKeycap, keyLabel, keycap, number, pageHead, row, section, segmented, select, shortCount, toggle,
} from "../ui";
import { speechModelRow } from "./speech";
import { IslandSettings } from "../island-settings";
import { PACES } from "../../views/say";

type Tab = "history" | "stats" | "settings";
const TABS: Tab[] = ["history", "stats", "settings"];
const TAB_MEMORY = "hub.dictation.tab";

/** The tab last open, a per-viewer convenience that may be unavailable. */
function rememberedTab(): Tab {
  try {
    const v = localStorage.getItem(TAB_MEMORY);
    return TABS.includes(v as Tab) ? (v as Tab) : "history";
  } catch {
    return "history";
  }
}

function rememberTab(tab: Tab) {
  try {
    localStorage.setItem(TAB_MEMORY, tab);
  } catch {
    // Private storage off: the page opens on History next time.
  }
}

export async function dictationPage(page: HTMLElement, ctx: HubContext) {
  let tab: Tab = TABS.includes(ctx.tab as Tab) ? (ctx.tab as Tab) : rememberedTab();
  const body = h("div", { class: "hub-page-body" });
  const picker = segmented<Tab>(
    [["history", t("History")], ["stats", t("Statistics")], ["settings", t("Settings")]],
    tab,
    (next) => {
      tab = next;
      rememberTab(tab);
      void draw();
    },
  );
  page.append(pageHead(t("Dictation"), picker), body);

  let leave: (() => void) | undefined;
  ctx.onLeave = () => leave?.();

  async function draw() {
    leave?.();
    leave = undefined;
    const fresh = h("div", { class: "hub-page-body" });
    if (tab === "history") leave = await historyTab(fresh, ctx);
    else if (tab === "stats") await statsTab(fresh);
    else await settingsTab(fresh, ctx, () => void draw());
    clear(body);
    body.append(...fresh.childNodes);
  }
  await draw();
}

// ── History ──────────────────────────────────────────────────────────────────

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function dayTitle(ms: number): string {
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (dayKey(ms) === dayKey(today.getTime())) return t("Today");
  if (dayKey(ms) === dayKey(yesterday.getTime())) return t("Yesterday");
  return new Date(ms).toLocaleDateString(document.documentElement.lang || undefined, { weekday: "long", day: "numeric", month: "long" });
}

function time(ms: number): string {
  return new Date(ms).toLocaleTimeString(document.documentElement.lang || undefined, { hour: "2-digit", minute: "2-digit" });
}

async function historyTab(body: HTMLElement, ctx: HubContext): Promise<() => void> {
  const status = ctx.status;
  const key = keyLabel(status.keys === "wayland" ? "wayland" : status.prefs.key, status.platform);

  // Not set up yet: the two things it takes, nothing else.
  if (!status.prefs.enabled || status.models.parakeet.state !== "ready") {
    body.append(section(t("Set up"), [
      row(t("Dictation"), t("Hold {0} anywhere, speak, let go: it's pasted.", { 0: key }), toggle(status.prefs.enabled, (on) => {
        void ctx.setPrefs((p) => (p.enabled = on)).then(() => ctx.navigate("dictation", "history"));
      })),
      speechModelRow(ctx, () => ctx.navigate("dictation", "history")),
    ]));
  }

  let entries: FlowEntry[] = (await FlowBridge.history()) ?? [];
  let query = "";
  const list = h("div", { class: "hub-history" });
  const search = h("input", { class: "hub-input", placeholder: t("Search dictations"), type: "search" }) as HTMLInputElement;
  search.addEventListener("input", () => {
    query = search.value.trim().toLowerCase();
    draw();
  });

  function draw() {
    clear(list);
    if (status.prefs.keepDays === 0) {
      list.append(emptyState(t("The history is off. Turn it on in Settings → Privacy.")));
      return;
    }
    const shown = query ? entries.filter((e) => e.text.toLowerCase().includes(query)) : entries;
    if (shown.length === 0) {
      list.append(emptyState(query ? t("No dictation matches.") : t("Your dictations will show here. Hold {0} in any app and speak.", { 0: key })));
      return;
    }
    let group: HTMLElement | null = null;
    let groupDay = "";
    for (const e of shown.slice(0, 300)) {
      const d = dayKey(e.date);
      if (d !== groupDay) {
        groupDay = d;
        list.append(h("div", { class: "hub-day", text: dayTitle(e.date) }));
        group = h("div", { class: "hub-entries" });
        list.append(group);
      }
      const when = h("div", { class: "when" }, h("span", { text: time(e.date) }));
      if (e.app) when.append(h("span", { class: "hub-tag", text: e.app, title: e.app }));
      const tools = h("div", { class: "tools" },
        iconButton("copy", t("Copy"), () => void FlowBridge.copy(e.text)),
        iconButton("trash", t("Delete"), () => {
          entries = entries.filter((x) => x.id !== e.id);
          void FlowBridge.deleteEntry(e.id);
          draw();
        }),
      );
      group!.append(h("div", { class: "hub-entry" }, when, h("div", { class: "words", text: e.text }), tools));
    }
  }

  if (entries.length > 0 || query) body.append(search);
  body.append(list);
  draw();

  return await onEvent<FlowEntry | null>("flow-history", (entry) => {
    if (!entry) return;
    entries = [entry, ...entries.filter((x) => x.id !== entry.id)];
    if (!search.isConnected && entries.length === 1) list.before(search);
    draw();
  });
}

// ── Statistics ───────────────────────────────────────────────────────────────

type Period = "week" | "month" | "all";

function duration(minutes: number): string {
  const m = Math.round(minutes);
  if (m >= 60) return t("{0} h {1}", { 0: Math.floor(m / 60), 1: String(m % 60).padStart(2, "0") });
  return t("{0} min", { 0: m });
}

async function statsTab(body: HTMLElement) {
  const stats: FlowStats | null = await FlowBridge.stats();
  let period: Period = "month";
  const content = h("div", { class: "hub-page-body" });
  const picker = segmented<Period>([["week", t("Week")], ["month", t("Month")], ["all", t("All")]], period, (p) => {
    period = p;
    draw();
  });
  body.append(h("div", { class: "hub-row" }, h("span", { style: "flex:1" }), picker), content);

  function stat(labelText: string, value: string, sub: string | null) {
    const el = h("div", { class: "hub-stat" }, h("div", { class: "label", text: labelText }), h("b", { text: value }));
    if (sub) el.append(h("div", { class: "sub", text: sub }));
    return el;
  }

  function draw() {
    clear(content);
    const totals: Totals = stats?.[period] ?? { words: 0, seconds: 0, dictations: 0, wordsPerMinute: 0, minutesSaved: 0 };
    content.append(h("div", { class: "hub-stat-row" },
      stat(t("Words dictated"), shortCount(totals.words), null),
      stat(t("Time saved"), duration(totals.minutesSaved), t("vs typing at 45 words/min")),
      stat(t("Speed"), number(totals.wordsPerMinute), t("words/min")),
      stat(t("Dictations"), number(totals.dictations), null),
    ));

    // Words per day, the last 30 days (or 7).
    const days = (stats?.daily ?? []).slice(period === "week" ? -7 : -30);
    const max = Math.max(1, ...days.map(([, w]) => w));
    const bars = h("div", { class: "hub-bars" });
    for (const [key, words] of days) {
      const bar = h("i", { class: words === 0 ? "zero" : "", title: `${key} · ${number(words)}` });
      bar.style.height = `${Math.max(words === 0 ? 0 : 3, (words / max) * 100)}%`;
      bars.append(bar);
    }
    const axis = h("div", { class: "hub-axis" });
    days.forEach(([key], i) => {
      if (i % (period === "week" ? 1 : 5) === 0 || i === days.length - 1) axis.append(h("span", { text: String(Number(key.split("-")[2])) }));
    });
    const chart = h("div", { class: "hub-card" }, h("div", { class: "title", style: "font:700 14px var(--font)", text: t("Words per day") }), bars, axis);

    const apps = Object.entries(stats?.apps ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const total = apps.reduce((s, [, w]) => s + w, 0);
    const appsCard = h("div", { class: "hub-card" }, h("div", { class: "title", style: "font:700 14px var(--font)", text: t("Where you dictate") }));
    if (apps.length === 0) {
      appsCard.append(emptyState(t("Dictate in an app and it shows here."), "idle"));
    } else {
      for (const [name, words] of apps) {
        const share = total > 0 ? words / total : 0;
        appsCard.append(h("div", { class: "hub-app-bar" },
          h("div", { class: "top" }, h("b", { text: name, style: "font-weight:500" }), h("span", { text: `${Math.round(share * 100)} %` })),
          h("div", { class: "track" }, h("i", { style: `width:${Math.max(2, share * 100)}%` })),
        ));
      }
    }
    content.append(h("div", { class: "hub-chart-row" }, chart, appsCard));
  }
  draw();
}

// ── Settings ─────────────────────────────────────────────────────────────────

export function styleOptions(): [Style, string][] {
  return [["verbatim", t("As said")], ["natural", t("Natural")], ["polished", t("Polished")]];
}

async function settingsTab(body: HTMLElement, ctx: HubContext, redraw: () => void) {
  body.classList.add("narrow");
  const status = await ctx.refresh();
  const prefs = status.prefs;

  // ── The key ──
  const keys: [FlowKey, string][] = [
    ["right_ctrl", t("Right {0}", { 0: "Ctrl" })],
    ["right_alt", t("Right {0}", { 0: "Alt" })],
    ["right_shift", t("Right {0}", { 0: "Shift" })],
    ["left_ctrl_super", status.platform === "windows" ? "Ctrl + Win" : "Ctrl + Super"],
  ];
  const wayland = status.keys === "wayland";
  body.append(section(null, [
    row(t("Dictation"), null, toggle(prefs.enabled, (on) => void ctx.setPrefs((p) => (p.enabled = on)))),
    wayland
      ? row(t("Hold to dictate"), null, keyKeycap("wayland", status.platform))
      : row(t("Hold to dictate"), prefs.key === "right_alt" ? t("On a keyboard with AltGr, the right Alt types characters: pick another key.") : null,
        select(keys, prefs.key, (key) => void ctx.setPrefs((p) => (p.key = key)).then(redraw))),
    row(t("Hands-free"), null, keyKeycap(wayland ? "wayland" : prefs.key, status.platform, true)),
    row(t("Cancel a dictation"), null, keycap(t("Esc"))),
    row(t("Paste the last dictation again"), null, button(t("Paste again"), () => void FlowBridge.pasteAgain(), "", true)),
    // winotch: an answer asked for by voice (Right Shift with the key) is read
    // along at this pace in the island (views/say.ts).
    row(t("Reading speed"), t("Answers you ask for by voice light up at this many words a minute."),
      segmented(PACES.map((p): [string, string] => [String(p), String(p)]), String(IslandSettings.value.sayPace ?? 300),
        (v) => void IslandSettings.update((x) => (x.sayPace = Number(v))))),
  ], status.keys !== "ok" && !wayland ? t("Dictation can't use the keyboard here") : null));

  // ── Listening ──
  const mics: [string, string][] = [["", t("System default")], ...status.mics.map((m): [string, string] => [m.name, m.name])];
  if (prefs.mic && !mics.some(([id]) => id === prefs.mic)) mics.push([prefs.mic, prefs.mic]);
  body.append(section(t("Listening"), [
    row(t("Microphone"), null, select(mics, prefs.mic, (mic) => void ctx.setPrefs((p) => (p.mic = mic)))),
    speechModelRow(ctx, redraw),
  ], t("Your voice never leaves this computer.")));

  // ── Clean-up ──
  let styles: AppStyle[] = (await FlowBridge.styles()) ?? [];
  const saveStyles = () => void FlowBridge.setStyles(styles);
  const perApp = h("div", { class: "hub-style-list" });
  const drawApps = () => {
    clear(perApp);
    for (const s of styles) {
      perApp.append(row(s.name, null,
        select(styleOptions(), s.style, (style) => {
          styles = styles.map((x) => (x.id === s.id ? { ...x, style } : x));
          saveStyles();
        }),
        iconButton("x", t("Delete"), () => {
          styles = styles.filter((x) => x.id !== s.id);
          saveStyles();
          drawApps();
        }),
      ));
    }
  };
  // "Add an app": the apps with a window right now.
  const add = h("select", { class: "hub-select" }) as HTMLSelectElement;
  const fillAdd = async () => {
    clear(add);
    add.append(h("option", { value: "", text: `+ ${t("Add an app")}` }));
    const running = ((await FlowBridge.runningApps()) ?? []).filter((a) => !styles.some((s) => s.id === a.id));
    if (running.length === 0) add.append(h("option", { value: "-", text: t("No other open app"), disabled: true }));
    for (const a of running) add.append(h("option", { value: `${a.id}\n${a.name}`, text: a.name }));
    add.value = "";
  };
  add.addEventListener("focus", () => void fillAdd());
  add.addEventListener("change", () => {
    const [id, name] = add.value.split("\n");
    if (!id || id === "-") return;
    styles = [...styles, { id, name: name ?? id, style: ctx.status.prefs.defaultStyle }];
    saveStyles();
    drawApps();
    void fillAdd();
  });
  void fillAdd();
  drawApps();

  const needsKey = prefs.cleanup && !status.hasClaudeKey;
  const keyRow = needsKey
    ? row(t("Needs your Claude API key"), null, button(t("Add it"), () => ctx.navigate("claude"), "", true))
    : null;
  keyRow?.classList.add("needs");
  body.append(section(t("Clean-up"), [
    row(t("Clean up with Claude"), t("Removes the “um”, the repeats and the corrections you made while speaking, and fixes the punctuation."),
      toggle(prefs.cleanup, (on) => void ctx.setPrefs((p) => (p.cleanup = on)).then(redraw))),
    keyRow,
    prefs.cleanup && row(t("Style"), null, select(styleOptions(), prefs.defaultStyle, (style) => void ctx.setPrefs((p) => (p.defaultStyle = style)))),
    prefs.cleanup && perApp,
    prefs.cleanup && row(t("Style per app"), null, add),
  ], prefs.cleanup ? t("The text, never your voice, goes to Anthropic with your Claude key.") : null));

  // ── History ──
  const keep: [string, string][] = [["0", t("Don't keep")], ["7", t("7 days")], ["30", t("30 days")], ["365", t("1 year")], ["-1", t("Forever")]];
  const eraseRow = h("div", { class: "hub-row" });
  const erase = () => {
    clear(eraseRow);
    eraseRow.append(
      h("span", { style: "flex:1" }),
      button(t("Erase the history"), () => void FlowBridge.clear(false), "", true),
      button(t("Erase everything"), () => {
        clear(eraseRow);
        eraseRow.append(
          h("span", { class: "hub-note", style: "flex:1", text: t("Erase the history and the statistics?") }),
          button(t("Erase everything"), () => {
            void FlowBridge.clear(true);
            erase();
          }, "danger", true),
          button(t("Cancel"), erase, "", true),
        );
      }, "", true),
    );
  };
  erase();
  body.append(section(t("History"), [
    row(t("Keep the history"), null, select(keep, String(prefs.keepDays), (v) => void ctx.setPrefs((p) => (p.keepDays = Number(v))))),
    eraseRow,
  ], t("Kept on this computer. Dictations are never saved as audio.")));
}
