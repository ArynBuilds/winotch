// The middle of the compact notch, between the mark and the bell (winotch):
// everything the Flow pill used to show, keys only, nothing to click.
//
//   dictating (the key held, hands-free, the words being written)  the bars
//   asking Claude Code (Shift with the key held)                    the bars, sent: an arrow
//   a short message ("Copied — Ctrl+V to paste"…)                   a line of text
//   « OK Tent »: what you said, then its answer                     a line of text
//   a call being recorded                                           a dot and its clock
//
// Rust sends the whole state as `flow-notch` (src-tauri/src/flow/notch.rs) and
// the bars' levels as `flow-bands` about 30 times a second while you speak.
// While something shows, the island keeps its compact notch up (`onHold`).
//
// Lightweight: nothing runs while nothing shows, or while the notch is not the
// compact one. The bars draw at the screen's rate only while you speak; the
// slow wave while the words are written at 24 frames a second; a call's clock
// once a second; a long answer turns its pages on a timer.

import { Bridge, onEvent } from "../core/bridge";
import { FlowBridge, clock, type NotchState } from "../core/flow";
import { COMPACT_W } from "../core/layout";
import { t } from "../i18n/i18n";
import { svg } from "../views/dom";
import { ICONS } from "../views/icons";

const BANDS = 9;
/** The slot's sides, from the island's edges: clear of the mark and of the bell. */
const SIDE = 60;
/** How long a line or the bars take to fade (style.css, #flow-slot). */
const FADE_MS = 160;
const SLOW_FRAME_MS = 1000 / 24;

type Content =
  | { kind: "bars"; key: string }
  | { kind: "text"; key: string; text: string }
  | { kind: "note"; key: string };

export class FlowSlot {
  readonly el: HTMLElement;
  /** Something shows (true) or nothing any more (false): the island holds its compact notch. */
  onHold: ((on: boolean) => void) | null = null;

  private state: NotchState = { phase: "idle", noteStartedAt: null, message: null, voice: null, ask: false };
  /** The compact notch is on screen. */
  private visible = false;
  private held = false;
  private current: { key: string; el: HTMLElement } | null = null;

  private bars: HTMLElement[] = [];
  private readonly levels = new Array<number>(BANDS).fill(0);
  private readonly target = new Array<number>(BANDS).fill(0);
  private frame: number | null = null;
  private slowFrame: number | null = null;
  private last = 0;

  private clockEl: HTMLElement | null = null;
  private clockTimer: number | null = null;

  /** A long answer, cut into lines that fit, shown one after the other. */
  private pages: { text: string; lines: string[]; index: number } | null = null;
  private pageTimer: number | null = null;

  constructor() {
    this.el = document.createElement("div");
    this.el.id = "flow-slot";
    this.el.setAttribute("aria-live", "polite");
  }

  /** Reads what shows now, then follows Rust. */
  async start() {
    void onEvent<NotchState>("flow-notch", (s) => this.apply(s));
    void onEvent<number[]>("flow-bands", (bands) => {
      for (let i = 0; i < BANDS; i++) this.target[i] = bands[i] ?? 0;
      this.wake();
    });
    const now = await FlowBridge.notchState();
    if (now) this.apply(now);
  }

  /** The island says whether its compact notch is what shows. */
  setVisible(on: boolean) {
    if (on === this.visible) return;
    if (on && this.state.phase !== "idle") void Bridge.log("flow notch: shown");
    this.visible = on;
    this.render();
  }

  private apply(next: NotchState) {
    // What the island was told, in winotch.log: a dictation that shows nothing
    // is told apart from one that never started.
    if (next.phase !== this.state.phase) void Bridge.log(`flow notch: ${next.phase}${this.visible ? "" : " (notch not shown yet)"}`);
    if (next.phase === "listening" && this.state.phase !== "listening") this.target.fill(0);
    this.state = next;
    this.render();
  }

  // ── What shows ──────────────────────────────────────────────────────────────

  private content(): Content | null {
    const s = this.state;
    if (s.phase !== "idle") return { kind: "bars", key: s.ask ? "bars-ask" : "bars" };
    if (s.message) return { kind: "text", key: `m${s.message.id}`, text: s.message.text };
    if (s.voice) {
      const v = s.voice;
      if (v.answer) {
        const line = this.page(v.answer);
        return { kind: "text", key: `a${this.pages?.index ?? 0}|${v.answer}`, text: line };
      }
      const text = v.heard || t("Listening…");
      return { kind: "text", key: `h|${text}`, text };
    }
    if (s.noteStartedAt) return { kind: "note", key: "note" };
    return null;
  }

  private render() {
    if (!this.state.voice?.answer) this.dropPages();
    const c = this.content();
    const key = c?.key ?? "";
    if (key !== (this.current?.key ?? "")) {
      const old = this.current;
      if (old) {
        old.el.classList.remove("in");
        window.setTimeout(() => old.el.remove(), FADE_MS + 20);
      }
      this.current = null;
      this.bars = [];
      this.clockEl = null;
      if (c) {
        const el = this.build(c);
        this.el.append(el);
        // Laid out at opacity 0 first, so the fade in runs.
        void el.offsetWidth;
        el.classList.add("in");
        this.current = { key, el };
      }
    }
    this.el.classList.toggle("on", this.visible && c !== null);
    const hold = c !== null;
    if (hold !== this.held) {
      this.held = hold;
      this.onHold?.(hold);
    }
    this.syncLoops();
  }

