// The speech model (Parakeet) that dictation, the Notetaker and « OK Tent »
// all listen with. It is set up in one place, Dictation → Settings; the other
// pages only say when it is missing and lead there.

import { h, clear } from "../../views/dom";
import { t } from "../../i18n/i18n";
import { onEvent } from "../../core/bridge";
import { FlowBridge, type ModelsStatus } from "../../core/flow";
import type { HubContext } from "../shell";
import { button, number, row } from "../ui";

/** Download / progress / installed, for the voice model. Redraws itself. */
export function modelsControl(ctx: HubContext, onReady?: () => void): HTMLElement {
  const el = h("div", { style: "display:flex;align-items:center;gap:8px" });
  let confirming = false;
  const draw = (models: ModelsStatus) => {
    clear(el);
    const m = models.parakeet;
    if (m.state === "missing") {
      el.append(button(t("Download"), () => void FlowBridge.download(), "primary"));
    } else if (m.state === "downloading") {
      const bar = h("div", { class: "hub-progress" }, h("i", { style: `width:${Math.round(m.fraction * 100)}%` }));
      el.append(bar, h("span", { class: "hub-note", text: `${Math.round(m.fraction * 100)} %` }));
    } else if (m.state === "failed") {
      el.append(h("span", { class: "hub-note", text: m.error, title: m.error, style: "max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }));
      el.append(button(t("Retry"), () => void FlowBridge.download()));
    } else if (confirming) {
      el.append(
        button(t("Remove the models"), () => {
          confirming = false;
          void FlowBridge.removeModels();
        }, "danger", true),
        button(t("Cancel"), () => {
          confirming = false;
          draw(ctx.status.models);
        }, "", true),
      );
    } else {
      const ok = h("button", { class: "hub-link", style: "color:var(--hub-green)", text: `✓ ${t("Installed")}`, title: t("Remove the models") });
      ok.addEventListener("click", () => {
        confirming = true;
        draw(ctx.status.models);
      });
      el.append(ok);
    }
  };
  draw(ctx.status.models);
  void onEvent<ModelsStatus>("speech-models", (models) => {
    if (!el.isConnected) return;
    const wasReady = ctx.status.models.parakeet.state === "ready";
    ctx.status.models = models;
    draw(models);
    if (!wasReady && models.parakeet.state === "ready") onReady?.();
  });
  return el;
}

/** The model's own row, with its size until it is downloaded. */
export function speechModelRow(ctx: HubContext, onReady?: () => void): HTMLElement {
  const missing = ctx.status.models.parakeet.state !== "ready";
  return row(
    t("Speech model"),
    missing ? t("On this computer, offline · about {0} MB", { 0: number(ctx.status.models.downloadMb) }) : null,
    modelsControl(ctx, onReady),
  );
}

/** On a page that needs the model while it is missing: one line, and the way to it. */
export function needsSpeechModel(ctx: HubContext): HTMLElement | null {
  if (ctx.status.models.parakeet.state === "ready") return null;
  const el = row(t("Needs the speech model"), null, button(t("Set up"), () => ctx.navigate("dictation", "settings"), "", true));
  el.classList.add("needs");
  return el;
}
