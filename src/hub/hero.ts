// The band on top of each page of the main window: the brand's flat panel and
// the page's mark standing on its floor, its dot answering the pointer. Also
// the cards and the marks of empty pages. Coucou's version (FlowHubMochis.swift)
// had colours, drifting particles and walking characters; the brand has none of them.
//
// One animation loop draws every live canvas, and only those that need it: a
// canvas is drawn when it is new, resized or poked (the pointer, a click), and
// again for as long as its mark moves. A still page costs nothing, even in a
// window open behind others, which Windows still reports as visible.

import { MarkEngine } from "../mark/engine";
import { PANEL } from "../core/brand";
import type { BotStateName } from "../core/layout";

/** What a canvas needs after a draw: nothing, a few frames a second (a mark breathing), or every frame. */
const enum Motion {
  Still,
  Slow,
  Moving,
}

interface Animated {
  el: HTMLCanvasElement;
  draw(dt: number, t: number): Motion;
  /** Drawn and still: skipped until poked. */
  still?: boolean;
  /** Pages are built before they are put in the window: dropped only once gone. */
  shown?: boolean;
  born?: number;
}

/** A loop that never ends by itself (a working mark's breath) is drawn at 24 frames a second. */
const SLOW_FRAME_MS = 1000 / 24;

const live = new Set<Animated>();
let frame: number | null = null;
let slowTimer: number | null = null;
let last = performance.now();
const start = performance.now();

function loop(now: number) {
  frame = null;
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const t = (now - start) / 1000;
  let need = Motion.Still;
  for (const a of live) {
    if (!a.el.isConnected) {
      // Built but not shown yet: wait for it (a few seconds at most).
      if (a.shown || now - (a.born ??= now) > 5000) live.delete(a);
      else need = Math.max(need, Motion.Slow);
      continue;
    }
    a.shown = true;
    if (a.still) continue;
    const motion = a.draw(dt, t);
    a.still = motion === Motion.Still;
    need = Math.max(need, motion);
  }
  if (document.visibilityState !== "visible" || need === Motion.Still) return;
  if (need === Motion.Moving) {
    frame = requestAnimationFrame(loop);
  } else {
    slowTimer = window.setTimeout(() => {
      slowTimer = null;
      frame = requestAnimationFrame(loop);
    }, SLOW_FRAME_MS);
  }
}

function wake() {
  if (live.size === 0 || document.visibilityState !== "visible" || frame !== null) return;
  if (slowTimer !== null) {
    window.clearTimeout(slowTimer);
    slowTimer = null;
  } else {
    last = performance.now();
  }
  frame = requestAnimationFrame(loop);
}

/** Something changed for `a` (the pointer, a click): draw it again. */
function poke(a: Animated) {
  a.still = false;
  wake();
}

document.addEventListener("visibilitychange", () => {
  for (const a of live) a.still = false;
  wake();
});

const resized = new ResizeObserver((entries) => {
  for (const entry of entries) for (const a of live) if (a.el === entry.target) a.still = false;
  wake();
});

function add(a: Animated) {
  live.add(a);
  resized.observe(a.el);
  wake();
}

/** What a mark's engine still needs drawn. */
const motionOf = (engine: MarkEngine): Motion =>
  engine.moving ? Motion.Moving : engine.looping ? Motion.Slow : Motion.Still;

function fit(canvas: HTMLCanvasElement): { w: number; h: number; ctx: CanvasRenderingContext2D | null } {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h, ctx };
}

/** The brand's one colour, at `alpha`. */
const inkAt = (alpha: number) => `rgba(236,236,236,${Math.max(0, Math.min(1, alpha))})`;

// ── The backdrop ──────────────────────────────────────────────────────────────

/**
 * The band behind a page: the brand's panel, flat. Coucou had a breathing colour
 * and drifting particles here; the brand has no glow, no gradient and no
 * particles, and nothing moves while nothing happens.
 */
export function backdrop(canvas: HTMLCanvasElement, _color: string, _pointerFrom: HTMLElement, radius = 18) {
  add({
    el: canvas,
    draw() {
      const { w, h, ctx } = fit(canvas);
      if (!ctx || w === 0) return Motion.Still;
      ctx.clearRect(0, 0, w, h);
      ctx.beginPath();
      ctx.roundRect(0, 0, w, h, radius);
      ctx.fillStyle = PANEL;
      ctx.fill();
      return Motion.Still;
    },
  });
}

// ── The marks ─────────────────────────────────────────────────────────────────

export interface MarkSpec {
  /** The square the mark is drawn in, in CSS pixels. */
  size: number;
  /** Where it stands along the floor, 0…1. */
  start: number;
  state?: BotStateName;
}

/**
 * The page's marks on the band's floor, in the right part of `canvas`. A mark
 * stands where it is: only its dot answers the pointer, and a poke squashes it.
 */
