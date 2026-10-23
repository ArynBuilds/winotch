// Plan usage gauges (src/core/plan.ts, src/views/usage.ts): a port of the Mac's
// tests/ClaudePlanGaugeTests.swift, and the pill's rules (where it shows, what a
// click opens, what closes it).

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  claudeSubtitle, dominantPct, effectivePct, parseClaudePlan, pillLabel, planColor, resetLabel,
  restorePlanUsage,
} from "../src/core/plan.ts";
import { emit } from "./tauri.mjs";
import { registerHookHandlers } from "../src/island/hooks.ts";
import { claudePillVisible, planCardOpen } from "../src/views/usage.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";
import { useRegistry } from "./registry.mjs";

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const future = NOW / 1000 + 7200; // 2 hours from now, epoch seconds
const past = NOW / 1000 - 100;
const claude = (rl) => parseClaudePlan(rl, NOW);
const win = (pct, epochS) => ({ usedPct: pct, resetsAt: epochS * 1000 });

// ── ClaudePlanGauge.parse ─────────────────────────────────────────────────────

test("a full payload gives both windows", () => {
  const u = claude({
    five_hour: { used_percentage: 23.5, resets_at: future },
    seven_day: { used_percentage: 67.0, resets_at: future },
  });
  assert.equal(u.fiveHour.usedPct, 23.5);
  assert.equal(u.sevenDay.usedPct, 67);
  assert.equal(u.fiveHour.resetsAt, future * 1000);
  assert.equal(u.updatedAt, NOW);
});

test("missing or empty rate_limits is nothing", () => {
  assert.equal(claude(undefined), null);
  assert.equal(claude({}), null);
  assert.equal(claude("x"), null);
});

test("percentages: 150 is shown full, above 200 or below 0 is dropped, ints are fine", () => {
  const one = (pct) => claude({ five_hour: { used_percentage: pct, resets_at: future } })?.fiveHour;
  assert.equal(one(250), undefined);
  assert.equal(one(201), undefined);
  assert.equal(one(-5), undefined);
  assert.equal(one(150).usedPct, 100);
  assert.equal(one(42).usedPct, 42);
  assert.equal(one("42"), undefined);
});

test("a reset more than 400 days away is milliseconds in disguise", () => {
  const far = NOW / 1000 + 401 * 86400;
  assert.equal(claude({ five_hour: { used_percentage: 50, resets_at: far } }), null);
  assert.equal(claude({ five_hour: { used_percentage: 50, resets_at: NOW } }), null);
  assert.equal(claude({ five_hour: { used_percentage: 50, resets_at: 0 } }), null);
});

test("one good window is enough", () => {
  const u = claude({
    five_hour: { used_percentage: 250, resets_at: future },
    seven_day: { used_percentage: 10, resets_at: future },
  });
  assert.equal(u.fiveHour, undefined);
  assert.equal(u.sevenDay.usedPct, 10);
});

// ── effectivePct / dominantPct ────────────────────────────────────────────────

test("a window whose reset has passed counts as 0", () => {
  assert.equal(effectivePct(win(80, past), NOW), 0);
  assert.equal(effectivePct(win(80, future), NOW), 80);
});

test("the dominant percentage is the higher window", () => {
  const both = { fiveHour: win(30, future), sevenDay: win(70, future), updatedAt: NOW };
  const fhOnly = { fiveHour: win(55, future), updatedAt: NOW };
  const empty = { updatedAt: NOW };
  assert.equal(dominantPct(both, NOW), 70);
  assert.equal(dominantPct(fhOnly, NOW), 55);
  assert.equal(dominantPct(empty, NOW), null);
  assert.equal(dominantPct(null, NOW), null);
  // An expired week no longer dominates.
  assert.equal(dominantPct({ fiveHour: win(30, future), sevenDay: win(90, past), updatedAt: NOW }, NOW), 30);
});

// ── color / labels ────────────────────────────────────────────────────────────

test("colours: grey with no number, else the brand's one colour", () => {
  assert.equal(planColor(null), "#6B7079");
  for (const used of [0, 49, 50, 79, 80, 100]) assert.equal(planColor(used), "#ECECEC", String(used));
});

