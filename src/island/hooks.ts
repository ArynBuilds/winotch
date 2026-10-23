// Hook events from Claude Code and every other agent → island state.
// Port of HookServer.processEvent / processPermissionRequest from the macOS app.
// Difference from macOS: no terminal filter. On Windows the hook fires from any
// terminal (Windows Terminal, VS Code, PowerShell…) and all of them are handled.
// The relay has already mapped every agent's events and fields onto Claude
// Code's (hook/src/normalize.rs), so one handler serves them all.

import { Bridge, onEvent } from "../core/bridge";
import { buildFileDiff, fileName, makeDiffStep, toOneLine } from "../core/diff";
import { Sound } from "../core/sound";
import { State, type AskedQuestion } from "../core/state";
import { pillDefinition } from "../core/pills";
import { APPROVAL_AGENTS, agentName, validateAgent } from "./agents";
import type { Island } from "./island";
import { parseClaudePlan, restorePlanUsage } from "../core/plan";
import { setClaudePlanUsage, storedClaudePlanUsage } from "../views/usage";
import { N_, t } from "../i18n/i18n";

const CLAUDE_ID = "integration_claude";

/** Clears the approval card if no decision was made before the hook gave up. */
let pendingTimeout: number | null = null;

/** Takes the approval or question card down and gives the island back. */
export function dropPendingCard(island: Island): void {
  if (!State.pendingApproval) return;
  State.endApproval();
  island.dropPin();
  if (State.view === "approval" || State.view === "question") {
    island.setView(State.viewAfterCard());
  } else {
    State.viewBeforeCard = null;
  }
  State.notify();
}

/** The return to idle that Stop arms, per pill, so the next turn can cancel it. */
const stopTimers = new Map<string, number>();

function cancelStopTimer(id: string): boolean {
  const timer = stopTimers.get(id);
  if (timer == null) return false;
  window.clearTimeout(timer);
  stopTimers.delete(id);
  return true;
}

/** Events after which a pending permission request of the same session is moot. */
const TURN_OVER = new Set(["Stop", "StopFailure", "UserPromptSubmit", "SessionEnd", "Interrupt"]);

interface HookPayload {
  hook_event_name?: string;
  request_id?: string;
  session_id?: string;
  cwd?: string;
  message?: string;
  /** UserPromptSubmit carries `prompt`; `message` belongs to Notification/Stop. */
  prompt?: string;
  /** Stop: the turn's final answer (Markdown) — Claude Code's, Hermes's, Codex's. */
  last_assistant_message?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Set by the relay when an edit was too big to forward whole (> 256 KB). */
  winotch_diff_truncated?: boolean;
  /** Optional agent tag: lowercase, digits and hyphens, ≤ 24 chars. */
  winotch_agent?: string;
  /** Hermes: where the session runs (telegram, discord…; "cli" in a terminal). */
  platform?: string;
  /** "cursor" when Claude Code runs in Cursor's terminal (set by the relay). */
  term_editor?: string;
  /** StatusLine (the plan usage relay): Claude Code's 5-hour and weekly limits. */
  rate_limits?: unknown;
}

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/**
 * localizedStep() — same labels as the macOS app, in English and shown in the
 * interface language (src/i18n) when the step is recorded.
 */
const TOOL_LABELS: Record<string, string> = {
  Bash: N_("Runs"),
  Read: N_("Reads"),
  Write: N_("Writes"),
  Edit: N_("Edits"),
  Glob: N_("Searches"),
  Grep: N_("Searches"),
  WebSearch: N_("Searches the web"),
  WebFetch: N_("Fetches"),
  TodoWrite: N_("Tasks"),
  Task: N_("Agent"),
  LS: N_("Lists"),
  MultiEdit: N_("Edits"),
  NotebookEdit: N_("Notebook"),
  PowerShell: N_("Runs"),
  // Antigravity's tools (#298).
  run_command: N_("Runs"),
  view_file: N_("Reads"),
  write_to_file: N_("Writes"),
  replace_file_content: N_("Edits"),
  read_url_content: N_("Fetches"),
  search_web: N_("Searches the web"),
};

