// The chat view (src/views/chat.ts) on a fake DOM, through the real bridge:
// it talks to Claude Code sessions only. The picker lists them, picking one
// saves it, and a message is typed into a session's terminal when winotch can
// reach it, else sent headless with its answer streaming in.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installFakeDom } from "./fakedom.mjs";
import { calls, emit, internals, sent } from "./tauri.mjs";

installFakeDom();
const { buildPrompt, openChatOn } = await import("../src/views/chat.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");

/** What the mocked Rust side answers, by command. */
let answers;
const plainInvoke = internals.invoke;
internals.invoke = async (cmd, args) => {
  const result = await plainInvoke(cmd, args);
  if (cmd in answers) return typeof answers[cmd] === "function" ? answers[cmd](args) : answers[cmd];
  return result;
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const SESSIONS = [
  { id: "s1", cwd: "/work/app", project: "app", title: "Fix the build", updated: 2 },
  { id: "s2", cwd: "/work/site", project: "site", title: "New page", updated: 1 },
];

let view;
beforeEach(() => {
  calls.length = 0;
  answers = {
    sessions_list: SESSIONS,
    sessions_reachable: [],
    session_messages: { stamp: "1", messages: [] },
  };
  State.settings = { ...DEFAULT_SETTINGS };
  State.stateOverride = null;
  State.view = "prompt";
  State.tasks = [];
  view = buildPrompt(() => {});
  view.sync();
});

const $ = (cls) => view.el.querySelector(cls);
const rows = () => view.el.find(".picker-model").map((m) => m.textContent);
/** The chip's strip: the choices it shows now, and a tap on one of them by its words. */
const strip = () => view.el.find(".chat-strip-item").map((b) => b.textContent);
const tap = (label) => {
  const b = view.el.find(".chat-strip-item").find((x) => x.textContent === label);
  assert.ok(b, `"${label}" in ${JSON.stringify(strip())}`);
  b.fire("click");
};
/** The strip opened on the model (0) or the effort (1). */
const into = (i) => {
  if (!$(".chat-body").classList.contains("picking")) $(".chat-chip").fire("click");
  view.el.find(".chat-strip-item")[i + 1].fire("click");
};
const typeAndSend = (text) => {
  $(".chat-input").value = text;
  $(".send-btn").fire("click");
};

test("nothing picked: the chip and the field ask for a session", () => {
  assert.equal(DEFAULT_SETTINGS.chatSession, "");
  assert.equal($(".chat-chip-name").textContent, "Pick a Claude Code session");
  assert.equal($(".chat-input").placeholder, "Pick a session first");
  assert.equal(view.el.find(".picker-chip").length, 0, "no providers to pick from");
});

test("the chip's strip goes into the sessions by folder, and picking one saves it", async () => {
  answers.sessions_reachable = ["s2"];
  $(".chat-chip").fire("click");
  await flush();
  assert.ok($(".chat-body").classList.contains("picking"));
  assert.equal($(".chat-chip").getAttribute("aria-expanded"), "true");
  // What is picked, as the chip says it: the session, the model, the effort.
  assert.deepEqual(strip(), ["Pick a Claude Code session", "Default model", "Default effort"]);
  tap("Pick a Claude Code session");
  await flush();
  await flush();
  assert.deepEqual(strip(), ["Quick question", "app", "site"]);
  tap("site");
  assert.deepEqual(strip(), ["● New page", "+ New"]);
  $(".chat-strip-back").fire("click");
  tap("app");
  assert.equal($(".chat-strip-title").textContent, "app");
  tap("Fix the build");
  assert.equal(State.settings.chatSession, "s1");
  assert.equal(sent("save_settings").at(-1).settings.chatSession, "s1");
  assert.ok(!$(".chat-body").classList.contains("picking"));
  assert.equal($(".chat-chip-name").textContent, "app · Fix the build");
  assert.equal($(".chat-chip").getAttribute("aria-label"), "app · Fix the build · Default model · Default effort");
});

test("a session open in a reachable terminal is typed into, never sent headless", async () => {
  State.settings = { ...State.settings, chatSession: "s2" };
  view.sync();
  answers.sessions_reachable = ["s2"];
  typeAndSend("hello");
  await flush();
  assert.deepEqual(sent("session_type"), [{ id: "s2", text: "hello" }]);
  assert.deepEqual(sent("session_send"), []);
  assert.equal($(".chat-input").value, "");
});

test("otherwise the message is sent headless and the answer streams in", async () => {
  State.settings = { ...State.settings, chatSession: "s1" };
  view.sync();
  let finish;
  answers.session_send = () => new Promise((resolve) => (finish = resolve));
  typeAndSend("hello");
  await flush();
  assert.equal(sent("session_send").length, 1);
  const { request, id, cwd, text } = sent("session_send")[0];
  assert.deepEqual({ id, cwd, text }, { id: "s1", cwd: null, text: "hello" });
  assert.ok($(".chat-chip").disabled, "no switching mid-answer");
  assert.equal(State.chatAnswering, true, "the island's mark crosses until the answer is in");

  emit("session-stream", { request, session: "s1", kind: "delta", text: "Hello **there**" });
  assert.equal(view.el.find("canvas").length, 0, "no mark of its own in the log");
  assert.equal(view.el.find(".reply")[0].find("STRONG")[0].textContent, "there");

  answers.session_messages = { stamp: "2", messages: [
    { role: "user", text: "hello" },
    { role: "assistant", text: "Hello there!" },
  ] };
  finish("s1");
  await flush();
  await flush();
  assert.equal(view.el.find(".reply").length, 1);
  assert.equal(view.el.find(".reply")[0].textContent, "Hello there!");
  assert.ok(!$(".chat-chip").disabled);
});

test("a new session's id replaces the folder it was started in", async () => {
  State.settings = { ...State.settings, chatSession: "new:/work/app" };
  view.sync();
  answers.session_send = "s9";
  typeAndSend("start");
  await flush();
  await flush();
  assert.deepEqual(sent("session_send").map(({ id, cwd }) => ({ id, cwd })), [{ id: null, cwd: "/work/app" }]);
  assert.equal(State.settings.chatSession, "s9");
  assert.equal(sent("save_settings").at(-1).settings.chatSession, "s9");
});

test("a quick question goes to the quick conversation, keeps its log in the page and passes the chips", async () => {
  State.settings = { ...State.settings, chatSession: "quick", chatModel: "sonnet", chatEffort: "low" };
  view.sync();
  assert.equal($(".chat-input").placeholder, "Ask a quick question…");
  let finish;
  answers.quick_send = () => new Promise((resolve) => (finish = resolve));
  typeAndSend("what is 2+2?");
  await flush();
  assert.deepEqual(sent("session_send"), []);
  assert.deepEqual(sent("session_messages"), [], "nothing of it is read from disk");
  const { request, text, model, effort } = sent("quick_send")[0];
  assert.deepEqual({ text, model, effort }, { text: "what is 2+2?", model: "sonnet", effort: "low" });
  emit("session-stream", { request, session: "q1", kind: "start", text: "" });
  emit("session-stream", { request, session: "q1", kind: "delta", text: "4" });
  emit("session-stream", { request, session: "q1", kind: "done", text: "4." });
  finish(true);
  await flush();
  await flush();
  assert.deepEqual(view.el.find(".bubble").map((b) => b.textContent), ["what is 2+2?"]);
  assert.equal(view.el.find(".reply")[0].textContent, "4.");
  assert.ok(State.headless.has("q1"), "its hooks never read as a terminal's");

  // A follow-up goes to the same conversation. Recent shows its latest
  // exchange; All, the whole conversation, and is remembered.
  answers.quick_send = false;
  typeAndSend("and times 3?");
  await flush();
  await flush();
  assert.equal(sent("quick_send").length, 2);
  assert.deepEqual(sent("quick_reset"), []);
  assert.deepEqual(view.el.find(".bubble").map((b) => b.textContent), ["and times 3?"]);
  const [recent, all] = view.el.find(".chat-history-opt");
  assert.deepEqual([recent.textContent, all.textContent], ["Recent", "All"]);
  all.fire("click");
  assert.deepEqual(view.el.find(".bubble").map((b) => b.textContent), ["what is 2+2?", "and times 3?"]);
  assert.equal(sent("save_settings").at(-1).settings.chatHistory, "all");
  recent.fire("click");
  assert.deepEqual(view.el.find(".bubble").map((b) => b.textContent), ["and times 3?"]);
});

test("the strip picks the model and the effort, saved, and a quick conversation starts over", async () => {
  State.settings = { ...State.settings, chatSession: "quick" };
  view.sync();
  answers.quick_send = false;
  typeAndSend("hi");
  await flush();
  await flush();

  into(0);
  assert.deepEqual(strip(), ["Default", "Opus", "Sonnet", "Fable"]);
  assert.ok(view.el.find(".chat-strip-item")[0].classList.contains("on"));
  tap("Opus");
  await flush();
  assert.equal(State.settings.chatModel, "opus");
  assert.equal(sent("save_settings").at(-1).settings.chatModel, "opus");
  assert.ok(!$(".chat-body").classList.contains("picking"), "a pick folds it back into the field");
  assert.equal($(".chat-chip").getAttribute("aria-label"), "Quick question · Opus · Default effort");
  assert.equal(sent("quick_reset").length, 1);
  // It starts over without a word: the chat is simply empty again.
  assert.equal(view.el.find(".chat-row").length, 0);

  into(1);
  assert.deepEqual(strip(), ["Default", "Low", "Medium", "High", "Extra high", "Max"]);
  tap("Max");
  assert.equal(State.settings.chatEffort, "max");
  assert.equal($(".chat-chip").getAttribute("aria-label"), "Quick question · Opus · Max effort");
});

test("picking a session ends the quick conversation; headless sends carry the chips", async () => {
  State.settings = { ...State.settings, chatSession: "quick", chatModel: "fable", chatEffort: "high" };
  view.sync();
  answers.quick_send = false;
  typeAndSend("hi");
  await flush();
  await flush();
  $(".chat-chip").fire("click");
  tap("Quick question");
  await flush();
  await flush();
  tap("app");
  tap("Fix the build");
  view.sync();
  assert.equal(sent("quick_reset").length, 1);
  answers.session_send = "s1";
  typeAndSend("go on");
  await flush();
  const { model, effort } = sent("session_send")[0];
  assert.deepEqual({ model, effort }, { model: "fable", effort: "high" });
});

test("a chip changed on a session open in a terminal is typed into it", async () => {
  State.settings = { ...State.settings, chatSession: "s2" };
  view.sync();
  answers.sessions_reachable = ["s2"];
  into(0);
  tap("Sonnet");
  await flush();
  await flush();
  into(1);
  tap("Default");
  into(1);
  tap("High");
  await flush();
  await flush();
  assert.deepEqual(sent("session_type"), [{ id: "s2", text: "/model sonnet" }, { id: "s2", text: "/effort high" }]);
  assert.equal(view.el.find(".chat-row.tool").length, 0, "no grey note about it");
});

test("one pill: the field, the chip and the send button, with no row of chips around it", () => {
  const bar = $(".chat-bar");
  // The chip's choices take the field's place, inside it (style.css .chat-strip).
  assert.deepEqual(bar.children.map((c) => c.className), ["chat-input", "chat-chip", "send-btn", "chat-mirror", "chat-strip"]);
  assert.deepEqual($(".chat-body").children.map((c) => c.className), ["chat-logwrap", "chat-bar"]);
  assert.equal(view.el.find(".model-row").length, 0);
});

test("typing folds the chip to its chevron; an empty or unfocused field brings its name back", () => {
  const input = $(".chat-input");
  const bar = $(".chat-bar");
  input.value = "";
  document.activeElement = input;
  input.fire("focus");
  assert.ok(!bar.classList.contains("typing"), "an empty field keeps the name");
  input.value = "hel";
  input.fire("input");
  assert.ok(bar.classList.contains("typing"));
  document.activeElement = null;
  input.fire("blur");
  assert.ok(!bar.classList.contains("typing"), "not focused: the name is back");
  document.activeElement = input;
  input.fire("focus");
  assert.ok(bar.classList.contains("typing"));
  input.value = "";
  input.fire("input");
  assert.ok(!bar.classList.contains("typing"));
  document.activeElement = null;
});

test("Escape folds the picker before anything else, from the field or the chip", () => {
  $(".chat-chip").fire("click");
  assert.ok($(".chat-body").classList.contains("picking"));
  const key = (el, k) => {
    const event = { key: k, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    for (const fn of el.listeners.get("keydown") ?? []) fn(event);
    return event;
  };
  const e = key($(".chat-chip"), "Escape");
  assert.ok(e.stopped && e.defaultPrevented);
  assert.ok(!$(".chat-body").classList.contains("picking"));
  $(".chat-chip").fire("click");
  key($(".chat-input"), "Escape");
  assert.ok(!$(".chat-body").classList.contains("picking"));
  // In the strip, Escape steps back a level, then folds it, never the island.
  $(".chat-chip").fire("click");
  view.el.find(".chat-strip-item")[1].fire("click");
  const once = key($(".chat-strip"), "Escape");
  assert.ok(once.stopped);
  assert.deepEqual(strip(), ["Pick a Claude Code session", "Default model", "Default effort"]);
  key($(".chat-strip"), "Escape");
  assert.ok(!$(".chat-body").classList.contains("picking"));
});

test("Open chat on a finished session: the chat opens on that session and loads its log", async () => {
  State.settings = { ...State.settings, chatSession: "quick" };
  view.sync();
  const shown = [];
  openChatOn("s2", (v) => shown.push(v));
  assert.deepEqual(shown, ["prompt"]);
  assert.equal(State.settings.chatSession, "s2");
  assert.equal(sent("save_settings").at(-1).settings.chatSession, "s2");
  answers.session_messages = { stamp: "3", messages: [{ role: "user", text: "ship it" }, { role: "assistant", text: "Shipped." }] };
  view.sync();
  await flush();
  assert.equal(sent("session_messages").at(-1).id, "s2");
  assert.equal(view.el.find(".reply")[0].textContent, "Shipped.");
  assert.equal($(".chat-chip-name").textContent, "site · New page", "the chip names it");
  // A session nobody knows the id of: the chat opens as it was.
  openChatOn(null, (v) => shown.push(v));
  assert.deepEqual(shown, ["prompt", "prompt"]);
  assert.equal(State.settings.chatSession, "s2");
});

test("the finished card offers Open chat, no longer Open terminal", () => {
  // views.ts needs the whole island to load, so its finished card is read as source.
  const source = readFileSync(new URL("../src/views/views.ts", import.meta.url), "utf8");
  const finished = source.slice(source.indexOf("function buildFinished"), source.indexOf("// ── Confused"));
  assert.ok(finished.includes('tl("Open chat")') && finished.includes('t("Open chat")'));
  assert.ok(finished.includes("openChatOn(State.finishedTurnOf(task)?.sessionId, actions.setView)"));
  assert.ok(!finished.includes("Open terminal"));
});

// ── The field grows with its text ────────────────────────────────────────────

/** A key pressed in an element, with Shift or an IME composition if asked. */
const press = (el, key, extra = {}) => {
  const event = { key, keyCode: 0, shiftKey: false, isComposing: false, ...extra, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
  for (const fn of el.listeners.get("keydown") ?? []) fn(event);
  return event;
};

/**
 * The field laid out 300 px wide; its twin measures as a browser would: one
 * 18 px line per 40 characters or line break, 10 px of padding.
 */
const layOut = () => {
  const input = $(".chat-input");
  const mirror = $(".chat-mirror");
  input.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 28, right: 300, bottom: 28 });
  Object.defineProperty(mirror, "scrollHeight", {
    get: () => mirror.value.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 40)), 0) * 18 + 10,
  });
  return input;
};
const typeLines = (input, n) => {
  input.value = Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
  input.fire("input");
};

