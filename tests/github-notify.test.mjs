// GitHub's notifications in the expanded view, its buttons, and how GitHub
// signs in (src/core/app-detail.ts, app-list.ts, github.ts). The Rust half —
// the inbox, the backlog rule, coalescing, mirroring read and done, `gh auth
// token` — is tested in src-tauri/src/github_notify.rs and github_auth.rs.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { calls, sent } from "./tauri.mjs";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();

const { detailFor, threadLine } = await import("../src/core/app-detail.ts");
const { readNotifications, reasonLabel } = await import("../src/core/github.ts");
const { AppList, githubAuthMode } = await import("../src/core/app-list.ts");
const { Feed, pillOfApp } = await import("../src/core/apps.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");
const { registry, useRegistry } = await import("./registry.mjs");

/** GitHub's pill; its data is kept under its registry id, "github". */
const GITHUB = "integration_github";

const thread = (id, extra = {}) => ({
  id, unread: true, reason: "review_requested", time: 1_800_000_000_000, title: `Thread ${id}`,
  kind: "PullRequest", repo: "me/app", url: `https://github.com/me/app/pull/${id}`, rerun: false, ...extra,
});

const pr = (id, ci, headSha = "0123abc") => ({
  id: `me/app#${id}`, title: `PR ${id}`, url: `https://github.com/me/app/pull/${id}`, repo: "me/app",
  number: id, isDraft: false, ci, review: "unknown", headSha,
});

function setData(data) {
  State.integrations.github = { data, error: null, loaded: true, configured: true };
}

beforeEach(() => {
  calls.length = 0;
  Feed.error = null;
  State.settings = { ...DEFAULT_SETTINGS };
  State.tasks = [];
  State.focusId = null;
  useRegistry();
});

test("the inbox is read only when Rust sent a list", () => {
  assert.equal(readNotifications({}), null);
  assert.equal(readNotifications({ notifications: { id: "1" } }), null);
  assert.deepEqual(readNotifications({ notifications: [thread("1"), { nope: true }, null] }).map((t) => t.id), ["1"]);
});

test("GitHub's reasons read as a few words", () => {
  assert.equal(reasonLabel("review_requested"), "Review requested");
  assert.equal(reasonLabel("mention"), "Mentioned you");
  assert.equal(reasonLabel("assign"), "Assigned to you");
  assert.equal(reasonLabel("ci_activity"), "CI activity");
  assert.equal(reasonLabel("subscribed"), "Watching");
  assert.equal(reasonLabel("something_new"), "something new");
});

test("Notifications come first, then everything the GitHub view showed before", () => {
  setData({
    notifications: [thread("1"), thread("2", { reason: "ci_activity", kind: "CheckSuite", rerun: true, url: "https://github.com/me/app/actions" })],
    pulse: {
      login: "me", fetchedAt: 0,
      toReview: [pr(7, "success")],
      myPRs: [pr(8, "failure"), pr(9, "success")],
      mainCI: [{ repo: "me/app", url: "https://github.com/me/app", branch: "main", ci: "failure", headSha: "fedcba9" }],
    },
  });
  const detail = detailFor(GITHUB);
  assert.deepEqual(detail.sections.map((s) => s.title), ["Notifications", "Waiting for your review", "Your pull requests", "Main branches"]);
  const [review, ci] = detail.sections[0].items;
  // Same row anatomy as every app: title, "repo · reason", time, unread, link.
  assert.deepEqual(
    [review.title, review.subtitle, review.time, review.unread, review.url],
    ["Thread 1", "me/app · Review requested", 1_800_000_000_000, true, "https://github.com/me/app/pull/1"],
  );
  assert.deepEqual(review.actions.map((a) => a.label), ["Open", "Mark as done"]);
  assert.deepEqual(ci.actions.map((a) => a.label), ["Re-run", "Open", "Mark as done"]);
  // The rows that were there keep their look; a failing one gains Re-run.
  const mine = detail.sections[2].items;
  assert.equal(mine[0].subtitle, "me/app #8 · CI failing");
  assert.deepEqual(mine[0].actions.map((a) => a.label), ["Re-run"]);
  assert.equal(mine[1].actions, undefined);
  assert.deepEqual(detail.sections[3].items[0].actions.map((a) => a.label), ["Re-run"]);
  assert.equal(detail.sections[1].items[0].actions, undefined);
});

test("without an inbox yet, the view is what it was", () => {
  setData({ pulse: { login: "me", fetchedAt: 0, toReview: [], myPRs: [pr(1, "success")], mainCI: [] } });
  assert.deepEqual(detailFor(GITHUB).sections.map((s) => s.title), ["Your pull requests"]);
});

test("the buttons call Rust and open the link", async () => {
  const row = threadLine(thread("42", { reason: "ci_activity", rerun: true }));
  const [rerun, open, done] = row.actions;
  rerun.run();
  done.run();
  open.run();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent("github_act"), [{ kind: "rerun", id: "42" }, { kind: "done", id: "42" }]);
  assert.deepEqual(sent("open_url"), [{ url: "https://github.com/me/app/pull/42" }]);

  // A failing row's Re-run names its commit.
  setData({ pulse: { login: "me", fetchedAt: 0, toReview: [], myPRs: [pr(5, "failure", "abc1234")], mainCI: [] } });
  detailFor(GITHUB).sections[0].items[0].actions[0].run();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent("github_act").at(-1), { kind: "rerun-sha", id: "me/app@abc1234" });
});

test("a link that is not github.com is not opened", () => {
  const row = threadLine(thread("1", { url: "https://evil.example/x" }));
  assert.equal(row.url, null);
  assert.deepEqual(row.actions.map((a) => a.label), ["Mark as done"]);
});

test("GitHub signs in with the CLI when it was picked, or when never picked and it is signed in", () => {
  const signedIn = { installed: true, signedIn: true, login: "BL4X3", error: null };
  const signedOut = { installed: true, signedIn: false, login: null, error: "signed out" };
  assert.equal(githubAuthMode("", signedIn), "cli");
  assert.equal(githubAuthMode("", signedOut), "token");
  assert.equal(githubAuthMode("", null), "token");
  assert.equal(githubAuthMode(undefined, signedIn), "cli");
  assert.equal(githubAuthMode("token", signedIn), "token");
  assert.equal(githubAuthMode("cli", signedOut), "cli");
});

test("the GitHub row carries its sign-in, and GitHub's notifications are no second app", async () => {
  const rows = await AppList.rows();
  const github = rows.find((r) => r.id === "github");
  assert.equal(github.setup.kind, "signIn");
  assert.deepEqual(github.setup.modes, ["cli", "token"]);
  assert.equal(github.setup.key.secret, "github-token");
  // Outside Tauri there is no CLI: the token, never chosen.
  assert.deepEqual(await AppList.githubAuth(), { mode: "token", chosen: false, cli: null });

  // GitHub is one app: one pill, and its notifications wear that pill's logo.
  Feed.set(registry({ notifications: [{ id: "1", app: "github", title: "Review requested", body: null, url: null,
    importance: "normal", actions: [], time: 1, read: false, acted: null }] }));
  State.syncPills();
  assert.deepEqual(State.tasks.filter((t) => t.app === "github").map((t) => t.id), [GITHUB]);
  assert.ok(!State.tasks.some((t) => t.id === "app_github"), "no pill of its own");
  assert.equal(pillOfApp("github"), GITHUB);
  assert.equal(rows.filter((r) => r.id === "github").length, 1, "one row in Settings");
});
