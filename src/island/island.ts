// The island: DOM shell, sizing animation, mark placement, mouse handling.
// Mirrors IslandRootView.swift + IslandWindowController.swift.

import { Tracked, Spring, clamp } from "../core/anim";
import { MOTION } from "../core/motion";
import { Bridge, IS_TAURI, onDragDrop } from "../core/bridge";
import {
  EXPANDED_CORNER, EXPANDED_W, NOTCH_W, PANEL_H, PANEL_W, WAKE_STRIP_H, WAKE_STRIP_W,
  ROUNDED_CORNER, botPosition, chatPromptHeight,
  islandSize,
  QUESTION_PICKER_H,
  type BotEmoteName, type IslandMode, type IslandViewName,
} from "../core/layout";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { SPOTIFY_ID, islandDances } from "../core/spotify";
import { MarkEngine, overFor } from "../mark/engine";
import type { SettingsHost } from "../views/settings";
import { MarkGreeting } from "../mark/greeting";
import { syncAppLogoStates, tickAppLogos } from "../views/app-logos";
import { Feed } from "../core/apps";
import { FlowBridge } from "../core/flow";
import { logoElement } from "../views/logo";
import { UploadCanvas } from "../upload/canvas";
import { USC, UploadSeq } from "../upload/sequence";
import { closePlanCard } from "../views/usage";
import { buildHeader, buildViews, type SayLine, type ViewActions, type ViewHost } from "../views/views";
import type { SayHost } from "../views/say";
import { openChatOn } from "../views/chat";
import { h, svg } from "../views/dom";
import { ICONS } from "../views/icons";
import { IslandStateMachine } from "./fsm";
import { FlowSlot } from "./flow-slot";
import { refreshHookPills } from "./integrations";
import type { ViewCommand } from "./shortcuts";
import { classify, moveScreens, placeScreens } from "./view-motion";

const BOT_OVERHANG = 40;
/** The concave curve where the island flows into the top edge, like a notch's. */
const EAR = 12;
/** The narrowest an answer said in the island makes it: never thinner than the compact notch. */
const SAY_MIN_W = 288;
const CLAUDE_DESKTOP_ID = "agent_claude-desktop";
/** Extra room on each side of the mark's surface. */
const BOT_SIDE = 24;
/** Same margin as the Rust hit test (src-tauri/src/island.rs). */
const HIT_MARGIN = 14;
/** How near the island (px) a pointer move still wakes the frame loop: hover effects live here. */
const NEAR = 160;
/** A loop that never ends by itself (the mark breathing) is drawn at 24 frames a second. */
const SLOW_FRAME_MS = 1000 / 24;

/** The three views the drop sequence owns; leaving them stops the engine. */
const UPLOAD_VIEWS: ReadonlySet<IslandViewName> = new Set(["upload", "uploading", "choose"]);

/** Seconds between the drop and the moment the progress bar starts filling. */
const PRE_PROGRESS = USC.T_PROG_START - USC.T_DROP;

/** How long the open island waits before folding: 3 to 10 s (winotch). */
const autoClose = () => Math.min(10, Math.max(3, State.settings.autoCloseInterval || 3));

/** The chat shows a Claude Code session, whose log starts out long: the chat opens at full height. */
const chatCount = () => 99;


export class Island {
  readonly fsm = new IslandStateMachine();

  private root: HTMLElement;
  private islandEl!: HTMLElement;
  private clipEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private viewsEl!: HTMLElement;
  private botCanvas!: SVGSVGElement;
  private botGlow!: HTMLElement;
  private greetingCanvas!: SVGSVGElement;
  /** The compact notch's right side: the bell and its count, or an app's logo a moment. */
  private compactBell!: HTMLElement;
  private bellCount!: HTMLElement;
  private bellFlash!: HTMLElement;
  /** The compact notch's middle: dictation's bars, a short line, a call's clock (flow-slot.ts). */
  private flowSlot = new FlowSlot();
  private shownFlash = 0;
  private flashTimer: number | null = null;
  private countdown!: HTMLElement;
  private wakeStrip!: HTMLElement;

  private header!: ViewHost;
  private views!: Map<IslandViewName, ViewHost>;
  private uploadCanvas!: UploadCanvas;

  private width = new Tracked(NOTCH_W);
  private height = new Tracked(0);
  private radius = new Tracked(ROUNDED_CORNER);
  // No overshoot (the brand never bounces), settling with the island's own
  // 340 ms close, so the mark travels into the notch as it shrinks.
  // The mark rides the island's own spring (core/motion.ts), so the two land together.
  private botCx = new Spring(46, MOTION.response, MOTION.damping);
  private botCy = new Spring(16, MOTION.response, MOTION.damping);
  private botSize = new Spring(10, MOTION.response, MOTION.damping);

  private engine = new MarkEngine();
  private greeting = new MarkGreeting();
  private greetingShown = false;
  /** A real pointer position has arrived since launch. */
  private pointerSeen = false;

  private running = false;
  private lastFrame = 0;
  /** The next frame of a slow loop (the mark only breathing), not yet asked of the screen. */
  private slowFrame: number | null = null;
  /** How smoothly each animation ran, in winotch.log (FrameMeter). */
  private meter = new FrameMeter();
  /** The view an alert opens the island on, while it opens (alert). */
  private openingView: IslandViewName | null = null;
  /** The launch's logo holds its shape until the island has settled (drawBot). */
  private holdLogo = false;
  private greetingLeftAt: number | null = null;
  /** The size last written to the DOM, as applyGeometry keys it. */
  private appliedGeometry = "";
  /** The ears' size and the content's size last written (applyGeometry, sizeContent). */
  private appliedEar = "";
  private contentSize = "";
  /** Where the dot was asked to go by the last pointer move that woke the loop. */
  private wokenOver = -1;
  private dirty = true;
  private canvasPx = 0;

  // Rust starts the window at full size so the launch greeting has room.
  private collapsed = false;
  private collapseTimer: number | null = null;
  private wasInIsland = false;
  /** Last shape handed to Rust for the click-through test. */
  private pushedRect = { x: -1, y: -1, w: -1, h: -1 };

  // Bot hover → love (IslandWindowController.botHoverIn)
  private botHovering = false;
  private botHoverTimer: number | null = null;
  private lastLoveTime = 0;
  private botHoverStart = { x: 0, y: 0 };

  private confusedRecovery: number | null = null;
  private prevViewBeforeConfused: IslandViewName = "overview";
  private lastSyncedView: IslandViewName | null = null;
  /** The screen last shown, and whether the content was showing (syncDom's motion). */
  private shownView: IslandViewName | null = null;
  private wasLive = false;

  /** The launch greeting ended, or the island came out of hidden — two of the
   *  moments the Monday recap may open (see src/recap/recap.ts). */
  onGreetingDone: (() => void) | null = null;
  onWake: (() => void) | null = null;

  /** The next reveal from hidden makes no peek (music starting, as on macOS). */
  private silentReveal = false;

