// One-off helper: generates a 1024x1024 source PNG for `tauri icon`.
// Pure Node (zlib only) — no external dependencies.
// Run: node generate-source.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const SIZE = 1024;

function rgba(r, g, b, a = 255) {
  return [r, g, b, a];
}

// Phorma palette: deep charcoal background with a soft indigo "P" mark.
const bg = rgba(14, 15, 18);
const fg = rgba(124, 132, 255);

function inGlyph(x, y) {
  // Draw a rounded block "P" inside a centered safe area.
  const left = 360;
  const top = 240;
  const stemW = 150;
  const bowlW = 320;
  const height = 544;
  // Vertical stem.
  if (x >= left && x < left + stemW && y >= top && y < top + height) return true;
  // Upper bowl (filled rectangle with a hollow center).
  const bowlTop = top;
  const bowlH = 300;
  const outerRight = left + bowlW;
  if (x >= left && x < outerRight && y >= bowlTop && y < bowlTop + bowlH) {
    const innerLeft = left + stemW + 40;
    const innerRight = outerRight - 60;
    const innerTop = bowlTop + 60;
    const innerBottom = bowlTop + bowlH - 60;
    const hollow = x >= innerLeft && x < innerRight && y >= innerTop && y < innerBottom;
    return !hollow;
  }
  return false;
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
let p = 0;
for (let y = 0; y < SIZE; y++) {
  raw[p++] = 0; // filter byte: none
  for (let x = 0; x < SIZE; x++) {
    const [r, g, b, a] = inGlyph(x, y) ? fg : bg;
    raw[p++] = r;
    raw[p++] = g;
    raw[p++] = b;
    raw[p++] = a;
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
  }
  return ~c;
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);

writeFileSync(new URL('./app-icon.png', import.meta.url), png);
console.log('Wrote app-icon.png (1024x1024).');
