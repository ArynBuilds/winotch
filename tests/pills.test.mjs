// The island's pills and Settings → Apps, both drawn from the one app registry
// (src-tauri/src/apps.rs; core/pills.ts registryPills, core/state.ts
// syncPills, core/app-list.ts appRows, hub/pages/apps.ts): Claude Code
// always first and no app; then the shown apps, built-ins first in the
// registry's order, then the API apps by name.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();

const { MAIN_PILL, PILL_CATALOG, isComingSoon, isHookPill, pillDefinition, registryPills, sessionSubtitle } =
  await import("../src/core/pills.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");
const { Feed } = await import("../src/core/apps.ts");
const { renderIntegrationCard } = await import("../src/views/integrations.ts");
const { AppList, appRows } = await import("../src/core/app-list.ts");
const { appBlock } = await import("../src/hub/pages/apps.ts");
const { apiApp, registry, useRegistry } = await import("./registry.mjs");

// ── Claude Code, the one pill that is not an app ──────────────────────────────

test("the catalog holds Claude Code only, with the ID, source and hooks it shipped with", () => {
  // An ID is a contract value (hook routing, the recap): it never changes.
  assert.deepEqual(
    PILL_CATALOG.map((p) => [p.id, p.name, p.color, p.category, p.subtitle, p.source, p.connect, p.support]),
    [["integration_claude", "Claude Code", "#F5F6F8", "workspace", "Integration", "claudeCode", { kind: "hooks" }, "yes"]],
  );
  assert.equal(MAIN_PILL, "integration_claude");
  assert.ok(isHookPill(MAIN_PILL) && !isComingSoon(MAIN_PILL));
  for (const id of ["integration_github", "integration_spotify", "app_gtm", "agent_unknown"]) {
    assert.equal(pillDefinition(id), undefined, id);
    assert.ok(!isHookPill(id), id);
  }
});

test("a live session names its tool next to the project", () => {
  assert.equal(sessionSubtitle("integration_claude"), "Claude Code");
  assert.equal(sessionSubtitle("agent_gemini"), "Agent");
  assert.equal(sessionSubtitle("agent_whatever"), "Agent");
});

// ── The pills, from a registry snapshot ───────────────────────────────────────

test("the pills come from the registry: built-ins in its order, then API apps by name", () => {
  const snap = registry({
    shown: ["spotify", "github", "notion"],
    apps: [apiApp("zed", "Zed"), apiApp("gtm", "gtm.js"), apiApp("abc", "Abc")],
  });
  assert.deepEqual(registryPills(snap.apps).map((p) => p.id),
    ["integration_github", "integration_notion", "integration_spotify", "app_abc", "app_gtm", "app_zed"]);
  assert.deepEqual(registryPills(snap.apps).map((p) => p.app), ["github", "notion", "spotify", "abc", "gtm", "zed"]);
  // API apps are put in order here too, whatever order they come in.
  const shuffled = [...snap.apps].reverse();
  assert.deepEqual(registryPills(shuffled).filter((p) => p.id.startsWith("app_")).map((p) => p.app), ["abc", "gtm", "zed"]);
});

test("a hidden app has no pill; Gmail gets one only once it is available", () => {
  const apps = [apiApp("gtm", "gtm.js", { shown: false }), apiApp("zed", "Zed")];
  assert.deepEqual(registryPills(registry({ apps }).apps).map((p) => p.app), ["github", "zed"],
    "Gmail with no account: listed in Settings, no pill");
  assert.deepEqual(registryPills(registry({ gmail: true, apps }).apps).map((p) => p.app), ["github", "gmail", "zed"]);
  assert.deepEqual(registryPills(registry({ shown: [], gmail: true }).apps), []);
});

test("Claude's MCP posts speak through Claude Code's pill: no pill of their own", () => {
  const snap = registry({ apps: [apiApp("claude", "Claude")] });
  assert.ok(!registryPills(snap.apps).some((p) => p.app === "claude" || p.id === MAIN_PILL));
});

beforeEach(() => {
  State.tasks = [];
  State.focusId = null;
  State.os = "windows";
  State.settings = { ...DEFAULT_SETTINGS };
  Feed.set({ apps: [], notifications: [], lists: {} });
});

const ids = () => State.tasks.map((t) => t.id);

test("Claude Code is always there, first, even before the registry, and focus starts on it", () => {
  State.syncPills();
  assert.deepEqual(ids(), ["integration_claude"]);
  assert.equal(State.focusId, "integration_claude");
  useRegistry({ shown: ["spotify", "github"] });
  assert.deepEqual(ids(), ["integration_claude", "integration_github", "integration_spotify"]);
  assert.equal(State.focusId, "integration_claude");
  assert.equal(State.tasks[1].app, "github");
});

