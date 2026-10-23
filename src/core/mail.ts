// Gmail accounts for Settings (src-tauri/src/mail, WINOTCH.md "Gmail"). Each
// account signs in with a Google app password, checked once when it is added
// and then kept in the OS credential store. The inbox itself reaches the
// island as the "gmail" app's list and notifications (core/apps.ts).

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t } from "../i18n/i18n";

const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`[winotch] ${cmd} failed`, err);
    return null;
  }
}

export type MailStatus = "connecting" | "ok" | "error";

/** An account as Settings shows it. */
export interface MailAccount {
  /** Lower case. */
  email: string;
  /** "Work"; null shows the address. */
  label: string | null;
  /** Its new mail may peek the island; off, it waits behind the bell. */
  opensIsland: boolean;
  status: MailStatus;
  /** Why it is not connected, in words to show as they are. */
  error: string | null;
  /** Unread mail in its inbox. */
  unread: number;
}

/** Where Google makes app passwords (it needs 2-Step Verification on). */
export const APP_PASSWORDS_URL = "https://myaccount.google.com/apppasswords";

export const MailBridge = {
  accounts: () => call<MailAccount[]>("mail_accounts"),

  /**
   * Signs in once with the app password; only then is the account saved and
   * started. Rejects with Gmail's reason, worded for the user (wrong password,
   * IMAP off, no 2-Step Verification…), so the form can show it.
   */
  addAccount: (email: string, label: string | null, password: string) =>
    IS_TAURI
      ? invoke<MailAccount>("mail_add_account", { email, label, password })
      : Promise.reject(new Error("Gmail needs the app")),

  /** Forgets the account, its password and its notifications. */
  removeAccount: (email: string) => call<void>("mail_remove_account", { email }),

  /** Renames it ("" shows the address) or lets it open the island or not. */
  setAccount: (email: string, change: { label?: string; opensIsland?: boolean }) =>
    call<void>("mail_set_account", { email, label: change.label ?? null, opensIsland: change.opensIsland ?? null }),

  /** Every change of an account's state, with the whole list. Returns the unlisten. */
  onAccounts: async (handler: (accounts: MailAccount[]) => void): Promise<() => void> => {
    if (!IS_TAURI) return () => {};
    return listen<MailAccount[]>("mail-accounts", (e) => handler(e.payload));
  },
};

/** What a row says about an account's state. */
export function mailStatusLine(a: MailAccount): string {
  if (a.status === "error") return a.error ?? t("Not connected");
  if (a.status === "connecting") return t("Connecting…");
  return a.unread === 0 ? t("No unread mail") : t("{n} unread", { n: a.unread });
}
