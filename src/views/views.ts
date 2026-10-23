// Island views — DOM ports of IslandViewContent.swift. Paddings, font sizes,
// colours and wording are copied from the Swift views so both platforms read
// identically.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Ticker } from "./ticker";
import { State, type AgentTask } from "../core/state";
import { washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { createAppLogo, pruneAppLogos } from "./app-logos";
import { buildPrompt, openChatOn } from "./chat";
import { buildChoose, buildUpload, buildUploading } from "./upload";
import { renderIntegrationCard, type IntegrationCardHooks } from "./integrations";
import { highlightRow, listRows, openRow } from "./github";
import { pillDefinition, sessionSubtitle } from "../core/pills";
import {
  PlanCard, buildPlanPill, claudePillVisible, planCardOpen,
} from "./usage";
import { buildDiffCard } from "./diff";
import { lastTextStep } from "../core/diff";
import { Bridge } from "../core/bridge";
import { buildRecap } from "./recap";
import { buildSpotifyCard, buildSpotifyPill, type SpotifyPillHost } from "./spotify";
import { SPOTIFY_ID } from "../core/spotify";
import { language, t, tl, type Msg } from "../i18n/i18n";
import type { ViewCommand } from "../island/shortcuts";
import { AppsBridge, Feed, ago } from "../core/apps";
import { buildNotifications } from "./notifications";
import { buildAppDetail } from "./appdetail";
import { buildSettingsView } from "./settings";
import { buildSay } from "./say";
import { canExpand } from "../core/app-detail";
import { logoElement } from "./logo";
import { PillPager } from "./pill-pages";
import { buildTodayCard } from "./today";
import { Today } from "../core/today";

export interface ViewActions {
  setView(v: IslandViewName): void;
  /** "Cancel" on a dropped file: forgets it and goes back home. */
  cancelDrop(): void;
  collapse(): void;
  /** Folds a waiting card to the compact island without answering it. */
  foldApproval(): void;
  setFocus(id: string): void;
  openTerminal(): void;
  /** The ↗ button: opens whatever the focused pill points at. */
  openTarget(): void;
  openUrl(url: string): void;
  decide(d: "allow" | "deny"): void;
  /** Answers the question Claude Code asked: question text → chosen label. */
  answer(answers: Record<string, string | string[]>): void;
  /** Hands the pending request back to the terminal. */
  answerInTerminal(): void;
  toggleSound(): void;
  openSettingsWindow(): void;
  blip(): void;
}

/** What was asked by voice, for the island to say big (views/say.ts): what was said, then the answer. */
export type SayLine = { phase: "asking"; text: string } | { phase: "answer"; text: string };

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /** Called every frame while the view is on screen. True = needs another frame. */
  tick?(nowMs: number): boolean | void;
  /** Ctrl+O / Ctrl+E while the view is on screen (island/shortcuts.ts). */
  command?(command: ViewCommand): void;
  /** Esc: one step back inside the view (an item's details to its list). False: nothing to step back from. */
  back?(): boolean;
  /** What was said with Shift, asked without opening anything (the chat: views/chat.ts). */
  ask?(text: string): void;
  /** Runs `then` once the answer under way is in (the chat: views/chat.ts), at once when none is. */
  whenIdle?(then: () => void): void;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(
  label: string | Msg,
  kind: "primary" | "secondary",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/** AgentWho — coloured dot + task name + grey label. */
function agentWho(task: AgentTask | null, label: string, name = task?.name ?? ""): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) {
    row.append(dot(task.color, 8), h("span", { class: "n", text: name }));
  }
  row.append(h("span", { text: label }));
  return row;
}

function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

// ── Header ────────────────────────────────────────────────────────────────────

