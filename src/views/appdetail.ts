// One app, expanded (WINOTCH.md): the island grows from the open size to
// APP_W × 280 and shows the whole list of the app whose card was clicked. Same
// rows, fonts and fades as the feed, for every app (core/app-detail.ts).
// Esc, the back arrow or a click on the mark goes back to the overview.
//
// Two things any app's list may carry, drawn the same way for every app:
// - views (Gmail: Inbox, Primary, Unread): text buttons in the left column
//   under the mark, only their words, never cut: the column takes the width
//   of its longest word and the list moves over for it; choosing one filters
//   the list here, sections kept, and is remembered per app while winotch runs;
// - items with details (a mail): a click slides the list aside for a pane
//   with the item's title and byline (who, when) at once, then its text,
//   attachments and buttons; its full header lines wait behind a chevron, an
//   earlier mail quoted at its end behind a "…" (as Gmail trims it). The back
//   arrow and Esc return to the list where it was scrolled (`back`), then to
//   the overview. The pane always ends in the details or one error line: past
//   `DetailTiming.giveUp` without an answer it says the app did not answer.

import { AppsBridge, Feed, ago, type AppInfo, type ItemDetail } from "../core/apps";
import {
  canExpand, chooseView, currentView, detailFor, findItem, inView, sectionsInView, splitQuoted,
  type AppDetail, type DetailAction, type DetailItem,
} from "../core/app-detail";
import { Bridge } from "../core/bridge";
import { State } from "../core/state";
import { ICONS } from "./icons";
import { clear, h, svg } from "./dom";
import { logoElement } from "./logo";
import { buildTodayStage } from "./today";
import type { ViewActions, ViewHost } from "./views";
import { t } from "../i18n/i18n";

/** The expanded app's host: the island's Esc and the feed reach it. */
export interface AppViewHost extends ViewHost {
  /** From an item's details back to the list: true if it did, false when on the list already. */
  back(): boolean;
  /**
   * Expands the app (registry id) on that item: its details when it has
   * them, else its list. False when there is nothing to expand, so the caller
   * does what it did before.
   */
  openItem(appId: string, itemId: string | null): boolean;
  /** Which pane shows. */
  readonly mode: "list" | "detail";
}

/**
 * A built-in that draws its own list and details in the card (Today: its
 * quick add, its calendar, its editors), from what the island already has:
 * nothing is asked of Rust for its details. The head, the views column, the
 * slide and Esc stay the framework's.
 */
export interface AppStage {
  /** Fills the list area for the view chosen, keeping what is being typed. Called when the app's data changed. */
  list(el: HTMLElement, view: string | null, ctx: StageContext): void;
  /** Fills the details pane for one of its items: the head's title and buttons. Null: no such item (any more). */
  pane(el: HTMLElement, itemId: string, ctx: StageContext): StagePane | null;
}

/** What a stage's details put in the head: a title and buttons (the first one lit, unless `plain`). */
export interface StagePane {
  title: string;
  actions: DetailAction[];
  plain?: boolean;
}

export interface StageContext {
  /** Opens one of its items' details (the list slides aside). */
  open(itemId: string): void;
  /** From the details back to the list. */
  back(): void;
  blip(): void;
  /** Draws the list and the open details again (its own state changed). */
  redraw(): void;
}

/** How long the pane waits, in ms (tests shorten them). */
export const DetailTiming = {
  /** Before "Loading…" shows: a mail read ahead never flashes it. */
  wait: 300,
  /** Before the pane gives up on an answer (Rust gives up first, at 15 s). */
  giveUp: 20_000,
  /** The pointer rests this long on a row before it is read ahead. */
  hover: 120,
};

/** The item whose details are shown, and what came for it. */
interface Opened {
  app: AppInfo;
  item: DetailItem;
  /** Asked for and not answered yet: neither. */
  detail: ItemDetail | null;
  error: string | null;
  ticket: number;
  /** Its header lines shown (the chevron), its quoted tail shown (the "…"). */
  metaOpen: boolean;
  quoteOpen: boolean;
}

