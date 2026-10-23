// Today (core/today.ts, views/today.ts): what each screen shows of the
// to-dos and notes Rust sends (today's list, the week ahead, a month's grid
// with its dots), its card in the overview, and its big view: the quick add,
// the views, the calendar, and a to-do's or a note's details edited in place,
// every change going to Rust through the today_* commands.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { calls, sent } from "./tauri.mjs";

installFakeDom();

const { State } = await import("../src/core/state.ts");
const { Feed } = await import("../src/core/apps.ts");
const {
  Today, cardTodos, dayLabel, monthGrid, todayDetail, todayGroups, todayStatus, todoViews, upcomingGroups,
} = await import("../src/core/today.ts");
const { dayFromIso, dayOf, isoOf } = await import("../src/core/today-parse.ts");
const { canExpand, chooseView, findItem } = await import("../src/core/app-detail.ts");
const { buildAppDetail } = await import("../src/views/appdetail.ts");
const { buildTodayCard } = await import("../src/views/today.ts");
const { useRegistry } = await import("./registry.mjs");

const D = (iso) => dayFromIso(iso);
const todo = (id, title, extra = {}) => ({ id, title, done: false, created: Number(id.slice(1)), ...extra });

// ── What each view shows (a fixed day: Sunday 18 October 2026) ───────────────

const SUNDAY = D("2026-10-18");
const SAMPLE = [
  todo("t1", "late", { date: "2026-10-16" }),
  todo("t2", "late but done", { date: "2026-10-15", done: true }),
  todo("t3", "today at 15", { date: "2026-10-18", time: "15:00" }),
  todo("t4", "today, done", { date: "2026-10-18", done: true }),
  todo("t5", "today", { date: "2026-10-18" }),
  todo("t6", "tomorrow", { date: "2026-10-19", time: "09:30" }),
  todo("t7", "wednesday", { date: "2026-10-21" }),
  todo("t8", "in a week", { date: "2026-10-25" }),
  todo("t9", "in eight days", { date: "2026-10-26" }),
  todo("t10", "someday"),
  todo("t11", "someday, done", { done: true }),
];

const shape = (groups) => groups.map((g) => [g.title, g.todos.map((x) => x.id)]);

test("Today: what is late and not done, then today's, the done ones last", () => {
  assert.deepEqual(shape(todayGroups(SAMPLE, SUNDAY)), [["Overdue", ["t1"]], ["Today", ["t5", "t3", "t4"]]]);
  assert.deepEqual(todayGroups([], SUNDAY), []);
  // The card: only what is open, late first.
  assert.deepEqual(cardTodos(SAMPLE, SUNDAY).map((x) => x.id), ["t1", "t5", "t3"]);
});

test("Upcoming: the seven days after today, each named, days without any left out, then someday", () => {
  assert.deepEqual(shape(upcomingGroups(SAMPLE, SUNDAY)), [
    ["Tomorrow", ["t6"]], ["Wednesday", ["t7"]], ["Oct 25", ["t8"]], ["Someday", ["t10"]],
  ]);
});

test("days are named from today: today, tomorrow, yesterday, this week's weekdays, else the date", () => {
  assert.equal(dayLabel(SUNDAY, SUNDAY), "Today");
  assert.equal(dayLabel(SUNDAY + 1, SUNDAY), "Tomorrow");
  assert.equal(dayLabel(SUNDAY - 1, SUNDAY), "Yesterday");
  assert.equal(dayLabel(SUNDAY + 5, SUNDAY), "Friday");
  assert.equal(dayLabel(SUNDAY + 7, SUNDAY), "Oct 25");
  assert.equal(dayLabel(SUNDAY - 3, SUNDAY), "Oct 15");
});

test("a month's grid: six weeks from Monday, today marked, each day's open and done counted", () => {
  const cells = monthGrid(2026, 9, SAMPLE, SUNDAY);
  assert.equal(cells.length, 42);
  assert.equal(isoOf(cells[0].day), "2026-09-28", "the Monday before the 1st (a Thursday)");
  assert.deepEqual(cells.slice(0, 4).map((c) => [c.date, c.inMonth]), [[28, false], [29, false], [30, false], [1, true]]);
  assert.equal(isoOf(cells[41].day), "2026-11-08");
  const at = (iso) => cells.find((c) => isoOf(c.day) === iso);
  assert.deepEqual([at("2026-10-18").isToday, at("2026-10-18").open, at("2026-10-18").done], [true, 2, 1]);
  assert.deepEqual([at("2026-10-15").open, at("2026-10-15").done], [0, 1], "done only: a hollow dot");
  assert.deepEqual([at("2026-10-17").open, at("2026-10-17").done], [0, 0], "nothing: no dot");
  assert.equal(cells.filter((c) => c.isToday).length, 1);
  // A month that starts on a Sunday still begins on the Monday before; one starting on a Monday on itself.
  assert.equal(isoOf(monthGrid(2026, 1, [], SUNDAY)[0].day), "2026-01-26");
  assert.equal(isoOf(monthGrid(2026, 5, [], SUNDAY)[0].day), "2026-06-01");
  // Someday has no day on the grid.
  assert.equal(monthGrid(2026, 9, [todo("t1", "x")], SUNDAY).reduce((n, c) => n + c.open, 0), 0);
});

