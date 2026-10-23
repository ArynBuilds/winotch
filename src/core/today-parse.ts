// Today's quick add (WINOTCH.md "Today"): "Call Sarah tomorrow 3pm" becomes a
// title, a day and a time, read here on the island and nowhere else. English
// only. Pure: the clock is passed in, so every rule is tested.
//
// What it understands, anywhere in the text (with "on", "at", "by", "due"
// before it taken too):
// - days: today, tonight, tomorrow (tmr, tmrw), the day after tomorrow;
//   weekdays (friday, fri; "sat" and "sun" only after on/this/next): the next
//   one, never today; "this friday" this week's (today included), "next
//   friday" next week's; next week (its Monday), this/next weekend, next
//   month; in 3 days, in 2 weeks, in a month;
// - dates: 21 Oct, Oct 21, October 21st, the 21st of October, 10/21 (month
//   first unless the first number is past 12), 10/21/2027, 2026-10-21; a day
//   without a year that has passed is next year's;
// - times: 3pm, 3:30 pm, 15:00, at 9, noon, midnight, morning (09:00),
//   afternoon (15:00), evening (18:00), tonight (20:00); in 2 hours, in 30
//   minutes. An hour said alone ("at 3") is the afternoon from 1 to 7. A time
//   without a day is today, or tomorrow once it has passed.
// Whatever is left is the title.

export interface Parsed {
  title: string;
  /** YYYY-MM-DD, or null: no day said. */
  date: string | null;
  /** HH:MM (24 h), or null. */
  time: string | null;
}

// ── Days as numbers (days since 1970-01-01, the user's own calendar) ─────────

const MS_DAY = 86_400_000;

/** The local day of `d`. */
export function dayOf(d: Date): number {
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / MS_DAY);
}

