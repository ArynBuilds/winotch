// App state — mirror of AppState.swift (the parts the island needs).

import type { BotEmoteName, BotStateName, IslandMode, IslandViewName } from "./layout";
import { HOST_OS, MAIN_PILL, pillDefinition, registryPills, type HostOs, type PillDefinition } from "./pills";
import type { PlanUsage } from "./plan";
import type { FileDiff } from "./diff";
import type { Bindings } from "./shortcuts";
import { INK } from "./brand";
import { Spotify, musicPlaying } from "./spotify";
import { Feed, type AppInfo } from "./apps";

export type AgentSource = "claudeCode" | "n8n" | "agent";
export type PillBadge = "approval" | "finished" | "error";

export interface AgentTask {
  id: string;
  name: string;
  color: string;
  state: BotStateName;
  stepIndex: number;
  steps: string[];
  /**
   * Position of the newest step in the whole session. `steps` is capped, so
   * `stepIndex` stops moving once it is full; this keeps counting.
   */
  stepSeq?: number;
  source: AgentSource;
  isIntegration: boolean;
  emote?: BotEmoteName | null;
  pillBadge?: PillBadge | null;
  sessionCwd?: string | null;
  /** Claude Code's session, so "Open terminal" can find the window it runs in. */
  sessionId?: string | null;
  /** Claude's final message after Stop, one line; cleared when a new turn starts. */
  finalLine?: string | null;
  /** The registry app this pill is (core/apps.ts); absent on Claude Code's and the agents'. */
  app?: string;
}

/**
 * A turn that finished, as its own Stop payload described it. Every Claude Code
 * session shares one pill, which holds whichever session spoke last; the
 * finished card and its "Open chat" read this instead, so a busy session's next
 * tool call cannot relabel another session's finish.
 */
export interface FinishedTurn {
  sessionId: string | null;
  /** Its project (the payload's own cwd), or the agent's name. */
  name: string;
  cwd: string | null;
  finalLine: string | null;
}

export interface ApprovalInfo {
  requestId: string;
  sessionId: string;
  /** The pill the request belongs to: VS Code's or Cursor's (Claude Code), or an agent's (Codex…). */
  pillId: string;
  tool: string;
  command: string;
  /** Set when Claude Code is asking a question rather than for a permission. */
  questions?: AskedQuestion[];
}

/** One question of an AskUserQuestion call. */
export interface AskedQuestion {
  question: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
}

export type PromptContext =
  | { kind: "window"; appName: string; title: string; url?: string }
  | { kind: "file"; name: string; path?: string };

export interface ResultItem {
  label: string;
  detail: string;
  url?: string;
}

export interface SearchResult {
  title: string;
  items: ResultItem[];
  note?: string;
}

/** A fresh, idle task for a catalog pill. Every pill wears the brand's one colour. */
function taskFor(def: PillDefinition, name = def.name): AgentTask {
  return {
    id: def.id, name, color: INK, state: "idle", stepIndex: 0, steps: [],
    source: def.source, isIntegration: true,
  };
}

/** A fresh, idle pill for an app of the registry. */
function appTask(id: string, name: string): AgentTask {
  return { id, name, color: INK, state: "idle", stepIndex: 0, steps: [], source: "n8n", isIntegration: true };
}

/**
 * What a built-in's poller last reported (the `integration` event), by its
 * registry id ("github"); Claude Code's hooks under its pill id. The rich
 * cards (GitHub, Stripe, Notion) present this data.
 */