test("each to-do is in the views it can be opened from, and the status says what is left", () => {
  const views = (id) => todoViews(SAMPLE.find((x) => x.id === id), SUNDAY);
  assert.deepEqual(views("t1"), ["today", "calendar"]);
  assert.deepEqual(views("t2"), ["calendar"], "late but done: not in Today");
  assert.deepEqual(views("t6"), ["upcoming", "calendar"]);
  assert.deepEqual(views("t9"), ["calendar"]);
  assert.deepEqual(views("t10"), ["upcoming"]);
  assert.deepEqual(views("t11"), []);
  assert.equal(todayStatus(SAMPLE, SUNDAY), "2 to do today · 1 overdue");
  assert.equal(todayStatus([], SUNDAY), "Nothing due today");
});

// ── On the island (the real clock: the data is laid around today) ────────────

const TODAY = dayOf(new Date());
const iso = (n) => isoOf(TODAY + n);

function live() {
  return {
    today: iso(0),
    todos: [
      todo("t1", "Send the invoice", { date: iso(-1) }),
      todo("t2", "Call Sarah", { date: iso(0), time: "15:00", note: "Bring the numbers\nand the shots" }),
      todo("t3", "Buy oat milk", { date: iso(0) }),
      todo("t4", "Review the PR", { date: iso(0), done: true }),
      todo("t5", "Dentist", { date: iso(1), time: "09:30" }),
      todo("t6", "Flight", { date: iso(5) }),
    ],
    notes: [
      { id: "n7", title: "Ideas", body: "Open on the dash.\nThe dot arrives late.", updated: Date.now() - 60_000, created: 1 },
      { id: "n8", title: "Empty one", body: "", updated: Date.now() - 3_600_000, created: 2 },
    ],
  };
}

