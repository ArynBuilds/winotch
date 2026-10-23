// Today (WINOTCH.md "Today"): to-dos on days, and notes, kept by Rust
// (src-tauri/src/today.rs) in one local file. The whole state comes with
// every change (the "today" event): from the island, and from Claude Code
// through the local API, so what Claude adds shows at once.
//
// Here: the state, the calls that change it, and what each screen shows of
// it, pure (the day is passed in): today's list, the next seven days, a
// month's grid, the big view's sections.

import { invoke } from "@tauri-apps/api/core";
import { dayFromIso, dayOf, isoOf, mondayOf, weekdayOf } from "./today-parse";
import { dayMonth, monthShort, t, weekdayShort } from "../i18n/i18n";
import type { AppInfo, ListView } from "./apps";
import type { AppDetail, DetailItem } from "./app-detail";

export interface Todo {
  id: string;
  title: string;
  note?: string | null;
  /** YYYY-MM-DD; absent: someday. */
  date?: string | null;
  /** HH:MM, with a date. */
  time?: string | null;
  done: boolean;
  doneAt?: number | null;
  created: number;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  updated: number;
  created: number;
}

export interface TodayState {
  /** The day it is, as Rust saw it (the island uses its own clock). */
  today: string;
  todos: Todo[];
  notes: Note[];
}

const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** What the island knows; State.notify() follows each change (main.ts). */
export const Today = {
  state: { today: "", todos: [], notes: [] } as TodayState,
  /** An edit that failed, shown in the big view until the next one. */
  error: null as string | null,
  /** Bumped on every change, for views that redraw only when it moves. */
  version: 0,

  set(s: TodayState | null) {
    if (!s) return;
    this.state = { today: s.today ?? "", todos: s.todos ?? [], notes: s.notes ?? [] };
    this.version++;
  },

  todo(id: string): Todo | undefined {
    return this.state.todos.find((t) => t.id === id);
  },

  note(id: string): Note | undefined {
    return this.state.notes.find((n) => n.id === id);
  },
};

/** Each call rejects with Rust's reason (a title too long…), so the view can say it. */
function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) return Promise.reject(new Error("Today needs the app"));
  return invoke<T>(cmd, args);
}

export interface TodoInput {
  title?: string;
  note?: string | null;
  date?: string | null;
  time?: string | null;
  done?: boolean;
}

export const TodayBridge = {
  state: () => (IS_TAURI ? invoke<TodayState | null>("today_state") : Promise.resolve(null)),
  addTodo: (input: TodoInput) => call<Todo>("today_todo_add", { input }),
  updateTodo: (id: string, input: TodoInput) => call<Todo>("today_todo_update", { id, input }),
  deleteTodo: (id: string) => call<void>("today_todo_delete", { id }),
  addNote: (input: { title?: string; body?: string }) => call<Note>("today_note_add", { input }),
  updateNote: (id: string, input: { title?: string; body?: string }) => call<Note>("today_note_update", { id, input }),
  deleteNote: (id: string) => call<void>("today_note_delete", { id }),
};

// ── Days ──────────────────────────────────────────────────────────────────────

/** The island's day now. */
export const todayDay = (now = new Date()) => dayOf(now);

const dayOfTodo = (t: Todo) => (t.date ? dayFromIso(t.date) : null);

/** "Today", "Tomorrow", "Yesterday", a weekday within the week ahead, else "Oct 21". */
export function dayLabel(day: number, today: number): string {
  if (day === today) return t("Today");
  if (day === today + 1) return t("Tomorrow");
  if (day === today - 1) return t("Yesterday");
  if (day > today && day < today + 7) return weekdayLong(weekdayOf(day));
  const d = new Date(day * 86_400_000);
  return dayMonth(d.getUTCMonth(), d.getUTCDate());
}

/** "Monday" (Sunday is 0), in the interface language. */
export function weekdayLong(day: number): string {
  try {
    const lang = typeof document !== "undefined" ? document.documentElement?.lang || "en" : "en";
    return new Intl.DateTimeFormat(lang, { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 7 + day)));
  } catch {
    return weekdayShort(day);
  }
}

