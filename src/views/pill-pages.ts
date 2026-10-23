// The overview's right card as a phone's home screen: the pills four to a
// page (2 × 2), the pages side by side, dots at the bottom past four. The
// rules are pure functions (tested without a DOM); PillPager lays the pills
// out and moves between pages with a CSS transition only, so nothing runs
// while the card sits still.

import { h } from "./dom";

/** Pills on one page: two rows of two. */
export const PER_PAGE = 4;
/** A wheel or trackpad gesture is over after this long without an event. */
export const WHEEL_QUIET_MS = 180;
/** Wheel travel (px) before a gesture turns the page; ignores jitter. */
export const WHEEL_THRESHOLD = 12;
/** Pointer travel (px) before a press becomes a drag; below it, a click. */
export const DRAG_START = 8;
/** Drag distance (px, or this share of the card) that turns the page. */
export const DRAG_TURN = 36;
export const DRAG_TURN_SHARE = 0.2;

export function pageCount(pills: number): number {
  return Math.max(1, Math.ceil(pills / PER_PAGE));
}

/** The page the pill at `index` sits on. */
export function pageOf(index: number): number {
  return Math.floor(Math.max(0, index) / PER_PAGE);
}

export function clampPage(page: number, pages: number): number {
  return Math.min(Math.max(0, Math.round(page)), Math.max(0, pages - 1));
}

/**
 * The page to show once focus moved. The focused pill is not in the grid (it
 * fills the left card): `slot` is where it would stand among the others, its
 * index in the full order. The current page stays if it holds a neighbour of
 * that slot (a click on a pill never moves the grid); else the grid slides to
 * the page of the slot.
 */
export function pageForFocus(slot: number, pills: number, current: number): number {
  const pages = pageCount(pills);
  const page = clampPage(current, pages);
  if (pills <= 0 || slot < 0) return page;
  const before = slot - 1;
  const after = Math.min(slot, pills - 1);
  if ((before >= 0 && pageOf(before) === page) || pageOf(after) === page) return page;
  return clampPage(pageOf(after), pages);
}

/**
 * One page per wheel gesture. A mouse wheel spun fast, or a trackpad's swipe
 * and the inertia after it, is one stream of events: the first that travels
 * far enough turns the page, then the stream is ignored until it has been
 * quiet for WHEEL_QUIET_MS.
 */
export class WheelPager {
  private last = -Infinity;
  private travel = 0;
  private spent = false;

  /** Normalised deltas (px); returns the step to take: -1, 0 or 1. */
  step(dx: number, dy: number, now: number): -1 | 0 | 1 {
    if (now - this.last > WHEEL_QUIET_MS) {
      this.travel = 0;
      this.spent = false;
    }
    this.last = now;
    if (this.spent) return 0;
    // The longer axis decides: a horizontal swipe, shift + wheel, or the wheel.
    this.travel += Math.abs(dx) > Math.abs(dy) ? dx : dy;
    if (Math.abs(this.travel) < WHEEL_THRESHOLD) return 0;
    this.spent = true;
    return this.travel > 0 ? 1 : -1;
  }
}

/** The page a released drag settles on: `dx` > 0 is a drag to the right. */
export function pageAfterDrag(page: number, pages: number, dx: number, width: number): number {
  const turn = Math.min(DRAG_TURN, Math.max(1, width) * DRAG_TURN_SHARE);
  if (Math.abs(dx) < turn) return clampPage(page, pages);
  return clampPage(page + (dx < 0 ? 1 : -1), pages);
}

/**
 * The pages and their dots. `el` goes in the card; `set` lays out a new list
 * of pills on the page it was showing (clamped); `show` moves to a page.
 */
export class PillPager {
  readonly el: HTMLElement;
  private readonly track: HTMLElement;
  private readonly dots: HTMLElement;
  private readonly wheel = new WheelPager();
  private page = 0;
  private pages = 1;
  private count = 0;

  constructor() {
    this.track = h("div", { class: "pill-track" });
    this.dots = h("div", { class: "pill-dots" });
    this.el = h("div", { class: "pill-pager" }, this.track, this.dots);
    this.el.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    this.listenForDrag();
  }

