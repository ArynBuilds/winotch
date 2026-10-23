// One motion for the whole island (the user's call, 2026-10-18): a clean
// ease-out with no bounce, and one clock per change. The island's shape and
// the mark ride the same critically damped spring, so they land together; the
// screens' slides and fades use the CSS curve closest to it (--motion-ease in
// style.css is the same curve). A spring rather than a timed curve: one
// retargeted halfway keeps its speed instead of starting over.

export const MOTION = {
  /** The shape's and the mark's spring: SwiftUI-style response (s), damping 1 = no overshoot. */
  response: 0.38,
  damping: 1,
  /** The curve screens move on, as CSS (an ease-out that reads like the spring). */
  ease: "cubic-bezier(0.22, 1, 0.36, 1)",
  /** A screen going away, and one arriving (ms). */
  out: 120,
  in: 300,
  /** The arriving screen waits this long, so the two never sit on each other. */
  inDelay: 40,
  /** On opening, the content waits for the shape to make room for it (ms). */
  openDelay: 90,
  /** How far screens travel (px): beside each other (tabs), and in or out (deeper). */
  slide: 18,
  push: 28,
  /** A card taking another card's place rises this little. */
  rise: 6,
} as const;