test("the field is a one-row text area, and its twin is out of sight", () => {
  const input = $(".chat-input");
  assert.equal(input.tagName, "TEXTAREA");
  assert.equal(input.getAttribute("rows"), "1");
  const mirror = $(".chat-mirror");
  assert.equal(mirror.tagName, "TEXTAREA");
  assert.equal(mirror.getAttribute("aria-hidden"), "true");
  assert.equal(mirror.getAttribute("tabindex"), "-1");
  assert.equal(input.style.height, undefined, "one line: the stylesheet's own height");
});

test("the field grows a line at a time up to six, then scrolls inside itself", () => {
  const input = layOut();
  const bar = $(".chat-bar");
  typeLines(input, 1);
  assert.equal(input.style.height, undefined);
  assert.ok(!bar.classList.contains("multiline"), "one line: the pill");
  // A long line wraps: two lines, without a break typed.
  input.value = "x".repeat(70);
  input.fire("input");
  assert.equal(input.style.height, "46px");
  assert.ok(bar.classList.contains("multiline"), "more lines: a rounded card");
  typeLines(input, 3);
  assert.equal(input.style.height, "64px");
  typeLines(input, 6);
  assert.equal(input.style.height, "118px");
  assert.ok(!input.classList.contains("scrolls"));
  typeLines(input, 9);
  assert.equal(input.style.height, "118px", "six lines at most");
  assert.ok(input.classList.contains("scrolls"), "past six, it scrolls");
  typeLines(input, 2);
  assert.equal(input.style.height, "46px");
  assert.ok(!input.classList.contains("scrolls"));
  input.value = "";
  input.fire("input");
  assert.equal(input.style.height, "28px", "empty: one line again");
  assert.ok(!bar.classList.contains("multiline"));
});

