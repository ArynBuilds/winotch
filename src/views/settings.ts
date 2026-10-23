// Every setting, inside the island (WINOTCH.md "Settings in the notch"): the
// gear grows the notch to SETTINGS_W × 560 around the settings' sidebar and
// pages (hub/shell.ts). Back, Esc or a click outside returns to the island.
// Drawn the first time they are opened, and drawn again each time they are, so
// what they show is never stale; their listeners stop while they are shut.

import { startHub, type HubHandle } from "../hub/shell";
import { welcomePage } from "../hub/pages/welcome";
import { generalPage } from "../hub/pages/general";
import { claudePage } from "../hub/pages/claude";
import { appsPage } from "../hub/pages/apps";
import { voicePage } from "../hub/pages/voice";
import { dictationPage } from "../hub/pages/dictation";
import { notesPage } from "../hub/pages/notes";
import { wordsPage } from "../hub/pages/words";
import { State } from "../core/state";
import { h } from "./dom";
import type { ViewActions, ViewHost } from "./views";

export interface SettingsHost extends ViewHost {
  /** Opens the settings on `page` (any name, old ones too); the island grows around them. */
  open(page: string): void;
}

export function buildSettingsView(actions: ViewActions, version: () => string): SettingsHost {
  const root = h("div", { class: "hub settings-host" });
  const el = h("div", { class: "view settingsview" }, root);
  let hub: HubHandle | null = null;
  let mounting: Promise<void> | null = null;
  let shown = false;
  /** The page asked for while the settings were not drawn yet. */
  let asked = "general";

  const mount = () => {
    mounting ??= startHub(root, {
      version: version(),
      pages: {
        welcome: welcomePage,
        general: generalPage,
        claude: claudePage,
        apps: appsPage,
        voice: voicePage,
        dictation: dictationPage,
        notes: notesPage,
        words: wordsPage,
      },
      onBack: () => actions.setView("overview"),
    }, asked).then((handle) => {
      hub = handle;
    });
    return mounting;
  };

  return {
    el,
    sync() {
      const on = State.mode === "expanded" && State.view === "settings";
      if (on === shown) return;
      shown = on;
      if (on) {
        // The first time it draws the page asked for; then the page shown last, fresh.
        if (!hub) void mount();
        else hub.open(asked);
      } else {
        hub?.leave();
        if (hub) asked = hub.current();
      }
    },
    open(page: string) {
      asked = page;
      if (hub && shown) hub.open(page);
    },
  };
}
