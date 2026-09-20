// make-icons.mjs — generate PNG app icons without any image dependency.
//
// iOS needs a real PNG for the home-screen icon (it will not use an SVG), and
// pulling in sharp/canvas for three small files is not worth the install. PNG
// is just IHDR + zlib-deflated scanlines + IEND, and Node ships zlib.
//
//   node test/make-icons.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');

// ── PNG encoding ────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** rgba: Uint8Array of size*size*4 */
function encodePNG(rgba, size) {
  const stride = size * 4;
  // Each scanline is prefixed with a filter byte; 0 = none.
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Drawing ─────────────────────────────────────────────────────────────────

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Signed distance to a rounded rectangle, for antialiased edges. */
function sdRoundRect(px, py, halfW, halfH, r) {
  const qx = Math.abs(px) - halfW + r;
  const qy = Math.abs(py) - halfH + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Distance from a point to a quadratic Bezier, sampled. Good enough here. */
function distToCurve(px, py, p0, p1, p2, samples = 220) {
  let best = Infinity;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const mt = 1 - t;
    const x = mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0];
    const y = mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1];
    const d = Math.hypot(px - x, py - y);
    if (d < best) best = d;
  }
  return best;
}

function blend(dst, i, r, g, b, a) {
  const ia = 1 - a;
  dst[i] = r * a + dst[i] * ia;
  dst[i + 1] = g * a + dst[i + 1] * ia;
  dst[i + 2] = b * a + dst[i + 2] * ia;
  dst[i + 3] = Math.max(dst[i + 3], a * 255);
}

function render(size) {
  const px = new Uint8Array(size * size * 4);
  const S = size / 512; // design is authored at 512

  // Flight arc: low-left to high-right, matching the SVG.
  const p0 = [84 * S, 404 * S];
  const p1 = [220 * S, 300 * S];
  const p2 = [436 * S, 108 * S];
  const strokeW = 26 * S;

  const ballC = [404 * S, 122 * S];
  const ballR = 34 * S;
  const teeC = [110 * S, 392 * S];
  const teeR = 16 * S;

  const half = size / 2;
  const corner = 114 * S;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const cx = x + 0.5 - half;
      const cy = y + 0.5 - half;

      // Rounded-rect mask with a 1px antialiased edge.
      const d = sdRoundRect(cx, cy, half, half, corner);
      const inside = clamp01(0.5 - d);
      if (inside <= 0) continue;

      // Background: near-black with a subtle vertical lift so the icon does
      // not read as a hole on a dark home screen.
      const lift = 10 * (1 - y / size);
      px[i] = lift; px[i + 1] = lift + 1; px[i + 2] = lift;
      px[i + 3] = inside * 255;

      // Arc.
      const dc = distToCurve(x + 0.5, y + 0.5, p0, p1, p2);
      const arcA = clamp01(strokeW / 2 - dc + 0.5) * inside;
      if (arcA > 0) blend(px, i, 0x5c, 0xf2, 0x85, arcA);

      // Tee dot.
      const dt = Math.hypot(x + 0.5 - teeC[0], y + 0.5 - teeC[1]);
      const teeA = clamp01(teeR - dt + 0.5) * inside;
      if (teeA > 0) blend(px, i, 0x5c, 0xf2, 0x85, teeA);

      // Ball.
      const db = Math.hypot(x + 0.5 - ballC[0], y + 0.5 - ballC[1]);
      const ballA = clamp01(ballR - db + 0.5) * inside;
      if (ballA > 0) {
        blend(px, i, 255, 255, 255, ballA);
        // Dimples, only where they fit inside the ball.
        for (const [ox, oy] of [[-12, -10], [8, -10], [-2, 6], [12, 10], [-12, 10]]) {
          const dd = Math.hypot(x + 0.5 - (ballC[0] + ox * S), y + 0.5 - (ballC[1] + oy * S));
          const dA = clamp01(4.5 * S - dd + 0.5) * ballA;
          if (dA > 0) blend(px, i, 0xcf, 0xcf, 0xcf, dA);
        }
      }
    }
  }
  return px;
}

for (const size of [180, 192, 512]) {
  const png = encodePNG(render(size), size);
  writeFileSync(join(OUT, `icon-${size}.png`), png);
  console.log(`icon-${size}.png  ${(png.length / 1024).toFixed(1)} KB`);
}
console.log('done');
