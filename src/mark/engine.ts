// The Tent.js mark in the island. It answers the calls the island makes to
// its character: state, emotes, the dance, the drop's morph.
//
// What it does comes from the brand: a dash is something that stays, a dot is
// something that runs. The dash never moves on its own. The dot stays on the
// pointer's side of the mark: as the pointer passes over the mark, the dot goes
// through the dash with the film's merge, as far as the pointer has gone, and
// lands with the film's recoil on the other side (the user's call: the film's
// crossing, following the pointer around the mark, not thirds of the screen).
// It also pulses, lifts or rests to say what the session is doing. Nothing
// drifts while nothing happens.

import { Sound } from "../core/sound";
import type { BotEmoteName, BotStateName } from "../core/layout";
import {
  LAND_END, MarkSvg, flow, inOutQuad, land, landing, mix, paintPose, scrub, span, type MarkPose,
} from "./liquid";

const now = () => performance.now() / 1000;

/**
 * How far either side of the mark (CSS px) the pointer moves the dot through
 * the dash: past it on the right the mark is the logo, past it on the left the
 * dot sits on the other side, in between it goes through the film's merge.
 */
export const CROSS_BAND = 120;
/** The dot follows through a spring that settles without overshoot, in about this many seconds. */
const FOLLOW_RESPONSE = 0.35;

/**
 * How far over the dot should be, 0 (right, the logo) to 1 (left), for a
 * pointer `x` CSS pixels right of the mark's centre (negative: left of it).
 */
export function overFor(x: number): number {
  return Math.min(1, Math.max(0, (CROSS_BAND - x) / (2 * CROSS_BAND)));
}
/** The bar's thickness against the bot's size. */
const U_OF_SIZE = 0.192;
/** A working dot breathes once in this many seconds. */
const PULSE_PERIOD = 1.2;

const RUNNING: ReadonlySet<BotStateName> = new Set(["working", "thinking", "searching"]);
const WAITING: ReadonlySet<BotStateName> = new Set(["approval", "question"]);

/** A move that plays once: when it started and how long it lasts, in seconds. */
interface Once {
  start: number;
  length: number;
}

const progress = (o: Once | null, n: number) => (o ? (n - o.start) / o.length : 1);
const running = (o: Once | null, n: number) => o !== null && n - o.start < o.length;

export class MarkEngine {
  readonly svg = new MarkSvg("bot-canvas");

  // What the island sets or reads on its character.
  particleOverhang = 0;
  /** Where the pointer is from the mark's centre, in CSS px (+y down); null when unknown: the logo. */
  look: { x: number; y: number } | null = null;
  morph = 0;
  slotH = 0;
  slotHTarget = 0;
  slotHVel = 0;
  tgEs = 1;
  onDizzy: (() => void) | null = null;
  /** 0 to 1: how loud the voice is right now (the Flow pill). The dot swells with it. */
  voiceLevel = 0;

  state: BotStateName = "idle";
  /**
   * winotch: crossing back and forth by itself, through the dash and back, as
   * when dizzy but without its sound or its card: the chat waiting for its
   * answer (island.ts). Since when, so it starts from where the dot is.
   */
  private crossing = false;
  private crossFrom = 0;

  setCrossing(on: boolean) {
    if (on === this.crossing) return;
    this.crossing = on;
    if (on) this.crossFrom = now();
  }

  /** How far over the dot is, 0 (right) to 1 (left), and how fast it is going. */
  private over = 0;
  private overVel = 0;
  /** The last landing, and on which side. */
  private landed: (Once & { side: 1 | -1 }) | null = null;
  private pulse: Once | null = null;
  private pulseSize = 0.3;
  private shake: Once | null = null;
  private squashed: Once | null = null;
  private morphFrom = 0;
  private morphTo = 0;
  private morphMove: Once | null = null;
  private slapTimes: number[] = [];
  private dancing = false;
  private danceLevel = 0;
  /** 0 on the line, 1 lifted off it: a session waiting for an answer. */
  private lift = 0;
  /** 0 awake, 1 the dot resting against the dash. */
  private sleep = 0;
  private t0 = now();
  private pose: MarkPose = scrub(0);

