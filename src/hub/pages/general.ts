// General: how the island behaves, its sound, the language, and the keyboard
// shortcuts that work from any app. Coucou's General and Shortcuts pages, cut
// to what is used.

import { h, clear } from "../../views/dom";
import { LANGUAGES, resolveLanguage, setLanguage, systemLanguages, t } from "../../i18n/i18n";
import { Bridge, onEvent, type ShortcutsReport } from "../../core/bridge";
import {
  SHORTCUTS, SHORTCUT_TEXT, activeKeys, displayKeys, duplicates, effective, recordPress, type Binding,
} from "../../core/shortcuts";
import type { HubContext } from "../shell";
import { IslandSettings } from "../island-settings";
import { button, pageHead, row, section, segmented, select, toggle } from "../ui";

const AUTO_CLOSE: [string, string][] = [["3", "3 s"], ["5", "5 s"], ["10", "10 s"]];

export async function generalPage(page: HTMLElement, ctx: HubContext) {
  page.classList.add("narrow");
  const s = IslandSettings.value;
  const save = (change: Parameters<typeof IslandSettings.update>[0]) => void IslandSettings.update(change);
  page.append(pageHead(t("General")));

  // ── The island ──
  const screen = select<string>([["primary", t("Main display")], ["cursor", t("Display under the cursor")]], s.screen, (v) => save((x) => (x.screen = v)));
  void Bridge.listMonitors().then((list) => {
    for (const m of list ?? []) screen.append(h("option", { value: m.key, text: m.label }));
    // Set again now the option exists. A display saved under an older key (moved,
    // resized, or saved before names were kept) is found by its place or its
    // name; one that is gone shows as the main one.
    const saved = s.screen;
    const [place, name] = saved.split("|");
    const keys = (list ?? []).map((m) => m.key);
    screen.value =
      keys.find((k) => k === saved) ??
      (saved.startsWith("at:") ? keys.find((k) => k.split("|")[0] === place) : undefined) ??
      (name ? keys.find((k) => k.split("|")[1] === name) : undefined) ??
      saved;
    if (!screen.value) screen.value = "primary";
  });
  const closeAfter = String(AUTO_CLOSE.some(([v]) => Number(v) === s.autoCloseInterval) ? s.autoCloseInterval : 3);
  page.append(section(null, [
    row(t("Open on hover"), null, toggle(s.openOnHover, (on) => save((x) => (x.openOnHover = on)))),
    row(t("Auto-close"), null, segmented(AUTO_CLOSE, closeAfter, (v) => save((x) => (x.autoCloseInterval = Number(v))))),
    row(t("Island lives on"), null, screen),
  ]));

  // ── Sound ──
  const volume = h("input", { type: "range", min: "0", max: "0.2", step: "0.005", value: String(s.soundVolume), class: "hub-range" }) as HTMLInputElement;
  volume.addEventListener("input", () => save((x) => (x.soundVolume = Number(volume.value))));
  const volumeRow = row(t("Volume"), null, volume);
  volumeRow.style.display = s.soundEnabled ? "" : "none";
  page.append(section(t("Sound"), [
    row(t("Sound"), null, toggle(s.soundEnabled, (on) => {
      save((x) => (x.soundEnabled = on));
      volumeRow.style.display = on ? "" : "none";
    })),
    volumeRow,
  ]));

  // ── Starting ──
  const language = select<string>(
    [["", t("System")], ...LANGUAGES.map(({ code, name }): [string, string] => [code, name])],
    LANGUAGES.some((l) => l.code === s.language) ? s.language : "",
    (code) => {
      save((x) => (x.language = code));
      setLanguage(resolveLanguage(code, systemLanguages()));
    },
  );
  page.append(section(null, [
    row(t("Launch at startup"), null, toggle(s.autostart, (on) => save((x) => (x.autostart = on)))),
    row(t("Language"), null, language),
  ]));

  // ── Shortcuts ──
  page.append(shortcutsSection(await Bridge.shortcutsStatus(), ctx));
}

// ── Shortcuts ────────────────────────────────────────────────────────────────