test("Enter sends, Shift+Enter breaks the line, and Enter in an IME composition only picks the word", async () => {
  State.settings = { ...State.settings, chatSession: "quick" };
  view.sync();
  answers.quick_send = false;
  const input = layOut();
  input.value = "first line";
  const shift = press(input, "Enter", { shiftKey: true });
  assert.ok(!shift.defaultPrevented, "the text area takes the new line itself");
  input.value = "first line\nsecond line";
  input.fire("input");
  assert.equal(input.style.height, "46px");
  for (const composing of [{ isComposing: true }, { keyCode: 229 }]) {
    const e = press(input, "Enter", composing);
    assert.ok(!e.defaultPrevented);
  }
  await flush();
  assert.deepEqual(sent("quick_send"), [], "nothing sent while typing");
  const enter = press(input, "Enter");
  assert.ok(enter.defaultPrevented, "Enter never adds a line");
  assert.equal(input.value, "", "sent: the field is empty");
  assert.equal(input.style.height, "28px", "and one line again");
  assert.ok(!$(".chat-bar").classList.contains("multiline"));
  await flush();
  await flush();
  assert.equal(sent("quick_send")[0].text, "first line\nsecond line", "its lines kept");
  assert.deepEqual(view.el.find(".bubble").map((b) => b.textContent), ["first line\nsecond line"]);
});