  get el(): SVGSVGElement {
    return this.svg.el;
  }

  setState(next: BotStateName, force = false) {
    if (this.state === next && !force) return;
    this.state = next;
    const n = now();
    switch (next) {
      case "finished":
        this.beat(0.35);
        break;
      case "error":
        this.shake = { start: n, length: 0.3 };
        break;
      case "approval":
      case "question":
        this.beat(0.25);
        break;
    }
  }

  /** One soft pulse of the dot, as when it lands in the film. */
  private beat(size = 0.3) {
    this.pulse = { start: now(), length: 0.45 };
    this.pulseSize = size;
  }

  blink() {
    this.beat(0.18);
  }

  squash() {
    this.squashed = { start: now(), length: 0.37 };
  }

  /** A file dropped in: the dash takes it in. */
  gulp() {
    this.squash();
    this.beat(0.3);
  }

  slap() {
    if (this.state === "dizzy") return;
    const n = now();
    this.slapTimes = this.slapTimes.filter((s) => n - s < 1.7);
    this.slapTimes.push(n);
    Sound.play("slap");
    this.squash();
    if (this.slapTimes.length >= 3) {
      this.slapTimes = [];
      this.onDizzy?.();
    }
  }

  triggerEmote(emote: BotEmoteName, _duration = 1.8) {
    switch (emote) {
      case "annoyed":
        this.shake = { start: now(), length: 0.3 };
        setTimeout(() => Sound.play("annoyed"), 60);
        break;
      case "surprised":
        this.beat(0.4);
        break;
      case "yawn":
        this.squash();
        break;
      default:
        this.beat(0.3);
    }
  }

  animateMorph(target: number, durationMs?: number) {
    this.morphFrom = this.morph;
    this.morphTo = target;
    this.morphMove = { start: now(), length: (durationMs ?? (target > 0.5 ? 550 : 650)) / 1000 };
  }

  resetMorph() {
    this.morphMove = null;
    this.morph = 0;
  }

  setDancing(dancing: boolean) {
    this.dancing = dancing;
  }

  /** Something on its way (a follow, a landing, a pulse): drawn at the screen's rate. */
  get moving(): boolean {
    const n = now();
    return (
      Math.abs(this.wantedOver(n) - this.over) > 0.001 || Math.abs(this.overVel) > 0.001 ||
      running(this.landed, n) ||
      running(this.pulse, n) ||
      running(this.shake, n) ||
      running(this.squashed, n) ||
      running(this.morphMove, n) ||
      this.state === "dizzy" ||
      this.crossing ||
      (this.dancing ? this.danceLevel < 1 : this.danceLevel > 0.001) ||
      Math.abs(this.lift - (WAITING.has(this.state) ? 1 : 0)) > 0.002 ||
      Math.abs(this.sleep - (this.state === "sleeping" ? 1 : 0)) > 0.002
    );
  }

  /**
   * A loop that never ends by itself: a working session's breath, the music's
   * nod. Slow and small, so a few frames a second draw it as well as sixty.
   */
  get looping(): boolean {
    return RUNNING.has(this.state) || WAITING.has(this.state) || this.dancing;
  }

  get busy(): boolean {
    return this.moving || this.looping;
  }

  /** Where the dot should be: the pointer's side (the logo when unknown), unless asleep or dizzy. */
  private wantedOver(n: number): number {
    if (this.state === "sleeping") return this.over;
    // Dizzy: it goes back and forth through the dash by itself.
    if (this.state === "dizzy") return (1 - Math.cos((2 * Math.PI * (n - this.t0)) / 1.4)) / 2;
    // The same, asked for (setCrossing): from the logo's side, over and back.
    if (this.crossing) return (1 - Math.cos((2 * Math.PI * (n - this.crossFrom)) / 1.4)) / 2;
    return this.look ? overFor(this.look.x) : 0;
  }

