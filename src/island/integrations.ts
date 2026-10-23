// Integration events → island state. Port of the `handle…` methods in the Swift
// pollers: a genuinely new item flips the pill to finished/error, badges it when
// the pill isn't focused, plays a sound, and clears itself after 60 s.
// Updates come keyed by the app's registry id ("github"); the pill is the one
// the registry gives that app (State.tasks' `app`).

import { onEvent, Bridge, type IntegrationUpdate } from "../core/bridge";
import { Feed } from "../core/apps";
import { gitHubAlert, type GitHubEvent } from "../core/github";
import { MAIN_PILL } from "../core/pills";
import { Sound } from "../core/sound";
import { State, type AgentTask } from "../core/state";
import type { Island } from "./island";

const GITHUB = "github";

/** The pill of the registry app `app`, if it has one on the island now. */
const pillOf = (app: string): AgentTask | undefined => State.tasks.find((t) => t.app === app);

const clearTimers = new Map<string, number>();

export function registerIntegrationHandlers(island: Island) {
  void onEvent<IntegrationUpdate>("integration", (update) => handle(island, update));
  void onEvent<GitHubEvent[]>("github-alerts", handleGitHubAlerts);
  refreshConfigured();
  void refreshHookPills();
  State.subscribe(refreshGitHubWhenShown);
}

/**
 * AppState.handleGitHubEvents: the loudest event sets the badge — only while the
 * GitHub pill isn't the one on screen — and plays its sound. Unlike the other
 * integrations it leaves the mark's state alone and the badge stays until the pill
 * is focused, as on macOS.
 */
export function handleGitHubAlerts(events: GitHubEvent[]) {
  if (State.paused) return;
  const alert = gitHubAlert(events);
  if (!alert) return;
  const task = pillOf(GITHUB);
  if (!task) return;
  if (State.focusId !== task.id) task.pillBadge = alert.badge;
  // winotch: no sound of its own any more. The same events reach the bell as
  // GitHub notifications (github_notify.rs), which announce them once; the
  // badge stays, marking the pill until it is looked at.
  State.notify();
}

let gitHubShown = false;

/** The GitHub card just came on screen (focused, island opened): refresh it if stale. */
function refreshGitHubWhenShown() {
  const shown = State.mode === "expanded" && State.focusTask?.app === GITHUB;
  if (shown && !gitHubShown) void Bridge.githubRefresh("pulse");
  gitHubShown = shown;
}

/**
 * Whether each app is connected, so its idle card can say so: the registry
 * knows (a key in the credential store, the app it drives installed). Called
 * on every snapshot; nothing is asked of Rust here.
 */
export function refreshConfigured() {
  for (const app of Feed.apps) {
    const info = State.integrations[app.id] ?? { data: {}, error: null, loaded: false, configured: false };
    State.integrations[app.id] = { ...info, configured: app.configured };
  }
}

/** Claude Code's pill (not an app): its hooks in place (Mac #183). One small file read. */
export async function refreshHookPills() {
  // Without an answer from Rust (a plain browser), what the settings say counts.
  const installed = (await Bridge.hooksStatus())?.installed ?? State.settings.hooksInstalled;
  const info = State.integrations[MAIN_PILL] ?? { data: {}, error: null, loaded: false, configured: false };
  State.integrations[MAIN_PILL] = { ...info, configured: installed };
  State.notify();
}

function handle(island: Island, update: IntegrationUpdate) {
  if (State.paused) return;

  const previous = State.integrations[update.id];
  State.integrations[update.id] = {
    data: update.error ? (previous?.data ?? {}) : update.data,
    error: update.error,
    loaded: update.error ? (previous?.loaded ?? false) : true,
    configured: previous?.configured ?? true,
  };

  const event = update.event;
  if (event) {
    const task = pillOf(update.id);
    if (task) {
      task.state = event.success ? "finished" : "error";
      task.steps = event.detail ? [event.label, event.detail] : [event.label];
      task.stepIndex = task.steps.length - 1;
      if (State.focusId !== task.id) {
        task.pillBadge = event.success ? "finished" : "error";
      }
      // Over the chat, or an answer being said, it says nothing; its badge waits (State.hushed).
      if (!State.hushed) Sound.play(event.success ? "finish" : "error");
      // Same as the Swift pollers: show the compact island so the badge is seen,
      // but never steal the screen for a successful deploy. An app set not to
      // open the island (Settings → Apps) keeps its badge and sound only.
      if (State.opensIsland(task.id)) island.reveal();

      const existing = clearTimers.get(update.id);
      if (existing != null) window.clearTimeout(existing);
      clearTimers.set(
        update.id,
        window.setTimeout(() => {
          clearTimers.delete(update.id);
          const t = pillOf(update.id);
          if (!t || (t.state !== "finished" && t.state !== "error")) return;
          t.state = "idle";
          t.steps = [];
          t.stepIndex = 0;
          t.pillBadge = null;
          State.notify();
        }, 60_000),
      );
    }
  }

  State.notify();
}
