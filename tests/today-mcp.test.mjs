// The MCP server's tools (`winotch-hook mcp`, hook/src/mcp.rs): each one
// becomes the right call on winotch's local API, with the token from api.json.
// The server runs as Claude Code runs it (stdio, one JSON message per line)
// against a stand-in for winotch that writes down what it is asked. It needs
// the relay built: `cargo build --release -p winotch-hook` (npm run dev and
// build do it first).

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const TARGET = join(dirname(fileURLToPath(import.meta.url)), "..", "target");
const EXE = process.platform === "win32" ? "winotch-hook.exe" : "winotch-hook";
const SERVER = ["release", "debug"].map((p) => join(TARGET, p, EXE)).find((p) => existsSync(p));
if (!SERVER) throw new Error(`${EXE} is not built: run \`cargo build --release -p winotch-hook\` first`);
const TOKEN = "secret-token";

/** What winotch was asked, oldest first: [method, url, body]. */
const asked = [];
/** What winotch answers, by "METHOD /path" (the query left out). */
const answers = new Map();

let http;
let mcp;
let dir;
const pending = new Map();
let nextId = 0;

before(async () => {
  http = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401).end(JSON.stringify({ error: "the token from api.json is missing or wrong" }));
        return;
      }
      asked.push([req.method, req.url, body ? JSON.parse(body) : undefined]);
      const answer = answers.get(`${req.method} ${req.url.split("?")[0]}`) ?? { ok: true };
      const status = answer.status ?? 200;
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(answer.status ? { error: answer.error } : answer));
    });
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  dir = mkdtempSync(join(tmpdir(), "winotch-mcp-"));
  mkdirSync(join(dir, "winotch"));
  writeFileSync(join(dir, "winotch", "api.json"), JSON.stringify({ url: `http://127.0.0.1:${http.address().port}`, token: TOKEN }));
  mcp = spawn(SERVER, ["mcp"], { env: { ...process.env, LOCALAPPDATA: dir, XDG_DATA_HOME: dir }, stdio: ["pipe", "pipe", "inherit"] });
  createInterface({ input: mcp.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
});

