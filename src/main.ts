// Entry point: boot the bridge, wire the island, start the greeting.

import "./style.css";
import { Bridge, IS_TAURI, onEvent } from "./core/bridge";
import { Sound } from "./core/sound";
import { State, type Settings } from "./core/state";
import { Island } from "./island/island";
import { registerHookHandlers } from "./island/hooks";
import { registerIntegrationHandlers, refreshConfigured, refreshHookPills } from "./island/integrations";
import { registerShortcutHandlers } from "./island/shortcuts";
import { registerVoiceHandlers } from "./island/voice";
import { registerVoiceSay } from "./island/voice-say";
import { applySpotify, registerSpotifyHandlers } from "./island/spotify";
import { SPOTIFY_ID } from "./core/spotify";
import { AppsBridge, Feed, pillOfApp, type AppNotification, type AppsSnapshot } from "./core/apps";
import { Recap } from "./recap/recap";
import { Today, TodayBridge, type TodayState } from "./core/today";
import { onLanguageChange, resolveLanguage, setLanguage, systemLanguages } from "./i18n/i18n";

/** Shows the language Settings asks for ("" = the system's, when winotch has it). */
function applyLanguage() {
  setLanguage(resolveLanguage(State.settings.language, systemLanguages()));
}

async function main() {
  const root = document.getElementById("root");
  if (!root) return;

  void Sound.preload();

  // Before the island exists: its canvases size their bitmaps from the pixel
  // ratio once, so the zoom correction has to land first. If zoom was adjusted,
  // wait until the ratio updates (or up to 500ms) so nothing is sized against
  // the stale value.
  const dprBefore = window.devicePixelRatio || 1;
  const zoomChanged = await Bridge.fitZoom(dprBefore);
  if (zoomChanged) {
    for (let i = 0; i < 20 && window.devicePixelRatio === dprBefore; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  const island = new Island(root);

  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
    State.appVersion = boot.version;
  }
  // A language change redraws the island in place: the texts given as tl(…)
  // relabel themselves (views/dom.ts) and the views redraw the rest on this
  // sync. Nothing is rebuilt, so tasks, steps and the chat stay as they are.
  onLanguageChange(() => State.notify());
  applyLanguage();
  // Rust shows the tray and its errors in the same language as the webview.
  void Bridge.setSystemLanguages(systemLanguages());
  island.applySettings();
  // Claude Code's pill now; the apps' pills come with the registry below.
  State.syncPills();
  if (boot && !boot.cursorPoll) island.followPageCursor();

  await onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onCursor(x, y));
  await onEvent<boolean>("pointer-inside", (inside) => island.setPointerInside(inside));
  // The pointer on the hidden island's strip, seen by Rust (island.rs): wakes it
  // even when the strip's own mouseenter never fired.
  await onEvent("strip-hover", () => island.stripHover());
  // The tray, winotch opened again, a link from Flow: the settings, in the island.
  await onEvent<string>("open-settings", (page) => island.openSettings(page || "general"));

  /** Pause has to reach Rust too, or the pollers keep calling out. */
  const setPaused = (on: boolean) => {
    if (State.paused === on) return;
    State.paused = on;
    void Bridge.setPaused(on);
  };

  await onEvent<string>("tray", (what) => {
    switch (what) {
      // "settings" opens the settings window from Rust (tray.rs).
      case "open":
        setPaused(false);
        island.alert(State.defaultView());
        break;
      case "recap":
        setPaused(false);
        void Recap.open(island);
        break;
      case "pause":
        setPaused(!State.paused);
        if (State.paused) island.fsm.forceHidden();
        else island.reveal();
        break;
    }
  });

  const checkZoom = async () => {
    const dpr = window.devicePixelRatio || 1;
    await Bridge.fitZoom(dpr);
  };

  await onEvent<null>("screen-changed", async () => {
    await checkZoom();
    void Bridge.reposition();
  });

  const mediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  mediaQuery.addEventListener?.("change", () => void checkZoom());

  window.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey) e.preventDefault();
    },
    { passive: false }
  );
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && (e.key === "+" || e.key === "-" || e.key === "=" || e.key === "0")) {
      e.preventDefault();
    }
  });

  // Settings → Reload sounds: read the sounds folder again, and let them hear it.
  await onEvent<null>("sounds-changed", () => {
    void Sound.reload().then(() => Sound.play("pop"));
  });

  // winotch: the one registry of apps (src-tauri/src/apps.rs), the feed of
  // their notifications and their lists. The pills follow it.
  const applyApps = (snapshot: AppsSnapshot) => {
    Feed.set(snapshot);
    State.syncPills();
    refreshConfigured();
    State.notify();
  };
  const apps = await AppsBridge.snapshot();
  if (apps) applyApps(apps);
  await onEvent<AppsSnapshot>("apps", applyApps);
  // winotch: Today's to-dos and notes (src-tauri/src/today.rs), whole on
  // every change, Claude Code's included.
  Today.set(await TodayBridge.state());
  await onEvent<TodayState>("today", (s) => {
    Today.set(s);
    State.notify();
  });
  // Claude Code opened a session in the chat (winotch_open_session).
  await onEvent<string>("open-chat-session", (id) => island.openChatSession(id));
  // Said with Shift and the dictation key: asked of Claude Code, the answer in the notch.
  await onEvent<string>("flow-ask", (text) => island.ask(text));
  // Something new: important news opens the feed; the rest peeks the island and
  // the mark's dot pulses. Low importance waits quietly behind the bell.
  const news = (n: AppNotification) => {
    // While the island is open on the chat, news waits behind the bell: no
    // flash, no peek, and the feed never takes the chat's place.
    if (State.chatting) return;
    // The compact notch's bell becomes the app's logo for a moment.
    State.flashLogo(pillOfApp(n.app), Feed.app(n.app)?.name ?? n.app);
    // A Claude Code request waiting for an answer always keeps the island: the
    // news waits behind the bell, and the dot pulses once.
    if (State.pendingApproval) {
      island.emote("happy");
      return;
    }
    if (n.importance === "high") island.alert("notifications");
    else if (n.importance === "normal") {
      island.reveal();
      island.emote("happy");
    }
  };
  await onEvent<AppNotification>("notification", (n) => {
    if (State.paused) return;
    // Over an answer being said in the island, it comes once that is over.
    State.afterSay(() => news(n));
  });

  // The settings window writes preferences; apply them here without a restart.
  await onEvent<Settings>("settings-changed", (s) => {
    State.settings = { ...State.settings, ...s };
    applyLanguage();
    island.applySettings();
    void refreshHookPills();
  });

  registerHookHandlers(island);
  registerIntegrationHandlers(island);
  registerShortcutHandlers(island, () => setPaused(false));
  registerVoiceHandlers();
  // OK Tent's answers are said out loud here (they were the Flow pill's).
  registerVoiceSay();
  registerSpotifyHandlers(island);
  // Rust may have read Spotify before this page listened: ask once.
  if (State.isKept(SPOTIFY_ID)) {
    void Bridge.spotifyRefresh().then((s) => s && applySpotify(island, s));
  }

  // Monday recap: app start (greeting over), an agent starting work, waking up.
  const checkRecap = () => void Recap.check(island);
  island.onGreetingDone = () => {
    // The first start: Get started, once (settings.rs `welcomed`).
    if (IS_TAURI && !State.settings.welcomed) {
      State.settings = { ...State.settings, welcomed: true };
      void Bridge.saveSettings(State.settings);
      island.openSettings("welcome");
      return;
    }
    checkRecap();
  };
  island.onWake = checkRecap;
  await onEvent<null>("recap-check", checkRecap);

  island.launch();

  // In a plain browser there is no wake strip behind the cursor: make the whole
  // page wake the island so the visuals can be checked with `npm run dev`.
  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
  }
}

void main();
