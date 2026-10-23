// One app expanded (the "app" view) in a real island, on sample data: an app's
// published list (?app=gtm, the default), GitHub's pulse (?app=github) or an
// app with notifications only (?app=notes). `npm run dev`, then open
// /dev/appview-preview.html. Not shipped in the app.

import "../src/style.css";
import { Island } from "../src/island/island";
import { Feed } from "../src/core/apps";
import { State } from "../src/core/state";

const now = Date.now();
const min = 60_000;
const which = new URLSearchParams(location.search).get("app") ?? "gtm";

Feed.set({
  apps: [
    {
      id: "gtm", name: "gtm.js", kind: "api", logo: "gtm", pill: "app_gtm", sign: "-.", icon: null, callback: null,
      status: "3 drafts waiting", problem: null, updated: now, shown: true, opensIsland: true, available: true, configured: true,
      settings: { kind: "none" },
    },
    {
      id: "github", name: "GitHub", kind: "builtin", logo: "github", pill: "integration_github", sign: null, icon: null, callback: null,
      status: null, problem: null, updated: now, shown: true, opensIsland: true, available: true, configured: true,
      settings: { kind: "signIn", modes: ["cli", "token"] },
    },
  ],
  notifications: [
    { id: "n1", app: "gtm", title: "Reply draft on reddit: best island apps for Windows", body: "A short, honest answer with the repo link.", time: now - 4 * min, read: false, actions: [{ id: "posted:1", label: "Posted" }, { id: "drop:1", label: "Drop" }], url: null, acted: null, importance: "normal" },
    { id: "n2", app: "gtm", title: "Post draft for x", body: "Shipped: the island that talks to Claude Code.", time: now - 52 * min, read: true, actions: [], url: null, acted: "posted:2", importance: "normal" },
  ],
  lists: which === "notes" ? {} : {
    gtm: {
      status: "3 drafts waiting",
      updated: now,
      sections: [{
        title: "Drafts",
        items: [
          { id: "1", title: "Best island apps for Windows? Here is what I built", subtitle: "Reply draft on reddit: r/Windows11", time: now - 4 * min, unread: true, actions: [{ id: "posted:1", label: "Posted" }, { id: "drop:1", label: "Drop" }] },
          { id: "2", title: "Shipped: the island that talks to Claude Code", subtitle: "Post draft for x", time: now - 52 * min, actions: [{ id: "posted:2", label: "Posted" }, { id: "drop:2", label: "Drop" }] },
          { id: "3", title: "How I cut my widget's idle CPU from 8% to zero", subtitle: "Post draft for linkedin", time: now - 3 * 60 * min, actions: [{ id: "posted:3", label: "Posted" }, { id: "drop:3", label: "Drop" }] },
        ],
      }],
    },
  },
} as never);

if (which === "github") {
  State.integrations.github = {
    loaded: true, error: null, configured: true,
    data: {
      pulse: {
        login: "octocat",
        fetchedAt: now,
        toReview: [
          { id: "r1", title: "Cache the session list between refreshes", url: "https://github.com", repo: "winotch", number: 41, isDraft: false, ci: "success", review: "pending", headSha: null },
        ],
        myPRs: [
          { id: "p1", title: "Settings, Apple-simple: 15 pages become 7", url: "https://github.com", repo: "winotch", number: 44, isDraft: false, ci: "failure", review: "changesRequested", headSha: null },
          { id: "p2", title: "Gradients that melt away", url: "https://github.com", repo: "winotch", number: 43, isDraft: false, ci: "success", review: "approved", headSha: null },
          { id: "p3", title: "Publish open drafts as a list", url: "https://github.com", repo: "gtm.js", number: 12, isDraft: true, ci: "pending", review: "unknown", headSha: null },
        ],
        mainCI: [
          { repo: "winotch", url: "https://github.com", branch: "main", ci: "success", headSha: null },
          { repo: "gtm.js", url: "https://github.com", branch: "main", ci: "failure", headSha: null },
        ],
      },
    },
  } as never;
}

State.syncPills();
const island = new Island(document.getElementById("root")!);
State.detailApp = which === "github" ? "integration_github" : "app_gtm";
island.alert("app");