export function isoOf(day: number): string {
  const d = new Date(day * MS_DAY);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** "2026-10-21" → its day; null unless a real date. */
export function dayFromIso(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  return dayFromParts(Number(m[1]), Number(m[2]), Number(m[3]));
}

function dayFromParts(y: number, month: number, d: number): number | null {
  if (month < 1 || month > 12 || d < 1 || d > 31 || y < 1970 || y > 9999) return null;
  const t = Date.UTC(y, month - 1, d);
  const back = new Date(t);
  if (back.getUTCMonth() !== month - 1 || back.getUTCDate() !== d) return null;
  return Math.round(t / MS_DAY);
}

/** Sunday 0 … Saturday 6 (1970-01-01 was a Thursday). */
export function weekdayOf(day: number): number {
  return (((day + 4) % 7) + 7) % 7;
}

/** The Monday of the week holding `day`. */
export function mondayOf(day: number): number {
  return day - ((weekdayOf(day) + 6) % 7);
}

function addMonths(day: number, n: number): number {
  const d = new Date(day * MS_DAY);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Math.round(Date.UTC(y, m, Math.min(d.getUTCDate(), last)) / MS_DAY);
}

const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

// ── Words ─────────────────────────────────────────────────────────────────────

const WEEKDAYS: [RegExp, number][] = [
  [/sunday|sun/, 0], [/monday|mon/, 1], [/tuesday|tues|tue/, 2], [/wednesday|wed/, 3],
  [/thursday|thurs|thur|thu/, 4], [/friday|fri/, 5], [/saturday|sat/, 6],
];
const WEEKDAY = "monday|tuesday|wednesday|thursday|friday|saturday|sunday|tues|thurs|thur|mon|tue|wed|thu|fri";
/** Short forms that are also words ("sat", "sun"): only after on, this or next. */
const WEEKDAY_SHORT_WORDS = "sat|sun";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = "january|february|march|april|may|june|july|august|september|sept|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec";

function weekdayNumber(word: string): number {
  const w = word.toLowerCase();
  return WEEKDAYS.find(([re]) => new RegExp(`^(?:${re.source})$`).test(w))![1];
}

function monthNumber(word: string): number {
  return MONTHS.indexOf(word.toLowerCase().slice(0, 3)) + 1;
}

const LEAD = String.raw`(?:\b(?:on|at|by|due|for)\s+)?`;

// ── The parser ────────────────────────────────────────────────────────────────

interface Ctx {
  now: Date;
  today: number;
  /** Minutes after midnight, now. */
  minute: number;
  date: number | null;
  time: number | null;
  /** "morning" or "evening" said: how an hour alone reads. */
  half: "am" | "pm" | null;
  /** A default time a word gave ("tonight": 20:00), used if no time was said. */
  soft: number | null;
}

type Rule = { re: RegExp; kind: "date" | "time" | "both"; apply: (m: RegExpExecArray, c: Ctx) => boolean };

/** An hour said without am or pm: 1 to 7 is the afternoon, unless the day's half was said. */
function plainHour(h: number, min: number, c: Ctx): number | null {
  if (h > 23 || min > 59) return null;
  let hour = h;
  if (h >= 1 && h <= 11) {
    if (c.half === "pm") hour = h + 12;
    else if (c.half !== "am" && h <= 7) hour = h + 12;
  }
  return hour * 60 + min;
}

function withHalf(h: number, min: number, half: string): number | null {
  if (h < 1 || h > 12 || min > 59) return null;
  const pm = half.toLowerCase().startsWith("p");
  const hour = (h % 12) + (pm ? 12 : 0);
  return hour * 60 + min;
}

/** A date without a year: this year's, or next year's once it has passed. */
function nearest(month: number, d: number, c: Ctx): number | null {
  const y = c.now.getFullYear();
  const day = dayFromParts(y, month, d);
  if (day == null) return dayFromParts(y + 1, month, d);
  return day < c.today ? dayFromParts(y + 1, month, d) : day;
}

function fullYear(y: string | undefined): number | null {
  if (!y) return null;
  const n = Number(y);
  return y.length === 2 ? 2000 + n : n;
}

const RULES: Rule[] = [
  // ── Both at once ──
  {
    re: new RegExp(String.raw`\bin\s+(\d{1,3}|an?|half\s+an)\s+(minutes?|mins?|hours?|hrs?|h)\b`, "i"),
    kind: "both",
    apply: (m, c) => {
      const n = /^half/i.test(m[1]) ? 0.5 : /^an?$/i.test(m[1]) ? 1 : Number(m[1]);
      const minutes = /^h/i.test(m[2]) ? n * 60 : n;
      if (!(minutes > 0) || minutes > 72 * 60) return false;
      const at = new Date(c.now.getTime() + minutes * 60_000);
      c.date = dayOf(at);
      c.time = at.getHours() * 60 + at.getMinutes();
      return true;
    },
  },
  // ── Days ──
  {
    re: /\b(?:the\s+)?day\s+after\s+tomorrow\b/i,
    kind: "date",
    apply: (_m, c) => ((c.date = c.today + 2), true),
  },
  {
    re: new RegExp(String.raw`${LEAD}\b(today|tonight|tomorrow|tomorow|tmrw|tmr)\b`, "i"),
    kind: "date",
    apply: (m, c) => {
      const w = m[1].toLowerCase();
      c.date = w === "today" || w === "tonight" ? c.today : c.today + 1;
      if (w === "tonight") {
        c.half = "pm";
        c.soft = 20 * 60;
      }
      return true;
    },
  },
  {
    re: new RegExp(String.raw`\bin\s+(\d{1,3}|an?|one|two|three)\s+(days?|weeks?|months?)\b`, "i"),
    kind: "date",
    apply: (m, c) => {
      const words: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3 };
      const n = words[m[1].toLowerCase()] ?? Number(m[1]);
      const unit = m[2].toLowerCase();
      if (!(n > 0) || n > 999) return false;
      c.date = unit.startsWith("month") ? addMonths(c.today, n) : c.today + n * (unit.startsWith("week") ? 7 : 1);
      return true;
    },
  },
  {
    re: /\b(this|next)\s+weekend\b|\b(?:(?:on|at|over|for)\s+)?(?:the\s+)?weekend\b/i,
    kind: "date",
    apply: (m, c) => {
      const wd = weekdayOf(c.today);
      if (m[1]?.toLowerCase() === "next") c.date = mondayOf(c.today) + 7 + 5;
      else c.date = wd === 6 || wd === 0 ? c.today : c.today + (6 - wd);
      return true;
    },
  },
  {
    re: /\bnext\s+(week|month)\b/i,
    kind: "date",
    apply: (m, c) => {
      c.date = m[1].toLowerCase() === "week" ? mondayOf(c.today) + 7 : addMonths(c.today, 1);
      return true;
    },
  },
  {
    re: new RegExp(String.raw`${LEAD}\b(?:(this|next|coming|on)\s+)?(${WEEKDAY}|${WEEKDAY_SHORT_WORDS})\b\.?`, "i"),
    kind: "date",
    apply: (m, c) => {
      const lead = m[1]?.toLowerCase();
      const word = m[2].toLowerCase();
      if (new RegExp(`^(?:${WEEKDAY_SHORT_WORDS})$`).test(word) && !lead && !/^\s*(on|by|due|for)\b/i.test(m[0])) return false;
      const target = weekdayNumber(word);
      const wd = weekdayOf(c.today);
      if (lead === "next") {
        // Next week's: the week after this one (weeks start on Monday).
        c.date = mondayOf(c.today) + 7 + ((target + 6) % 7);
      } else if (lead === "this") {
        const ahead = (target - wd + 7) % 7;
        c.date = c.today + ahead;
      } else {
        const ahead = (target - wd + 7) % 7 || 7;
        c.date = c.today + ahead;
      }
      return true;
    },
  },
  // ── Dates ──
  {
    re: new RegExp(String.raw`${LEAD}\b(\d{4})-(\d{2})-(\d{2})\b`, "i"),
    kind: "date",
    apply: (m, c) => {
      const day = dayFromParts(Number(m[1]), Number(m[2]), Number(m[3]));
      if (day == null) return false;
      c.date = day;
      return true;
    },
  },
  {
    // 21 Oct, 21st October 2027, the 21st of October
    re: new RegExp(String.raw`${LEAD}\b(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(${MONTH})\b\.?(?:,?\s+(\d{4}))?`, "i"),
    kind: "date",
    apply: (m, c) => {
      const month = monthNumber(m[2]);
      const y = fullYear(m[3]);
      const day = y ? dayFromParts(y, month, Number(m[1])) : nearest(month, Number(m[1]), c);
      if (day == null) return false;
      c.date = day;
      return true;
    },
  },
  {
    // Oct 21, October 21st, 2027
    re: new RegExp(String.raw`${LEAD}\b(${MONTH})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?`, "i"),
    kind: "date",
    apply: (m, c) => {
      const month = monthNumber(m[1]);
      const y = fullYear(m[3]);
      const day = y ? dayFromParts(y, month, Number(m[2])) : nearest(month, Number(m[2]), c);
      if (day == null) return false;
      c.date = day;
      return true;
    },
  },
  {
    // 10/21, 21/10 (the first past 12), 10/21/2027, 10/21/27
    re: new RegExp(String.raw`${LEAD}\b(\d{1,2})/(\d{1,2})(?:/(\d{4}|\d{2}))?\b`, "i"),
    kind: "date",
    apply: (m, c) => {
      let [month, d] = [Number(m[1]), Number(m[2])];
      if (month > 12 && d <= 12) [month, d] = [d, month];
      const y = fullYear(m[3]);
      const day = y ? dayFromParts(y, month, d) : nearest(month, d, c);
      if (day == null) return false;
      c.date = day;
      return true;
    },
  },
  // ── Times ──
  {
    re: /\b(?:in\s+the\s+)?(morning|afternoon|evening)\b/i,
    kind: "time",
    apply: (m, c) => {
      const w = m[1].toLowerCase();
      c.half = w === "morning" ? "am" : "pm";
      c.soft = w === "morning" ? 9 * 60 : w === "afternoon" ? 15 * 60 : 18 * 60;
      // Only a hint: a time said as well wins.
      return true;
    },
  },
  {
    re: /(?:\bat\s+|@\s*)?\b(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?\s?m\b\.?/i,
    kind: "time",
    apply: (m, c) => {
      const t = withHalf(Number(m[1]), Number(m[2] ?? 0), m[3]);
      if (t == null) return false;
      c.time = t;
      return true;
    },
  },
  {
    re: /(?:\bat\s+|@\s*)?\b(\d{1,2}):(\d{2})\b/i,
    kind: "time",
    apply: (m, c) => {
      const h = Number(m[1]);
      const t = h > 12 || h === 0 ? (h <= 23 && Number(m[2]) < 60 ? h * 60 + Number(m[2]) : null) : plainHour(h, Number(m[2]), c);
      if (t == null) return false;
      c.time = t;
      return true;
    },
  },
  {
    re: /(?:\bat\s+|@\s*)(\d{1,2})\b(?![/.:\d])/i,
    kind: "time",
    apply: (m, c) => {
      const t = plainHour(Number(m[1]), 0, c);
      if (t == null) return false;
      c.time = t;
      return true;
    },
  },
  {
    re: /(?:\bat\s+)?\b(noon|midday|midnight)\b/i,
    kind: "time",
    apply: (m, c) => {
      c.time = m[1].toLowerCase() === "midnight" ? 0 : 12 * 60;
      return true;
    },
  },
];

/**
 * Reads a quick-add line: the title and the day and time it names. `now`
 * is the user's clock. A line that is only a day ("tomorrow") has an empty
 * title.
 */
export function parseQuick(text: string, now: Date = new Date()): Parsed {
  const c: Ctx = {
    now,
    today: dayOf(now),
    minute: now.getHours() * 60 + now.getMinutes(),
    date: null,
    time: null,
    half: null,
    soft: null,
  };
  let rest = ` ${text} `;
  for (const rule of RULES) {
    if ((rule.kind === "date" || rule.kind === "both") && c.date != null) continue;
    if ((rule.kind === "time" || rule.kind === "both") && c.time != null) continue;
    // A rule may decline its first match ("sat" as a word): look further on.
    const global = new RegExp(rule.re.source, rule.re.flags.includes("g") ? rule.re.flags : rule.re.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = global.exec(rest))) {
      if (m[0].length === 0) {
        global.lastIndex++;
        continue;
      }
      const before = { date: c.date, time: c.time, half: c.half, soft: c.soft };
      if (rule.apply(m, c)) {
        rest = rest.slice(0, m.index) + " ".repeat(m[0].length) + rest.slice(m.index + m[0].length);
        break;
      }
      Object.assign(c, before);
    }
  }
  if (c.time == null && c.soft != null && c.date != null) c.time = c.soft;
  // "morning" alone, with no day: a time of day, not a day.
  if (c.time == null && c.soft != null && c.date == null) c.time = c.soft;
  if (c.time != null && c.date == null) c.date = c.time > c.minute ? c.today : c.today + 1;
  const title = rest
    .replace(/\s+/g, " ")
    .trim()
    // Left hanging where a day or time was taken out.
    .replace(/(?:\s+(?:on|at|by|due|for|,|-|–))+$/i, "")
    .replace(/^(?:(?:on|at|by|due)\s+)+/i, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/[,;:\-–]+$/, "")
    .replace(/^[,;:\-–\s]+/, "")
    .trim();
  return { title, date: c.date == null ? null : isoOf(c.date), time: c.time == null ? null : hhmm(c.time) };
}