after(() => {
  mcp?.kill();
  http?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function rpc(method, params) {
  const id = ++nextId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

/** Calls a tool; its JSON answer, or `{ error }` when it failed. */
async function call(name, args) {
  const { result } = await rpc("tools/call", { name, arguments: args });
  const text = result.content[0].text;
  return result.isError ? { error: text } : JSON.parse(text);
}

const last = () => asked.at(-1);

test("the Today tools are listed, each saying how to give days and times", async () => {
  await rpc("initialize", { protocolVersion: "2025-06-18" });
  const { result } = await rpc("tools/list", {});
  const names = result.tools.map((t) => t.name);
  for (const name of [
    "winotch_today_list", "winotch_today_add", "winotch_today_update", "winotch_today_delete",
    "winotch_notes_list", "winotch_notes_read", "winotch_notes_write", "winotch_notes_append", "winotch_notes_delete",
  ]) assert.ok(names.includes(name), name);
  const describe = (n) => result.tools.find((t) => t.name === n).description;
  assert.match(describe("winotch_today_list"), /tomorrow/);
  assert.match(describe("winotch_today_add"), /YYYY-MM-DD/);
  assert.deepEqual(result.tools.find((t) => t.name === "winotch_today_add").inputSchema.required, ["title"]);
});

test("the list asks for today and the week after, and splits out what is late and someday's", async () => {
  answers.set("GET /v1/today/todos", {
    today: "2026-10-18", weekday: "Sunday", now: "14:00",
    todos: [
      { id: "t1", title: "late", date: "2026-10-16", done: false, created: 1 },
      { id: "t2", title: "today", date: "2026-10-18", done: false, created: 2 },
      { id: "t3", title: "someday", done: false, created: 3 },
    ],
  });
  const got = await call("winotch_today_list", { from: "2026-10-18" });
  const [method, url] = last();
  assert.equal(method, "GET");
  const q = new URL(url, "http://x").searchParams;
  assert.deepEqual([q.get("from"), q.get("to"), q.get("overdue"), q.get("undated")], ["2026-10-18", "2026-10-25", "1", "1"]);
  assert.deepEqual([got.today, got.weekday, got.now], ["2026-10-18", "Sunday", "14:00"]);
  assert.deepEqual(got.range, { from: "2026-10-18", to: "2026-10-25" });
  assert.deepEqual([got.todos, got.overdue, got.someday].map((l) => l.map((t) => t.id)), [["t2"], ["t1"], ["t3"]]);
  // Without a range: today on this computer's clock.
  await call("winotch_today_list", {});
  const from = new URL(last()[1], "http://x").searchParams.get("from");
  const d = new Date();
  assert.equal(from, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  // Everything, done ones only.
  await call("winotch_today_list", { all: true, done: true });
  assert.deepEqual(last().slice(0, 2), ["GET", "/v1/today/todos?done=1"]);
});

test("add, update and delete go to the to-do's own path, with only the fields given", async () => {
  await call("winotch_today_add", { title: "Call Sarah", date: "2026-10-19", time: "15:00" });
  assert.deepEqual(last(), ["POST", "/v1/today/todos", { title: "Call Sarah", date: "2026-10-19", time: "15:00" }]);
  await call("winotch_today_update", { id: "t2", date: null, done: true });
  assert.deepEqual(last(), ["PATCH", "/v1/today/todos/t2", { date: null, done: true }]);
  await call("winotch_today_delete", { id: "t2" });
  assert.deepEqual(last().slice(0, 2), ["DELETE", "/v1/today/todos/t2"]);
  // A refusal comes back as the tool's error, in winotch's words.
  answers.set("POST /v1/today/todos", { status: 400, error: "time needs a date" });
  assert.deepEqual(await call("winotch_today_add", { title: "x", time: "15:00" }), { error: "time needs a date" });
  answers.delete("POST /v1/today/todos");
});

test("notes: list or search, read, write (new or replaced), append, delete", async () => {
  await call("winotch_notes_list", {});
  assert.deepEqual([last()[0], last()[1].replace(/\?$/, "")], ["GET", "/v1/today/notes"]);
  await call("winotch_notes_list", { query: "hotel river" });
  assert.deepEqual(last().slice(0, 2), ["GET", "/v1/today/notes?q=hotel+river"]);
  await call("winotch_notes_read", { id: "n3" });
  assert.deepEqual(last().slice(0, 2), ["GET", "/v1/today/notes/n3"]);
  await call("winotch_notes_write", { title: "Ideas", body: "One" });
  assert.deepEqual(last(), ["POST", "/v1/today/notes", { title: "Ideas", body: "One" }]);
  await call("winotch_notes_write", { id: "n3", body: "Two" });
  assert.deepEqual(last(), ["PATCH", "/v1/today/notes/n3", { body: "Two" }]);
  await call("winotch_notes_append", { id: "n3", text: "Three" });
  assert.deepEqual(last(), ["PATCH", "/v1/today/notes/n3", { append: "Three" }]);
  await call("winotch_notes_delete", { id: "n3" });
  assert.deepEqual(last().slice(0, 2), ["DELETE", "/v1/today/notes/n3"]);
  // An id is one path segment, whatever it holds.
  await call("winotch_notes_read", { id: "../todos" });
  assert.deepEqual(last().slice(0, 2), ["GET", "/v1/today/notes/..%2Ftodos"]);
});

// ── The sessions (winotch_sessions, winotch_open_session, winotch_open_folder) ──
// "Open my last my-app session": listed by folder, opened in the chat (or its
// terminal), a folder shown in Explorer.

test("the session tools are listed, saying how to find the last one of a folder", async () => {
  const { result } = await rpc("tools/list", {});
  const names = result.tools.map((t) => t.name);
  for (const name of ["winotch_sessions", "winotch_open_session", "winotch_open_folder"]) assert.ok(names.includes(name), name);
  assert.match(result.tools.find((t) => t.name === "winotch_sessions").description, /last my-app session/);
  assert.deepEqual(result.tools.find((t) => t.name === "winotch_open_session").inputSchema.required, ["id"]);
});

test("the sessions are asked for by folder, and opened in the chat unless the terminal is asked for", async () => {
  answers.set("GET /v1/sessions", { sessions: [{ id: "a1", folder: "my-app", title: "Docs", cwd: "C:\\code\\my-app", updated: 5, openInTerminal: false }] });
  const got = await call("winotch_sessions", { folder: "my-app", limit: 3 });
  const q = new URL(last()[1], "http://x").searchParams;
  assert.deepEqual([last()[0], q.get("folder"), q.get("limit")], ["GET", "my-app", "3"]);
  assert.equal(got.sessions[0].id, "a1");

  await call("winotch_open_session", { id: "a1" });
  assert.deepEqual(last(), ["POST", "/v1/sessions/open", { id: "a1", in: "chat" }]);
  await call("winotch_open_session", { id: "a1", in: "terminal" });
  assert.deepEqual(last(), ["POST", "/v1/sessions/open", { id: "a1", in: "terminal" }]);
  await call("winotch_open_folder", { path: "C:\\code\\my-app" });
  assert.deepEqual(last(), ["POST", "/v1/folders/open", { path: "C:\\code\\my-app" }]);
});
