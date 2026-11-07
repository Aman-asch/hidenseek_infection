'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');

/* ------------------------------------------------------------------ */
/* Minimal PNG encoder                                                 */
/* ------------------------------------------------------------------ */

let CRC_TABLE = null;

function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** draw(ctx) where ctx has { size, data, set(x, y, r, g, b, a) } */
function makePng(size, draw) {
  const data = Buffer.alloc(size * size * 4);
  const ctx = {
    size,
    data,
    set(x, y, r, g, b, a) {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      const i = (y * size + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    },
  };
  draw(ctx);

  // Each scanline is prefixed with a filter-type byte (0 = None).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;
    data.copy(raw, o, y * size * 4, (y + 1) * size * 4);
    o += size * 4;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);         // width
  ihdr.writeUInt32BE(size, 4);         // height
  ihdr[8] = 8;                         // bit depth
  ihdr[9] = 6;                         // colour type: RGBA
  ihdr[10] = 0;                        // compression: deflate
  ihdr[11] = 0;                        // filter: adaptive
  ihdr[12] = 0;                        // interlace: none

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* Icon artwork: green ring + green centre dot on a dark field        */
/* Drawn with 3x3 supersampling for smooth anti-aliased edges.        */
/* ------------------------------------------------------------------ */

function drawIcon({ size, set }, padding) {
  const cx = size / 2;
  const cy = size / 2;
  const maxR = size / 2;
  const outerR = maxR * (1 - padding); // outermost green ring edge
  const ringR = outerR * 0.62;         // inner edge of the green ring
  const dotR = outerR * 0.16;          // centre green dot

  const BG = [11, 15, 20];      // #0b0f14
  const GREEN = [61, 220, 132]; // #3ddc84
  const DARK = [11, 15, 20];    // gap between ring and dot

  const SS = 3; // supersample factor
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          const d = Math.hypot(px - cx, py - cy);
          let col;
          if (d <= dotR) col = GREEN;         // centre dot
          else if (d <= ringR) col = DARK;    // gap
          else if (d <= outerR) col = GREEN;  // ring
          else col = BG;                      // transparent corner -> bg colour
          r += col[0];
          g += col[1];
          b += col[2];
          a += 255;
        }
      }
      const n = SS * SS;
      set(
        x,
        y,
        Math.round(r / n),
        Math.round(g / n),
        Math.round(b / n),
        Math.round(a / n)
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

function generate() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const jobs = [
    ['icon-192.png', 192, 0.08],
    ['icon-512.png', 512, 0.08],
    ['icon-192-maskable.png', 192, 0.20],
    ['icon-512-maskable.png', 512, 0.20],
    ['apple-touch-icon.png', 180, 0.05],
  ];
  for (const [name, size, pad] of jobs) {
    const png = makePng(size, (ctx) => drawIcon(ctx, pad));
    fs.writeFileSync(path.join(OUT_DIR, name), png);
  }
  console.log('[icons] wrote', jobs.map((j) => j[0]).join(', '));
}

function ensureIcons() {
  const required = ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
  const missing = required.some((f) => !fs.existsSync(path.join(OUT_DIR, f)));
  if (missing) generate();
}

module.exports = { generate, ensureIcons };

if (require.main === module) generate();