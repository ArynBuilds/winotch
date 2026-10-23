// One app, expanded (views/appdetail.ts, core/app-detail.ts): a list's views
// in the left column filter it here, sections kept; an item with details
// slides into its pane (asked of Rust with app_item_detail), whose buttons
// press as the item's own; back and Esc return to the list where it was; a
// notification about an item opens its app on it. Gmail is the app used.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { internals, sent } from "./tauri.mjs";

installFakeDom();

const { State } = await import("../src/core/state.ts");
const { Feed } = await import("../src/core/apps.ts");
const { chooseView, currentView, findItem, sectionsInView, splitQuoted } = await import("../src/core/app-detail.ts");
const { buildAppDetail, DetailTiming } = await import("../src/views/appdetail.ts");
const { buildNotifications } = await import("../src/views/notifications.ts");
const { useRegistry } = await import("./registry.mjs");

const PILL = "app_gmail";

const mail = (id, title, views, extra = {}) => ({
  id, title, subtitle: `Ana · ${title}`, time: Date.now(), unread: views.includes("unread"), url: `https://mail.google.com/#all/${id}`,
  actions: [{ id: "archive", label: "Archive" }], detail: true, views, ...extra,
});

// A count an older app may still send: never shown.
const VIEWS = [
  { id: "inbox", label: "Inbox", count: 2 },
  { id: "primary", label: "Primary" },
  { id: "unread", label: "Unread" },
];

function gmailList(work = [mail("w:1", "Plan", ["inbox", "primary", "unread"]), mail("w:2", "News", ["inbox"])]) {
  return {
    status: "2 unread",
    updated: 1,
    views: VIEWS,
    sections: [
      { title: "Work", items: work },
      { title: "Home", items: [mail("h:1", "Dinner", ["inbox", "unread"])] },
    ],
  };
}

/** What Rust answers app_item_detail with, per test; HANG: never. */
let answer = null;
const HANG = Symbol("hang");
const plainInvoke = internals.invoke;
internals.invoke = async (cmd, args) => {
  if (cmd === "app_item_detail") {
    await plainInvoke(cmd, args);
    if (answer === HANG) return new Promise(() => {});
    if (answer instanceof Error) throw answer.message;
    return answer;
  }
  return plainInvoke(cmd, args);
};

const DETAIL = {
  title: "Plan for Friday",
  meta: ["From Ana <ana@example.com>", "To me@gmail.com", "2026-10-17 09:05"],
  body: "Hi,\n\nsee https://example.com\nAna",
  attachments: ["plan.pdf", "map.png"],
  url: "https://mail.google.com/#all/1",
  actions: [{ id: "archive", label: "Archive" }, { id: "open", label: "Open in Gmail" }],
};

const tick = () => new Promise((r) => setImmediate(r));

function setup(list = gmailList(), notifications = []) {
  useRegistry({ gmail: true, lists: { gmail: list }, notifications });
  State.detailApp = PILL;
  State.view = "app";
  const opened = [];
  const views = [];
  const actions = {
    setView: (v) => {
      views.push(v);
      State.view = v;
      State.notify();
    },
    blip() {},
    openUrl: (u) => opened.push(u),
  };
  const host = buildAppDetail(actions);
  host.sync();
  return { host, actions, opened, views };
}

const byClass = (el, cls) => el.find(`.${cls}`);
const rows = (host) => byClass(host.el, "ad-item");
const titles = (host) => rows(host).map((r) => byClass(r, "ad-title")[0].textContent);
const card = (host) => byClass(host.el, "ad-card")[0];

beforeEach(() => {
  answer = DETAIL;
  chooseView("gmail", "inbox");
  Feed.error = null;
});

// ── Views ─────────────────────────────────────────────────────────────────────

test("a view filters the list here, keeping its sections; no views is the whole list", () => {
  const detail = { sections: gmailList().sections };
  const ids = (sections) => sections.map((s) => [s.title, s.items.map((i) => i.id)]);
  assert.deepEqual(ids(sectionsInView(detail.sections, "primary")), [["Work", ["w:1"]], ["Home", []]]);
  assert.deepEqual(ids(sectionsInView(detail.sections, "unread")), [["Work", ["w:1"]], ["Home", ["h:1"]]]);
  assert.deepEqual(ids(sectionsInView(detail.sections, null)), [["Work", ["w:1", "w:2"]], ["Home", ["h:1"]]]);
  // An item naming no views is in all of them.
  assert.deepEqual(ids(sectionsInView([{ title: null, items: [{ id: "x", title: "x" }] }], "primary")), [[null, ["x"]]]);
  // The chosen view is remembered per app; one that is gone falls back to the first.
  assert.equal(currentView("gmail", undefined), null);
  chooseView("gmail", "unread");
  assert.equal(currentView("gmail", VIEWS), "unread");
  assert.equal(currentView("other", VIEWS), "inbox");
  assert.equal(currentView("gmail", VIEWS.filter((v) => v.id !== "unread")), "inbox");
});

