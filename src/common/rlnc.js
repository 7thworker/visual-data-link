// Outer erasure code (SPEC §11.3, ROADMAP M7): systematic random linear
// code over GF(256) (primitive polynomial 0x11d, as in rs.js).
//
// An object of K source symbols (segments of T bytes, the last one zero-
// padded) is split into Z source blocks of nearly equal size (at most 256
// blocks, one per value of the header's 8-bit source-block field). Within a
// block of K_b symbols, encoding symbol ID (ESI) e < K_b is source symbol e
// itself; e >= K_b is a repair symbol sum_j c_j * S_j with coefficients c
// generated from domain 0x03, session ID, block and ESI (coefficients()), so
// that the receiver regenerates them from the header alone. A receiver
// recovers a block from any K_b linearly independent symbols; for random
// dense coefficients over GF(256) that takes K_b symbols with probability
// ~0.996 and K_b + 1 with ~0.99998, whatever symbols were lost.
//
// Chosen over RaptorQ (RFC 6330) for v0.1 because it has no IPR disclosures
// and fits in a page of code; its cost (Gaussian elimination, O(K_b^2 (K_b + T))
// per block) is bounded by the block size limit.

export const PRBS_DOMAIN_OUTER = 0x03;
// Sender default; the receiver accepts blocks up to MAX_DECODE_BLOCK_SYMBOLS.
export const MAX_BLOCK_SYMBOLS = 256;
export const MAX_DECODE_BLOCK_SYMBOLS = 1024;
export const MAX_BLOCKS = 256;
// Receiver default for the coefficient rows of all block decoders (sum of
// K_b^2 bytes): every object the sender can produce (at most 256 blocks of at
// most 256 symbols) fits, while a manifest naming 256 blocks of 1024 symbols
// (268 MB of rows) is refused before any symbol arrives.
export const MAX_DECODE_COEFFICIENT_BYTES = MAX_BLOCKS * MAX_BLOCK_SYMBOLS ** 2;

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
// MUL[a << 8 | b] = a * b: one table lookup per byte in the row operations.
const MUL = new Uint8Array(65536);
for (let a = 1; a < 256; a++) for (let b = 1; b < 256; b++) MUL[(a << 8) | b] = EXP[LOG[a] + LOG[b]];
const INV = new Uint8Array(256);
for (let a = 1; a < 256; a++) INV[a] = EXP[255 - LOG[a]];

export const gfMul = (a, b) => MUL[(a << 8) | b];
export const gfInv = (a) => INV[a];

// dst ^= c * src
export function mulAdd(dst, src, c) {
  if (c === 0) return;
  const n = dst.length;
  if (c === 1) {
    for (let j = 0; j < n; j++) dst[j] ^= src[j];
    return;
  }
  const m = c << 8;
  for (let j = 0; j < n; j++) dst[j] ^= MUL[m | src[j]];
}

function scale(v, c) {
  if (c === 1) return;
  const m = c << 8;
  for (let j = 0; j < v.length; j++) v[j] = MUL[m | v[j]];
}

// Z blocks of sizes differing by at most one, larger ones first:
// [{ first, count }] with first = index of the block's first source symbol.
export function partitionBlocks(K, Z) {
  if (!(Z >= 1) || Z > K) throw new RangeError(`bad block count ${Z} for ${K} symbols`);
  const base = Math.floor(K / Z);
  const extra = K % Z;
  const out = [];
  let first = 0;
  for (let b = 0; b < Z; b++) {
    const count = base + (b < extra ? 1 : 0);
    out.push({ first, count });
    first += count;
  }
  return out;
}

export const blockCountFor = (K, maxBlock = MAX_BLOCK_SYMBOLS) => Math.max(1, Math.ceil(K / maxBlock));

// Bytes of coefficient rows a receiver holds once every block of K symbols in
// Z blocks (partitionBlocks) is complete: sum of K_b^2.
export function coefficientBytes(K, Z) {
  const base = Math.floor(K / Z);
  const extra = K % Z;
  return extra * (base + 1) ** 2 + (Z - extra) * base ** 2;
}

// murmur3 32-bit finalizer.
function fmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// Coefficient vector of symbol `esi` of a block with K_b = k symbols.
//
// The generator must be nonlinear over GF(2): with the CRC32C seed and the
// xorshift PRBS of SPEC §8.1 (both GF(2)-linear) the vectors of nearby ESIs
// span only a handful of dimensions (50 repair symbols gave rank 7), because
// a GF(2) combination is also a GF(256) combination. The seed is therefore
// hashed with integer multiplications (murmur3 finalizer) and expanded with
// mulberry32.
export function coefficients(sessionId, block, esi, k, out = new Uint8Array(k)) {
  out.fill(0);
  if (esi < k) {
    out[esi] = 1;
    return out;
  }
  let a = fmix32(fmix32(fmix32(PRBS_DOMAIN_OUTER ^ Math.imul(sessionId >>> 0, 0x9e3779b1)) ^ block) + (esi >>> 0));
  let any = 0;
  for (let j = 0; j < k; j += 4) {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    t = (t ^ (t >>> 14)) >>> 0;
    for (let b = 0; b < 4 && j + b < k; b++) any |= out[j + b] = (t >>> (24 - 8 * b)) & 0xff;
  }
  if (!any) out[esi % k] = 1; // all-zero vector (probability 256^-k)
  return out;
}

// Encoding symbol from the block's source symbols (array of equal-length Uint8Array).
export function encodeSymbol(sources, coefs, out = new Uint8Array(sources[0].length)) {
  out.fill(0);
  for (let j = 0; j < sources.length; j++) mulAdd(out, sources[j], coefs[j]);
  return out;
}

// Incremental Gauss-Jordan elimination: rows are kept in reduced row echelon
// form, indexed by pivot column, so each arriving symbol costs at most two
// sweeps over the current rows and the block is decoded the moment the rank
// reaches K_b (row p then holds source symbol p).
export class BlockDecoder {
  constructor(k, symbolSize) {
    this.k = k;
    this.symbolSize = symbolSize;
    this.rows = new Array(k).fill(null); // pivot column -> { c, d }
    this.rank = 0;
  }

  get complete() {
    return this.rank === this.k;
  }

  // Returns true if the symbol was innovative (raised the rank).
  add(coefs, data) {
    if (this.complete) return false;
    const { k, rows } = this;
    const c = Uint8Array.from(coefs);
    const d = Uint8Array.from(data);
    // Remove the known pivot columns (rows are reduced, so one pass suffices).
    for (let p = 0; p < k; p++) {
      const f = c[p];
      if (f && rows[p]) {
        mulAdd(c, rows[p].c, f);
        mulAdd(d, rows[p].d, f);
      }
    }
    let q = 0;
    while (q < k && !c[q]) q++;
    if (q === k) return false;
    const f = INV[c[q]];
    scale(c, f);
    scale(d, f);
    // Clear column q from the other rows to keep the reduced form.
    for (let p = 0; p < k; p++) {
      const r = rows[p];
      if (r && r.c[q]) {
        const g = r.c[q];
        mulAdd(r.c, c, g);
        mulAdd(r.d, d, g);
      }
    }
    rows[q] = { c, d };
    this.rank++;
    return true;
  }

  // Source symbol i of a complete block.
  source(i) {
    return this.rows[i].d;
  }
}
