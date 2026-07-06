// Generates assets/icon.png — a 256x256 glowing blue AI orb
// Run once: node generate-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const cx = SIZE / 2, cy = SIZE / 2, r = SIZE / 2 - 4;

// Build raw RGBA pixel data
const pixels = Buffer.alloc(SIZE * SIZE * 4);

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const dx = x - cx, dy = y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const idx = (y * SIZE + x) * 4;

    if (dist > r + 8) {
      // Fully transparent outside outer glow
      pixels[idx] = pixels[idx+1] = pixels[idx+2] = pixels[idx+3] = 0;
      continue;
    }

    // Outer glow halo
    if (dist > r) {
      const glowFade = 1 - (dist - r) / 8;
      pixels[idx]   = 0;
      pixels[idx+1] = Math.round(150 * glowFade);
      pixels[idx+2] = Math.round(255 * glowFade);
      pixels[idx+3] = Math.round(80 * glowFade);
      continue;
    }

    // Inside the orb — radial gradient (light blue center → deep blue edge)
    const t = dist / r; // 0 = center, 1 = edge

    // Highlight offset (top-left bright spot)
    const hx = cx - r * 0.25, hy = cy - r * 0.25;
    const hdist = Math.sqrt((x - hx) ** 2 + (y - hy) ** 2) / (r * 0.55);
    const highlight = Math.max(0, 1 - hdist);

    const baseR = Math.round(20  + 200 * Math.pow(1 - t, 2.5) + 200 * highlight * Math.pow(1 - t, 1));
    const baseG = Math.round(80  + 140 * Math.pow(1 - t, 2)   + 180 * highlight * Math.pow(1 - t, 1.2));
    const baseB = Math.round(160 + 95  * Math.pow(1 - t, 1.5) + 255 * highlight * Math.pow(1 - t, 0.8));

    // Thin rim glow at edge
    const rim = t > 0.85 ? (t - 0.85) / 0.15 : 0;

    pixels[idx]   = Math.min(255, baseR + Math.round(0   * rim));
    pixels[idx+1] = Math.min(255, baseG + Math.round(180 * rim));
    pixels[idx+2] = Math.min(255, baseB + Math.round(255 * rim));
    pixels[idx+3] = 255;
  }
}

// Build PNG
function crc32(buf) {
  const table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(data.length);
  const crcInput = Buffer.concat([typeBytes, data]);
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(crcInput));
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

// IHDR
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

// IDAT: add filter byte (0) before each row, then deflate
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
for (let y = 0; y < SIZE; y++) {
  raw[y * (1 + SIZE * 4)] = 0;
  pixels.copy(raw, y * (1 + SIZE * 4) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const compressed = zlib.deflateSync(raw, { level: 6 });

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG signature
  chunk('IHDR', ihdr),
  chunk('IDAT', compressed),
  chunk('IEND', Buffer.alloc(0)),
]);

const outPath = path.join(__dirname, 'assets', 'icon.png');
fs.writeFileSync(outPath, png);
console.log('Icon saved to', outPath, `(${png.length} bytes)`);
