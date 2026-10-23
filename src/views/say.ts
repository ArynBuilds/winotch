// What was asked by voice, answered in the island (winotch, the user's call).
// Right Shift with the dictation key asks Claude Code (flow/mod.rs ask,
// views/chat.ts); the island opens one line high, all black, nothing else in
// it: what was asked, in the shimmer Claude Code's card shows a step at work
// with, while Claude Code answers; then the answer, exactly as it came. It
// takes as many lines as the answer, up to three (the user's call), shown
// whole: a page comes up from below as the one before goes up, the way the
// ticker on Claude Code's card moves its steps. On each page a light reads
// along, line after line at a calm reading pace, lighting the words it passes,
// so the eye has something to follow; at the page's end the next three come.
// It hugs its words, as the Dynamic Island does (the user's call: no empty
// space beside a short line): as wide as its widest line, the lines balanced
// to about one length, centred.
// Then it folds away (island.ts say); a click opens the console on the exchange.

import { h, clear } from "./dom";
import { State } from "../core/state";
import type { ViewActions, ViewHost } from "./views";

/** The paces the light can read at, in words a minute (Settings → Dictation; Settings.sayPace). */
export const PACES = [200, 250, 300, 350, 400] as const;

/** How many lines it shows at most, how wide they may be, and its timings, in ms. */
export const SAY = {
  lines: 3,
  /** The widest a line may be: the open island's text width (style.css .sayview's padding inside EXPANDED_W). */
  maxWidth: 564,
  /** A page stays this long once read, before the next comes. */
  hold: 700,
  /** One page giving way to the next: the ticker's own step (views/ticker.ts DURATION, EASE). */
  turn: 380,
  ease: "cubic-bezier(0.4, 0, 0.2, 1)",
};