function stepLabel(tool: string, input: Record<string, unknown>): string {
  const label = TOOL_LABELS[tool] ? t(TOOL_LABELS[tool]) : tool;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const cmd = str("command");
  if (cmd) return `${label} · ${cmd.slice(0, 40)}`;
  const path = str("path");
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const file = str("file_path");
  if (file) return `${label} · ${lastPathComponent(file)}`;
  const query = str("query");
  if (query) return `${label} · ${query.slice(0, 40)}`;
  return label;
}

/**
 * What the Allow button actually authorises. Approving "Write" tells you nothing
 * — approving `Write · C:\…\.env` tells you everything, and the difference is
 * the whole point of approving from the island rather than blind.
 *
 * Ordered by how specific the field is, so an unfamiliar tool still shows
 * whatever identifying string it carries instead of falling back to its name.
 */
const APPROVAL_FIELDS = [
  "command", // Bash, PowerShell
  "file_path", // Write, Edit, MultiEdit, NotebookEdit
  "path", // Read, LS
  "url", // WebFetch
  "query", // WebSearch
  "pattern", // Glob, Grep
  "prompt", // Task
] as const;

function approvalTarget(tool: string, input: Record<string, unknown>): string {
  for (const field of APPROVAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return `${tool} · ${value.trim()}`;
    }
  }
  return tool;
}

/**
 * The questions of an AskUserQuestion call, if the island can show all of them
 * as options to pick from. Anything it cannot is left to the terminal.
 */
function askedQuestions(tool: string, input: Record<string, unknown>): AskedQuestion[] | null {
  if (tool !== "AskUserQuestion" || !Array.isArray(input.questions)) return null;
  const out: AskedQuestion[] = [];
  for (const raw of input.questions as Record<string, unknown>[]) {
    const question = typeof raw?.question === "string" ? raw.question : "";
    const options = (Array.isArray(raw?.options) ? (raw.options as Record<string, unknown>[]) : [])
      .filter((o) => typeof o?.label === "string" && o.label)
      .map((o) => ({
        label: o.label as string,
        description: typeof o.description === "string" ? o.description : "",
      }));
    // A question cut short by the relay would be answered under the wrong text.
    if (!question || question.endsWith("…") || options.length < 2) return null;
    out.push({ question, options, multiSelect: raw.multiSelect === true });
  }
  return out.length > 0 ? out : null;
}

/** The Claude Code session's pill, named after its project for the session. */
function upsert(id: string, projectName: string, cwd: string, sessionId: string) {
  const t = State.upsertWorkspacePill(id, projectName, cwd);
  if (t && sessionId) t.sessionId = sessionId;
}

/** The session is over: the pill goes back as it was, or away if it was only there for it. */
function clearSession(id: string) {
  const t = State.tasks.find((x) => x.id === id);
  if (!t) return;
  if (!State.isKept(id)) {
    State.removeTask(id);
    return;
  }
  t.state = "idle";
  t.steps = [];
  t.stepIndex = 0;
  delete t.stepSeq;
  t.name = pillDefinition(id)?.name ?? t.name;
  t.pillBadge = null;
  t.sessionId = null;
  t.finalLine = null;
}

/**
 * The final message stays on the card until the next turn starts. The finished
 * turn goes only with a new turn of its own session: Claude Code sessions share
 * one pill, and another session's tool call must not take it away (or relabel it).
 */
function clearFinalLine(id: string, sessionId: string) {
  const t = State.tasks.find((x) => x.id === id);
  if (t) t.finalLine = null;
  dropFinishedTurn(id, sessionId);
}

/** Forgets the pill's finished turn if it is this session's. */
function dropFinishedTurn(id: string, sessionId: string) {
  const turn = State.finishedTurns.get(id);
  if (turn && (turn.sessionId ?? "") === sessionId) State.finishedTurns.delete(id);
}

/**
 * PostToolUse of Edit / MultiEdit / Write → a diff stored for the pill and a
 * ticker step with its +N −M counts. Nothing is kept for a pill that does not
 * exist, so a stray event cannot grow memory. An edit the relay had to cut
 * would give wrong counts: the PreToolUse step ("Edits · file") stands alone.
 */
function recordDiff(agentId: string, payload: HookPayload) {
  if (payload.winotch_diff_truncated) return;
  if (!State.tasks.some((t) => t.id === agentId)) return;
  const diff = buildFileDiff(payload.tool_name ?? "", payload.tool_input ?? {});
  if (!diff) return;
  const id = State.appendSessionDiff(agentId, diff);
  State.appendStep(agentId, makeDiffStep(fileName(diff.path), diff.added, diff.removed, id));
}

