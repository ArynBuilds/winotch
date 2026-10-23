// Gmail's rows on the Apps page: one block per account (its name, how it is
// doing, whether its new mail may open the island, Remove), then Add account.
// An account is saved only once Gmail accepted its app password: the form
// signs in first and says exactly why when it can't (core/mail.ts).

import { h, clear } from "../../views/dom";
import { t } from "../../i18n/i18n";
import { Bridge } from "../../core/bridge";
import { APP_PASSWORDS_URL, MailBridge, mailStatusLine, type MailAccount } from "../../core/mail";
import { button, row, toggle } from "../ui";

export function gmailAccounts(): { el: HTMLElement; dispose(): void } {
  const el = h("div", { class: "hub-accounts" });
  let accounts: MailAccount[] = [];
  let adding = false;
  /** Asked to remove: confirmed in place, as everywhere else. */
  let confirming: string | null = null;

  function accountBlock(a: MailAccount): HTMLElement {
    const name = a.label ?? a.email;
    const status = mailStatusLine(a);
    const remove = confirming === a.email
      ? h("div", { class: "hub-key" },
          button(t("Cancel"), () => { confirming = null; draw(); }, "", true),
          button(t("Remove"), () => {
            confirming = null;
            void MailBridge.removeAccount(a.email).then(load);
          }, "danger", true))
      : button(t("Remove"), () => { confirming = a.email; draw(); }, "", true);
    const block = h("div", { class: a.status === "error" ? "hub-account error" : "hub-account" },
      row(name, a.label ? `${a.email} · ${status}` : status, remove),
      row(t("Can open the island"), null, toggle(a.opensIsland, (on) => void MailBridge.setAccount(a.email, { opensIsland: on }))),
    );
    return block;
  }

  function addForm(): HTMLElement {
    const email = h("input", { class: "hub-input", type: "email", placeholder: t("Gmail address"), autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
    const label = h("input", { class: "hub-input", placeholder: t("Name (optional), e.g. Work"), autocomplete: "off" }) as HTMLInputElement;
    const password = h("input", { class: "hub-input", type: "password", placeholder: t("App password"), autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
    const error = h("div", { class: "foot hub-error" });
    const add = button(t("Add"), () => void submit(), "primary", true);
    const submit = async () => {
      if (!email.value.trim() || !password.value.trim()) return;
      add.disabled = true;
      add.textContent = t("Checking…");
      error.textContent = "";
      try {
        await MailBridge.addAccount(email.value.trim(), label.value.trim() || null, password.value);
        adding = false;
        await load();
      } catch (err) {
        // Gmail's reason, already in words for the user (mail.rs).
        error.textContent = String(err).replace(/^Error:\s*/, "");
        add.disabled = false;
        add.textContent = t("Add");
        password.select();
      }
    };
    for (const input of [email, label, password]) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void submit();
        if (e.key === "Escape") {
          // The form's cancel, not the island's back.
          e.preventDefault();
          adding = false;
          draw();
        }
      });
    }
    const help = h("button", { class: "hub-link", text: `${t("Create an app password")} ↗`, onclick: () => void Bridge.openUrl(APP_PASSWORDS_URL) });
    window.setTimeout(() => email.focus(), 0);
    return h("div", { class: "hub-account-form" },
      email, label, password,
      h("div", { class: "hub-row" }, help, h("span", { style: "flex:1" }),
        button(t("Cancel"), () => { adding = false; draw(); }, "", true), add),
      error,
    );
  }

  function draw() {
    clear(el);
    for (const a of accounts) el.append(accountBlock(a));
    if (adding) el.append(addForm());
    else el.append(h("div", { class: "hub-row" }, h("span", { style: "flex:1" }), button(t("Add account"), () => { adding = true; draw(); }, accounts.length ? "" : "primary", true)));
  }

  async function load() {
    accounts = (await MailBridge.accounts()) ?? [];
    draw();
  }

  void load();
  let off: (() => void) | null = null;
  void MailBridge.onAccounts((fresh) => {
    accounts = fresh;
    // Never redrawn under a form being typed in.
    if (!adding) draw();
  }).then((u) => (off = u));
  return { el, dispose: () => off?.() };
}