export function buildAppDetail(actions: ViewActions): AppViewHost {
  const back = h("button", { class: "ad-back", title: t("Back"), "aria-label": t("Back") }, svg(ICONS.chevronLeft, 12, { stroke: 2.2 }));
  back.addEventListener("click", () => {
    if (!host.back()) actions.setView("overview");
  });
  const logo = h("span", { class: "ad-logo" });
  const name = h("span", { class: "ad-name" });
  const status = h("span", { class: "ad-status" });
  const subject = h("span", { class: "ad-subject" });
  const link = h("button", { class: "feed-link ad-link" });
  const tools = h("div", { class: "ad-tools" });
  const viewsEl = h("nav", { class: "ad-views" });
  const list = h("div", { class: "ad-list" });
  // The pane: the byline at once; the rest fades in once it came.
  const bylineText = h("span", { class: "ad-byline-text" });
  const metaToggle = h("button", { class: "ad-meta-toggle" }, svg(ICONS.chevronUp, 10, { stroke: 2 }));
  const byline = h("div", { class: "ad-byline" }, bylineText, metaToggle);
  const meta = h("div", { class: "ad-meta" });
  const files = h("div", { class: "ad-files" });
  const body = h("div", { class: "ad-body" });
  const quoteToggle = h("button", { class: "ad-trim", text: "…" });
  const quoted = h("div", { class: "ad-body ad-quoted" });
  /** A stage's own details (AppStage.pane). */
  const own = h("div", { class: "ad-own" });
  const reader = h("div", { class: "ad-reader" }, meta, files, body, quoteToggle, quoted, own);
  const failure = h("div", { class: "ad-fail" });
  const waiting = h("div", { class: "ad-wait", text: t("Loading…") });
  const pane = h("div", { class: "ad-pane" }, byline, failure, waiting, reader);
  const error = h("div", { class: "feed-error" });
  const card = h("div", { class: "card ad-card" },
    viewsEl,
    h("div", { class: "ad-head" }, back, logo,
      h("div", { class: "ad-heading" }, h("div", { class: "ad-titles" }, name, status), subject),
      link, tools),
    error,
    h("div", { class: "ad-stage" }, list, pane),
  );
  const el = h("div", { class: "view appview" }, card);

  /** Says how far a scroller is scrolled, for the eased edges (style.css). */
  const edgesOf = (box: HTMLElement) => () => {
    box.classList.toggle("more-above", box.scrollTop > 2);
    box.classList.toggle("more-below", box.scrollTop + box.clientHeight < box.scrollHeight - 2);
  };
  const edges = edgesOf(list);
  const readerEdges = edgesOf(reader);
  list.addEventListener("scroll", edges, { passive: true });
  reader.addEventListener("scroll", readerEdges, { passive: true });

  /**
   * The views' column is as wide as its longest word (never cut); the list
   * and the head move over when that is wider than the column under the mark.
   */
  const fitViews = () => {
    const width = viewsEl.offsetWidth;
    if (typeof width === "number" && width > 0) card.style.setProperty("--views-w", `${Math.ceil(width)}px`);
  };
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(fitViews).observe(viewsEl);

  /** The rows already read ahead on a hover, this session. */
  const hovered = new Set<string>();

  // The pane's two folds: the full header lines, the quoted tail.
  metaToggle.addEventListener("click", () => {
    if (!opened) return;
    opened.metaOpen = !opened.metaOpen;
    renderPane();
  });
  quoteToggle.addEventListener("click", () => {
    if (!opened) return;
    opened.quoteOpen = !opened.quoteOpen;
    renderPane();
  });

  let mode: "list" | "detail" = "list";
  let opened: Opened | null = null;
  let tickets = 0;
  /** Where the list was scrolled when an item opened. */
  let listScroll = 0;
  /** The app on screen (its pill): another one starts on its list. */
  let shownTask: string | null = null;
  let lastKey = "";

  /** The built-ins that draw their own list and details, by registry id. */
  const stages: Record<string, AppStage> = { today: buildTodayStage() };
  const stageCtx: StageContext = {
    open(itemId) {
      const taskId = State.detailApp;
      const app = taskId ? Feed.byPill(taskId) : undefined;
      const detail = taskId ? detailFor(taskId) : null;
      const item = detail ? findItem(detail, itemId) : null;
      if (!app || !item) return;
      actions.blip();
      openDetail(app, item);
    },
    back: () => void host.back(),
    blip: () => actions.blip(),
    redraw() {
      lastKey = "";
      host.sync();
    },
  };

  const done = () => {
    Feed.error = null;
    State.notify();
  };
  const failed = (err: unknown) => {
    Feed.error = String(err);
    State.notify();
  };

  const press = (taskId: string, item: DetailItem, action: DetailAction) => {
    actions.blip();
    if (action.run) {
      action.run();
      return;
    }
    const app = Feed.byPill(taskId);
    if (item.notification) {
      AppsBridge.act(item.notification, action.id).then(done, failed);
    } else if (app) {
      // A row of the list the app published: the app does the work.
      AppsBridge.actItem(app.id, item.id, action.id).then(done, failed);
    }
  };

  /** Shows the transitions' end at once (an item opened from the feed). */
  const settle = () => {
    card.classList.add("instant");
    requestAnimationFrame(() => requestAnimationFrame(() => card.classList.remove("instant")));
  };

  /** Back to the list, where it was. `instant`: without the slide. */
  function toList(instant = false) {
    if (mode === "list") return;
    if (instant) settle();
    mode = "list";
    opened = null;
    tickets++;
    card.classList.remove("detail");
    pane.classList.remove("waiting");
    clear(tools);
    list.scrollTop = listScroll;
    requestAnimationFrame(edges);
  }

  /**
   * Slides the list aside and asks for the item's details: its title and
   * byline show at once, the rest fades in; "Loading…" only if it is slow,
   * and past `giveUp` one line saying the app did not answer.
   */
  function openDetail(app: AppInfo, item: DetailItem, instant = false) {
    if (instant) settle();
    if (mode === "list") listScroll = list.scrollTop;
    mode = "detail";
    const ticket = ++tickets;
    opened = { app, item, detail: null, error: null, ticket, metaOpen: false, quoteOpen: false };
    card.classList.add("detail");
    pane.classList.remove("waiting");
    renderPane();
    // A stage draws its details from what the island has.
    if (stages[app.id]) return;
    const asked = Date.now();
    const current = () => (opened?.ticket === ticket ? opened : null);
    const slow = setTimeout(() => {
      const o = current();
      if (o && !o.detail && !o.error) pane.classList.add("waiting");
    }, DetailTiming.wait);
    const giveUp = setTimeout(() => {
      const o = current();
      if (!o || o.detail || o.error) return;
      o.error = t("{0} did not answer", { 0: app.name });
      void Bridge.log(`app view: ${app.id} item details: no answer after ${DetailTiming.giveUp} ms`);
      renderPane();
    }, DetailTiming.giveUp);
    const settled = () => {
      clearTimeout(slow);
      clearTimeout(giveUp);
    };
    AppsBridge.itemDetail(app.id, item.id).then(
      (detail) => {
        settled();
        const o = current();
        if (!o || o.error) return;
        o.detail = detail;
        renderPane();
      },
      (err) => {
        settled();
        void Bridge.log(`app view: ${app.id} item details failed after ${Date.now() - asked} ms`);
        const o = current();
        if (!o || o.detail) return;
        o.error = String(err);
        renderPane();
      },
    );
  }

  /** Draws the pane; a failure to draw says so in its one error line. */
  function renderPane() {
    if (!opened) return;
    try {
      drawPane(opened);
    } catch (err) {
      void Bridge.log(`app view: the details pane failed to draw (${err instanceof Error ? err.name : "error"})`);
      opened.detail = null;
      opened.error = t("{0} did not answer", { 0: opened.app.name });
      pane.classList.remove("ready");
      pane.classList.remove("waiting");
      failure.textContent = opened.error;
    }
  }

  function drawPane(o: Opened) {
    const { app, detail, error: problem, item } = o;
    const stage = stages[app.id];
    if (stage) {
      clear(meta);
      clear(files);
      body.textContent = "";
      quoted.textContent = "";
      byline.style.display = "none";
      quoteToggle.style.display = "none";
      quoted.style.display = "none";
      meta.style.display = "none";
      failure.textContent = "";
      const shown = stage.pane(own, item.id, stageCtx);
      if (!shown) return toList();
      subject.textContent = shown.title;
      subject.setAttribute("title", shown.title);
      clear(tools);
      for (const [i, a] of shown.actions.entries()) {
        const b = h("button", { class: i === 0 && !shown.plain ? "btn primary small" : "btn secondary small", text: a.label });
        b.addEventListener("click", () => {
          actions.blip();
          a.run?.();
        });
        tools.append(b);
      }
      pane.classList.add("ready");
      requestAnimationFrame(readerEdges);
      return;
    }
    clear(own);
    const title = detail?.title ?? item.title;
    subject.textContent = title;
    subject.setAttribute("title", title);
    clear(tools);
    clear(meta);
    clear(files);
    body.textContent = "";
    quoted.textContent = "";
    failure.textContent = problem ?? "";
    if (detail || problem) pane.classList.remove("waiting");
    pane.classList.toggle("ready", detail != null);
    // Who and when: from the details, else what the list knew, at once.
    const line = detail?.byline ?? item.byline ?? null;
    bylineText.textContent = line ?? "";
    byline.style.display = line ? "" : "none";
    // The full header lines wait behind the chevron (Gmail's "to me ▾").
    metaToggle.style.display = line && (detail?.meta.length ?? 0) > 0 ? "" : "none";
    metaToggle.classList.toggle("open", o.metaOpen);
    const metaLabel = o.metaOpen ? t("Hide details") : t("Show details");
    metaToggle.setAttribute("title", metaLabel);
    metaToggle.setAttribute("aria-label", metaLabel);
    metaToggle.setAttribute("aria-expanded", String(o.metaOpen));
    if (!detail) {
      reader.scrollTop = 0;
      meta.style.display = "none";
      files.style.display = "none";
      quoteToggle.style.display = "none";
      quoted.style.display = "none";
      return;
    }
    // Without a byline (an app that sends none) the lines show as they are.
    meta.style.display = !line || o.metaOpen ? "" : "none";
    for (const l of detail.meta) meta.append(h("div", { class: "ad-meta-line", text: l }));
    if (detail.attachments.length) {
      files.append(svg(ICONS.paperclip, 12, { stroke: 1.8 }), h("span", { text: detail.attachments.join(" · ") }));
    }
    files.style.display = detail.attachments.length ? "" : "none";
    // An earlier mail quoted at its end waits behind "…", as Gmail trims it.
    const text = splitQuoted(detail.body);
    body.textContent = text.main;
    quoteToggle.style.display = text.quoted ? "" : "none";
    quoteToggle.classList.toggle("open", o.quoteOpen);
    const quoteLabel = o.quoteOpen ? t("Hide trimmed content") : t("Show trimmed content");
    quoteToggle.setAttribute("title", quoteLabel);
    quoteToggle.setAttribute("aria-label", quoteLabel);
    quoteToggle.setAttribute("aria-expanded", String(o.quoteOpen));
    quoted.textContent = text.quoted && o.quoteOpen ? text.quoted : "";
    quoted.style.display = text.quoted && o.quoteOpen ? "" : "none";
    for (const [i, a] of detail.actions.entries()) {
      const b = h("button", { class: i === 0 ? "btn primary small" : "btn secondary small", text: a.label });
      b.addEventListener("click", () => {
        actions.blip();
        AppsBridge.actItem(app.id, item.id, a.id).then(done, failed);
      });
      tools.append(b);
    }
    // Where it opens, when no button says so.
    if (detail.url && detail.actions.length === 0) {
      const url = detail.url;
      tools.append(h("button", { class: "feed-link", text: `${t("Open")} ↗`, onclick: () => actions.openUrl(url) }));
    }
    requestAnimationFrame(readerEdges);
  }

  function row(taskId: string, item: DetailItem): HTMLElement {
    const r = h("div", { class: item.unread ? "ad-item unread" : "ad-item" },
      h("i", { class: "ad-dot" }),
      h("div", { class: "ad-main" },
        h("div", { class: "ad-title", text: item.title }),
        item.subtitle ? h("div", { class: "ad-sub", text: item.subtitle }) : null,
      ),
    );
    const side = h("div", { class: "ad-side" });
    for (const [i, a] of (item.actions ?? []).entries()) {
      const b = h("button", { class: i === 0 ? "btn primary small" : "btn secondary small", text: a.label });
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        press(taskId, item, a);
      });
      side.append(b);
    }
    if (item.time) side.append(h("span", { class: "ad-time", text: ago(item.time) }));
    r.append(side);
    const app = Feed.byPill(taskId);
    // A press on a row with details opens them; else it reads it (a
    // notification) and opens what it points at.
    r.addEventListener("click", () => {
      if (item.detail && app) {
        actions.blip();
        openDetail(app, item);
        return;
      }
      if (item.notification && item.unread) void AppsBridge.read(item.notification);
      if (item.url) actions.openUrl(item.url);
    });
    // The pointer resting on a row with details reads it ahead (Gmail): the
    // click then finds it there.
    if (item.detail && app) {
      let rest: ReturnType<typeof setTimeout> | null = null;
      r.addEventListener("mouseenter", () => {
        const key = `${app.id}\n${item.id}`;
        if (hovered.has(key)) return;
        rest = setTimeout(() => {
          hovered.add(key);
          void AppsBridge.prefetchItem(app.id, item.id);
        }, DetailTiming.hover);
      });
      r.addEventListener("mouseleave", () => {
        if (rest) clearTimeout(rest);
        rest = null;
      });
    }
    if (item.url || item.detail) r.classList.add("link");
    return r;
  }

  function renderViews(appId: string, detail: AppDetail, view: string | null) {
    clear(viewsEl);
    const views = detail.views ?? [];
    card.classList.toggle("has-views", views.length > 0);
    for (const v of views) {
      // Only its words: no count, never cut.
      const b = h("button", { class: v.id === view ? "ad-view on" : "ad-view", text: v.label });
      b.addEventListener("click", () => {
        actions.blip();
        chooseView(appId, v.id);
        toList();
        list.scrollTop = 0;
        listScroll = 0;
        host.sync();
      });
      viewsEl.append(b);
    }
    fitViews();
  }

  // Leaving the view (the island folded, another view) ends the details:
  // the app opens on its list the next time.
  State.subscribe(() => {
    if (State.view !== "app" && mode === "detail") toList(true);
  });

  const host: AppViewHost = {
    el,
    get mode() {
      return mode;
    },
    back() {
      if (mode !== "detail") return false;
      toList();
      lastKey = "";
      State.notify();
      return true;
    },
    openItem(appId, itemId) {
      const app = Feed.app(appId);
      const detail = app ? detailFor(app.pill) : null;
      if (!app || !detail) return false;
      const item = itemId ? findItem(detail, itemId) : null;
      if (!item && !canExpand(app.pill)) return false;
      State.detailApp = app.pill;
      shownTask = app.pill;
      toList(true);
      list.scrollTop = 0;
      // A view that leaves the item out gives way to one that has it.
      if (item && !inView(item, currentView(app.id, detail.views))) {
        const has = detail.views?.find((v) => inView(item, v.id));
        if (has) chooseView(app.id, has.id);
      }
      lastKey = "";
      actions.setView("app");
      if (item?.detail) openDetail(app, item, true);
      return true;
    },
    sync() {
      const taskId = State.detailApp;
      if (taskId !== shownTask) {
        // Another app: on its list, from the top.
        shownTask = taskId;
        toList(true);
        list.scrollTop = 0;
        listScroll = 0;
        lastKey = "";
      }
      // The rule decides whether a card opens; an open view shows whatever is left.
      const detail = taskId ? detailFor(taskId) : null;
      error.textContent = Feed.error ?? "";
      if (!detail) {
        clear(list);
        clear(viewsEl);
        card.classList.remove("has-views");
        lastKey = "";
        return;
      }
      // Gone from the list (archived): its details go with it.
      if (opened && !findItem(detail, opened.item.id)) toList();
      const app = Feed.byPill(detail.taskId);
      const view = app ? currentView(app.id, detail.views) : null;
      // Rebuilt only when something it shows changed: the list keeps its scroll.
      const key = JSON.stringify([detail, view, Math.floor(Date.now() / 60_000)]);
      if (key === lastKey) return;
      lastKey = key;

      clear(logo);
      logo.append(logoElement(detail.logoId, detail.name, 16));
      name.textContent = detail.name;
      status.textContent = detail.status ?? "";
      status.style.display = detail.status ? "" : "none";
      link.textContent = detail.link ? `${detail.link.label} ↗` : "";
      link.style.display = detail.link ? "" : "none";
      link.onclick = detail.link ? () => actions.openUrl(detail.link!.url) : null;
      if (app) renderViews(app.id, detail, view);
      else {
        clear(viewsEl);
        card.classList.remove("has-views");
      }

      const stage = app ? stages[app.id] : undefined;
      list.classList.toggle("staged", !!stage);
      if (stage) {
        stage.list(list, view, stageCtx);
        if (mode === "detail") renderPane();
        return;
      }

      const scrolled = list.scrollTop;
      clear(list);
      const sections = sectionsInView(detail.sections, view).filter((s) => s.items.length > 0);
      if (sections.length === 0) {
        list.append(h("div", { class: "ad-empty", text: detail.empty }));
      }
      for (const s of sections) {
        if (s.title) list.append(h("div", { class: "ad-caption", text: s.title }));
        for (const item of s.items) list.append(row(detail.taskId, item));
      }
      list.scrollTop = scrolled;
      requestAnimationFrame(edges);
    },
  };
  return host;
}
