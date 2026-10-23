// Today on the island (WINOTCH.md "Today"): its card in the overview, and its
// stage in the big view (views/appdetail.ts hosts it as an AppStage): a quick
// add that reads "Call Sarah tomorrow 3pm", today's list, the week ahead, a
// month's calendar and the notes; a to-do's or a note's details are edited in
// place. Every change goes to Rust (today.rs), which sends the whole state
// back; Claude Code's changes arrive the same way.

import { clear, h, svg } from "./dom";
import { ICONS } from "./icons";
import { logoElement } from "./logo";
import { State } from "../core/state";
import { Bridge } from "../core/bridge";
import { Feed } from "../core/apps";
import type { DetailAction } from "../core/app-detail";
import { dayFromIso, dayOf, isoOf, parseQuick, type Parsed } from "../core/today-parse";
import {
  Today, TodayBridge, cardTodos, dayLabel, dayTodos, gridWeekdays, isOverdue, monthGrid, monthTitle, notePreview,
  notesByRecent, todayDay, todayGroups, upcomingGroups, weekdayLong, whenLabel, type DayGroup, type Note, type Todo,
} from "../core/today";
import type { AppStage, StageContext, StagePane } from "./appdetail";
import { dayMonth, t } from "../i18n/i18n";

/** Small stroked glyphs of its own (24 × 24). */
const GLYPHS = {
  calendar: "M5.5 6.5h13a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1zM4.5 10.5h15M8.5 4.5v4M15.5 4.5v4",
  clock: "M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15zM12 8v4.3l2.8 1.7",
  note: "M7 4.5h7.5l3.5 3.5v11.5H7zM14.5 4.5V8H18M9.8 12h5.4M9.8 15h5.4",
};

const ok = () => {
  if (Feed.error) {
    Feed.error = null;
    State.notify();
  }
};
const failed = (err: unknown) => {
  Feed.error = String(err instanceof Error ? err.message : err);
  State.notify();
};

// ── Ticking a to-do off ───────────────────────────────────────────────────────

/** Ticks shown before Rust has them, so a redraw in between never undoes one. */
const pending = new Map<string, boolean>();

const isDone = (todo: Todo) => pending.get(todo.id) ?? todo.done;

/**
 * Ticks it off (or back on) at once on screen; the change goes to Rust a
 * moment later, so the circle fills before the row moves to its new place.
 */
function tick(todo: Todo, row: HTMLElement) {
  const done = !isDone(todo);
  pending.set(todo.id, done);
  row.classList.toggle("done", done);
  row.classList.add("ticked");
  window.setTimeout(() => {
    TodayBridge.updateTodo(todo.id, { done }).then(
      () => {
        pending.delete(todo.id);
        ok();
      },
      (err) => {
        pending.delete(todo.id);
        failed(err);
      },
    );
  }, done ? 380 : 0);
}

function checkButton(todo: Todo, row: HTMLElement, blip: () => void): HTMLElement {
  const done = isDone(todo);
  const b = h("button", { class: "td-check", title: done ? t("Mark as not done") : t("Mark as done") },
    svg(ICONS.check, 10, { stroke: 2.8 }));
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    blip();
    tick(todo, row);
  });
  return b;
}

const firstLine = (text: string) => text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";

// ── Text fields ───────────────────────────────────────────────────────────────

/**
 * A field of the island: a click gives the island the keyboard (it never
 * takes it by itself), and while the field has it the island holds open.
 */
function typeable(el: HTMLInputElement | HTMLTextAreaElement) {
  el.addEventListener("mousedown", () => void Bridge.focusWindow(true));
  el.addEventListener("focus", () => {
    void Bridge.focusWindow(true);
    State.typing = true;
    State.notify();
  });
  el.addEventListener("blur", () => {
    State.typing = false;
    State.notify();
  });
  // Esc lets go of the field too (after the island stepped back, or after a
  // field used it to clear itself), so no hidden field keeps the keyboard.
  el.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape") window.setTimeout(() => !e.defaultPrevented && el.blur());
  });
}

interface Quick {
  el: HTMLElement;
  input: HTMLInputElement;
  setPlaceholder(text: string): void;
}

/**
 * The quick add: type a line, see the day and time it read on the right, and
 * Enter adds it. `hint` says what a line would become; `submit` does it.
 */
