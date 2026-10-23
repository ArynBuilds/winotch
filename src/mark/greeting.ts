// The launch greeting: the first scene of the film, in the island. A drop wells
// up, stretches into the dash, and the dot pinches off and settles. Then the
// island's own mark takes over at the same place and size (core/layout.ts,
// VIEW_LAYOUTS.greeting), and when the island shrinks into its notch, that mark
// travels into its place with it.

import { Sound } from "../core/sound";
import { EXPANDED_W } from "../core/layout";
import { BIRTH_END, MarkSvg, birth } from "./liquid";

const T = {
  end: 4.6,
  autoLeave: 4.9,
};

export const GREETING_END = T.end;
export const GREETING_W = EXPANDED_W;
export const GREETING_H = 150;

/** Where the mark is born, and how thick its bars are there. */
const BIG = { x: GREETING_W / 2, y: 75, u: 22 };

const GREETING_SOUND = "greeting";

export class MarkGreeting {
  readonly svg = new MarkSvg("greeting-canvas");
  private startMs = 0;
  private tc = Number.POSITIVE_INFINITY;
  private fired = false;
  private timers: number[] = [];

  onComplete: (() => void) | null = null;

  constructor() {
    this.svg.size(GREETING_W, GREETING_H);
  }

  get el(): SVGSVGElement {
    return this.svg.el;
  }

  start() {
    this.startMs = performance.now();
    this.tc = Number.POSITIVE_INFINITY;
    this.fired = false;
    this.cancelTimers();
    Sound.play(GREETING_SOUND);
    this.timers.push(window.setTimeout(() => this.fire(), (T.end + 0.05) * 1000));
  }

  /** The pointer came in during the greeting: hold it open. */
  hover() {
    if (this.tc >= T.autoLeave) this.tc = Number.POSITIVE_INFINITY;
  }

  /** The pointer left: go to the compact island from now. */
  interrupt() {
    const t = this.elapsed;
    if (!Number.isFinite(this.tc) || this.tc > t) this.tc = t;
    this.cancelTimers();
    Sound.fadeOut(GREETING_SOUND, 0.25);
  }

  /** The greeting view is gone: let what is left of its sound fade away. */
  leave() {
    this.cancelTimers();
    Sound.fadeOut(GREETING_SOUND, 0.2);
  }

  get elapsed(): number {
    return (performance.now() - this.startMs) / 1000;
  }

  get done(): boolean {
    return this.fired;
  }

  /** The birth is over: the island's own mark stands where it ended. */
  get handedOver(): boolean {
    return this.elapsed >= BIRTH_END;
  }

  private fire() {
    if (this.fired) return;
    this.fired = true;
    this.cancelTimers();
    this.onComplete?.();
  }

  private cancelTimers() {
    this.timers.forEach((id) => window.clearTimeout(id));
    this.timers = [];
  }

  draw() {
    const t = this.elapsed;
    if (!this.fired && t >= T.end && this.tc >= T.autoLeave) this.fire();
    const pose = birth(Math.min(t, BIRTH_END));
    // Born: the island's mark is drawn there from now on, and this one goes.
    if (this.handedOver) pose.opacity = 0;
    this.svg.draw(pose, BIG.x, BIG.y, BIG.u);
  }
}