test("a message with several lines keeps them headless, and is one line typed into a terminal", async () => {
  State.settings = { ...State.settings, chatSession: "s1" };
  view.sync();
  answers.session_send = "s1";
  typeAndSend("  fix this\n\nand  that  ");
  await flush();
  assert.equal(sent("session_send")[0].text, "fix this\n\nand  that");

  State.settings = { ...State.settings, chatSession: "s2" };
  view.sync();
  answers.sessions_reachable = ["s2"];
  const input = layOut();
  input.value = "fix this\nand that";
  input.fire("input");
  assert.equal(input.style.height, "46px");
  press(input, "Enter");
  await flush();
  await flush();
  // Enter in the terminal would send the first line alone.
  assert.deepEqual(sent("session_type"), [{ id: "s2", text: "fix this and that" }]);
  assert.equal(input.value, "");
  assert.equal(input.style.height, "28px");
  assert.equal(view.el.find(".bubble").at(-1).textContent, "fix this and that");
});

// ── Reading (views/chat.ts) ───────────────────────────────────────────────────

const { turnsOf } = await import("../src/views/chat.ts");

test("the log reads in turns: a question and what came back for it", () => {
  const turns = turnsOf([
    { role: "assistant", text: "left from before" },
    { role: "user", text: "q1" },
    { role: "tool", text: "Read a.ts" },
    { role: "assistant", text: "a1" },
    { role: "user", text: "q2" },
  ]);
  assert.deepEqual(turns.map((t) => [t.ask?.text ?? null, t.rest.map((m) => m.text)]), [
    [null, ["left from before"]],
    ["q1", ["Read a.ts", "a1"]],
    ["q2", []],
  ]);
});