test("an old settings file that picked another main pill still gets Claude Code", () => {
  State.settings = { ...DEFAULT_SETTINGS, mainPill: "agent_codex", activeIntegrations: ["agent_cursor"] };
  useRegistry();
  assert.deepEqual(ids(), ["integration_claude", "integration_github"]);
  assert.equal(State.mainPillId, "integration_claude");
  assert.equal(State.tasks[0].name, "Claude Code");
});

test("every app can be shown, with no limit, and the agents' pills stay right after Claude Code", () => {
  const all = { shown: ["github", "stripe", "notion", "spotify", "gmail"], gmail: true, apps: [apiApp("gtm", "gtm.js")] };
  useRegistry(all);
  State.upsertExternalAgent("agent_mine", "mine");
  useRegistry(all);
  assert.deepEqual(ids(), [
    "integration_claude", "agent_mine", "integration_github", "integration_stripe", "integration_notion",
    "integration_spotify", "app_gmail", "app_gtm",
  ]);
});

test("API apps get a pill each, after the built-ins and by name, unless hidden; names follow", () => {
  useRegistry({ apps: [apiApp("zed", "Zed"), apiApp("gtm", "gtm.js"), apiApp("claude", "Claude"), apiApp("quiet", "Quiet", { shown: false })] });
  assert.deepEqual(ids(), ["integration_claude", "integration_github", "app_gtm", "app_zed"]);
  // A new one lands in its place by name; one hidden since leaves; a new name shows.
  useRegistry({ apps: [apiApp("zed", "Zed 2"), apiApp("gtm", "gtm.js", { shown: false }), apiApp("abc", "Abc")] });
  assert.deepEqual(ids(), ["integration_claude", "integration_github", "app_abc", "app_zed"]);
  assert.equal(State.tasks.at(-1).name, "Zed 2");
});

test("turning an app off takes its pill and the focus away", () => {
  useRegistry({ shown: ["github", "stripe"] });
  State.setFocus("integration_stripe");
  useRegistry({ shown: ["github"] });
  assert.ok(!ids().includes("integration_stripe"));
  assert.equal(State.focusId, "integration_claude");
});

test("a pill in the middle of a session stays until the session ends", () => {
  useRegistry();
  const github = State.tasks.find((t) => t.id === "integration_github");
  github.state = "finished";
  useRegistry({ shown: [] });
  assert.ok(ids().includes("integration_github"));
  State.removeTask("integration_github");
  assert.ok(!ids().includes("integration_github"));
});

test("the end of a session puts a kept pill back as it was, and removes any other", () => {
  useRegistry();
  const github = State.tasks.find((t) => t.id === "integration_github");
  Object.assign(github, { name: "proj", state: "finished", steps: ["a"], pillBadge: "finished" });
  State.removeTask("integration_github");
  assert.deepEqual(
    [github.name, github.state, github.steps, github.pillBadge],
    ["GitHub", "idle", [], null],
  );
  State.upsertExternalAgent("agent_mine", "mine");
  State.setFocus("agent_mine");
  State.removeTask("agent_mine");
  assert.ok(!ids().includes("agent_mine"));
  assert.equal(State.focusId, "integration_claude");
});

test("a Claude Code session gets its pill even when it is not loaded", () => {
  const t = State.upsertWorkspacePill("integration_claude", "proj", "/p");
  assert.equal(ids()[0], "integration_claude");
  assert.equal(t.name, "proj");
  assert.equal(t.sessionCwd, "/p");
  assert.equal(State.upsertWorkspacePill("not_a_pill", "x", ""), null);
});

test("whether an app may open the island is the registry's, for built-ins and API apps alike", () => {
  useRegistry({
    shown: ["stripe", "spotify"],
    builtins: { stripe: { opensIsland: false } },
    apps: [apiApp("gtm", "gtm.js", { opensIsland: false })],
  });
  assert.ok(!State.opensIsland("integration_stripe"));
  assert.ok(State.opensIsland("integration_spotify"));
  assert.ok(!State.opensIsland("app_gtm"));
  assert.ok(State.opensIsland(MAIN_PILL), "Claude Code is no app: its own rules");
});

// ── Settings → Apps, from the same snapshot ──────────────────────────────────

