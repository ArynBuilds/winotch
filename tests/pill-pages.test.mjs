// The overview's pills as a phone's home screen (src/views/pill-pages.ts):
// four to a page, the pages side by side, dots past four; one page per wheel
// gesture; the page kept when the pills change, and followed when focus moves.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();

const {
  PER_PAGE, PillPager, WHEEL_QUIET_MS, WheelPager, clampPage, pageAfterDrag, pageCount, pageForFocus, pageOf,
} = await import("../src/views/pill-pages.ts");

// ── The rules ─────────────────────────────────────────────────────────────────

test("four pills to a page; one page for none to four", () => {
  assert.equal(PER_PAGE, 4);
  assert.deepEqual([0, 1, 4, 5, 8, 9, 13].map(pageCount), [1, 1, 1, 2, 2, 3, 4]);
  assert.deepEqual([0, 3, 4, 7, 8].map(pageOf), [0, 0, 1, 1, 2]);
});

test("a page is clamped to the pages there are", () => {
  assert.equal(clampPage(2, 3), 2);
  assert.equal(clampPage(3, 2), 1, "fewer pages now: the last one");
  assert.equal(clampPage(-1, 2), 0);
  assert.equal(clampPage(5, 1), 0);
  assert.equal(clampPage(0, 0), 0);
});

test("focus that moved slides to its page, and a click never moves the grid", () => {
  // Seven pills in all, one focused: six in the grid, pages [0..3] [4..5].
  assert.equal(pageForFocus(6, 6, 0), 1, "the last pill: page two");
  assert.equal(pageForFocus(5, 6, 0), 1, "between the 5th and 6th: page two");
  assert.equal(pageForFocus(1, 6, 1), 0, "back to the start: page one");
  // A slot on the seam keeps whichever of its two pages is shown.
  assert.equal(pageForFocus(4, 6, 0), 0);
  assert.equal(pageForFocus(4, 6, 1), 1);
  assert.equal(pageForFocus(-1, 6, 1), 1, "focus not among the pills: unchanged");
  assert.equal(pageForFocus(0, 3, 0), 0, "one page: nothing to follow");
});

test("one page per wheel gesture, however long its inertia runs", () => {
  const wheel = new WheelPager();
  let now = 1_000;
  assert.equal(wheel.step(0, 4, now), 0, "jitter alone turns nothing");
  assert.equal(wheel.step(0, 10, (now += 16)), 1, "far enough: the next page");
  // The trackpad's inertia: a second of events, never quiet for long.
  for (let i = 0; i < 60; i++) assert.equal(wheel.step(0, 40, (now += 16)), 0);
  // Quiet, then a new gesture: back a page, sideways this time.
  assert.equal(wheel.step(-30, 2, (now += WHEEL_QUIET_MS + 1)), -1);
  assert.equal(wheel.step(-30, 2, (now += 16)), 0);
  // A wheel notch (vertical, shift-less mouse) is a gesture of its own.
  assert.equal(wheel.step(0, 100, (now += WHEEL_QUIET_MS + 1)), 1);
});

test("a drag turns the page past its threshold, else snaps back", () => {
  assert.equal(pageAfterDrag(0, 2, -50, 200), 1);
  assert.equal(pageAfterDrag(1, 2, 50, 200), 0);
  assert.equal(pageAfterDrag(0, 2, -20, 200), 0, "too short: back where it was");
  assert.equal(pageAfterDrag(1, 2, -80, 200), 1, "no page past the last");
  assert.equal(pageAfterDrag(0, 3, 80, 200), 0, "none before the first");
});

// ── The pager ─────────────────────────────────────────────────────────────────

const pills = (n) => Array.from({ length: n }, (_, i) => {
  const el = document.createElement("div");
  el.className = "pill";
  el.dataset.n = String(i);
  return el;
});
const pages = (pager) => pager.el.querySelector(".pill-track").children;
const dots = (pager) => pager.el.querySelector(".pill-dots").children;

test("up to four pills: one grid, no dots, as before", () => {
  const pager = new PillPager();
  pager.set(pills(4));
  assert.equal(pages(pager).length, 1);
  assert.equal(pages(pager)[0].className, "pills");
  assert.equal(pages(pager)[0].children.length, 4);
  assert.equal(dots(pager).length, 0);
  assert.equal(pager.el.classList.contains("paged"), false);
});

test("five pills: two pages of four and one, two dots, the first one on", () => {
  const pager = new PillPager();
  pager.set(pills(5));
  assert.deepEqual([...pages(pager)].map((p) => p.children.length), [4, 1]);
  assert.equal(pages(pager)[1].children[0].dataset.n, "4");
  assert.equal(dots(pager).length, 2);
  assert.deepEqual([...dots(pager)].map((d) => d.classList.contains("on")), [true, false]);
  assert.equal(pager.el.classList.contains("paged"), true);
  assert.equal(pager.el.querySelector(".pill-track").style.transform, "translateX(0%)");

  // A dot slides to its page.
  dots(pager)[1].fire("click");
  assert.equal(pager.current, 1);
  assert.equal(pager.el.querySelector(".pill-track").style.transform, "translateX(-100%)");
  assert.deepEqual([...dots(pager)].map((d) => d.classList.contains("on")), [false, true]);
});

test("the page is kept when the pills change, and clamped when pages go", () => {
  const pager = new PillPager();
  pager.set(pills(9));
  pager.show(2);
  pager.set(pills(10));
  assert.equal(pager.current, 2, "rebuilt on the page it showed");
  pager.set(pills(6));
  assert.equal(pager.current, 1, "a page fewer: the last one");
  pager.set(pills(3));
  assert.equal(pager.current, 0);
  assert.equal(dots(pager).length, 0, "back to one page: no dots");
});

test("the wheel pages the grid, and only when there is more than one page", () => {
  const pager = new PillPager();
  const wheel = (dy, timeStamp, over = {}) => {
    const event = { deltaX: 0, deltaY: dy, deltaMode: 0, shiftKey: false, ctrlKey: false, timeStamp,
      defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...over };
    for (const fn of pager.el.listeners.get("wheel")) fn(event);
    return event;
  };
  pager.set(pills(3));
  assert.equal(wheel(50, 0).defaultPrevented, false, "one page: the wheel is left alone");
  pager.set(pills(8));
  assert.equal(wheel(50, 1_000).defaultPrevented, true);
  assert.equal(pager.current, 1);
  wheel(50, 1_020);
  assert.equal(pager.current, 1, "the same gesture: no second page");
  wheel(-3, 2_000, { deltaMode: 1 });
  assert.equal(pager.current, 0, "lines count as pixels, a gesture later");
});
