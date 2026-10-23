// The notifications tab (WINOTCH.md): one feed for every app that joined
// winotch, newest first. Filter it to one app, mark it read, press an action:
// the app hears of the press and does the work. Nothing is sent from here
// without that press.

import { AppsBridge, Feed, ago, pillOfApp, type AppNotification } from "../core/apps";
import { DASH, GAP, INK } from "../core/brand";
import { logoElement } from "./logo";
import { State } from "../core/state";
import { ICONS } from "./icons";
import { clear, h, svg } from "./dom";
import type { ViewActions, ViewHost } from "./views";
import type { AppViewHost } from "./appdetail";
import { t } from "../i18n/i18n";

const NS = "http://www.w3.org/2000/svg";

/** An app's sign, `u` pixels thick, standing still. */
export function signElement(sign: string, u: number): SVGSVGElement {
  let x = 0;
  const el = document.createElementNS(NS, "svg");
  el.setAttribute("fill", INK);
  for (const part of sign) {
    if (part === "-") {
      const r = document.createElementNS(NS, "rect");
      r.setAttribute("x", String(x));
      r.setAttribute("width", String(DASH * u));
      r.setAttribute("height", String(u));
      r.setAttribute("rx", String(u / 2));
      el.append(r);
      x += (DASH + GAP) * u;
    } else {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", String(x + u / 2));
      c.setAttribute("cy", String(u / 2));
      c.setAttribute("r", String(u / 2));
      el.append(c);
      x += (1 + GAP) * u;
    }
  }
  const w = x - GAP * u;
  el.setAttribute("width", w.toFixed(2));
  el.setAttribute("height", String(u));
  el.setAttribute("viewBox", `0 0 ${w} ${u}`);
  return el;
}


/** `appView`: the expanded app, where a notification about one of its items opens. */
export function buildNotifications(actions: ViewActions, appView?: Pick<AppViewHost, "openItem">): ViewHost {
  const filters = h("div", { class: "feed-filters" });
  const markAll = h("button", { class: "feed-link", text: "Mark all read" });
  markAll.addEventListener("click", () => void AppsBridge.read(null, Feed.filter));
  const list = h("div", { class: "feed-list" });
  const error = h("div", { class: "feed-error" });
  const el = h(
    "div",
    { class: "view feed" },
    h("div", { class: "card feed-card" },
      h("div", { class: "feed-head" }, filters, markAll),
      error,
      list,
    ),
  );

  function filterChip(id: string | null, label: string, unread: number): HTMLElement {
    const on = Feed.filter === id;
    const chip = h("button", { class: on ? "feed-chip on" : "feed-chip" });
    if (id) chip.append(logoElement(pillOfApp(id), Feed.app(id)?.name ?? id, 12));
    chip.append(h("span", { text: label }));
    if (unread > 0) chip.append(h("span", { class: "feed-count", text: String(unread) }));
    chip.addEventListener("click", () => {
      Feed.filter = id;
      State.notify();
    });
    return chip;
  }

  function row(n: AppNotification): HTMLElement {
    const app = Feed.app(n.app);
    const item = h("div", { class: n.read ? "feed-item" : "feed-item unread" });
    const text = h("div", { class: "feed-text" },
      h("div", { class: "feed-title", text: n.title }),
      n.body ? h("div", { class: "feed-body", text: n.body }) : null,
    );
    const meta = h("div", { class: "feed-meta" },
      logoElement(pillOfApp(n.app), app?.name ?? n.app, 11),
      h("span", { text: `${app?.name ?? n.app} · ${ago(n.time)}` }),
    );
    const buttons = h("div", { class: "feed-actions" });
    if (n.acted) {
      const label = n.actions.find((a) => a.id === n.acted)?.label ?? n.acted;
      buttons.append(h("span", { class: "feed-done" }, svg(ICONS.check, 11, { stroke: 2.4 }), label));
    } else {
      n.actions.forEach((a, i) => {
        const b = h("button", { class: i === 0 ? "btn primary small" : "btn secondary small", text: a.label });
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          actions.blip();
          AppsBridge.act(n.id, a.id).then(
            () => { Feed.error = null; State.notify(); },
            (err) => { Feed.error = String(err); State.notify(); },
          );
        });
        buttons.append(b);
      });
    }
    const dismiss = h("button", { class: "feed-dismiss", title: "Dismiss" }, svg(ICONS.xmark, 10));
    dismiss.addEventListener("click", (e) => {
      e.stopPropagation();
      void AppsBridge.dismiss(n.id);
    });
    item.append(h("div", { class: "feed-main" }, meta, text), buttons, dismiss);
    // A press on the row reads it, and opens what it is about: the item in
    // its app, expanded (a mail, opened), else where it points.
    item.addEventListener("click", () => {
      if (!n.read) void AppsBridge.read(n.id);
      if (n.item && appView?.openItem(n.app, n.item)) {
        actions.blip();
        return;
      }
      if (n.url) actions.openUrl(n.url);
    });
    return item;
  }

  let lastKey = "";
  return {
    el,
    sync() {
      const shown = Feed.shown;
      const key = JSON.stringify([Feed.filter, Feed.error, Feed.apps.map((a) => a.id + a.name),
        shown.map((n) => [n.id, n.read, n.acted]), Math.floor(Date.now() / 60000)]);
      if (key === lastKey) return;
      lastKey = key;

      clear(filters);
      const unreadOf = (app: string) => Feed.notifications.filter((n) => n.app === app && !n.read).length;
      filters.append(filterChip(null, t("All"), Feed.unread));
      for (const app of Feed.apps) {
        if (Feed.notifications.some((n) => n.app === app.id)) filters.append(filterChip(app.id, app.name, unreadOf(app.id)));
      }
      markAll.style.visibility = shown.some((n) => !n.read) ? "visible" : "hidden";
      error.textContent = Feed.error ?? "";
      error.style.display = Feed.error ? "" : "none";

      clear(list);
      if (shown.length === 0) {
        list.append(h("div", { class: "feed-empty" },
          h("div", { class: "title", text: "Nothing new" }),
          h("div", { class: "sub", text: Feed.apps.length
            ? "What your apps send shows up here."
            : "Apps that join winotch send their notifications here." }),
        ));
        return;
      }
      for (const n of shown.slice(0, 60)) list.append(row(n));
    },
  };
}
