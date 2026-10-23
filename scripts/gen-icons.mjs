// Draws the Tent.js mark into the PNG/ICO set Tauri needs. No dependencies: the
// icons are rasterised here and encoded with node:zlib, so the app icon stays
// "drawn in code" like the mark itself.
//
//   node scripts/gen-icons.mjs

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");

// ── The Tent.js mark ──────────────────────────────────────────────────────────
// The brand (WINOTCH.md): one dash 2.3 U long and one dot U wide, round ends,
// light #ECECEC, alone on a transparent ground (the user's call: no square
// behind it). Small icons take the brand's bolder cut, a narrower gap, so the
// shapes stay thick at 16 and 32 pixels.

const INK = [236, 236, 236]; // #ECECEC
const DASH = 2.3;

const SS = 4; // supersampling factor

/** A capsule from x0 to x1, `u` thick, centred on y = 0. */
function insideCapsule(x, y, x0, x1, u) {
  const r = u / 2;
  const cx = Math.max(x0 + r, Math.min(x1 - r, x));
  return (x - cx) ** 2 + y * y <= r * r;
}

function renderMark(size) {
  const px = new Uint8Array(size * size * 4);
  const gap = size <= 32 ? 0.3 : 0.45;
  const width = DASH + gap + 1;
  // With no square around it, the mark takes 94 % of the icon's width.
  const u = 0.94 / width;
  const left = -0.47;
  const dashEnd = left + DASH * u;
  const dotX = dashEnd + gap * u + u / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let ink = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = (x + (sx + 0.5) / SS) / size - 0.5;
          const fy = (y + (sy + 0.5) / SS) / size - 0.5;
          if (insideCapsule(fx, fy, left, dashEnd, u) || (fx - dotX) ** 2 + fy * fy <= (u / 2) ** 2) ink++;
        }
      }
      // The ink alone: its coverage is the pixel's opacity.
      const o = (y * size + x) * 4;
      for (let i = 0; i < 3; i++) px[o + i] = INK[i];
      px[o + 3] = Math.round((ink / (SS * SS)) * 255);
    }
  }
  return px;
}

// ── PNG ───────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── ICO (PNG-in-ICO, Vista and later) ─────────────────────────────────────────

function encodeICO(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0;
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

// ── Go ────────────────────────────────────────────────────────────────────────

mkdirSync(OUT, { recursive: true });

const png = (size) => encodePNG(size, renderMark(size));

const files = {
  "32x32.png": png(32),
  "128x128.png": png(128),
  "128x128@2x.png": png(256),
  "icon.png": png(512),
};
for (const [name, data] of Object.entries(files)) {
  writeFileSync(join(OUT, name), data);
  console.log(`${name} — ${data.length} bytes`);
}

const ico = encodeICO([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: png(size) })));
writeFileSync(join(OUT, "icon.ico"), ico);
console.log(`icon.ico — ${ico.length} bytes`);
