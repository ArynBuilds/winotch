// Island geometry — ported from IslandTypes.swift + IslandWindowController.islandSize
// + IslandRootView.botPosition. All values are logical pixels, identical to the
// macOS app's points.

export type IslandMode = "hidden" | "compact" | "expanded";

export type IslandViewName =
  | "overview"
  | "empty"
  | "approval"
  | "question"
  | "error"
  | "finished"
  | "confused"
  | "upload"
  | "uploading"
  | "choose"
  | "mail"
  | "prompt"
  | "searching"
  | "result"
  | "note"
  | "greeting"
  | "recap"
  | "notifications"
  // winotch: one app, expanded: its whole list (views/appdetail.ts).
  | "app"
  // winotch: every setting, inside the island (views/settings.ts).
  | "settings"
  // winotch: what was asked by voice, answered big (views/say.ts).
  | "say";

export type BotStateName =
  | "idle"
  | "working"
  | "thinking"
  | "searching"
  | "approval"
  | "question"
  | "error"
  | "finished"
  | "ratelimit"
  | "sleeping"
  | "dizzy";

export type BotEmoteName = "love" | "surprised" | "proud" | "wink" | "yawn" | "happy" | "annoyed";

export type AgentLayoutMode = "none" | "grid" | "pills" | "column";

export interface ViewLayout {
  height: number;
  botX: number;
  botY: number | null; // null = auto-centred
  botDiameter: number;
  agentMode: AgentLayoutMode;
}

// The window is a fixed 920×600 (largest view, with the ears) like the macOS
// panel; the island is drawn inside it, glued to the top edge and centred.
// Outside the island it lets the mouse through, so its size costs nothing.
// winotch: 720×320 → 920×600 for the settings (SETTINGS_W) and their ears.
export const PANEL_W = 920;
export const PANEL_H = 600;

// No notch on a PC: these are the hidden/compact sizes from docs/SPEC.md.
export const NOTCH_W = 184;
export const NOTCH_H = 32;
/** The hidden island: a line this many pixels tall (winotch). */
export const HIDDEN_H = 3;
export const COMPACT_W = 288; // NOTCH_W + 104
export const EXPANDED_W = 640;
/** One app expanded (the "app" view): taller and a little wider than the open island. */
export const APP_W = 720;
/** Every setting, in the island: room for the sidebar and a page. */
export const SETTINGS_W = 880;

export const ROUNDED_CORNER = 14; // hidden / compact
export const EXPANDED_CORNER = 22;

/** Invisible hover strip that wakes the island when hidden. */
export const WAKE_STRIP_W = 240;
export const WAKE_STRIP_H = 6;

export const VIEW_LAYOUTS: Record<IslandViewName, ViewLayout> = {
  overview: { height: 160, botX: 68, botY: null, botDiameter: 58, agentMode: "pills" },
  empty: { height: 160, botX: 70, botY: null, botDiameter: 62, agentMode: "none" },
  approval: { height: 160, botX: 62, botY: null, botDiameter: 56, agentMode: "column" },
  question: { height: 160, botX: 62, botY: null, botDiameter: 56, agentMode: "column" },
  error: { height: 160, botX: 62, botY: null, botDiameter: 58, agentMode: "column" },
  finished: { height: 160, botX: 62, botY: null, botDiameter: 58, agentMode: "column" },
  confused: { height: 160, botX: 76, botY: null, botDiameter: 66, agentMode: "column" },
  upload: { height: 176, botX: 140, botY: 104, botDiameter: 62, agentMode: "column" },
  // botY 103 = bar top (42 + 58) + 3, so the dot really rides the bar. The Swift
  // layout says 118 while its own comment says 103; the comment matches the spec.
  uploading: { height: 176, botX: 46, botY: 103, botDiameter: 20, agentMode: "none" },
  choose: { height: 176, botX: 60, botY: 101, botDiameter: 52, agentMode: "column" },
  mail: { height: 240, botX: 56, botY: null, botDiameter: 46, agentMode: "column" },
  // winotch: in the chat the mark sits by the field, the one you talk to, and
  // the conversation has the card's whole width (botY: see botPosition).
  prompt: { height: 160, botX: 40, botY: null, botDiameter: 26, agentMode: "column" },
  searching: { height: 160, botX: 52, botY: null, botDiameter: 44, agentMode: "column" },
  result: { height: 160, botX: 52, botY: null, botDiameter: 44, agentMode: "column" },
  note: { height: 160, botX: 60, botY: null, botDiameter: 50, agentMode: "column" },
  // winotch: where the launch's birth ends, so the island's mark takes over there
  // (mark/greeting.ts BIG: the middle of the greeting, bars 22 px thick).
  greeting: { height: 150, botX: 320, botY: 75, botDiameter: (22 / 0.192) * 0.6, agentMode: "none" },
  // Mac: 160. The extra 24 hold the two lines with top agent, project, busiest
  // day, longest session, permissions and questions, which the Mac card leaves
  // to the shared image.
  recap: { height: 184, botX: 62, botY: null, botDiameter: 58, agentMode: "column" },
  // winotch: the feed of every app's notifications, the mark in its left column.
  notifications: { height: 258, botX: 50, botY: 76, botDiameter: 40, agentMode: "none" },
  // winotch: one app, expanded; the mark in the left column, as in the feed.
  app: { height: 280, botX: 50, botY: 76, botDiameter: 40, agentMode: "none" },
  // winotch: the mark stands at the top of the settings' sidebar, left of Back.
  settings: { height: 560, botX: 34, botY: 30, botDiameter: 30, agentMode: "none" },
  // winotch: one line, a little taller than it, all black, the answer alone in it: no mark.
  say: { height: 56, botX: 320, botY: 28, botDiameter: 30, agentMode: "none" },
};