/** A shortcut that can't work as set: why, in a word or two. */
function problem(id: string, report: ShortcutsReport | null, dups: Set<string>): string | null {
  if (dups.has(id)) return t("Used twice");
  const st = report?.actions.find((a) => a.id === id);
  switch (st?.status) {
    case "inUse": return t("In use by another app");
    case "duplicate": return t("Used twice");
    case "invalid": return t("Not a valid shortcut");
    case "typesCharacter": return t("Types “{char}”", { char: st.typed ?? "?" });
    case "unsupported": return t("Not available");
    case "refused": return t("Not set by your desktop");
    default: return null;
  }
}

function shortcutsSection(initial: ShortcutsReport | null, ctx: HubContext): HTMLElement {
  let report = initial;
  const host = h("div", {});
  const feedback = h("div", { class: "foot" });
  let stopRecording: (() => void) | null = null;

  const store = (id: string, binding: Binding) =>
    void IslandSettings.update((x) => (x.shortcuts = { ...x.shortcuts, [id]: binding }));

  function record(id: string, binding: Binding, keycap: HTMLButtonElement) {
    stopRecording?.();
    feedback.textContent = "";
    keycap.classList.add("recording");
    keycap.textContent = t("Press keys…");
    void Bridge.shortcutsSuspend(true);

    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const result = recordPress(e);
      switch (result.kind) {
        case "pending":
          return;
        case "keys":
          finish();
          store(id, { keys: result.keys, enabled: true });
          return;
        case "clear":
          finish();
          store(id, { keys: "", enabled: binding.enabled });
          return;
        case "typesCharacter":
          finish();
          feedback.textContent = t("{keys} types “{char}” on your keyboard, so it can't be a shortcut. Pick another key.", { keys: displayKeys(result.keys), char: result.typed });
          return;
        case "needsModifier":
          feedback.textContent = t("Hold Ctrl, Alt or the Windows key with it.");
          return;
        case "unsupported":
          feedback.textContent = t("That key can't be used in a shortcut.");
          return;
        case "cancel":
          finish();
          return;
      }
    };
    const onBlur = () => finish();
    function finish() {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      stopRecording = null;
      // Takes the global shortcuts back, from what is saved by now.
      void Bridge.shortcutsSuspend(false);
      draw();
    }
    stopRecording = finish;
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
  }

  function draw() {
    const settings = IslandSettings.value;
    const dups = duplicates(activeKeys(settings.shortcuts));
    const rows: HTMLElement[] = [];
    for (const d of SHORTCUTS) {
      if (!d.ported) continue;
      const binding = effective(d, settings.shortcuts);
      const keycap = h("button", { class: "hub-keycap button", text: binding.keys ? displayKeys(binding.keys) : t("None") }) as HTMLButtonElement;
      keycap.disabled = !binding.enabled;
      keycap.addEventListener("click", () => record(d.id, binding, keycap));
      const issue = binding.enabled ? problem(d.id, report, dups) : null;
      const r = row(t(SHORTCUT_TEXT[d.id]), issue, keycap, toggle(binding.enabled, (on) => store(d.id, { keys: binding.keys, enabled: on })));
      if (!binding.enabled) r.classList.add("off");
      rows.push(r);
    }
    rows.push(h("div", { class: "hub-row" }, h("span", { style: "flex:1" }), button(t("Reset to defaults"), () => {
      stopRecording?.();
      void IslandSettings.update((x) => (x.shortcuts = {})).then(draw);
    }, "", true)));
    const blocked = report?.blocked ? t("No display server was found, so global shortcuts are off.") : null;
    const fresh = section(t("Keyboard shortcuts"), rows, blocked ?? t("Click a shortcut, then press the new keys. Backspace removes it."));
    fresh.append(feedback);
    clear(host);
    host.append(fresh);
  }

  draw();
  // Only while the page is open: its own listeners, gone when it is left.
  const off = IslandSettings.onChange(() => {
    if (!stopRecording) draw();
  });
  let unlisten: (() => void) | null = null;
  void onEvent<ShortcutsReport>("shortcuts-status", (fresh) => {
    report = fresh;
    if (!stopRecording) draw();
  }).then((u) => (unlisten = u));
  const before = ctx.onLeave;
  ctx.onLeave = () => {
    before?.();
    stopRecording?.();
    off();
    unlisten?.();
  };
  return host;
}
