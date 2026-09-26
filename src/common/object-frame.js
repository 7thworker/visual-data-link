// Object transfer frames (SPEC §12, §13, ROADMAP M6): MANIFEST and DATA
// frames, the segment carousel, and receiver-side validation helpers.
//
// Both frame types use the dynamic layout (header copies, pilots, payload
// cells) with inner FEC. The FEC data region (fec.js layout.dataBytes) holds
//
//   body (header payloadLength bytes) | CRC32C (4 bytes) | zero fill
//
// The CRC32C (SPEC §13) runs over session ID (4) | sequence (4) | frame type
// (1) | source block (1) | body, so that a body cannot be accepted under
// another frame's header. The FEC-encoded frame bytes (parity and padding
// included) are whitened by XOR with the PRBS of domain 0x01 seeded by
// session ID, sequence, frame type and source block (SPEC §8.1); the
// receiver removes the whitening before RS decoding.
//
// MANIFEST frame: sequence = 0, source block = 0, body = the manifest below,
// repeated about every 2 s (sender-ui.js manifestEvery). DATA frames depend on
// the outer code:
//
//   0 = none (Milestone 6): source block 0, sequence = segment index, body =
//       object bytes [index * segmentSize, ...), at most segmentSize bytes
//       (only the last segment is shorter); all segments repeat in a
//       carousel (SPEC §11.3).
//   1 = random linear code over GF(256) (Milestone 7, rlnc.js): source block
//       = block index, sequence = encoding symbol ID within the block, body =
//       one encoding symbol of exactly segmentSize bytes (the last source
//       segment is zero-padded). Blocks are sent round-robin; each block
//       sends its source symbols once and then new repair symbols only.
//
// Manifest v1 (big-endian):
//   0  u8   manifest version (1)
//   1  u8   outer code (0 = none, 1 = random linear code over GF(256))
//   2  u16  source block count (outer code 1; 0 otherwise)
//   4  u64  object size in bytes (< 2^53)
//  12  u32  segment size in bytes
//  16  u32  segment count
//  20  32 B SHA-256 of the object
//  52  u8   MIME hint length, MIME hint (UTF-8, advisory)
//      u8   filename length, filename (UTF-8, at most 255 bytes)

import { crc32c } from './crc.js';
import { createPrbs, PRBS_DOMAIN, Xorshift32, ZERO_SEED_REPLACEMENT } from './prbs.js';
import { FRAME_TYPE } from './protocol.js';
import { fecLayout, fecFlags, encodeFecBytes } from './fec.js';
import { dynamicPayloadCells, writeHeaderAndPilots, writePayloadBytes, fillOutline } from './test-frame.js';
import { MAX_BLOCKS, MAX_DECODE_BLOCK_SYMBOLS, MAX_DECODE_COEFFICIENT_BYTES, blockCountFor, coefficientBytes, partitionBlocks, coefficients, encodeSymbol } from './rlnc.js';

export const MANIFEST_VERSION = 1;
export const OUTER_CODE_NONE = 0;
export const OUTER_CODE_RLNC = 1;
export const OUTER_CODES = Object.freeze({ [OUTER_CODE_NONE]: 'なし（カルーセル）', [OUTER_CODE_RLNC]: 'ランダム線形符号 GF(256)' });
export const FRAME_CRC_BYTES = 4;
export const MAX_NAME_BYTES = 255;
export const MAX_MIME_BYTES = 255;
// SPEC §16.2: default receiver limit on the object size.
export const DEFAULT_MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const MANIFEST_FIXED_BYTES = 52;

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

export function objectFrameLayout(profile, fec) {
  return fecLayout(profile, dynamicPayloadCells(profile), fec);
}

// Object bytes per DATA frame for a profile and inner FEC rate.
export function segmentSizeFor(profile, fec) {
  return objectFrameLayout(profile, fec).dataBytes - FRAME_CRC_BYTES;
}

// ------------------------------------------------------------------ strings

// Longest prefix of `text` whose UTF-8 encoding fits in maxBytes (whole code points).
export function truncateUtf8(text, maxBytes) {
  let out = '';
  let bytes = 0;
  for (const ch of text) {
    const n = utf8.encode(ch).length;
    if (bytes + n > maxBytes) break;
    out += ch;
    bytes += n;
  }
  return out;
}

const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)(\..*)?$/i;