/** The answer as it reads aloud: Markdown's marks gone, a list's items as bullets. */
export function plainAnswer(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*\n?/g, ""))
    .replace(/\*\*|__|`/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .trim();
}

/** `text` cut at words into lines no wider than `width` (as `measure` says), its own line breaks kept. */
export function wrapLines(text: string, width: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (line && measure(next) > width) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/**
 * `text` in as few lines as fit `maxWidth`, but each as short as it can be for
 * that many: the narrowest width that still takes no more lines, so the lines
 * come out about one length instead of long ones and a stub (as text-wrap:
 * balance does). Never narrower than its longest word.
 */
export function balancedLines(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const lines = wrapLines(text, maxWidth, measure);
  if (lines.length <= 1) return lines;
  let lo = Math.max(...text.split(/\s+/).filter(Boolean).map(measure));
  let hi = maxWidth;
  for (let i = 0; i < 14 && hi - lo > 0.5; i++) {
    const mid = (lo + hi) / 2;
    if (wrapLines(text, mid, measure).length <= lines.length) hi = mid;
    else lo = mid;
  }
  return wrapLines(text, hi, measure);
}

/** The lines in pages of `perPage`. */
export function pagesOf(lines: string[], perPage: number): string[][] {
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += Math.max(1, perPage)) pages.push(lines.slice(i, i + Math.max(1, perPage)));
  return pages;
}

/** The pace chosen, in words a minute: one of PACES, else the default. */
export function pace(): number {
  const p = State.settings.sayPace;
  return (PACES as readonly number[]).includes(p) ? p : 300;
}

/** How long the light takes over a line at `wpm` words a minute: never less than about two words' time. */
export function lineFor(line: string, wpm = pace()): number {
  const perWord = 60_000 / wpm;
  return Math.max(Math.round(perWord * 2.35), Math.round(line.split(/\s+/).filter(Boolean).length * perWord));
}

/** How long a page shows: its lines read one after the other, then a moment. */
export function readFor(page: string[], wpm = pace()): number {
  return page.reduce((ms, line) => ms + lineFor(line, wpm), 0) + SAY.hold;
}

/**
 * What was asked, as the island shows it while Claude Code answers: balanced
 * over up to SAY.lines like an answer, a longer one cut at the last line's
 * end. Its start always shows (the user's call: a long question lost it).
 */
export function askedLines(said: string, measure: (s: string) => number): string[] {
  const lines = balancedLines(said.trim(), SAY.maxWidth, measure);
  if (lines.length <= SAY.lines) return lines;
  const kept = lines.slice(0, SAY.lines);
  let last = kept[SAY.lines - 1];
  while (last.includes(" ") && measure(`${last} …`) > SAY.maxWidth) last = last.slice(0, last.lastIndexOf(" "));
  kept[SAY.lines - 1] = `${last} …`;
  return kept;
}

/** How many lines the island shows for an answer of `count` lines: all of them, up to SAY.lines. */
export function linesShown(count: number): number {
  return Math.min(SAY.lines, Math.max(1, count));
}

export interface SayHost extends ViewHost {
  /** The lines the island is tall for now (island.ts targetSize). */
  readonly lines: number;
  /** The width of its widest line, in px: the island is as wide as its words (island.ts targetSize). */
  readonly textWidth: number;
  /** What was asked, dim, while Claude Code answers. */
  asking(text: string): void;
  /** The answer, written in page by page; `done` once its last page has been read. */
  answer(text: string, done: () => void): void;
  /** Stops reading (it folded, or the console took over). */
  stop(): void;
}

export function buildSay(actions: ViewActions, onResize: () => void): SayHost {
  const text = h("div", { class: "say-text" });
  const el = h("div", { class: "view sayview" }, text);
  // A click: the exchange, in the console.
  el.addEventListener("click", () => actions.setView("prompt"));

  /** The lines the island is tall for (one while asking, then the answer's, up to three), and its words' width. */
  let lines = 1;
  let textWidth: number = SAY.maxWidth;
  const sizeFor = (n: number, width: number) => {
    const w = Math.min(SAY.maxWidth, Math.ceil(width) + 4);
    if (n === lines && w === textWidth) return;
    lines = n;
    textWidth = w;
    onResize();
  };

  /** The timers writing and turning the pages; one run at a time. */
  let timers: number[] = [];
  let run = 0;
  const later = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));
  const stop = () => {
    for (const t of timers) window.clearTimeout(t);
    timers = [];
    run += 1;
  };
  const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  /**
   * `page` takes the place of what shows: it comes up from below as that goes
   * up, the ticker's step, both in the same place (style.css .say-text).
   */
  function turnTo(page: HTMLElement) {
    const before = [...text.children] as HTMLElement[];
    text.append(page);
    if (reduced() || typeof page.animate !== "function") {
      for (const old of before) old.remove();
      return;
    }
    const opts = { duration: SAY.turn, easing: SAY.ease };
    for (const old of before) {
      const out = old.animate([{ transform: "none", opacity: 1 }, { transform: "translateY(-60%)", opacity: 0 }], { ...opts, fill: "forwards" });
      out.onfinish = () => old.remove();
    }
    if (before.length) page.animate([{ transform: "translateY(60%)", opacity: 0 }, { transform: "none", opacity: 1 }], opts);
  }

  let ctx: CanvasRenderingContext2D | null = null;
  function measurer(): (s: string) => number {
    ctx ??= document.createElement("canvas").getContext?.("2d") ?? null;
    const style = getComputedStyle(text);
    if (ctx) ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    return (s) => ctx?.measureText(s).width ?? s.length * 8;
  }

  /** Shows `page` whole, the light reading it along line after line; then `next`. */
  function show(page: string[], next: () => void) {
    const mine = run;
    const rows = page.map((line) => h("div", { class: "say-line read", text: line }));
    turnTo(h("div", { class: "say-page" }, ...rows));
    let at = SAY.turn;
    for (const row of rows) {
      const ms = lineFor(row.textContent ?? "");
      if (reduced() || typeof row.animate !== "function") row.classList.add("lit");
      // The light from the line's start to its end, the words it passes lit (style.css .say-line.read).
      // 82.5% → 17.5%: its glow just off the line's start, then just past its end (style.css).
      else row.animate([{ backgroundPosition: "82.5% 0" }, { backgroundPosition: "17.5% 0" }], { duration: ms, delay: at, easing: "linear", fill: "both" });
      at += ms;
    }
    later(at + SAY.hold, () => mine === run && next());
  }

  return {
    el,
    get lines() {
      return lines;
    },
    get textWidth() {
      return textWidth;
    },
    sync() {},
    asking(said) {
      stop();
      // As many lines as what was said takes, up to three, as wide as the widest.
      const measure = measurer();
      const asked = askedLines(said, measure);
      sizeFor(asked.length, Math.max(...asked.map(measure), 0));
      clear(text);
      // At work, as Claude Code's card shows a step (style.css .shimmer).
      text.append(h("div", { class: "say-page asked" }, ...asked.map((line) => h("div", { class: "say-line shimmer", text: line }))));
    },
    answer(answer, done) {
      stop();
      const mine = run;
      const measure = measurer();
      const all = balancedLines(plainAnswer(answer), SAY.maxWidth, measure);
      // As tall as the answer, up to three lines, and as wide as its widest:
      // the island takes that shape as the answer starts, and keeps it.
      sizeFor(linesShown(all.length), Math.max(...all.map(measure), 0));
      const pages = pagesOf(all, SAY.lines);
      const next = (i: number) => {
        if (mine !== run) return;
        if (i >= pages.length) return done();
        show(pages[i], () => next(i + 1));
      };
      next(0);
    },
    stop,
  };
}