  /** Drop sequence bookkeeping: last tick played, and whether the ✓ has fired. */
  private uploadTens = 0;
  private uploadDone = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.build();
    this.wireFsm();
    this.wireInput();
    this.engine.onDizzy = () => this.handleDizzy();
    this.flowSlot.onHold = (on) => this.holdCompact(on);
    void this.flowSlot.start();
    this.greeting.onComplete = () => {
      this.fsm.greetComplete();
      this.onGreetingDone?.();
    };
    State.subscribe(() => {
      this.dirty = true;
      this.ensureRunning();
    });
  }

  /** The request has its answer: the card goes and the session carries on. */
  private closeApproval() {
    State.endApproval();
    this.fsm.pinned = false;
    // Back to the chat when the card came over it.
    this.setView(State.viewAfterCard());
  }

  /**
   * Folds a card that is waiting for an answer down to the compact island,
   * without answering it (Mac #290). Nothing is decided: the request keeps
   * waiting, the island stays on screen, and opening it shows the card again.
   */
  foldApproval() {
    if (!State.pendingApproval || State.mode !== "expanded") return;
    State.isPinned = true;
    this.fsm.pinned = true;
    this.fsm.forcePetit();
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  private build() {
    const actions: ViewActions = {
      setView: (v) => this.setView(v),
      cancelDrop: () => this.discardDrop(),
      collapse: () => this.collapse(),
      foldApproval: () => this.foldApproval(),
      setFocus: (id) => {
        State.setFocus(id);
        Sound.play("blip");
        // A pill with a waiting request opens on its card: going back to it
        // after looking at another pill brings the card up again.
        const req = State.pendingApproval;
        if (req?.pillId === id) this.setView(req.questions ? "question" : "approval");
      },
      openTerminal: () => {
        const task = State.focusTask;
        // Sessions from the Claude desktop app live there, not in a terminal.
        if (task?.id === CLAUDE_DESKTOP_ID) void Bridge.openClaudeDesktop();
        else void Bridge.openSession(task?.sessionId ?? null, task?.sessionCwd ?? null);
      },
      // The ↗ button — same targets as openAgentTarget() on macOS.
      openTarget: () => {
        const task = State.focusTask;
        if (!task) return;
        const urls: Record<string, string> = {
          integration_github: "https://github.com/pulls",
          integration_stripe: "https://dashboard.stripe.com/payments",
          integration_notion: "https://notion.so",
        };
        if (task.id === CLAUDE_DESKTOP_ID) void Bridge.openClaudeDesktop();
        else if (task.id === "integration_claude" || task.sessionId) {
          void Bridge.openSession(task.sessionId ?? null, task.sessionCwd ?? null);
        } else if (task.id === SPOTIFY_ID) void Bridge.spotifyOpen();
        else if (urls[task.id]) void Bridge.openUrl(urls[task.id]);
        // winotch: Today opens big, on its own views.
        else if (task.app === "today") {
          State.detailApp = task.id;
          this.setView("app");
        }
      },
      openUrl: (url) => {
        if (url) void Bridge.openUrl(url);
      },
      decide: (d) => {
        const req = State.pendingApproval;
        void Bridge.log(`decide ${d} req=${req?.requestId ?? "none"}`);
        if (!req) return;
        Sound.play(d === "deny" ? "blip" : "approve");
        void Bridge.approvalDecision(req.requestId, d);
        this.closeApproval();
      },
      answer: (answers) => {
        const req = State.pendingApproval;
        if (!req) return;
        Sound.play("approve");
        void Bridge.approvalAnswer(req.requestId, answers);
        this.closeApproval();
      },
      answerInTerminal: () => {
        const req = State.pendingApproval;
        if (!req) return;
        Sound.play("blip");
        void Bridge.approvalDecline(req.requestId);
        this.closeApproval();
      },
      toggleSound: () => {
        State.settings.soundEnabled = !State.settings.soundEnabled;
        Sound.setEnabled(State.settings.soundEnabled);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      openSettingsWindow: () => this.openSettings("general"),
      blip: () => Sound.play("blip"),
    };

    this.wakeStrip = h("div", { id: "wake-strip" });
    this.botGlow = h("div", { id: "bot-glow" });
    this.botCanvas = this.engine.el;
    this.greetingCanvas = this.greeting.el;
    this.bellCount = h("span", { class: "count" });
    this.bellFlash = h("span", { class: "flash" });
    this.compactBell = h("div", { id: "compact-bell" },
      h("span", { class: "bell" }, svg(ICONS.bell, 14), this.bellCount),
      this.bellFlash,
    );
    this.countdown = h("div", { id: "countdown" });

    this.header = buildHeader(actions);
    this.views = buildViews(actions, () => this.animateGeometry(), (line) => this.say(line));
    this.viewsEl = h("div", { id: "views" });
    for (const v of this.views.values()) this.viewsEl.append(v.el);
    this.contentEl = h("div", { id: "content" }, this.header.el, this.viewsEl);

    // The drop sequence draws the card, the bar and its own mark. It sits under
    // the header, which stays visible on top of it exactly as on macOS.
    this.uploadCanvas = new UploadCanvas({
      ask: () => {
        State.promptContext = State.droppedFile
          ? { kind: "file", name: State.droppedFile.name, path: State.droppedFile.path }
          : null;
        this.setView("prompt");
      },
      cancel: () => this.discardDrop(),
    });

    this.clipEl = h(
      "div",
      { id: "island-clip" },
      this.greetingCanvas,
      this.uploadCanvas.el,
      this.contentEl,
    );
    this.islandEl = h(
      "div",
      { id: "island" },
      this.clipEl,
      this.botGlow,
      this.botCanvas,
      this.compactBell,
      this.flowSlot.el,
      this.countdown,
    );

    this.greetingCanvas.style.width = `${EXPANDED_W}px`;
    this.greetingCanvas.style.height = "150px";

    this.root.append(this.wakeStrip, this.islandEl);
    this.applyGeometry();
  }

  // ── FSM ─────────────────────────────────────────────────────────────────────

  private wireFsm() {
    this.fsm.homeToPetitDelay = autoClose();
    this.fsm.openOnHover = State.settings.openOnHover;
    this.fsm.onTransition = (from, to) => {
      switch (to) {
        case "hidden":
          this.setMode("hidden");
          break;
        case "petit":
          if (from === "greeting") this.greeting.interrupt();
          else if (from === "hidden" && !this.silentReveal) Sound.play("peek");
          this.setMode("compact");
          if (from === "greeting") State.view = State.defaultView();
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "home":
          this.expand(this.openingView ?? State.defaultView());
          if (!this.wasInIsland) this.fsm.mouseLeft();
          // Hooks may have been installed in a terminal since: the idle cards
          // say so on the next open, without polling while the island is shut.
          void refreshHookPills();
          break;
        case "greeting":
          this.expand("greeting");
          this.greeting.start();
          this.holdLogo = true;
          this.greetingLeftAt = null;
          break;
      }
      State.notify();
      if (from === "hidden") this.onWake?.();
    };
  }

  launch() {
    this.fsm.launch();
  }

  // ── Mode / view ─────────────────────────────────────────────────────────────

  private setMode(mode: IslandMode) {
    const prev = State.mode;
    if (mode === prev) return;
    State.mode = mode;
    if (mode === "expanded") Sound.play("open");
    if (prev === "expanded") {
      Sound.play("close");
      // A folded card is still waiting: it keeps the island pinned.
      if (!State.pendingApproval) State.isPinned = false;
      void Bridge.focusWindow(false);
    }
    if (mode !== "expanded") {
      closePlanCard();
      this.engine.resetMorph();
      // Nothing can be seen of the sequence once the island is shut, and leaving
      // it running would keep the frame loop awake — the island must cost
      // nothing while hidden.
      UploadSeq.deactivate();
    }
    this.updateWindowCollapsed();
    this.animateGeometry();
    State.notify();
  }

  /** True while the drop sequence owns the island body. */
  private get uploadActive(): boolean {
    return State.mode === "expanded" && UploadSeq.isActive && UPLOAD_VIEWS.has(State.view);
  }

  /** Navigating out of the drop flow ends the sequence, as on macOS. */
  private stopSequenceIfLeaving(view: IslandViewName) {
    if (UploadSeq.isActive && !UPLOAD_VIEWS.has(view)) UploadSeq.deactivate();
  }

  expand(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    if (view !== "overview") closePlanCard();
    State.view = view;
    if (State.mode !== "expanded") this.setMode("expanded");
    else this.animateGeometry();
    State.lastActivity = performance.now();
    State.notify();
  }

  setView(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    if (view !== "overview") closePlanCard();
    if (State.mode !== "expanded") {
      this.fsm.forceHome();
      State.view = view;
      this.animateGeometry();
      State.notify();
      return;
    }
    State.view = view;
    State.lastActivity = performance.now();
    this.animateGeometry();
    State.notify();
  }

  collapse() {
    // A waiting card is only ever folded, never dropped by a close.
    if (State.pendingApproval) {
      this.foldApproval();
      return;
    }
    State.isPinned = false;
    this.fsm.pinned = false;
    // Drive the state machine rather than the mode: setting the mode behind its
    // back left it thinking the island was still open, and a click on the compact
    // island then did nothing — the island could never be reopened.
    this.fsm.forcePetit();
  }

  /** Alert from the hook server: open on this view. Pinned alerts never auto-close. */
  /** The settings, on `page` (any page name): the island grows around them. */
  openSettings(page: string) {
    (this.views.get("settings") as SettingsHost | undefined)?.open(page);
    this.alert("settings");
  }

  alert(view: IslandViewName) {
    this.fsm.pinned = State.isPinned;
    // Opened straight on the alert's view: opening on the default view first
    // and then switching played two transitions, and read as sluggish.
    this.openingView = view;
    this.fsm.forceHome();
    this.openingView = null;
    this.expand(view);
  }

  reveal() {
    this.fsm.reveal();
  }

  /** Music started playing: the compact island, without the peek sound (musicReveal). */
  revealSilently() {
    this.silentReveal = true;
    this.fsm.reveal();
    this.silentReveal = false;
  }

  /** An alert stopped waiting for an answer: let the island auto-close again. */
  dropPin() {
    this.fsm.pinned = false;
    // The countdown the pin held back starts now, if the mouse is elsewhere.
    if (!this.wasInIsland) this.fsm.mouseLeft();
  }

  /**
   * Flow shows something in the compact notch (dictation, a call, a message,
   * OK Tent): the notch comes up from its line, without the peek sound, and
   * stays; it never opens for it. Once nothing shows, it goes back to its line
   * on the usual timing.
   */
  private holdCompact(on: boolean) {
    this.fsm.held = on;
    if (on) this.revealSilently();
    else if (this.fsm.state === "petit" && !this.wasInIsland) this.fsm.mouseLeft();
  }

  // ── Keyboard shortcuts (island/shortcuts.ts) ────────────────────────────────

  emote(name: BotEmoteName) {
    this.engine.triggerEmote(name);
    this.ensureRunning();
  }

  /** Ctrl+P: keep the open island from folding away, or let it fold again. */
  setPinned(on: boolean) {
    State.isPinned = on;
    this.fsm.pinned = on;
    if (on) {
      // The countdown bar reads the state machine's deadline, cleared with it.
      this.fsm.cancelTimers();
    } else if (!this.wasInIsland && this.fsm.state === "home") {
      this.fsm.mouseLeft();
    }
    State.notify();
  }

  /** The island takes the keyboard, so its own shortcuts work (Mac: makeKey).
   *  It gives it back when it closes, or when the chat is left. */
  takeKeyboard() {
    void Bridge.focusWindow(true);
  }

  /** The answer said in the island holds it open while it writes (say). */
  private sayPinned = false;

  /** An answer that never comes keeps nothing waiting longer than this (State.saying). */
  private sayGuard: number | null = null;

  /** The answer being said starts: news waits for it (State.afterSay). */
  private beginSay() {
    State.saying = true;
    if (this.sayGuard != null) window.clearTimeout(this.sayGuard);
    this.sayGuard = window.setTimeout(() => {
      this.sayGuard = null;
      for (const then of this.endSay()) then();
    }, 90_000);
  }

  /** It is over: what waited for it, to run now (State.endSay). */
  private endSay(): (() => void)[] {
    if (this.sayGuard != null) window.clearTimeout(this.sayGuard);
    this.sayGuard = null;
    return State.endSay();
  }

  /**
   * The answer said in the island was left, however (a click to the console,
   * Esc, another card, folded): it stops writing, and the pin it held goes, so
   * the island folds as usual afterwards.
   */
  private leaveSay() {
    (this.views.get("say") as SayHost | undefined)?.stop();
    // What waited comes next, once this change of screen is done.
    const waiting = this.endSay();
    if (waiting.length) window.setTimeout(() => waiting.forEach((then) => then()), 0);
    if (!this.sayPinned) return;
    this.sayPinned = false;
    State.isPinned = false;
    this.fsm.pinned = false;
  }

  /**
   * Claude Code opened a session in the chat (winotch_open_session): the
   * console, on it, once the chat's own answer is in. Asked from the quick
   * question, switching at once would end the conversation that asked.
   */
  openChatSession(id: string) {
    const go = () => {
      // Opened for the user from elsewhere: it waits for the pointer to come once.
      this.chatUntilVisit = !this.wasInIsland;
      openChatOn(id, (view) => this.alert(view));
    };
    const chat = this.views.get("prompt");
    if (chat?.whenIdle) chat.whenIdle(go);
    else go();
  }

  /** The chat opened on a session for the user, the pointer not on it yet: it holds until it comes. */
  private chatUntilVisit = false;

  /**
   * The chat holds the island open: something typed, the chip's choices open
   * (State.chatHolds), or opened for the user and not visited yet. Otherwise it
   * folds on leaving like any screen.
   */
  private chatHolds(): boolean {
    return State.view === "prompt" && (State.chatHolds || this.chatUntilVisit);
  }

  /** What was said with Shift and the dictation key: asked by the console (views/chat.ts). */
  ask(text: string) {
    this.views.get("prompt")?.ask?.(text);
  }

  /**
   * What was asked by voice, said big (views/say.ts): the island opens at its
   * launch size on what was asked, the answer writes itself in, and once it
   * has been read the island folds (unless the pointer is on it: then when it
   * leaves). With the console open the console shows it, nothing else does.
   */
  private say(line: SayLine | null) {
    const view = this.views.get("say") as SayHost | undefined;
    if (!view || State.chatting) return;
    if (line?.phase === "asking") {
      // A card waiting for an answer keeps the island: the console has the exchange.
      if (State.pendingApproval) return;
      view.asking(line.text);
      this.beginSay();
      this.sayPinned = true;
      State.isPinned = true;
      this.alert("say");
      return;
    }
    // Moved on meanwhile (opened the console, another card): it is said there, or not at all.
    if (State.view !== "say" || State.mode !== "expanded") return;
    const done = () => {
      if (State.view !== "say") return;
      this.sayPinned = false;
      State.isPinned = false;
      // What waited for it comes now, in its place; nothing did: it folds.
      for (const then of this.endSay()) then();
      if (State.view !== "say") return;
      if (this.wasInIsland) this.dropPin();
      else this.collapse();
    };
    if (line) view.answer(line.text, done);
    else done();
  }

  /** Ctrl+O / Ctrl+E go to the view on screen. */
  viewCommand(command: ViewCommand) {
    this.views.get(State.view)?.command?.(command);
  }

  // ── File drop ───────────────────────────────────────────────────────────────

  private onDragDrop(e: { type: string; paths?: string[] }) {
    if (e.type !== "over") void Bridge.log(`drag ${e.type} ${e.paths?.length ?? 0} file(s)`);
    if (State.paused) return;
    switch (e.type) {
      case "enter":
      case "over": {
        if (State.fileDragOver) return;
        State.fileDragOver = true;
        this.engine.animateMorph(1);
        // enterZone must run before the island expands, so the sequence is
        // already active by the time the view becomes `upload`.
        UploadSeq.enterZone(State.mouseInIsland.x, State.mouseInIsland.y);
        this.alert("upload");
        break;
      }
      case "leave": {
        if (!State.fileDragOver) return;
        State.fileDragOver = false;
        this.engine.animateMorph(0);
        // The island deliberately stays open: the drag session is still alive.
        UploadSeq.exitZone();
        State.notify();
        break;
      }
      case "drop": {
        State.fileDragOver = false;
        const path = e.paths?.[0];
        if (!path) {
          this.engine.animateMorph(0);
          this.setView(State.defaultView());
          return;
        }
        this.swallow(path);
        break;
      }
    }
  }

  /**
   * The mark takes the file in. Nothing here waits on the file system: the copy into
   * the inbox runs in the background and swaps the path in when it lands, so a
   * slow disk can never stall the animation — same as FileDropHandler on macOS.
   */
  private swallow(path: string) {
    const name = path.split(/[\\/]/).pop() || "file";
    State.droppedFile = { name, path };
    State.promptContext = { kind: "file", name, path };

    UploadSeq.performDrop(State.uploadDuration);
    this.uploadTens = 0;
    this.uploadDone = false;

    this.engine.gulp();
    Sound.play("approve");
    this.engine.triggerEmote("happy");
    this.engine.animateMorph(0);

    State.uploadProgress = 0;
    this.setView("uploading");
    this.ensureRunning();

    void Bridge.ingestFile(path)
      .then((file) => {
        // Cancelled (or replaced by another drop) while the copy was running.
        if (State.droppedFile?.path !== path) return;
        State.droppedFile = { name: file.name, path: file.path };
        State.promptContext = { kind: "file", name: file.name, path: file.path };
        State.notify();
      })
      .catch((err) => {
        if (State.droppedFile?.path !== path) return;
        UploadSeq.deactivate();
        const note = String(err).replace(/^Error:\s*/, "");
        State.noteMessage = note;
        this.engine.animateMorph(0);
        this.setView("note");
        Sound.play("error");
        // Only if the note is still what shows: a new drop may have come since.
        window.setTimeout(() => {
          if (State.view === "note" && State.noteMessage === note) this.setView(State.defaultView());
        }, 2400);
      });
  }

  /** "Cancel" on the dropped file: forget it, so the chat does not pick it up. */
  private discardDrop() {
    State.droppedFile = null;
    State.promptContext = null;
    this.setView(State.defaultView());
  }

  /**
   * Sounds and view changes hung off the canvas timeline: a `tick` every 10 %,
   * the ✓ chime when the bar completes, then `choose` once the mark is back to itself.
   */
  private stepSequence() {
    const since = UploadSeq.sinceDrop();
    if (since == null) return;
    const dur = State.uploadDuration;
    const p = Math.max(0, Math.min(1, (since - PRE_PROGRESS) / dur));

    const tens = Math.floor(p * 10);
    if (tens > this.uploadTens && tens < 10) {
      this.uploadTens = tens;
      Sound.play("tick");
    }

    if (!this.uploadDone && since >= PRE_PROGRESS + dur) {
      this.uploadDone = true;
      Sound.play("approve");
      this.engine.triggerEmote("happy");
    }
    // The extra second is the grow-back, after which the choose card is up.
    if (since >= PRE_PROGRESS + dur + 1 && State.view === "uploading") {
      this.setView("choose");
    }
  }

  // ── Geometry ────────────────────────────────────────────────────────────────

  private targetSize(): { w: number; h: number; r: number } {
    let { w, h } = islandSize(State.mode, State.view, chatCount());
    if (State.mode === "expanded" && State.view === "question" && State.pendingApproval?.questions) {
      h = QUESTION_PICKER_H;
    }
    // The chat is as tall as what it shows (views/chat.ts fitHeight).
    // An answer said in the island hugs its words (views/say.ts): as tall as
    // its lines, up to three, and as wide as the widest, within the open
    // island's width. Its padding, the island's, and 22 a line (style.css .sayview).
    if (State.mode === "expanded" && State.view === "say") {
      const say = this.views.get("say") as SayHost | undefined;
      h = 34 + 22 * (say?.lines ?? 1);
      w = Math.max(SAY_MIN_W, Math.min(EXPANDED_W, (say?.textWidth ?? EXPANDED_W) + 2 * 28 + 20));
    }
    // Never past the window, whatever it asks: the island stays whole on screen.
    if (State.mode === "expanded" && State.view === "prompt" && State.chatReadHeight) {
      h = Math.min(PANEL_H - 40, State.chatReadHeight);
    }
    const r = State.mode === "expanded" ? EXPANDED_CORNER : ROUNDED_CORNER;
    return { w, h, r };
  }

  /**
   * The shape goes to the size its mode and screen want, growing or folding on
   * the one spring (core/motion.ts): clean, no overshoot. Coucou grew on a
   * bouncy spring and folded on a timed curve, while the mark had a spring of
   * its own, so the three never landed together.
   */
  private animateGeometry() {
    const { w, h, r } = this.targetSize();
    this.width.springTo(w, MOTION.response, MOTION.damping);
    this.height.springTo(h, MOTION.response, MOTION.damping);
    this.radius.springTo(r, MOTION.response, MOTION.damping);
    this.ensureRunning();
  }

  private applyGeometry() {
    this.sizeContent();
    const w = this.width.value;
    const hh = this.height.value;
    const r = this.radius.value;
    // Every frame asks; only a change in size is worth writing.
    const key = `${w.toFixed(2)} ${hh.toFixed(2)} ${r.toFixed(2)} ${window.innerWidth}`;
    if (key === this.appliedGeometry) return;
    this.appliedGeometry = key;
    this.islandEl.style.width = `${w}px`;
    this.islandEl.style.height = `${hh}px`;
    this.islandEl.style.borderRadius = `0 0 ${r}px ${r}px`;
    // The ears where it meets the top of the screen, never taller than the
    // island itself: a hidden island leaves nothing behind (style.css #island::before).
    // Written only when it changes, which is only while the island is shorter than them.
    const ear = `${Math.min(EAR, hh).toFixed(2)}px`;
    if (ear !== this.appliedEar) {
      this.appliedEar = ear;
      this.islandEl.style.setProperty("--ear", ear);
    }
    this.islandEl.style.transform = `translateX(-50%)`;
    // These follow the island as it resizes, so they belong here rather than in
    // the state-driven DOM sync.
    this.compactBell.style.left = `${w - 40 - 14.5}px`;
    this.compactBell.style.top = `${hh / 2 - 14.5}px`;
    this.greetingCanvas.style.left = `${(w - EXPANDED_W) / 2}px`;
    this.uploadCanvas.el.style.left = `${(w - EXPANDED_W) / 2}px`;

    const viewportW = window.innerWidth > 0 ? window.innerWidth : PANEL_W;
    const rect = { x: (viewportW - w) / 2, y: 0, w, h: hh };
    const p = this.pushedRect;
    if (Math.abs(p.x - rect.x) > 0.5 || Math.abs(p.w - rect.w) > 0.5 || Math.abs(p.h - rect.h) > 0.5) {
      this.pushedRect = rect;
      void Bridge.setIslandRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  /**
   * The screens take the size the open island is going to, once, rather than
   * following it frame by frame: the island's clip reveals them as it grows.
   * Only the screen on screen takes a new size; one going away keeps its own
   * while it leaves (island/view-motion.ts), and a folding island keeps its
   * screen at the last open size while it fades. The header is light and
   * follows the shape.
   */
  private sizeContent() {
    if (State.mode !== "expanded") return;
    const { w, h } = this.targetSize();
    // #content's padding (8 top, 10 sides and bottom) and the header's 34 (style.css).
    const vw = w - 20;
    const vh = h - 8 - 34 - 10;
    const on = this.views.get(State.view)?.el;
    const key = `${vw} ${vh} ${State.view}`;
    if (key === this.contentSize) return;
    this.contentSize = key;
    this.viewsEl.style.width = `${vw}px`;
    this.viewsEl.style.height = `${vh}px`;
    if (on) {
      // The settings bring their own head (Back) and take the header's place
      // too, as it fades (style.css #content.settings-open); an answer said
      // big (views/say.ts) has the whole black island.
      const over = State.view === "settings" || State.view === "say" ? 34 : 0;
      on.style.width = `${vw}px`;
      on.style.height = `${vh + over}px`;
      on.style.marginLeft = `${-vw / 2}px`;
      on.style.marginTop = `${-over}px`;
    }
  }

  /** Island rect in window coordinates (origin top-left of the 720×320 window). */
  private islandRect(): { x: number; y: number; w: number; h: number } {
    const w = this.width.value;
    const hh = this.height.value;
    const viewportW = window.innerWidth > 0 ? window.innerWidth : PANEL_W;
    return { x: (viewportW - w) / 2, y: 0, w, h: hh };
  }

  // ── Window collapse (hidden → tiny wake strip, zero polling) ────────────────

  private updateWindowCollapsed() {
    if (this.collapseTimer != null) {
      window.clearTimeout(this.collapseTimer);
      this.collapseTimer = null;
    }
    if (State.mode === "hidden") {
      // Let the island finish retracting, then drop the window to the wake strip:
      // from there the OS delivers no cursor events, so nothing polls at all.
      // (winotch, Windows: the window keeps its size and only the strip takes
      // the mouse; growing back from the strip flashed a stale frame.)
      this.collapseTimer = window.setTimeout(() => {
        this.collapseTimer = null;
        if (State.mode !== "hidden") return;
        this.collapsed = true;
        void Bridge.setCollapsed(true);
      }, 420);
    } else if (this.collapsed) {
      // Grow the window back before the island animates open.
      this.collapsed = false;
      void Bridge.setCollapsed(false);
    }
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  /** The pointer reached the hidden island's strip: wake it. */
  stripHover() {
    Sound.resume();
    if (State.mode === "hidden") this.fsm.mouseEntered();
  }

  private wireInput() {
    // The wake strip is the only thing the OS can hit while the island is hidden.
    this.wakeStrip.addEventListener("mouseenter", () => this.stripHover());

    this.islandEl.addEventListener("mousedown", (e) => {
      Sound.resume();
      State.lastActivity = performance.now();
      // A click makes a hover-opened island an ordinary open one.
      this.fsm.userInteracted();
      if (State.mode !== "expanded") {
        this.fsm.click();
        return;
      }
      if (this.isBotHit(e.clientX, e.clientY)) {
        this.cancelBotHover();
        this.engine.slap();
      }
    });

    // No browser menu over the mark. Everywhere else (the chat field) the webview
    // keeps its own menu.
    this.islandEl.addEventListener("contextmenu", (e) => {
      if (this.isBotHit(e.clientX, e.clientY)) e.preventDefault();
    });

    // Only keys typed into the island itself land here, never Escape typed in
    // a terminal — so it may fold a waiting card away, as Escape in the notch
    // does on macOS.
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && State.mode === "expanded") {
        if (State.pendingApproval) this.foldApproval();
        // An expanded app or the settings step back to the open island first
        // (an app's item details back to its list before that); an Esc a
        // field already used (a form's cancel) is not theirs.
        else if (State.view === "app" || State.view === "settings") {
          if (!e.defaultPrevented && !this.views.get(State.view)?.back?.()) this.setView("overview");
        }
        else if (!State.isPinned) this.collapse();
      }
      State.lastActivity = performance.now();
    });

    void onDragDrop((e) => this.onDragDrop(e));

    // Dictation's key while one of the island's fields has the keyboard (the
    // chat, Today): the key hook can't hear it then (flow/os_windows.rs
    // forward_key), so the island passes its keys on. Capture phase: the chat
    // stops its own key events from bubbling. Which key only; none is logged or kept.
    const passKey = (e: KeyboardEvent, down: boolean) => {
      if (!e.repeat) void FlowBridge.key(e.code, e.keyCode, down);
    };
    window.addEventListener("keydown", (e) => passKey(e, true), true);
    window.addEventListener("keyup", (e) => passKey(e, false), true);

    // Outside Tauri (plain browser) drive the cursor from DOM events so the
    // island can be inspected with `npm run dev`.
    if (!IS_TAURI) this.followPageCursor();
  }

  /**
   * Takes the cursor from the page's own mouse events instead of Rust's poll.
   * Used where the OS has no global cursor position (Wayland): the events only
   * fire while the pointer is over the island, so leaving the window is
   * reported as a cursor far away, which is what the poll would have said.
   */
  followPageCursor() {
    window.addEventListener("mousemove", (e) => this.onCursor(e.clientX, e.clientY));
    window.addEventListener("mouseout", (e) => {
      if (e.relatedTarget == null) this.onCursor(-10_000, -10_000);
    });
  }

  /**
   * Pointer on/off the island as the compositor sees it (Linux only). Null
   * until the first report, so a platform that never sends it is not gated.
   */
  private pointerInside: boolean | null = null;

  setPointerInside(inside: boolean) {
    this.pointerInside = inside;
  }

  /** Cursor in window-logical coordinates (anywhere on screen: it may lie outside the window). */
  onCursor(x: number, y: number) {
    // WebKitGTK can deliver a mousemove after the pointer has left the layer
    // surface; trusting it re-enters the island and the auto-close never runs.
    if (this.pointerInside === false) {
      x = -10_000;
      y = -10_000;
    }
    State.mouse = { x, y };
    this.pointerSeen = x > -10_000;
    const rect = this.islandRect();
    State.mouseInIsland = { x: x - rect.x, y: y - rect.y };

    // Windows sends no cursor position with an OLE drag, so the drop sequence is
    // fed from the Win32 cursor poll instead — it runs throughout the drag.
    if (UploadSeq.isActive && !UploadSeq.dropped) {
      UploadSeq.updateCursor(State.mouseInIsland.x, State.mouseInIsland.y);
    }

    // Hidden, only the wake strip at the very top counts, as Rust's
    // click-through does (island.rs): the window no longer shrinks to it.
    const viewportW = window.innerWidth > 0 ? window.innerWidth : PANEL_W;
    const inIsland = State.mode === "hidden"
      ? Math.abs(x - viewportW / 2) <= WAKE_STRIP_W / 2 && y >= 0 && y <= WAKE_STRIP_H
      : x >= rect.x - HIT_MARGIN && x <= rect.x + rect.w + HIT_MARGIN &&
        y >= rect.y - HIT_MARGIN && y <= rect.y + rect.h + HIT_MARGIN;

    // Recorded before the state machine hears of it: a transition it makes
    // right away (open on hover) reads where the pointer is, and must not see
    // the pointer as still outside.
    const wasIn = this.wasInIsland;
    this.wasInIsland = inIsland;
    // The pointer came to a chat opened for the user: it folds as usual from now on.
    if (inIsland && this.chatUntilVisit) {
      this.chatUntilVisit = false;
      State.notify();
    }
    if (inIsland && !wasIn) {
      if (this.fsm.state === "greeting") this.greeting.hover();
      this.fsm.mouseEntered();
    }
    if (!inIsland && wasIn) {
      this.fsm.mouseLeft();
    }

    // Bot hover → love
    const overBot = State.mode === "expanded" && State.stateOverride == null && this.isBotHit(x, y);
    if (overBot && !this.botHovering) this.botHoverIn(x, y);
    if (!overBot && this.botHovering) this.cancelBotHover();
    this.botHovering = overBot;
    if (this.botHovering) {
      const d = Math.hypot(x - this.botHoverStart.x, y - this.botHoverStart.y);
      if (d > 40) {
        this.botHoverStart = { x, y };
        this.scheduleLove();
      }
    }

    // The pointer moves all day, anywhere on screen. A frame is only worth
    // drawing when the move can change one: near the island, or passing the
    // mark's column, where the dot crosses.
    const over = this.pointerSeen ? overFor(this.pointerFromMark().x) : 0;
    const near = x >= rect.x - NEAR && x <= rect.x + rect.w + NEAR && y <= rect.y + rect.h + NEAR;
    if (near || inIsland !== wasIn || UploadSeq.isActive || Math.abs(over - this.wokenOver) > 0.002) {
      this.wokenOver = over;
      this.ensureRunning();
    }
  }

  private isBotHit(x: number, y: number): boolean {
    // A mark that does not show (the answer said in the island) is not there to touch.
    if (this.botCanvas.style.opacity === "0") return false;
    const rect = this.islandRect();
    const cx = rect.x + this.botCx.value;
    const cy = rect.y + this.botCy.value;
    const radius = this.botSize.value / 2;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  }

  private botHoverIn(x: number, y: number) {
    if (performance.now() / 1000 - this.lastLoveTime < 6) return;
    this.botHoverStart = { x, y };
    this.engine.blink();
    this.engine.tgEs = 1.08;
    Sound.play("hover");
    this.scheduleLove();
  }

  private scheduleLove() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = window.setTimeout(() => {
      this.botHoverTimer = null;
      if (!this.botHovering || State.stateOverride != null) return;
      if (performance.now() / 1000 - this.lastLoveTime < 6) return;
      this.lastLoveTime = performance.now() / 1000;
      this.engine.triggerEmote("love");
      Sound.play("love");
    }, 1900);
  }

  private cancelBotHover() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = null;
    this.engine.tgEs = 1;
  }

  /** Three slaps → dizzy + confused view for 3.3 s, then back. */
  handleDizzy() {
    this.prevViewBeforeConfused = State.view;
    State.stateOverride = "dizzy";
    this.engine.setState("dizzy");
    Sound.play("dizzy");
    this.alert("confused");
    if (this.confusedRecovery != null) window.clearTimeout(this.confusedRecovery);
    this.confusedRecovery = window.setTimeout(() => {
      this.confusedRecovery = null;
      State.stateOverride = null;
      this.engine.setState(State.effectiveState);
      if (State.view === "confused") {
        const fallback = State.defaultView();
        this.setView(this.prevViewBeforeConfused === "confused" ? fallback : this.prevViewBeforeConfused);
      }
      this.engine.triggerEmote("happy");
    }, 3300);
  }

  // ── Frame loop ──────────────────────────────────────────────────────────────

  ensureRunning() {
    // A slow loop waiting for its next frame: something new wants the full rate now.
    if (this.slowFrame !== null) {
      clearTimeout(this.slowFrame);
      this.slowFrame = null;
      requestAnimationFrame(this.frame);
      return;
    }
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (nowMs: number) => {
    const gapMs = nowMs - this.lastFrame;
    const dt = Math.min(0.05, gapMs / 1000);
    this.lastFrame = nowMs;
    const workStart = performance.now();

    this.width.step(dt, nowMs);
    this.height.step(dt, nowMs);
    this.radius.step(dt, nowMs);
    this.applyGeometry();

    if (this.dirty) {
      this.dirty = false;
      this.syncDom();
    }

    this.updateBotTargets();
    this.botCx.step(dt);
    this.botCy.step(dt);
    this.botSize.step(dt);

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    if (greetingActive) this.greeting.draw();
    // Kept running even while the drop canvas is up, so the island's own mark
    // is already in the right place the moment the canvas fades out. During the
    // greeting it takes over once the birth is over.
    if (!greetingActive || this.greeting.handedOver) this.drawBot(dt);

    const uploadActive = this.uploadActive;
    if (uploadActive) this.uploadCanvas.draw(UploadSeq.frame(), nowMs / 1000);
    this.uploadCanvas.el.classList.toggle("on", uploadActive);
    this.viewsEl.classList.toggle("hidden-by-upload", uploadActive);

    // The app pills only show in the open island.
    if (State.mode === "expanded") tickAppLogos(dt);
    // A ticker scroll that loses its frames freezes mid-way, rows overlapping.
    const viewAnimating = this.views.get(State.view)?.tick?.(nowMs) === true;
    if (UploadSeq.isActive) this.stepSequence();
    this.updateCountdown(nowMs);

    // Nothing is drawn while the island is hidden, so nothing may keep the loop
    // alive either. This used to read `... || this.engine.busy || State.mode !==
    // "hidden"`, and engine.busy is permanently true for any state with a
    // looping animation — breathing, ratelimit sweat, sleeping z's, the search
    // sweep — so a hidden island went on burning frames in exactly the states it
    // spends most of its life in. Geometry still has to finish retracting.
    const settling =
      this.width.animating || this.height.animating || this.radius.animating;
    const moving = State.mode === "hidden"
      ? settling
      : settling ||
        !this.botCx.settled || !this.botCy.settled || !this.botSize.settled ||
        greetingActive || this.engine.moving || UploadSeq.isActive || viewAnimating ||
        // The auto-close bar: it used to advance only when something else drew.
        (State.mode === "expanded" && !State.isPinned && this.fsm.homeCollapseDueAt != null);
    // Only the mark's slow loop is left (a working session's breath): in the
    // small notch a few frames a second draw it just as well, for a fraction of
    // the work. The open island is being looked at: there it gets every frame.
    const looping = State.mode !== "hidden" && this.engine.looping;
    const watched = State.mode === "expanded";

    this.meter.frame(moving, gapMs, performance.now() - workStart);

    if (moving || (looping && watched)) {
      requestAnimationFrame(this.frame);
    } else if (looping) {
      this.slowFrame = window.setTimeout(() => {
        this.slowFrame = null;
        requestAnimationFrame(this.frame);
      }, SLOW_FRAME_MS);
    } else {
      this.running = false;
      Sound.idle();
    }
  };

  private updateBotTargets() {
    // Toward where the island is going, not where it is: chasing the height as
    // it grew, the mark arrived late.
    const p = botPosition(State.mode, State.view, this.targetSize().h, State.uploadProgress);
    this.botCx.target = p.cx;
    this.botCy.target = p.cy;
    this.botSize.target = p.diameter / 0.6;

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    // The drop canvas draws its own mark; two of them would overlap.
    const handing = greetingActive && !this.greeting.handedOver;
    const visible = p.opacity > 0 && !handing && !this.uploadActive;
    this.botCanvas.style.opacity = visible ? "1" : "0";

    // The mark has no glow (style.css hides it too).
    this.botGlow.style.display = "none";
  }

  private drawBot(dt: number) {
    const size = this.botSize.value;
    const w = Math.max(1, Math.round(size));
    const hCss = w + BOT_OVERHANG;
    const wCss = w + BOT_SIDE * 2;
    if (this.canvasPx !== w) {
      this.canvasPx = w;
      this.botCanvas.style.width = `${wCss}px`;
      this.botCanvas.style.height = `${hCss}px`;
    }
    this.botCanvas.style.left = `${this.botCx.value - wCss / 2}px`;
    this.botCanvas.style.top = `${this.botCy.value - BOT_OVERHANG / 2 - hCss / 2}px`;

    this.engine.particleOverhang = BOT_OVERHANG;
    // The dot follows the pointer around the mark: where it is from the mark,
    // in CSS px. Until a real position arrives, and through the launch: the logo.
    this.engine.look = this.holdLogo || !this.pointerSeen ? null : this.pointerFromMark();
    // The dot follows the pointer across the whole screen (mark/engine.ts),
    // except at launch: the logo just born keeps its shape through the hand-over
    // and the shrink, and only once the island has settled into its notch does
    // the dot go where the pointer is. Following at once, a pointer in the
    // middle third melted the new logo into a blob as it shrank.
    if (this.holdLogo) {
      const greeting = State.mode === "expanded" && State.view === "greeting";
      if (greeting) this.greetingLeftAt = null;
      else this.greetingLeftAt ??= performance.now();
      const settled = !this.width.animating && !this.height.animating;
      if (this.greetingLeftAt !== null && settled && performance.now() - this.greetingLeftAt > 300) {
        this.holdLogo = false;
      }
    }
    if (this.engine.morph > 0.3) {
      this.engine.slotHTarget = State.fileDragOver ? 0.2 : 0;
    } else {
      this.engine.slotHTarget = 0;
      if (this.engine.morph < 0.05) {
        this.engine.slotH = 0;
        this.engine.slotHVel = 0;
      }
    }
    // Dances while music plays: always in the compact island, expanded only on
    // the music pill's card (BotCanvasView, macOS). Asked every frame.
    this.engine.setDancing(islandDances({
      music: State.spotifyPlaying,
      state: State.effectiveState,
      mode: State.mode,
      view: State.view,
      focusId: State.focusTask?.id,
    }));

    // The chat waiting for its answer: the mark by the field crosses, over and
    // back, until the answer is in (views/chat.ts State.chatAnswering).
    this.engine.setCrossing(State.chatAnswering && State.mode === "expanded" && State.view === "prompt");
    this.engine.update(dt);
    this.engine.draw(wCss, hCss, w);
  }

  /** The pointer from the mark's centre, in CSS px: which side the dot belongs on. */
  private pointerFromMark(): { x: number; y: number } {
    const rect = this.islandRect();
    return { x: State.mouse.x - (rect.x + this.botCx.value), y: State.mouse.y - (rect.y + this.botCy.value) };
  }

  private updateCountdown(nowMs: number) {
    // The state machine's own deadline, so the bar follows an auto-close delay
    // edited while the countdown runs.
    const dueAt = this.fsm.homeCollapseDueAt;
    if (State.mode !== "expanded" || State.isPinned || dueAt == null) {
      this.countdown.style.width = "0px";
      return;
    }
    const autoClose = this.fsm.homeToPetitDelay;
    const windowS = Math.min(10, autoClose * 0.6);
    const remaining = (dueAt - nowMs) / 1000;
    this.countdown.style.width =
      remaining < windowS ? `${Math.max(0, clamp(remaining / windowS, 0, 1) * 160)}px` : "0px";
  }

  // ── DOM sync ────────────────────────────────────────────────────────────────

  private syncDom() {
    const expanded = State.mode === "expanded";
    const greetingActive = expanded && State.view === "greeting";

    const live = expanded && !greetingActive;
    this.contentEl.style.opacity = live ? "1" : "0";
    this.contentEl.classList.toggle("shut", !live);
    // The settings bring their own head (Back): the island's tabs step aside.
    this.contentEl.classList.toggle("settings-open", State.view === "settings");
    // While the drop sequence owns the body its buttons are painted on the canvas
    // underneath, so only the header may keep taking clicks up here.
    this.contentEl.style.pointerEvents = live && !this.uploadActive ? "auto" : "none";
    this.header.el.style.pointerEvents = live ? "auto" : "none";
    this.greetingCanvas.style.display = greetingActive ? "block" : "none";

    // Leaving the greeting, however it ends, lets its sound fade out.
    if (this.greetingShown && !greetingActive) this.greeting.leave();
    this.greetingShown = greetingActive;

    this.header.sync();
    const from = this.shownView;
    const changed = State.view !== from;
    for (const [name, view] of this.views) {
      const on = name === State.view;
      view.el.classList.toggle("on", on);
      if (on) view.sync();
    }
    if (from === "say" && (State.view !== "say" || !live)) this.leaveSay();
    // A new screen, or the island opening on one: it comes as the change means
    // (island/view-motion.ts). Shut, screens only swap; the content fades as a whole.
    if (changed || live !== this.wasLive) {
      const leaving = changed && from ? this.views.get(from)?.el ?? null : null;
      const arriving = this.views.get(State.view)?.el;
      if (arriving) {
        if (live && !this.wasLive) moveScreens(null, arriving, "open", 0);
        else if (live) {
          const { move, dir } = classify(from, State.view);
          moveScreens(leaving, arriving, move, dir);
        } else placeScreens(leaving, arriving);
      }
      this.shownView = State.view;
      this.wasLive = live;
    }

    // The chat is the only view with a text field, so it is the only time the
    // island is allowed to take keyboard focus.
    if (this.lastSyncedView !== State.view) {
      const wasChat = this.lastSyncedView === "prompt" || this.lastSyncedView === "settings";
      this.lastSyncedView = State.view;
      // The settings hold the island open, and the chat while it holds something
      // (State.chatHolds); leaving them starts the usual countdown.
      this.fsm.chatOpen = this.chatHolds() || State.view === "settings";
      if (wasChat && !this.wasInIsland) this.fsm.mouseLeft();
      if (State.view === "settings") {
        // Its fields (keys, the Gmail form, shortcuts) need the keyboard.
        void Bridge.focusWindow(true);
      } else if (State.view === "prompt") {
        void Bridge.focusWindow(true);
        window.setTimeout(() => this.views.get("prompt")?.focus?.(), 120);
      } else if (wasChat) {
        void Bridge.focusWindow(false);
      }
    }
    // winotch: while a field of the expanded app is being typed in (Today),
    // the island holds open like the chat; letting go starts the countdown.
    const holds = this.chatHolds() || State.view === "settings" || (State.view === "app" && State.typing);
    if (this.fsm.chatOpen !== holds) {
      this.fsm.chatOpen = holds;
      if (!holds && !this.wasInIsland) this.fsm.mouseLeft();
    }

    // winotch: the compact notch shows the bell and its count, not the app grid;
    // the moment an app has news, its logo stands in for the bell.
    const compact = State.mode === "compact";
    this.compactBell.style.opacity = compact ? "1" : "0";
    // Flow's slot shows in the compact notch and in the open island alike (in
    // the header row's middle there): dictating into the chat shows its bars.
    this.flowSlot.setVisible(State.mode !== "hidden");
    this.flowSlot.el.classList.toggle("open", State.mode === "expanded");
    this.bellCount.textContent = Feed.unread > 99 ? "99+" : String(Feed.unread);
    this.compactBell.classList.toggle("none", Feed.unread === 0);
    const flash = State.flash;
    if (flash && flash.at !== this.shownFlash) {
      this.shownFlash = flash.at;
      this.bellFlash.replaceChildren(logoElement(flash.id, flash.name, 16));
      this.compactBell.classList.add("flashing");
      if (this.flashTimer !== null) window.clearTimeout(this.flashTimer);
      this.flashTimer = window.setTimeout(() => {
        this.flashTimer = null;
        this.compactBell.classList.remove("flashing");
      }, 3000);
    }

    // winotch: the compact island shows the bell, never Coucou's 2 x 2 grid
    // of app pills (the overview's pill grid holds every app).
    syncAppLogoStates(State.tasks);
    this.engine.setState(State.effectiveState);
  }

  /** Applies settings coming from Rust at boot. */
  applySettings() {
    Sound.setEnabled(State.settings.soundEnabled);
    Sound.setVolume(State.settings.soundVolume);
    this.fsm.homeToPetitDelay = autoClose();
    this.fsm.openOnHover = State.settings.openOnHover;
    State.notify();
  }

  get panelSize() {
    return { w: PANEL_W, h: PANEL_H };
  }

  get chatHeight() {
    return chatPromptHeight(chatCount());
  }
}

