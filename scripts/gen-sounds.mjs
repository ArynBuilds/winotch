// winotch's sounds, synthesised here like the icons are drawn: no recordings,
// no dependencies. Coucou's sounds are its author's (LICENSE-ASSETS.md), so
// winotch ships these instead.
//
// They follow the brand: a dot is a short tone, a dash a longer one, soft sine
// with a quick attack and a calm fall, nothing harsh. The launch greeting is
// TENT in Morse (dash, dot, dash dot, dash), like the film's transition.
//
//   node scripts/gen-sounds.mjs        → windows/sounds/*.wav

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "sounds");
const RATE = 44100;

// A tone: from f0 to f1 Hz, starting at t seconds, lasting d, at gain g.
const tone = (f0, t, d, g = 0.5, f1 = f0) => ({ f0, f1, t, d, g });
const DOT = 0.07;
const DASH = 0.2;
const GAP = 0.07;

/** Dots and dashes at one pitch, from `t`: the brand's own rhythm. */
function morse(code, f, t = 0, g = 0.45) {
  const out = [];
  for (const c of code) {
    if (c === " ") {
      t += GAP * 2;
      continue;
    }
    const d = c === "-" ? DASH : DOT;
    out.push(tone(f, t, d, g));
    t += d + GAP;
  }
  return out;
}

const SOUNDS = {
  // The island
  peek: [tone(880, 0, 0.06, 0.35)],
  open: [tone(660, 0, 0.06, 0.35), tone(880, 0.07, 0.08, 0.35)],
  close: [tone(880, 0, 0.06, 0.3), tone(660, 0.07, 0.08, 0.3)],
  hover: [tone(1320, 0, 0.025, 0.12)],
  blip: [tone(1000, 0, 0.04, 0.3)],
  tick: [tone(1500, 0, 0.015, 0.2)],
  pop: [tone(900, 0, 0.03, 0.35, 1100)],
  // The mark
  slap: [tone(220, 0, 0.07, 0.6, 160)],
  annoyed: [tone(330, 0, 0.07, 0.4), tone(277, 0.09, 0.1, 0.4)],
  dizzy: [tone(660, 0, 0.08, 0.3, 560), tone(560, 0.09, 0.08, 0.3, 470), tone(470, 0.18, 0.12, 0.3, 390)],
  greet: morse("..", 784),
  love: [tone(784, 0, 0.07, 0.3), tone(988, 0.08, 0.07, 0.3), tone(1175, 0.16, 0.12, 0.3)],
  proud: [tone(523, 0, 0.06, 0.3), tone(659, 0.07, 0.06, 0.3), tone(784, 0.14, 0.06, 0.3), tone(1047, 0.21, 0.14, 0.3)],
  wink: [tone(1175, 0, 0.04, 0.3), tone(880, 0.07, 0.05, 0.3)],
  yawn: [tone(520, 0, 0.42, 0.3, 330)],
  sleep: [tone(440, 0, 0.3, 0.25, 330)],
  gulp: [tone(420, 0, 0.12, 0.45, 240)],
  // A session
  work: morse(".", 660, 0, 0.3),
  think: morse("-", 523, 0, 0.25),
  search: [tone(698, 0, 0.05, 0.3), tone(784, 0.07, 0.05, 0.3), tone(698, 0.14, 0.05, 0.3)],
  finish: [tone(660, 0, DOT, 0.4), tone(880, DOT + GAP, DASH, 0.4)],
  error: morse("-", 220, 0, 0.5),
  approval: morse("..", 880, 0, 0.45),
  question: [tone(660, 0, 0.07, 0.4), tone(990, 0.09, 0.12, 0.4)],
  approve: [tone(880, 0, 0.05, 0.4), tone(1320, 0.06, 0.09, 0.4)],
  rate: morse("-", 294, 0, 0.4),
  // Files and the chat
  send: [tone(700, 0, 0.06, 0.35, 1050)],
  attach: morse("..", 600, 0, 0.35),
  // Launch: TENT in Morse.
  greeting: morse("- . -. -", 660, 0.05, 0.4),
};

function render(tones) {
  const end = Math.max(...tones.map((n) => n.t + n.d)) + 0.12;
  const out = new Float32Array(Math.ceil(end * RATE));
  for (const n of tones) {
    const start = Math.floor(n.t * RATE);
    const len = Math.floor(n.d * RATE);
    // The tail rings on a little past the tone, falling away.
    const tail = Math.floor(0.08 * RATE);
    let phase = 0;
    for (let i = 0; i < len + tail && start + i < out.length; i++) {
      const p = Math.min(1, i / len);
      const f = n.f0 + (n.f1 - n.f0) * p;
      phase += (2 * Math.PI * f) / RATE;
      const attack = Math.min(1, i / (0.005 * RATE));
      const body = i < len ? 1 - 0.3 * p : 0.7 * Math.exp((-(i - len) / RATE) * 40);
      // Sine, with a quiet octave for warmth.
      out[start + i] += n.g * attack * body * (Math.sin(phase) + 0.12 * Math.sin(2 * phase));
    }
  }
  // No clipping: scale down only if a chord adds up past 1.
  const peak = out.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  if (peak > 0.95) for (let i = 0; i < out.length; i++) out[i] *= 0.95 / peak;
  return out;
}

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2));
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVE", 8);
  head.write("fmt ", 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

mkdirSync(OUT, { recursive: true });
for (const [name, tones] of Object.entries(SOUNDS)) {
  const file = wav(render(tones));
  writeFileSync(join(OUT, `${name}.wav`), file);
}
console.log(`${Object.keys(SOUNDS).length} sounds in ${OUT}`);