function quickField(hint: (text: string) => string, submit: (text: string) => Promise<unknown>): Quick {
  const input = h("input", { class: "tq-input", type: "text", maxlength: "300", spellcheck: "false" }) as HTMLInputElement;
  const when = h("span", { class: "tq-when" });
  const el = h("div", { class: "tq" }, svg(ICONS.plus, 11), input, when);
  typeable(input);
  let busy = false;
  const show = () => {
    const text = input.value.trim();
    when.textContent = text ? hint(text) : "";
    el.classList.toggle("filled", text !== "");
  };
  input.addEventListener("input", show);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !busy) {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      busy = true;
      submit(text).then(
        () => {
          busy = false;
          input.value = "";
          show();
          ok();
        },
        (err) => {
          busy = false;
          failed(err);
        },
      );
    } else if (e.key === "Escape" && input.value) {
      // Clears the line first; the next Esc goes back, as everywhere.
      e.preventDefault();
      input.value = "";
      show();
    }
  });
  el.addEventListener("click", () => input.focus());
  return { el, input, setPlaceholder: (text) => input.setAttribute("placeholder", text) };
}

/** "Tomorrow · 15:00" for what a quick add read, the day `fallback` when it named none. */
function readAs(p: Parsed, fallback: number | null, today: number): string {
  const day = p.date ? dayFromIso(p.date) : fallback;
  const parts = [day == null ? t("Someday") : dayLabel(day, today)];
  if (p.time) parts.push(p.time);
  return parts.join(" · ");
}

async function addFrom(text: string, fallback: number | null) {
  const p = parseQuick(text, new Date());
  if (!p.title) throw new Error(t("Say what to do as well."));
  await TodayBridge.addTodo({ title: p.title, date: p.date ?? (fallback == null ? null : isoOf(fallback)), time: p.time });
}

/** Says how far a scroller is scrolled, for the eased edges (the big view's). */
function edgesOf(box: HTMLElement) {
  const edges = () => {
    box.classList.toggle("more-above", box.scrollTop > 2);
    box.classList.toggle("more-below", box.scrollTop + box.clientHeight < box.scrollHeight - 2);
  };
  box.addEventListener("scroll", edges, { passive: true });
  return edges;
}

// ── Rows ──────────────────────────────────────────────────────────────────────

function todoRow(todo: Todo, today: number, shownDay: number | null, ctx: StageContext): HTMLElement {
  const done = isDone(todo);
  const late = !done && isOverdue(todo, today);
  const when = whenLabel(todo, today, shownDay);
  const row = h("div", { class: `td-row${done ? " done" : ""}${late ? " late" : ""}` });
  row.append(
    checkButton(todo, row, ctx.blip),
    h("div", { class: "td-main" },
      h("div", { class: "td-title", text: todo.title }),
      todo.note ? h("div", { class: "td-sub", text: firstLine(todo.note) }) : null,
    ),
    ...(when ? [h("span", { class: "td-when", text: when })] : []),
  );
  row.addEventListener("click", () => ctx.open(todo.id));
  return row;
}

/** When a note was last edited: its time today, else its day. */
function editedLabel(ms: number, today: number): string {
  const d = new Date(ms);
  const day = dayOf(d);
  if (day === today) return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return dayLabel(day, today);
}

function noteRow(note: Note, today: number, ctx: StageContext): HTMLElement {
  const preview = notePreview(note);
  const row = h("div", { class: "td-row td-note" },
    h("span", { class: "td-glyph" }, svg(GLYPHS.note, 14, { stroke: 1.6 })),
    h("div", { class: "td-main" },
      h("div", { class: "td-title", text: note.title }),
      preview ? h("div", { class: "td-sub", text: preview }) : null,
    ),
    h("span", { class: "td-when", text: editedLabel(note.updated, today) }),
  );
  row.addEventListener("click", () => ctx.open(note.id));
  return row;
}

function groupsInto(box: HTMLElement, groups: DayGroup[], today: number, ctx: StageContext) {
  for (const g of groups) {
    box.append(h("div", { class: "ad-caption td-caption", text: g.title }));
    for (const todo of g.todos) box.append(todoRow(todo, today, g.day, ctx));
  }
}

// ── The big view ──────────────────────────────────────────────────────────────