test("Settings lists every app of the registry, built-ins first, and removes only API apps", () => {
  const snap = registry({
    shown: ["github"],
    builtins: { stripe: { problem: "Key not configured", configured: false }, gmail: { status: "3 unread" } },
    gmail: true,
    apps: [apiApp("zed", "Zed", { status: "ready" }), apiApp("claude", "Claude"), apiApp("gtm", "gtm.js", { shown: false, opensIsland: false })],
  });
  const rows = appRows(snap.apps);
  assert.deepEqual(rows.map((r) => r.id), ["github", "stripe", "notion", "spotify", "gmail", "today", "gtm", "zed"],
    "no Claude Code, and Claude's MCP posts are its");
  assert.deepEqual(rows.map((r) => r.kind), ["builtin", "builtin", "builtin", "builtin", "builtin", "builtin", "api", "api"]);
  assert.deepEqual(rows.map((r) => r.removable), [false, false, false, false, false, false, true, true]);
  assert.deepEqual(rows.map((r) => r.setup.kind), ["signIn", "key", "key", "none", "accounts", "none", "none", "none"]);
  assert.deepEqual(rows.map((r) => r.logoId),
    ["integration_github", "integration_stripe", "integration_notion", "integration_spotify", "app_gmail", "app_today", "app_gtm", "app_zed"]);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual([byId.github.shown, byId.stripe.shown, byId.gtm.shown, byId.gtm.opensIsland], [true, false, false, false]);
  assert.equal(byId.stripe.status, "Key not configured", "what is missing first");
  assert.equal(byId.gmail.status, "3 unread");
  assert.equal(byId.zed.status, "ready");
  assert.equal(byId.notion.status, null);
});

test("Gmail is in Settings before its first account, and says so", () => {
  const gmail = appRows(registry().apps).find((r) => r.id === "gmail");
  assert.equal(gmail.status, "Not connected");
  assert.equal(gmail.setup.kind, "accounts");
});

test("a newly registered API app is a row as soon as the registry has it", async () => {
  Feed.set(registry());
  assert.ok(!(await AppList.rows()).some((r) => r.id === "fresh"));
  Feed.set(registry({ apps: [apiApp("fresh", "Fresh")] }));
  const rows = await AppList.rows();
  assert.equal(rows.at(-1).id, "fresh");
  assert.ok(rows.at(-1).removable);
});

/** Lets the async parts of a row (a key's state, the CLI's answer) land. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** The row Settings draws for `id`, opened, from a registry with `options`. */
function render(id, options = {}) {
  Feed.set(registry({ gmail: true, ...options }));
  const env = {
    open: new Set([id]),
    redraw() {},
    accounts: (appId) => {
      const el = document.createElement("div");
      el.className = `accounts-of-${appId}`;
      return el;
    },
  };
  return appBlock(appRows(Feed.apps).find((r) => r.id === id), env);
}

const titles = (el) => el.find(".title").map((e) => e.textContent);

test("each app's row draws what its setup declares, the same way for every app", async () => {
  // none: the switches only.
  const spotify = render("spotify");
  await settle();
  assert.deepEqual(titles(spotify), ["Spotify", "Can open the island"]);
  assert.equal(spotify.find("INPUT").length, 0);
  assert.ok(!spotify.textContent.includes("Remove"));

  // key: its field, with the placeholder it declared.
  const stripe = render("stripe");
  await settle();
  assert.deepEqual(titles(stripe), ["Stripe", "Can open the island", "Secret key"]);
  assert.deepEqual(stripe.find("INPUT").map((i) => i.getAttribute("placeholder")), ["sk_live_…"]);

  // signIn: the choice, then the key in token mode (outside Tauri: no CLI).
  const github = render("github");
  await settle();
  await settle();
  assert.deepEqual(titles(github), ["GitHub", "Can open the island", "Sign in with", "Token"]);
  assert.equal(github.find(".hub-segmented").length, 1);
  assert.deepEqual(github.find("INPUT").map((i) => i.getAttribute("placeholder")), ["ghp_…"]);

  // accounts: the accounts list, each account choosing whether it opens the island.
  const gmail = render("gmail");
  assert.equal(gmail.find(".accounts-of-gmail").length, 1);
  assert.deepEqual(titles(gmail), ["Gmail"]);
  assert.ok(!gmail.textContent.includes("Remove"));

  // An API app: the switches, and Remove.
  const gtm = render("gtm", { apps: [apiApp("gtm", "gtm.js")] });
  assert.deepEqual(titles(gtm), ["gtm.js", "Can open the island"]);
  assert.ok(gtm.textContent.includes("Remove"));
  assert.ok(gtm.className.includes("open"), "an opened row stays open across a redraw");
});

test("the Claude Code idle card keeps the agent title when the task has a project name", () => {
  State.syncPills();
  const task = State.tasks.find((t) => t.id === "integration_claude");
  task.name = "my-project";
  const card = renderIntegrationCard(task, { openSettings() {} });
  assert.ok(card.textContent.includes("Claude Code"));
  assert.ok(!card.textContent.includes("my-project"));
  assert.ok(card.textContent.includes("Open Visual Studio Code"));
});
