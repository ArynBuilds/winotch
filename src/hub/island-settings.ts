// The island's settings as the winotch window holds them: read at boot, saved
// on every change, and kept up to date when the island changes them (the
// settings-changed event). General, Claude Code and Apps all edit this one copy.

import { Bridge, onEvent } from "../core/bridge";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";

let current: Settings = { ...DEFAULT_SETTINGS };
const listeners = new Set<(s: Settings) => void>();

export const IslandSettings = {
  get value(): Settings {
    return current;
  },

  /** The settings as boot read them. */
  load(s: Partial<Settings>) {
    current = { ...current, ...s };
  },

  /** Changes them and saves at once. */
  async update(change: (s: Settings) => void) {
    const next = { ...current };
    change(next);
    current = next;
    await Bridge.saveSettings(current);
  },

  /** Told whenever they change elsewhere (the island, a shortcut). */
  onChange(listener: (s: Settings) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

void onEvent<Settings>("settings-changed", (s) => {
  current = { ...current, ...s };
  for (const l of listeners) l(current);
});
