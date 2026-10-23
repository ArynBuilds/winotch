// Chat view — DOM port of PromptView / ChatBubble / TypingDotsView from
// IslandViewContent.swift. winotch's chat talks to the user's own Claude Code
// sessions only (core/claude-sessions.ts), never to a model API directly.
//
// The chip inside the text field, at its right end, names the session and
// opens the picker: a quick question (not saved), a new session in a recent
// folder, then the sessions on this computer; its tabs pick the model and the
// effort too. The log is the picked session's conversation, kept fresh while the
// chat is open. A message goes to that session (or starts a new one in a
// folder): typed into its terminal when winotch can reach it, else sent
// headless, its answer streaming in as Claude Code writes it. A quick
// question's log lives in this page only. Answers are rendered as Markdown
// (markdown.ts).
//
// The model and effort tabs pick what Claude Code runs with
// (Settings.chatModel / chatEffort; none = Claude Code's default). While the
// field has text and the keys, the chip folds to its chevron so the text has
// the width.
//
// The field is one line until the text wraps or Shift+Enter breaks it; then it
// grows upward a line at a time, up to six, and scrolls inside itself past
// that. The log above gives up the height, still showing its end.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { renderMarkdown } from "./markdown";
import { MOTION } from "../core/motion";
import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type ChatMessage } from "../core/state";
import {
  Consoles, ClaudeSessions, Quick, QUICK, EFFORTS, MODELS, folderName, isNew, isQuick, newIn,
  type ModelFlags, type SessionInfo, type SessionMessage, type SessionStream,
} from "../core/claude-sessions";
import type { SayLine, ViewHost } from "./views";
import { N_, t, tl } from "../i18n/i18n";

const STRINGS = {
  send: N_("Send"),
};

/** What each model alias and effort level is called (sessions.rs MODELS / EFFORTS). */
const MODEL_NAMES: Record<(typeof MODELS)[number], string> = {
  opus: N_("Opus"),
  sonnet: N_("Sonnet"),
  fable: N_("Fable"),
};
const EFFORT_NAMES: Record<(typeof EFFORTS)[number], string> = {
  low: N_("Low"),
  medium: N_("Medium"),
  high: N_("High"),
  xhigh: N_("Extra high"),
  max: N_("Max"),
};

const modelName = (m: string) => (m in MODEL_NAMES ? t(MODEL_NAMES[m as keyof typeof MODEL_NAMES]) : "");
const effortName = (e: string) => (e in EFFORT_NAMES ? t(EFFORT_NAMES[e as keyof typeof EFFORT_NAMES]) : "");

/** The model and effort picked, as `claude` takes them. */
function flags(): ModelFlags {
  return { model: State.settings.chatModel || undefined, effort: State.settings.chatEffort || undefined };
}

function bubble(message: ChatMessage): HTMLElement {
  if (message.role === "user") {
    return h(
      "div",
      { class: "chat-row user" },
      h("div", { class: "bubble", text: message.content }),
    );
  }
  const reply = h("div", { class: "reply" });
  renderMarkdown(reply, message.content);
  return h("div", { class: "chat-row" }, reply);
}

/** `target` becomes the session the chat talks to, and is saved. */
function pickSession(target: string) {
  State.settings = { ...State.settings, chatSession: target };
  void Bridge.saveSettings(State.settings);
}

/**
 * "Open chat" on a finished Claude Code session (views.ts): the chat, on that
 * session, picked as the picker picks it; its log loads when the chat syncs.
 */
export function openChatOn(sessionId: string | null | undefined, show: (view: "prompt") => void) {
  if (sessionId) pickSession(sessionId);
  show("prompt");
}

// ── Picker ────────────────────────────────────────────────────────────────────

/** What the picker last called each session, for the chip in the field. */
const sessionLabels = new Map<string, string>();

/** What the menu was opened for: a session ("target"), the model or the effort; it shows them all. */
type PickerKind = "target" | "model" | "effort";

interface PickerChoices {
  /** A session was picked (the quick question's included). */
  session(target: string): void;
  model(model: string): void;
  effort(effort: string): void;
}

interface Picker {
  el: HTMLElement;
  open(kind?: PickerKind): void;
  close(done?: boolean): void;
  /** Marks what is picked again (the model or effort changed). */
  refresh(): void;
  readonly isOpen: boolean;
  readonly kind: PickerKind;
}

/**
 * winotch: the chip's choices, inside the field (the user's call: a menu
 * that grew the island, a panel over the chat, both too much). The pill
 * stays one line and its content changes: the text slides away and the pill
 * becomes a strip of choices, read and moved through sideways, as the camera's
 * modes or the Dynamic Island changing what it shows without changing its
 * size. Its first level is what is picked (the session, the model, the
 * effort); each goes a level in, from the right, and ‹ comes back; sessions go
 * one more, by folder. A row longer than the pill scrolls sideways (the wheel,
 * a swipe), its edges eased; typing among the sessions finds them. A pick, Esc
 * at the first level or a click outside folds it back into the field. It looks
 * as the rest of the app: the chip's words, the lit backdrop of the
 * Recent / All switch, the motion curve.
 */
type Level = { kind: "root" } | { kind: "model" } | { kind: "effort" } | { kind: "sessionList" } | { kind: "folder"; cwd: string };

