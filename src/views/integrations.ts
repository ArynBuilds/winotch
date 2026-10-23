// Integration cards shown in the overview's left card — DOM ports of
// IntegrationCardView and friends from IslandViewContent.swift. They present
// the built-ins' data (State.integrations, keyed by the app's registry id) on
// the pill the registry gives the app; Claude Code's idle card is here too.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { State, type AgentTask, type IntegrationInfo } from "../core/state";
import { Bridge } from "../core/bridge";
import { isComingSoon, pillDefinition } from "../core/pills";
import { refreshHookPills } from "../island/integrations";
import { readActivity, readPulse, readStats } from "../core/github";
import { githubDetail, githubPulseCard } from "./github";
import { N_, t } from "../i18n/i18n";

/** Same shape as the Swift `timeAgo` computed properties. */
export function timeAgo(value: unknown): string {
  const date = typeof value === "number" ? new Date(value) : new Date(String(value));
  const diff = (Date.now() - date.getTime()) / 1000;
  if (!Number.isFinite(diff)) return "";
  if (diff < 60) return t("just now");
  if (diff < 3600) return t("{n}m", { n: Math.floor(diff / 60) });
  if (diff < 86400) return t("{n}h", { n: Math.floor(diff / 3600) });
  return t("{n}d", { n: Math.floor(diff / 86400) });
}

function header(color: string, name: string, kind: string, extra?: Node): HTMLElement {
  const row = h("div", { class: "int-head" }, dot(color, 7), h("b", { text: name }), h("span", { text: kind }));
  if (extra) row.append(extra);
  return row;
}

/** What a built-in reported, by its registry id ("github"). */
function get(id: string): Record<string, unknown> {
  return (State.integrations[id]?.data ?? {}) as Record<string, unknown>;
}

/** What is known for a pill: its app's report, or Claude Code's hooks. */
function infoOf(pillId: string): IntegrationInfo | undefined {
  return State.integrations[State.appOf(pillId)?.id ?? pillId];
}