export function buildHeader(actions: ViewActions): ViewHost {
  const tabHome = h("button", { class: "tab", title: tl("Overview"), onclick: () => go("overview") }, svg(ICONS.house, 13));
  const tabChat = h("button", { class: "tab", title: tl("Ask"), onclick: () => go("prompt") }, svg(ICONS.bubble, 13));
  const tabDrop = h("button", { class: "tab", title: tl("Drop"), onclick: () => go("upload") }, svg(ICONS.plus, 13));
  // winotch: every app's notifications, with the unread count on the bell.
  const bellCount = h("span", { class: "tab-count" });
  const tabFeed = h("button", { class: "tab feed-tab", title: t("Notifications"), onclick: () => go("notifications") },
    svg(ICONS.bell, 13), bellCount);

  // The settings live in their own window (General first), not in the island.
  const gearBtn = h("button", {
    title: tl("Settings"),
    onclick: () => {
      actions.blip();
      actions.openSettingsWindow();
    },
  }, svg(ICONS.gear, 14));
  const soundBtn = h("button", { title: tl("Mute"), onclick: () => actions.toggleSound() }, svg(ICONS.speakerOn, 14));
  // Plan usage pill (off by default): before the gear, as on the Mac.
  const claudePill = buildPlanPill();
  const planPills = h("div", { class: "plan-pills" }, claudePill.el);

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  // One lit backdrop slides from tab to tab with the screens (core/motion.ts),
  // instead of each tab lighting up on its own. Away from the tabs (an app, a
  // card) it fades where it was.
  const marker = h("span", { class: "tab-marker" });
  let markedTab: HTMLElement | null = null;
  function mark(tab: HTMLElement | null) {
    if (tab === markedTab) return;
    if (tab) {
      // The first time it is placed without sliding there.
      if (!markedTab && !marker.classList.contains("placed")) {
        marker.style.transform = `translateX(${tab.offsetLeft}px)`;
        void marker.offsetWidth;
        marker.classList.add("placed");
      } else marker.style.transform = `translateX(${tab.offsetLeft}px)`;
    }
    marker.classList.toggle("off", !tab);
    markedTab = tab;
  }

  const el = h(
    "div",
    { id: "header" },
    h("div", { class: "tabs" }, marker, tabHome, tabChat, tabFeed, tabDrop),
    h("div", { class: "header-actions" }, planPills, gearBtn, soundBtn),
  );

  return {
    el,
    sync() {
      const v = State.view;
      tabHome.classList.toggle("on", v === "overview" || v === "empty");
      tabChat.classList.toggle("on", v === "prompt");
      tabDrop.classList.toggle("on", v === "upload");
      tabFeed.classList.toggle("on", v === "notifications");
      mark([tabHome, tabChat, tabDrop, tabFeed].find((t) => t.classList.contains("on")) ?? null);
      const unread = Feed.unread;
      bellCount.textContent = unread > 99 ? "99+" : String(unread);
      bellCount.style.display = unread > 0 ? "" : "none";
      // Rebuilt only when the icon changes: this runs on every state change.
      const speaker = State.settings.soundEnabled ? "on" : "off";
      if (soundBtn.dataset.icon !== speaker) {
        soundBtn.dataset.icon = speaker;
        clear(soundBtn);
        soundBtn.append(svg(State.settings.soundEnabled ? ICONS.speakerOn : ICONS.speakerOff, 14));
      }
      syncPlanPills();
      // The settings bring their own head, and an answer said big has nothing
      // around it: the tabs fade for them (style.css).
      el.style.opacity = v === "confused" || v === "settings" || v === "say" ? "0" : "1";
    },
  };

  function syncPlanPills() {
    const claudeOn = claudePillVisible();
    claudePill.el.style.display = claudeOn ? "" : "none";
    planPills.classList.toggle("on", claudeOn);
    if (claudeOn) claudePill.sync();
  }
}

// ── An app's card (winotch) ───────────────────────────────────────────────────

/** The built-ins whose data has a card of its own (views/integrations.ts; Spotify's player above). */
const CARDS: ReadonlySet<string> = new Set(["github", "stripe", "notion"]);

/**
 * The left card of an app without a card of its own (the API's, Gmail): its
 * status line in the registry and its two latest notifications.
 */
