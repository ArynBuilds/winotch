// Claude Code: everything winotch does with it. Its sessions in the island
// (the hooks), the plan usage gauge (the status line relay), the one Claude
// API key the clean-up, the Notetaker and « OK Tent » share, the weekly recap,
// and winotch's tools in Claude Code (MCP). Anything that writes to
// ~/.claude/settings.json shows the exact change first and is only written on
// an explicit click; the tools are added by Claude Code's own `claude mcp add`,
// also only on a click.

import { h, clear } from "../../views/dom";
import { t } from "../../i18n/i18n";
import { Bridge, type HookPreview, type HookStatus, type McpStatus } from "../../core/bridge";
import type { HubContext } from "../shell";
import { IslandSettings } from "../island-settings";
import { keyField } from "../keys";
import { button, pageHead, row, section, select, toggle } from "../ui";

const CLAUDE_KEY = "anthropic-api-key";

const MODELS: [string, string][] = [
  ["claude-opus-5", "Claude Opus 5"],
  ["claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-haiku-4-5", "Claude Haiku 4.5"],
];

/** One kind of change to ~/.claude/settings.json, with the words that go with it. */
interface Change {
  preview: (install: boolean) => Promise<HookPreview | null>;
  apply: (install: boolean, fingerprint: string) => Promise<string | null>;
  installText: string;
  removeText: string;
  /** The note once written; `backup` is "" when there was no file to back up. */
  done: (backup: string) => string;
}

const HOOKS_CHANGE: Change = {
  preview: Bridge.hooksPreview,
  apply: Bridge.hooksApply,
  get installText() { return t("This is exactly what will change in your settings.json. Your own hooks are left untouched."); },
  get removeText() { return t("This removes winotch's entries only. Your own hooks are left untouched."); },
  done: (backup) => backup
    ? t("Done. Previous settings saved as {backup}. Open a new Claude Code session to pick the hooks up.", { backup })
    : t("Done. Open a new Claude Code session to pick the hooks up."),
};

const STATUS_LINE_CHANGE: Change = {
  preview: Bridge.statusLinePreview,
  apply: Bridge.statusLineApply,
  get installText() { return t("This is exactly what will change: only the status line. If you already have one it keeps working, winotch's relay runs it for you."); },
  get removeText() { return t("This puts your previous status line back, or removes the entry if there was none."); },
  done: (backup) => backup
    ? t("Done. Previous settings saved as {backup}. The numbers appear after the next reply of a Claude Code session.", { backup })
    : t("Done. The numbers appear after the next reply of a Claude Code session."),
};

