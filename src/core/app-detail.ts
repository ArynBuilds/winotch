// One app, expanded (the "app" view): what the island shows when the app's card
// is clicked. Which apps there are, their names and status lines come from the
// registry (core/apps.ts); every app is turned into the same shape, a status
// line and sections of items, so every app looks the same and nothing can draw
// its own layout:
// - an app that publishes a list (/v1/items, Gmail): that list, else its
//   notifications;
// - the built-ins with a presenter here: the data their poller already brings
//   (GitHub, Notion, Stripe), or the player (Spotify).

import { Feed, type AppAction, type AppInfo, type ListItem, type ListView } from "./apps";
import { Bridge } from "./bridge";
import { readNotifications, readPulse, reasonLabel, safeGitHubUrl, type CIState, type GitHubPR, type GitHubThread } from "./github";
import { Spotify } from "./spotify";
import { todayDetail } from "./today";
import { State } from "./state";
import { t } from "../i18n/i18n";

/** A row's button. Built-ins act here (`run`); apps hear of the press (`app`). */
export interface DetailAction extends AppAction {
  run?: () => void;
}

export interface DetailItem {
  id: string;
  title: string;
  subtitle?: string | null;
  /** Epoch ms. */
  time?: number | null;
  unread?: boolean;
  url?: string | null;
  actions?: DetailAction[];
  /** For an item that came from a notification: pressing reads and acts on it. */
  notification?: string;
  /** A click opens its details in the view (a mail's whole text), not its url. */
  detail?: boolean;
  /** The views of the list it is in; absent: all of them. */
  views?: string[] | null;
  /** Who and when, shown on its details pane before they came (Gmail). */
  byline?: string | null;
}

export interface DetailSection {
  title?: string | null;
  items: DetailItem[];
}

export interface AppDetail {
  /** The island task id: "integration_github", "app_gtm"… */
  taskId: string;
  name: string;
  /** For logoElement. */
  logoId: string;
  status: string | null;
  sections: DetailSection[];
  /** Shown when there are no items. */
  empty: string;
  /** Where the whole app opens (its website, dashboard). */
  link?: { label: string; url: string } | null;
  /** The list's views, shown in the left column under the mark; none: the list whole. */
  views?: ListView[];
}

// ── Views of a list (the left column) ────────────────────────────────────────

/** The view chosen per app, for as long as winotch runs. */
const chosenViews = new Map<string, string>();

/** The view an app's list is shown in: the one chosen last, else its first; null without views. */
export function currentView(appId: string, views: ListView[] | undefined): string | null {
  if (!views?.length) return null;
  const chosen = chosenViews.get(appId);
  return views.some((v) => v.id === chosen) ? chosen! : views[0].id;
}

export function chooseView(appId: string, view: string) {
  chosenViews.set(appId, view);
}

/** Whether an item shows in a view: one that names no views is in all of them. */
export const inView = (item: DetailItem, view: string | null) => view == null || !item.views || item.views.includes(view);

/** The sections as one view shows them: each keeps its title, and only its items in the view. */
export function sectionsInView(sections: DetailSection[], view: string | null): DetailSection[] {
  return sections.map((s) => ({ ...s, items: s.items.filter((i) => inView(i, view)) }));
}

/**
 * An item of the expanded view by its id: the list's id, or a presenter's
 * row that prefixes it with its kind ("thread:<id>" for GitHub's).
 */
export function findItem(detail: AppDetail, id: string): DetailItem | null {
  const all = detail.sections.flatMap((s) => s.items);
  // The kind is a word ("thread"), never an account ("me@gmail.com:3eb").
  const prefixed = (i: DetailItem) => {
    const kind = i.id.indexOf(":");
    return kind > 0 && /^[a-z]+$/.test(i.id.slice(0, kind)) && i.id.slice(kind + 1) === id;
  };
  return all.find((i) => i.id === id) ?? all.find(prefixed) ?? null;
}

// ── A text's quoted tail (the details pane) ──────────────────────────────────