export interface IntegrationInfo {
  data: Record<string, unknown>;
  error: string | null;
  loaded: boolean;
  configured: boolean;
}

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  /** Hovering the island opens it all the way (off: hovering only peeks). */
  openOnHover: boolean;
  /** "primary", "cursor", or `at:<x>,<y>` for one display (logical origin). */
  screen: string;
  autostart: boolean;
  hooksInstalled: boolean;
  /** Claude model of the calls made on the user's key (call notes, « OK Tent »). */
  model: string;
  /** Show the Claude plan pill (5 h and weekly limits) in the island's header. */
  showPlanInNotch: boolean;
  /** winotch's status line relay is installed in Claude Code's settings. */
  planRelayInstalled: boolean;
  /**
   * The Claude Code session the chat talks to: a session id, or "new:<folder>"
   * to start one there, or "quick" for a quick question that is not saved
   * (see core/claude-sessions.ts). "" until one is picked.
   */
  chatSession: string;
  /** The chat's Claude Code model alias ("opus", "sonnet", "fable"); "" = Claude Code's default. */
  chatModel: string;
  /** The chat's effort level ("low" … "max"); "" = Claude Code's default. */
  chatEffort: string;
  /** winotch: what the console shows of a conversation: its latest exchange, or all of it. */
  chatHistory: "recent" | "all";
  /** winotch: how fast an answer asked for by voice is read along, in words a minute (views/say.ts PACES). */
  sayPace: number;
  /** Global shortcuts the user changed, by action id (see core/shortcuts.ts). */
  shortcuts: Bindings;
  /**
   * Interface language: "" follows the system (when winotch has its language,
   * else English), or one of src/i18n's ten codes ("fr", "pt-BR", "zh-Hans"…).
   */
  language: string;
  /**
   * The Gmail accounts (src-tauri/src/mail). Changed only through core/mail.ts:
   * Rust keeps its own list when a page saves the settings.
   */
  gmailAccounts: GmailAccount[];
  /**
   * How winotch signs in to GitHub: "cli" (the GitHub CLI's login), "token"
   * (the one saved in Settings), or "" (never chosen: the CLI when it is
   * signed in, else the token). See src-tauri/src/github_auth.rs.
   */
  githubAuth: "" | "cli" | "token";
  /** Get started has been shown (once, at the first start). */
  welcomed: boolean;
}

/** A Gmail account as settings.json keeps it; its app password is in the credential store. */
export interface GmailAccount {
  /** Lower case. */
  email: string;
  /** What the island calls it ("Work"); null shows the address. */
  label: string | null;
  /** Its new mail may peek the island; off, it waits behind the bell. */
  opensIsland: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 3,
  openOnHover: false,
  screen: "primary",
  autostart: false,
  hooksInstalled: false,
  model: "claude-opus-5",
  showPlanInNotch: false,
  planRelayInstalled: false,
  chatSession: "",
  chatModel: "",
  chatEffort: "",
  chatHistory: "recent",
  sayPace: 300,
  shortcuts: {},
  language: "",
  gmailAccounts: [],
  githubAuth: "",
  welcomed: false,
};

type Listener = () => void;

/** Live diffs kept per pill (oldest dropped first) — same cap as macOS. */
export const MAX_DIFFS_PER_PILL = 50;
/** A pill's diffs are forgotten after an hour without a new one, as on macOS. */
export const DIFF_TTL_MS = 3_600_000;

class AppState {
  mode: IslandMode = "hidden";
  view: IslandViewName = "overview";
  /** winotch's version, as boot reported it (the settings' sidebar shows it). */
  appVersion = "";
  /** winotch: the app shown expanded in the "app" view (its task id). */
  detailApp: string | null = null;
  /**
   * winotch: a text field of the expanded app has the keyboard (Today's quick
   * add, a note being written): the island holds open, as for the chat.
   */
  typing = false;

  tasks: AgentTask[] = [];
  focusId: string | null = null;

  stateOverride: BotStateName | null = null;

  /** Cursor in logical screen pixels, origin top-left (like AppState.mousePosition). */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;
  paused = false;

  uploadProgress = 0;
  uploadDuration = 2.4;
  fileDragOver = false;

  promptContext: PromptContext | null = null;
  droppedFile: { name: string; path: string } | null = null;
  noteMessage: string | null = null;
  searchResult: SearchResult | null = null;
  pendingApproval: ApprovalInfo | null = null;
  /** The pill that was in front when the card came up; it comes back after. */
  focusBeforeApproval: string | null = null;

  integrations: Record<string, IntegrationInfo> = {};

  /** Claude's 5 h / weekly limits, from the status line (null until the first call). */
  planUsage: PlanUsage | null = null;
  /** The plan card is open in place of the overview's left card. */
  showingPlanDetail = false;
  /** Per-pill file diffs, in order of reception. Steps carry their ids. */
  sessionDiffs = new Map<string, FileDiff[]>();
  private sessionDiffTimers = new Map<string, number>();
  /** Never reset, so an id can never point at a newer diff than the one tapped. */
  private nextDiffId = 0;
  /** Ctrl+↑ / Ctrl+↓: the highlighted row of the card's list (AppState.cardSelection). */
  cardSelection: number | null = null;
  /** Rows in the list on screen, 0 when there is none (AppState.cardItemCount). */
  cardItemCount = 0;
  lastActivity = performance.now();

  settings: Settings = { ...DEFAULT_SETTINGS };

  /** Which pills this build offers depends on it (Claude Desktop is Windows only). */
  os: HostOs = HOST_OS;

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Marks the UI dirty; the island re-renders on the next frame. */
  notify() {
    for (const fn of this.listeners) fn();
  }