/** "October 2026", in the interface language. */
export function monthTitle(year: number, month: number): string {
  try {
    const lang = typeof document !== "undefined" ? document.documentElement?.lang || "en" : "en";
    return new Intl.DateTimeFormat(lang, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month, 15)));
  } catch {
    return `${monthShort(month)} ${year}`;
  }
}

/** A to-do's day and time as a row says it beside its title: "15:00", "Tomorrow", "Fri 15:00". */
export function whenLabel(todo: Todo, today: number, shownDay: number | null = null): string {
  const day = dayOfTodo(todo);
  if (day == null) return "";
  const time = todo.time ?? "";
  if (day === shownDay) return time;
  return [dayLabel(day, today), time].filter(Boolean).join(" · ");
}

/** Its order: by day (someday last), the ones without a time first, then by time, then as added. */
export function byDay(a: Todo, b: Todo): number {
  const da = dayOfTodo(a) ?? Number.MAX_SAFE_INTEGER;
  const db = dayOfTodo(b) ?? Number.MAX_SAFE_INTEGER;
  if (da !== db) return da - db;
  const ta = a.time ?? "";
  const tb = b.time ?? "";
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.created - b.created || (a.id < b.id ? -1 : 1);
}

export const isOverdue = (todo: Todo, today: number) => {
  const day = dayOfTodo(todo);
  return !todo.done && day != null && day < today;
};

// ── What each view shows ──────────────────────────────────────────────────────

export interface DayGroup {
  /** Its day, or null for someday. */
  day: number | null;
  title: string;
  todos: Todo[];
}

/** The Today view and the card: what is late (not done), then today's, done ones last. */
export function todayGroups(todos: Todo[], today: number): DayGroup[] {
  const overdue = todos.filter((x) => isOverdue(x, today)).sort(byDay);
  const due = todos.filter((x) => dayOfTodo(x) === today).sort((a, b) => Number(a.done) - Number(b.done) || byDay(a, b));
  const out: DayGroup[] = [];
  if (overdue.length) out.push({ day: null, title: t("Overdue"), todos: overdue });
  if (due.length) out.push({ day: today, title: t("Today"), todos: due });
  return out;
}

/** The card: today's open to-dos and the late ones, late first. */
export function cardTodos(todos: Todo[], today: number): Todo[] {
  return todos.filter((x) => !x.done && (dayOfTodo(x) ?? Infinity) <= today).sort(byDay);
}

/** Upcoming: the next seven days after today, one group per day that has any, then someday. */
export function upcomingGroups(todos: Todo[], today: number, days = 7): DayGroup[] {
  const out: DayGroup[] = [];
  for (let day = today + 1; day <= today + days; day++) {
    const list = todos.filter((x) => dayOfTodo(x) === day).sort((a, b) => Number(a.done) - Number(b.done) || byDay(a, b));
    if (list.length) out.push({ day, title: dayLabel(day, today), todos: list });
  }
  const someday = todos.filter((x) => dayOfTodo(x) == null && !x.done).sort(byDay);
  if (someday.length) out.push({ day: null, title: t("Someday"), todos: someday });
  return out;
}

/** One day's to-dos (the calendar's), open first. */
export function dayTodos(todos: Todo[], day: number): Todo[] {
  return todos.filter((x) => dayOfTodo(x) === day).sort((a, b) => Number(a.done) - Number(b.done) || byDay(a, b));
}

export interface GridCell {
  day: number;
  /** Day of the month, 1–31. */
  date: number;
  inMonth: boolean;
  isToday: boolean;
  /** To-dos not done on it. */
  open: number;
  /** To-dos done on it. */
  done: number;
}

/**
 * A month as the calendar draws it: weeks from Monday, six of them so its
 * height never jumps, each day with what is on it. `month` from 0.
 */