// SPEC §16.2: received filenames are untrusted. Keeps the last path
// component and removes control and bidirectional-override characters (which
// can disguise an extension), characters reserved on Windows, leading dots
// (hidden files) and trailing dots / spaces; reserved device names get a "_"
// prefix.
export function sanitizeFilename(name, fallback = 'vdl-received.bin') {
  let s = String(name ?? '').normalize('NFC');
  s = s.replace(/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g, '');
  s = s.split(/[/\\]/).pop();
  s = s.replace(/[<>:"|?*]/g, '_');
  s = s.replace(/^[\s.]+/, '').replace(/[\s.]+$/, '');
  if (!s) return fallback;
  if (RESERVED_NAME.test(s)) s = `_${s}`;
  return truncateUtf8(s, MAX_NAME_BYTES) || fallback;
}

// The MIME hint is advisory and only displayed; anything unusual is dropped.
export function sanitizeMime(mime) {
  const s = String(mime ?? '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(s) ? s : '';
}

// ------------------------------------------------------------------ manifest

export function encodeManifest({ size, segmentSize, segmentCount, sha256, mime = '', name = '', outerCode = OUTER_CODE_NONE, blockCount = 0 }) {
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError(`object size out of range: ${size}`);
  if (sha256.length !== 32) throw new RangeError('SHA-256 must be 32 bytes');
  const mimeBytes = utf8.encode(truncateUtf8(mime, MAX_MIME_BYTES));
  const nameBytes = utf8.encode(truncateUtf8(name, MAX_NAME_BYTES));
  const out = new Uint8Array(MANIFEST_FIXED_BYTES + 1 + mimeBytes.length + 1 + nameBytes.length);
  const v = new DataView(out.buffer);
  v.setUint8(0, MANIFEST_VERSION);
  v.setUint8(1, outerCode);
  v.setUint16(2, outerCode === OUTER_CODE_RLNC ? blockCount : 0);
  v.setUint32(4, Math.floor(size / 2 ** 32));
  v.setUint32(8, size >>> 0);
  v.setUint32(12, segmentSize);
  v.setUint32(16, segmentCount);
  out.set(sha256, 20);
  let p = MANIFEST_FIXED_BYTES;
  out[p++] = mimeBytes.length;
  out.set(mimeBytes, p);
  p += mimeBytes.length;
  out[p++] = nameBytes.length;
  out.set(nameBytes, p);
  return out;
}

export function segmentCountFor(size, segmentSize) {
  return Math.max(1, Math.ceil(size / segmentSize));
}

// Bytes of segment `index` of an object.
export function segmentLength(manifest, index) {
  const { size, segmentSize, segmentCount } = manifest;
  return index < segmentCount - 1 ? segmentSize : size - (segmentCount - 1) * segmentSize;
}

// Parses and validates a manifest body (untrusted, SPEC §16.2).
// limits: { maxObjectBytes, maxSegmentSize, maxBlockSymbols,
// maxCoefficientBytes }. Returns { ok, manifest } or { ok: false, reason }.
export function decodeManifest(
  body,
  { maxObjectBytes = DEFAULT_MAX_OBJECT_BYTES, maxSegmentSize = Infinity, maxBlockSymbols = MAX_DECODE_BLOCK_SYMBOLS, maxCoefficientBytes = MAX_DECODE_COEFFICIENT_BYTES } = {},
) {
  if (body.length < MANIFEST_FIXED_BYTES + 2) return { ok: false, reason: 'manifest-short' };
  const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
  if (v.getUint8(0) !== MANIFEST_VERSION) return { ok: false, reason: 'manifest-version' };
  const outerCode = v.getUint8(1);
  if (outerCode !== OUTER_CODE_NONE && outerCode !== OUTER_CODE_RLNC) return { ok: false, reason: 'outer-code-unsupported' };
  const blockCount = v.getUint16(2);
  const hi = v.getUint32(4);
  if (hi >= 2 ** 21) return { ok: false, reason: 'object-too-large' };
  const size = hi * 2 ** 32 + v.getUint32(8);
  const segmentSize = v.getUint32(12);
  const segmentCount = v.getUint32(16);
  if (size > maxObjectBytes) return { ok: false, reason: 'object-too-large', size };
  if (segmentSize < 1 || segmentSize > maxSegmentSize) return { ok: false, reason: 'segment-size' };
  if (segmentCount !== segmentCountFor(size, segmentSize)) return { ok: false, reason: 'segment-count' };
  if (outerCode === OUTER_CODE_RLNC) {
    // Bounds the decoder's work and memory: O(K_b^2) per block.
    if (blockCount < 1 || blockCount > MAX_BLOCKS || blockCount > segmentCount) return { ok: false, reason: 'block-count' };
    if (Math.ceil(segmentCount / blockCount) > maxBlockSymbols) return { ok: false, reason: 'block-too-large' };
    // The decoders' coefficient rows grow with every symbol: bound their total.
    if (coefficientBytes(segmentCount, blockCount) > maxCoefficientBytes) return { ok: false, reason: 'decoder-memory' };
  }
  let p = MANIFEST_FIXED_BYTES;
  const mimeLen = body[p++];
  if (p + mimeLen + 1 > body.length) return { ok: false, reason: 'manifest-short' };
  const mime = utf8Decoder.decode(body.subarray(p, p + mimeLen));
  p += mimeLen;
  const nameLen = body[p++];
  if (p + nameLen > body.length) return { ok: false, reason: 'manifest-short' };
  const name = utf8Decoder.decode(body.subarray(p, p + nameLen));
  return {
    ok: true,
    manifest: {
      size,
      segmentSize,
      segmentCount,
      outerCode,
      blockCount: outerCode === OUTER_CODE_RLNC ? blockCount : 0,
      sha256: body.slice(20, 52),
      mime,
      name,
    },
  };
}


// ------------------------------------------------------------------ frame payload

function frameCrc(sessionId, sequence, frameType, sourceBlock, body) {
  const prefix = new Uint8Array(10);
  const v = new DataView(prefix.buffer);
  v.setUint32(0, sessionId >>> 0);
  v.setUint32(4, sequence >>> 0);
  v.setUint8(8, frameType);
  v.setUint8(9, sourceBlock);
  return crc32c(body, crc32c(prefix));
}

// Seed of the whitening PRBS (SPEC §8.1): CRC32C(0x01 | session ID (4) |
// sequence (4) | frame type (1) | source block (1)), 0 replaced. Frame type
// and source block enter so that the manifest and DATA ESI 0, and the blocks
// of one ESI (shown one after another), get different sequences.
export function whiteningSeed({ sessionId, sequence, frameType, sourceBlock = 0 }) {
  const buf = new Uint8Array(11);
  const v = new DataView(buf.buffer);
  buf[0] = PRBS_DOMAIN.WHITENING;
  v.setUint32(1, sessionId >>> 0);
  v.setUint32(5, sequence >>> 0);
  buf[9] = frameType & 0xff;
  buf[10] = sourceBlock & 0xff;
  return crc32c(buf) >>> 0 || ZERO_SEED_REPLACEMENT;
}

// XOR with the whitening PRBS (SPEC §8); its own inverse. id: header fields
// { sessionId, sequence, frameType, sourceBlock }.
export function whiten(bytes, id) {
  const prbs = new Xorshift32(whiteningSeed(id));
  for (let i = 0; i < bytes.length; i++) bytes[i] ^= prbs.nextBits(8);
  return bytes;
}

// FEC data region of a frame: body | CRC32C | zero fill.
export function framePayload(layout, { sessionId, sequence, frameType, sourceBlock = 0, body }) {
  if (body.length + FRAME_CRC_BYTES > layout.dataBytes) throw new RangeError(`frame body too long: ${body.length} > ${layout.dataBytes - FRAME_CRC_BYTES}`);
  const data = new Uint8Array(layout.dataBytes);
  data.set(body);
  new DataView(data.buffer).setUint32(body.length, frameCrc(sessionId, sequence, frameType, sourceBlock, body));
  return data;
}

// Body of a decoded (de-whitened, FEC-corrected) data region, or null if the
// length is out of range or the CRC32C does not match. fields: header fields.
export function checkFramePayload(layout, data, { sessionId, sequence, frameType, sourceBlock = 0, payloadLength }) {
  if (payloadLength + FRAME_CRC_BYTES > layout.dataBytes) return null;
  const body = data.subarray(0, payloadLength);
  const crc = new DataView(data.buffer, data.byteOffset).getUint32(payloadLength);
  return crc === frameCrc(sessionId, sequence, frameType, sourceBlock, body) ? body : null;
}

// Pilot level shift of an object frame (SPEC §12.1): consecutive frames get
// different pilots, so that a capture whose exposure covered two frames
// shows the mixture in its pilots as well (receiver: mixing.js). The shift
// is read from the header alone (the block count Z is only known from the
// manifest), and (source block mod 3) + 3 x ESI makes a DATA frame of the
// outer code's round-robin differ from both the frame before and the frame
// after for any Z. The frames before and after also differ from each other,
// which tells which one a capture was mixed with, except for block 0 (next
// to block Z - 1 and block 1) when Z mod 3 = 1 and Z >= 4; the receiver then
// tries both.
export function objectPilotShift({ frameType, sourceBlock = 0, sequence }, levels) {
  return ((sourceBlock % 3) + 3 * sequence + frameType) % levels;
}

// Symbols of one MANIFEST or DATA frame.
export function buildObjectFrame({ profile, sessionId, sequence, frameType, sourceBlock = 0, body, fec }, out) {
  if (!fec) throw new RangeError('object frames require inner FEC');
  const n = profile.gridWidth * profile.gridHeight;
  const symbols = out && out.length === n ? out : new Uint8Array(n);
  const layout = objectFrameLayout(profile, fec);
  const data = framePayload(layout, { sessionId, sequence, frameType, sourceBlock, body });
  const bytes = whiten(encodeFecBytes(layout, data, new Uint8Array(layout.bytes)), { sessionId, sequence, frameType, sourceBlock });
  writeHeaderAndPilots(
    symbols,
    profile,
    { frameType, flags: fecFlags(fec), sessionId, sequence, sourceBlock, payloadLength: body.length },
    objectPilotShift({ frameType, sourceBlock, sequence }, profile.levels),
  );
  writePayloadBytes(symbols, profile, bytes);
  fillOutline(symbols, profile);
  return symbols;
}

// ------------------------------------------------------------------ schedule

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

// Transmission schedule: groups of one MANIFEST followed by `manifestEvery`
// DATA frames.
//
// Outer code 0 (carousel, SPEC §11.3): pass 0 sends the segments in order;
// later passes use a pseudo-random affine permutation (index = a * i + b mod
// N), so that a segment lost to an unfavourable capture phase (SPEC §10.1)
// does not meet the same conditions on every pass. The receiver still needs
// every single segment, so the last missing ones take several passes.
//
// Outer code 1 (rlnc.js): DATA frame d goes to block d mod Z with ESI
// floor(d / Z): source symbols first, then repair symbols that are never
// repeated. Any K_b independent symbols of a block recover it.
export function planCarousel({ sessionId, segmentCount, manifestEvery, outerCode = OUTER_CODE_NONE, blockCount = 1 }) {
  if (!(segmentCount >= 1) || !(manifestEvery >= 1)) throw new RangeError('segmentCount and manifestEvery must be >= 1');
  const plan = { sessionId: sessionId >>> 0, segmentCount, manifestEvery, outerCode, passCache: new Map() };
  if (outerCode === OUTER_CODE_RLNC) plan.blocks = partitionBlocks(segmentCount, blockCount);
  return plan;
}

function passPermutation(plan, pass) {
  let p = plan.passCache.get(pass);
  if (p) return p;
  const N = plan.segmentCount;
  const rng = createPrbs(PRBS_DOMAIN.WHITENING, plan.sessionId ^ 0x5a5a5a5a, pass);
  let a = N > 2 ? 1 + (rng.nextU32() % (N - 1)) : 1;
  while (gcd(a, N) !== 1) a = (a % (N - 1)) + 1;
  p = { a, b: rng.nextU32() % N };
  if (plan.passCache.size > 8) plan.passCache.clear();
  plan.passCache.set(pass, p);
  return p;
}

// What is shown in display slot `slot` (0, 1, 2, ...):
// { frameType, sequence, sourceBlock, pass, repair }. For outer code 1,
// `pass` counts symbols of the block in units of K_b (0 = source symbols).
export function carouselEntry(plan, slot) {
  const group = plan.manifestEvery + 1;
  const r = slot % group;
  if (r === 0) return { frameType: FRAME_TYPE.MANIFEST, sequence: 0, sourceBlock: 0, pass: null, repair: false };
  const d = Math.floor(slot / group) * plan.manifestEvery + r - 1;
  if (plan.outerCode === OUTER_CODE_RLNC) {
    const Z = plan.blocks.length;
    const block = d % Z;
    const esi = Math.floor(d / Z) >>> 0;
    const k = plan.blocks[block].count;
    return { frameType: FRAME_TYPE.DATA, sequence: esi, sourceBlock: block, pass: Math.floor(esi / k), repair: esi >= k };
  }
  const N = plan.segmentCount;
  const pass = Math.floor(d / N);
  const i = d % N;
  if (pass === 0) return { frameType: FRAME_TYPE.DATA, sequence: i, sourceBlock: 0, pass, repair: false };
  const { a, b } = passPermutation(plan, pass);
  return { frameType: FRAME_TYPE.DATA, sequence: (a * i + b) % N, sourceBlock: 0, pass, repair: false };
}

// Display slots per full pass over all segments (manifests included); with
// the outer code, the slots needed to send K symbols.
export function slotsPerPass(plan) {
  return plan.segmentCount + Math.ceil(plan.segmentCount / plan.manifestEvery);
}

// ------------------------------------------------------------------ sender

// Everything the sender needs to transmit one object. sha256: 32-byte digest
// of `bytes` (computed by the caller, crypto.subtle is asynchronous).
export function prepareTransfer({ profile, fec, sessionId, bytes, sha256, name = '', mime = '', manifestEvery, outerCode = OUTER_CODE_RLNC }) {
  const segmentSize = segmentSizeFor(profile, fec);
  const segmentCount = segmentCountFor(bytes.length, segmentSize);
  const blockCount = outerCode === OUTER_CODE_RLNC ? blockCountFor(segmentCount) : 0;
  if (blockCount > MAX_BLOCKS) throw new RangeError(`ファイルが大きすぎます（ブロック ${blockCount} 個 > ${MAX_BLOCKS}）`);
  const manifest = fitManifest(
    {
      size: bytes.length,
      segmentSize,
      segmentCount,
      sha256,
      name: truncateUtf8(name, MAX_NAME_BYTES),
      mime: truncateUtf8(mime, MAX_MIME_BYTES),
      outerCode,
      blockCount,
    },
    segmentSize,
  );
  return {
    profile,
    fec,
    sessionId: sessionId >>> 0,
    bytes,
    manifest,
    manifestBody: encodeManifest(manifest),
    plan: planCarousel({ sessionId, segmentCount, manifestEvery, outerCode, blockCount: blockCount || 1 }),
    blockSources: new Map(), // block -> [Uint8Array(segmentSize)] (outer code 1)
    coefs: null,
    symbol: null,
  };
}

// The manifest SHALL fit one frame (SPEC §12). Up to 564 bytes with the
// longest MIME hint and filename, but P0 carries only 326 - 458: the MIME
// hint (advisory) is dropped then. Without it the manifest has at most 52 +
// 2 + 255 = 309 bytes, which fits every standard profile and rate.
function fitManifest(manifest, maxBytes) {
  if (encodeManifest(manifest).length <= maxBytes) return manifest;
  const m = { ...manifest, mime: '' };
  const n = encodeManifest(m).length;
  if (n > maxBytes) throw new RangeError(`manifest does not fit a frame (${n} > ${maxBytes} bytes)`);
  return m;
}

// Source symbols of a block: segments, the last one zero-padded.
function blockSources(transfer, block) {
  let src = transfer.blockSources.get(block);
  if (src) return src;
  const { first, count } = transfer.plan.blocks[block];
  const T = transfer.manifest.segmentSize;
  src = [];
  for (let i = first; i < first + count; i++) {
    const seg = transfer.bytes.subarray(i * T, Math.min(transfer.bytes.length, (i + 1) * T));
    if (seg.length === T) {
      src.push(seg);
    } else {
      const padded = new Uint8Array(T);
      padded.set(seg);
      src.push(padded);
    }
  }
  transfer.blockSources.set(block, src);
  return src;
}

// Body of a DATA frame for a schedule entry.
export function dataBody(transfer, entry) {
  const T = transfer.manifest.segmentSize;
  if (transfer.plan.outerCode !== OUTER_CODE_RLNC) {
    return transfer.bytes.subarray(entry.sequence * T, Math.min(transfer.bytes.length, (entry.sequence + 1) * T));
  }
  const src = blockSources(transfer, entry.sourceBlock);
  if (!entry.repair) return src[entry.sequence];
  const k = src.length;
  if (!transfer.coefs || transfer.coefs.length !== k) transfer.coefs = new Uint8Array(k);
  transfer.symbol ??= new Uint8Array(T);
  return encodeSymbol(src, coefficients(transfer.sessionId, entry.sourceBlock, entry.sequence, k, transfer.coefs), transfer.symbol);
}

// Symbols for display slot `slot` of a prepared transfer; returns { symbols, entry }.
export function buildCarouselFrame(transfer, slot, out) {
  const entry = carouselEntry(transfer.plan, slot);
  const body = entry.frameType === FRAME_TYPE.MANIFEST ? transfer.manifestBody : dataBody(transfer, entry);
  const symbols = buildObjectFrame(
    { profile: transfer.profile, sessionId: transfer.sessionId, sequence: entry.sequence, frameType: entry.frameType, sourceBlock: entry.sourceBlock, body, fec: transfer.fec },
    out,
  );
  return { symbols, entry };
}