// The upload views above are only the fallback geometry. Once a file is actually
// dropped the whole sequence — the mark included — is drawn by src/upload, which
// owns its own constants (USC) straight from UploadSequenceEngine.swift.

/** The question view with options to pick from: room for two rows of them. */
export const QUESTION_PICKER_H = 200;

/** Chat view grows with the conversation — IslandContainer.chatPromptHeight. */
export function chatPromptHeight(messageCount: number): number {
  return Math.min(300, 240 + messageCount * 40);
}

export function islandSize(
  mode: IslandMode,
  view: IslandViewName,
  chatCount = 0,
): { w: number; h: number } {
  switch (mode) {
    case "hidden":
      // winotch: hidden, the island is a hairline with the notch's own curves
      // (rounded below, ears into the top edge), never gone. It fits the 240 x 6
      // wake strip the window shrinks to.
      return { w: NOTCH_W, h: HIDDEN_H };
    case "compact":
      return { w: COMPACT_W, h: NOTCH_H };
    case "expanded": {
      const h = view === "prompt" ? chatPromptHeight(chatCount) : VIEW_LAYOUTS[view].height;
      return { w: view === "app" ? APP_W : view === "settings" ? SETTINGS_W : EXPANDED_W, h };
    }
  }
}

export interface BotPlacement {
  cx: number;
  cy: number;
  diameter: number;
  opacity: number;
}

/** IslandRootView.botPosition — cy is measured from the island's top edge. */
export function botPosition(
  mode: IslandMode,
  view: IslandViewName,
  islandH: number,
  uploadProgress = 0,
): BotPlacement {
  switch (mode) {
    case "hidden":
      return { cx: 46, cy: 16, diameter: 6, opacity: 0 };
    case "compact":
      return { cx: 40, cy: 16, diameter: 20, opacity: 1 };
    case "expanded": {
      const layout = VIEW_LAYOUTS[view];
      if (view === "uploading") {
        return {
          cx: 36 + uploadProgress * 526,
          cy: layout.botY ?? 103,
          diameter: layout.botDiameter,
          opacity: 1,
        };
      }
      // Nothing but the answer on it.
      if (view === "say") return { cx: layout.botX, cy: layout.botY ?? 75, diameter: layout.botDiameter, opacity: 0 };
      if (layout.botY != null) {
        return { cx: layout.botX, cy: layout.botY, diameter: layout.botDiameter, opacity: 1 };
      }
      // The chat: level with its field, whatever the island's height (style.css
      // .chat-bar: 10 below the card, 14 below the bar, the bar's middle).
      if (view === "prompt") {
        return { cx: layout.botX, cy: islandH - 10 - 14 - 19, diameter: layout.botDiameter, opacity: 1 };
      }
      // Centre of the fixed 84 pt card (8 pt top inset + 34 pt header → content at y = 42)
      const headerBottom = 42;
      const cardH = 84;
      const cy = headerBottom + (islandH - headerBottom - cardH) / 2 + cardH / 2;
      return { cx: layout.botX, cy, diameter: layout.botDiameter, opacity: 1 };
    }
  }
}

export function botGlowColor(s: BotStateName): string {
  switch (s) {
    case "working":
      return "#ECECEC";
    case "thinking":
      return "#ECECEC";
    case "searching":
      return "#ECECEC";
    case "approval":
      return "#ECECEC";
    case "error":
      return "#ECECEC";
    case "finished":
      return "#ECECEC";
    case "ratelimit":
      return "#ECECEC";
    default:
      return "#FFFFFF";
  }
}

export function botGlowOpacity(s: BotStateName): number {
  switch (s) {
    case "idle":
    case "sleeping":
      return 0.15;
    case "dizzy":
      return 0;
    default:
      return 0.65;
  }
}

// Project colours (IslandConst.projectColors): one ink for every project now,
// so only the fallback below is left.
const PROJECT_COLORS: Record<string, string> = {};

const FALLBACK_COLORS = ["#ECECEC", "#ECECEC", "#ECECEC", "#ECECEC"];

export function colorForProject(name: string): string {
  const key = name.toLowerCase().trim();
  const exact = PROJECT_COLORS[key];
  if (exact) return exact;
  for (const [k, c] of Object.entries(PROJECT_COLORS)) {
    if (key.startsWith(k) || key.includes(k)) return c;
  }
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}

// Card wash colours (CardBackground.washColor)
export type Wash = "red" | "green" | "pink" | "amber" | "cyan" | "indigo" | "soft" | null;

export function washRGBA(wash: Wash): string {
  switch (wash) {
    case "red":
      return "rgba(236, 236, 236,0.55)";
    case "green":
      return "rgba(236, 236, 236,0.5)";
    case "pink":
      return "rgba(236, 236, 236,0.55)";
    case "amber":
      return "rgba(236, 236, 236,0.42)";
    case "cyan":
      return "rgba(236, 236, 236,0.38)";
    case "indigo":
      return "rgba(236, 236, 236,0.5)";
    case "soft":
      return "rgba(255,255,255,0.08)";
    default:
      return "rgba(0,0,0,0)";
  }
}