  get focusTask(): AgentTask | null {
    return this.tasks.find((t) => t.id === this.focusId) ?? this.tasks[0] ?? null;
  }

  get effectiveState(): BotStateName {
    return this.stateOverride ?? this.focusTask?.state ?? "idle";
  }

  /** Spotify plays on a declared pill: the mark dances (Linux; never on Windows yet). */
  get spotifyPlaying(): boolean {
    return musicPlaying(Spotify.state, this.appPills());
  }

  /** The pill ids the registry's apps have on the island now (core/pills.ts registryPills). */
  appPills(): string[] {
    return registryPills(Feed.apps).map((p) => p.id);
  }

  /** The registry app behind a pill, if the pill is an app's. */
  appOf(pillId: string): AppInfo | undefined {
    return Feed.byPill(pillId);
  }

  get otherTasks(): AgentTask[] {
    return this.tasks.filter((t) => t.id !== this.focusId);
  }

  setFocus(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    this.focusId = id;
    this.showingPlanDetail = false;
    t.pillBadge = null;
    this.notify();
  }

  /**
   * A permission card or a question comes up: its pill comes to the front, and
   * the pill that was there is remembered (HookServer.focusBeforeApproval).
   */
  beginApproval(info: ApprovalInfo) {
    this.pendingApproval = info;
    this.isPinned = true;
    if (this.focusBeforeApproval == null) this.focusBeforeApproval = this.focusId;
    this.setFocus(info.pillId);
  }

  /**
   * The card has its answer, or is withdrawn: the session carries on, and the
   * pill you were on comes back — unless you moved to another one meanwhile.
   */
  endApproval() {
    const req = this.pendingApproval;
    if (!req) return;
    this.pendingApproval = null;
    this.isPinned = false;
    this.updateTask(req.pillId, "working");
    this.setPillBadge(req.pillId, null);
    const previous = this.focusBeforeApproval;
    this.focusBeforeApproval = null;
    if (previous && this.focusId === req.pillId && this.tasks.some((t) => t.id === previous)) {
      this.focusId = previous;
    }
    this.notify();
  }

