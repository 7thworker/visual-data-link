// Inner FEC framing (SPEC §11.2, ROADMAP M5).
//
// The payload cells of a frame carry a byte stream (bits MSB first, Gray-
// mapped per symbol, SPEC §0). The stream holds an integer number of
// shortened Reed-Solomon codewords of equal length n (SPEC: no codeword spans
// frames), byte-interleaved so that neighbouring bytes, and therefore
// neighbouring cells, belong to different codewords: codeword j byte m goes
// to slot m * codewords + j. A localized defect (e.g. the camera-fixed
// low-contrast spots found in Milestone 2) is thus spread over all codewords.
// Slots beyond codewords * n are padding.

import { bitsPerSymbol } from './profiles.js';
import { rsEncode, rsDecode } from './rs.js';
import { bitsToSymbol, symbolToBits } from './gray.js';

// Payload cells <-> bits. Power-of-two levels: log2 L Gray-mapped bits per
// cell. 27 colours: 19 bits in each group of 4 cells as base-27 digits
// (27^4 = 531441 >= 2^19; 4.75 bits per cell, 99.9% of log2 27); cells left
// over after the last whole group carry nothing.
export function symbolGrouping(profile) {
  if (profile.levels === 27) return { cells: 4, bits: 19 };
  return { cells: 1, bits: bitsPerSymbol(profile.levels) };
}

export function payloadBitCapacity(profile, payloadCells) {
  const g = symbolGrouping(profile);
  return Math.floor(payloadCells / g.cells) * g.bits;
}

// Frame bytes -> symbols of `count` payload cells.
export function bytesToPayloadSymbols(bytes, profile, count) {
  const g = symbolGrouping(profile);
  if (g.cells === 1) return Uint8Array.from(bytesToSymbolBits(bytes, g.bits, count), bitsToSymbol);
  const out = new Uint8Array(count);
  const groups = Math.floor(count / g.cells);
  const values = bytesToSymbolBits(bytes, g.bits, groups);
  for (let k = 0; k < groups; k++) {
    let v = values[k];
    for (let d = g.cells - 1; d >= 0; d--) {
      out[k * g.cells + d] = v % 27;
      v = Math.floor(v / 27);
    }
  }
  return out;
}

// Symbols of the payload cells -> frame bytes (a group whose digits exceed
// 19 bits, i.e. a misread, gives all ones; the inner FEC corrects it).
export function payloadSymbolsToBytes(symbols, profile, byteCount) {
  const g = symbolGrouping(profile);
  if (g.cells === 1) return symbolBitsToBytes(Uint8Array.from(symbols, symbolToBits), g.bits, byteCount);
  const groups = Math.floor(symbols.length / g.cells);
  const values = new Uint32Array(groups);
  const max = 2 ** g.bits - 1;
  for (let k = 0; k < groups; k++) {
    let v = 0;
    for (let d = 0; d < g.cells; d++) v = v * 27 + symbols[k * g.cells + d];
    values[k] = Math.min(max, v);
  }
  return symbolBitsToBytes(values, g.bits, byteCount);
}

// Per-byte erasure flags from per-payload-cell flags.
export function payloadFlagsToByteFlags(flags, profile, byteCount) {
  const g = symbolGrouping(profile);
  if (g.cells === 1) return symbolFlagsToByteFlags(flags, g.bits, byteCount);
  const groups = Math.floor(flags.length / g.cells);
  const gf = new Uint8Array(groups);
  for (let k = 0; k < groups; k++) for (let d = 0; d < g.cells; d++) if (flags[k * g.cells + d]) gf[k] = 1;
  return symbolFlagsToByteFlags(gf, g.bits, byteCount);
}

// Parity per 255 bytes: 32 ~ RS(255,223), 64 ~ RS(255,191), 96 ~ RS(255,159).
export const FEC_RATES = Object.freeze([
  null,
  Object.freeze({ index: 1, name: '高率 RS(255,223) 相当', parityPer255: 32 }),
  Object.freeze({ index: 2, name: '中 RS(255,191) 相当', parityPer255: 64 }),
  Object.freeze({ index: 3, name: '低 RS(255,159) 相当', parityPer255: 96 }),
]);

// Header flags (4 bits): bit 3 = inner FEC present, bits 0-2 = rate index.
export const FLAG_FEC = 0x8;
export const fecFlags = (rateIndex) => (rateIndex ? FLAG_FEC | rateIndex : 0);
export const fecRateFromFlags = (flags) => (flags & FLAG_FEC ? flags & 0x7 : 0);
// False for the FEC bit with a rate index this receiver does not know (4-7,
// or 0): such frames are dropped, not decoded (SPEC §16.2).
export const knownFecFlags = (flags) => !(flags & FLAG_FEC) || Boolean(FEC_RATES[flags & 0x7]);

