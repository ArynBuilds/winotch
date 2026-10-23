// Claude Code's sessions, as the chat sees them (src-tauri/src/sessions.rs).
// The chat's picker lists them: an id picks a session, "new:<folder>" starts
// one in that folder, "quick" is a quick question that is not saved
// (Settings.chatSession holds the pick).

import { invoke } from "@tauri-apps/api/core";

const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const NEW = "new:";

export interface SessionInfo {
  id: string;
  cwd: string;
  project: string;
  title: string;
  updated: number;
}

export interface SessionMessage {
  role: "user" | "assistant" | "tool";
  text: string;
}

/** What a send reports as it goes (session-stream events). */
export interface SessionStream {
  request: number;
  session: string;
  kind: "start" | "delta" | "tool" | "done" | "error";
  text: string;
}

export interface SessionMessages {
  stamp: string;
  messages: SessionMessage[] | null;
}

export const ClaudeSessions = {
  list: async (): Promise<SessionInfo[]> => (IS_TAURI ? invoke<SessionInfo[]>("sessions_list") : []),
  /** The conversation, or `messages: null` when it is as `seen` (the last stamp) left it. */
  messages: async (id: string, seen: string | null = null): Promise<SessionMessages> =>
    IS_TAURI ? invoke<SessionMessages>("session_messages", { id, seen }) : { stamp: "", messages: [] },
  /** Resolves with the session's id when Claude Code has answered. */
  send: (request: number, target: string, text: string, flags: ModelFlags = {}): Promise<string> => {
    if (!IS_TAURI) return Promise.reject(new Error("not running inside winotch"));
    const fresh = isNew(target);
    return invoke<string>("session_send", {
      request,
      id: fresh ? null : target,
      cwd: fresh ? target.slice(NEW.length) : null,
      text,
      model: flags.model || null,
      effort: flags.effort || null,
    });
  },
};

/** The chat's model and effort: an alias / level, or none for Claude Code's default. */
export interface ModelFlags {
  model?: string;
  effort?: string;
}

/** Model aliases and effort levels `claude --model` / `--effort` take (sessions.rs). */
export const MODELS = ["opus", "sonnet", "fable"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * A quick question: not saved, nothing on disk. One `claude` keeps the quick
 * conversation's context until it is reset (sessions.rs `quick_send`).
 */
export const Quick = {
  /** Resolves when Claude Code has answered: `true` if a new conversation began for it. */
  send: (request: number, text: string, flags: ModelFlags = {}): Promise<boolean> =>
    IS_TAURI
      ? invoke<boolean>("quick_send", { request, text, model: flags.model || null, effort: flags.effort || null })
      : Promise.reject(new Error("not running inside winotch")),
  /** Ends the quick conversation and its `claude`. */
  reset: (): Promise<void> => (IS_TAURI ? invoke<void>("quick_reset") : Promise.resolve()),
};

export const QUICK = "quick";
export const isQuick = (target: string | null | undefined) => target === QUICK;

/** Open sessions are reached through their own terminal: winotch types into it. */
export const Consoles = {
  /** The open sessions winotch can type into now. */
  reachable: async (): Promise<string[]> => (IS_TAURI ? invoke<string[]>("sessions_reachable") : []),
  /** Types `text` into that session's terminal and enters it. */
  type: (id: string, text: string): Promise<void> =>
    IS_TAURI ? invoke<void>("session_type", { id, text }) : Promise.resolve(),
};

export const isNew = (target: string) => target.startsWith(NEW);
export const newIn = (cwd: string) => NEW + cwd;

/** A folder's last part, as the island names projects. */
export const folderName = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