function appCard(appId: string, actions: ViewActions): HTMLElement {
  const app = Feed.app(appId);
  const latest = Feed.notifications.filter((n) => n.app === appId).slice(0, 2);
  const head = h("div", { class: "who" },
    logoElement(app?.pill ?? `app_${appId}`, app?.name ?? appId, 14),
    h("span", { class: "name", text: app?.name ?? appId }),
    h("span", { class: "tool", text: t("App") }),
  );
  const status = h("div", { class: "sub app-status", text: app?.problem ?? app?.status ?? t("Connected") });
  const rows = latest.map((n) => {
    const row = h("div", { class: n.read ? "app-note" : "app-note unread" },
      h("span", { class: "app-note-title", text: n.title }),
      h("span", { class: "app-note-time", text: ago(n.time) }),
    );
    if (!n.acted && n.actions[0]) {
      const a = n.actions[0];
      const b = h("button", { class: "btn primary small", text: a.label });
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        actions.blip();
        void AppsBridge.act(n.id, a.id).catch((err) => {
          Feed.error = String(err);
          State.notify();
        });
      });
      row.append(b);
    }
    return row;
  });
  const all = h("button", { class: "feed-link", text: latest.length ? "All notifications" : "No notifications yet" });
  all.addEventListener("click", () => {
    Feed.filter = appId;
    actions.setView("notifications");
  });
  return h("div", { class: "card-body app-card" }, head, status, ...rows, all);
}

// ── Overview ──────────────────────────────────────────────────────────────────

