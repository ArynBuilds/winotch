// An API key in a settings row: a field and Save while there is none, then
// "Saved" and Remove. The key itself never comes back to the page; it lives in
// the system's credential store (secrets.rs).

import { h, clear } from "../views/dom";
import { t } from "../i18n/i18n";
import { button } from "./ui";

export interface KeyStore {
  placeholder: string;
  isSet(): Promise<boolean>;
  save(value: string): Promise<unknown>;
  remove(): Promise<unknown>;
  /** Called once the key was saved or removed. */
  changed?(isSet: boolean): void;
}

export function keyField(store: KeyStore): HTMLElement {
  const box = h("div", { class: "hub-key" });
  const draw = async () => {
    const present = await store.isSet().catch(() => false);
    clear(box);
    if (present) {
      box.append(
        h("span", { class: "hub-note", text: `✓ ${t("Saved")}` }),
        button(t("Remove"), () => void store.remove().then(() => {
          store.changed?.(false);
          return draw();
        }), "", true),
      );
      return;
    }
    const input = h("input", {
      class: "hub-input", type: "password", placeholder: store.placeholder, autocomplete: "off", spellcheck: "false",
    }) as HTMLInputElement;
    const save = button(t("Save"), () => {
      const value = input.value.trim();
      if (!value) return;
      void store.save(value).then(() => {
        store.changed?.(true);
        return draw();
      }, () => input.classList.add("err"));
    }, "primary", true);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") save.click();
    });
    box.append(input, save);
  };
  void draw();
  return box;
}
