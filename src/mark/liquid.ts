// The Tent.js mark: one dash, one dot, and the liquid that joins them.
// Same geometry, curves and filter as the film (tent-film/src/Lockup.tsx), so
// the island's mark moves exactly like the logo in the video. Drawn as SVG on
// purpose: the film is SVG rendered by Chromium, and so is this.

import { cubicBezier } from "../core/anim";

/** Lengths in units of U, the thickness of every bar. */
export const DASH = 2.3;
export const GAP = 0.45;
/** Dash, gap and dot: the whole sign. */
export const WIDTH = DASH + GAP + 1;
export const HALF = WIDTH / 2;

/** A curve that starts and ends exactly: the bisection behind cubicBezier stops short of 1. */
const exact = (curve: (t: number) => number) => (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : curve(t));

/** tent-film/src/brand.ts */
export const ease = exact(cubicBezier(0.16, 1, 0.3, 1));
export const flow = exact(cubicBezier(0.65, 0, 0.35, 1));
export const outQuad = (t: number) => 1 - (1 - t) * (1 - t);
export const inOutQuad = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export const INK = "#ECECEC";

export const mix = (from: number, to: number, t: number) => from + (to - from) * t;
export const span = (t: number, from: number, to: number, easing: (t: number) => number = ease) =>
  easing(Math.min(1, Math.max(0, (t - from) / (to - from))));
/** 0 to 1 between a and b, held, then back to 0 between c and d (the film's `there`). */
export const there = (t: number, a: number, b: number, c: number, d: number) =>
  t < c ? span(t, a, b, flow) : 1 - span(t, c, d, flow);

/** Everything the mark can be doing at one moment, in units of U from its centre. */
export interface MarkPose {
  dashLeft: number;
  dashRight: number;
  /** 0 to 1: a dash still welling up is a drop that grows. */
  dashHeight: number;
  dots: { x: number; y: number; r: number }[];
  /** How liquid the shapes are. 0 at rest, so a resting mark is drawn exactly. */
  liquid: number;
  /** Whole-mark offset, in U. */
  dx: number;
  dy: number;
  sx: number;
  sy: number;
  opacity: number;
}

/** The mark at rest, its dot on the right (+1, the logo) or on the left (−1). */
export function rest(side: 1 | -1): MarkPose {
  return {
    dashLeft: side > 0 ? -HALF : -HALF + 1 + GAP,
    dashRight: side > 0 ? -HALF + DASH : HALF,
    dashHeight: 1,
    dots: [{ x: side > 0 ? HALF - 0.5 : -HALF + 0.5, y: 0, r: 0.5 }],
    liquid: 0,
    dx: 0, dy: 0, sx: 1, sy: 1, opacity: 1,
  };
}

/**
 * The dot going over to `to`, `t` seconds in. It is the film's birth run on its
 * side: the dash stretches over the dot until they are one drop, then lets go of
 * the far end, and the dot pinches off on the other side and recoils.
 */
export const CROSS_END = 1.25;
export function crossing(to: 1 | -1, t: number): MarkPose {
  const p = rest((-to) as 1 | -1);
  const stretch = span(t, 0, 0.45, flow);
  const pinch = span(t, 0.45, 0.95, flow);
  const recoil = t < 0.95
    ? span(t, 0.8, 0.95, outQuad)
    : 1 - span(t, 0.95, 1.25, inOutQuad);
  // Measured from the side the dot leaves: `near` is the dash end next to it.
  const near = HALF - 1 - GAP;
  const far = -HALF;
  const end = mix(near, HALF, stretch);
  const start = mix(far, -HALF + 1 + GAP, pinch) + recoil * 0.12;
  const dotX = -(HALF - 0.5) - recoil * 0.14;
  // Written for a dot going left; mirrored for one going right.
  const s = -to;
  p.dashLeft = s > 0 ? start : -end;
  p.dashRight = s > 0 ? end : -start;
  p.dots = t < 0.45
    ? [{ x: s * (HALF - 0.5), y: 0, r: 0.5 }]
    : [{ x: s * dotX, y: 0, r: 0.5 }];
  p.liquid = there(t, 0, 0.1, 1.0, 1.25);
  return p;
}

/** Where the crossing's stretch gives way to its pinch, as a share of the way. */
const PINCH_AT = 0.47;