// ── Asked by voice (views/chat.ts ask) ────────────────────────────────────────

test("what was said goes to the quick conversation, and the island is told what was asked, then the answer", async () => {
  const said = [];
  const talk = buildPrompt(() => {}, (line) => said.push(line));
  State.settings = { ...State.settings, chatSession: "some-session" };
  talk.sync();
  let finish;
  answers.quick_send = () => new Promise((resolve) => (finish = resolve));
  talk.ask("draft a reply to Sarah");
  await flush();
  assert.equal(State.settings.chatSession, "quick", "asked in the quick conversation");
  const { request, text } = sent("quick_send").at(-1);
  assert.equal(text, "draft a reply to Sarah");
  assert.deepEqual(said, [{ phase: "asking", text: "draft a reply to Sarah" }]);
  emit("session-stream", { request, session: "q9", kind: "start", text: "" });
  emit("session-stream", { request, session: "q9", kind: "done", text: "Draft saved for Sarah." });
  finish(true);
  await flush();
  await flush();
  assert.deepEqual(said.at(-1), { phase: "answer", text: "Draft saved for Sarah." });
  // The exchange is the console's too.
  assert.deepEqual(talk.el.find(".reply").map((r) => r.textContent), ["Draft saved for Sarah."]);
});

// ── Said big (views/say.ts) ───────────────────────────────────────────────────