export function buildTodayStage(): AppStage {
  let ctx: StageContext | null = null;
  let view = "today";

  // A field left focused when the island folds or goes elsewhere lets the island go.
  State.subscribe(() => {
    if (!State.typing || (State.view === "app" && State.mode === "expanded")) return;
    State.typing = false;
    (document.activeElement as HTMLElement | null)?.blur?.();
  });

  // Today and Upcoming: the quick add over the list.
  const listQuick = quickField(
    (text) => readAs(parseQuick(text, new Date()), view === "upcoming" ? todayDay() + 1 : todayDay(), todayDay()),
    (text) => addFrom(text, view === "upcoming" ? todayDay() + 1 : todayDay()),
  );
  const listScroll = h("div", { class: "ad-list td-scroll" });
  const listEdges = edgesOf(listScroll);
  const listView = h("div", { class: "td-view td-lists" }, listQuick.el, listScroll);

  // Calendar: the month on the left, the chosen day on the right.
  let month: { y: number; m: number } | null = null;
  let chosen: number | null = null;
  const calTitle = h("span", { class: "tc-title" });
  const toToday = h("button", { class: "tc-today", text: t("Today") });
  const prev = h("button", { class: "tc-nav", title: t("Previous month"), "aria-label": t("Previous month") }, svg(ICONS.chevronLeft, 10, { stroke: 2.4 }));
  const next = h("button", { class: "tc-nav", title: t("Next month"), "aria-label": t("Next month") }, svg(ICONS.chevronRight, 10, { stroke: 2.4 }));
  const weekdays = h("div", { class: "tc-week" });
  const grid = h("div", { class: "tc-grid" });
  const dayTitle = h("div", { class: "ad-caption td-caption tc-daytitle" });
  const dayQuick = quickField(
    (text) => readAs(parseQuick(text, new Date()), chosen ?? todayDay(), todayDay()),
    (text) => addFrom(text, chosen ?? todayDay()),
  );
  const dayScroll = h("div", { class: "ad-list td-scroll" });
  const dayEdges = edgesOf(dayScroll);
  const calView = h("div", { class: "td-view td-cal" },
    h("div", { class: "tc-month" }, h("div", { class: "tc-head" }, calTitle, toToday, prev, next), weekdays, grid),
    h("div", { class: "tc-day" }, dayTitle, dayQuick.el, dayScroll),
  );
  const shift = (n: number) => {
    if (!month) return;
    const d = new Date(Date.UTC(month.y, month.m + n, 1));
    month = { y: d.getUTCFullYear(), m: d.getUTCMonth() };
    ctx?.blip();
    renderCalendar();
  };
  prev.addEventListener("click", () => shift(-1));
  next.addEventListener("click", () => shift(1));
  toToday.addEventListener("click", () => {
    ctx?.blip();
    choose(todayDay());
  });

  // Notes: a new one by its title, then the list.
  const noteQuick = quickField(
    () => "",
    async (text) => {
      const note = await TodayBridge.addNote({ title: text });
      // Opened at once, whether its state came before this answer or not.
      if (!Today.note(note.id)) {
        Today.state.notes = [...Today.state.notes, note];
        Today.version++;
      }
      State.notify();
      ctx?.open(note.id);
    },
  );
  noteQuick.setPlaceholder(t("New note"));
  const noteScroll = h("div", { class: "ad-list td-scroll" });
  const noteEdges = edgesOf(noteScroll);
  const notesView = h("div", { class: "td-view td-notes" }, noteQuick.el, noteScroll);

  const root = h("div", { class: "td-stage" }, listView, calView, notesView);

  function renderLists() {
    if (!ctx) return;
    const today = todayDay();
    const scrolled = listScroll.scrollTop;
    clear(listScroll);
    listQuick.setPlaceholder(view === "upcoming" ? t("Add to the week ahead, like “Dentist friday 9am”") : t("Add a to-do, like “Call Sarah tomorrow 3pm”"));
    const groups = view === "upcoming" ? upcomingGroups(Today.state.todos, today) : todayGroups(Today.state.todos, today);
    if (groups.length === 0) {
      listScroll.append(h("div", { class: "ad-empty td-empty", text: view === "upcoming" ? t("Nothing planned for the week ahead.") : t("Nothing to do today.") }));
    }
    groupsInto(listScroll, groups, today, ctx);
    listScroll.scrollTop = scrolled;
    requestAnimationFrame(listEdges);
  }

  function choose(day: number) {
    chosen = day;
    const d = new Date(day * 86_400_000);
    month = { y: d.getUTCFullYear(), m: d.getUTCMonth() };
    dayScroll.scrollTop = 0;
    renderCalendar();
  }

  function renderCalendar() {
    if (!ctx) return;
    const today = todayDay();
    chosen ??= today;
    if (!month) {
      const d = new Date(chosen * 86_400_000);
      month = { y: d.getUTCFullYear(), m: d.getUTCMonth() };
    }
    calTitle.textContent = monthTitle(month.y, month.m);
    const shownToday = new Date(today * 86_400_000);
    const away = chosen !== today || shownToday.getUTCMonth() !== month.m || shownToday.getUTCFullYear() !== month.y;
    toToday.classList.toggle("on", away);
    if (!weekdays.firstChild) for (const w of gridWeekdays()) weekdays.append(h("span", { text: w.slice(0, 2) }));
    clear(grid);
    for (const cell of monthGrid(month.y, month.m, Today.state.todos.map((x) => ({ ...x, done: isDone(x) })), today)) {
      const classes = ["tc-cell"];
      if (!cell.inMonth) classes.push("out");
      if (cell.isToday) classes.push("today");
      if (cell.day === chosen) classes.push("sel");
      if (cell.day < today) classes.push("past");
      const b = h("button", { class: classes.join(" ") },
        h("span", { class: "tc-n", text: String(cell.date) }),
        h("i", { class: cell.open ? "tc-dot" : cell.done ? "tc-dot done" : "tc-dot none" }),
      );
      b.addEventListener("click", () => {
        ctx?.blip();
        choose(cell.day);
      });
      grid.append(b);
    }
    const d = new Date(chosen * 86_400_000);
    const near = chosen >= today - 1 && chosen <= today + 1;
    dayTitle.textContent = near ? `${dayLabel(chosen, today)} · ${dayMonth(d.getUTCMonth(), d.getUTCDate())}` : `${weekdayLong(d.getUTCDay())} · ${dayMonth(d.getUTCMonth(), d.getUTCDate())}`;
    dayQuick.setPlaceholder(t("Add to {day}", { day: dayMonth(d.getUTCMonth(), d.getUTCDate()) }));
    const scrolled = dayScroll.scrollTop;
    clear(dayScroll);
    const list = dayTodos(Today.state.todos, chosen);
    if (list.length === 0) dayScroll.append(h("div", { class: "ad-empty td-empty", text: t("Nothing on this day.") }));
    for (const todo of list) dayScroll.append(todoRow(todo, today, chosen, ctx));
    dayScroll.scrollTop = scrolled;
    requestAnimationFrame(dayEdges);
  }

  function renderNotes() {
    if (!ctx) return;
    const today = todayDay();
    const scrolled = noteScroll.scrollTop;
    clear(noteScroll);
    const notes = notesByRecent(Today.state.notes);
    if (notes.length === 0) noteScroll.append(h("div", { class: "ad-empty td-empty", text: t("No notes yet.") }));
    for (const note of notes) noteScroll.append(noteRow(note, today, ctx));
    noteScroll.scrollTop = scrolled;
    requestAnimationFrame(noteEdges);
  }

  // ── Details ──
  const pane = buildPane();

  return {
    list(el, chosenView, c) {
      ctx = c;
      if (root.parentElement !== el) {
        clear(el);
        el.append(root);
      }
      view = chosenView ?? "today";
      const on = (box: HTMLElement, yes: boolean) => box.classList.toggle("on", yes);
      on(listView, view === "today" || view === "upcoming");
      on(calView, view === "calendar");
      on(notesView, view === "notes");
      if (view === "calendar") renderCalendar();
      else if (view === "notes") renderNotes();
      else renderLists();
    },
    pane: (el, itemId, c) => pane(el, itemId, c),
  };
}