/**
 * The crossing as a place, not a time: `p` is how far the dot has gone from
 * the right (0, the logo) to the left (1), and the pointer moves it. Same
 * stretch and pinch as `crossing`, with no recoil: that is the landing's, and
 * it plays in time once the dot arrives (`land`). The liquid is there only
 * between the ends, so a mark at rest is drawn exactly.
 */
export function scrub(p: number): MarkPose {
  p = Math.min(1, Math.max(0, p));
  const pose = rest(1);
  const stretch = flow(Math.min(1, p / PINCH_AT));
  const pinch = flow(Math.max(0, (p - PINCH_AT) / (1 - PINCH_AT)));
  pose.dashLeft = mix(-HALF, -HALF + 1 + GAP, pinch);
  pose.dashRight = mix(HALF - 1 - GAP, HALF, stretch);
  // The dot goes into the dash on the right and the new one comes out on the
  // left; the swap happens while both are inside the one drop.
  pose.dots = [{ x: p < PINCH_AT ? HALF - 0.5 : -(HALF - 0.5), y: 0, r: 0.5 }];
  pose.liquid = Math.min(1, p / 0.08, (1 - p) / 0.08);
  return pose;
}

/** The landing, `t` seconds after the dot arrived: the film's recoil, 0 → 1 → 0. */
export const LAND_END = 0.45;
export function landing(t: number): number {
  return t < 0.15 ? outQuad(Math.max(0, t) / 0.15) : 1 - inOutQuad(Math.min(1, (t - 0.15) / 0.3));
}

/** `pose` after landing on `side` (+1 right, −1 left), recoiling by `r`. */
export function land(pose: MarkPose, side: 1 | -1, r: number) {
  if (r <= 0) return;
  for (const d of pose.dots) d.x += side * 0.14 * r;
  if (side > 0) pose.dashRight -= 0.12 * r;
  else pose.dashLeft += 0.12 * r;
}

/**
 * The birth from the film's first scene, `t` seconds in: a drop wells up,
 * stretches into the dash, and the dot pinches off it and recoils.
 */
export const BIRTH_END = 1.75;
export function birth(t: number): MarkPose {
  const well = span(t, 0.2, 0.5);
  const stretch = span(t, 0.45, 0.9, flow);
  const pinch = span(t, 0.9, 1.4, flow);
  const recoil = t < 1.4
    ? span(t, 1.25, 1.4, outQuad)
    : 1 - span(t, 1.4, 1.7, inOutQuad);
  const left = mix(-well / 2, -HALF, stretch);
  const right = mix(mix(well / 2, HALF, stretch), -HALF + DASH, pinch) - recoil * 0.12;
  return {
    dashLeft: left,
    dashRight: right,
    dashHeight: well,
    dots: t >= 0.9 ? [{ x: HALF - 0.5 + recoil * 0.14, y: 0, r: 0.5 }] : [],
    liquid: there(t, 0.1, 0.2, 1.5, 1.75),
    dx: 0, dy: 0, sx: 1, sy: 1, opacity: 1,
  };
}

const NS = "http://www.w3.org/2000/svg";
let filters = 0;

/** One drawn mark: an SVG with the film's liquid filter on its shapes. */
/** Sets an attribute only when it changes: a still mark costs nothing to redraw. */
const put = (el: Element, name: string, value: string) => {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
};

export class MarkSvg {
  readonly el: SVGSVGElement;
  private blur: SVGFEGaussianBlurElement;
  private filter: SVGFilterElement;
  private group: SVGGElement;
  private dash: SVGRectElement;
  private dotEls: SVGCircleElement[] = [];
  private filterId = `liquid-${++filters}`;
  private w = 0;
  private h = 0;

  constructor(id?: string) {
    this.el = document.createElementNS(NS, "svg");
    if (id) this.el.id = id;
    this.el.setAttribute("fill", INK);
    const defs = document.createElementNS(NS, "defs");
    // Softens the shapes and cuts them hard again, so that shapes close to each
    // other join like drops of one liquid. The film's numbers, unchanged.
    this.filter = document.createElementNS(NS, "filter");
    this.filter.id = this.filterId;
    this.filter.setAttribute("filterUnits", "userSpaceOnUse");
    this.filter.setAttribute("color-interpolation-filters", "sRGB");
    this.blur = document.createElementNS(NS, "feGaussianBlur");
    this.blur.setAttribute("in", "SourceGraphic");
    const matrix = document.createElementNS(NS, "feColorMatrix");
    matrix.setAttribute("type", "matrix");
    matrix.setAttribute("values", "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 14 -6.5");
    this.filter.append(this.blur, matrix);
    defs.append(this.filter);
    this.group = document.createElementNS(NS, "g");
    this.dash = document.createElementNS(NS, "rect");
    this.group.append(this.dash);
    this.el.append(defs, this.group);
  }