/** An attribution line ending a reply: "On Sat, 17 Oct 2026, Ana <ana@…> wrote:", in the languages mail comes in. */
const WROTE = /(wrote|schrieb|a écrit|escribió|escreveu|ha scritto|schreef|написал\(а\)|написал|написала|yazdı|menulis|लिखा|লিখেছেন|كتب|写道|寫道|書きました).*:\s*$/i;
/** Where an Outlook-style reply leaves the earlier mail below. */
const ORIGINAL = /^\s*-{2,}\s*(original message|ursprüngliche nachricht|message d'origine|mensaje original|mensagem original|исходное сообщение|orijinal ileti)\s*-{2,}\s*$/i;
/** A line that starts a wrapped attribution ("On … <ana@" / "example.com> wrote:"). */
const ATTRIBUTION_START = /^(on|le|el|em|am|il|op|в|tarihinde)\s/i;

/**
 * A mail's text and the earlier mail it quotes at its end, which the pane
 * folds away as Gmail trims it: the trailing run of "> " lines with the
 * "… wrote:" line above it, or everything from an "Original Message" rule.
 * Quotes inside the text stay where they are; a text that is only a quote is
 * left whole.
 */
export function splitQuoted(text: string): { main: string; quoted: string | null } {
  const lines = text.split("\n");
  let start = -1;
  const rule = lines.findIndex((l) => ORIGINAL.test(l));
  if (rule >= 0) start = rule;
  else {
    let end = lines.length;
    while (end > 0 && !lines[end - 1].trim()) end--;
    let q = end;
    while (q > 0 && (lines[q - 1].trimStart().startsWith(">") || !lines[q - 1].trim())) q--;
    while (q < end && !lines[q].trim()) q++;
    if (q < end && lines[q].trimStart().startsWith(">")) {
      start = q;
      let above = q - 1;
      while (above >= 0 && !lines[above].trim()) above--;
      if (above >= 0 && WROTE.test(lines[above])) {
        start = above;
        if (above > 0 && lines[above - 1].trim() && !ATTRIBUTION_START.test(lines[above]) && ATTRIBUTION_START.test(lines[above - 1].trim())) {
          start = above - 1;
        }
      }
    }
  }
  if (start < 0) return { main: text, quoted: null };
  const main = lines.slice(0, start).join("\n").replace(/\s+$/, "");
  const quoted = lines.slice(start).join("\n").replace(/\s+$/, "");
  if (!main.trim() || !quoted.trim()) return { main: text, quoted: null };
  return { main, quoted };
}

/**
 * How many rows an app's card already shows, by registry id: its big view has
 * to show more than that to be worth opening.
 */
const CARD_ROWS: Record<string, number> = {
  // GitHub's card shows counts, not titles: any row is news.
  github: 0,
  notion: 3,
  stripe: 3,
  // Today's big view has its calendar and notes: always worth opening.
  today: -1,
};
/** An app's card shows its two latest notifications. */
const APP_CARD_ROWS = 2;

/**
 * Whether a task's card opens a big view: only when the view would show
 * clearly more than the card (the user's rule: expanding is earned). Claude
 * Code never (its depth is the chat), Spotify not while only the playing
 * track is known, an app only once it publishes a list; asked again as the
 * data changes, so GitHub with nothing open simply doesn't expand that day.
 */
export function canExpand(taskId: string): boolean {
  // Claude Code is no app of the registry, and neither are the agents' pills.
  const app = Feed.byPill(taskId);
  if (!app || app.id === "spotify") return false;
  const presented = PRESENTERS[app.id] != null;
  if (!presented && !Feed.lists?.[app.id]?.sections.some((s) => s.items.length > 0)) return false;
  const detail = detailFor(taskId);
  if (!detail) return false;
  const rows = detail.sections.reduce((n, s) => n + s.items.length, 0);
  return rows > (presented ? CARD_ROWS[app.id] ?? APP_CARD_ROWS : APP_CARD_ROWS);
}

/** What a built-in's poller reported, by its registry id. */
const data = (id: string) => (State.integrations[id]?.data ?? {}) as Record<string, unknown>;
const list = (id: string, key: string) => {
  const v = data(id)[key];
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
};
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** The built-ins whose data is presented here rather than published as a list. */
const PRESENTERS: Record<string, (app: AppInfo) => AppDetail> = {
  github: (app) => github(app),
  notion: (app) => notion(app),
  stripe: (app) => stripe(app),
  spotify: (app) => spotify(app),
  today: (app) => todayDetail(app),
};

/** The expanded view of the app whose pill this is; null for a pill that is no app's. */
export function detailFor(taskId: string): AppDetail | null {
  const app = Feed.byPill(taskId);
  if (!app) return null;
  return (PRESENTERS[app.id] ?? listed)(app);
}

/** The registry's status line: what is wrong first, else what the app says. */
const statusOf = (app: AppInfo) => app.problem ?? app.status ?? null;

// ── Apps that publish their list (the API's, Gmail) ──────────────────────────

function listed(app: AppInfo): AppDetail {
  const appId = app.id;
  const published = Feed.lists?.[appId];
  const base = {
    taskId: app.pill,
    name: app.name,
    logoId: app.pill,
    empty: t("Nothing here yet."),
  };
  if (published && published.sections.some((s) => s.items.length > 0)) {
    return {
      ...base,
      status: app.problem ?? published.status ?? app.status ?? null,
      sections: published.sections.map((s) => ({ title: s.title ?? null, items: s.items.map((i: ListItem) => ({ ...i })) })),
      views: published.views?.length ? published.views : undefined,
    };
  }
  // No list published: its notifications are its story so far.
  const notes = Feed.notifications.filter((n) => n.app === appId);
  return {
    ...base,
    status: statusOf(app),
    sections: [{
      title: null,
      items: notes.map((n) => ({
        id: n.id,
        title: n.title,
        subtitle: n.body ?? null,
        time: n.time,
        unread: !n.read,
        url: n.url ?? null,
        actions: n.acted ? [] : n.actions,
        notification: n.id,
      })),
    }],
  };
}

// ── Built-ins ────────────────────────────────────────────────────────────────

function prLine(pr: GitHubPR): DetailItem {
  const ci = pr.ci === "failure" ? t("CI failing") : pr.ci === "pending" ? t("CI running") : pr.ci === "success" ? t("CI passing") : null;
  const review = pr.review === "approved" ? t("Approved") : pr.review === "changesRequested" ? t("Changes requested") : null;
  return {
    id: pr.id,
    title: pr.title,
    subtitle: [`${pr.repo} #${pr.number}`, pr.isDraft ? t("Draft") : null, ci, review].filter(Boolean).join(" · "),
    unread: pr.ci === "failure" || pr.review === "changesRequested",
    url: pr.url,
  };
}

/** A GitHub button: Rust does it (github_notify.rs); a failure shows above the list. */
function githubAction(id: string, label: string, kind: "done" | "rerun" | "rerun-sha", target: string): DetailAction {
  return {
    id,
    label,
    run: () =>
      void Bridge.githubAct(kind, target).then(
        () => {
          Feed.error = null;
          State.notify();
        },
        (err) => {
          Feed.error = String(err);
          State.notify();
        },
      ),
  };
}

/** One unread thread of GitHub's inbox: Re-run (a failed run), Open, Mark as done. */
export function threadLine(th: GitHubThread): DetailItem {
  const url = safeGitHubUrl(th.url);
  const actions: DetailAction[] = [];
  if (th.rerun) actions.push(githubAction("rerun", t("Re-run"), "rerun", th.id));
  if (url) actions.push({ id: "open", label: t("Open"), run: () => void Bridge.openUrl(url) });
  actions.push(githubAction("done", t("Mark as done"), "done", th.id));
  return {
    id: `thread:${th.id}`,
    title: th.title,
    subtitle: [th.repo, reasonLabel(th.reason)].filter(Boolean).join(" · "),
    time: th.time || null,
    unread: th.unread,
    url,
    actions,
  };
}

/** A failing row with its commit known gets Re-run (its failed GitHub Actions runs). */
function withRerun(item: DetailItem, repo: string, ci: CIState, sha: string | null): DetailItem {
  if (ci !== "failure" || !sha) return item;
  return { ...item, actions: [githubAction("rerun", t("Re-run"), "rerun-sha", `${repo}@${sha}`)] };
}

function github(app: AppInfo): AppDetail {
  const pulse = readPulse(data(app.id));
  const threads = readNotifications(data(app.id));
  const sections: DetailSection[] = [];
  if (threads?.length) sections.push({ title: t("Notifications"), items: threads.map(threadLine) });
  if (pulse?.toReview.length) sections.push({ title: t("Waiting for your review"), items: pulse.toReview.map(prLine) });
  if (pulse?.myPRs.length) {
    sections.push({ title: t("Your pull requests"), items: pulse.myPRs.map((pr) => withRerun(prLine(pr), pr.repo, pr.ci, pr.headSha)) });
  }
  if (pulse?.mainCI.length) {
    sections.push({
      title: t("Main branches"),
      items: pulse.mainCI.map((r) => withRerun({
        id: `ci:${r.repo}`,
        title: r.repo,
        subtitle: `${r.branch} · ${r.ci === "failure" ? t("CI failing") : r.ci === "pending" ? t("CI running") : r.ci === "success" ? t("CI passing") : t("No CI")}`,
        unread: r.ci === "failure",
        url: r.url,
      }, r.repo, r.ci, r.headSha)),
    });
  }
  const open = (pulse?.myPRs.length ?? 0) + (pulse?.toReview.length ?? 0);
  return {
    taskId: app.pill,
    name: app.name,
    logoId: app.pill,
    status: pulse ? t("{0} open pull requests", { 0: open }) : State.integrations[app.id]?.error ?? statusOf(app),
    sections,
    empty: t("No pull request open, nothing to review."),
    link: { label: "github.com", url: "https://github.com/pulls" },
  };
}

function notion(app: AppInfo): AppDetail {
  const pages = list(app.id, "pages");
  return {
    taskId: app.pill,
    name: app.name,
    logoId: app.pill,
    status: State.integrations[app.id]?.error ?? app.problem ?? null,
    sections: [{
      title: t("Recently edited"),
      items: pages.map((p, i) => ({
        id: str(p.id) ?? String(i),
        title: [str(p.emoji), str(p.title) ?? t("Untitled")].filter(Boolean).join(" "),
        time: str(p.lastEditedAt) ? Date.parse(str(p.lastEditedAt)!) || null : null,
        url: str(p.url),
      })),
    }],
    empty: t("No page yet."),
    link: { label: "notion.so", url: "https://www.notion.so" },
  };
}

function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(document.documentElement.lang || undefined, { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

function stripe(app: AppInfo): AppDetail {
  const d = data(app.id);
  const currency = str(d.currency) ?? "eur";
  const payments = list(app.id, "payments");
  return {
    taskId: app.pill,
    name: app.name,
    logoId: app.pill,
    status: typeof d.balance === "number" ? t("Balance {0}", { 0: money(d.balance, currency) }) : State.integrations[app.id]?.error ?? app.problem ?? null,
    sections: [{
      title: t("Recent payments"),
      items: payments.map((p, i) => ({
        id: str(p.id) ?? String(i),
        title: money(Number(p.amount ?? 0), str(p.currency) ?? currency),
        subtitle: [str(p.description), p.status === "succeeded" ? null : str(p.status)].filter(Boolean).join(" · ") || null,
        time: typeof p.createdAt === "number" ? p.createdAt : null,
        url: str(p.id) ? `https://dashboard.stripe.com/payments/${p.id}` : null,
      })),
    }],
    empty: t("No payment yet."),
    link: { label: "dashboard.stripe.com", url: "https://dashboard.stripe.com/payments" },
  };
}

function spotify(app: AppInfo): AppDetail {
  const s = Spotify.state;
  const track = s.track;
  return {
    taskId: app.pill,
    name: app.name,
    logoId: app.pill,
    status: !s.installed ? t("Not installed") : s.playing ? t("Playing") : track ? t("Paused") : t("Not playing"),
    sections: track
      ? [{
          title: t("Now playing"),
          items: [{ id: track.id, title: track.title, subtitle: [track.artist, track.album].filter(Boolean).join(" · ") }],
        }]
      : [],
    empty: t("Nothing playing."),
    link: null,
  };
}