function buildOverview(actions: ViewActions): ViewHost {
  /** The diff open in the left card (a FileDiff id), as activeDiffId on macOS. */
  let activeDiffId: number | null = null;
  const closeDiff = () => {
    if (activeDiffId == null) return;
    activeDiffId = null;
    State.notify();
  };
  const ticker = new Ticker((diffId) => {
    actions.blip();
    activeDiffId = diffId;
    State.notify();
  });
  const who = h("div", { class: "who" });
  const tickerBody = h("div", { class: "card-body" }, who, ticker.el);
  const leftBody = h("div", { class: "left-body" });
  const jump = h(
    "button",
    { class: "icon-btn jump", title: tl("Open"), onclick: () => actions.openTarget() },
    svg(ICONS.arrowUpRight, 8),
  );
  const left = card(null, leftBody, jump);
  // winotch: a click on an app's card expands it (the "app" view), except on
  // what already does something of its own (its buttons, links, rows, sliders).
  left.addEventListener("click", (e) => {
    const task = State.focusTask;
    if (!task || !canExpand(task.id)) return;
    if ((e.target as HTMLElement).closest("button, a, input, select, textarea, .gh-row, .gh-stat, .app-note, .np-art, .np-controls, .np-progress, .np-volume, .np-track")) return;
    actions.blip();
    State.detailApp = task.id;
    actions.setView("app");
  });
  // Every pill but the focused one, two by row, four to a page like a phone's
  // home screen: past four, the pages slide sideways (dots, wheel, swipe or a
  // drag) and dots show at the bottom. The island keeps its size.
  const pager = new PillPager();
  const right = card(null, pager.el);
  // Opened from a plan pill in the header: stands in for the left card.
  const plan = new PlanCard();
  let planTimer: number | null = null;
  // Spotify's card and pill are kept and updated in place: the progress bar
  // runs on, and a slider being dragged must not be rebuilt under the pointer.
  const spotifyCard = buildSpotifyCard();
  let spotifyPill: SpotifyPillHost | null = null;

  const el = h("div", { class: "view overview" },
    h("div", { class: "left" }, left),
    h("div", { class: "right" }, right),
  );

  let pillIds = "";
  let detailOpen = false;
  let lastFocus: string | null = null;
  /** The focus the pill pages last followed. */
  let pagedFocus: string | null | undefined;
  let mode: "ticker" | "card" | "plan" | "diff" | "spotify" | null = null;
  let cardKey = "";
  /** The list row highlighted at the last sync, to scroll only when it moves. */
  let shownSelection: number | null = null;

  // Leaving the overview or folding the island closes the diff, as on macOS.
  State.subscribe(() => {
    if (activeDiffId != null && (State.view !== "overview" || State.mode !== "expanded")) {
      activeDiffId = null;
    }
  });
  // Escape steps back out of the diff before it closes the island.
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || activeDiffId == null || State.view !== "overview") return;
      e.stopImmediatePropagation();
      closeDiff();
    },
    true,
  );

  const hooks: IntegrationCardHooks = {
    get detailOpen() {
      return detailOpen;
    },
    openDetail() {
      detailOpen = true;
      cardKey = "";
      State.notify();
    },
    closeDetail() {
      detailOpen = false;
      cardKey = "";
      State.notify();
    },
    openSettings: () => actions.openSettingsWindow(),
  };

  /** The countdowns move every 30 s while a card is open, and only then. */
  function syncPlanTimer(open: boolean) {
    const stop = () => {
      if (planTimer != null) window.clearInterval(planTimer);
      planTimer = null;
    };
    if (!open) return stop();
    if (planTimer != null) return;
    planTimer = window.setInterval(() => {
      if (planCardOpen() && State.mode === "expanded") State.notify();
      else stop();
    }, 30_000);
  }

  return {
    el,
    tick(nowMs: number) {
      if (mode !== "ticker") return false;
      ticker.tick(nowMs);
      return ticker.animating;
    },
    command(command) {
      if (command === "openSelection") {
        // Ctrl+O: what a click on the highlighted row does.
        if (mode !== "card" || State.cardSelection == null) return;
        openRow(listRows(leftBody)[State.cardSelection]);
        return;
      }
      // Ctrl+E (⌘E, islandToggleDiff): closes the diff that is open, else
      // opens the focused pill's latest edit.
      if (activeDiffId != null) {
        closeDiff();
        return;
      }
      const task = State.focusTask;
      const diffs = task ? State.sessionDiffs.get(task.id) : undefined;
      const last = diffs?.[diffs.length - 1];
      if (last?.id == null) return;
      activeDiffId = last.id;
      State.notify();
    },
    sync() {
      const task = State.focusTask;
      if (task?.id !== lastFocus) {
        lastFocus = task?.id ?? null;
        detailOpen = false;
        activeDiffId = null;
        cardKey = "";
        mode = null;
      }

      // A workspace or agent pill with a live session keeps the ticker; every
      // other pill shows its own card, exactly like IntegrationCardView.
      const sessionActive = task != null && hasSessionTicker(task);

      const planOpen = planCardOpen();
      if (mode === "plan" && !planOpen) {
        mode = null;
        cardKey = "";
      }
      syncPlanTimer(planOpen);

      // A diff that has since been dropped (cap, expiry, session end) just closes.
      const diff = task && activeDiffId != null ? State.findDiff(task.id, activeDiffId) : null;
      if (!diff) activeDiffId = null;

      if (planOpen) {
        if (mode !== "plan") {
          clear(leftBody);
          leftBody.append(plan.el);
          mode = "plan";
        }
        plan.sync();
      } else if (task && diff) {
        const key = `diff~${task.id}~${diff.id}`;
        if (key !== cardKey) {
          cardKey = key;
          mode = "diff";
          clear(leftBody);
          leftBody.append(buildDiffCard(diff, {
            dismiss: () => {
              actions.blip();
              closeDiff();
            },
            open: (path) => void Bridge.openFileInVSCode(path),
          }));
        }
      } else if (task && sessionActive) {
        if (mode !== "ticker") {
          clear(leftBody);
          leftBody.append(tickerBody);
          mode = "ticker";
          cardKey = "";
        }
        clear(who);
        // The agent's name is already the pill's: the label says what kind of
        // pill it is, as on the Mac (PillDefinition.sessionSubtitle).
        who.append(
          dot(task.color, 7),
          h("span", { class: "name", text: task.name }),
          h("span", { class: "tool", text: t(sessionSubtitle(task.id)) }),
        );
        if (task.steps.length > 1) {
          who.append(h("span", {
            class: "count",
            text: `${Math.min(task.stepIndex + 1, task.steps.length)}/${task.steps.length}`,
          }));
        }
        ticker.sync(task);
      } else if (task && task.id === SPOTIFY_ID) {
        // Its own card for every state: playing, idle, not installed.
        if (mode !== "spotify") {
          clear(leftBody);
          leftBody.append(spotifyCard.el);
          mode = "spotify";
          cardKey = "";
        }
        spotifyCard.sync();
      } else if (task && task.app === "today") {
        // Today: the day's to-dos, ticked off right on the card (views/today.ts).
        const key = JSON.stringify(["today", Today.version, language(), Math.floor(Date.now() / 60000)]);
        if (key !== cardKey) {
          cardKey = key;
          mode = "card";
          clear(leftBody);
          leftBody.append(buildTodayCard(() => actions.blip()));
        }
      } else if (task && task.app && !CARDS.has(task.app)) {
        // An app without a card of its own: what its pill says, and its latest news.
        const appId = task.app;
        const key = JSON.stringify(["app", appId, Feed.app(appId),
          Feed.notifications.filter((n) => n.app === appId).slice(0, 2), Math.floor(Date.now() / 60000)]);
        if (key !== cardKey) {
          cardKey = key;
          mode = "card";
          clear(leftBody);
          leftBody.append(appCard(appId, actions));
        }
      } else if (task) {
        const info = State.integrations[task.app ?? task.id];
        const key = [
          language(), task.id, task.color, detailOpen, task.state, task.steps.join("|"),
          info?.loaded, info?.error, info?.configured,
          JSON.stringify(info?.data ?? {}),
        ].join("~");
        if (key !== cardKey) {
          cardKey = key;
          mode = "card";
          clear(leftBody);
          leftBody.append(renderIntegrationCard(task, hooks));
        }
      }

      jump.style.display = detailOpen || mode === "plan" || mode === "diff" ? "none" : "";
      left.classList.toggle("expandable", !!task && canExpand(task.id) && mode !== "plan" && mode !== "diff");

      // Ctrl+↓ Ctrl+↑ walk the open GitHub list (cardItemCount / cardSelection).
      const rows = mode === "card" ? listRows(leftBody) : [];
      State.cardItemCount = rows.length;
      if (State.cardSelection != null && State.cardSelection >= rows.length) State.cardSelection = null;
      highlightRow(rows, State.cardSelection, State.cardSelection !== shownSelection);
      shownSelection = State.cardSelection;

      const others = State.otherTasks;
      const pillKey = others.map((t) => `${t.id}:${t.color}:${t.pillBadge ?? ""}`).join("|");
      if (pillKey !== pillIds) {
        pillIds = pillKey;
        // Rebuilt on the page it showed (the last one if there are fewer now).
        spotifyPill = null;
        pager.set(others.map((t) => {
          if (t.id !== SPOTIFY_ID) return buildPill(t, actions);
          spotifyPill = buildSpotifyPill(t, () => actions.setFocus(t.id));
          return spotifyPill.el;
        }));
        pruneAppLogos();
      }
      // Focus moved (a shortcut, a notification): to the page where it stood.
      if (State.focusId !== pagedFocus) {
        pagedFocus = State.focusId;
        pager.follow(State.tasks.findIndex((t) => t.id === State.focusId));
      }
      spotifyPill?.sync();
    },
  };
}