  get current(): number {
    return this.page;
  }

  get pageTotal(): number {
    return this.pages;
  }

  /** Lays out `pills` four to a page; keeps the page shown, clamped. */
  set(pills: HTMLElement[]) {
    this.count = pills.length;
    this.pages = pageCount(pills.length);
    this.page = clampPage(this.page, this.pages);
    const grids: HTMLElement[] = [];
    for (let i = 0; i < this.pages; i++) {
      grids.push(h("div", { class: "pills" }, ...pills.slice(i * PER_PAGE, (i + 1) * PER_PAGE)));
    }
    this.track.replaceChildren(...grids);
    const paged = this.pages > 1;
    this.el.classList.toggle("paged", paged);
    const dots: HTMLElement[] = [];
    if (paged) {
      for (let i = 0; i < this.pages; i++) {
        dots.push(h("button", { class: "pill-dot", tabindex: -1, onclick: () => this.show(i) }));
      }
    }
    this.dots.replaceChildren(...dots);
    this.place();
  }

  /** Moves to `page` (clamped), sliding unless the user asked for less motion. */
  show(page: number) {
    const next = clampPage(page, this.pages);
    if (next === this.page) return;
    this.page = next;
    this.place();
  }

  /** Focus moved: the page of its slot among the pills (see pageForFocus). */
  follow(slot: number) {
    this.show(pageForFocus(slot, this.count, this.page));
  }

  private place(dragPx = 0) {
    const shift = `${-this.page * 100}%`;
    this.track.style.transform = dragPx ? `translateX(calc(${shift} + ${dragPx}px))` : `translateX(${shift})`;
    for (let i = 0; i < this.dots.children.length; i++) {
      this.dots.children[i].classList.toggle("on", i === this.page);
    }
  }

  private onWheel(e: WheelEvent) {
    if (this.pages < 2 || e.ctrlKey) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
    // Shift + wheel arrives on either axis: the longer one decides (WheelPager).
    const step = this.wheel.step(e.deltaX * unit, e.deltaY * unit, e.timeStamp);
    if (step) this.show(this.page + step);
  }

  /**
   * A press that travels sideways past DRAG_START drags the pages under the
   * pointer and snaps on release; anything shorter stays a click, so the
   * pills (and Spotify's buttons) work as before. The click that ends a drag
   * is swallowed.
   */
  private listenForDrag() {
    let id: number | null = null;
    let x0 = 0;
    let y0 = 0;
    let dragging = false;
    let swallow = false;
    const end = (e: PointerEvent, cancel: boolean) => {
      if (e.pointerId !== id) return;
      id = null;
      if (!dragging) return;
      dragging = false;
      this.el.classList.remove("dragging");
      const dx = e.clientX - x0;
      const width = this.el.getBoundingClientRect().width;
      this.page = cancel ? this.page : pageAfterDrag(this.page, this.pages, dx, width);
      this.place();
      swallow = !cancel;
    };
    this.el.addEventListener("pointerdown", (e) => {
      swallow = false;
      if (this.pages < 2 || e.button !== 0) return;
      id = e.pointerId;
      x0 = e.clientX;
      y0 = e.clientY;
      dragging = false;
    });
    this.el.addEventListener("pointermove", (e) => {
      if (e.pointerId !== id) return;
      const dx = e.clientX - x0;
      if (!dragging) {
        if (Math.abs(dx) < DRAG_START || Math.abs(dx) < Math.abs(e.clientY - y0)) return;
        dragging = true;
        this.el.classList.add("dragging");
        this.el.setPointerCapture?.(e.pointerId);
      }
      // Past the first or last page the pages follow at a third of the pull.
      const edge = (dx > 0 && this.page === 0) || (dx < 0 && this.page === this.pages - 1);
      this.place(edge ? dx / 3 : dx);
    });
    this.el.addEventListener("pointerup", (e) => end(e, false));
    this.el.addEventListener("pointercancel", (e) => end(e, true));
    this.el.addEventListener(
      "click",
      (e) => {
        if (!swallow) return;
        swallow = false;
        e.stopPropagation();
        e.preventDefault();
      },
      true,
    );
  }
}
