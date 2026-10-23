#!/usr/bin/env node
// A whole winotch app in one file, with no dependencies: it registers itself,
// publishes a list, sends a notification with two buttons, and hears your
// presses. Start winotch, then:
//
//   node examples/hello-app.mjs
//
// It shows up on the island and in Settings → Apps. Ctrl+C stops it; remove
// it in Settings → Apps. See docs/api.md for every call.

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const APP = "hello";

/** Where winotch listens and its token: api.json, written at every start. */
function api() {
  const dir = process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "winotch")
    : join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "winotch");
  try {
    return JSON.parse(readFileSync(join(dir, "api.json"), "utf8"));
  } catch {
    console.error("winotch is not running (no api.json). Start it, then run this again.");
    process.exit(1);
  }
}

const { url, token } = api();

async function call(method, path, body) {
  const res = await fetch(url + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${data.error}`);
  return data;
}

let count = 0;

/** The list the island shows when the app is opened. */
const publish = () => call("POST", "/v1/items", {
  app: APP,
  status: `${count} pressed`,
  sections: [{
    title: "Things to do",
    items: [
      { id: "one", title: "Read docs/api.md", subtitle: "Every call, with its limits", actions: [{ id: "done", label: "Done" }] },
      { id: "two", title: "Make your own app", subtitle: "Copy this file and change it" },
    ],
  }],
});

// A button press comes back here, on 127.0.0.1 only.
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const press = JSON.parse(body || "{}");
    console.log("pressed:", press);
    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    if (press.action) {
      count += 1;
      await publish();
    }
  });
});

server.listen(0, "127.0.0.1", async () => {
  const callback = `http://127.0.0.1:${server.address().port}/act`;
  await call("POST", "/v1/apps", { id: APP, name: "Hello", sign: "-.", callback, status: "ready" });
  await publish();
  await call("POST", "/v1/notify", {
    app: APP,
    title: "Hello from your own app",
    body: "Press a button: this script hears it.",
    importance: "normal",
    actions: [{ id: "yes", label: "Nice" }, { id: "no", label: "Dismiss" }],
  });
  console.log("Hello is on the island. Press its buttons; Ctrl+C to stop.");
});
