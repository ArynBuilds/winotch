// Flow in the compact notch, on sample states (?state=bars|message|note|voice).
// `npm run dev`, then open /dev/slot-preview.html. Not shipped in the app.

import "../src/style.css";
import { Island } from "../src/island/island";

const island = new Island(document.getElementById("root")!);
// The slot is the island's own; a preview reaches in to play Rust's part.
const slot = (island as unknown as { flowSlot: { apply(s: unknown): void; target: number[]; wake(): void } }).flowSlot;
const which = new URLSearchParams(location.search).get("state") ?? "bars";
const idle = { phase: "idle", noteStartedAt: null, message: null, voice: null };
const states: Record<string, unknown> = {
  bars: { ...idle, phase: "listening" },
  message: { ...idle, message: { id: 1, text: "Copied — Ctrl+V to paste" } },
  note: { ...idle, noteStartedAt: Date.now() - 754_000 },
  voice: { ...idle, voice: { phase: "speaking", heard: "what's the weather", answer: "Sunny, 18 degrees in Istanbul this afternoon." } },
};
slot.apply(states[which]);
if (which === "bars") {
  window.setInterval(() => {
    for (let i = 0; i < slot.target.length; i++) slot.target[i] = 0.25 + Math.random() * 0.75;
    slot.wake();
  }, 90);
}