export function registerHookHandlers(island: Island) {
  // The last plan numbers seen survive a restart, as on the Mac.
  State.planUsage ??= restorePlanUsage(storedClaudePlanUsage());
  void onEvent<HookPayload>("hook", (payload) => handleHook(island, payload));
}

function handleHook(island: Island, payload: HookPayload) {
  // Account-wide numbers from the status line relay, not part of any session:
  // keep the latest, nothing else (no reveal, no sound), paused or not.
  if (payload.hook_event_name === "StatusLine") {
    const usage = parseClaudePlan(payload.rate_limits);
    if (usage) setClaudePlanUsage(usage);
    return;
  }

  // Which Claude Code sessions are open, for the chat (winotch).
  if (payload.session_id) State.noteSession(payload.session_id, payload.hook_event_name ?? "");

  if (State.paused) {
    // Silence here used to cost Claude Code nearly two minutes: the relay waited
    // for a decision from an island that had already decided not to look. Say so,
    // and the terminal takes the question immediately.
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }

  const name = payload.hook_event_name ?? "";
  const cwd = payload.cwd ?? "";
  const raw = lastPathComponent(cwd);
  const projectName = raw || "Session";

  // Route to the right pill. Valid winotch_agent → dynamic "agent_<name>" pill.
  // "claude" is reserved; absent or invalid → Claude Code's own pill, the main
  // one, whichever terminal it runs in (winotch has no Cursor pill).
  const validAgent = validateAgent(payload.winotch_agent);
  const agentId = validAgent ? `agent_${validAgent}` : CLAUDE_ID;
  const isExternalAgent = validAgent !== null;
  const sessionId = payload.session_id ?? "";

  /**
   * Alerts force the island open. winotch: work events (a prompt, a tool) leave
   * it as it is: while Claude Code works nothing pops up, and the island only
   * opens when the session finishes, fails, or needs an answer.
   */
  const surface = (view: Parameters<Island["alert"]>[0], isAlert: boolean) => {
    if (!isAlert) return;
    if (State.mode === "expanded") island.setView(view);
    else island.alert(view);
  };

  /**
   * Shows `show` now; while an answer asked by voice is being said, once it is
   * over, if `still()` says it is news yet (State.afterSay: nothing cuts in).
   */
  const whenSaid = (show: () => void, still: () => boolean) => {
    if (!State.saying) show();
    else State.afterSay(() => still() && show());
  };

  /** Ensure the agent pill exists (no-op for Claude Code). */
  const ensurePill = () => {
    if (isExternalAgent) {
      State.upsertExternalAgent(agentId, agentName(validAgent!));
      const t = State.tasks.find((x) => x.id === agentId);
      if (t && cwd) t.sessionCwd = cwd;
      if (t && sessionId) t.sessionId = sessionId;
    } else {
      upsert(agentId, projectName, cwd, sessionId);
    }
  };

  /**
   * Called where a handler is about to replace `finished` with a newer state:
   * the timer Stop armed would otherwise put the pill back to idle over it. The
   * badge that timer was going to clear goes now.
   */
  const supersedeStop = () => {
    if (cancelStopTimer(agentId)) State.setPillBadge(agentId, null);
  };

  // The turn that asked for a permission is over — answered in the terminal,
  // interrupted, or a new prompt — so the card would be lying. It goes, and the
  // relay is released without a decision. Same rule as the Mac.
  const pending = State.pendingApproval;
  if (
    pending &&
    TURN_OVER.has(name) &&
    pending.pillId === agentId &&
    pending.sessionId === (payload.session_id ?? "")
  ) {
    if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
    pendingTimeout = null;
    if (pending.requestId) void Bridge.approvalDecline(pending.requestId);
    dropPendingCard(island);
  }

  // winotch: a session the island's chat talks to is the chat's (State.headless):
  // its answer shows there, so nothing of it shows here, no pill, card or
  // sound. Only a permission it needs still asks, over the chat.
  if (State.fromChat(sessionId) && name !== "PermissionRequest") return;

  // Read after the card above is dropped: its pill may have handed the front
  // back to the pill you were on.
  const focused = State.focusId === agentId;
  // While the island is open on the chat, other sessions say nothing either:
  // no card over the chat, no sound (State.chatting).
  const heard = focused && !State.chatting;

  switch (name) {
    case "SessionStart":
      ensurePill();
      clearFinalLine(agentId, sessionId);
      // Hermes through its gateway says where the session comes from.
      if (validAgent === "hermes" && payload.platform && payload.platform !== "cli") {
        State.appendStep(agentId, payload.platform.charAt(0).toUpperCase() + payload.platform.slice(1));
      }
      surface("overview", false);
      if (!State.hushed) Sound.play("work");
      break;

    case "UserPromptSubmit": {
      ensurePill();
      supersedeStop();
      clearFinalLine(agentId, sessionId);
      State.updateTask(agentId, "thinking");
      // The field is `prompt`; reading `message` meant this step was always blank.
      const asked = payload.prompt ?? payload.message;
      if (asked) State.appendStep(agentId, asked.slice(0, 60));
      surface("overview", false);
      break;
    }

    case "PreToolUse": {
      ensurePill();
      supersedeStop();
      clearFinalLine(agentId, sessionId);
      State.updateTask(agentId, "working");
      const tool = payload.tool_name ?? "Tool";
      State.appendStep(agentId, stepLabel(tool, payload.tool_input ?? {}));
      surface("overview", false);
      break;
    }

    case "PostToolUse":
      supersedeStop();
      // The question was answered in the terminal: the card would be lying.
      if (
        payload.tool_name === "AskUserQuestion" &&
        State.pendingApproval?.questions &&
        State.pendingApproval.sessionId === (payload.session_id ?? "")
      ) {
        if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
        pendingTimeout = null;
        dropPendingCard(island);
      }
      State.updateTask(agentId, "working");
      recordDiff(agentId, payload);
      break;

    case "PostToolUseFailure":
      supersedeStop();
      State.updateTask(agentId, "working");
      State.appendStep(agentId, t("⚠ failed"));
      break;

    case "Notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        supersedeStop();
        State.updateTask(agentId, "ratelimit");
        if (!State.hushed) Sound.play("rate");
      } else if (message.endsWith("?")) {
        supersedeStop();
        State.updateTask(agentId, "question");
        State.appendStep(agentId, message);
      }
      break;
    }

    case "Stop": {
      // Every Claude Code session shares this pill, and it holds whichever one
      // spoke last: often another, busier session. What finished is named from
      // this payload's own folder and session, never from the pill's leftovers.
      const pill = State.tasks.find((x) => x.id === agentId);
      if (pill && cwd) {
        if (isExternalAgent) pill.sessionCwd = cwd;
        else upsert(agentId, projectName, cwd, sessionId);
      }
      if (pill && sessionId) pill.sessionId = sessionId;
      State.updateTask(agentId, "finished");
      // Claude Code puts the turn's answer in the Stop payload itself, so there is
      // no transcript to read (the relay does not even forward its path). Other
      // agents report their last words the same way (Hermes, Codex) or as
      // `message`.
      const finalText = toOneLine(payload.last_assistant_message ?? payload.message ?? "");
      if (finalText) {
        State.appendStep(agentId, finalText);
        if (pill) pill.finalLine = finalText;
      }
      if (pill) {
        State.finishedTurns.set(agentId, {
          sessionId: sessionId || null,
          name: !isExternalAgent && cwd ? projectName : pill.name,
          cwd: cwd || null,
          finalLine: finalText || null,
        });
      }
      // Only the session in front is heard and seen: behind another app a
      // finish says nothing (the user's call; a notification is what speaks),
      // and neither does it over the chat.
      // Over an answer being said, it comes once that is over, unless the
      // session went back to work meanwhile (its turn is gone) or the chat opened.
      const done = State.finishedTurns.get(agentId);
      if (heard) {
        whenSaid(
          () => {
            Sound.play("finish");
            // The compact notch shows whose session it was, a moment.
            if (done) State.flashLogo(agentId, done.name);
            // A card waiting for an answer is never covered by another alert.
            if (!State.pendingApproval) surface("finished", true);
            else State.setPillBadge(agentId, "finished");
          },
          () => !State.chatting && State.finishedTurns.get(agentId) === done,
        );
      }
      cancelStopTimer(agentId);
      stopTimers.set(
        agentId,
        window.setTimeout(() => {
          stopTimers.delete(agentId);
          if (isExternalAgent) {
            State.removeTask(agentId);
          } else {
            State.updateTask(agentId, "idle");
            State.setPillBadge(agentId, null);
          }
        }, 5200),
      );
      break;
    }

    case "Interrupt":
      // Codex: the user stopped the turn. Back to idle, nothing to celebrate.
      supersedeStop();
      State.updateTask(agentId, "idle");
      State.setPillBadge(agentId, null);
      break;

    case "StopFailure":
      supersedeStop();
      State.updateTask(agentId, "error");
      // Over an answer being said, it comes once that is over, if still failed.
      whenSaid(
        () => {
          if (!State.chatting) Sound.play("error");
          if (heard && !State.chatting && !State.pendingApproval) surface("error", true);
          else State.setPillBadge(agentId, "error");
        },
        () => State.tasks.find((x) => x.id === agentId)?.state === "error",
      );
      break;

    case "SessionEnd": {
      dropFinishedTurn(agentId, sessionId);
      // Another Claude Code session ending leaves the shared pill to the one it
      // now shows (still working, or its finish on screen).
      const holder = State.tasks.find((x) => x.id === agentId)?.sessionId;
      if (!isExternalAgent && sessionId && holder && holder !== sessionId) break;
      // Nothing left for the timer to do, and it must not outlive the session: a
      // pill recreated within 5.2 s would be removed by it.
      cancelStopTimer(agentId);
      State.clearSessionDiffs(agentId);
      if (isExternalAgent) {
        State.removeTask(agentId);
      } else {
        State.updateTask(agentId, "idle");
        clearSession(agentId);
      }
      break;
    }

    case "SubagentStart":
      State.appendStep(agentId, t("+ subagent"));
      break;

    case "SubagentStop":
      State.appendStep(agentId, t("• subagent done"));
      break;

    case "PermissionRequest": {
      // Only Claude Code and the agents the relay can answer for (Codex, Copilot
      // CLI, Muse Code — same as the Mac) get a card. Anyone else's request is
      // declined at once, so the agent asks in its own terminal.
      if (isExternalAgent && !APPROVAL_AGENTS.has(validAgent!)) {
        if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
        break;
      }

      const requestId = payload.request_id ?? "";
      // One card, one request. A second one must never quietly replace the first
      // — that would leave a human staring at request B while request A waits for
      // a decision nobody can give. Hand it straight back to the terminal.
      if (State.pendingApproval && State.pendingApproval.requestId !== requestId) {
        if (requestId) void Bridge.approvalDecline(requestId);
        break;
      }
      ensurePill();
      supersedeStop();
      if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
      const tool = payload.tool_name ?? "Tool";
      const input = payload.tool_input ?? {};
      // Claude Code asking a question is not a permission to grant: the island
      // shows the options and sends back the one that was picked. Only Claude
      // Code asks questions this way.
      const questions = isExternalAgent ? null : askedQuestions(tool, input);
      const view = questions ? "question" : "approval";
      // The card always comes up, even over another pill or an island that is
      // already open: its pill comes to the front, and the one you were on
      // comes back once you answer (Mac #117, #120).
      State.beginApproval({
        requestId,
        sessionId,
        pillId: agentId,
        tool,
        command: approvalTarget(tool, input),
        ...(questions ? { questions } : {}),
      });
      // The relay's short ack window closes in 800 ms; everything below this
      // line is synchronous, so the card really is up by the time it lands.
      if (requestId) void Bridge.approvalAck(requestId);
      // Over the chat, answering it goes back to the chat.
      if (State.chatting) State.viewBeforeCard = "prompt";
      State.updateTask(agentId, view);
      // Any agent's card (Claude Code, Codex, Copilot CLI, Muse Code) comes up
      // the same way: beginApproval brought its pill to the front. Over an
      // answer being said, another session's waits for it to be over (if still
      // asked); the answer's own session's comes at once: the answer needs it.
      const ask = () => {
        Sound.play(view);
        island.alert(view);
      };
      if (State.fromChat(sessionId)) ask();
      else whenSaid(ask, () => State.pendingApproval?.requestId === requestId);
      // winotch answers within 108 s or not at all; after that the terminal has
      // taken over and the card would be lying.
      pendingTimeout = window.setTimeout(() => {
        pendingTimeout = null;
        dropPendingCard(island);
      }, 110_000);
      break;
    }

    default:
      break;
  }
  State.notify();
}