// ── An item's details, edited in place ────────────────────────────────────────

function buildPane(): (el: HTMLElement, itemId: string, ctx: StageContext) => StagePane | null {
  // A to-do: its title, day and time, note.
  const title = h("input", { class: "tp-title", type: "text", maxlength: "200", spellcheck: "false" }) as HTMLInputElement;
  const date = h("input", { class: "tp-input tp-date", type: "date" }) as HTMLInputElement;
  const time = h("input", { class: "tp-input tp-time", type: "time" }) as HTMLInputElement;
  const said = h("span", { class: "tp-said" });
  const someday = h("button", { class: "tp-link", text: t("Remove date") });
  const note = h("textarea", { class: "tp-text tp-note", maxlength: "20000", spellcheck: "false" }) as HTMLTextAreaElement;
  note.setAttribute("placeholder", t("Add a note"));
  const todoPane = h("div", { class: "tp" },
    title,
    h("div", { class: "tp-when" },
      h("label", { class: "tp-field" }, svg(GLYPHS.calendar, 13, { stroke: 1.6 }), date),
      h("label", { class: "tp-field" }, svg(GLYPHS.clock, 13, { stroke: 1.6 }), time),
      said, someday),
    note,
  );
  // A note: its title and its text.
  const noteTitle = h("input", { class: "tp-title", type: "text", maxlength: "200", spellcheck: "false" }) as HTMLInputElement;
  noteTitle.setAttribute("placeholder", t("Title"));
  const noteBody = h("textarea", { class: "tp-text tp-body", maxlength: "20000", spellcheck: "false" }) as HTMLTextAreaElement;
  noteBody.setAttribute("placeholder", t("Write anything…"));
  const notePane = h("div", { class: "tp tp-notepane" }, noteTitle, noteBody);
  for (const f of [title, date, time, note, noteTitle, noteBody]) typeable(f);

  let shown: string | null = null;
  /** A note's Delete was pressed once: the next press deletes. */
  let armed: string | null = null;
  let saveTimer: number | null = null;
  let flushing: (() => void) | null = null;

  const update = (id: string, input: Parameters<typeof TodayBridge.updateTodo>[1]) =>
    TodayBridge.updateTodo(id, input).then(ok, failed);

  // Typing is saved after a pause, and at once when the field is left.
  const later = (save: () => void) => {
    if (saveTimer != null) window.clearTimeout(saveTimer);
    flushing = save;
    saveTimer = window.setTimeout(flush, 600);
  };
  function flush() {
    if (saveTimer != null) window.clearTimeout(saveTimer);
    saveTimer = null;
    const save = flushing;
    flushing = null;
    save?.();
  }

  title.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      title.blur();
    }
  });
  title.addEventListener("change", () => {
    const todo = shown ? Today.todo(shown) : undefined;
    const text = title.value.trim();
    if (!todo) return;
    if (!text) title.value = todo.title;
    else if (text !== todo.title) void update(todo.id, { title: text });
  });
  date.addEventListener("change", () => {
    if (!shown) return;
    void update(shown, { date: date.value || null });
  });
  time.addEventListener("change", () => {
    const todo = shown ? Today.todo(shown) : undefined;
    if (!todo) return;
    // A time needs a day: today, when it had none.
    void update(todo.id, time.value ? { date: todo.date ?? isoOf(todayDay()), time: time.value } : { time: null });
  });
  someday.addEventListener("click", () => {
    if (shown) void update(shown, { date: null });
  });
  const saveNote = () => {
    const todo = shown ? Today.todo(shown) : undefined;
    if (todo && note.value !== (todo.note ?? "")) void update(todo.id, { note: note.value });
  };
  note.addEventListener("input", () => later(saveNote));
  note.addEventListener("blur", flush);

  noteTitle.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      noteBody.focus();
    }
  });
  const saveNoteText = () => {
    const n = shown ? Today.note(shown) : undefined;
    if (!n) return;
    const change: { title?: string; body?: string } = {};
    const text = noteTitle.value.trim();
    if (text && text !== n.title) change.title = text;
    if (noteBody.value !== n.body) change.body = noteBody.value;
    if (Object.keys(change).length) void TodayBridge.updateNote(n.id, change).then(ok, failed);
  };
  for (const f of [noteTitle, noteBody]) {
    f.addEventListener("input", () => later(saveNoteText));
    f.addEventListener("blur", flush);
  }

  /** A field being typed in keeps what is typed; the others show what Rust has. */
  const put = (f: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    if (document.activeElement !== f && f.value !== value) f.value = value;
  };

  return (el, itemId, ctx) => {
    const todo = Today.todo(itemId);
    const n = todo ? undefined : Today.note(itemId);
    if (!todo && !n) {
      shown = null;
      return null;
    }
    if (shown !== itemId) {
      // Another item: what was being typed in the last one is saved first.
      flush();
      shown = itemId;
      armed = null;
      for (const f of [title, date, time, note, noteTitle, noteBody]) f.value = "";
    }
    const pane = todo ? todoPane : notePane;
    if (el.firstChild !== pane) {
      clear(el);
      el.append(pane);
    }
    const today = todayDay();
    if (todo) {
      put(title, todo.title);
      put(date, todo.date ?? "");
      put(time, todo.time ?? "");
      date.classList.toggle("empty", !date.value);
      time.classList.toggle("empty", !time.value);
      put(note, todo.note ?? "");
      const day = todo.date ? dayFromIso(todo.date) : null;
      said.textContent = day == null ? t("Someday") : isOverdue(todo, today) ? `${dayLabel(day, today)} · ${t("Overdue")}` : dayLabel(day, today);
      someday.style.display = day == null ? "none" : "";
      todoPane.classList.toggle("done", isDone(todo));
      const done = isDone(todo);
      const actions: DetailAction[] = [
        { id: "done", label: done ? t("Undo") : t("Done"), run: () => void update(todo.id, { done: !done }) },
      ];
      if (day !== today + 1) {
        actions.push({ id: "tomorrow", label: t("Move to tomorrow"), run: () => void update(todo.id, { date: isoOf(today + 1) }) });
      }
      actions.push({ id: "delete", label: t("Delete"), run: () => void TodayBridge.deleteTodo(todo.id).then(ok, failed) });
      return { title: "", actions };
    }
    const note_ = n!;
    put(noteTitle, note_.title);
    put(noteBody, note_.body);
    const remove = () => void TodayBridge.deleteNote(note_.id).then(ok, failed);
    const actions: DetailAction[] = [{
      id: "delete",
      label: armed === note_.id ? t("Delete this note?") : t("Delete"),
      run: () => {
        // A note with text asks once more: a stray click must not lose it.
        if (armed === note_.id || !note_.body.trim()) return remove();
        armed = note_.id;
        ctx.redraw();
        window.setTimeout(() => {
          if (armed !== note_.id) return;
          armed = null;
          ctx.redraw();
        }, 3000);
      },
    }];
    // Deleting is never the lit button.
    return { title: "", actions, plain: true };
  };
}

