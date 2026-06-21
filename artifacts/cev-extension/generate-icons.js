/**
 * Génère les icônes PNG pour l'extension (sans dépendances externes).
 * Crée des PNG minimalistes en pure Node.js.
 * Usage : node generate-icons.js
 */

const { createCanvas } = (() => {
  try { return require('canvas'); } catch { return null; }
})() || {};

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── PNG pur Node.js (sans canvas) ────────────────────────────────────────────

function crc32(buf) {
  let crc = 0xffffffff;
  const table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })();
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcData = Buffer.concat([typeBytes, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData), 0);
  return Buffer.concat([len, typeBytes, data, crc]);
}

function createPng(size, r, g, b) {
  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Image data (raw scanlines)
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0; // filter none
    for (let x = 0; x < size; x++) {
      // Gradient circle effect
      const cx = size / 2, cy = size / 2;
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      const radius = size * 0.42;
      const isInCircle = dist <= radius;
      const isInner = dist <= radius * 0.65;

      let pr = 15, pg = 15, pb = 19; // background: #0f0f13
      if (isInCircle) {
        // Border zone: slightly lighter
        const t = isInner ? 1 : (radius - dist) / (radius * 0.35);
        pr = Math.round(r * t);
        pg = Math.round(g * t);
        pb = Math.round(b * t);
      }

      const px = row + 1 + x * 3;
      raw[px]     = pr;
      raw[px + 1] = pg;
      raw[px + 2] = pb;
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Génération des icônes ─────────────────────────────────────────────────────

const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir);

// Couleur : orange/ambre (#f59e0b) — identifiable et distinctif
const R = 245, G = 158, B = 11;

const sizes = [16, 48, 128];
for (const size of sizes) {
  const png = createPng(size, R, G, B);
  const outPath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`✅ icons/icon${size}.png (${size}x${size}) — ${png.length} bytes`);
}

console.log('\nIcônes générées dans le dossier icons/');