test("the views stand in the left column as their words only, and choosing one filters the rows", () => {
  const { host } = setup();
  const buttons = byClass(host.el, "ad-view");
  assert.deepEqual(buttons.map((b) => b.textContent), ["Inbox", "Primary", "Unread"], "no count, nothing but the word");
  assert.equal(buttons[0].children.length, 0, "one text, nothing beside it");
  assert.ok(card(host).classList.contains("has-views"), "the list makes room for the column");
  assert.ok(buttons[0].classList.contains("on"));
  assert.deepEqual(titles(host), ["Plan", "News", "Dinner"]);
  assert.deepEqual(byClass(host.el, "ad-caption").map((c) => c.textContent), ["Work", "Home"]);

  buttons[1].fire("click");
  assert.deepEqual(titles(host), ["Plan"]);
  assert.deepEqual(byClass(host.el, "ad-caption").map((c) => c.textContent), ["Work"], "an empty section is left out");
  assert.ok(byClass(host.el, "ad-view")[1].classList.contains("on"));

  // Remembered for the session: a new view of Gmail opens on Primary.
  assert.deepEqual(titles(setup().host), ["Plan"]);
});

test("a view with nothing in it says so, and an app without views has an empty column", () => {
  const list = gmailList([mail("w:2", "News", ["inbox"])]);
  list.sections = [list.sections[0]];
  chooseView("gmail", "primary");
  const { host } = setup(list);
  assert.equal(rows(host).length, 0);
  assert.equal(byClass(host.el, "ad-empty")[0].textContent, "Nothing here yet.");

  delete list.views;
  const plain = setup(list).host;
  assert.equal(byClass(plain.el, "ad-view").length, 0);
  assert.deepEqual(titles(plain), ["News"]);
});

// ── Details ───────────────────────────────────────────────────────────────────

test("a row with details slides into its pane: the title at once, then the rest", async () => {
  const { host, opened } = setup();
  const list = byClass(host.el, "ad-list")[0];
  list.scrollTop = 120;
  const before = sent("app_item_detail").length;
  rows(host)[0].fire("click");
  assert.equal(host.mode, "detail");
  assert.ok(card(host).classList.contains("detail"));
  assert.deepEqual(sent("app_item_detail").slice(before), [{ app: "gmail", item: "w:1" }]);
  assert.equal(opened.length, 0, "its link is not opened");
  // Asked, not answered yet: the row's title, nothing else.
  assert.equal(byClass(host.el, "ad-subject")[0].textContent, "Plan");
  assert.ok(!byClass(host.el, "ad-pane")[0].classList.contains("ready"));

  await tick();
  assert.equal(byClass(host.el, "ad-subject")[0].textContent, "Plan for Friday");
  assert.ok(byClass(host.el, "ad-pane")[0].classList.contains("ready"));
  assert.deepEqual(byClass(host.el, "ad-meta-line").map((l) => l.textContent), DETAIL.meta);
  assert.equal(byClass(host.el, "ad-body")[0].textContent, DETAIL.body, "text as it came, line breaks and all");
  assert.equal(byClass(host.el, "ad-body")[0].find("A").length, 0, "no link in it");
  assert.equal(byClass(host.el, "ad-files")[0].textContent, "plan.pdf · map.png");
  const tools = byClass(host.el, "ad-tools")[0].find("BUTTON");
  assert.deepEqual(tools.map((b) => b.textContent), ["Archive", "Open in Gmail"]);
  assert.ok(tools[0].classList.contains("primary") && tools[1].classList.contains("secondary"));

  // Its buttons press as the item's own.
  const pressed = sent("app_item_act").length;
  tools[1].fire("click");
  assert.deepEqual(sent("app_item_act").slice(pressed), [{ app: "gmail", item: "w:1", action: "open" }]);

  // Back: the list, where it was; then nothing more to step back from.
  list.scrollTop = 0;
  assert.equal(host.back(), true);
  assert.equal(host.mode, "list");
  assert.ok(!card(host).classList.contains("detail"));
  assert.equal(list.scrollTop, 120);
  assert.equal(host.back(), false, "the island's Esc then goes to the overview");
});

