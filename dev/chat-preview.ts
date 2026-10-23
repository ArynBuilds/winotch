// The chat in a real island, on sample sessions: ?state=idle (the default),
// typing (text in the field: the chip folds to its chevron), fold (that fold
// held halfway), picker (the chip's picker open, ?tab=target|model|effort),
// lines (the field grown with ?n=1..9 lines of text: six at most, then it scrolls).
// `npm run dev`, then open /dev/chat-preview.html. Not shipped in the app.

const SESSIONS = [
  { id: "s1", cwd: "C:/code/winotch", project: "winotch", title: "Chips inside the chat field", updated: 3 },
  { id: "s2", cwd: "C:/code/gtm.js", project: "gtm.js", title: "Draft replies for reddit", updated: 2 },
  { id: "s3", cwd: "C:/code/my-site", project: "my-site", title: "Sequenced motion pass", updated: 1 },
];
const MESSAGES = [
  { role: "user", text: "Can the chips live inside the input box?" },
  { role: "tool", text: "Read src/views/chat.ts" },
  { role: "assistant", text: "Yes. The field keeps the width; at its right end a **compact chip** names the session and opens the picker, whose tabs pick the model and the effort.\n\nWhile you type, the chip folds to its chevron." },
  { role: "user", text: "And the log gets the freed height?" },
  { role: "assistant", text: "The two rows of chips are gone, so the log grows by about 54 px." },
];

// The page plays Rust's part: the sessions, their messages, who is reachable.
let callbacks = 0;
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  transformCallback: () => ++callbacks,
  invoke: async (cmd: string) => {
    if (cmd === "plugin:event|listen") return ++callbacks;
    if (cmd === "sessions_list") return SESSIONS;
    if (cmd === "sessions_reachable") return ["s2"];
    if (cmd === "session_messages") return { stamp: "1", messages: MESSAGES };
    return null;
  },
};

await import("../src/style.css");
const { Island } = await import("../src/island/island");
const { State } = await import("../src/core/state");

const params = new URLSearchParams(location.search);
const which = params.get("state") ?? "idle";
State.settings = { ...State.settings, chatSession: "s1", chatModel: "opus", chatEffort: "high" };
const island = new Island(document.getElementById("root")!);
island.alert("prompt");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
await wait(700);
const input = document.querySelector(".chat-input") as HTMLTextAreaElement;
const LINES = [
  "Make the send button a touch smaller and keep the pill concentric with the field,",
  "then let the field grow upward as I type",
  "- one line at a time",
  "- six at most",
  "- then it scrolls inside itself",
  "and the log above gives up the height.",
  "The chip and the send button stay by the last line.",
  "Enter sends; Shift+Enter breaks the line.",
  "After sending it is one line again.",
];
if (which === "lines") {
  const n = Math.max(1, Math.min(LINES.length, Number(params.get("n") ?? 3)));
  input.focus();
  // The first line wraps once the chip has folded: n lines from n - 1 breaks.
  input.value = n === 1 ? "One line, as it always was" : LINES.slice(0, n - 1).join("\n");
  input.dispatchEvent(new Event("input"));
  input.scrollTop = input.scrollHeight;
} else if (which === "typing" || which === "fold") {
  input.focus();
  input.value = "Make the send button a touch smaller and keep the pill concentric";
  input.dispatchEvent(new Event("input"));
  if (which === "fold") {
    await wait(0);
    for (const a of document.getAnimations()) {
      a.pause();
      a.currentTime = 70;
    }
  }
} else if (which === "picker") {
  (document.querySelector(".chat-chip") as HTMLElement).click();
  const tab = ["target", "model", "effort"].indexOf(params.get("tab") ?? "target");
  if (tab > 0) (document.querySelectorAll(".picker-tab")[tab] as HTMLElement).click();
}