function buildPicker(choices: PickerChoices, onChange: (picked: boolean) => void, sessionName: () => string): Picker {
  const back = h("button", { class: "chat-strip-back", "aria-label": t("Back") }, svg(ICONS.chevronLeft, 10, { stroke: 2.2 }));
  const title = h("span", { class: "chat-strip-title" });
  const items = h("div", { class: "chat-strip-items", role: "listbox" });
  const el = h("div", { class: "chat-strip", role: "toolbar", tabindex: "-1" }, back, title, items);

  let isOpen = false;
  let level: Level = { kind: "root" };
  /** Back the way it came: the levels walked through. */
  let trail: Level[] = [];
  /** What is typed among the sessions. */
  let find = "";
  let sessions: SessionInfo[] | null = null;
  let live: string[] = [];
  let request = 0;

  /** One choice in the row: lit when it is what is picked; a › when it goes a level in. */
  function item(label: string, on: boolean, pick: () => void, deeper = false, hint = "") {
    const b = h("button", { class: on ? "chat-strip-item on" : "chat-strip-item", role: "option", "aria-selected": on ? "true" : "false", title: hint || undefined },
      h("span", { text: label }), deeper ? svg(ICONS.chevronRight, 8, { stroke: 2.2 }) : null);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      Sound.play("blip");
      pick();
    });
    items.append(b);
  }

  const go = (next: Level) => {
    trail.push(level);
    level = next;
    find = "";
    draw(1);
  };
  const up = () => {
    if (find) {
      find = "";
      return draw(0);
    }
    const prev = trail.pop();
    if (!prev) return close(true);
    level = prev;
    draw(-1);
  };
  back.addEventListener("click", (e) => {
    e.stopPropagation();
    up();
  });

  async function needSessions() {
    if (sessions) return;
    const ticket = ++request;
    const [list, reachable] = await Promise.all([ClaudeSessions.list(), Consoles.reachable()]);
    if (ticket !== request || !isOpen) return;
    sessions = list;
    live = reachable;
    for (const x of list) sessionLabels.set(x.id, `${x.project} · ${x.title}`);
    draw(0);
  }

  /** The row for where it is, sliding in from the side it came from. */
  function draw(dir: -1 | 0 | 1) {
    clear(items);
    const current = State.settings.chatSession;
    title.textContent = level.kind === "folder" ? folderName(level.cwd) : "";
    title.style.display = title.textContent ? "" : "none";
    el.classList.toggle("deep", level.kind !== "root");
    switch (level.kind) {
      case "root": {
        item(sessionName(), false, () => go({ kind: "sessionList" }), true);
        item(modelName(State.settings.chatModel) || t("Default model"), false, () => go({ kind: "model" }), true,
          tl("The model Claude Code answers with").toString());
        const effort = effortName(State.settings.chatEffort);
        item(effort ? t("{level} effort", { level: effort }) : t("Default effort"), false, () => go({ kind: "effort" }), true,
          tl("How hard Claude Code thinks").toString());
        break;
      }
      case "model":
      case "effort": {
        const which = level.kind;
        const values: readonly string[] = which === "model" ? MODELS : EFFORTS;
        const now = which === "model" ? State.settings.chatModel : State.settings.chatEffort;
        const pick = (v: string) => () => {
          if (which === "model") choices.model(v);
          else choices.effort(v);
          close(true);
        };
        item(t("Default"), !values.includes(now), pick(""), false, t("Claude Code's own setting"));
        for (const v of values) item(which === "model" ? modelName(v) : effortName(v), v === now, pick(v));
        break;
      }
      case "sessionList":
      case "folder": {
        if (!sessions) {
          item(t("Loading…"), false, () => {});
          void needSessions();
          break;
        }
        const pick = (id: string) => () => {
          choices.session(id);
          close(true);
        };
        const named = (x: SessionInfo) => `${live.includes(x.id) ? "● " : ""}${x.title}`;
        if (find) {
          // Typed: every session that matches, wherever it is.
          const q = find.toLowerCase();
          for (const x of sessions.filter((x) => `${x.project} ${x.title}`.toLowerCase().includes(q))) {
            item(`${named(x)} · ${x.project}`, x.id === current, pick(x.id), false, x.cwd);
          }
          if (!items.childElementCount) item("…", false, () => {});
          break;
        }
        if (level.kind === "sessionList") {
          item(t("Quick question"), isQuick(current), pick(QUICK));
          const folders = [...new Set(sessions.map((x) => x.cwd))];
          for (const cwd of folders) {
            const inIt = sessions.some((x) => x.cwd === cwd && x.id === current) || current === newIn(cwd);
            item(folderName(cwd), inIt, () => go({ kind: "folder", cwd }), true, cwd);
          }
        } else {
          const cwd = level.cwd;
          for (const x of sessions.filter((x) => x.cwd === cwd)) item(named(x), x.id === current, pick(x.id), false, x.title);
          sessionLabels.set(newIn(cwd), `New session · ${folderName(cwd)}`);
          item("+ New", current === newIn(cwd), pick(newIn(cwd)), false, cwd);
        }
        break;
      }
    }
    if (find) items.prepend(h("span", { class: "chat-strip-find", text: find }));
    items.scrollLeft = 0;
    edges();
    if (dir !== 0 && typeof items.animate === "function") {
      items.animate([{ opacity: 0, transform: `translateX(${dir * 18}px)` }, { opacity: 1, transform: "none" }], { duration: MOTION.in, easing: MOTION.ease });
    }
  }

  /** The row's ends ease out where there is more of it (style.css .chat-strip-items). */
  function edges() {
    items.classList.toggle("more-left", items.scrollLeft > 2);
    items.classList.toggle("more-right", items.scrollLeft + items.clientWidth < items.scrollWidth - 2);
  }
  items.addEventListener("scroll", edges, { passive: true });
  // The wheel scrolls the row sideways.
  items.addEventListener("wheel", (e) => {
    const w = e as WheelEvent;
    items.scrollLeft += w.deltaY + w.deltaX;
    w.preventDefault();
  }, { passive: false });

  // Its keys: left and right walk the row, Enter picks, Esc and Backspace go
  // back; among the sessions, letters find them.
  el.addEventListener("keydown", (e) => {
    const k = e as KeyboardEvent;
    const buttons = [...items.children].filter((c) => c.classList.contains("chat-strip-item")) as HTMLElement[];
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    if (k.key === "Escape" || (k.key === "Backspace" && !find)) {
      e.preventDefault();
      e.stopPropagation(); // Escape steps back in the strip, not out of the island
      return up();
    }
    if (k.key === "ArrowRight" || k.key === "ArrowLeft") {
      e.preventDefault();
      const next = buttons[k.key === "ArrowRight" ? Math.min(at + 1, buttons.length - 1) : Math.max(at - 1, 0)];
      next?.focus();
      next?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
      return;
    }
    if (k.key === "Enter") {
      e.preventDefault();
      (buttons[at] ?? buttons[0])?.click();
      return;
    }
    const finding = level.kind === "sessionList" || level.kind === "folder";
    if (finding && k.key === "Backspace") {
      e.preventDefault();
      find = find.slice(0, -1);
      return draw(0);
    }
    if (finding && k.key.length === 1 && !k.ctrlKey && !k.metaKey && !k.altKey) {
      e.preventDefault();
      find += k.key;
      draw(0);
    }
  });

  // A click outside folds it back (the strip's own clicks stop at its items).
  window.addEventListener?.("pointerdown", (e) => {
    const target = e.target as Node | null;
    if (!isOpen || !target || el.contains(target) || (target as HTMLElement).closest?.(".chat-chip")) return;
    close();
  }, true);

  function open() {
    isOpen = true;
    level = { kind: "root" };
    trail = [];
    find = "";
    sessions = null;
    el.classList.add("on");
    draw(0);
    onChange(false);
    window.setTimeout(() => isOpen && el.focus(), 0);
  }

  /** `done`: closed from the strip (a pick, or Esc), so the field takes the keys again. */
  function close(done = false) {
    if (!isOpen) return;
    isOpen = false;
    request++;
    el.classList.remove("on");
    onChange(done);
  }

  return {
    el,
    open,
    close,
    refresh: () => isOpen && draw(0),
    get isOpen() {
      return isOpen;
    },
    get kind(): PickerKind {
      return "target";
    },
  };
}