  /** Sizes the drawing surface, in CSS pixels. */
  size(w: number, h: number) {
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.el.setAttribute("width", String(w));
    this.el.setAttribute("height", String(h));
    this.el.setAttribute("viewBox", `0 0 ${w} ${h}`);
    // The filter covers the whole picture, as in the film.
    this.filter.setAttribute("x", "0");
    this.filter.setAttribute("y", "0");
    this.filter.setAttribute("width", String(w));
    this.filter.setAttribute("height", String(h));
  }

  /** Draws `pose` with its centre at (cx, cy) and a bar `u` pixels thick. */
  draw(pose: MarkPose, cx: number, cy: number, u: number) {
    const x = (v: number) => cx + (pose.dx + v * pose.sx) * u;
    const y = (v: number) => cy + (pose.dy + v * pose.sy) * u;
    const blur = 0.27 * u * pose.liquid;
    put(this.blur, "stdDeviation", blur.toFixed(3));
    // The film turns the filter off below 0.4 px of blur. At the island's size a
    // faint blur, cut hard, leaves jagged edges, and by then the shapes are apart:
    // so it also goes off once the liquid is nearly gone.
    if (blur > 0.4 && pose.liquid > 0.3) put(this.group, "filter", `url(#${this.filterId})`);
    else if (this.group.hasAttribute("filter")) this.group.removeAttribute("filter");
    put(this.group, "opacity", pose.opacity.toFixed(3));

    const height = pose.dashHeight * pose.sy * u;
    const left = x(pose.dashLeft);
    const width = Math.max(0, x(pose.dashRight) - left);
    put(this.dash, "x", left.toFixed(2));
    put(this.dash, "y", (y(0) - height / 2).toFixed(2));
    put(this.dash, "width", width.toFixed(2));
    put(this.dash, "height", Math.max(0, height).toFixed(2));
    put(this.dash, "rx", (Math.min(height, width) / 2).toFixed(2));

    while (this.dotEls.length < pose.dots.length) {
      const c = document.createElementNS(NS, "circle");
      this.group.append(c);
      this.dotEls.push(c);
    }
    this.dotEls.forEach((c, i) => {
      const d = pose.dots[i];
      if (!d) {
        put(c, "r", "0");
        return;
      }
      put(c, "cx", x(d.x).toFixed(2));
      put(c, "cy", y(d.y).toFixed(2));
      put(c, "r", Math.max(0, d.r * u * Math.min(pose.sx, pose.sy)).toFixed(2));
    });
  }
}

/**
 * Paints `pose` on a 2D canvas, for the pages that draw on one (the hub's band,
 * the recap image, the drop sequence). No liquid here: these marks stand still
 * or move without crossing, and the liquid only shows while shapes meet.
 */
export function paintPose(
  x: CanvasRenderingContext2D, pose: MarkPose, cx: number, cy: number, u: number, color = INK,
) {
  const px = (v: number) => cx + (pose.dx + v * pose.sx) * u;
  const py = (v: number) => cy + (pose.dy + v * pose.sy) * u;
  x.save();
  x.globalAlpha *= pose.opacity;
  x.fillStyle = color;
  const height = pose.dashHeight * pose.sy * u;
  const left = px(pose.dashLeft);
  const width = Math.max(0, px(pose.dashRight) - left);
  if (width > 0 && height > 0) {
    x.beginPath();
    x.roundRect(left, py(0) - height / 2, width, height, Math.min(height, width) / 2);
    x.fill();
  }
  for (const d of pose.dots) {
    x.beginPath();
    x.arc(px(d.x), py(d.y), Math.max(0, d.r * u * Math.min(pose.sx, pose.sy)), 0, Math.PI * 2);
    x.fill();
  }
  x.restore();
}