test("the back arrow steps out of the details first, then out of the app", async () => {
  const { host, views } = setup();
  rows(host)[0].fire("click");
  const arrow = byClass(host.el, "ad-back")[0];
  arrow.fire("click");
  assert.equal(host.mode, "list");
  assert.deepEqual(views, []);
  arrow.fire("click");
  assert.deepEqual(views, ["overview"]);
});

test("an item archived from its details leaves them for the list; a late answer is ignored", async () => {
  const { host } = setup();
  rows(host)[0].fire("click");
  await tick();
  // The next list Gmail publishes has it no more.
  Feed.lists.gmail = gmailList([mail("w:2", "News", ["inbox"])]);
  host.sync();
  assert.equal(host.mode, "list");
  assert.deepEqual(titles(host), ["News", "Dinner"]);

  // Opened, then left before Rust answered: the answer draws nothing.
  rows(host)[0].fire("click");
  host.back();
  await tick();
  assert.equal(host.mode, "list");
  assert.equal(byClass(host.el, "ad-meta-line").length, 0);
});

test("details that fail say why in one line", async () => {
  answer = new Error("Can't reach Gmail: timed out");
  const { host } = setup();
  rows(host)[0].fire("click");
  await tick();
  assert.equal(byClass(host.el, "ad-fail")[0].textContent, "Can't reach Gmail: timed out");
  assert.equal(byClass(host.el, "ad-tools")[0].find("BUTTON").length, 0);
});

// ── The pane: at once, folds, never empty ─────────────────────────────────────

