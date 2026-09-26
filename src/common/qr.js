// Minimal QR Code encoder (ISO/IEC 18004), for showing the receive page's URL
// on the sender's screen: byte mode, versions 1-10, error correction levels
// L / M / Q / H. No dependencies; Reed-Solomon from rs.js (same field and
// generator convention as QR: 0x11d, roots alpha^0 ... alpha^(n-1)).
//
//   const { size, modules } = encodeQr('https://example.test/receive.html');
//   modules[y * size + x] === 1  -> dark module (no quiet zone included)

import { rsEncode } from './rs.js';

const MAX_VERSION = 10;
// Per level (L, M, Q, H) and version 1-10.
const ECC_PER_BLOCK = {
  L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  H: [17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
};
const BLOCKS = {
  L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  Q: [1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  H: [1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
};
const FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

// Modules available for data and error correction codewords.
function rawDataModules(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}

const dataCodewords = (ver, ecl) => Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ecl][ver - 1] * BLOCKS[ecl][ver - 1];

function alignmentPositions(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = ver * 4 + 10; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

// Data codewords: byte-mode segment, terminator, padding.
function dataBytes(bytes, ver, ecl) {
  const capacity = dataCodewords(ver, ecl);
  const bits = [];
  const put = (v, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capacity * 8 - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; out.length < capacity; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

// Splits into blocks, appends the error correction, interleaves.
function codewords(data, ver, ecl) {
  const numBlocks = BLOCKS[ecl][ver - 1];
  const eccLen = ECC_PER_BLOCK[ecl][ver - 1];
  const raw = Math.floor(rawDataModules(ver) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const len = shortLen - eccLen + (i < numShort ? 0 : 1);
    const d = data.slice(k, k + len);
    k += len;
    blocks.push({ data: d, ecc: Array.from(rsEncode(Uint8Array.from(d), eccLen)) });
  }
  const out = [];
  const maxData = shortLen - eccLen + 1;
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < eccLen; i++) for (const b of blocks) out.push(b.ecc[i]);
  return out;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Matrix {
  constructor(ver) {
    this.ver = ver;
    this.size = ver * 4 + 17;
    this.m = new Uint8Array(this.size * this.size);
    this.fn = new Uint8Array(this.size * this.size); // function module
  }

  set(x, y, dark, isFunction = true) {
    this.m[y * this.size + x] = dark ? 1 : 0;
    if (isFunction) this.fn[y * this.size + x] = 1;
  }

  drawFunctionPatterns() {
    const s = this.size;
    for (let i = 0; i < s; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [
      [3, 3],
      [s - 4, 3],
      [3, s - 4],
    ]) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= s || y >= s) continue;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          this.set(x, y, d !== 2 && d !== 4);
        }
      }
    }
    const pos = alignmentPositions(this.ver);
    const last = pos.length - 1;
    for (let i = 0; i <= last; i++) {
      for (let j = 0; j <= last; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
    this.drawFormat('M', 0); // reserves the format areas; redrawn with the chosen mask
    if (this.ver >= 7) {
      let rem = this.ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (this.ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = ((bits >>> i) & 1) === 1;
        const a = s - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.set(a, b, bit);
        this.set(b, a, bit);
      }
    }
  }

  drawFormat(ecl, mask) {
    const s = this.size;
    const data = (FORMAT_BITS[ecl] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(s - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, s - 15 + i, bit(i));
    this.set(8, s - 8, true); // dark module
  }

  drawCodewords(cw) {
    const s = this.size;
    let i = 0;
    for (let right = s - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < s; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? s - 1 - vert : vert;
          if (this.fn[y * s + x] || i >= cw.length * 8) continue;
          this.set(x, y, ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) === 1, false);
          i++;
        }
      }
    }
  }

  applyMask(mask) {
    const s = this.size;
    const f = MASKS[mask];
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) if (!this.fn[y * s + x] && f(x, y)) this.m[y * s + x] ^= 1;
  }

  // Penalty rules N1-N4 of the standard.
  penalty() {
    const s = this.size;
    const at = (x, y) => this.m[y * s + x];
    let p = 0;
    for (const horizontal of [true, false]) {
      for (let a = 0; a < s; a++) {
        let run = 0;
        let prev = -1;
        const line = [];
        for (let b = 0; b < s; b++) {
          const v = horizontal ? at(b, a) : at(a, b);
          line.push(v);
          if (v === prev) run++;
          else {
            if (run >= 5) p += run - 2;
            run = 1;
            prev = v;
          }
        }
        if (run >= 5) p += run - 2;
        // 1:1:3:1:1 finder-like runs with 4 light modules on one side.
        const str = line.join('');
        for (const pat of ['10111010000', '00001011101']) {
          for (let k = str.indexOf(pat); k >= 0; k = str.indexOf(pat, k + 1)) p += 40;
        }
      }
    }
    for (let y = 0; y < s - 1; y++) {
      for (let x = 0; x < s - 1; x++) {
        const v = at(x, y);
        if (v === at(x + 1, y) && v === at(x, y + 1) && v === at(x + 1, y + 1)) p += 3;
      }
    }
    const dark = this.m.reduce((a, b) => a + b, 0);
    const total = s * s;
    p += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return p;
  }
}

// text (string, UTF-8) or bytes -> { version, size, modules }. Picks the
// smallest version that fits and the mask with the lowest penalty.
export function encodeQr(input, { ecl = 'M', mask = null } = {}) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : Uint8Array.from(input);
  let ver = 1;
  while (ver <= MAX_VERSION && 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8 > dataCodewords(ver, ecl) * 8) ver++;
  if (ver > MAX_VERSION) throw new RangeError(`too long for a QR code up to version ${MAX_VERSION} (${bytes.length} bytes)`);
  const cw = codewords(dataBytes(bytes, ver, ecl), ver, ecl);
  const build = (k) => {
    const mx = new Matrix(ver);
    mx.drawFunctionPatterns();
    mx.drawCodewords(cw);
    mx.applyMask(k);
    mx.drawFormat(ecl, k);
    return mx;
  };
  let best = null;
  for (const k of mask === null ? [0, 1, 2, 3, 4, 5, 6, 7] : [mask]) {
    const mx = build(k);
    const p = mask === null ? mx.penalty() : 0;
    if (!best || p < best.p) best = { mx, p, k };
  }
  return { version: ver, mask: best.k, size: best.mx.size, modules: best.mx.m };
}

// Draws a QR code on a canvas with a quiet zone of 4 modules.
export function drawQr(canvas, qr, modulePx = 6) {
  const n = qr.size + 8;
  canvas.width = canvas.height = n * modulePx;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.modules[y * qr.size + x]) ctx.fillRect((x + 4) * modulePx, (y + 4) * modulePx, modulePx, modulePx);
}