/**
 * IntegrationCardView.agentSessionActive: a workspace tool or an agent — or
 * any other tagged agent — with something going on.
 */
export function hasSessionTicker(task: AgentTask): boolean {
  // A pill made for an agent's session (Gemini CLI, Codex… not declared) only
  // exists while that session does: it keeps the ticker from the first event.
  if (task.source === "agent" && !task.isIntegration) return true;
  const category = pillDefinition(task.id)?.category;
  const isSession = category === "workspace" || (category == null && task.id.startsWith("agent_"));
  return isSession && (task.state !== "idle" || task.steps.length > 0);
}

function buildPill(task: AgentTask, actions: ViewActions): HTMLElement {
  const label = task.id === "integration_claude" ? pillDefinition(task.id)!.name : task.name;
  const logo = createAppLogo(task, 24);
  const pill = h(
    "div",
    { class: "pill", onclick: () => actions.setFocus(task.id) },
    logo,
    h("span", { class: "lbl", text: label }),
  );
  pill.style.borderColor = `${task.color}24`;
  pill.addEventListener("mouseenter", () => {
    pill.style.background = `${task.color}2e`;
    pill.style.borderColor = `${task.color}8c`;
    pill.style.boxShadow = `0 2px 10px ${task.color}59`;
    (pill.querySelector(".lbl") as HTMLElement).style.color = lighten(task.color, 0.3);
  });
  pill.addEventListener("mouseleave", () => {
    pill.style.background = "";
    pill.style.borderColor = `${task.color}24`;
    pill.style.boxShadow = "";
    (pill.querySelector(".lbl") as HTMLElement).style.color = "";
  });

  if (task.pillBadge) {
    const colors = { approval: "#ECECEC", finished: "#ECECEC", error: "#ECECEC" } as const;
    const icons = { approval: ICONS.bang, finished: ICONS.check, error: ICONS.xmark } as const;
    const inner = h("i", { style: `background:${colors[task.pillBadge]}` }, svg(icons[task.pillBadge], 6, { stroke: task.pillBadge === "finished" ? 3 : 0 }));
    const badge = h("div", { class: "pill-badge" }, inner);
    badge.style.boxShadow = `0 0 4px ${colors[task.pillBadge]}99`;
    pill.append(badge);
  }
  return pill;
}

