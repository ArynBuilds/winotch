// The island's pills. Claude Code is the main pill: always there, always first,
// driven by its hooks, and not an app. Every other pill is an app of the one
// registry (src-tauri/src/apps.rs, core/apps.ts): `registryPills` derives them
// from its snapshot, and nothing else decides which apps have a pill.
//
// The main pill's ID is a contract value (hook routing, the recap), so it
// never changes once shipped. So do the built-ins' pill ids, which the
// registry declares (`AppInfo.pill`).

import type { AgentSource } from "./state";
import type { AppInfo } from "./apps";
import { N_ } from "../i18n/i18n";

export type PillCategory = "workspace" | "service";

/**
 * Whether the pill does anything on this build:
 * - `yes`: works on Windows and Linux;
 * - `windows`: Windows only (the app behind it has no Linux build);
 * - `linux`: Linux only (what drives it is Linux's);
 * - `soon`: can be declared, shows "Coming soon" (macOS has it, this build not yet);
 * - `no`: macOS only, never offered here.
 */
export type PillSupport = "yes" | "windows" | "linux" | "soon" | "no";

/** What makes the pill connected. */
export type PillConnect =
  /** Hook events: connected once the hooks are installed (Mac #183). */
  | { kind: "hooks" }
  /** A key in the credential store. */
  | { kind: "key"; key: string }
  /** Nothing to set up. */
  | { kind: "none" };

export interface PillDefinition {
  id: string;
  name: string;
  color: string;
  category: PillCategory;
  /** Label next to the pill name in the idle card header (an English key, shown with `t()`). */
  subtitle: string;
  source: AgentSource;
  support: PillSupport;
  connect: PillConnect;
}

export type HostOs = "windows" | "linux";

/** Claude Code: the one pill that is not an app. */
export const PILL_CATALOG: readonly PillDefinition[] = [
  { id: "integration_claude", name: "Claude Code", color: "#F5F6F8", category: "workspace",
    subtitle: N_("Integration"), source: "claudeCode", support: "yes", connect: { kind: "hooks" } },
];

/** Claude Code: the main pill, always there, never a setting. */
export const MAIN_PILL = "integration_claude";

/** The OS this page runs on. Only the Windows webview says "Windows". */
export const HOST_OS: HostOs =
  typeof navigator !== "undefined" && /Windows/.test(navigator.userAgent ?? "") ? "windows" : "linux";

export function pillDefinition(id: string): PillDefinition | undefined {
  return PILL_CATALOG.find((p) => p.id === id);
}

export function isComingSoon(id: string): boolean {
  return pillDefinition(id)?.support === "soon";
}

/** True for pills whose sessions arrive as hook events (Mac #183). */
export function isHookPill(id: string): boolean {
  return pillDefinition(id)?.connect.kind === "hooks";
}

/** PillDefinition.sessionSubtitle — next to the name in a live session's card. */
export function sessionSubtitle(id: string): string {
  return id === MAIN_PILL ? "Claude Code" : N_("Agent");
}

/** A pill an app of the registry has on the island. */
export interface RegistryPill {
  /** The pill's id ("integration_github", "app_gtm"). */
  id: string;
  /** The app's registry id ("github", "gtm"). */
  app: string;
  name: string;
}

/**
 * The island's app pills, from the registry and nothing else, in the
 * island's order: the built-ins as the registry lists them, then the apps
 * from the API by name. An app has one when it is shown and available (Gmail
 * only once it has an account); what speaks through Claude Code's own pill
 * (Claude's MCP posts) has none of its own.
 */
export function registryPills(apps: readonly AppInfo[]): RegistryPill[] {
  const on = apps.filter((a) => a.shown && a.available && a.pill !== MAIN_PILL);
  const builtins = on.filter((a) => a.kind === "builtin");
  const api = on.filter((a) => a.kind !== "builtin").sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return [...builtins, ...api].map((a) => ({ id: a.pill, app: a.id, name: a.name }));
}