function arr(id: string, key: string): Record<string, unknown>[] {
  const v = get(id)[key];
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

// ── Not configured / idle ─────────────────────────────────────────────────────

const OPEN_URLS: Record<string, string> = {
  integration_github: "https://github.com",
  integration_stripe: "https://dashboard.stripe.com/payments",
  integration_notion: "https://notion.so",
};

/** IntegrationCardView.statusLabel on macOS. */
export function idleStatus(
  id: string,
  info: { configured: boolean; error: string | null } | undefined,
): { label: string; color: string } {
  if (isComingSoon(id)) return { label: t("Coming soon"), color: "#6B7079" };
  if (info?.error) return { label: info.error, color: "#ECECEC" };
  const configured = info?.configured ?? false;
  const def = pillDefinition(id);
  const app = State.appOf(id);
  const ok = (label: string) => ({ label, color: "#ECECEC" });
  const missing = (label: string) => ({ label, color: "#ECECEC" });
  // Pills driven by hooks never have a key: they are connected once the hooks
  // are in place (Mac #183). A session replaces this card; nothing is loading.
  if (def?.connect.kind === "hooks") return configured ? ok(t("Hooks installed")) : missing(t("Hooks not installed"));
  if (def?.connect.kind === "none" || app?.settings.kind === "none") return ok(t("Ready · no setup needed"));
  // What the registry says is missing ("Key not configured", a signed-out CLI).
  if (!configured && app?.problem) return missing(app.problem);
  return configured ? ok(t("Connected · loading…")) : missing(t("Key not configured"));
}

function idleCard(task: AgentTask, openSettings: () => void): HTMLElement {
  const info = infoOf(task.id);
  const configured = info?.configured ?? false;
  const def = pillDefinition(task.id);
  const status = idleStatus(task.id, info);

  const actions = h("div", { class: "int-actions" });
  if (task.id === "integration_claude") {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}b3`,
        text: t("Open Visual Studio Code"),
        onclick: () => void Bridge.openInVSCode(task.sessionCwd ?? null),
      }),
    );
  } else if (OPEN_URLS[task.id]) {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}d9`,
        text: t("Open {name}", { name: task.name }),
        onclick: () => void Bridge.openUrl(OPEN_URLS[task.id]),
      }),
    );
  }
  const hookPill = def?.connect.kind === "hooks";
  if (isComingSoon(task.id) || def?.connect.kind === "none" || State.appOf(task.id)?.settings.kind === "none") {
    // Nothing to set up, and nothing to refresh.
  } else if (configured) {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}d9`,
        text: t("Refresh"),
        // A hook pill has nothing to poll: look at its hooks again instead.
        onclick: () => void (hookPill ? refreshHookPills() : Bridge.refreshIntegration(task.app ?? task.id)),
      }),
    );
  } else if (!configured) {
    actions.append(
      h("button", { class: "link-btn", style: "color:#8e939c", text: t("Settings…"), onclick: openSettings }),
    );
  }

  return h(
    "div",
    { class: "int-card" },
    header(
      task.color,
      task.id === "integration_claude" ? def!.name : task.name,
      t(def?.subtitle ?? N_("Integration")),
    ),
    h("div", { class: "int-status" }, dot(status.color, 5), h("span", { text: status.label })),
    actions,
  );
}

// ── GitHub ────────────────────────────────────────────────────────────────────

function statRow(icon: string, color: string, label: string, value: string): HTMLElement {
  return h(
    "div",
    { class: "int-stat" },
    h("i", { class: "int-stat-icon", style: `color:${color}` }, svg(icon, 10)),
    h("span", { class: "int-stat-label", text: label }),
    h("span", { class: "int-stat-value", text: value }),
  );
}

function githubCard(): HTMLElement {
  const d = get("github");
  const stars = Number(d.totalStars ?? 0);
  const repos = Number(d.totalRepos ?? 0);
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return h(
    "div",
    { class: "int-card" },
    header("#ECECEC", "GitHub", t("Overview")),
    h(
      "div",
      { class: "int-stats" },
      statRow(ICONS.star, "#ECECEC", t("Total stars"), fmt(stars)),
      statRow(ICONS.stack, "#6B7079", t("Repositories"), String(repos)),
    ),
  );
}

// ── Stripe ────────────────────────────────────────────────────────────────────

function stripeCard(): HTMLElement {
  const d = get("stripe");
  const balance = (Number(d.balance ?? 0) / 100).toFixed(2);
  const currency = String(d.currency ?? "eur").toUpperCase();
  const rows = h("div", { class: "int-rows tight" });
  for (const p of arr("stripe", "payments").slice(0, 3)) {
    const success = p.status === "succeeded";
    const accent = success ? "#ECECEC" : "#ECECEC";
    rows.append(
      h(
        "div",
        { class: "int-row" },
        dot(accent, 5),
        h("span", { class: "int-name", text: String(p.description ?? t("Payment")) }),
        h("span", {
          class: "int-amount",
          style: "color:#ECECEC",
          text: `+${(Number(p.amount ?? 0) / 100).toFixed(2)}`,
        }),
        h("span", { class: "int-ago", text: timeAgo(p.createdAt) }),
      ),
    );
  }
  return h(
    "div",
    { class: "int-card" },
    header("#ECECEC", "Stripe", t("Payments")),
    h("div", { class: "int-balance" }, h("span", { text: balance }), h("i", { text: currency })),
    rows,
  );
}

// ── Notion ────────────────────────────────────────────────────────────────────

function notionCard(): HTMLElement {
  const rows = h("div", { class: "int-rows tight" });
  for (const p of arr("notion", "pages").slice(0, 3)) {
    rows.append(
      h(
        "button",
        {
          class: "int-page",
          onclick: () => {
            if (typeof p.url === "string") void Bridge.openUrl(p.url);
          },
        },
        p.emoji
          ? h("span", { class: "int-emoji", text: String(p.emoji) })
          : h("i", { class: "int-emoji" }, svg(ICONS.doc, 9)),
        h("span", { class: "int-name", text: String(p.title ?? t("Untitled")) }),
        h("span", { class: "int-ago", text: timeAgo(p.lastEditedAt) }),
      ),
    );
  }
  return h("div", { class: "int-card" }, header("#E8E8E8", "Notion", t("Recent")), rows);
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

export interface IntegrationCardHooks {
  detailOpen: boolean;
  openDetail(): void;
  closeDetail(): void;
  openSettings(): void;
}

/** True when the app on this pill has data worth showing instead of the idle card. */
export function hasIntegrationData(pillId: string): boolean {
  const app = State.appOf(pillId)?.id;
  const info = app ? State.integrations[app] : undefined;
  if (!app || !info || info.error) return false;
  switch (app) {
    case "github":
      return get(app).totalRepos != null || readPulse(get(app)) != null;
    case "stripe":
      return info.loaded;
    case "notion":
      return arr(app, "pages").length > 0;
    default:
      return false;
  }
}

export function renderIntegrationCard(task: AgentTask, hooks: IntegrationCardHooks): HTMLElement {
  if (!hasIntegrationData(task.id)) return idleCard(task, hooks.openSettings);

  const app = State.appOf(task.id)?.id;
  // With the pulse in, GitHub gets the Mac's richer card and its lists.
  if (app === "github") {
    const d = get(app);
    const pulse = readPulse(d);
    if (pulse) {
      return hooks.detailOpen
        ? githubDetail(pulse, readStats(d), readActivity(d), hooks.closeDetail)
        : githubPulseCard(pulse, readStats(d), readActivity(d), hooks.openDetail);
    }
  }

  switch (app) {
    case "github":
      return githubCard();
    case "stripe":
      return stripeCard();
    case "notion":
      return notionCard();
    default:
      return idleCard(task, hooks.openSettings);
  }
}

export { clear };
