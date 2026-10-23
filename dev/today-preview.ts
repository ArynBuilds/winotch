// Today in a real island, on sample to-dos and notes: the page plays Rust's
// part (the apps snapshot, today_state and the today_* edits, kept here in
// memory). `npx vite`, then open /dev/today-preview.html. Not shipped.
//   ?view=card       the overview, Today's card (default)
//   ?view=today|upcoming|calendar|notes   the big view on that view
//   ?open=t3         that item's details opened (a to-do "t…" or a note "n…")
//   ?type=Call%20Sarah%20tomorrow%203pm   typed into the quick add
//   ?day=2026-10-21  the calendar's chosen day (clicked)
//   ?empty=1         nothing yet
//   ?lang=fr         the interface in that language

const params = new URLSearchParams(location.search);
const view = params.get("view") ?? "card";
const empty = params.get("empty") === "1";

const MS_DAY = 86_400_000;
const now = new Date();
const today = Math.round(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / MS_DAY);
const iso = (day: number) => new Date(day * MS_DAY).toISOString().slice(0, 10);
const created = Date.now() - 3 * 3600_000;

type Todo = { id: string; title: string; note?: string; date?: string; time?: string; done: boolean; doneAt?: number; created: number };
type Note = { id: string; title: string; body: string; updated: number; created: number };

let next = 20;
const todos: Todo[] = empty ? [] : [
  { id: "t1", title: "Send the invoice to Studio North", date: iso(today - 1), done: false, created },
  { id: "t2", title: "Call Sarah about the deck", note: "Bring the Q4 numbers and the new island shots.", date: iso(today), time: "15:00", done: false, created },
  { id: "t3", title: "Buy oat milk", date: iso(today), done: false, created },
  { id: "t4", title: "Review the island pull request", date: iso(today), time: "11:30", done: true, doneAt: Date.now() - 3600_000, created },
  { id: "t5", title: "Dentist", date: iso(today + 1), time: "09:30", done: false, created },
  { id: "t6", title: "Ship the Today app", date: iso(today + 1), done: false, created },
  { id: "t7", title: "Pick up the parcel at the kiosk", date: iso(today + 3), done: false, created },
  { id: "t8", title: "Flight to Lisbon", note: "TP 1355, seat 14A", date: iso(today + 5), time: "07:15", done: false, created },
  { id: "t9", title: "Learn the cello", done: false, created },
  { id: "t10", title: "Renew the passport", date: iso(today + 16), done: false, created },
  { id: "t11", title: "Water the plants", date: iso(today - 4), done: true, created },
];
const notes: Note[] = empty ? [] : [
  { id: "n12", title: "Ideas for the film", body: "Open on the dash alone.\nThe dot arrives late, from the right.\n\nNo drift, ever: every move is sequenced.", updated: Date.now() - 20 * 60_000, created },
  { id: "n13", title: "Lisbon trip", body: "Hotel near the river, two nights.\nDinner at the place Ana liked.", updated: Date.now() - 26 * 3600_000, created },
  { id: "n14", title: "Groceries", body: "oat milk, bread, lemons", updated: Date.now() - 4 * MS_DAY, created },
];

const state = () => ({ today: iso(today), todos: [...todos], notes: [...notes] });

const SNAPSHOT = {
  apps: [{
    id: "today", name: "Today", kind: "builtin", logo: "today", pill: "app_today", sign: null, icon: null, callback: null,
    status: null, problem: null, updated: Date.now(), shown: true, opensIsland: true, available: true, configured: true,
    settings: { kind: "none" },
  }],
  notifications: [],
  lists: {},
};

let publish: () => void = () => {};
let callbacks = 0;
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "island" }, currentWebview: { windowLabel: "island", label: "island" } },
  transformCallback: () => ++callbacks,
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "plugin:event|listen") return ++callbacks;
    if (cmd === "apps_snapshot") return SNAPSHOT;
    if (cmd === "today_state") return state();
    const input = (args?.input ?? {}) as Record<string, unknown>;
    if (cmd === "today_todo_add") {
      const todo = { id: `t${++next}`, title: String(input.title), date: (input.date as string) ?? undefined, time: (input.time as string) ?? undefined, done: false, created: Date.now() };
      todos.push(todo);
      setTimeout(publish);
      return todo;
    }
    if (cmd === "today_todo_update") {
      const todo = todos.find((x) => x.id === args.id)!;
      Object.assign(todo, Object.fromEntries(Object.entries(input).map(([k, v]) => [k, v ?? undefined])));
      setTimeout(publish);
      return todo;
    }
    if (cmd === "today_todo_delete") {
      todos.splice(todos.findIndex((x) => x.id === args.id), 1);
      setTimeout(publish);
      return null;
    }
    if (cmd === "today_note_add") {
      const note = { id: `n${++next}`, title: String(input.title ?? ""), body: String(input.body ?? ""), updated: Date.now(), created: Date.now() };
      notes.push(note);
      setTimeout(publish);
      return note;
    }
    if (cmd === "today_note_update") {
      const note = notes.find((x) => x.id === args.id)!;
      Object.assign(note, input, { updated: Date.now() });
      setTimeout(publish);
      return note;
    }
    if (cmd === "today_note_delete") {
      notes.splice(notes.findIndex((x) => x.id === args.id), 1);
      setTimeout(publish);
      return null;
    }
    return null;
  },
};

await import("../src/style.css");
const { setLanguage, isLanguage } = await import("../src/i18n/i18n");
const lang = params.get("lang");
if (lang && isLanguage(lang)) setLanguage(lang);
const { Island } = await import("../src/island/island");
const { Feed } = await import("../src/core/apps");
const { State } = await import("../src/core/state");
const { Today } = await import("../src/core/today");
const { chooseView } = await import("../src/core/app-detail");

Feed.set(SNAPSHOT as never);
State.syncPills();
Today.set(state());
publish = () => {
  Today.set(state());
  State.notify();
};
const island = new Island(document.getElementById("root")!);
// No pointer here: held open, as a waiting card would be.
island.setPinned(true);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (view === "card") {
  State.setFocus("app_today");
  island.alert("overview");
} else {
  chooseView("today", view);
  State.detailApp = "app_today";
  island.alert("app");
  await wait(700);
  const day = params.get("day");
  if (day) {
    const cells = [...document.querySelectorAll(".tc-cell")] as HTMLElement[];
    const target = Math.round(Date.parse(`${day}T00:00:00Z`) / MS_DAY);
    const first = cells.findIndex((c) => !c.classList.contains("out"));
    const firstDay = Math.round(Date.UTC(now.getFullYear(), now.getMonth(), 1) / MS_DAY);
    cells[first + (target - firstDay)]?.click();
  }
  const typed = params.get("type");
  if (typed) {
    const input = document.querySelector(".td-view.on .tq-input") as HTMLInputElement;
    input.focus();
    input.value = typed;
    input.dispatchEvent(new Event("input"));
  }
  const open = params.get("open");
  if (open) {
    const rows = [...document.querySelectorAll(".td-view.on .td-row")] as HTMLElement[];
    const title = todos.find((x) => x.id === open)?.title ?? notes.find((x) => x.id === open)?.title;
    rows.find((r) => r.querySelector(".td-title")?.textContent === title)?.click();
  }
}