function lighten(hex: string, amount: number): string {
  const v = parseInt(hex.replace("#", ""), 16);
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) =>
    Math.min(255, Math.round(x + amount * 255)),
  );
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ── Empty ─────────────────────────────────────────────────────────────────────

function buildEmpty(actions: ViewActions): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px;flex-direction:row;align-items:center;gap:16px" },
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:5px" },
      h("div", { class: "title", text: tl("Nothing running right now.") }),
      h("div", { class: "sub", text: tl("Drop a file or window, or ask me anything.") }),
    ),
    h("div", { class: "grow" }),
    btn(tl("Ask Claude"), "primary", () => actions.setView("prompt")),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Approval ──────────────────────────────────────────────────────────────────

/** How long a fresh permission card ignores clicks on its buttons. */
const CLICK_GUARD_MS = 600;

/**
 * The ⌃ in the corner of a waiting card: folds the island to its compact size
 * and leaves the request waiting — nothing is answered (Mac #290). Opening the
 * island again brings the card back.
 */
function foldButton(actions: ViewActions): HTMLElement {
  return h(
    "button",
    { class: "icon-btn fold", title: tl("Later — keep it waiting"), onclick: () => actions.foldApproval() },
    svg(ICONS.chevronUp, 8, { stroke: 2.4 }),
  );
}