  update(dt: number) {
    const n = now();

    if (this.morphMove) {
      const p = Math.min(1, progress(this.morphMove, n));
      this.morph = mix(this.morphFrom, this.morphTo, inOutQuad(p));
      if (p >= 1) this.morphMove = null;
    }

    // The dot follows the pointer through a critically damped spring: smooth,
    // never past where it is going, sub-stepped so a slow frame cannot upset it.
    const before = this.over;
    const target = this.wantedOver(n);
    const omega = (2 * Math.PI) / FOLLOW_RESPONSE;
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    for (let i = 0; i < steps; i++) {
      const h = dt / steps;
      this.overVel += (omega * omega * (target - this.over) - 2 * omega * this.overVel) * h;
      this.over = Math.min(1, Math.max(0, this.over + this.overVel * h));
    }
    // Arriving at either end, the dot lands, once.
    if (before < 0.995 && this.over >= 0.995) this.landed = { start: n, length: LAND_END, side: -1 };
    if (before > 0.005 && this.over <= 0.005) this.landed = { start: n, length: LAND_END, side: 1 };


    // Lift and rest follow the state; they ease, they do not bounce.
    const k = 1 - Math.pow(0.004, dt);
    this.lift += ((WAITING.has(this.state) ? 1 : 0) - this.lift) * k;
    this.sleep += ((this.state === "sleeping" ? 1 : 0) - this.sleep) * k;
    this.danceLevel = this.dancing
      ? Math.min(1, this.danceLevel + dt / 0.3)
      : Math.max(0, this.danceLevel - dt / 0.5);

    const p = scrub(this.over);
    if (this.landed && running(this.landed, n)) land(p, this.landed.side, landing(n - this.landed.start));
    const dot = p.dots[0];
    const t = n - this.t0;

    if (dot) {
      // A session at work: the dot breathes, calmly, on a steady beat.
      if (RUNNING.has(this.state) || WAITING.has(this.state)) {
        const breath = (1 - Math.cos((2 * Math.PI * t) / PULSE_PERIOD)) / 2;
        dot.r *= 1 + 0.14 * breath;
      }
      // Waiting for an answer: the dot lifts off the line.
      dot.y -= 1.05 * flow(Math.min(1, this.lift));
      // Asleep: it rests against the dash and the two become one drop.
      const towards = dot.x > 0 ? -1 : 1;
      dot.x += towards * 0.4 * this.sleep;
      p.liquid = Math.max(p.liquid, 0.9 * this.sleep);
      // Music: the dot nods along at 112 beats a minute.
      if (this.danceLevel > 0) {
        const beat = (n * 112) / 60;
        dot.y -= 0.35 * Math.abs(Math.sin(Math.PI * beat)) * this.danceLevel;
      }
      dot.r *= 1 + 0.5 * Math.min(1, this.voiceLevel);
      if (running(this.pulse, n)) {
        dot.r *= 1 + this.pulseSize * Math.sin(Math.PI * flow(progress(this.pulse, n)));
      }
    }
    p.opacity = 1 - 0.35 * this.sleep;

    if (running(this.shake, n)) {
      const s = progress(this.shake, n);
      p.dx = 0.22 * Math.sin(s * Math.PI * 4) * (1 - s);
    }
    if (running(this.squashed, n)) {
      const s = progress(this.squashed, n);
      const dip = s < 0.2 ? span(s, 0, 0.2) : 1 - span(s, 0.2, 1, flow);
      p.sy = 1 - 0.25 * dip;
      p.sx = 1 + 0.12 * dip;
    }
    this.pose = p;
  }

  /**
   * Draws into a `wCss`×`hCss` surface for a bot `size` pixels across, centred
   * in it below the overhang.
   */
  draw(wCss: number, hCss: number, size: number) {
    this.svg.size(wCss, hCss);
    this.svg.draw(this.pose, wCss / 2, hCss / 2 + this.particleOverhang / 2, size * U_OF_SIZE);
  }

  /** The same, painted on a 2D canvas `w`×`h` pixels, for the pages that draw on one. */
  paint(x: CanvasRenderingContext2D, w: number, h: number, size = w) {
    paintPose(x, this.pose, w / 2, h / 2 + this.particleOverhang / 2, size * U_OF_SIZE);
  }
}