  updateTask(id: string, state: BotStateName) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.state = state;
    this.notify();
  }

  appendStep(id: string, step: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    const newest = t.stepSeq ?? t.steps.length - 1;
    t.steps.push(step);
    if (t.steps.length > 20) t.steps.shift();
    t.stepIndex = t.steps.length - 1;
    t.stepSeq = newest + 1;
    this.notify();
  }

  setPillBadge(id: string, badge: PillBadge | null) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.pillBadge = badge;
    this.notify();
  }

  /** Stores a diff for a pill and returns its id (for the ticker step). */
  appendSessionDiff(pillId: string, diff: FileDiff): number {
    const id = this.nextDiffId++;
    const list = this.sessionDiffs.get(pillId) ?? [];
    list.push({ ...diff, id });
    while (list.length > MAX_DIFFS_PER_PILL) list.shift();
    this.sessionDiffs.set(pillId, list);
    // One timer per pill, re-armed on every diff — nothing polls.
    const prev = this.sessionDiffTimers.get(pillId);
    if (prev != null) window.clearTimeout(prev);
    this.sessionDiffTimers.set(
      pillId,
      window.setTimeout(() => this.clearSessionDiffs(pillId), DIFF_TTL_MS),
    );
    return id;
  }

  findDiff(pillId: string, id: number): FileDiff | null {
    return this.sessionDiffs.get(pillId)?.find((d) => d.id === id) ?? null;
  }

  clearSessionDiffs(pillId: string) {
    const timer = this.sessionDiffTimers.get(pillId);
    if (timer != null) window.clearTimeout(timer);
    this.sessionDiffTimers.delete(pillId);
    this.sessionDiffs.delete(pillId);
  }

  /** Claude Code, always: kept as a getter for the places that ask. */
  get mainPillId(): string {
    return MAIN_PILL;
  }

  /**
   * True for a pill that stays when its session ends: the main pill and the
   * pills of the registry's shown apps go back to idle instead of going away.
   */
  isKept(id: string): boolean {
    return id === MAIN_PILL || this.appPills().includes(id);
  }

  /**
   * False for an app the user keeps from opening or peeking the island
   * (Settings → Apps, the registry's `opensIsland`). apps.rs also holds back
   * such an app's notifications before they reach the island.
   */
  opensIsland(pillId: string): boolean {
    return this.appOf(pillId)?.opensIsland ?? true;
  }

  /**
   * The pills, from the registry (Feed.apps) and nothing else: Claude Code
   * first, always; then the agents' session pills; then one pill per app
   * `registryPills` gives, in its order. A pill whose app went away (hidden,
   * removed, not available) leaves, unless it is mid-session: it stays until
   * that ends. Safe to call any number of times; called on every snapshot.
   */
  syncPills() {
    const wanted = registryPills(Feed.apps);
    const ids = new Set(wanted.map((p) => p.id));
    const busy = (t: AgentTask) => t.state !== "idle" || t.steps.length > 0;
    const key = () => [this.focusId, ...this.tasks.map((t) => `${t.id}:${t.name}`)].join("|");
    const before = key();

    const main = this.tasks.find((t) => t.id === MAIN_PILL) ?? taskFor(pillDefinition(MAIN_PILL)!);
    const agents = this.tasks.filter((t) => t.id !== MAIN_PILL && t.app == null);
    const apps = wanted.map((p) => {
      const task = this.tasks.find((t) => t.id === p.id) ?? appTask(p.id, p.name);
      task.app = p.app;
      // An API app may rename itself; a built-in's pill may wear what it plays (Spotify).
      if (this.appOf(p.id)?.kind === "api") task.name = p.name;
      return task;
    });
    // Gone from the registry's pills but mid-session: kept, after the rest.
    const leaving = this.tasks.filter((t) => t.app != null && !ids.has(t.id) && busy(t));
    this.tasks = [main, ...agents, ...apps, ...leaving];
    for (const t of this.tasks) t.color = INK;
    if (!this.focusId || !this.tasks.some((t) => t.id === this.focusId)) this.focusId = MAIN_PILL;
    if (key() !== before) this.notify();
  }

  /**
   * A session is over. The main and declared pills are put back as they were;
   * any other pill goes away (AppState.removeTask on macOS).
   */
  removeTask(id: string) {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx < 0) return;
    if (this.isKept(id)) {
      const t = this.tasks[idx];
      t.state = "idle";
      t.steps = [];
      t.stepIndex = 0;
      delete t.stepSeq;
      t.pillBadge = null;
      t.finalLine = null;
      this.finishedTurns.delete(id);
      const name = pillDefinition(id)?.name ?? this.appOf(id)?.name;
      if (name) t.name = name;
      this.clearSessionDiffs(id);
      this.notify();
      return;
    }
    this.tasks.splice(idx, 1);
    this.finishedTurns.delete(id);
    this.clearSessionDiffs(id);
    if (this.focusId === id) this.focusId = this.tasks[0]?.id ?? this.mainPillId;
    this.notify();
  }

  /**
   * Creates the pill of a tagged agent on its first event; no-op if it exists.
   * Inserted right after the main pill, where a live session is seen first.
   */
  upsertExternalAgent(id: string, name: string) {
    if (this.tasks.some((t) => t.id === id)) return;
    this.insertAfterMain({
      id, name, color: INK,
      state: "idle", stepIndex: 0, steps: [],
      source: "agent", isIntegration: false,
    });
  }

  /**
   * The pill a Claude Code session belongs to. It is made for the session when
   * it is not loaded yet, as upsertWorkspaceTask does on macOS.
   */
  upsertWorkspacePill(id: string, name: string, cwd: string): AgentTask | null {
    let t = this.tasks.find((x) => x.id === id);
    if (!t) {
      const def = pillDefinition(id);
      if (!def) return null;
      t = taskFor(def, name);
      this.insertAfterMain(t);
    }
    t.name = name;
    if (cwd) t.sessionCwd = cwd;
    return t;
  }

  /**
   * Claude Code sessions the hooks have seen lately, by id: when last. A session
   * is open from its first event until SessionEnd. The island's own headless
   * sends are left out (`headless`), so they never close a terminal's session.
   */
  openSessions = new Map<string, number>();
  /**
   * winotch: the sessions the island's chat is talking to (a quick question, a
   * send in the background). They are the chat's: their answer shows there, so
   * their hooks say nothing anywhere else (hooks.ts).
   */
  headless = new Set<string>();
  /** When each of them stops being the chat's (`releaseHeadless`). */
  private headlessUntil = new Map<string, number>();

  /** `id` is the chat's from now until it is released. */
  holdHeadless(id: string) {
    const timer = this.headlessUntil.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    this.headlessUntil.delete(id);
    this.headless.add(id);
  }

  /**
   * The chat's send is over. Its session stays the chat's a little longer: its
   * last hooks (the Stop) can land after the answer did.
   */
  releaseHeadless(id: string, afterMs = 15_000) {
    const timer = this.headlessUntil.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    this.headlessUntil.set(id, window.setTimeout(() => {
      this.headlessUntil.delete(id);
      this.headless.delete(id);
    }, afterMs));
  }

  /** The session is one the island's chat is talking to. */
  fromChat(id: string | null | undefined): boolean {
    return !!id && this.headless.has(id);
  }

  /**
   * winotch: the island is open on the chat. While it is, nothing else speaks
   * up (the user's call): no card takes the chat's place, no sound, no peek;
   * news waits behind the bell. Only a permission a session needs still asks,
   * and answering it comes back to the chat (`viewAfterCard`).
   */
  get chatting(): boolean {
    return this.mode === "expanded" && this.view === "prompt";
  }

  /**
   * winotch: an answer asked by voice is being said in the island
   * (views/say.ts), from the question until it has been read. Nothing cuts in
   * meanwhile (the user's call): Claude Code's cards and the apps' news wait in
   * line (`afterSay`) and come once it is over, and no sound plays over it.
   */
  saying = false;

  private sayQueue: (() => void)[] = [];

  /** Runs `then` once the answer being said is over, at once when none is. */
  afterSay(then: () => void) {
    if (this.saying) this.sayQueue.push(then);
    else then();
  }

  /** The answer is over: what waited for it, in the order it came, to run now. */
  endSay(): (() => void)[] {
    this.saying = false;
    const waiting = this.sayQueue;
    this.sayQueue = [];
    return waiting;
  }

  /** No sound now: over the chat, or over an answer being said. */
  get hushed(): boolean {
    return this.chatting || this.saying;
  }

  /**
   * winotch: how tall the chat wants the island: as tall as what it shows (the
   * field alone when empty, the answer as it comes), up to chat.ts READ_MAX;
   * null until it has measured, the usual height.
   */
  chatReadHeight: number | null = null;

  /**
   * winotch: the chat holds the island open: something typed and not sent,
   * or the chip's choices open. Otherwise it folds on leaving like any screen
   * (the user's call: closing it took the home button and a wait).
   */
  chatHolds = false;

  /** winotch: the chat sent something and its answer is not in yet: the island's mark crosses (island.ts). */
  chatAnswering = false;

  /** The chat, when a permission card came up over it: answering goes back there. */
  viewBeforeCard: IslandViewName | null = null;

  /** Where the island goes once a card has its answer, or is withdrawn. */
  viewAfterCard(): IslandViewName {
    const back = this.viewBeforeCard;
    this.viewBeforeCard = null;
    return back ?? this.defaultView();
  }

  noteSession(id: string, event: string) {
    if (!id || this.headless.has(id)) return;
    if (event === "SessionEnd") this.openSessions.delete(id);
    else this.openSessions.set(id, Date.now());
  }

  /** Open in a terminal: an event in the last few hours, and no SessionEnd since. */
  isOpenInTerminal(id: string): boolean {
    const last = this.openSessions.get(id);
    return last !== undefined && Date.now() - last < 6 * 3600_000;
  }

  /** The logo the compact notch shows for a moment instead of its bell (winotch). */
  flash: { id: string; name: string; at: number } | null = null;

  /** Something new from `id`: its logo stands in for the compact bell a moment. */
  flashLogo(id: string, name: string) {
    this.flash = { id, name, at: performance.now() };
    this.notify();
  }

  /** The last turn that finished on each pill, by pill id (see FinishedTurn). */
  finishedTurns = new Map<string, FinishedTurn>();

  /**
   * What the finished card shows for a pill: the turn that finished there, else
   * the pill itself (a pill no Stop has described).
   */
  finishedTurnOf(task: AgentTask | null): FinishedTurn | null {
    if (!task) return null;
    return this.finishedTurns.get(task.id) ?? {
      sessionId: task.sessionId ?? null,
      name: task.name,
      cwd: task.sessionCwd ?? null,
      finalLine: task.finalLine ?? null,
    };
  }

  private insertAfterMain(t: AgentTask) {
    const at = this.tasks.findIndex((x) => x.id === this.mainPillId) + 1;
    this.tasks.splice(at, 0, t);
    if (!this.focusId) this.focusId = t.id;
    this.notify();
  }

  /**
   * What the island opens on. A card waiting for an answer comes first, so
   * reopening a folded island shows it again (Mac #117, #290).
   */
  defaultView(): IslandViewName {
    if (this.pendingApproval) return this.pendingApproval.questions ? "question" : "approval";
    return this.tasks.length === 0 ? "empty" : "overview";
  }
}

export const State = new AppState();