/** Gmail's answer (mail/detail.rs `item_detail`): a byline, the addresses behind it. */
const GMAIL_DETAIL = {
  title: "Plan for Friday",
  byline: "Ana Müller · 2026-10-17 09:05",
  meta: ["From Ana Müller <ana@example.com>", "To me@gmail.com", "Cc bo@example.com"],
  body: "Sounds good, see you then.\n\nOn Sat, 17 Oct 2026 at 09:05, Ana Müller <\nana@example.com> wrote:\n> Lunch on Friday?\n> Ana",
  attachments: [],
  url: "https://mail.google.com/#all/1",
  actions: [{ id: "archive", label: "Archive" }, { id: "open", label: "Open in Gmail" }],
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shown = (el) => el.style.display !== "none";

test("the pane shows the list's byline at once, then the sender and date with the addresses behind a chevron", async () => {
  answer = GMAIL_DETAIL;
  const list = gmailList([mail("w:1", "Plan", ["inbox"], { byline: "Ana Müller · 2026-10-17 09:05" })]);
  const { host } = setup(list);
  rows(host)[0].fire("click");
  // Before Rust answered: who and when, from the list.
  assert.equal(byClass(host.el, "ad-byline-text")[0].textContent, "Ana Müller · 2026-10-17 09:05");
  assert.ok(shown(byClass(host.el, "ad-byline")[0]));
  await tick();
  const toggle = byClass(host.el, "ad-meta-toggle")[0];
  const meta = byClass(host.el, "ad-meta")[0];
  assert.ok(shown(toggle), "the chevron, beside the byline");
  assert.ok(!shown(meta), "To and Cc are hidden at first");
  assert.equal(toggle.getAttribute("title"), "Show details");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  toggle.fire("click");
  assert.ok(shown(meta));
  assert.deepEqual(byClass(host.el, "ad-meta-line").map((l) => l.textContent), GMAIL_DETAIL.meta);
  assert.equal(toggle.getAttribute("title"), "Hide details");
  toggle.fire("click");
  assert.ok(!shown(meta), "and folded again");
  // The next mail opens folded.
  host.back();
  rows(host)[0].fire("click");
  await tick();
  assert.ok(!shown(byClass(host.el, "ad-meta")[0]));
});

test("an app's details without a byline show their lines as they are, with no chevron", async () => {
  const { host } = setup();
  rows(host)[0].fire("click");
  await tick();
  assert.ok(!shown(byClass(host.el, "ad-byline")[0]));
  assert.ok(!shown(byClass(host.el, "ad-meta-toggle")[0]));
  assert.ok(shown(byClass(host.el, "ad-meta")[0]));
  assert.deepEqual(byClass(host.el, "ad-meta-line").map((l) => l.textContent), DETAIL.meta);
});

test("the earlier mail quoted at the end waits behind a small …", async () => {
  answer = GMAIL_DETAIL;
  const { host } = setup();
  rows(host)[0].fire("click");
  await tick();
  const body = byClass(host.el, "ad-body").filter((b) => !b.classList.contains("ad-quoted"))[0];
  const quoted = byClass(host.el, "ad-quoted")[0];
  const trim = byClass(host.el, "ad-trim")[0];
  assert.equal(body.textContent, "Sounds good, see you then.");
  assert.ok(shown(trim) && !shown(quoted));
  assert.equal(trim.textContent, "…");
  assert.equal(trim.getAttribute("title"), "Show trimmed content");
  trim.fire("click");
  assert.ok(shown(quoted));
  assert.equal(quoted.textContent, "On Sat, 17 Oct 2026 at 09:05, Ana Müller <\nana@example.com> wrote:\n> Lunch on Friday?\n> Ana");
  assert.equal(trim.getAttribute("title"), "Hide trimmed content");
  trim.fire("click");
  assert.ok(!shown(quoted));

  // Nothing quoted: no "…".
  answer = DETAIL;
  host.back();
  rows(host)[0].fire("click");
  await tick();
  assert.ok(!shown(byClass(host.el, "ad-trim")[0]));
});

test("a quoted tail is told from a quote in the text, in the languages mail comes in", () => {
  const split = (t) => splitQuoted(t);
  // "On … wrote:" and its "> " lines, at the end.
  assert.deepEqual(split("Yes.\n\nOn Fri, Ana <a@b.co> wrote:\n> Lunch?\n>\n> A\n"), { main: "Yes.", quoted: "On Fri, Ana <a@b.co> wrote:\n> Lunch?\n>\n> A" });
  // Turkish, French, German attributions.
  assert.equal(split("Tamam.\n\n17 Eki 2026 Cmt, Ana <a@b.co> şunu yazdı:\n> Öğle?").main, "Tamam.");
  assert.equal(split("Oui.\n\nLe sam. 17 oct. 2026, Ana <a@b.co> a écrit :\n> Déjeuner ?").main, "Oui.");
  assert.equal(split("Ja.\n\nAm Sa., 17. Okt. 2026 um 09:05 Uhr schrieb Ana <a@b.co>:\n> Mittag?").main, "Ja.");
  // Outlook's rule: everything from it.
  assert.deepEqual(split("Fine.\n\n-----Original Message-----\nFrom: Ana\nSent: Friday\n\nLunch?"), { main: "Fine.", quoted: "-----Original Message-----\nFrom: Ana\nSent: Friday\n\nLunch?" });
  // A quote inside the text, answered below it, stays.
  assert.deepEqual(split("> Lunch?\nYes, at noon.\n\n> And Bo?\nHe comes too."), { main: "> Lunch?\nYes, at noon.\n\n> And Bo?\nHe comes too.", quoted: null });
  // Only a quote: shown whole, nothing to fold.
  assert.equal(split("> Lunch?\n> Ana").quoted, null);
  // A plain text: nothing.
  assert.deepEqual(split("Hello"), { main: "Hello", quoted: null });
});

test("a slow answer says Loading…, and none at all ends in one line saying so, logged", async () => {
  const saved = { ...DetailTiming };
  DetailTiming.wait = 5;
  DetailTiming.giveUp = 30;
  try {
    answer = HANG;
    const { host } = setup();
    const logged = sent("log_line").length;
    rows(host)[0].fire("click");
    const pane = byClass(host.el, "ad-pane")[0];
    assert.ok(!pane.classList.contains("waiting"), "no Loading… flash for a quick answer");
    await wait(15);
    assert.ok(pane.classList.contains("waiting"));
    assert.equal(byClass(host.el, "ad-wait")[0].textContent, "Loading…");
    await wait(40);
    assert.ok(!pane.classList.contains("waiting"));
    assert.equal(byClass(host.el, "ad-fail")[0].textContent, "Gmail did not answer");
    assert.ok(sent("log_line").slice(logged).some((l) => /gmail item details: no answer after 30 ms/.test(l.message)));
  } finally {
    Object.assign(DetailTiming, saved);
  }
});

test("a failed answer is logged without what it said, and a wrong shape still ends in one line", async () => {
  answer = new Error("Can't reach Gmail: no answer");
  const { host } = setup();
  let logged = sent("log_line").length;
  rows(host)[0].fire("click");
  await tick();
  const lines = sent("log_line").slice(logged).map((l) => l.message);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^app view: gmail item details failed after \d+ ms$/);

  // Details that are not the shape the pane reads: an error line, not an empty pane.
  answer = { title: "x" };
  host.back();
  logged = sent("log_line").length;
  rows(host)[0].fire("click");
  await tick();
  assert.equal(byClass(host.el, "ad-fail")[0].textContent, "Gmail did not answer");
  assert.ok(!byClass(host.el, "ad-pane")[0].classList.contains("ready"));
  assert.ok(sent("log_line").slice(logged).some((l) => /failed to draw \(TypeError\)/.test(l.message)));
});

