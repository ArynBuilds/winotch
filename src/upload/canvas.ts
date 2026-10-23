// The upload canvas — port of UploadCanvasView.swift.
//
// While the sequence engine is active this canvas draws the whole island body:
// card, dashed drop frame, drop text, progress bar, the choose card, the mark
// and the file being sucked in. The island's own mark is hidden for the
// duration, exactly as on macOS, because this canvas draws its own.

import { State } from "../core/state";
import { paintPose, rest } from "../mark/liquid";
import { SCRIPT_FONTS } from "../core/fonts";
import { N_, isRtl, t } from "../i18n/i18n";
import {
  USC, eIn, eInOut, eOut, lerp, progressAt,
  type UploadFrame,
} from "./sequence";

const FONT = `system-ui, "Segoe UI Variable Text", "Segoe UI", ${SCRIPT_FONTS}, sans-serif`;

/** The card's inner right edge: no text runs past it. */
const TEXT_RIGHT = USC.CARD_X + USC.CARD_W - 16;
/** The two choose buttons, as drawn and as hit areas. */
const ASK_BTN = { x: 114, w: 168 };
const CANCEL_BTN = { x: 290, w: 120 };
/** Drop-zone chips (English keys, shown with `t()`). */
const CHIPS = [N_("PDF"), N_("Images"), N_("Code"), N_("Docs")];

/** Mirrors the reference `rr()`: a rounded rect, radius clamped to the box. */
function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, rad);
}

/** Superellipse body — port of usBodyPath(m, R). */
function text(
  ctx: CanvasRenderingContext2D,
  s: string,
  x: number,
  y: number,
  font: string,
  color: string,
  align: CanvasTextAlign = "left",
) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  // Arabic orders its words right to left; the anchor (left, centre, right) stays put.
  ctx.direction = isRtl() ? "rtl" : "ltr";
  // SwiftUI's .leading / .center / .trailing anchors are vertically centred.
  ctx.textBaseline = "middle";
  ctx.fillText(s, x, y);
}

/**
 * The font that fits `s` in `maxW`: `weight size FONT`, or smaller down to
 * `minSize` for a longer translation. English was laid out for these widths
 * and keeps its size (only an overlong file name can make it shrink).
 */
export function fitFont(
  ctx: CanvasRenderingContext2D,
  s: string,
  maxW: number,
  weight: number,
  size: number,
  minSize = size * 0.75,
): string {
  let px = size;
  ctx.font = `${weight} ${px}px ${FONT}`;
  while (ctx.measureText(s).width > maxW && px > minSize) {
    px = Math.max(minSize, px - 0.5);
    ctx.font = `${weight} ${px}px ${FONT}`;
  }
  return ctx.font;
}

/** `s` cut with an ellipsis so it fits `maxW` in `font` (a file name that is too long). */
export function ellipsize(ctx: CanvasRenderingContext2D, s: string, maxW: number, font: string): string {
  ctx.font = font;
  if (ctx.measureText(s).width <= maxW) return s;
  let cut = s;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxW) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** A label that fits `maxW`: a smaller font first, then an ellipsis. */
function fitted(ctx: CanvasRenderingContext2D, s: string, maxW: number, weight: number, size: number) {
  const font = fitFont(ctx, s, maxW, weight, size);
  return { font, s: ellipsize(ctx, s, maxW, font) };
}

export interface UploadCanvasActions {
  /** Primary button — hand the file to the chat. */
  ask(): void;
  /** Secondary button. */
  cancel(): void;
}

export class UploadCanvas {
  /** Wrapper holding the canvas and the two invisible choose buttons. */
  readonly el: HTMLElement;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private overlay: HTMLElement;
  private sizedFor = 0;

  constructor(actions: UploadCanvasActions) {
    this.canvas = document.createElement("canvas");
    this.canvas.id = "upload-canvas";

    // Invisible hit areas at the reference button positions. The labels are
    // painted on the canvas; these only catch the click.
    const mk = (x: number, w: number, onclick: () => void) => {
      const b = document.createElement("button");
      b.className = "upload-hit";
      b.style.left = `${x}px`;
      b.style.top = "113px";
      b.style.width = `${w}px`;
      b.style.height = "26px";
      b.addEventListener("click", onclick);
      return b;
    };
    this.overlay = document.createElement("div");
    this.overlay.id = "upload-overlay";
    this.overlay.append(mk(ASK_BTN.x, ASK_BTN.w, actions.ask), mk(CANCEL_BTN.x, CANCEL_BTN.w, actions.cancel));

    this.el = document.createElement("div");
    this.el.id = "upload-layer";
    this.el.append(this.canvas, this.overlay);

    this.ctx = this.canvas.getContext("2d");
  }