const byClass = (el, cls) => el.find(`.${cls}`);
const text = (el, cls) => byClass(el, cls).map((e) => e.textContent);
const tick = () => new Promise((r) => setImmediate(r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** A key pressed in a field, as the browser sends it. */
function key(el, k) {
  const event = { key: k, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
  for (const fn of el.listeners.get("keydown") ?? []) fn(event);
  return event;
}
const lastSent = (cmd) => sent(cmd).at(-1);

beforeEach(() => {
  calls.length = 0;
  Feed.error = null;
  Today.set(live());
  useRegistry({ shown: ["github", "today"] });
  chooseView("today", "today");
});

function bigView() {
  State.detailApp = "app_today";
  State.view = "app";
  const actions = {
    setView: (v) => {
      State.view = v;
      State.notify();
    },
    blip() {},
    openUrl() {},
  };
  const host = buildAppDetail(actions);
  host.sync();
  return host;
}

test("Today has a pill of its own and always opens big, even with nothing in it", () => {
  assert.ok(State.tasks.some((t) => t.id === "app_today" && t.app === "today"));
  Today.set({ today: iso(0), todos: [], notes: [] });
  assert.ok(canExpand("app_today"));
});

test("the card: the day, up to three open to-dos (late first, marked), how many more", () => {
  Today.state.todos.push(todo("t9", "Water the plants", { date: iso(0) }), todo("t10", "Post the letter", { date: iso(0) }));
  const card = buildTodayCard(() => {}, new Date());
  assert.equal(text(card, "name")[0], "Today");
  const rows = byClass(card, "td-crow");
  assert.deepEqual(rows.map((r) => text(r, "td-ctitle")[0]), ["Send the invoice", "Buy oat milk", "Water the plants"]);
  assert.ok(rows[0].classList.contains("late"));
  assert.equal(text(rows[0], "td-cwhen")[0], "Yesterday");
  assert.deepEqual(text(card, "td-cmore"), ["2 more"]);
  // Nothing left today: says so, and what tomorrow holds.
  Today.set({ today: iso(0), todos: [todo("t1", "Dentist", { date: iso(1) })], notes: [] });
  const empty = buildTodayCard(() => {}, new Date());
  assert.deepEqual(text(empty, "td-cempty"), ["Nothing due today"]);
  assert.deepEqual(text(empty, "td-cmore"), ["1 tomorrow"]);
});

test("a circle ticks the to-do off at once, and tells Rust a moment later", async () => {
  const card = buildTodayCard(() => {}, new Date());
  const row = byClass(card, "td-crow")[1];
  byClass(row, "td-check")[0].fire("click");
  assert.ok(row.classList.contains("done") && row.classList.contains("ticked"), "filled at once");
  assert.equal(sent("today_todo_update").length, 0, "the row keeps its place for a moment");
  // Drawn again meanwhile: still ticked.
  assert.ok(byClass(buildTodayCard(() => {}, new Date()), "td-crow")[1].classList.contains("done"));
  await wait(450);
  assert.deepEqual(lastSent("today_todo_update"), { id: "t3", input: { done: true } });
});

test("the big view: its four views in the left column, Today's list under the quick add", () => {
  const host = bigView();
  assert.deepEqual(text(host.el, "ad-view"), ["Today", "Upcoming", "Calendar", "Notes"]);
  assert.ok(byClass(host.el, "ad-view")[0].classList.contains("on"));
  assert.equal(text(host.el, "ad-name")[0], "Today");
  assert.equal(text(host.el, "ad-status")[0], "2 to do today · 1 overdue");
  const view = byClass(host.el, "td-lists")[0];
  assert.ok(view.classList.contains("on"));
  assert.deepEqual(text(view, "td-caption"), ["Overdue", "Today"]);
  assert.deepEqual(text(view, "td-title"), ["Send the invoice", "Buy oat milk", "Call Sarah", "Review the PR"]);
  assert.deepEqual(text(view, "td-when"), ["Yesterday", "15:00"]);
  assert.deepEqual(text(view, "td-sub"), ["Bring the numbers"], "a note's first line under its title");
  assert.ok(byClass(view, "td-row")[3].classList.contains("done"));
  // Upcoming: the days ahead by name.
  byClass(host.el, "ad-view")[1].fire("click");
  assert.deepEqual(text(view, "td-caption").slice(0, 1), ["Tomorrow"]);
  assert.deepEqual(text(view, "td-title"), ["Dentist", "Flight"]);
});

test("the quick add reads the day and time as you type, and Enter adds the to-do", async () => {
  const host = bigView();
  const view = byClass(host.el, "td-lists")[0];
  const input = byClass(view, "tq-input")[0];
  input.value = "Call Sarah tomorrow 3pm";
  input.fire("input");
  assert.equal(text(view, "tq-when")[0], "Tomorrow · 15:00");
  // Nothing said of the day in Today's view: today.
  input.value = "Buy bread";
  input.fire("input");
  assert.equal(text(view, "tq-when")[0], "Today");
  input.value = "Call Sarah tomorrow 3pm";
  key(input, "Enter");
  await tick();
  assert.deepEqual(lastSent("today_todo_add"), { input: { title: "Call Sarah", date: iso(1), time: "15:00" } });
  await tick();
  assert.equal(input.value, "", "cleared for the next one");
  // Esc clears a line first, without leaving.
  input.value = "half typed";
  assert.ok(key(input, "Escape").defaultPrevented);
  assert.equal(input.value, "");
  // Only a day: refused, said above the list.
  input.value = "tomorrow";
  key(input, "Enter");
  await tick();
  await tick();
  assert.equal(sent("today_todo_add").length, 1);
  assert.equal(Feed.error, "Say what to do as well.");
});

test("the calendar: a month of days with dots, ‹ › to move, a click lists that day", () => {
  chooseView("today", "calendar");
  const host = bigView();
  const view = byClass(host.el, "td-cal")[0];
  assert.ok(view.classList.contains("on"));
  const cells = () => byClass(view, "tc-cell");
  assert.equal(cells().length, 42);
  const todayCell = cells().find((c) => c.classList.contains("today"));
  assert.ok(todayCell.classList.contains("sel"), "today chosen at first");
  assert.ok(byClass(todayCell, "tc-dot")[0].className === "tc-dot", "open to-dos: a dot");
  assert.deepEqual(text(view, "td-title"), ["Buy oat milk", "Call Sarah", "Review the PR"]);
  assert.match(text(view, "tc-daytitle")[0], /^Today · /);
  // Tomorrow, clicked: its to-dos, and the quick add adds to it.
  const at = cells().indexOf(todayCell);
  cells()[at + 1].fire("click");
  assert.deepEqual(text(view, "td-title"), ["Dentist"]);
  assert.match(text(view, "tc-daytitle")[0], /^Tomorrow · /);
  const title = text(view, "tc-title")[0];
  byClass(view, "tc-nav")[1].fire("click");
  assert.notEqual(text(view, "tc-title")[0], title, "the next month");
  assert.ok(byClass(view, "tc-today")[0].classList.contains("on"), "a way back to today");
  byClass(view, "tc-today")[0].fire("click");
  assert.equal(text(view, "tc-title")[0], title);
  assert.ok(cells().find((c) => c.classList.contains("today")).classList.contains("sel"));
});

test("a to-do's details: edited in place, with Done, Move to tomorrow and Delete", async () => {
  const host = bigView();
  const row = byClass(host.el, "td-row").find((r) => text(r, "td-title")[0] === "Call Sarah");
  row.fire("click");
  assert.equal(host.mode, "detail");
  assert.deepEqual(byClass(host.el, "ad-tools")[0].children.map((b) => b.textContent), ["Done", "Move to tomorrow", "Delete"]);
  const pane = byClass(host.el, "tp")[0];
  assert.equal(byClass(pane, "tp-title")[0].value, "Call Sarah");
  assert.equal(byClass(pane, "tp-date")[0].value, iso(0));
  assert.equal(byClass(pane, "tp-time")[0].value, "15:00");
  assert.equal(byClass(pane, "tp-note")[0].value, "Bring the numbers\nand the shots");
  assert.equal(text(pane, "tp-said")[0], "Today");
  // Each change goes to Rust.
  const title = byClass(pane, "tp-title")[0];
  title.value = "Call Sarah back";
  title.fire("change");
  assert.deepEqual(lastSent("today_todo_update"), { id: "t2", input: { title: "Call Sarah back" } });
  const time = byClass(pane, "tp-time")[0];
  time.value = "";
  time.fire("change");
  assert.deepEqual(lastSent("today_todo_update"), { id: "t2", input: { time: null } });
  byClass(pane, "tp-link")[0].fire("click");
  assert.deepEqual(lastSent("today_todo_update"), { id: "t2", input: { date: null } }, "Remove date: someday");
  const note = byClass(pane, "tp-note")[0];
  note.value = "New words";
  note.fire("input");
  note.fire("blur");
  assert.deepEqual(lastSent("today_todo_update"), { id: "t2", input: { note: "New words" } }, "saved when the field is left");
  const [done, tomorrow, remove] = byClass(host.el, "ad-tools")[0].children;
  tomorrow.fire("click");
  assert.deepEqual(lastSent("today_todo_update"), { id: "t2", input: { date: iso(1) } });
  done.fire("click");
  assert.deepEqual(lastSent("today_todo_update"), { id: "t2", input: { done: true } });
  remove.fire("click");
  assert.deepEqual(lastSent("today_todo_delete"), { id: "t2" });
  // Gone from the state: back to the list.
  Today.set({ ...live(), todos: live().todos.filter((x) => x.id !== "t2") });
  State.notify();
  host.sync();
  assert.equal(host.mode, "list");
});

test("a note's details: its title and text edited in place; Delete asks once more when it has text", () => {
  chooseView("today", "notes");
  const host = bigView();
  const view = byClass(host.el, "td-notes")[0];
  assert.deepEqual(text(view, "td-title"), ["Ideas", "Empty one"]);
  assert.deepEqual(text(view, "td-sub"), ["Open on the dash. The dot arrives late."]);
  byClass(view, "td-row")[0].fire("click");
  const pane = byClass(host.el, "tp-notepane")[0];
  assert.equal(byClass(pane, "tp-title")[0].value, "Ideas");
  assert.equal(byClass(pane, "tp-body")[0].value, "Open on the dash.\nThe dot arrives late.");
  const body = byClass(pane, "tp-body")[0];
  body.value = "Open on the dash.";
  body.fire("input");
  body.fire("blur");
  assert.deepEqual(lastSent("today_note_update"), { id: "n7", input: { body: "Open on the dash." } });
  const tools = () => byClass(host.el, "ad-tools")[0].children;
  assert.deepEqual(tools().map((b) => [b.textContent, b.className]), [["Delete", "btn secondary small"]], "never the lit button");
  tools()[0].fire("click");
  assert.equal(sent("today_note_delete").length, 0);
  assert.equal(tools()[0].textContent, "Delete this note?");
  tools()[0].fire("click");
  assert.deepEqual(lastSent("today_note_delete"), { id: "n7" });
});

test("a reminder's notification opens its to-do's details, in a view that has it", () => {
  chooseView("today", "notes");
  const host = bigView();
  assert.ok(host.openItem("today", "t5"));
  assert.equal(host.mode, "detail");
  assert.equal(byClass(host.el, "tp-title")[0].value, "Dentist");
  assert.ok(findItem(todayDetail(Feed.app("today")), "n7"), "notes are items too");
});
