// Draws the Ringkeeper ring as PNGs (no image tools needed). Run once; the
// output is committed under apps/desktop/assets/.
//   node scripts/make-icons.mjs
import fs from "node:fs";
import zlib from "node:zlib";

const out = "apps/desktop/assets";
fs.mkdirSync(out, { recursive: true });

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Coverage (0..1) of a ring, 4x4 supersampled. Placeholder until the M5 icon. */
function ringCoverage(size) {
  const c = size / 2;
  const outer = size * 0.42;
  const inner = size * 0.27;
  return (x, y) => {
    let hits = 0;
    for (let sy = 0; sy < 4; sy++) {
      for (let sx = 0; sx < 4; sx++) {
        const px = x + (sx + 0.5) / 4;
        const py = y + (sy + 0.5) / 4;
        const d = Math.hypot(px - c, py - c);
        const inRing = d <= outer && d >= inner;

        if (inRing) hits++;
      }
    }
    return hits / 16;
  };
}

function write(name, size, rgb) {
  const cov = ringCoverage(size);
  fs.writeFileSync(`${out}/${name}`, png(size, (x, y) => [...rgb, Math.round(255 * cov(x, y))]));
  console.log(`wrote ${out}/${name}`);
}

const teal = [15, 118, 110];
write("tray.png", 16, teal);
write("tray@2x.png", 32, teal);
// macOS menu bar: black + alpha, named *Template so macOS tints it.
write("trayTemplate.png", 16, [0, 0, 0]);
write("trayTemplate@2x.png", 32, [0, 0, 0]);
write("icon.png", 512, teal);
