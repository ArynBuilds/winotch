// How one screen gives way to the next (src/island/view-motion.ts): the motion
// says what the change is. Tabs slide toward the side of the tab chosen, an
// app's page or the settings push in and pop out, cards rise in place, and an
// opening island fades its screen in.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();

const { classify, moveScreens } = await import("../src/island/view-motion.ts");

test("the tabs slide toward the side of the tab chosen", () => {
  assert.deepEqual(classify("overview", "prompt"), { move: "switch", dir: 1 });
  assert.deepEqual(classify("notifications", "prompt"), { move: "switch", dir: -1 });
  assert.deepEqual(classify("empty", "upload"), { move: "switch", dir: 1 });
});

test("an app's page and the settings lie deeper: in from the right, out to the left", () => {
  assert.deepEqual(classify("overview", "app"), { move: "push", dir: 1 });
  assert.deepEqual(classify("notifications", "app"), { move: "push", dir: 1 });
  assert.deepEqual(classify("app", "overview"), { move: "pop", dir: -1 });
  assert.deepEqual(classify("prompt", "settings"), { move: "push", dir: 1 });
  assert.deepEqual(classify("settings", "prompt"), { move: "pop", dir: -1 });
});

test("a card takes the place of what was there; the same tab's two faces too", () => {
  assert.deepEqual(classify("overview", "finished"), { move: "swap", dir: 0 });
  assert.deepEqual(classify("approval", "overview"), { move: "swap", dir: 0 });
  assert.deepEqual(classify("overview", "empty"), { move: "swap", dir: 0 });
  assert.deepEqual(classify("app", "settings"), { move: "swap", dir: 0 });
});

test("nothing showed before: the island is opening", () => {
  assert.deepEqual(classify(null, "notifications"), { move: "open", dir: 0 });
});

test("without Web Animations the screen just shows, and nothing is left leaving", () => {
  const leaving = document.createElement("div");
  const arriving = document.createElement("div");
  leaving.classList.add("leaving");
  moveScreens(leaving, arriving, "switch", 1);
  assert.equal(leaving.classList.contains("leaving"), false);
});