/**
 * Measures each animation as it runs: frames, average rate, the longest gap
 * between two frames, and the longest the island's own code took for one.
 * Animations that dropped frames are written to winotch.log, so a stutter can
 * be told apart: slow code here, or a webview that draws late.
 */
class FrameMeter {
  private start = 0;
  private frames = 0;
  private worstGap = 0;
  private worstWork = 0;

  frame(moving: boolean, gapMs: number, workMs: number) {
    if (moving) {
      if (this.frames === 0) {
        this.start = performance.now();
      } else {
        this.worstGap = Math.max(this.worstGap, gapMs);
      }
      this.frames += 1;
      this.worstWork = Math.max(this.worstWork, workMs);
      return;
    }
    if (this.frames === 0) return;
    const ms = performance.now() - this.start;
    const fps = ms > 0 ? ((this.frames - 1) * 1000) / ms : 0;
    // Two frames missed in a row is a visible stutter; anything shorter is noise.
    if (ms >= 150 && this.worstGap > 34) {
      void Bridge.log(
        `fps: ${Math.round(ms)} ms, ${this.frames} frames (${Math.round(fps)} fps), ` +
          `worst gap ${Math.round(this.worstGap)} ms, worst frame work ${this.worstWork.toFixed(1)} ms`,
      );
    }
    this.frames = 0;
    this.worstGap = 0;
    this.worstWork = 0;
  }
}
