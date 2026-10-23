// An app's own logo, wherever the island names an app: its pill, its card, the
// feed. Known apps carry their brand mark (core/logos.ts) in the island's one
// colour; an app that joined through the API may send its own picture (an
// image, never markup); anything else shows its initial.

import { Feed } from "../core/apps";
import { INK } from "../core/brand";
import { LOGOS } from "../core/logos";
import { MAIN_PILL } from "../core/pills";

const NS = "http://www.w3.org/2000/svg";

/**
 * The logo of the pill `id` ("integration_github", "app_gtm"…), `size` pixels
 * square: the mark the registry names for its app, else Claude Code's.
 */
export function logoElement(id: string, name: string, size: number): Element {
  const app = Feed.byPill(id);
  const path = LOGOS[app?.logo ?? (id === MAIN_PILL ? "claude" : "")];
  if (path) {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("aria-hidden", "true");
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", path);
    p.setAttribute("fill", INK);
    svg.append(p);
    return svg;
  }
  const icon = app?.icon;
  if (icon) {
    const img = document.createElement("img");
    img.src = icon;
    img.alt = "";
    img.width = size;
    img.height = size;
    img.style.objectFit = "contain";
    return img;
  }
  const initial = document.createElement("span");
  initial.className = "logo-initial";
  initial.textContent = (name.trim()[0] ?? "?").toUpperCase();
  initial.style.width = `${size}px`;
  initial.style.height = `${size}px`;
  initial.style.fontSize = `${Math.round(size * 0.58)}px`;
  return initial;
}
