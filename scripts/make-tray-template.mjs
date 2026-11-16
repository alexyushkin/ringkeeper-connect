// macOS menu bar icons should be "template" images: black with transparency,
// so macOS can tint them for light and dark menu bars. This turns the
// Ringkeeper tray icon (from the ringkeeper repo) into one, keeping its shape.
//   node scripts/make-tray-template.mjs
import fs from "node:fs";
import zlib from "node:zlib";

const dir = "apps/desktop/assets";

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** Decode an 8-bit RGBA, non-interlaced PNG into rows of RGBA bytes. */
function decode(buf) {
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (buf[24] !== 8 || buf[25] !== 6 || buf[28] !== 0) throw new Error("expected 8-bit RGBA non-interlaced PNG");
  const idat = [];
  for (let o = 8; o < buf.length; ) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString("ascii", o + 4, o + 8);
    if (type === "IDAT") idat.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= 4 ? px[y * stride + x - 4] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? px[(y - 1) * stride + x - 4] : 0;
      let out;
      if (f === 0) out = v;
      else if (f === 1) out = v + a;
      else if (f === 2) out = v + b;
      else if (f === 3) out = v + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      px[y * stride + x] = out & 0xff;
    }
  }
  return { width, height, px };
}

function encode(width, height, px) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) px.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const src = decode(fs.readFileSync(`${dir}/tray@2x.png`));
// The icon is a bright ring and keys on a dark tile. Keep only the bright
// parts as the shape (black, with opacity from brightness); the tile drops out.
const black = Buffer.from(src.px);
for (let i = 0; i < black.length; i += 4) {
  const lum = 0.2126 * src.px[i] + 0.7152 * src.px[i + 1] + 0.0722 * src.px[i + 2];
  const shape = Math.min(1, Math.max(0, (lum - 60) / 60));
  black[i] = black[i + 1] = black[i + 2] = 0;
  black[i + 3] = Math.round(src.px[i + 3] * shape);
}
fs.writeFileSync(`${dir}/trayTemplate@2x.png`, encode(src.width, src.height, black));

// Half size: average each 2x2 block's opacity.
const w = src.width / 2, h = src.height / 2;
const small = Buffer.alloc(w * h * 4);
for (let y = 0; y < h; y++)
  for (let x = 0; x < w; x++) {
    let a = 0;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) a += black[((y * 2 + dy) * src.width + (x * 2 + dx)) * 4 + 3];
    small[(y * w + x) * 4 + 3] = Math.round(a / 4);
  }
fs.writeFileSync(`${dir}/trayTemplate.png`, encode(w, h, small));
console.log("wrote trayTemplate.png and trayTemplate@2x.png");
