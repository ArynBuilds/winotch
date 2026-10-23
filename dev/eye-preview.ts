// The mark's eye looking at a pointer in each direction, settled. `npm run dev`,
// then open /dev/eye-preview.html. Not shipped in the app.

import { MarkEngine } from "../src/mark/engine";

const root = document.getElementById("root")!;
const D = 300;
const cases: [string, { x: number; y: number } | null][] = [
  ["no pointer", null],
  ["on the dot", { x: 0, y: 0 }],
  ["right", { x: D, y: 0 }],
  ["up-right", { x: D * 0.7, y: -D * 0.7 }],
  ["up", { x: 0, y: -D }],
  ["up-left", { x: -D * 0.7, y: -D * 0.7 }],
  ["left", { x: -D, y: 0 }],
  ["down-left", { x: -D * 0.7, y: D * 0.7 }],
  ["down", { x: 0, y: D }],
  ["down-right", { x: D * 0.7, y: D * 0.7 }],
  ["far right", { x: 2000, y: 0 }],
  ["far left", { x: -2000, y: 0 }],
];

for (const [label, look] of cases) {
  const engine = new MarkEngine();
  engine.look = look;
  for (let i = 0; i < 120; i++) engine.update(1 / 60);
  const canvas = document.createElement("canvas");
  canvas.width = 220;
  canvas.height = 120;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#141414";
  ctx.fillRect(0, 0, 220, 120);
  engine.paint(ctx, 220, 120, 150);
  const figure = document.createElement("figure");
  figure.append(canvas, label);
  root.append(figure);
}