const { pagesOf, plainAnswer, readFor, wrapLines } = await import("../src/views/say.ts");

test("an answer said big reads as plain words: no Markdown marks, lists as bullets", () => {
  assert.equal(plainAnswer("**Done.** Saved as `draft-1`.\n- one\n* two\n## Next"), "Done. Saved as draft-1.\n• one\n• two\nNext");
});

test("it is cut at words into lines that fit, and the lines into pages of what fits", () => {
  const measure = (t) => t.length * 10;
  const lines = wrapLines("one two three four five\nsix", 100, measure);
  assert.deepEqual(lines, ["one two", "three four", "five", "six"]);
  assert.deepEqual(pagesOf(lines, 3), [["one two", "three four", "five"], ["six"]]);
  assert.deepEqual(pagesOf(lines, 0), [["one two"], ["three four"], ["five"], ["six"]]);
});

test("the light reads at the pace chosen, a page line after line, then holds a moment", async () => {
  const { lineFor, PACES, SAY } = await import("../src/views/say.ts");
  assert.deepEqual([...PACES], [200, 250, 300, 350, 400]);
  const ten = "one two three four five six seven eight nine ten";
  assert.equal(lineFor(ten, 300), 2000, "300 words a minute: 200 ms a word");
  assert.equal(lineFor(ten, 200), 3000);
  assert.equal(lineFor(ten, 400), 1500);
  assert.equal(lineFor("Done.", 300), 470, "a short line is never rushed past");
  assert.equal(readFor(["Done.", ten], 300), 470 + 2000 + SAY.hold);
  // The setting decides, and anything else reads at 300.
  State.settings = { ...State.settings, sayPace: 400 };
  assert.equal(lineFor(ten), 1500);
  State.settings = { ...State.settings, sayPace: 123 };
  assert.equal(lineFor(ten), 2000);
});