test("a pointer resting on a row reads it ahead, once", async () => {
  const saved = DetailTiming.hover;
  DetailTiming.hover = 1;
  try {
    const { host } = setup();
    const before = sent("app_item_prefetch").length;
    const row = rows(host)[1];
    row.fire("mouseenter");
    row.fire("mouseleave");
    await wait(10);
    assert.equal(sent("app_item_prefetch").length, before, "passing over it is no rest");
    row.fire("mouseenter");
    await wait(10);
    assert.deepEqual(sent("app_item_prefetch").slice(before), [{ app: "gmail", item: "w:2" }]);
    row.fire("mouseenter");
    await wait(10);
    assert.equal(sent("app_item_prefetch").length, before + 1, "once per row");
  } finally {
    DetailTiming.hover = saved;
  }
});

test("a row without details still opens its link", () => {
  const list = gmailList([mail("w:9", "Old", ["inbox"], { detail: false })]);
  const { host, opened } = setup(list);
  rows(host)[0].fire("click");
  assert.equal(host.mode, "list");
  assert.deepEqual(opened, ["https://mail.google.com/#all/w:9"]);
});

test("leaving the app view ends its details", () => {
  const { host } = setup();
  rows(host)[0].fire("click");
  State.view = "overview";
  State.notify();
  assert.equal(host.mode, "list");
});

// ── From a notification ───────────────────────────────────────────────────────

const note = (id, item, extra = {}) => ({
  id, app: "gmail", title: "Ana", body: "Plan — see", url: "https://mail.google.com/#all/1", importance: "normal",
  actions: [{ id: "read", label: "Mark read" }], time: Date.now(), read: false, acted: null, item, ...extra,
});

test("a notification about an item opens its app expanded on that item's details", async () => {
  const { host, actions, views, opened } = setup(gmailList(), [note("7", "h:1")]);
  State.view = "notifications";
  State.detailApp = null;
  chooseView("gmail", "primary"); // Dinner is not in Primary: the view gives way.
  const feed = buildNotifications(actions, host);
  feed.sync();
  const before = sent("app_item_detail").length;
  byClass(feed.el, "feed-item")[0].fire("click");
  assert.deepEqual(views, ["app"]);
  assert.equal(State.detailApp, PILL);
  assert.equal(host.mode, "detail");
  assert.deepEqual(sent("app_item_detail").slice(before), [{ app: "gmail", item: "h:1" }]);
  assert.deepEqual(sent("notification_read").at(-1), { id: "7", ofApp: null }, "the notification is read");
  assert.deepEqual(opened, [], "not sent to the browser");
  assert.equal(currentView("gmail", VIEWS), "inbox");

  // The island draws the view: the details stay.
  host.sync();
  await tick();
  assert.equal(host.mode, "detail");
  assert.equal(byClass(host.el, "ad-subject")[0].textContent, "Plan for Friday");
});

test("a notification whose item has no details opens the list; without an item it keeps its link", () => {
  const list = gmailList([mail("w:9", "Old", ["inbox"], { detail: false }), mail("w:2", "News", ["inbox"])]);
  const { host, actions, views, opened } = setup(list, [note("8", "w:9"), note("9", null), note("10", "gone")]);
  State.view = "notifications";
  const feed = buildNotifications(actions, host);
  feed.sync();
  const [about, plain, gone] = byClass(feed.el, "feed-item");
  about.fire("click");
  assert.deepEqual(views, ["app"]);
  assert.equal(host.mode, "list");

  plain.fire("click");
  assert.deepEqual(opened, ["https://mail.google.com/#all/1"]);
  // An item the list no longer has: the app's list, as it expands.
  gone.fire("click");
  assert.deepEqual(views, ["app", "app"]);
  assert.equal(host.mode, "list");
});

test("items are found by their id, or by a presenter's prefixed one", () => {
  const detail = { sections: [{ items: [{ id: "thread:42", title: "a" }, { id: "me@gmail.com:3eb", title: "b" }] }] };
  assert.equal(findItem(detail, "42").title, "a");
  assert.equal(findItem(detail, "me@gmail.com:3eb").title, "b");
  assert.equal(findItem(detail, "3eb"), null, "a mail's id is never cut");
  assert.equal(findItem(detail, "7"), null);
});
