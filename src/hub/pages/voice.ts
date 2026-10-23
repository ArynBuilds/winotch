// « OK Tent »: say it, then ask anything. Turning it on, and how winotch
// answers out loud. Port of the Mac's Settings → Voice.

import { h, clear } from "../../views/dom";
import { t } from "../../i18n/i18n";
import { Bridge } from "../../core/bridge";
import type { VoiceOutput } from "../../core/flow";
import type { HubContext } from "../shell";
import { button, pageHead, row, section, segmented, toggle } from "../ui";
import { needsSpeechModel } from "./speech";

const ELEVEN = "elevenlabs-api-key";

function elevenKey(): HTMLElement {
  const box = h("div", { style: "display:flex;align-items:center;gap:8px" });
  const draw = async () => {
    const present = (await Bridge.secretPresent(ELEVEN)) ?? false;
    clear(box);
    if (present) {
      box.append(
        h("span", { class: "hub-note", text: `✓ ${t("Saved")}` }),
        button(t("Remove"), () => void Bridge.secretClear(ELEVEN).then(draw), "", true),
      );
      return;
    }
    const input = h("input", { class: "hub-input", type: "password", placeholder: t("ElevenLabs key"), autocomplete: "off", spellcheck: "false", style: "width:220px" }) as HTMLInputElement;
    const save = button(t("Save"), () => {
      const value = input.value.trim();
      if (!value) return;
      void Bridge.secretSet(ELEVEN, value).then(draw, () => input.classList.add("err"));
    }, "primary", true);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") save.click();
    });
    box.append(input, save);
  };
  void draw();
  return box;
}

export async function voicePage(page: HTMLElement, ctx: HubContext) {
  page.classList.add("narrow");
  const status = await ctx.refresh();
  const prefs = status.prefs;
  page.append(pageHead("OK Tent"));

  const needsKey = prefs.voice && !status.hasClaudeKey
    ? row(t("Needs your Claude API key"), null, button(t("Add it"), () => ctx.navigate("claude"), "", true))
    : null;
  needsKey?.classList.add("needs");
  page.append(section(null, [
    row(t("Listen for « OK Tent »"), t("Then ask anything: music, the weather, an email to prepare."),
      toggle(prefs.voice, (on) => void ctx.setPrefs((p) => (p.voice = on)).then(() => ctx.navigate("voice")))),
    prefs.voice && needsSpeechModel(ctx),
    needsKey,
  ], t("Your voice stays on this computer. Only what follows « OK Tent » goes to Claude.")));

  const outputs: [VoiceOutput, string][] = [["system", t("System voice")], ["elevenlabs", "ElevenLabs"], ["off", t("Text only")]];
  const eleven = prefs.voiceOutput === "elevenlabs";
  page.append(section(t("Answers"), [
    row(t("Answers out loud"), null, segmented(outputs, prefs.voiceOutput, (v) => void ctx.setPrefs((p) => (p.voiceOutput = v)).then(() => ctx.navigate("voice")))),
    eleven && row(t("Voice"), null, segmented([["female", t("Female")], ["male", t("Male")]], prefs.voiceGender, (g) => void ctx.setPrefs((p) => (p.voiceGender = g)))),
    eleven && row(t("ElevenLabs key"), null, elevenKey()),
  ]));
}