test("pill labels read like the Mac's header pill", () => {
  const both = { fiveHour: win(30, future), sevenDay: win(70, future), updatedAt: NOW };
  assert.equal(pillLabel("Claude", null, NOW), "Claude —");
  assert.equal(pillLabel("Claude", { updatedAt: NOW }, NOW), "Claude —");
  assert.equal(pillLabel("Claude", both, NOW), "Claude 70%");
});

test("reset times: a countdown for 5 hours, a weekday for the week", () => {
  assert.equal(resetLabel(win(10, NOW / 1000 + 4800), false, NOW), "in 1 h 20");
  assert.equal(resetLabel(win(10, NOW / 1000 + 300), false, NOW), "in 5 min");
  assert.equal(resetLabel(win(10, past), false, NOW), "Resetting…");
  const at = new Date(2026, 9, 12, 9, 5); // a Monday, local time
  assert.equal(resetLabel({ usedPct: 1, resetsAt: at.getTime() }, true, at.getTime() - 3600_000), "Mon 9:05");
});

test("subtitles say how old the numbers are", () => {
  assert.equal(claudeSubtitle(null, NOW), "Waiting for a response from Claude Code");
  assert.equal(claudeSubtitle({ updatedAt: NOW - 30_000 }, NOW), "just now");
  assert.equal(claudeSubtitle({ updatedAt: NOW - 12 * 60_000 }, NOW), "12 min ago");
  assert.equal(claudeSubtitle({ updatedAt: NOW - 3 * 3600_000 }, NOW), "3 h ago");
});

test("the last Claude numbers survive a restart, and junk does not", () => {
  const u = { fiveHour: win(30, future), updatedAt: NOW };
  assert.deepEqual(restorePlanUsage(JSON.stringify(u)), u);
  assert.equal(restorePlanUsage(null), null);
  assert.equal(restorePlanUsage("{"), null);
  assert.equal(restorePlanUsage(JSON.stringify({ updatedAt: NOW, fiveHour: { usedPct: 900, resetsAt: 1 } })), null);
});

// ── The pills in the island ───────────────────────────────────────────────────

registerHookHandlers({ alert() {}, setView() {}, reveal() {}, dropPin() {} });

beforeEach(() => {
  State.settings = { ...DEFAULT_SETTINGS };
  State.view = "overview";
  State.paused = false;
  State.planUsage = null;
  State.showingPlanDetail = false;
});

test("the pill is off by default, so the header is as it shipped", () => {
  assert.equal(claudePillVisible(), false);
});

test("the Claude pill needs the switch and the relay, and the overview", () => {
  State.settings.showPlanInNotch = true;
  assert.equal(claudePillVisible(), false);
  State.settings.planRelayInstalled = true;
  assert.equal(claudePillVisible(), true);
  State.view = "prompt";
  assert.equal(claudePillVisible(), false);
});

test("an open card follows its pill", () => {
  State.settings.showPlanInNotch = true;
  State.settings.planRelayInstalled = true;
  State.showingPlanDetail = true;
  assert.equal(planCardOpen(), true);
  // The card cannot be open without its pill.
  State.view = "prompt";
  assert.equal(planCardOpen(), false);
});

test("focusing another pill closes the plan card", () => {
  useRegistry();
  State.showingPlanDetail = true;
  State.setFocus(State.tasks[0].id);
  assert.equal(State.showingPlanDetail, false);
});

test("a status line call updates the numbers and nothing else, even when paused", () => {
  State.paused = true;
  const tasks = JSON.stringify(State.tasks);
  emit("hook", {
    hook_event_name: "StatusLine",
    session_id: "s1",
    rate_limits: { five_hour: { used_percentage: 42, resets_at: Date.now() / 1000 + 3600 } },
  });
  assert.equal(State.planUsage.fiveHour.usedPct, 42);
  assert.equal(JSON.stringify(State.tasks), tasks);
  // Without limits (API-key users) the last numbers stay.
  emit("hook", { hook_event_name: "StatusLine", session_id: "s1" });
  assert.equal(State.planUsage.fiveHour.usedPct, 42);
});