test("the console measures what it shows, never the room it was given", async () => {
  const { contentHeight } = await import("../src/views/chat.ts");
  globalThis.getComputedStyle ??= () => ({ paddingBottom: "2px" });
  const rows = { offsetTop: 40, offsetHeight: 60 };
  // The island grew, and the log with it: what it shows did not, nor does its measure.
  const box = { lastElementChild: rows, clientHeight: 120, scrollHeight: 120 };
  const before = contentHeight(box);
  box.clientHeight = box.scrollHeight = 480;
  assert.equal(contentHeight(box), before);
  assert.equal(before, 102);
  assert.equal(contentHeight({ lastElementChild: null }), 0);
});

test("the answer's island is as tall as its lines, up to three; more show three at a time", async () => {
  const { linesShown, pagesOf: pages } = await import("../src/views/say.ts");
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(linesShown), [1, 1, 2, 3, 3, 3]);
  assert.deepEqual(pages(["a", "b", "c", "d", "e", "f", "g"], 3), [["a", "b", "c"], ["d", "e", "f"], ["g"]]);
});

test("an answer's lines are balanced: as many as fit, each about one length, never narrower than a word", async () => {
  const { balancedLines, wrapLines: wrap } = await import("../src/views/say.ts");
  const measure = (t) => t.length * 10;
  const text = "the quick brown fox jumps over the lazy dog";
  // Wrapped greedily at 300 px: a full line and a stub.
  assert.deepEqual(wrap(text, 300, measure).map((l) => l.length), [30, 12]);
  const even = balancedLines(text, 300, measure);
  assert.equal(even.length, wrap(text, 300, measure).length, "no more lines than it needs");
  const lengths = even.map((l) => l.length);
  assert.ok(Math.max(...lengths) - Math.min(...lengths) <= 6, `about one length: ${lengths}`);
  assert.deepEqual(balancedLines("short", 300, measure), ["short"]);
  assert.deepEqual(balancedLines("supercalifragilistic word", 100, measure), ["supercalifragilistic", "word"]);
});

test("what was asked shows from its start, over up to three balanced lines, a longer one cut at the end", async () => {
  const { askedLines, SAY } = await import("../src/views/say.ts");
  const measure = (t) => t.length * 10;
  const short = askedLines("what is on today", measure);
  assert.deepEqual(short, ["what is on today"]);
  const long = askedLines(Array.from({ length: 200 }, (_, i) => `w${i}`).join(" "), measure);
  assert.equal(long.length, SAY.lines);
  assert.ok(long[0].startsWith("w0 "), "its start shows");
  assert.ok(long[2].endsWith(" …"), "the rest is cut at the last line's end");
  assert.ok(long.every((l) => measure(l) <= SAY.maxWidth));
});

test("what waits for the chat's answer runs once it is in, and at once when none is coming", async () => {
  const ran = [];
  view.whenIdle(() => ran.push("now"));
  assert.deepEqual(ran, ["now"]);
  State.settings = { ...State.settings, chatSession: "quick" };
  view.sync();
  let finish;
  answers.quick_send = () => new Promise((resolve) => (finish = resolve));
  typeAndSend("open my last tent.js session");
  await flush();
  view.whenIdle(() => ran.push("after"));
  assert.deepEqual(ran, ["now"], "not while the answer is coming");
  finish(true);
  await flush();
  await flush();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(ran, ["now", "after"]);
});

test("the chat holds the island open only while something is typed or its choices are open", () => {
  const input = $(".chat-input");
  input.value = "";
  input.fire("input");
  assert.equal(State.chatHolds, false, "empty: it folds on leaving like any screen");
  input.value = "a draft";
  input.fire("input");
  assert.equal(State.chatHolds, true, "a draft is not lost to a fold");
  input.value = "  ";
  input.fire("input");
  assert.equal(State.chatHolds, false);
  $(".chat-chip").fire("click");
  assert.equal(State.chatHolds, true, "nor the chip's choices, open");
});