export function troupe(canvas: HTMLCanvasElement, cast: MarkSpec[], width: number) {
  const marks = cast.map((spec) => {
    const engine = new MarkEngine();
    engine.setState(spec.state ?? "idle", true);
    return { spec, engine, x: 0 };
  });
  let pointer: { x: number; y: number } | null = null;
  let placed = false;
  canvas.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
    poke(animated);
  });
  canvas.addEventListener("pointerleave", () => {
    pointer = null;
    poke(animated);
  });
  canvas.addEventListener("click", (e) => {
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    for (const m of marks) if (Math.abs(px - m.x) < m.spec.size * 0.4) m.engine.slap();
    poke(animated);
  });

  const animated: Animated = {
    el: canvas,
    draw(dt) {
      const { w: cw, h: ch, ctx } = fit(canvas);
      if (!ctx || cw === 0) return Motion.Still;
      const left = Math.max(0, cw - width - 18);
      const right = cw - 18;
      if (!placed) {
        placed = true;
        for (const m of marks) m.x = left + m.spec.size / 2 + (right - left - m.spec.size) * m.spec.start;
      }
      ctx.clearRect(0, 0, cw, ch);
      for (const m of marks) {
        const box = m.spec.size;
        // The dot follows the pointer around the mark (its centre).
        m.engine.look = pointer ? { x: pointer.x - m.x, y: pointer.y - (ch - 8 - box * 0.78 + box / 2) } : null;
        m.engine.update(dt);
        ctx.save();
        ctx.translate(m.x - box / 2, ch - 8 - box * 0.78);
        m.engine.paint(ctx, box, box);
        ctx.restore();
      }
      return Math.max(Motion.Still, ...marks.map((m) => motionOf(m.engine)));
    },
  };
  add(animated);
}

/** One mark alone (the sidebar's logo, an empty page). */
export function liveMark(canvas: HTMLCanvasElement, _color?: string, state: BotStateName = "idle") {
  const engine = new MarkEngine();
  engine.setState(state, true);
  let mouse: { x: number; y: number } | null = null;
  const animated: Animated = {
    el: canvas,
    draw(dt) {
      const { w, h, ctx } = fit(canvas);
      if (!ctx || w === 0) return Motion.Still;
      if (mouse) engine.look = { x: mouse.x, y: mouse.y };
      engine.update(dt);
      ctx.clearRect(0, 0, w, h);
      engine.paint(ctx, w, h);
      return motionOf(engine);
    },
  };
  canvas.addEventListener("click", () => {
    engine.slap();
    poke(animated);
  });
  const follow = (e: PointerEvent) => {
    // Gone with its page: stop listening, or every old page's mark stays hooked here.
    if (!canvas.isConnected && animated.shown) {
      window.removeEventListener("pointermove", follow);
      return;
    }
    const r = canvas.getBoundingClientRect();
    mouse = { x: e.clientX - (r.left + r.width / 2), y: e.clientY - (r.top + r.height / 2) };
    poke(animated);
  };
  window.addEventListener("pointermove", follow);
  add(animated);
  return engine;
}

// ── Page themes ───────────────────────────────────────────────────────────────

export interface Theme {
  cast: MarkSpec[];
}

/** Each page: one mark, in a state that suits it. */
export const THEMES: Record<string, Theme> = {
  dictation: { cast: [{ size: 66, start: 0.7 }] },
  notes: { cast: [{ size: 62, start: 0.7 }] },
  insights: { cast: [{ size: 62, start: 0.7 }] },
  dictionary: { cast: [{ size: 62, start: 0.7 }] },
  snippets: { cast: [{ size: 62, start: 0.7, state: "working" }] },
  styles: { cast: [{ size: 62, start: 0.7 }] },
  flowsettings: { cast: [{ size: 62, start: 0.7, state: "sleeping" }] },
  general: { cast: [{ size: 62, start: 0.7 }] },
  pills: { cast: [{ size: 62, start: 0.7 }] },
  agents: { cast: [{ size: 62, start: 0.7, state: "working" }] },
  chat: { cast: [{ size: 62, start: 0.7, state: "thinking" }] },
  integrations: { cast: [{ size: 62, start: 0.7 }] },
  voice: { cast: [{ size: 62, start: 0.7 }] },
  shortcuts: { cast: [{ size: 62, start: 0.7 }] },
};

/** The band itself: title, line, actions, and the marks. */
export function hero(page: string, title: string, subtitle: string | null, actions: HTMLElement[] = [], compact = false): HTMLElement {
  const theme = THEMES[page] ?? THEMES.general;
  const el = document.createElement("div");
  el.className = compact ? "hub-hero compact" : "hub-hero";
  el.style.setProperty("--hero-line", inkAt(0.16));
  const back = document.createElement("canvas");
  back.className = "backdrop";
  const marks = document.createElement("canvas");
  marks.className = "troupe";
  const copy = document.createElement("div");
  copy.className = "copy";
  const h1 = document.createElement("h1");
  h1.textContent = title;
  copy.append(h1);
  if (subtitle) {
    const p = document.createElement("p");
    p.textContent = subtitle;
    copy.append(p);
  }
  if (actions.length) {
    const row = document.createElement("div");
    row.className = "actions";
    row.append(...actions);
    copy.append(row);
  }
  el.append(back, marks, copy);
  backdrop(back, "", el);
  troupe(marks, theme.cast, compact ? 280 : 340);
  return el;
}

/** A card in a colour: the band's black and particles behind `content`. */
export function glowCard(color: string, ...content: (HTMLElement | string)[]): HTMLElement {
  const el = document.createElement("div");
  el.className = "hub-glow";
  el.style.setProperty("--glow-line", inkAt(0.18));
  const canvas = document.createElement("canvas");
  const inner = document.createElement("div");
  inner.className = "inner";
  inner.append(...content);
  el.append(canvas, inner);
  backdrop(canvas, color, el, 14);
  return el;
}

/** An empty page: a mark asleep, and a line. */
export function emptyState(text: string, state: BotStateName = "sleeping", color = "#F5F6F8"): HTMLElement {
  const el = document.createElement("div");
  el.className = "hub-empty";
  const canvas = document.createElement("canvas");
  const p = document.createElement("div");
  p.textContent = text;
  el.append(canvas, p);
  liveMark(canvas, color, state);
  return el;
}