  /** `wallTime` in seconds drives the marching dashes, like the macOS timeline. */
  draw(f: UploadFrame, wallTime: number) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.sizedFor !== dpr) {
      this.sizedFor = dpr;
      this.canvas.width = Math.round(USC.W * dpr);
      this.canvas.height = Math.round(USC.ISL_H * dpr);
      this.canvas.style.width = `${USC.W}px`;
      this.canvas.style.height = `${USC.ISL_H}px`;
    }
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, USC.W, USC.ISL_H);

    this.drawScene(ctx, f, wallTime);

    // The buttons only exist once the choose card has faded in.
    this.overlay.style.display = f.chooseAlpha > 0.5 ? "block" : "none";
  }

  // ── Scene ─────────────────────────────────────────────────────────────────

  private drawScene(ctx: CanvasRenderingContext2D, f: UploadFrame, wallTime: number) {
    // Island background.
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, USC.W, USC.ISL_H);

    // Card.
    ctx.save();
    rr(ctx, USC.CARD_X, USC.CARD_Y, USC.CARD_W, USC.CARD_H, USC.CARD_R);
    ctx.clip();
    ctx.fillStyle = "#0D0E10";
    ctx.fillRect(USC.CARD_X, USC.CARD_Y, USC.CARD_W, USC.CARD_H);

    // Green glow, fanning up from the bottom edge of the card.
    if (f.greenWash > 0) {
      const gx = USC.CARD_X + USC.CARD_W / 2;
      const gy = USC.CARD_Y + USC.CARD_H;
      const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, USC.CARD_H * 1.5);
      g.addColorStop(0, `rgba(236, 236, 236,${f.greenWash * 0.9})`);
      g.addColorStop(0.55, `rgba(236, 236, 236,${f.greenWash * 0.3})`);
      g.addColorStop(1, "rgba(236, 236, 236,0)");
      ctx.fillStyle = g;
      ctx.fillRect(USC.CARD_X, USC.CARD_Y, USC.CARD_W, USC.CARD_H);
    }
    ctx.restore();

    // Dashed border, marching left to right at ~20 pt/s.
    if (f.zoneAlpha > 0) {
      ctx.save();
      ctx.globalAlpha = f.zoneAlpha;
      ctx.strokeStyle = f.zoneOver ? "rgba(236, 236, 236,0.55)" : "rgba(255,255,255,0.14)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 5]);
      ctx.lineDashOffset = -wallTime * 20;
      rr(ctx, USC.CARD_X + 0.75, USC.CARD_Y + 0.75, USC.CARD_W - 1.5, USC.CARD_H - 1.5, USC.CARD_R - 0.5);
      ctx.stroke();
      ctx.restore();
    }

    if (f.zoneAlpha > 0 && f.textAlpha > 0) this.drawDropText(ctx, f);
    if (f.barAlpha > 0 || f.barReveal > 0) this.drawProgressBar(ctx, f);
    if (f.chooseAlpha > 0) this.drawChoose(ctx, f);

    this.drawMark(ctx, f);
    if (f.fileVisible) this.drawFile(ctx, f);
  }

  // ── Drop zone text and chips ──────────────────────────────────────────────

  private drawDropText(ctx: CanvasRenderingContext2D, f: UploadFrame) {
    ctx.save();
    ctx.globalAlpha = f.textAlpha;
    const title = fitted(ctx, t("Drop your files here"), TEXT_RIGHT - USC.TEXT_X, 500, 13);
    text(ctx, title.s, USC.TEXT_X, USC.TEXT_Y - 4, title.font, "#D5D7DB");

    // The macOS port measures chips the same rough way, so the row lines up; a
    // translation wider than that estimate gets the room it needs.
    const labels = CHIPS.map((chip) => t(chip));
    let chipPx = 11;
    const widths = () => {
      ctx.font = `500 ${chipPx}px ${FONT}`;
      return labels.map((l) => Math.max(l.length * 6.5 + 16, Math.ceil(ctx.measureText(l).width) + 16));
    };
    let ws = widths();
    const rowW = () => ws.reduce((a, b) => a + b, 0) + 6 * (ws.length - 1);
    while (rowW() > TEXT_RIGHT - USC.TEXT_X && chipPx > 8.5) {
      chipPx -= 0.5;
      ws = widths();
    }
    let cx = USC.TEXT_X;
    labels.forEach((chip, i) => {
      const w = ws[i];
      ctx.fillStyle = "rgba(255,255,255,0.07)";
      rr(ctx, cx, USC.TEXT_Y + 9, w, 18, 9);
      ctx.fill();
      text(ctx, chip, cx + 8, USC.TEXT_Y + 18, `500 ${chipPx}px ${FONT}`, "#B9BDC4");
      cx += w + 6;
    });
    ctx.restore();
  }

  // ── Progress bar ──────────────────────────────────────────────────────────

  private drawProgressBar(ctx: CanvasRenderingContext2D, f: UploadFrame) {
    ctx.save();
    ctx.globalAlpha = Math.max(f.barAlpha, 0.001);

    const x0 = USC.BAR_X0;
    const x1 = USC.BAR_X1;
    const by = USC.BAR_Y;
    const barLen = (x1 - x0) * f.barReveal;

    // Room up to the percentage (or the check mark) at the bar's right end.
    const uploading = t("Uploading {name}", { name: State.droppedFile?.name ?? t("file") });
    const label = fitted(ctx, uploading, x1 - x0 - 56, 500, 12.5);
    text(ctx, label.s, x0, by - 30, label.font, "#A9ADB5");

    if (f.check > 0) {
      ctx.save();
      ctx.translate(x1 - 8, by - 30);
      ctx.scale(f.check, f.check);
      ctx.beginPath();
      ctx.arc(0, 0, 8, 0, Math.PI * 2);
      ctx.fillStyle = "#ECECEC";
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-3.6, 0.2);
      ctx.lineTo(-1, 2.8);
      ctx.lineTo(3.8, -2.6);
      ctx.strokeStyle = "#07130E";
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.restore();
    } else {
      text(ctx, `${Math.round(f.progress * 100)} %`, x1, by - 30, `500 12.5px ${FONT}`, "#A9ADB5", "right");
    }

    // Track.
    if (barLen > 0) {
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      rr(ctx, x0, by - 3, barLen, 6, 3);
      ctx.fill();
    }

    // Fill.
    const fx = lerp(x0, x1, f.progress);
    if (fx > x0 + 1) {
      const flashGreen = `rgb(${Math.round(lerp(52, 110, f.flash))},${Math.round(
        lerp(211, 231, f.flash),
      )},${Math.round(lerp(153, 183, f.flash))})`;
      const g = ctx.createLinearGradient(x0, 0, fx, 0);
      g.addColorStop(0, "#ECECEC");
      g.addColorStop(1, flashGreen);
      ctx.fillStyle = g;
      rr(ctx, x0, by - 3, fx - x0, 6, 3);
      ctx.fill();
    }

    // Glow trail, its length driven by how fast the bar is moving.
    if (f.progress > 0.01 && f.progress < 1) {
      const v =
        (progressAt(f.t + 0.01, USC.T_PROG_START, f.progEnd) -
          progressAt(f.t, USC.T_PROG_START, f.progEnd)) / 0.01;
      const tl = Math.max(8, Math.min(34, 8 + v * 40));
      const g = ctx.createLinearGradient(fx - tl, 0, fx, 0);
      g.addColorStop(0, "rgba(236, 236, 236,0)");
      g.addColorStop(1, "rgba(236, 236, 236,0.6)");
      ctx.save();
      ctx.filter = "blur(3px)";
      ctx.fillStyle = g;
      rr(ctx, fx - tl, by - 4, tl, 8, 4);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  // ── Choose card ───────────────────────────────────────────────────────────

  private drawChoose(ctx: CanvasRenderingContext2D, f: UploadFrame) {
    ctx.save();
    ctx.globalAlpha = f.chooseAlpha;
    ctx.translate(0, (1 - f.chooseAlpha) * 4);

    const maxW = TEXT_RIGHT - 114;
    const ready = fitted(ctx, t("{name} is ready.", { name: State.droppedFile?.name ?? t("file") }), maxW, 600, 14);
    text(ctx, ready.s, 114, 80, ready.font, "#F5F6F8");
    const what = fitted(ctx, t("What do you want to do with it?"), maxW, 400, 12.5);
    text(ctx, what.s, 114, 100, what.font, "#9398A1");

    ctx.fillStyle = "#F5F6F8";
    rr(ctx, ASK_BTN.x, 113, ASK_BTN.w, 26, 13);
    ctx.fill();
    const ask = fitted(ctx, t("Ask a question about it"), ASK_BTN.w - 14, 500, 12.5);
    text(ctx, ask.s, ASK_BTN.x + ASK_BTN.w / 2, 126, ask.font, "#0B0C0E", "center");

    ctx.fillStyle = "rgba(255,255,255,0.09)";
    rr(ctx, CANCEL_BTN.x, 113, CANCEL_BTN.w, 26, 13);
    ctx.fill();
    const cancel = fitted(ctx, t("Cancel"), CANCEL_BTN.w - 14, 500, 12.5);
    text(ctx, cancel.s, CANCEL_BTN.x + CANCEL_BTN.w / 2, 126, cancel.font, "#F1F2F4", "center");
    ctx.restore();
  }

  // ── The mark ──────────────────────────────────────────────────────────────

  private drawMark(ctx: CanvasRenderingContext2D, f: UploadFrame) {
    // The mark takes the file in: as the sequence turns it into a box, the
    // dash opens up to hold it and the dot runs into it.
    const take = Math.max(0, Math.min(f.morph, 1));
    const pose = rest(1);
    pose.dashHeight = 1 + 0.9 * take;
    pose.dots[0].x -= 1.2 * take;
    pose.sx = f.sx;
    pose.sy = f.sy;
    ctx.save();
    ctx.translate(f.x, f.y + f.hop);
    ctx.rotate(f.tilt);
    paintPose(ctx, pose, 0, 0, f.d / 3.75);
    ctx.restore();
  }


  // ── The file, and the suction ─────────────────────────────────────────────

  private drawFile(ctx: CanvasRenderingContext2D, f: UploadFrame) {
    const cx = f.cursorX;
    const cy = f.cursorY + 14;

    if (f.suck <= 0) {
      ctx.save();
      ctx.globalAlpha = 0.92;
      drawDoc(ctx, cx, cy, 1, 1);
      ctx.restore();
      return;
    }

    const m = f.mouthRect;
    const W0 = 34;
    const H0 = 42;
    const p = eIn(f.suck);
    const topY = lerp(cy - H0 / 2, m.y - 2, eInOut(f.suck));
    const hs = lerp(1.08, 0.55, eInOut(f.suck));
    const Hh = H0 * hs;
    const sc = lerp(1, 0.55, p);
    const q = eOut(f.suck);
    const fCx = lerp(cx, m.x + m.w / 2, eOut(f.suck));
    const wob = Math.sin(f.suck * Math.PI * 2) * 0.1 * (1 - p);
    const clipY = m.y + m.h * 0.5;

    // The sheet is drawn as 28 horizontal strips, each narrowed towards the
    // mouth, so the page appears to funnel in. Everything below the mouth line
    // is clipped away — that is what makes it look swallowed.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, USC.W, clipY);
    ctx.clip();

    for (let i = 0; i < 28; i++) {
      const v0 = i / 28;
      const wsc = lerp(1, lerp(0.92, (0.22 * m.w) / W0, Math.pow(v0, 1.2)), q) * sc;
      const yy = topY + v0 * Hh;
      const hh = Hh / 28 + 0.6;

      ctx.save();
      ctx.translate(fCx, yy);
      ctx.rotate(wob);
      ctx.beginPath();
      ctx.rect((-W0 * wsc) / 2, 0, W0 * wsc, hh);
      ctx.clip();
      ctx.translate(-fCx, -yy);
      drawDoc(ctx, fCx, topY + Hh / 2, wsc, hs);
      ctx.restore();
    }
    ctx.restore();

    // Green crumbs pulled in with the file.
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.6;
      const k = Math.max(0, Math.min(1, (f.suck - i * 0.08) / 0.7));
      if (k <= 0 || k >= 1) continue;
      const sx0 = cx + Math.cos(a) * 24;
      const sy0 = cy + Math.sin(a) * 24;
      const ex = m.x + m.w / 2;
      const ey = m.y + m.h * 0.3;
      const kk = Math.pow(k, 0.7);
      const px = lerp(sx0, ex, kk);
      const py = lerp(sy0, ey, kk) - Math.sin(Math.PI * k) * 6;
      const rad = 2.2 * (1 - k * 0.5);
      ctx.beginPath();
      ctx.arc(px, py, rad, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(236, 236, 236,${1 - k})`;
      ctx.fill();
    }
  }
}

function drawDoc(ctx: CanvasRenderingContext2D, cx: number, cy: number, wsc: number, hsc: number) {
  const w = 34 * wsc;
  const h = 42 * hsc;
  const x = cx - w / 2;
  const y = cy - h / 2;
  const fold = 8 * Math.min(wsc, hsc);

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  ctx.beginPath();
  ctx.moveTo(x + 2, y);
  ctx.lineTo(x + w - fold, y);
  ctx.lineTo(x + w, y + fold);
  ctx.lineTo(x + w, y + h - 2);
  ctx.quadraticCurveTo(x + w, y + h, x + w - 2, y + h);
  ctx.lineTo(x + 2, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - 2);
  ctx.lineTo(x, y + 2);
  ctx.quadraticCurveTo(x, y, x + 2, y);
  ctx.closePath();
  ctx.fillStyle = "#F4F4F6";
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ctx.moveTo(x + w - fold, y);
  ctx.lineTo(x + w - fold, y + fold);
  ctx.lineTo(x + w, y + fold);
  ctx.closePath();
  ctx.fillStyle = "#D5D6DB";
  ctx.fill();

  ctx.fillStyle = "#ECECEC";
  rr(ctx, x + w * 0.18, y + h * 0.58, w * 0.64, h * 0.16, 2);
  ctx.fill();
}
