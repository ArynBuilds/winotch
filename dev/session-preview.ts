// A Claude Code session in a real island, on sample hook events: the page
// plays the relay's part (the "hook" event), so what shows is what
// island/hooks.ts makes of them. `npm run dev`, then open
// /dev/session-preview.html. Not shipped in the app.
//   ?state=approval   a command waiting for Allow or Deny (default)
//   ?state=question   Claude asking which way to go
//   ?state=finished   the session's last answer

const params = new URLSearchParams(location.search);
const state = params.get("state") ?? "approval";

// Tauri's internals, enough for the page's listeners: each `listen` keeps its
// callback, and `emit` below calls the ones for that event.
const callbacks = new Map<number, (e: unknown) => void>();
const listeners = new Map<string, number[]>();
let next = 0;
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "island" }, currentWebview: { windowLabel: "island", label: "island" } },
  transformCallback: (fn: (e: unknown) => void) => {
    callbacks.set(++next, fn);
    return next;
  },
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "plugin:event|listen") {
      const event = String(args.event);
      listeners.set(event, [...(listeners.get(event) ?? []), Number(args.handler)]);
      return Number(args.handler);
    }
    return null;
  },
};

function emit(event: string, payload: unknown) {
  for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ event, id, payload });
}

await import("../src/style.css");
const { Island } = await import("../src/island/island");
const { registerHookHandlers } = await import("../src/island/hooks");

const island = new Island(document.getElementById("root")!);
registerHookHandlers(island);
await new Promise((r) => setTimeout(r, 50));

const session = { session_id: "s1", cwd: "C:\\code\\my-app" };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
emit("hook", { ...session, hook_event_name: "UserPromptSubmit", prompt: "Add rate limiting to the public API" });
await wait(120);
emit("hook", { ...session, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "C:\\code\\my-app\\src\\server.ts" } });
await wait(120);
emit("hook", {
  ...session,
  hook_event_name: "PostToolUse",
  tool_name: "Edit",
  tool_input: {
    file_path: "C:\\code\\my-app\\src\\server.ts",
    old_string: "app.use(router);",
    new_string: "app.use(rateLimit({ windowMs: 60_000, max: 100 }));\napp.use(router);",
  },
});
await wait(120);

if (state === "approval") {
  emit("hook", {
    ...session,
    hook_event_name: "PermissionRequest",
    request_id: "r1",
    tool_name: "Bash",
    tool_input: { command: "npm install express-rate-limit", description: "Install the rate limiter" },
  });
} else if (state === "question") {
  emit("hook", {
    ...session,
    // A question comes as a permission request for AskUserQuestion.
    hook_event_name: "PermissionRequest",
    request_id: "q1",
    tool_name: "AskUserQuestion",
    tool_input: {
      questions: [{
        question: "Which limit should anonymous callers get?",
        header: "Limit",
        multiSelect: false,
        options: [
          { label: "100 a minute", description: "The same as signed-in users" },
          { label: "20 a minute", description: "Stricter for anonymous callers" },
        ],
      }],
    },
  });
} else {
  emit("hook", {
    ...session,
    hook_event_name: "Stop",
    last_assistant_message: "Rate limiting is in: **100 requests a minute** per address on every `/api` route, with a `429` and a `Retry-After` header past that. The tests pass.",
  });
}