function buildApproval(actions: ViewActions): ViewHost {
  const who = h("div");
  const code = h("div", { class: "code" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" },
    // winotch: Claude Code's cards on the card's plain ground, no wash (the user's call).
    card(null, stack(116, 16, who, code, row), foldButton(actions)));
  let rowKey = "";
  // The card pops up under a cursor that was busy with something else: a click
  // meant for the window underneath must not land on Allow. Clicks in the first
  // moments after a new request appears are ignored.
  let shownFor: string | null = null;
  let shownAt = 0;
  const guarded = (d: "allow" | "deny") => () => {
    if (performance.now() - shownAt < CLICK_GUARD_MS) return;
    actions.decide(d);
  };
  return {
    el,
    sync() {
      const req = State.pendingApproval?.requestId ?? null;
      if (req !== shownFor) {
        shownFor = req;
        shownAt = performance.now();
      }
      clear(who);
      who.append(agentWho(State.focusTask, t("needs permission")));
      // The whole point of approving here rather than in the terminal: this line
      // is the command, the file path or the URL being authorised, not just the
      // name of the tool asking.
      code.textContent = State.pendingApproval?.command || State.pendingApproval?.tool || "…";
      // Two buttons, built once. Rebuilding them between a mouse-down and a
      // mouse-up would swallow the click, and there is nothing left to vary:
      // "Always" is gone until the remembered-rules list exists to back it.
      if (rowKey === "built") return;
      rowKey = "built";
      clear(row);
      row.append(
        btn(tl("Deny"), "secondary", guarded("deny"), "N"),
        btn(tl("Allow"), "primary", guarded("allow"), "Y"),
      );
    },
  };
}

// ── Question ──────────────────────────────────────────────────────────────────

function buildQuestion(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title question-text" });
  const row = h("div", { class: "actions options" });
  const fold = foldButton(actions);
  const el = h("div", { class: "view" }, card(null, stack(116, 16, who, title, row), fold));

  // Where we are in the request on screen: which question, what is answered so
  // far, and what is ticked in a pick-several question.
  let requestId = "";
  let index = 0;
  let answers: Record<string, string | string[]> = {};
  let picked = new Set<string>();
  // The buttons are only rebuilt when what they show changes: rebuilding them
  // between a mouse-down and a mouse-up would swallow the click.
  let rowKey = "";

  const next = (question: string, answer: string | string[], total: number) => {
    answers[question] = answer;
    picked = new Set();
    index += 1;
    if (index >= total) actions.answer(answers);
    else State.notify();
  };

  return {
    el,
    sync() {
      const questions = State.pendingApproval?.questions;
      clear(who);
      // Only a request that is waiting can be folded away and come back.
      fold.style.display = State.pendingApproval ? "" : "none";

      // A question that arrived as a notification has nothing to pick from.
      if (!questions) {
        who.append(agentWho(State.focusTask, t("is asking a question")));
        const task = State.focusTask;
        title.textContent = (task && lastTextStep(task.steps)) ?? t("Claude needs an answer.");
        if (rowKey !== "terminal") {
          rowKey = "terminal";
          clear(row);
          row.append(h("div", { class: "sub", text: tl("Answer it in your terminal.") }));
        }
        return;
      }

      if (State.pendingApproval!.requestId !== requestId) {
        requestId = State.pendingApproval!.requestId;
        index = 0;
        answers = {};
        picked = new Set();
      }
      const q = questions[Math.min(index, questions.length - 1)];
      const asking = questions.length > 1
        ? t("is asking ({index} of {total})", { index: index + 1, total: questions.length })
        : t("is asking");
      who.append(agentWho(State.focusTask, asking));
      title.textContent = q.question;
      title.title = q.question;

      const key = `${requestId}:${index}:${[...picked].join("|")}`;
      if (rowKey === key) return;
      rowKey = key;
      clear(row);
      for (const option of q.options) {
        const on = picked.has(option.label);
        const button = btn(option.label, on ? "primary" : "secondary", () => {
          if (!q.multiSelect) {
            next(q.question, option.label, questions.length);
            return;
          }
          if (on) picked.delete(option.label);
          else picked.add(option.label);
          State.notify();
        });
        if (option.description) button.title = option.description;
        row.append(button);
      }
      if (q.multiSelect) {
        const done = btn(tl("Done"), "primary", () => {
          if (picked.size > 0) next(q.question, [...picked], questions.length);
        });
        if (picked.size === 0) done.classList.add("off");
        row.append(done);
      }
      row.append(
        h("button", {
          class: "link-btn",
          style: "color:#8e939c",
          text: tl("Answer in terminal"),
          onclick: () => actions.answerInTerminal(),
        }),
      );
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

function buildError(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const detail = h("div", { class: "detail" });
  const row = h("div", { class: "actions" },
    btn(tl("Retry"), "primary", () => actions.setView(State.defaultView())),
  );
  const el = h("div", { class: "view" }, card(null, stack(116, 16, who, title, detail, row)));
  return {
    el,
    sync() {
      const task = State.focusTask;
      clear(who);
      // agentWho already shows an agent's name: its label is just the kind.
      const whoLabel = task?.source === "agent" ? t("Agent") : "Claude Code";
      who.append(agentWho(task, whoLabel));
      title.textContent = t("Session stopped on an error.");
      detail.textContent = (task && lastTextStep(task.steps)) ?? t("No detail available.");
    },
  };
}

// ── Finished ──────────────────────────────────────────────────────────────────

function buildFinished(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title one-line" });
  // "Open chat": the chat, on the session that finished. Claude Code's sessions
  // share one pill, so the session is the finished turn's, not the pill's.
  const open = btn(tl("Open chat"), "primary", () => {
    const task = State.focusTask;
    if (task?.id === "agent_claude-desktop") actions.openTerminal();
    else openChatOn(State.finishedTurnOf(task)?.sessionId, actions.setView);
  });
  const row = h("div", { class: "actions" },
    open,
    btn(tl("OK"), "secondary", () => actions.collapse()),
  );
  const el = h("div", { class: "view" }, card(null, stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      const task = State.focusTask;
      const turn = State.finishedTurnOf(task);
      const agent = task?.source === "agent";
      who.append(agentWho(task, agent ? t("finished") : t("Claude Code finished"), turn?.name));
      // The final message, else the last step that is not a diff (FinishedView),
      // as long as the pill's steps are still that session's.
      const ownSteps = task && (task.sessionId ?? null) === (turn?.sessionId ?? null);
      title.textContent = turn?.finalLine || (ownSteps && lastTextStep(task.steps)) || t("Session finished");
      // Sessions from the Claude desktop app live there, not in a terminal.
      const label = task?.id === "agent_claude-desktop" ? t("Open Claude") : t("Open chat");
      const span = open.firstElementChild as HTMLElement;
      if (span.textContent !== label) span.textContent = label;
    },
  };
}

// ── Confused ──────────────────────────────────────────────────────────────────

function buildConfused(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 128px" },
    h("div", { class: "title", text: tl("Too many hits at once.") }),
    h("div", { class: "sub", text: tl("Give me a sec. Back to work in three seconds.") }),
  );
  // winotch: no wash here either, as on every card now.
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Note ──────────────────────────────────────────────────────────────────────

function buildNote(): ViewHost {
  const title = h("div", { class: "title" });
  const el = h("div", { class: "view" }, card(null, h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title)));
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
    },
  };
}

// ── Placeholders filled in later stages ───────────────────────────────────────

function buildPlaceholder(title: Msg, sub: string): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px" },
    h("div", { class: "title", text: title }),
    h("div", { class: "sub", text: sub }),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildViews(
  actions: ViewActions,
  onChatHeightChange: () => void,
  say: (line: SayLine | null) => void,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildOverview(actions));
  map.set("empty", buildEmpty(actions));
  map.set("approval", buildApproval(actions));
  map.set("question", buildQuestion(actions));
  map.set("error", buildError(actions));
  map.set("finished", buildFinished(actions));
  map.set("confused", buildConfused());
  map.set("note", buildNote());
  map.set("prompt", buildPrompt(onChatHeightChange, say));
  map.set("say", buildSay(actions, onChatHeightChange));
  map.set("upload", buildUpload());
  map.set("uploading", buildUploading());
  map.set("choose", buildChoose(actions));
  map.set("recap", buildRecap(actions));
  // A click on a notification about an item opens its app expanded there.
  const appView = buildAppDetail(actions);
  map.set("notifications", buildNotifications(actions, appView));
  map.set("app", appView);
  map.set("settings", buildSettingsView(actions, () => State.appVersion));
  // Not in the Windows v1: sending a file by email, window attach + web result.
  map.set("mail", buildPlaceholder(tl("Sending by email isn't in this version."), ""));
  map.set("searching", buildPlaceholder(tl("Claude is searching…"), ""));
  map.set("result", buildPlaceholder(tl("Result"), ""));
  return map;
}