// ── View ──────────────────────────────────────────────────────────────────────

/** The field's line and its padding above and below, as `.chat-input` in style.css. */
const LINE = 18;
const PAD = 10;
/** The most lines the field shows before it scrolls. */
const MAX_LINES = 6;

/** A message typed into a terminal is one line there: Enter would send its first line alone. */
export const oneLine = (text: string) => text.trim().split(/\s+/).join(" ");

// A session's log starts out long, so the chat's height never follows it (island.ts).
// ── Reading ───────────────────────────────────────────────────────────────────
//
// winotch: the chat is read in a small island, so it reads one exchange at a
// time (the user's call: everything was too small and too long to read).
// - A turn is a question and what came back for it. The console shows the
//   latest one ("Recent") or all of them ("All"), as the switch over the log
//   says (Settings.chatHistory; the user's call: simpler than folding, and it
//   stays light however long a conversation gets).
// - A new turn starts with its question at the top of the log, so an answer is
//   read from its start; "↓" says there is more below.
// - What Claude Code did on the way (its tools) is one quiet line: live while
//   it works, then a count of its steps that opens to the list.
// - Every answer at one size, however short (the user's call: a voice
//   answer set larger than a typed one read as a different chat).
// - The console is as tall as what it shows: empty, it is a command line, the
//   field alone; it grows with the answer up to READ_MAX, and settles as the
//   log changes (the user's call: never an empty box).

/** A question and what came back for it. */
export interface Turn {
  ask: SessionMessage | null;
  rest: SessionMessage[];
}

/** The log in turns: a new one at each of the user's messages. */
export function turnsOf(messages: SessionMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    if (m.role === "user") turns.push({ ask: m, rest: [] });
    else if (turns.length === 0) turns.push({ ask: null, rest: [m] });
    else turns[turns.length - 1].rest.push(m);
  }
  return turns;
}

/**
 * How tall `box`'s content is, whatever height the box itself is given: where
 * its last child ends, and its padding below. Never its scrollHeight, which is
 * at least the box's own height: measured that way, every island that grew
 * made the next measure taller, and the console grew with each click and key.
 * `box` is positioned (style.css), so its children's offsets are from it.
 */