const cache = new Map();

// payloadCells: number of payload cells of the frame (payloadMask).
export function fecLayout(profile, payloadCells, rateIndex) {
  const rate = FEC_RATES[rateIndex];
  if (!rate) throw new RangeError(`unknown FEC rate ${rateIndex}`);
  const key = `${profile.levels}:${payloadCells}:${rateIndex}`;
  if (cache.has(key)) return cache.get(key);
  const bps = bitsPerSymbol(profile.levels);
  const bytes = Math.floor(payloadBitCapacity(profile, payloadCells) / 8);
  const codewords = Math.ceil(bytes / 255);
  const n = Math.floor(bytes / codewords);
  const nsym = Math.max(2, 2 * Math.round((n * rate.parityPer255) / 255 / 2));
  const k = n - nsym;
  const layout = Object.freeze({
    rateIndex,
    name: rate.name,
    bps,
    payloadCells,
    bytes,
    codewords,
    n,
    nsym,
    k,
    dataBytes: codewords * k,
    codeRate: k / n,
    correctable: nsym / 2,
  });
  cache.set(key, layout);
  return layout;
}

const slot = (layout, j, m) => m * layout.codewords + j;

// data (layout.dataBytes) + pad (layout.bytes - codewords * n) -> frame bytes.
export function encodeFecBytes(layout, data, pad) {
  const out = new Uint8Array(layout.bytes);
  const { codewords, n, k, nsym } = layout;
  for (let j = 0; j < codewords; j++) {
    const d = data.subarray(j * k, (j + 1) * k);
    const parity = rsEncode(d, nsym);
    for (let m = 0; m < k; m++) out[slot(layout, j, m)] = d[m];
    for (let m = 0; m < nsym; m++) out[slot(layout, j, k + m)] = parity[m];
  }
  out.set(pad.subarray(0, layout.bytes - codewords * n), codewords * n);
  return out;
}

// bytes: frame bytes as received; erased: per-slot flags (or null).
// Returns { ok, data, codewords: [{ ok, errors, erasures, reason }], corrected, erasures }.
export function decodeFecBytes(layout, bytes, erased = null) {
  const { codewords, n, k, nsym } = layout;
  const data = new Uint8Array(layout.dataBytes);
  const results = [];
  let corrected = 0;
  let erasures = 0;
  let ok = true;
  const cw = new Uint8Array(n);
  for (let j = 0; j < codewords; j++) {
    const erasePos = [];
    for (let m = 0; m < n; m++) {
      const s = slot(layout, j, m);
      cw[m] = bytes[s];
      if (erased && erased[s]) erasePos.push(m);
    }
    // More erasures than parity cannot be decoded; fall back to errors only.
    const r = rsDecode(cw, nsym, erasePos.length <= nsym ? erasePos : []);
    results.push(r);
    if (r.ok) {
      corrected += r.errors;
      erasures += r.erasures;
    } else {
      ok = false;
    }
    data.set(cw.subarray(0, k), j * k);
  }
  return { ok, data, codewords: results, corrected, erasures };
}

// Byte stream <-> symbol stream (bits MSB first, bps bits per symbol).
export function bytesToSymbolBits(bytes, bps, count) {
  // Groups of more than 8 bits (27 colours: 19) need wider values.
  const out = bps > 8 ? new Uint32Array(count) : new Uint8Array(count);
  let bit = 0;
  for (let c = 0; c < count; c++) {
    let v = 0;
    for (let b = 0; b < bps; b++, bit++) {
      const byte = bit >> 3;
      v = (v << 1) | (byte < bytes.length ? (bytes[byte] >> (7 - (bit & 7))) & 1 : 0);
    }
    out[c] = v;
  }
  return out;
}

export function symbolBitsToBytes(values, bps, byteCount) {
  const out = new Uint8Array(byteCount);
  let bit = 0;
  for (let c = 0; c < values.length && bit < byteCount * 8; c++) {
    for (let b = bps - 1; b >= 0 && bit < byteCount * 8; b--, bit++) {
      if ((values[c] >> b) & 1) out[bit >> 3] |= 0x80 >> (bit & 7);
    }
  }
  return out;
}

// Per-byte erasure flags from per-symbol flags: a byte is erased if any
// symbol carrying one of its bits is.
export function symbolFlagsToByteFlags(flags, bps, byteCount) {
  const out = new Uint8Array(byteCount);
  for (let byte = 0; byte < byteCount; byte++) {
    const first = Math.floor((byte * 8) / bps);
    const last = Math.floor((byte * 8 + 7) / bps);
    for (let c = first; c <= last && c < flags.length; c++) {
      if (flags[c]) {
        out[byte] = 1;
        break;
      }
    }
  }
  return out;
}
