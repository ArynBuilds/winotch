// The compact notch's middle (src/island/flow-slot.ts): what Flow shows there,
// keys only, and when it holds the notch up.

import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { emit } from "./tauri.mjs";

installFakeDom();
// Frames are not drawn here: the bars' loop only has to start and stop.
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.getComputedStyle = () => ({ fontFamily: "sans-serif" });
const { FlowSlot } = await import("../src/island/flow-slot.ts");

const idle = { phase: "idle", noteStartedAt: null, message: null, voice: null };

let slot;
let holds;

beforeEach(async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  slot = new FlowSlot();
  holds = [];
  slot.onHold = (on) => holds.push(on);
  await slot.start();
});

afterEach(() => mock.timers.reset());

const shown = () => slot.el.children.filter((c) => c.classList.contains("in"));

test("dictating holds the notch and shows the bars between the mark and the bell", () => {
  emit("flow-notch", { ...idle, phase: "listening" });
  assert.deepEqual(holds, [true]);
  assert.equal(slot.el.classList.contains("on"), false, "nothing shows until the compact notch does");
  slot.setVisible(true);
  assert.equal(slot.el.classList.contains("on"), true);
  const [bars] = shown();
  assert.ok(bars.classList.contains("fs-bars"));
  assert.equal(bars.children.length, 9);
  emit("flow-bands", [1, 1, 1, 1, 1, 1, 1, 1, 1]);
  // Hands-free and writing keep the same bars, no new fade.
  emit("flow-notch", { ...idle, phase: "locked" });
  emit("flow-notch", { ...idle, phase: "thinking" });
  assert.equal(shown()[0], bars);
  emit("flow-notch", idle);
  assert.deepEqual(holds, [true, false], "done: the notch goes back to its usual timing");
  assert.equal(slot.el.classList.contains("on"), false);
});

test("a message is a line of text, with nothing to click, until Rust takes it away", () => {
  slot.setVisible(true);
  emit("flow-notch", { ...idle, message: { id: 1, text: "Copied — Ctrl+V to paste" } });
  const [line] = shown();
  assert.ok(line.classList.contains("fs-text"));
  assert.equal(line.textContent, "Copied — Ctrl+V to paste");
  assert.equal(line.find("BUTTON").length, 0);
  emit("flow-notch", idle);
  assert.equal(shown().length, 0);
  mock.timers.tick(200);
  assert.equal(slot.el.children.length, 0, "the old line is gone once it has faded");
  assert.deepEqual(holds, [true, false]);
});

test("a call shows a dot and its clock, ticking once a second", () => {
  slot.setVisible(true);
  emit("flow-notch", { ...idle, noteStartedAt: Date.now() - 74_000 });
  const [note] = shown();
  assert.ok(note.classList.contains("fs-note"));
  const clockEl = note.find(".fs-clock")[0];
  assert.equal(clockEl.textContent, "1:14");
  mock.timers.tick(1010);
  assert.equal(clockEl.textContent, "1:15");
  mock.timers.tick(1000);
  assert.equal(clockEl.textContent, "1:16");
});

test("OK Tent: listening, then what was heard, then the answer", () => {
  slot.setVisible(true);
  emit("flow-notch", { ...idle, voice: { phase: "listening", heard: "", answer: "" } });
  assert.equal(shown()[0].textContent, "Listening…");
  emit("flow-notch", { ...idle, voice: { phase: "thinking", heard: "what time is it", answer: "" } });
  assert.equal(shown()[0].textContent, "what time is it");
  emit("flow-notch", { ...idle, voice: { phase: "speaking", heard: "what time is it", answer: "It is ten." } });
  assert.equal(shown()[0].textContent, "It is ten.");
  assert.deepEqual(holds, [true]);
});

test("dictation comes before a message, a message before a call", () => {
  slot.setVisible(true);
  const note = Date.now();
  emit("flow-notch", { phase: "listening", noteStartedAt: note, message: { id: 3, text: "Hi" }, voice: null });
  assert.ok(shown()[0].classList.contains("fs-bars"));
  emit("flow-notch", { phase: "idle", noteStartedAt: note, message: { id: 3, text: "Hi" }, voice: null });
  assert.equal(shown()[0].textContent, "Hi");
  emit("flow-notch", { phase: "idle", noteStartedAt: note, message: null, voice: null });
  assert.ok(shown()[0].classList.contains("fs-note"));
});
