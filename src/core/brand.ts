// The Tent.js brand, as winotch uses it. One colour: light on dark, no accents.
// The rules are in WINOTCH.md.

/** Every shape and every pill. */
export const INK = "#ECECEC";
/** Quieter text. */
export const QUIET = "#9A9A9A";
/** Panels. */
export const PANEL = "#1B1B1B";

/** Lengths of the signs, in units of U, the thickness of every bar. */
export const DASH = 2.3;
export const GAP = 0.45;

/**
 * Every app's sign, made of dashes and dots like the ten words of Tent.js. Where
 * it can, a sign is the Morse code of the app's initial, the way the Tent.js
 * logo begins with "Te". Claude Code, the main pill, carries the logo itself.
 */
const SIGNS: Record<string, string> = {
  integration_claude: "-.",
  integration_github: "--.",
  integration_stripe: "...",
  integration_notion: "-.-",
  integration_spotify: "..-",
  integration_music: ".-.",
  ai_anthropic: ".-",
};

const MORSE: Record<string, string> = {
  a: ".-", b: "-...", c: "-.-.", d: "-..", e: ".", f: "..-.", g: "--.", h: "....", i: "..",
  j: ".---", k: "-.-", l: ".-..", m: "--", n: "-.", o: "---", p: ".--.", q: "--.-", r: ".-.",
  s: "...", t: "-", u: "..-", v: "...-", w: ".--", x: "-..-", y: "-.--", z: "--..",
};

/** Signs the apps that joined winotch chose for themselves (core/apps.ts). */
const chosen = new Map<string, string>();

export function setSign(id: string, sign: string | null) {
  if (sign) chosen.set(id, sign);
  else chosen.delete(id);
}

/** An app's sign: its own, else its initial in Morse, at most three parts like every sign. */
export function signFor(id: string, name: string): string {
  const own = chosen.get(id) ?? SIGNS[id];
  if (own) return own;
  const initial = name.trim().charAt(0).toLowerCase();
  return (MORSE[initial] ?? ".").slice(0, 3);
}