  private build(c: Content): HTMLElement {
    const el = document.createElement("div");
    el.className = `fs-item fs-${c.kind}`;
    switch (c.kind) {
      case "bars":
        // Asked of Claude Code: the bars go off with an arrow, as a message sent.
        if (c.key === "bars-ask") el.append(svg(ICONS.arrowUp, 9, { stroke: 2.4 }));
        for (let i = 0; i < BANDS; i++) {
          const bar = document.createElement("i");
          el.append(bar);
          this.bars.push(bar);
        }
        break;
      case "text":
        el.textContent = c.text;
        break;
      case "note": {
        const dot = document.createElement("span");
        dot.className = "fs-rec";
        this.clockEl = document.createElement("span");
        this.clockEl.className = "fs-clock";
        // Ticking every second: not for a screen reader to read out each time.
        this.clockEl.setAttribute("aria-hidden", "true");
        this.clockEl.textContent = this.noteClock();
        el.append(dot, this.clockEl);
        break;
      }
    }
    return el;
  }

  // ── A long answer, page by page ─────────────────────────────────────────────

  /** The line of `answer` that shows now; starts its pages when it is new. */
  private page(answer: string): string {
    if (this.pages?.text !== answer) {
      this.dropPages();
      this.pages = { text: answer, lines: fitLines(answer, this.width()), index: 0 };
      this.schedulePage();
    }
    return this.pages.lines[this.pages.index] ?? answer;
  }

  /** About the pace the answer is said at; the last line stays until the answer goes. */
  private schedulePage() {
    const p = this.pages;
    if (!p || p.index >= p.lines.length - 1) return;
    const words = p.lines[p.index].split(/\s+/).filter(Boolean).length;
    this.pageTimer = window.setTimeout(() => {
      this.pageTimer = null;
      if (this.pages !== p) return;
      p.index += 1;
      this.render();
      this.schedulePage();
    }, Math.max(1400, 400 + words * 380));
  }

  private dropPages() {
    if (this.pageTimer !== null) window.clearTimeout(this.pageTimer);
    this.pageTimer = null;
    this.pages = null;
  }

  /** The slot's width in the settled compact notch (the island may still be growing into it). */
  private width(): number {
    return COMPACT_W - 2 * SIDE - 4;
  }

  // ── Loops, only while they show ─────────────────────────────────────────────

  private syncLoops() {
    const kind = this.visible ? this.contentKind() : null;
    if (kind === "bars") this.wake();
    else this.stopBars();
    if (kind === "note") this.scheduleClock();
    else if (this.clockTimer !== null) {
      window.clearTimeout(this.clockTimer);
      this.clockTimer = null;
    }
  }

  private contentKind(): Content["kind"] | null {
    if (!this.current) return null;
    if (this.current.key.startsWith("bars")) return "bars";
    if (this.current.key === "note") return "note";
    return "text";
  }

  /** Speaking: every frame the screen draws. Thinking: a slow wave, 24 a second. */
  private wake() {
    if (!this.visible || this.contentKind() !== "bars") return;
    if (this.frame !== null) return;
    if (this.slowFrame !== null) {
      if (this.state.phase === "thinking") return;
      window.clearTimeout(this.slowFrame);
      this.slowFrame = null;
    }
    this.last = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  private stopBars() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    if (this.slowFrame !== null) window.clearTimeout(this.slowFrame);
    this.frame = null;
    this.slowFrame = null;
    this.levels.fill(0);
  }

  private tick = (now: number) => {
    this.frame = null;
    if (!this.visible || this.contentKind() !== "bars") return;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const thinking = this.state.phase === "thinking";
    let settled = true;
    for (let i = 0; i < BANDS; i++) {
      const goal = thinking ? 0.25 + 0.25 * Math.sin(now / 160 - i * 0.7) : this.target[i];
      this.levels[i] += (goal - this.levels[i]) * Math.min(1, dt * 14);
      settled &&= Math.abs(goal - this.levels[i]) < 0.002;
      const bar = this.bars[i];
      if (bar) bar.style.height = `${(3.4 + 14 * Math.max(0, this.levels[i])).toFixed(2)}px`;
    }
    if (thinking) {
      this.slowFrame = window.setTimeout(() => {
        this.slowFrame = null;
        this.frame = requestAnimationFrame(this.tick);
      }, SLOW_FRAME_MS);
    } else if (!settled) {
      // The next levels (flow-bands) wake it again.
      this.frame = requestAnimationFrame(this.tick);
    }
  };

  private noteClock(): string {
    const started = this.state.noteStartedAt ?? Date.now();
    return clock((Date.now() - started) / 1000);
  }

  /** The call's clock, on the second. */
  private scheduleClock() {
    if (this.clockTimer !== null) return;
    const started = this.state.noteStartedAt ?? Date.now();
    const toNext = 1000 - ((Date.now() - started) % 1000) + 5;
    this.clockTimer = window.setTimeout(() => {
      this.clockTimer = null;
      if (this.clockEl) this.clockEl.textContent = this.noteClock();
      if (this.visible && this.contentKind() === "note") this.scheduleClock();
    }, toNext);
  }
}

let measureCtx: CanvasRenderingContext2D | null = null;

/** `text` cut at word boundaries into lines no wider than `width` px, in the slot's font. */
export function fitLines(text: string, width: number): string[] {
  measureCtx ??= document.createElement("canvas").getContext?.("2d") ?? null;
  const ctx = measureCtx;
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!ctx || words.length === 0) return [text];
  ctx.font = `500 12px ${getComputedStyle(document.body).fontFamily}`;
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > width) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}
