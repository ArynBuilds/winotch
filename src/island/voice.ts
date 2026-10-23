// « OK Tent » asks the island what only it knows (src-tauri/src/voice): the
// pills, to add or remove one (Claude Code's is always there), and the user's
// own data for Claude to answer from. Port of the Mac's VoiceTools pills and
// service_info.

import { invoke } from "@tauri-apps/api/core";
import { IS_TAURI, onEvent } from "../core/bridge";
import { AppsBridge, Feed, type AppInfo } from "../core/apps";
import { MAIN_PILL, pillDefinition, registryPills } from "../core/pills";
import { Spotify } from "../core/spotify";
import { State } from "../core/state";
import { serviceCards } from "./service-cards";

interface Ask {
  id: number;
  kind: "pills" | "info";
  input: { action?: string; names?: string[] };
}

const norm = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** The apps a pill can be asked for: every app of the registry with a pill of its own. */
const apps = (): AppInfo[] => Feed.apps.filter((a) => a.pill !== MAIN_PILL);

/**
 * The pill a spoken name means: Claude Code's (MAIN_PILL), or the registry id
 * of an app. Exact, then the start, then anywhere in it.
 */
export function findPill(name: string): string | null {
  const wanted = norm(name);
  if (!wanted) return null;
  const main = pillDefinition(MAIN_PILL)!;
  const pills = [{ id: MAIN_PILL, name: main.name }, ...apps().map((a) => ({ id: a.id, name: a.name }))];
  const hit =
    pills.find((p) => norm(p.name) === wanted || norm(p.id.replace(/^integration_/, "")) === wanted) ??
    pills.find((p) => norm(p.name).startsWith(wanted)) ??
    pills.find((p) => norm(p.name).includes(wanted) || wanted.includes(norm(p.name)));
  return hit?.id ?? null;
}

function describe(): string {
  return JSON.stringify({
    main: pillDefinition(MAIN_PILL)!.name,
    shown: registryPills(Feed.apps).map((p) => p.name),
    available: apps().map((a) => a.name),
  });
}

function pills(input: Ask["input"]): string {
  const action = input.action ?? "list";
  if (action === "list") return describe();
  const names = input.names ?? [];
  const done: string[] = [];
  const failed: string[] = [];
  for (const spoken of names) {
    const id = findPill(spoken);
    if (!id) {
      failed.push(`${spoken}: unknown pill`);
      continue;
    }
    if (id === MAIN_PILL) {
      if (action === "add") done.push(pillDefinition(MAIN_PILL)!.name);
      else failed.push(`${pillDefinition(MAIN_PILL)!.name}: Claude Code's pill is always there`);
      continue;
    }
    const app = Feed.app(id)!;
    const want = action === "add";
    if (app.shown !== want) {
      // The registry is the one place it is kept (apps.rs); the island follows
      // its next snapshot, and is told now so the answer says what is shown.
      app.shown = want;
      void AppsBridge.setHidden(id, !want);
    }
    done.push(app.name);
  }
  if (done.length) State.syncPills();
  return JSON.stringify({ done, failed, now: JSON.parse(describe()) });
}

function info(): string {
  const sessions = State.tasks
    .filter((t) => !t.isIntegration || t.state !== "idle" || t.steps.length > 0)
    .map((t) => ({ pill: t.name, state: t.state, doing: t.steps[t.stepIndex] ?? t.steps[t.steps.length - 1] ?? null }));
  const plan = (p: typeof State.planUsage) =>
    p && {
      fiveHourPercent: p.fiveHour?.usedPct ?? null,
      weekPercent: p.sevenDay?.usedPct ?? null,
    };
  const s = Spotify.state;
  return JSON.stringify({
    pills: JSON.parse(describe()),
    sessions,
    claudePlan: plan(State.planUsage),
    spotify: s.running && s.track ? { playing: s.playing, title: s.track.title, artist: s.track.artist } : null,
    services: serviceCards().map((c) => ({ service: c.title, headline: c.headline, about: c.reason, items: c.items })),
  });
}

export function registerVoiceHandlers() {
  if (!IS_TAURI) return;
  void onEvent<Ask>("voice-ask", (ask) => {
    let text: string;
    try {
      text = ask.kind === "pills" ? pills(ask.input ?? {}) : info();
    } catch (err) {
      text = `error: ${String(err)}`;
    }
    void invoke("voice_done", { id: ask.id, text }).catch(() => {});
  });
}