function renderDiff(text: string): HTMLElement {
  const box = h("div", { class: "hub-diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    box.append(h("div", { class: cls, text: line }));
  }
  return box;
}

/**
 * Shows the change in `panel` and writes it only after an explicit click, and
 * only if settings.json still matches what was shown. `back` puts the section
 * back; `applied` runs a moment after a successful write.
 */
async function review(panel: HTMLElement, change: Change, install: boolean, back: () => void, applied: () => void) {
  let preview: HookPreview | null;
  try {
    preview = await change.preview(install);
  } catch (err) {
    // An unreadable settings.json stops here rather than being treated as
    // empty and written over.
    clear(panel);
    panel.append(h("div", { class: "hub-warn", text: String(err).replace(/^Error:\s*/, "") }), h("div", { class: "hub-row" }, button(t("Back"), back, "", true)));
    return;
  }
  if (!preview) return;
  const fingerprint = preview.fingerprint;
  clear(panel);
  const confirm = button(install ? t("Back up and write") : t("Back up and remove"), () => {
    confirm.disabled = true;
    change.apply(install, fingerprint).then((backup) => {
      clear(panel);
      panel.append(h("div", { class: "hub-note", text: change.done(backup ?? "") }));
      window.setTimeout(applied, 2600);
    }, (err) => {
      confirm.disabled = false;
      panel.append(h("div", { class: "hub-warn", text: t("Could not write: {error}", { error: String(err) }) }));
    });
  }, install ? "primary" : "danger", true);
  panel.append(
    h("div", { class: "hub-note", text: install ? change.installText : change.removeText }),
    renderDiff(preview.diff),
    h("div", { class: "hub-row" },
      h("span", { class: "hub-note", style: "flex:1", text: preview.backup ? t("Backup → {path}", { path: preview.backup }) : t("No settings.json yet — nothing to back up.") }),
      button(t("Cancel"), back, "", true),
      confirm,
    ),
  );
}

const EMPTY_STATUS: HookStatus = { installed: false, planRelayInstalled: false, settingsPath: "", hookPath: "", hookReady: false };

export async function claudePage(page: HTMLElement, ctx: HubContext) {
  page.classList.add("narrow");
  page.append(pageHead("Claude Code"));
  const status: HookStatus = (await Bridge.hooksStatus()) ?? EMPTY_STATUS;
  const redraw = () => ctx.navigate("claude");

  // ── Sessions in the island (the hooks) ──
  const panel = h("div", { class: "hub-review" });
  const hooksButton = status.installed
    ? button(t("Uninstall hooks…"), () => void review(panel, HOOKS_CHANGE, false, redraw, redraw), "", true)
    : button(t("Install hooks…"), () => void review(panel, HOOKS_CHANGE, true, redraw, redraw), "primary", true);
  // Hook commands pointing at a relay that isn't there would give every
  // session a broken hook and nothing to show for it.
  if (!status.installed && !status.hookReady) hooksButton.disabled = true;
  page.append(section(null, [
    row(t("Sessions in the island"), status.installed ? t("Connected") : t("Not connected"), hooksButton),
    panel,
  ], !status.hookReady ? t("winotch-hook.exe is not in place yet. Restart winotch; if it still fails, build it with `cargo build -p winotch-hook`.") : null));

  // ── Plan usage (the status line relay) ──
  const planPanel = h("div", { class: "hub-review" });
  const plan = toggle(IslandSettings.value.showPlanInNotch, (on) => {
    if (!on) {
      void IslandSettings.update((x) => (x.showPlanInNotch = false));
    } else if (status.planRelayInstalled) {
      void IslandSettings.update((x) => (x.showPlanInNotch = true));
    } else {
      // Turned on before the relay is in: install it first; it stays on once confirmed.
      void review(planPanel, STATUS_LINE_CHANGE, true, redraw, () => {
        void IslandSettings.update((x) => {
          x.planRelayInstalled = true;
          x.showPlanInNotch = true;
        }).then(redraw);
      });
    }
  });
  page.append(section(t("Plan usage"), [
    row(t("Show plan usage in the island"), null, plan),
    status.planRelayInstalled && row(t("Status line relay"), null,
      button(t("Uninstall relay…"), () => void review(planPanel, STATUS_LINE_CHANGE, false, redraw, () => {
        void IslandSettings.update((x) => {
          x.planRelayInstalled = false;
          x.showPlanInNotch = false;
        }).then(redraw);
      }), "", true)),
    planPanel,
  ], t("Pro and Max plans, from Claude Code in a terminal.")));

  // ── The Claude API key ──
  page.append(section(t("Claude API key"), [
    row(t("API key"), null, keyField({
      placeholder: "sk-ant-…",
      isSet: async () => (await Bridge.secretPresent(CLAUDE_KEY)) ?? false,
      save: (v) => Bridge.secretSet(CLAUDE_KEY, v),
      remove: () => Bridge.secretClear(CLAUDE_KEY),
      changed: () => void ctx.refresh(),
    })),
    row(t("Model"), null, select(
      MODELS.some(([id]) => id === IslandSettings.value.model) ? MODELS : [...MODELS, [IslandSettings.value.model, IslandSettings.value.model]],
      IslandSettings.value.model,
      (model) => void IslandSettings.update((x) => (x.model = model)),
    )),
  ], t("For dictation clean-up, call summaries and « OK Tent ».")));

  // ── Weekly recap ──
  const recap = toggle(true, (on) => void Bridge.recapSetEnabled(on));
  void Bridge.recapPrefs().then((prefs) => {
    if (prefs) recap.classList.toggle("on", prefs.enabled);
  });
  const clearRecap = button(t("Clear history"), () => {
    clearRecap.disabled = true;
    void Bridge.recapClear().then(() => {
      clearRecap.textContent = t("History cleared.");
      window.setTimeout(() => {
        clearRecap.disabled = false;
        clearRecap.textContent = t("Clear history");
      }, 2400);
    });
  }, "", true);
  page.append(section(t("Weekly recap"), [
    row(t("Keep a history of my coding sessions"), null, recap),
    h("div", { class: "hub-row" }, h("span", { style: "flex:1" }), clearRecap),
  ], t("Counts and project names only — never commands, files or prompts. Kept on this computer for 12 weeks.")));

  // ── winotch's tools in Claude Code (MCP) ──
  page.append(await toolsSection(redraw));
}

/**
 * Notifications, mail drafts, Today and the sessions as Claude Code tools: one
 * click runs `claude mcp add` for every project, and the command is there to
 * copy for a terminal too.
 */
async function toolsSection(redraw: () => void): Promise<HTMLElement> {
  const mcp: McpStatus | null = await Bridge.mcpStatus();
  const note = h("div", { class: "hub-review hub-note" });
  const ready = mcp?.current ?? false;
  const add = button(mcp?.registered && !ready ? t("Update") : t("Add to Claude Code"), () => {
    add.disabled = true;
    note.textContent = "";
    Bridge.mcpInstall().then(() => {
      note.textContent = t("Done. Open a new Claude Code session to use winotch's tools.");
      window.setTimeout(redraw, 2600);
    }, (err) => {
      add.disabled = false;
      note.textContent = t("Could not add: {error}", { error: String(err).replace(/^Error:\s*/, "") });
    });
  }, "primary", true);
  if (mcp && (!mcp.relayReady || !mcp.claudeFound)) add.disabled = true;
  const remove = button(t("Remove"), () => {
    remove.disabled = true;
    Bridge.mcpRemove().then(redraw, (err) => {
      remove.disabled = false;
      note.textContent = String(err).replace(/^Error:\s*/, "");
    });
  }, "", true);
  const command = mcp?.command ?? "";
  const copy = button(t("Copy"), () => {
    void navigator.clipboard?.writeText(command);
    copy.textContent = t("Copied");
  }, "", true);
  const missing = mcp && !mcp.claudeFound ? t("Claude Code (`claude`) was not found. Install it, then come back here.") : null;
  return section(t("Tools for Claude Code"), [
    row(t("Notifications, mail drafts, Today and sessions"), ready ? t("Added") : mcp?.registered ? t("Points to another copy") : t("Not added"), ready ? remove : add),
    note,
    !!command && h("div", { class: "hub-row" }, h("code", { class: "hub-code", style: "flex:1", text: command }), copy),
  ], missing ?? t("Claude Code can read your feed and draft for you, but never press a button for you."));
}
