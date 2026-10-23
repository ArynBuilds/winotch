// How one screen gives way to the next in the open island. Every change says
// what happened (the user's call, 2026-10-18: the motion has to fit the
// change): the tabs at the top lie side by side, so a tab's screen slides in
// from its side; an app's page or the settings lie deeper, so they push in
// from the right and Back pulls them out the other way; a card (a finished
// turn, a question) takes the place of what was there and rises a little; the
// island opening fades its content in once the shape has made room for it.
//
// The screen going away keeps its own size (island.ts sizes each screen) and
// leaves quickly; the one coming arrives at its final size, so nothing is laid
// out again while it moves. Both run as Web Animations on opacity and
// transform only, which the compositor draws without the page.

import { MOTION } from "../core/motion";
import type { IslandViewName } from "../core/layout";

export type Move = "open" | "switch" | "push" | "pop" | "swap";

/** The tabs at the top, left to right (views.ts buildHeader). */
const TABS: Partial<Record<IslandViewName, number>> = { overview: 0, empty: 0, prompt: 1, notifications: 2, upload: 3 };
/** Screens a level below the tabs. */
const DEEPER: ReadonlySet<IslandViewName> = new Set(["app", "settings"]);

/** What a change from one screen to another is. `dir` is +1 toward the right, -1 toward the left. */
export function classify(from: IslandViewName | null, to: IslandViewName): { move: Move; dir: number } {
  if (from === null) return { move: "open", dir: 0 };
  if (DEEPER.has(to) && !DEEPER.has(from)) return { move: "push", dir: 1 };
  if (DEEPER.has(from) && !DEEPER.has(to)) return { move: "pop", dir: -1 };
  const a = TABS[from];
  const b = TABS[to];
  if (a !== undefined && b !== undefined && a !== b) return { move: "switch", dir: b > a ? 1 : -1 };
  return { move: "swap", dir: 0 };
}

const opts = (duration: number, delay = 0): KeyframeAnimationOptions => ({
  duration, delay, easing: MOTION.ease, fill: "backwards",
});

/** Stops whatever was moving a screen, where it is: a new change starts from there. */
function settle(el: HTMLElement) {
  // The screen's own animations only, never those inside it (a shimmer).
  for (const a of el.getAnimations?.() ?? []) a.cancel();
}

/**
 * The screen `leaving` goes (it may be null: nothing showed), `arriving`
 * comes. The caller has already given `arriving` the `on` class.
 */
export function moveScreens(leaving: HTMLElement | null, arriving: HTMLElement, move: Move, dir: number) {
  // A page without Web Animations (the tests' DOM) just shows the screen.
  if (typeof arriving.animate !== "function") return placeScreens(leaving, arriving);
  settle(arriving);
  if (leaving) {
    settle(leaving);
    const to =
      move === "switch" ? `translateX(${-dir * MOTION.slide}px)` :
      move === "push" ? `translateX(${-MOTION.push / 2}px)` :
      move === "pop" ? `translateX(${MOTION.push}px)` : "none";
    // Kept on screen (style.css .view.leaving) until it is gone.
    leaving.classList.add("leaving");
    const out = leaving.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: to }], opts(MOTION.out));
    const done = () => leaving.classList.remove("leaving");
    out.onfinish = done;
    out.oncancel = done;
  }
  const from =
    move === "switch" ? `translateX(${dir * MOTION.slide}px)` :
    move === "push" ? `translateX(${MOTION.push}px)` :
    move === "pop" ? `translateX(${-MOTION.push / 2}px)` :
    move === "swap" ? `translateY(${MOTION.rise}px)` : "translateY(-4px)";
  const delay = move === "open" ? MOTION.openDelay : leaving ? MOTION.inDelay : 0;
  arriving.animate([{ opacity: 0, transform: from }, { opacity: 1, transform: "none" }], opts(MOTION.in, delay));
}

/** No motion: the island is shut, or a screen changed while nobody could see it. */
export function placeScreens(leaving: HTMLElement | null, arriving: HTMLElement) {
  if (leaving) {
    settle(leaving);
    leaving.classList.remove("leaving");
  }
  settle(arriving);
}
