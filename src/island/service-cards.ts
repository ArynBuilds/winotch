// What the island's service pills show, as small read-only cards for « OK Tent »
// (voice.ts): a headline, why, and three lines, kept short on purpose.
//
// What never goes in a card: a payment's description (Stripe), a link, a token.
// A card says what the pill's own header says and counts, nothing a click would reveal.

import { State } from "../core/state";
import { t } from "../i18n/i18n";

export interface ServiceCard {
  id: string;
  title: string;
  headline: string;
  reason?: string;
  items: { label: string; detail: string }[];
}

const obj = (id: string): Record<string, unknown> => (State.integrations[id]?.data ?? {}) as Record<string, unknown>;
const list = (id: string, key: string): Record<string, unknown>[] => {
  const v = obj(id)[key];
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
};

/** "just now", "5m", "2h", "3d": the shorthand the pills use. */
export function ago(value: unknown, now = Date.now()): string {
  const date = typeof value === "number" ? new Date(value) : new Date(String(value));
  const secs = (now - date.getTime()) / 1000;
  if (!Number.isFinite(secs)) return "";
  if (secs < 60) return t("just now");
  if (secs < 3600) return t("{n}m", { n: Math.floor(secs / 60) });
  if (secs < 86400) return t("{n}h", { n: Math.floor(secs / 3600) });
  return t("{n}d", { n: Math.floor(secs / 86400) });
}

const money = (cents: unknown) => (Number(cents ?? 0) / 100).toFixed(2);
const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

type Builder = (now: number) => ServiceCard;

function usable(id: string): boolean {
  const info = State.integrations[id];
  return !!info && info.configured && !info.error;
}

/** By the app's registry id, as its poller's data is kept (State.integrations). */
const BUILDERS: Record<string, Builder> = {
  stripe: (now) => {
    const d = obj("stripe");
    return {
      id: "stripe", title: "Stripe",
      headline: `${money(d.balance)} ${String(d.currency ?? "eur").toUpperCase()}`,
      reason: t("Payments"),
      items: list("stripe", "payments").slice(0, 3).map((p) => ({
        label: p.status === "succeeded" ? t("Payment") : t("Payment failed"),
        detail: `+${money(p.amount)} · ${ago(p.createdAt, now)}`,
      })),
    };
  },
  github: () => {
    const d = obj("github");
    return {
      id: "github", title: "GitHub",
      headline: `${compact(Number(d.totalStars ?? 0))} ${t("Total stars")}`,
      reason: t("Overview"),
      items: [{ label: t("Repositories"), detail: String(Number(d.totalRepos ?? 0)) }],
    };
  },
  notion: (now) => {
    const pages = list("notion", "pages");
    return {
      id: "notion", title: "Notion",
      headline: String(Math.min(pages.length, 3)),
      reason: t("Recent"),
      items: pages.slice(0, 3).map((p) => ({ label: String(p.title ?? t("Untitled")), detail: ago(p.lastEditedAt, now) })),
    };
  },
};

/** The cards of the services the island has data for. */
export function serviceCards(now = Date.now()): ServiceCard[] {
  return Object.entries(BUILDERS)
    .filter(([id]) => usable(id))
    .map(([, build]) => build(now));
}