export function contentHeight(box: HTMLElement): number {
  const last = box.lastElementChild as HTMLElement | null;
  if (!last) return 0;
  const pad = parseFloat(getComputedStyle(box).paddingBottom) || 0;
  return last.offsetTop + last.offsetHeight + pad;
}

/** How tall the island may grow to fit what the console shows (island.ts targetSize). */
export const READ_MAX = 520;
/** The island's own frame around the chat card: its padding and the header (style.css #content, #header). */
const ISLAND_CHROME = 8 + 34 + 10;
/** The card's own frame around the log: .chat-body's padding and gap. */
const CARD_CHROME = 12 + 14 + 8;

export function buildPrompt(onHeightChange: () => void, say: (line: SayLine | null) => void = () => {}): ViewHost {
  const log = h("div", { class: "chat-log" });
  const input = h("textarea", {
    class: "chat-input",
    rows: "1",
    spellcheck: "false",
  }) as HTMLTextAreaElement;
  // The field's twin, out of sight: it wraps the text at the field's width to
  // say how many lines it takes, so the field's own height can ease.
  const mirror = h("textarea", {
    class: "chat-mirror",
    rows: "1",
    tabindex: "-1",
    "aria-hidden": "true",
    readonly: "",
  }) as HTMLTextAreaElement;
  const send = h("button", { class: "send-btn", title: tl(STRINGS.send) }, svg(ICONS.arrowUp, 11));

  // Inside the field, by the send button: the session's name and the up-down
  // chevron. It opens the picker; while typing it folds to the chevron.
  const chipName = h("span", { class: "chat-chip-name" });
  const chipLabel = h("span", { class: "chat-chip-label" }, chipName);
  const chip = h(
    "button",
    { class: "chat-chip", "aria-haspopup": "listbox", "aria-expanded": "false" },
    chipLabel,
    svg(ICONS.chevronUpDown, 9, { stroke: 2 }),
  ) as HTMLButtonElement;
  const bar = h("div", { class: "chat-bar" }, input, chip, send, mirror);

  const body = h("div", { class: "chat-body" });
  // Recent or All, over the log: the latest exchange, or the whole conversation.
  const historyRecent = h("button", { class: "chat-history-opt", text: t("Recent") });
  const historyAll = h("button", { class: "chat-history-opt", text: t("All") });
  const historySwitch = h("div", { class: "chat-history", role: "group" }, historyRecent, historyAll);
  // More of the answer below: one tap goes to its end.
  const more = h("button", { class: "chat-more", "aria-label": "↓" }, svg(ICONS.arrowUp, 10, { stroke: 2.2 }));
  const picker = buildPicker(
    {
      session: (target) => {
        // Picking anything, even a quick question again, ends the quick conversation.
        endQuick();
        pickSession(target);
        if (isQuick(target) && isQuick(shownTarget)) drawSession();
      },
      model: (m) => void changeFlag("model", m),
      effort: (e) => void changeFlag("effort", e),
    },
    (done) => {
      body.classList.toggle("picking", picker.isOpen);
      drawChips();
      drawHolds();
      fitHeight();
      if (done) input.focus();
    },
    // The session, named as the chip names it.
    () => chipName.textContent ?? "",
  );
  // The log and its "↓", which stays put while the log scrolls under it.
  // The chip's choices take the field's place, inside the pill (style.css .chat-strip).
  bar.append(picker.el);
  body.append(h("div", { class: "chat-logwrap" }, log, historySwitch, more), bar);

  // winotch: no wash behind the chat (the user's call: it made what is typed
  // harder to read); the card's plain ground, as the other screens have.
  const el = h("div", { class: "view" }, h("div", { class: "card chat-card" }, body));

  let sending = false;
  /** The picked session (or "new:<folder>", or "quick"), whose conversation the log shows. */
  let shownTarget: string | null = null;
  let sessionLog: SessionMessage[] = [];
  /** The quick conversation, kept in this page only: nothing of it is saved. */
  let quickLog: SessionMessage[] = [];
  /** A quick conversation is going on (its `claude` has answered at least once). */
  let quickGoing = false;
  /** The send in flight: its number, the answer so far, the tools it used. */
  let request = 0;
  let streamed = "";
  let streamTools: string[] = [];
  let refresh: number | null = null;
  /** The file stamp of the session last read, so an unchanged one is not read again. */
  let stamp: string | null = null;
  let stampOf: string | null = null;
  /** The session the send in flight runs in, once its stream named it (a new session's included). */
  let streamSession: string | null = null;
  /** What the chat has to say about the last send; stays until the next one or another session. */
  let sessionError: string | null = null;

  /** The chip says what is picked; its label reads all three. */
  function drawChips() {
    const target = State.settings.chatSession;
    const session = target
      ? sessionLabels.get(target) ??
        (isQuick(target) ? t("Quick question") : isNew(target) ? `New session · ${folderName(target.slice(4))}` : "Claude Code session")
      : "Pick a Claude Code session";
    const model = modelName(State.settings.chatModel) || t("Default model");
    const effort = effortName(State.settings.chatEffort);
    const effortLabel = effort ? t("{level} effort", { level: effort }) : t("Default effort");
    chipName.textContent = session;
    const all = `${session} · ${model} · ${effortLabel}`;
    chip.setAttribute("aria-label", all);
    chip.title = all;
    chip.classList.toggle("open", picker.isOpen);
    chip.setAttribute("aria-expanded", String(picker.isOpen));
    chip.disabled = sending;
  }

  /** A session the picker has not listed yet (picked before, or "Open chat"): its name, for the chip. */
  async function nameSession(target: string) {
    for (const x of await ClaudeSessions.list()) {
      if (!sessionLabels.has(x.id)) sessionLabels.set(x.id, `${x.project} · ${x.title}`);
    }
    if (State.settings.chatSession === target) drawChips();
  }

  /** Text in the field, and the keys there: the chip folds to its chevron. */
  function drawTyping() {
    bar.classList.toggle("typing", document.activeElement === input && input.value !== "");
  }

  /** The lines the field shows now. */
  let lines = 1;
  /**
   * The field takes as many lines as its text, up to six (it scrolls past
   * that); the bar grows upward with it and rounds from a pill to a card.
   * Measured on the twin, so the field's height only ever eases between two
   * lengths and never flashes. Only on input: nothing runs while nothing changes.
   */
  function fit() {
    let wanted = 1;
    if (input.value !== "") {
      let width = input.getBoundingClientRect().width;
      if (!width) return; // not laid out: measured again on the next input
      // The chip folding away gives the field its width: measured as it will
      // be, so a line pasted into an empty field never grows and shrinks back.
      if (bar.classList.contains("typing")) width += chipLabel.getBoundingClientRect().width;
      mirror.style.width = `${width}px`;
      mirror.value = input.value;
      wanted = Math.max(1, Math.round((mirror.scrollHeight - PAD) / LINE));
    }
    const shown = Math.min(wanted, MAX_LINES);
    input.classList.toggle("scrolls", wanted > MAX_LINES);
    bar.classList.toggle("multiline", wanted > 1);
    if (shown === lines) return;
    lines = shown;
    input.style.height = `${shown * LINE + PAD}px`;
  }

  /** Something typed, or the chip's choices open: the island stays open for them (State.chatHolds). */
  function drawHolds() {
    const holds = (input.value ?? "").trim() !== "" || picker.isOpen;
    if (holds === State.chatHolds) return;
    State.chatHolds = holds;
    State.notify();
  }

  function drawField() {
    drawTyping();
    drawHolds();
    fit();
    // The field growing a line grows the console with it.
    fitHeight();
  }
  input.addEventListener("input", drawField);
  input.addEventListener("focus", drawTyping);
  input.addEventListener("blur", drawTyping);
  // The chip folding or unfolding changes the field's width: its lines again,
  // once it has settled.
  chipLabel.addEventListener("transitionend", (e) => {
    if ((e as TransitionEvent).propertyName === "grid-template-columns") fit();
  });

  /**
   * What the log keeps in view: the latest question at its top ("turn", after a
   * send or a new answer), its end ("end", once scrolled there), or wherever it
   * was scrolled ("free").
   */
  let follow: "turn" | "end" | "free" = "turn";
  /** The latest turn, drawn last: where "turn" puts the log. */
  let latestTurn: HTMLElement | null = null;
  /** Where the log was put by `anchor`: its own scroll event is not the user's. */
  let placed = -1;
  function anchor() {
    const top = follow === "turn" && latestTurn ? latestTurn.offsetTop - 2 : follow === "end" ? log.scrollHeight : null;
    if (top !== null) {
      log.scrollTop = top;
      placed = log.scrollTop;
    }
    drawMore();
  }
  /** "↓" while there is more of the log below what shows; the edges ease where it goes on (style.css). */
  function drawMore() {
    const below = log.scrollHeight - log.scrollTop - log.clientHeight > 12;
    more.classList.toggle("on", below);
    log.classList.toggle("more-below", below);
    log.classList.toggle("more-above", log.scrollTop > 2);
  }
  log.addEventListener("scroll", () => {
    drawMore();
    if (log.scrollTop === placed) return;
    follow = log.scrollHeight - log.scrollTop - log.clientHeight < 4 ? "end" : "free";
  }, { passive: true });
  more.addEventListener("click", () => {
    follow = "end";
    log.scrollTo({ top: log.scrollHeight, behavior: "smooth" });
  });
  // The field growing, the island growing: the same thing stays in view.
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => anchor()).observe(log);

  /**
   * The room the island gives the console: what it shows, no more. Empty, the
   * field alone; then the log as it fills, or the picker's list, up to READ_MAX.
   */
  function fitHeight() {
    if (State.view !== "prompt" || bar.offsetHeight === 0) return;
    // The chip's choices live inside the field: they never ask for room.
    const content = log.childElementCount ? contentHeight(log) + 4 : 0;
    const wanted = Math.min(READ_MAX, Math.ceil(ISLAND_CHROME + CARD_CHROME + bar.offsetHeight + content));
    // Nothing laid out yet (or a measure that makes no sense): the island keeps its size.
    if (!Number.isFinite(wanted) || wanted <= ISLAND_CHROME) return;
    if (wanted === State.chatReadHeight) return;
    State.chatReadHeight = wanted;
    onHeightChange();
  }

  chip.addEventListener("click", () => {
    if (sending) return;
    if (picker.isOpen) picker.close(true);
    else picker.open("target");
  });
  chip.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key !== "Escape" || !picker.isOpen) return;
    e.preventDefault();
    e.stopPropagation(); // Escape folds the picker first, not the island
    picker.close(true);
  });

  /** The quick conversation ends, and its `claude` with it. */
  function endQuick() {
    if (quickGoing || quickLog.length > 0) void Quick.reset();
    quickGoing = false;
    quickLog = [];
  }

  /**
   * The model or effort chip changed. Saved for what is sent next; a quick
   * conversation starts over with it, and a session open in a terminal is told
   * through that terminal (`/model`, `/effort`), as if typed there.
   */
  async function changeFlag(which: "model" | "effort", value: string) {
    const before = which === "model" ? State.settings.chatModel : State.settings.chatEffort;
    if (value === before) return;
    State.settings = { ...State.settings, [which === "model" ? "chatModel" : "chatEffort"]: value };
    void Bridge.saveSettings(State.settings);
    drawChips();
    picker.refresh();
    const target = State.settings.chatSession;
    if (isQuick(target)) {
      if (quickGoing || quickLog.length > 0) {
        void Quick.reset();
        quickGoing = false;
        // A new model or effort: a new quick conversation, without a word.
        quickLog = [];
        drawSession();
      }
      return;
    }
    if (!target || isNew(target)) return;
    const live = await Consoles.reachable();
    if (!live.includes(target) || State.settings.chatSession !== target) return;
    // Claude Code's own commands; "default" and "auto" are its defaults.
    const command = which === "model" ? `/model ${value || "default"}` : `/effort ${value || "auto"}`;
    try {
      await Consoles.type(target, command);
    } catch (err) {
      sessionError = String(err).replace(/^Error:\s*/, "");
    }
    drawSession();
  }

  function sessionRow(m: SessionMessage): HTMLElement {
    if (m.role === "tool") return h("div", { class: "chat-row tool", text: m.text });
    return bubble({ id: 0, role: m.role, content: m.text });
  }

  /** An answer. */
  function replyRow(text: string): HTMLElement {
    const reply = h("div", { class: "reply" });
    renderMarkdown(reply, text);
    return h("div", { class: "chat-row" }, reply);
  }

  /** What Claude Code did on the way: one line, its count of steps, that opens to the list. */
  function stepsRow(tools: string[]): HTMLElement {
    const list = h("div", { class: "chat-steps-list" }, ...tools.map((text) => h("div", { class: "chat-row tool", text })));
    const head = h("button", { class: "chat-steps", title: tools[tools.length - 1] },
      svg(ICONS.stack, 10), h("span", { text: String(tools.length) }), svg(ICONS.chevronRight, 8, { stroke: 2.2 }));
    const row = h("div", { class: "chat-steps-row" }, head, list);
    head.addEventListener("click", () => {
      row.classList.toggle("open");
      follow = "free";
      fitHeight();
    });
    return row;
  }

  /** A turn in full: its question, its steps folded, its answers. */
  function turnEl(turn: Turn, latest: boolean): HTMLElement {
    const el = h("div", { class: latest ? "chat-turn latest" : "chat-turn" });
    if (turn.ask) el.append(sessionRow(turn.ask));
    let tools: string[] = [];
    const flush = () => {
      if (tools.length) el.append(stepsRow(tools));
      tools = [];
    };
        for (const m of turn.rest) {
      if (m.role === "tool") {
        tools.push(m.text);
        continue;
      }
      flush();
      el.append(m.role === "assistant" ? replyRow(m.text) : sessionRow(m));
    }
    flush();
    return el;
  }

  /** Recent or All: over the log, once there is more than the latest turn. */
  function drawHistorySwitch(earlier: boolean) {
    historySwitch.style.display = earlier ? "" : "none";
    log.classList.toggle("has-history", earlier);
    const all = State.settings.chatHistory === "all";
    historyRecent.classList.toggle("on", !all);
    historyAll.classList.toggle("on", all);
  }
  function showHistory(which: "recent" | "all") {
    if (State.settings.chatHistory === which) return;
    State.settings = { ...State.settings, chatHistory: which };
    void Bridge.saveSettings(State.settings);
    follow = which === "all" ? "end" : "turn";
    drawSession();
  }
  historyRecent.addEventListener("click", () => showHistory("recent"));
  historyAll.addEventListener("click", () => showHistory("all"));

  /** The step Claude Code is on while it answers: one line, in place. */
  function liveStatus(): HTMLElement {
    return h("div", { class: "chat-live" },
      h("i"),
      h("span", { class: "chat-live-text", text: streamTools[streamTools.length - 1] }),
      streamTools.length > 1 ? h("span", { class: "chat-live-count", text: String(streamTools.length) }) : null);
  }

  function drawSession() {
    const scrolled = log.scrollTop;
    clear(log);
    const turns = turnsOf(isQuick(shownTarget) ? quickLog : sessionLog);
    const shown = State.settings.chatHistory === "all" ? turns : turns.slice(-1);
    drawHistorySwitch(turns.length > 1);
    latestTurn = null;
    shown.forEach((turn, i) => {
      const last = i === shown.length - 1;
      const el = turnEl(turn, last && !sending);
      if (last) latestTurn = el;
      log.append(el);
    });
    if (sending) {
      // The answer being written belongs to the question just sent.
      const into = latestTurn ?? log;
      if (streamTools.length) into.append(liveStatus());
      if (streamed) into.append(replyRow(streamed));
      // Until then the island's own mark, by the field, crosses (State.chatAnswering).
    }
    if (sessionError) log.append(h("div", { class: "chat-row tool error", text: sessionError }));
    if (follow === "free") {
      log.scrollTop = scrolled;
      placed = log.scrollTop;
    }
    anchor();
    fitHeight();
  }

  async function loadSession(target: string | null) {
    if (!target || isNew(target) || isQuick(target)) {
      sessionLog = [];
      stampOf = null;
      drawSession();
      return;
    }
    try {
      const read = await ClaudeSessions.messages(target, target === stampOf ? stamp : null);
      if (target !== shownTarget) return;
      stamp = read.stamp;
      stampOf = target;
      const messages = read.messages;
      if (!messages) return;
      const changed = messages.length !== sessionLog.length ||
        messages[messages.length - 1]?.text !== sessionLog[sessionLog.length - 1]?.text;
      // A new question from elsewhere (its terminal) starts at its top too.
      if (turnsOf(messages).length !== turnsOf(sessionLog).length) follow = "turn";
      sessionLog = messages;
      if (changed && !sending) drawSession();
    } catch (err) {
      sessionError = String(err).replace(/^Error:\s*/, "");
      drawSession();
    }
  }

  /** While the chat shows a session, what happens in it elsewhere shows here too. */
  function keepFresh(on: boolean) {
    if (on && refresh === null) {
      refresh = window.setInterval(() => {
        // Stops itself when the chat is no longer on screen: a view that is
        // left is not always told so.
        if (State.mode !== "expanded" || State.view !== "prompt") {
          keepFresh(false);
          return;
        }
        if (!sending && shownTarget && !isNew(shownTarget) && !isQuick(shownTarget)) void loadSession(shownTarget);
      }, 1500);
    } else if (!on && refresh !== null) {
      window.clearInterval(refresh);
      refresh = null;
    }
  }

  // ── Asked by voice (Shift with the dictation key: flow/mod.rs ask) ─────────
  // Asked in the quick conversation without opening the console: the island
  // says what was asked, then writes the answer in, big (views/say.ts). The
  // exchange is the console's too: a click there opens it.
  /** What was said while an answer was still coming: asked once it has come. */
  let queuedAsk: string | null = null;
  /** The ask under way: what was said; null when the console was typed in. */
  let asking: string | null = null;

  async function askAloud(text: string) {
    if (sending) {
      queuedAsk = text;
      return;
    }
    // The quick conversation, whatever the console showed: picking it ends nothing.
    if (!isQuick(State.settings.chatSession)) pickSession(QUICK);
    host.sync();
    asking = text;
    say({ phase: "asking", text });
    await sendQuick(text);
  }

  /** The asked answer has come (or failed): the island says it. */
  function sayAnswer() {
    const heard = asking;
    asking = null;
    if (heard === null) return;
    const answer = streamed || sessionError || "";
    say(answer ? { phase: "answer", text: answer } : null);
  }

  void onEvent<SessionStream>("session-stream", (e) => {
    if (e.request !== request || !sending) return;
    if (e.kind === "start" && e.session) {
      // The session answering is the chat's: its hooks say nothing elsewhere
      // (a quick question's, or a new session's, whose id only comes now).
      State.holdHeadless(e.session);
      if (!isQuick(shownTarget)) streamSession = e.session;
    }
    if (e.kind === "delta" || e.kind === "done") streamed = e.text;
    else if (e.kind === "tool") streamTools.push(e.text);
    else if (e.kind === "error") sessionError = e.text;
    drawSession();
  });

  /** A send that fails says why, here and in winotch's log. */
  async function submitToSession(query: string) {
    try {
      await sendToSession(query);
    } catch (err) {
      sending = false;
      State.stateOverride = null;
      sessionError = String(err).replace(/^Error:\s*/, "") || "Sending failed.";
      void Bridge.log(`chat: send failed before reaching Claude Code: ${sessionError}`);
      drawChips();
      drawSession();
    }
  }

  /** The send's start, shared by headless sends and quick questions. */
  function beginSend() {
    input.value = "";
    drawField();
    sending = true;
    request += 1;
    streamed = "";
    streamTools = [];
    sessionError = null;
    follow = "turn";
    drawChips();
    Sound.play("send");
    State.stateOverride = "thinking";
    State.chatAnswering = true;
    State.notify();
    drawSession();
  }

  /** What waits for the answer under way: opening another session must not cut it off. */
  let afterSend: (() => void)[] = [];

  function endSend() {
    sending = false;
    // After the send has wound up (its answer said, the field back).
    const waiting = afterSend;
    afterSend = [];
    for (const then of waiting) window.setTimeout(then, 0);
    State.stateOverride = null;
    State.chatAnswering = false;
    drawChips();
    State.notify();
  }

  /** A quick question: to the quick conversation's `claude`, logged here only. */
  async function sendQuick(query: string) {
    quickLog = [...quickLog, { role: "user", text: query }];
    beginSend();
    const mine = request;
    try {
      await Quick.send(mine, query, flags());
      if (!isQuick(shownTarget) || mine !== request) return;
      quickGoing = true;
      quickLog = [...quickLog, ...streamTools.map((text) => ({ role: "tool" as const, text })),
        ...(streamed ? [{ role: "assistant" as const, text: streamed }] : [])];
      Sound.play("finish");
    } catch (err) {
      if (mine !== request) return;
      quickLog = [...quickLog, ...streamTools.map((text) => ({ role: "tool" as const, text }))];
      sessionError = String(err).replace(/^Error:\s*/, "");
      Sound.play("error");
    } finally {
      if (mine === request) {
        endSend();
        drawSession();
        sayAnswer();
        // The field only when the console is what shows: an ask by voice opens nothing.
        if (State.chatting) input.focus();
        const next = queuedAsk;
        queuedAsk = null;
        if (next !== null) void askAloud(next);
      }
    }
  }

  async function sendToSession(query: string) {
    const target = State.settings.chatSession;
    void Bridge.log(`chat: send to ${target || "(no session picked)"}`);
    if (!target) {
      picker.open("target");
      return;
    }
    sessionError = null;
    if (isQuick(target)) {
      await sendQuick(query);
      return;
    }
    // Open in a terminal: typed into that terminal, as if typed there. Claude
    // Code takes it like any prompt, queued if it is busy; the log follows.
    const live = await Consoles.reachable();
    void Bridge.log(`chat: ${live.length} reachable session(s); open in a terminal: ${State.isOpenInTerminal(target)}`);
    if (!isNew(target) && live.includes(target)) {
      // Its lines joined by spaces, as typed there (sessions.rs does the same).
      const line = oneLine(query);
      await Consoles.type(target, line);
      input.value = "";
      drawField();
      sessionLog = [...sessionLog, { role: "user", text: line }];
      Sound.play("send");
      drawSession();
      return;
    }
    // Open, but its terminal not known yet (the session ran before winotch's
    // hook reported terminals): the next step it takes tells winotch.
    if (!isNew(target) && State.isOpenInTerminal(target)) {
      sessionError = "winotch does not know this session's terminal yet. It learns it from the session's next step: " +
        "do anything in that terminal, then send again.";
      drawSession();
      return;
    }
    // A session at work in a terminal is left to finish first.
    const busy = State.tasks.find((t) => t.sessionId === target && ["working", "thinking", "searching", "approval", "question"].includes(t.state));
    if (busy) {
      sessionError = "Claude Code is working in this session now. Send when it has finished.";
      drawSession();
      return;
    }
    sessionLog = [...sessionLog, { role: "user", text: query }];
    beginSend();
    // Its own start and end must not read as a terminal's, and its finish is
    // the chat's to show.
    if (!isNew(target)) State.holdHeadless(target);
    try {
      const id = await ClaudeSessions.send(request, target, query, flags());
      // A new session has its id now: the chat goes on in it.
      if (isNew(target) && id) {
        sessionLabels.set(id, `${folderName(target.slice(4))} · ${query.slice(0, 60)}`);
        pickSession(id);
        shownTarget = id;
      }
      Sound.play("finish");
    } catch (err) {
      sessionError = String(err).replace(/^Error:\s*/, "");
      Sound.play("error");
    } finally {
      if (!isNew(target)) State.releaseHeadless(target);
      if (streamSession && streamSession !== target) State.releaseHeadless(streamSession);
      streamSession = null;
      endSend();
      await loadSession(shownTarget);
      drawSession();
      input.focus();
    }
  }

  function submit() {
    const query = input.value.trim();
    void Bridge.log(`chat: submit (${query.length} characters, ${sending ? "still sending the last one" : "ready"})`);
    if (!query || sending) return;
    if (picker.isOpen) picker.close();
    void submitToSession(query);
  }

  send.addEventListener("click", () => submit());
  input.addEventListener("keydown", (e) => {
    const k = e as KeyboardEvent;
    const key = k.key;
    // Enter sends; Shift+Enter is a new line. Enter that ends an IME
    // composition (Japanese, Chinese…) only picks the word.
    if (key === "Enter" && !k.shiftKey && !k.isComposing && k.keyCode !== 229) {
      e.preventDefault();
      submit();
    } else if (key === "Escape" && picker.isOpen) {
      e.preventDefault();
      picker.close();
    }
    e.stopPropagation(); // Escape closes the island, not the chat
  });

  const host: ViewHost = {
    el,
    ask: (text) => void askAloud(text),
    whenIdle(then) {
      if (sending) afterSend.push(then);
      else then();
    },
    sync() {
      const target = State.settings.chatSession || null;
      if (target !== shownTarget) {
        // Leaving a quick question for a session ends it (picked elsewhere too).
        if (isQuick(shownTarget)) endQuick();
        shownTarget = target;
        sessionLog = [];
        stampOf = null;
        sessionError = null;
        follow = "turn";
        void loadSession(target);
        drawSession();
        if (target && !isQuick(target) && !isNew(target) && !sessionLabels.has(target)) void nameSession(target);
      }
      keepFresh(State.view === "prompt" && State.mode === "expanded");
      // Shown: measured now, so the island opens at the console's height. While
      // hidden (an answer said in the notch) it could not be measured.
      if (State.view === "prompt") fitHeight();
      // Leaving the chat folds the picker away.
      if (State.view !== "prompt" && picker.isOpen) picker.close();
      drawChips();
      input.placeholder = !target
        ? "Pick a session first"
        : isQuick(target) ? t("Ask a quick question…") : "Message Claude Code…";
      input.disabled = sending;
    },
    focus() {
      input.focus();
      input.select();
    },
  };
  return host;
}
