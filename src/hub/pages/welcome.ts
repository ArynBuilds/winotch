// Get started: what to set up first, each with where it is done. Shown once by
// itself at the first start (main.ts), then one page among the others. Nothing
// is changed from here but the Claude Code tools, which are one click anyway;
// the rest opens its own page, where the change is shown before it is made.

import { h } from "../../views/dom";
import { t } from "../../i18n/i18n";
import { Bridge } from "../../core/bridge";
import type { HubContext } from "../shell";
import { button, keyLabel, pageHead, row, section } from "../ui";

export async function welcomePage(page: HTMLElement, ctx: HubContext) {
  page.classList.add("narrow");
  page.append(pageHead(t("Get started")));
  const redraw = () => ctx.navigate("welcome");
  const [hooks, mcp] = await Promise.all([Bridge.hooksStatus(), Bridge.mcpStatus()]);

  // ── Claude Code ──
  const connected = hooks?.installed ?? false;
  const tools = mcp?.current ?? false;
  const note = h("div", { class: "hub-review hub-note" });
  const add = button(t("Add to Claude Code"), () => {
    add.disabled = true;
    Bridge.mcpInstall().then(redraw, (err) => {
      add.disabled = false;
      note.textContent = t("Could not add: {error}", { error: String(err).replace(/^Error:\s*/, "") });
    });
  }, "primary", true);
  if (mcp && (!mcp.relayReady || !mcp.claudeFound)) add.disabled = true;
  page.append(section("Claude Code", [
    row(t("Sessions in the island"),
      connected ? t("Connected") : t("Every prompt, edit and command live, and approvals from here."),
      connected ? null : button(t("Set up…"), () => ctx.navigate("claude"), "primary", true)),
    row(t("Tools for Claude Code"),
      tools ? t("Added") : t("Claude reads your feed and mail, keeps your to-dos, drafts for you."),
      tools ? null : add),
    note,
  ], mcp && !mcp.claudeFound ? t("Claude Code (`claude`) was not found. Install it, then come back here.") : null));

  // ── Apps ──
  page.append(section(t("Apps"), [
    row("GitHub, Gmail, Spotify, Notion, Stripe", t("Turn on the ones you use."),
      button(t("Choose…"), () => ctx.navigate("apps"), "", true)),
    row(t("Today"), t("To-dos and notes, ready now."), null),
  ], t("Your own apps can join too, through the local API.")));

  // ── Voice ──
  const prefs = ctx.status.prefs;
  page.append(section(t("Voice"), [
    row(t("Dictation"),
      prefs.enabled ? t("Hold {key} anywhere and speak.", { key: keyLabel(prefs.key, ctx.status.platform) }) : t("Off"),
      button(prefs.enabled ? t("Settings") : t("Turn on…"), () => ctx.navigate("dictation", "settings"), "", true)),
    row("« OK Tent »", prefs.voice ? t("Listening") : t("Off"),
      button(t("Settings"), () => ctx.navigate("voice"), "", true)),
  ], t("Speech is recognised on this computer. The voice model is downloaded once.")));
}
