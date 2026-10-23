// The app logos on the overview's pills: each app's own logo (views/logo.ts),
// one per pill however many apps there are. While an app is busy or waiting
// its logo breathes, while music plays it nods; otherwise nothing moves.

import type { AgentTask } from "../core/state";
import type { BotStateName } from "../core/layout";
import { logoElement } from "./logo";

interface LiveLogo {
  el: Element;
  taskId: string;
  state: BotStateName;
  /** Asked every frame: whether this one dances (the music pill's). */
  dancing?: () => boolean;
  dance: number;
  /** Something moved last frame, so the shapes still need putting back. */
  moved: boolean;
}

const live = new Map<Element, LiveLogo>();
const BREATHING: ReadonlySet<BotStateName> = new Set(["working", "thinking", "searching", "approval", "question"]);
const t0 = performance.now();

/** The logo of `task` in a `size`-pixel slot. */
export function createAppLogo(task: AgentTask, size: number, dancing?: () => boolean): HTMLElement {
  const slot = document.createElement("span");
  slot.className = "app-logo";
  slot.style.width = `${size}px`;
  slot.style.height = `${size}px`;
  const el = logoElement(task.id, task.name, Math.round(size * 0.82));
  slot.append(el);
  live.set(el, { el, taskId: task.id, state: task.state, dancing, dance: 0, moved: false });
  return slot;
}

/** Drops every logo no longer in the document (views are rebuilt wholesale). */
export function pruneAppLogos() {
  for (const [el] of live) {
    if (!el.isConnected) live.delete(el);
  }
}

export function syncAppLogoStates(tasks: AgentTask[]) {
  for (const logo of live.values()) {
    const task = tasks.find((t) => t.id === logo.taskId);
    if (task) logo.state = task.state;
  }
}

export function tickAppLogos(dt: number) {
  const t = (performance.now() - t0) / 1000;
  for (const logo of live.values()) {
    const dancing = logo.dancing?.() ?? false;
    logo.dance = dancing ? Math.min(1, logo.dance + dt / 0.3) : Math.max(0, logo.dance - dt / 0.5);
    const breathing = BREATHING.has(logo.state);
    const moving = breathing || logo.dance > 0;
    if (!moving && !logo.moved) continue;
    const breath = breathing ? (1 - Math.cos((2 * Math.PI * t) / 1.2)) / 2 : 0;
    // At 112 beats a minute.
    const nod = Math.abs(Math.sin((Math.PI * t * 112) / 60)) * logo.dance;
    (logo.el as HTMLElement).style.transform = moving
      ? `translateY(${(-2.5 * nod).toFixed(2)}px) scale(${(1 + 0.08 * breath).toFixed(3)})`
      : "";
    logo.moved = moving;
  }
}
