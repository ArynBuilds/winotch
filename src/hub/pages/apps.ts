// Apps: every app of the registry (src-tauri/src/apps.rs), in one list, each
// row drawn the same way: its logo, name and status line, and whether it is on
// the island. Open a row for the rest: whether it may open the island, what
// its setup needs as the app declares it (nothing, a key, accounts, a choice
// of sign-in), and Remove for the apps that joined through the local API. The
// page follows the registry: an app that joins shows at once.

import { h, clear } from "../../views/dom";
import { N_, t } from "../../i18n/i18n";
import { onEvent } from "../../core/bridge";
import { AppsBridge, Feed, type AppSetup, type AppsSnapshot, type KeySetup } from "../../core/apps";
import { AppList, appRows, type AppRow } from "../../core/app-list";
import { logoElement } from "../../views/logo";
import type { HubContext } from "../shell";
import { IslandSettings } from "../island-settings";
import { keyField } from "../keys";
import { gmailAccounts } from "./gmail-accounts";
import { button, icon, pageHead, row, section, segmented, toggle } from "../ui";

/** What a row needs from its page. */
export interface RowEnv {
  /** The rows opened, by app id: kept across redraws. */
  open: Set<string>;
  /** Draws the page again (after a change the snapshot does not carry). */
  redraw(): void;
  /** An app's accounts list (the `accounts` setup), kept across redraws. */
  accounts(appId: string): HTMLElement | null;
}

/** The labels of the sign-in modes an app may offer (English keys, shown with `t()`). */
const MODE_LABELS: Record<string, string> = { cli: N_("GitHub CLI"), token: N_("Token") };

function keyRow(r: AppRow, key: KeySetup): HTMLElement {
  return row(t(key.label), key.hint ? t(key.hint) : null, keyField({
    placeholder: key.placeholder,
    isSet: () => AppList.keyIsSet(r.id),
    save: (v) => AppList.saveKey(r.id, v),
    remove: () => AppList.removeKey(r.id),
  }));
}

/** A choice of sign-in, then the key in token mode only. Filled once the CLI answered. */
function signInRows(r: AppRow, setup: Extract<AppSetup, { kind: "signIn" }>, env: RowEnv): HTMLElement {
  const box = h("div", { class: "hub-app-signin" });
  void AppList.githubAuth().then((auth) => {
    clear(box);
    const cli = auth.cli;
    const who = cli?.signedIn && cli.login ? t("Signed in as {0}", { 0: cli.login }) : cli?.error ?? null;
    box.append(row(t("Sign in with"), who, segmented<"cli" | "token">(
      setup.modes.map((m) => [m, t(MODE_LABELS[m] ?? m)]),
      auth.mode,
      (mode) => void AppList.setGithubAuth(mode).then(env.redraw),
    )));
    // Signed in through the command line, there is no key to ask for.
    if (auth.mode === "token") box.append(keyRow(r, setup.key));
  });
  return box;
}

/** What the app declared its setup needs, the same way for every app. */
export function setupRows(r: AppRow, env: RowEnv): (HTMLElement | null)[] {
  const setup = r.setup;
  switch (setup.kind) {
    case "key":
      return [keyRow(r, setup)];
    case "signIn":
      return [signInRows(r, setup, env)];
    case "accounts":
      return [env.accounts(r.id)];
    default:
      return [];
  }
}

/** One app's block: its row, and its details when opened. */
export function appBlock(r: AppRow, env: RowEnv): HTMLElement {
  const head = row(r.name, r.status, toggle(r.shown, (on) => void AppList.setShown(r.id, on)));
  head.classList.add("hub-app");
  const logo = h("span", { class: "hub-app-logo" }, logoElement(r.logoId, r.name, 20));
  const chevron = h("span", { class: "hub-chevron" }, icon("chevron"));
  head.prepend(logo);
  head.querySelector(".text")?.after(chevron);

  const details = h("div", { class: "hub-app-details" });
  // Accounts each choose for themselves whether they may open the island.
  if (r.setup.kind !== "accounts") {
    details.append(row(t("Can open the island"), null, toggle(r.opensIsland, (on) => void AppList.setOpensIsland(r.id, on))));
  }
  for (const el of setupRows(r, env)) if (el) details.append(el);
  if (r.removable) {
    details.append(h("div", { class: "hub-row" }, h("span", { style: "flex:1" }), button(t("Remove"), () => void AppList.remove(r.id), "danger", true)));
  }

  const block = h("div", { class: env.open.has(r.id) ? "hub-app-block open" : "hub-app-block" }, head, details);
  head.addEventListener("click", (e) => {
    // The switch does its own thing.
    if ((e.target as HTMLElement | null)?.closest?.(".switch")) return;
    if (env.open.has(r.id)) env.open.delete(r.id);
    else env.open.add(r.id);
    block.classList.toggle("open", env.open.has(r.id));
  });
  return block;
}

export async function appsPage(page: HTMLElement, ctx: HubContext) {
  page.classList.add("narrow");
  AppList.use(IslandSettings);
  page.append(pageHead(t("Apps")));
  const list = h("div", { class: "hub-page-body" });
  page.append(list);
  /** Gmail's accounts, kept across redraws: a form being typed in survives a list update. */
  const gmail = gmailAccounts();
  const env: RowEnv = {
    open: new Set<string>(),
    redraw: () => void draw(true),
    accounts: (appId) => (appId === "gmail" ? gmail.el : null),
  };
  const file = await AppsBridge.apiFile();
  let shownKey = "";

  async function draw(force = false, rows?: AppRow[]) {
    rows ??= await AppList.rows();
    // Drawn again only when a row changed: a key being typed in survives the rest.
    const key = JSON.stringify(rows);
    if (!force && key === shownKey) return;
    shownKey = key;
    const fresh = section(null, rows.map((r) => appBlock(r, env)), t("Off, an app is hidden from the island. Its notifications still wait behind the bell."));
    clear(list);
    list.append(fresh);
    if (file) {
      list.append(section(t("Connect an app"), [
        row(t("Address and token"), null),
        h("code", { class: "hub-code", text: file }),
      ], t("Apps read this file to join the island. Only you can read it.")));
    }
  }

  await draw(true);
  // What each built-in needs (a key, Spotify installed), looked at again now.
  void AppsBridge.refreshSetup();
  // Apps join, leave or change while the page is open: the registry says so.
  const unlisten = await onEvent<AppsSnapshot>("apps", (snapshot) => {
    Feed.set(snapshot);
    void draw(false, appRows(Feed.apps));
  });
  const before = ctx.onLeave;
  ctx.onLeave = () => {
    before?.();
    unlisten();
    gmail.dispose();
  };
}