export function monthGrid(year: number, month: number, todos: Todo[], today: number): GridCell[] {
  const first = Math.round(Date.UTC(year, month, 1) / 86_400_000);
  const start = mondayOf(first);
  const counts = new Map<number, { open: number; done: number }>();
  for (const x of todos) {
    const day = dayOfTodo(x);
    if (day == null) continue;
    const c = counts.get(day) ?? { open: 0, done: 0 };
    if (x.done) c.done++;
    else c.open++;
    counts.set(day, c);
  }
  const cells: GridCell[] = [];
  for (let i = 0; i < 42; i++) {
    const day = start + i;
    const d = new Date(day * 86_400_000);
    const c = counts.get(day) ?? { open: 0, done: 0 };
    cells.push({ day, date: d.getUTCDate(), inMonth: d.getUTCMonth() === month, isToday: day === today, open: c.open, done: c.done });
  }
  return cells;
}

/** The weekday initials over the grid, from Monday. */
export function gridWeekdays(): string[] {
  return [1, 2, 3, 4, 5, 6, 0].map((d) => weekdayShort(d));
}

/** Notes, the one edited last first. */
export function notesByRecent(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => b.updated - a.updated || (a.id < b.id ? 1 : -1));
}

/** A note's first words after its title, for its row. */
export function notePreview(note: Note): string {
  return note.body.split(/\s+/).filter(Boolean).join(" ").slice(0, 140);
}

// ── The big view (core/app-detail.ts presents it, views/today.ts draws it) ──

export const TODAY_VIEWS = ["today", "upcoming", "calendar", "notes"] as const;
export type TodayView = (typeof TODAY_VIEWS)[number];

/** The views of a to-do: where it can be opened from (a reminder opens it in one of them). */
export function todoViews(todo: Todo, today: number): TodayView[] {
  const day = dayOfTodo(todo);
  const views: TodayView[] = [];
  if (day != null && (day === today || isOverdue(todo, today))) views.push("today");
  if ((day != null && day > today && day <= today + 7) || (day == null && !todo.done)) views.push("upcoming");
  if (day != null) views.push("calendar");
  return views;
}

/** "3 to do today · 1 overdue", or that nothing is due. */
export function todayStatus(todos: Todo[], today: number): string {
  const due = todos.filter((x) => !x.done && dayOfTodo(x) === today).length;
  const late = todos.filter((x) => isOverdue(x, today)).length;
  const parts = [];
  if (due) parts.push(t("{n} to do today", { n: due }));
  if (late) parts.push(t("{n} overdue", { n: late }));
  return parts.length ? parts.join(" · ") : t("Nothing due today");
}

/**
 * Today expanded: its four views, and every to-do and note as an item (so a
 * reminder in the feed opens its own), drawn by its stage (views/today.ts).
 */
export function todayDetail(app: AppInfo, now = new Date()): AppDetail {
  const today = todayDay(now);
  const { todos, notes } = Today.state;
  const views: ListView[] = [
    { id: "today", label: t("Today") },
    { id: "upcoming", label: t("Upcoming") },
    { id: "calendar", label: t("Calendar") },
    { id: "notes", label: t("Notes") },
  ];
  const todoItems: DetailItem[] = [...todos].sort(byDay).map((x) => ({
    id: x.id,
    title: x.title,
    subtitle: [whenLabel(x, today), x.note ?? ""].filter(Boolean).join(" · ") || null,
    unread: !x.done,
    detail: true,
    views: todoViews(x, today),
  }));
  const noteItems: DetailItem[] = notesByRecent(notes).map((n) => ({
    id: n.id,
    title: n.title,
    subtitle: notePreview(n) || null,
    time: n.updated,
    detail: true,
    views: ["notes"],
  }));
  return {
    taskId: app.pill,
    name: app.name,
    logoId: app.pill,
    status: app.problem ?? todayStatus(todos, today),
    sections: [{ title: null, items: todoItems }, { title: null, items: noteItems }],
    empty: t("Nothing here yet."),
    views,
  };
}

export { dayOf, isoOf };
