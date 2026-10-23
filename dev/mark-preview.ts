// The mark's moves laid out frame by frame, to check them against the film
// without building the app. Open /dev/mark-preview.html on the Vite dev server.

import { BIRTH_END, CROSS_END, MarkSvg, birth, crossing, rest, scrub, type MarkPose } from "../src/mark/liquid";

const U = 20;
const W = 130;
const H = 56;
const root = document.getElementById("root")!;

function row(title: string, frames: [string, MarkPose][]) {
  const h = document.createElement("h2");
  h.textContent = title;
  const r = document.createElement("div");
  r.className = "row";
  for (const [label, pose] of frames) {
    const fig = document.createElement("figure");
    const mark = new MarkSvg();
    mark.size(W, H);
    mark.draw(pose, W / 2, H / 2, U);
    const cap = document.createElement("figcaption");
    cap.textContent = label;
    fig.append(mark.el, cap);
    r.append(fig);
  }
  root.append(h, r);
}

const steps = (end: number, n: number) => Array.from({ length: n + 1 }, (_, i) => (end * i) / n);

row("At rest", [["dot right", rest(1)], ["dot left", rest(-1)]]);
row("Birth", steps(BIRTH_END, 14).map((t) => [`${t.toFixed(2)} s`, birth(t)]));
row("Crossing to the left", steps(CROSS_END, 14).map((t) => [`${t.toFixed(2)} s`, crossing(-1, t)]));
row("Crossing to the right", steps(CROSS_END, 14).map((t) => [`${t.toFixed(2)} s`, crossing(1, t)]));
row("Following the pointer (0 = right third, 1 = left third)", steps(1, 14).map((p) => [`${Math.round(p * 100)} %`, scrub(p)]));
