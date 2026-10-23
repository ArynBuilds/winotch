// The Gmail accounts' bridge (src/core/mail.ts): the commands Settings sends
// to Rust (src-tauri/src/mail), and the account rows' status line. The Rust
// half (IMAP, drafts, the bell kept in step with Gmail) is tested in mail/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { sent } from "./tauri.mjs";
import { MailBridge, mailStatusLine } from "../src/core/mail.ts";
import { DEFAULT_SETTINGS } from "../src/core/state.ts";

test("the bridge names the mail commands and their arguments as Rust takes them", async () => {
  await MailBridge.accounts();
  assert.equal(sent("mail_accounts").length, 1);
  await MailBridge.addAccount("me@gmail.com", "Work", "abcd efgh ijkl mnop");
  assert.deepEqual(sent("mail_add_account").at(-1), { email: "me@gmail.com", label: "Work", password: "abcd efgh ijkl mnop" });
  await MailBridge.setAccount("me@gmail.com", { opensIsland: false });
  assert.deepEqual(sent("mail_set_account").at(-1), { email: "me@gmail.com", label: null, opensIsland: false });
  await MailBridge.setAccount("me@gmail.com", { label: "" });
  assert.deepEqual(sent("mail_set_account").at(-1), { email: "me@gmail.com", label: "", opensIsland: null });
  await MailBridge.removeAccount("me@gmail.com");
  assert.deepEqual(sent("mail_remove_account").at(-1), { email: "me@gmail.com" });
});

test("an account's line says what it is doing", () => {
  const a = { email: "me@gmail.com", label: null, opensIsland: true, status: "ok", error: null, unread: 3 };
  assert.equal(mailStatusLine(a), "3 unread");
  assert.equal(mailStatusLine({ ...a, unread: 0 }), "No unread mail");
  assert.equal(mailStatusLine({ ...a, status: "connecting" }), "Connecting…");
  assert.equal(mailStatusLine({ ...a, status: "error", error: "Wrong email or app password." }), "Wrong email or app password.");
});

test("settings start with no Gmail account", () => {
  assert.deepEqual(DEFAULT_SETTINGS.gmailAccounts, []);
});