// ── The card (the overview's left card) ───────────────────────────────────────

/** How many to-dos the card lists. */
const CARD_ROWS = 3;

/** Today's card: the day, its open to-dos and the late ones, each ticked off with its circle. */
export function buildTodayCard(blip: () => void, now = new Date()): HTMLElement {
  const today = dayOf(now);
  const app = Feed.app("today");
  const name = app?.name ?? t("Today");
  const head = h("div", { class: "who" },
    logoElement(app?.pill ?? "app_today", name, 14),
    h("span", { class: "name", text: name }),
    h("span", { class: "tool", text: `${weekdayLong(now.getDay())} · ${dayMonth(now.getMonth(), now.getDate())}` }),
  );
  const open = cardTodos(Today.state.todos, today);
  const rows = open.slice(0, CARD_ROWS).map((todo) => {
    const done = isDone(todo);
    const late = !done && isOverdue(todo, today);
    const row = h("div", { class: `td-crow${done ? " done" : ""}${late ? " late" : ""}` });
    const when = late ? dayLabel(dayFromIso(todo.date!)!, today) : todo.time ?? "";
    row.append(
      checkButton(todo, row, blip),
      h("span", { class: "td-ctitle", text: todo.title }),
      ...(when ? [h("span", { class: "td-cwhen", text: when })] : []),
    );
    return row;
  });
  const body = h("div", { class: "card-body td-card" }, head);
  if (rows.length === 0) {
    const tomorrow = Today.state.todos.filter((x) => !x.done && x.date && dayFromIso(x.date) === today + 1).length;
    body.append(h("div", { class: "sub td-cempty", text: t("Nothing due today") }));
    if (tomorrow) body.append(h("div", { class: "td-cmore", text: t("{n} tomorrow", { n: tomorrow }) }));
  } else {
    body.append(...rows);
    if (open.length > CARD_ROWS) body.append(h("div", { class: "td-cmore", text: t("{n} more", { n: open.length - CARD_ROWS }) }));
  }
  return body;
}
