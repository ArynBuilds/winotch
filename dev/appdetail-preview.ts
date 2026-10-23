// Gmail expanded in a real island, a mail opened: the page plays Rust's part
// (the apps snapshot, `app_item_detail`). `npm run dev`, then open
// /dev/appdetail-preview.html. Not shipped in the app.
//   ?open=0      click that row once the list shows (none: stay on the list)
//   ?answer=ok   the detail (default) · fail (an error) · hang (never answers) · slow (2.5 s)
//   ?lang=ru     the views' labels in that language (extra.json / strings.json)
//   ?view=unread the view chosen
//   ?unfold=meta|quote|both  open the details chevron and/or the trimmed quote once shown

import strings from "../src/i18n/strings.json";
import extra from "../src/i18n/extra.json";

const params = new URLSearchParams(location.search);
const answer = params.get("answer") ?? "ok";
const lang = params.get("lang") ?? "en";
const label = (en: string) => {
  const all = { ...(strings as { strings: Record<string, Record<string, string>> }).strings, ...(extra as { strings: Record<string, Record<string, string>> }).strings };
  return lang === "en" ? en : all[en]?.[lang] ?? en;
};

const now = Date.now();
const min = 60_000;
const ACCOUNT = "me@gmail.com";

/** As apps.rs serializes `ItemDetail` (mail/detail.rs `item_detail`). */
const DETAIL = {
  title: "Tomorrow's plan",
  byline: "Ana Müller · 2026-10-17 09:05",
  meta: ["From Ana Müller <ana@example.com>", "To Me <me@gmail.com>, bo@example.com", "Cc cy@example.com"],
  body: "Hi,\n\nThe island ships on Monday. Notes are in the doc:\nhttps://example.com/plan\n\nAna\n\nOn Fri, 16 Oct 2026 at 18:20, Me <me@gmail.com> wrote:\n> When does it ship?\n> Me",
  attachments: ["plan.pdf", "budget.xlsx"],
  url: "https://mail.google.com/mail/?authuser=me%40gmail.com#all/ff",
  actions: [{ id: "archive", label: "Archive" }, { id: "open", label: "Open in Gmail" }],
};

const mail = (n: number, title: string, from: string, snippet: string, ago: number, unread: boolean, primary: boolean) => ({
  id: `${ACCOUNT}:${(0x18f00 + n).toString(16)}`,
  title,
  subtitle: `${from} · ${snippet}`,
  time: now - ago,
  unread,
  url: `https://mail.google.com/mail/?authuser=me%40gmail.com#all/${n}`,
  actions: [...(unread ? [{ id: "read", label: "Mark read" }] : []), { id: "archive", label: "Archive" }],
  detail: true,
  views: ["inbox", ...(primary ? ["primary"] : []), ...(unread ? ["unread"] : [])],
  // mail/inbox.rs `item`: who and when, for the pane at once.
  byline: `${from} · 2026-10-17 09:05`,
});

const SNAPSHOT = {
  apps: [{
    id: "gmail", name: "Gmail", kind: "builtin", logo: "gmail", pill: "app_gmail", sign: null, icon: null, callback: null,
    status: "2 unread", problem: null, updated: now, shown: true, opensIsland: true, available: true, configured: true,
    settings: { kind: "accounts" },
  }],
  notifications: [],
  lists: {
    gmail: {
      status: "2 unread",
      updated: now,
      views: [
        { id: "inbox", label: label("Inbox") },
        { id: "primary", label: label("Primary") },
        { id: "unread", label: label("Unread") },
      ],
      sections: [{
        title: null,
        items: [
          mail(1, "Tomorrow's plan", "Ana Müller", "The island ships on Monday. Notes are in the doc", 4 * min, true, true),
          mail(2, "Your receipt from Example Store", "Example Store", "Thanks for your order", 52 * min, true, false),
          mail(3, "Re: the eye mark", "Bo", "Looks right at 16 px too", 3 * 60 * min, false, true),
          mail(4, "Weekly digest", "News", "Five things this week", 26 * 60 * min, false, false),
        ],
      }],
    },
  },
};

/** The "apps" event after a mail was opened: read now, out of Unread (main.ts `applyApps`). */
function republishRead(id: string) {
  const items = SNAPSHOT.lists.gmail.sections[0].items;
  const i = items.findIndex((m) => m.id === id);
  if (i < 0) return;
  items[i] = { ...items[i], unread: false, actions: items[i].actions.filter((a) => a.id !== "read"), views: items[i].views.filter((v) => v !== "unread") };
  const snapshot = JSON.parse(JSON.stringify(SNAPSHOT));
  void import("../src/core/apps").then(({ Feed }) =>
    import("../src/core/state").then(({ State }) => {
      Feed.set(snapshot);
      State.syncPills();
      State.notify();
    }),
  );
}

const logged: string[] = [];
(window as unknown as Record<string, unknown>).previewLog = logged;
let callbacks = 0;
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "island" }, currentWebview: { windowLabel: "island", label: "island" } },
  transformCallback: () => ++callbacks,
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "plugin:event|listen") return ++callbacks;
    if (cmd === "apps_snapshot") return SNAPSHOT;
    if (cmd === "log_line") {
      logged.push(String(args.message));
      console.log("[log_line]", args.message);
      return null;
    }
    if (cmd === "app_item_detail") {
      if (answer === "hang") return new Promise(() => {});
      if (answer === "fail") throw "Can't reach Gmail: no answer";
      if (answer === "slow") await new Promise((r) => setTimeout(r, 2500));
      // As mail/mod.rs `open_detail` does: the mail is marked read and the
      // list republished (the "apps" event) before the details answer.
      await new Promise((r) => setTimeout(r, 300));
      republishRead(String(args.item));
      return DETAIL;
    }
    return null;
  },
};

await import("../src/style.css");
const { Island } = await import("../src/island/island");
const { Feed } = await import("../src/core/apps");
const { State } = await import("../src/core/state");
const { chooseView } = await import("../src/core/app-detail");

Feed.set(SNAPSHOT as never);
if (params.get("view")) chooseView("gmail", params.get("view")!);
const island = new Island(document.getElementById("root")!);
State.detailApp = "app_gmail";
island.alert("app");

const open = params.get("open");
if (open != null) {
  await new Promise((r) => setTimeout(r, 900));
  (document.querySelectorAll(".appview .ad-item")[Number(open)] as HTMLElement | undefined)?.click();
  const unfold = params.get("unfold") ?? "";
  if (unfold) {
    await new Promise((r) => setTimeout(r, 700));
    if (unfold === "meta" || unfold === "both") (document.querySelector(".ad-meta-toggle") as HTMLElement | null)?.click();
    if (unfold === "quote" || unfold === "both") (document.querySelector(".ad-trim") as HTMLElement | null)?.click();
  }
}
