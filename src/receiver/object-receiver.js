// Object reception (SPEC §12, §13, §16.2, ROADMAP M6): collects MANIFEST and
// DATA frames (object-frame.js) per session ID, reassembles the object, and
// accepts it only when its SHA-256 matches the manifest.
//
// Per capture: header copies (reception.js readHeaders) -> skip frames that
// are already known without decoding -> de-whiten -> inner FEC, errors only
// and, if that fails, with erasures (low-confidence cells and cells in known-
// bad camera regions) -> CRC32C. Everything received is untrusted: the
// manifest is validated against size limits before any buffer is allocated,
// DATA frames arriving before the manifest are buffered up to a cap, and
// sessions are kept apart.
//
// With the outer code (manifest outer code 1, rlnc.js) each block has its own
// incremental decoder; a DATA frame counts as progress when its symbol is
// linearly independent of those already received, and a block is finished
// as soon as its rank reaches K_b, whichever symbols those were.
//
// Capture classes: acquisition-failed, guard, no-header, transition,
// other-type (TEST / IDLE frames), known (segment, symbol, block or manifest
// already held; not decoded), fec-failed, crc-failed, rejected (fails
// validation or a buffer limit), manifest, segment (new segment or
// independent symbol), redundant (decoded symbol that added no rank), done
// (session already complete or being verified).

import { FRAME_TYPE } from '../common/protocol.js';
import { fecRateFromFlags, knownFecFlags, decodeFecBytes, payloadSymbolsToBytes, payloadFlagsToByteFlags } from '../common/fec.js';
import { payloadMask, pilotLayoutFor } from '../common/test-frame.js';
import {
  DEFAULT_MAX_OBJECT_BYTES,
  objectFrameLayout,
  segmentSizeFor,
  whiten,
  checkFramePayload,
  decodeManifest,
  segmentLength,
  sanitizeFilename,
  sanitizeMime,
  OUTER_CODE_RLNC,
  objectPilotShift,
  buildObjectFrame,
} from '../common/object-frame.js';
import { BlockDecoder, partitionBlocks, coefficients, encodeSymbol } from '../common/rlnc.js';
import { fitMixing, cancelPartner, levelShape, fitMixingRgb, cancelPartnerRgb } from './mixing.js';
import { symbolFromBits } from './colour-demod.js';
import { readHeaders, isGuard, ERASURE_CONFIDENCE } from './reception.js';

// DATA frames buffered before their session's manifest (SPEC §12), all sessions.
export const DEFAULT_MAX_PENDING_BYTES = 8 * 1024 * 1024;
const MAX_SESSIONS = 4;
// Frames with failed captures kept for combining; a frame's captures arrive
// within ~100 ms, so a few recent frames suffice (~100 KB each for P1).
const MAX_COMBINING = 12;
// Combining weights: blocks of the frame (columns x rows), the floor of the
// pilot variance (level units^2) and the capture-wide variance mixed into each
// block, in pilot cells (about 12 per block for P1).
const COMBINE_BLOCKS_X = 8;
const COMBINE_BLOCKS_Y = 6;
const COMBINE_BLOCKS = COMBINE_BLOCKS_X * COMBINE_BLOCKS_Y;
const MIN_PILOT_VARIANCE = 0.003;
const PILOT_VARIANCE_PRIOR = 6;
// Mixed captures: minimum median share of the partner frame, queue length,
// decoded bodies kept for cancellation.
const MIXED_MIN_SHARE = 0.12;
const MAX_MIXED_QUEUE = 16;
const MAX_RECENT_BODIES = 64;
const MAX_TIMELINE = 20000;

export const CAPTURE_CLASSES = Object.freeze([
  'acquisition-failed',
  'guard',
  'no-header',
  'transition',
  'other-type',
  'known',
  'fec-failed',
  'crc-failed',
  'rejected',
  'manifest',
  'segment',
  'redundant',
  'done',
]);

// Combining block of each cell of `cells` (grid indices, e.g. payloadIndex).
export function combineBlockOf(profile, cells) {
  const { gridWidth: gw, gridHeight: gh } = profile;
  return Uint8Array.from(cells, (i) => {
    const bx = Math.min(COMBINE_BLOCKS_X - 1, Math.floor(((i % gw) * COMBINE_BLOCKS_X) / gw));
    const by = Math.min(COMBINE_BLOCKS_Y - 1, Math.floor((Math.floor(i / gw) * COMBINE_BLOCKS_Y) / gh));
    return by * COMBINE_BLOCKS_X + bx;
  });
}

// Per combining block: mean squared deviation of the pilot cells' level
// coordinates from their known levels (level units^2), i.e. the variance of
// a cell's level coordinate there, shrunk toward the capture-wide mean.
// pilots: base pilot layout; shift: the frame's pilot shift. null if no
// pilot cell was read.
//
// Chosen over the payload misfit (distance from the nearest level) after the
// M8 failure analysis: in real failed captures the misfit did not follow the
// symbol error rate (rank correlation -0.74 and 0.00 in two runs), because
// cells of a capture blended with a neighbouring frame land near a wrong
// level; sqrt(pilot variance) did (0.89 in both).
export function pilotBlockVariance(profile, pilots, coord, shift) {
  const L = profile.levels;
  const blockOf = pilotBlocks(profile, pilots);
  const sum = new Float64Array(COMBINE_BLOCKS);
  const n = new Uint32Array(COMBINE_BLOCKS);
  let total = 0;
  let count = 0;
  for (let k = 0; k < pilots.count; k++) {
    const u = coord[pilots.cells[k]];
    if (Number.isNaN(u)) continue;
    const d = (u - ((pilots.levels[k] + shift) % L)) ** 2;
    sum[blockOf[k]] += d;
    n[blockOf[k]]++;
    total += d;
    count++;
  }
  if (!count) return null;
  const g = total / count;
  return Float64Array.from(sum, (s, b) => (s + PILOT_VARIANCE_PRIOR * g) / (n[b] + PILOT_VARIANCE_PRIOR));
}

// The same for colour soft values (colour-demod.js): per block, the mean
// squared distance of the pilot bit coordinates from their symbol bits,
// averaged over the three channels.
export function pilotBlockVarianceRgb(profile, pilots, bits, shift) {
  const L = profile.levels;
  const blockOf = pilotBlocks(profile, pilots);
  const sum = new Float64Array(COMBINE_BLOCKS);
  const n = new Uint32Array(COMBINE_BLOCKS);
  let total = 0;
  let count = 0;
  for (let k = 0; k < pilots.count; k++) {
    const i = pilots.cells[k];
    if (Number.isNaN(bits[3 * i])) continue;
    const s = (pilots.levels[k] + shift) % L;
    const d = ((bits[3 * i] - (s & 4 ? 1 : 0)) ** 2 + (bits[3 * i + 1] - (s & 2 ? 1 : 0)) ** 2 + (bits[3 * i + 2] - (s & 1 ? 1 : 0)) ** 2) / 3;
    sum[blockOf[k]] += d;
    n[blockOf[k]]++;
    total += d;
    count++;
  }
  if (!count) return null;
  const g = total / count;
  return Float64Array.from(sum, (s, b) => (s + PILOT_VARIANCE_PRIOR * g) / (n[b] + PILOT_VARIANCE_PRIOR));
}

const pilotBlockCache = new WeakMap();
function pilotBlocks(profile, pilots) {
  let b = pilotBlockCache.get(pilots);
  if (!b) pilotBlockCache.set(pilots, (b = combineBlockOf(profile, pilots.cells)));
  return b;
}

// Weight of a cell in the combination: 1 / the variance of its level coordinate.
export const combineWeight = (variance) => 1 / Math.max(MIN_PILOT_VARIANCE, variance);

export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

export class ObjectReceiver {
  // options: maxObjectBytes, maxPendingBytes, digest (async bytes -> 32-byte
  // hash), onComplete(session), onHashMismatch(session), keepFailed (failed
  // captures kept for failure-analysis.js, ~40 KB each for P1).
  constructor(profile, { maxObjectBytes = DEFAULT_MAX_OBJECT_BYTES, maxPendingBytes = DEFAULT_MAX_PENDING_BYTES, digest = sha256, onComplete = null, onHashMismatch = null, keepFailed = 0 } = {}) {
    this.profile = profile;
    this.keepFailed = keepFailed;
    this.failed = [];
    this.maxObjectBytes = maxObjectBytes;
    this.maxPendingBytes = maxPendingBytes;
    this.digest = digest;
    this.onComplete = onComplete;
    this.onHashMismatch = onHashMismatch;
    const mask = payloadMask(profile, 'file');
    const index = [];
    for (let i = 0; i < mask.length; i++) if (mask[i]) index.push(i);
    this.payloadIndex = Uint32Array.from(index);
    this.blockOf = combineBlockOf(profile, this.payloadIndex);
    this.sessions = new Map(); // sessionId -> session state
    this.pendingBytes = 0;
    this.counts = Object.fromEntries(CAPTURE_CLASSES.map((c) => [c, 0]));
    this.rejections = {};
    this.fec = { decodes: 0, withErasures: 0, corrected: 0, erasures: 0, combineAttempts: 0, combinedRecoveries: 0, combinedCaptures: 0 };
    this.pilots = pilotLayoutFor(profile, 'file');
    this.combining = new Map(); // frame key -> soft sums of failed captures (#combine)
    // Mixed captures (mixing.js): camera level shape, recently decoded bodies
    // (outer code 1, blocks not yet complete), regenerated partner frames,
    // captures waiting for their partner.
    this.qShape = null;
    this.colourGains = null; // clean channel contrasts (colour profiles, mixing.js)
    this.recentBodies = new Map();
    this.partnerCache = new Map();
    this.mixedQueue = [];
    Object.assign(this.fec, { mixedDetected: 0, mixedQueued: 0, mixedAttempts: 0, mixedRecoveries: 0 });
    this.completed = null; // first session whose object verified
    this.verifying = null; // pending digest promise
    this.firstT = null;
  }

  #session(sessionId, t) {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        sessionId,
        manifest: null,
        name: null,
        mime: null,
        pending: new Map(), // "block:esi" -> { block, esi, body }, before the manifest
        data: null,
        have: null, // outer code 0: per-segment flags
        decoders: null, // outer code 1: BlockDecoder per block (null once decoded)
        blocks: null, // outer code 1: partitionBlocks()
        blocksDone: 0,
        seen: new Set(), // "block:esi" of DATA frames already used (outer code 1)
        received: 0, // segments (outer code 0) or independent symbols (outer code 1)
        redundant: 0,
        state: 'collecting', // collecting | verifying | complete
        firstT: t,
        lastT: t,
        manifestT: null,
        completeT: null,
        manifestFrames: 0,
        segmentFrames: 0,
        hashMismatches: 0,
        timeline: [], // [t, received] per new segment
      };
      this.sessions.set(sessionId, s);
      if (this.sessions.size > MAX_SESSIONS) this.#evict();
    }
    s.lastT = t;
    return s;
  }

  // Drops the least recently seen session (never a completed one).
  #evict() {
    const victim = [...this.sessions.values()].filter((s) => s.state !== 'complete').sort((a, b) => a.lastT - b.lastT)[0];
    if (!victim) return;
    for (const e of victim.pending.values()) this.pendingBytes -= e.body.length;
    this.sessions.delete(victim.sessionId);
  }

  #reject(reason) {
    this.rejections[reason] = (this.rejections[reason] ?? 0) + 1;
    return 'rejected';
  }

  // Payload-order symbols -> de-whitened, FEC-decoded, CRC-checked body
  // (fec.js maps symbols to bits: Gray bits, or base-27 groups for 27
  // colours). erasureFlags(): per-payload-cell erasure flags, computed only if
  // the errors-only decoding fails.
  #decodeGroups(fields, groups, erasureFlags) {
    const layout = objectFrameLayout(this.profile, fecRateFromFlags(fields.flags));
    const bytes = whiten(payloadSymbolsToBytes(groups, this.profile, layout.bytes), fields);
    this.fec.decodes++;
    let d = decodeFecBytes(layout, bytes, null);
    if (!d.ok) {
      const flags = erasureFlags();
      if (flags.some((v) => v)) {
        this.fec.withErasures++;
        d = decodeFecBytes(layout, bytes, payloadFlagsToByteFlags(flags, this.profile, layout.bytes));
      }
    }
    if (!d.ok) return { ok: false, cls: 'fec-failed' };
    this.fec.corrected += d.corrected;
    this.fec.erasures += d.erasures;
    const body = checkFramePayload(layout, d.data, fields);
    return body ? { ok: true, body, layout } : { ok: false, cls: 'crc-failed' };
  }

  // Erasure flags: low decision confidence or a known-bad camera region.
  #erasures(confidenceAt, cellErasures) {
    const cells = typeof cellErasures === 'function' ? cellErasures() : cellErasures;
    const flags = new Uint8Array(this.payloadIndex.length);
    for (let c = 0; c < flags.length; c++) {
      if (!(confidenceAt(c) >= ERASURE_CONFIDENCE) || (cells && cells[this.payloadIndex[c]])) flags[c] = 1;
    }
    return flags;
  }

  // One capture on its own.
  #decode(result, fields, cellErasures) {
    const groups = new Uint8Array(this.payloadIndex.length);
    for (let c = 0; c < groups.length; c++) groups[c] = result.symbols[this.payloadIndex[c]];
    const conf = result.confidence;
    return this.#decodeGroups(fields, groups, () => this.#erasures((c) => (conf ? conf[this.payloadIndex[c]] : 1), cellErasures));
  }

  // Luma noise variance of a capture: mean squared distance of the pilot
  // cells from their local level centers (diagnostics only, see #blockMisfit).
  #captureNoise({ coord, spacing }, pilotShift = 0) {
    const L = this.profile.levels;
    let s = 0;
    let n = 0;
    for (let k = 0; k < this.pilots.count; k++) {
      const i = this.pilots.cells[k];
      if (Number.isNaN(coord[i])) continue;
      s += ((coord[i] - ((this.pilots.levels[k] + pilotShift) % L)) * spacing[i]) ** 2;
      n++;
    }
    return n ? s / n : Infinity;
  }

  // Per block of the frame: mean squared distance of the payload cells'
  // level coordinates from the nearest level ("misfit", level units^2; about
  // 1/12 for garbage). Kept for the failure analysis only: it was the
  // combining weight while the pilots were the same in every frame (before
  // m8-1), but on real failed captures it did not follow the symbol error
  // rate (see pilotBlockVariance).
  #blockMisfit(coord) {
    const sum = new Float64Array(COMBINE_BLOCKS);
    const n = new Uint32Array(COMBINE_BLOCKS);
    const top = this.profile.levels - 1;
    for (let c = 0; c < this.payloadIndex.length; c++) {
      const u = coord[this.payloadIndex[c]];
      if (Number.isNaN(u)) continue;
      const b = this.blockOf[c];
      sum[b] += (u - Math.max(0, Math.min(top, Math.round(u)))) ** 2;
      n[b]++;
    }
    return Float64Array.from(sum, (s, b) => (n[b] ? s / n[b] : 1 / 12));
  }

  // Soft combining (SPEC §10.3): a capture that failed on its own is kept as
  // level coordinates per payload cell; once a second capture of the same
  // frame (same session, type, block, sequence) has also failed, the weighted
  // mean is decided and decoded. Different captures of a frame are usually
  // degraded in different places (rolling shutter), so the mean often
  // decodes when neither capture does. Each cell is weighted by 1 / the
  // pilot variance of its block in that capture (pilotBlockVariance), so a
  // capture counts little where it is blurred, blended with gray, or mixed
  // with another frame. Returns the decode result or null.
  #combine(key, result, fields, cellErasures) {
    const soft = result.soft;
    if (!soft) return null;
    if (soft.bits) return this.#combineRgb(key, soft.bits, fields, cellErasures);
    const { coord } = soft;
    const variance = pilotBlockVariance(this.profile, this.pilots, coord, objectPilotShift(fields, this.profile.levels));
    if (!variance) return null;
    const N = this.payloadIndex.length;
    let e = this.combining.get(key);
    if (!e) {
      e = { sum: new Float32Array(N), weight: new Float32Array(N), captures: 0 };
      if (this.combining.size >= MAX_COMBINING) this.combining.delete(this.combining.keys().next().value);
      this.combining.set(key, e);
    }
    const blockWeight = Float64Array.from(variance, combineWeight);
    for (let c = 0; c < N; c++) {
      const u = coord[this.payloadIndex[c]];
      if (Number.isNaN(u)) continue;
      const w = blockWeight[this.blockOf[c]];
      e.sum[c] += w * u;
      e.weight[c] += w;
    }
    e.captures++;
    if (e.captures < 2) return null;
    const top = this.profile.levels - 1;
    const groups = new Uint8Array(N);
    const conf = new Float32Array(N);
    for (let c = 0; c < N; c++) {
      if (!e.weight[c]) continue; // conf 0: erased
      const u = e.sum[c] / e.weight[c];
      const s = Math.max(0, Math.min(top, Math.round(u)));
      groups[c] = s;
      conf[c] = Math.max(0, Math.min(1, 1 - 2 * Math.abs(u - s)));
    }
    this.fec.combineAttempts++;
    const d = this.#decodeGroups(fields, groups, () => this.#erasures((c) => conf[c], cellErasures));
    if (d.ok) {
      this.fec.combinedRecoveries++;
      this.fec.combinedCaptures += e.captures;
      this.combining.delete(key);
    }
    return d;
  }

  // Colour profiles: the same, with the three soft bit coordinates per cell
  // (colour-demod.js) averaged separately and thresholded at 0.5.
  #combineRgb(key, bits, fields, cellErasures) {
    const variance = pilotBlockVarianceRgb(this.profile, this.pilots, bits, objectPilotShift(fields, this.profile.levels));
    if (!variance) return null;
    const N = this.payloadIndex.length;
    let e = this.combining.get(key);
    if (!e) {
      e = { sum: new Float32Array(3 * N), weight: new Float32Array(N), captures: 0 };
      if (this.combining.size >= MAX_COMBINING) this.combining.delete(this.combining.keys().next().value);
      this.combining.set(key, e);
    }
    const blockWeight = Float64Array.from(variance, combineWeight);
    for (let c = 0; c < N; c++) {
      const i = this.payloadIndex[c];
      if (Number.isNaN(bits[3 * i])) continue;
      const w = blockWeight[this.blockOf[c]];
      e.sum[3 * c] += w * bits[3 * i];
      e.sum[3 * c + 1] += w * bits[3 * i + 1];
      e.sum[3 * c + 2] += w * bits[3 * i + 2];
      e.weight[c] += w;
    }
    e.captures++;
    if (e.captures < 2) return null;
    const groups = new Uint8Array(N);
    const conf = new Float32Array(N);
    for (let c = 0; c < N; c++) {
      const w = e.weight[c];
      if (!w) continue; // conf 0: erased
      const { s, conf: q } = symbolFromBits(e.sum[3 * c] / w, e.sum[3 * c + 1] / w, e.sum[3 * c + 2] / w);
      groups[c] = s;
      conf[c] = q;
    }
    this.fec.combineAttempts++;
    const d = this.#decodeGroups(fields, groups, () => this.#erasures((c) => conf[c], cellErasures));
    if (d.ok) {
      this.fec.combinedRecoveries++;
      this.fec.combinedCaptures += e.captures;
      this.combining.delete(key);
    }
    return d;
  }

  // Decodes a capture, and if that fails, the combination with earlier failed
  // captures of the same frame.
  #decodeOrCombine(key, result, fields, cellErasures, t, headerCopies, keep = true) {
    const d = this.#decode(result, fields, cellErasures);
    if (d.ok) {
      this.combining.delete(key);
      // Clean captures teach the camera-side level shape (mixing.js).
      const q = levelShape(result.pilot?.global);
      if (q) this.qShape = this.qShape ? this.qShape.map((v, l) => 0.8 * v + 0.2 * q[l]) : q;
      const g = result.channelGains;
      if (g && g.every((v) => v > 10)) this.colourGains = this.colourGains ? this.colourGains.map((v, c) => 0.8 * v + 0.2 * g[c]) : [...g];
      return d;
    }
    if (keep) this.#keepFailed(key, result, fields, t, headerCopies);
    return this.#combine(key, result, fields, cellErasures) ?? d;
  }

  // Keeps a failed capture compactly for failure-analysis.js (bounded).
  #keepFailed(key, result, fields, t, headerCopies) {
    if (this.failed.length >= this.keepFailed) return;
    const N = this.payloadIndex.length;
    const symbols = new Uint8Array(N);
    for (let c = 0; c < N; c++) symbols[c] = result.symbols[this.payloadIndex[c]];
    let coord = null;
    let spacing = null;
    let noise = null;
    let medianSpacing = null;
    let misfit = null;
    let pilotVariance = null;
    if (result.soft?.coord) {
      coord = new Uint8Array(N); // (u + 0.5) * 50, 255 = not read
      spacing = new Uint8Array(N); // luma, rounded
      for (let c = 0; c < N; c++) {
        const i = this.payloadIndex[c];
        const u = result.soft.coord[i];
        coord[c] = Number.isNaN(u) ? 255 : Math.max(0, Math.min(254, Math.round((u + 0.5) * 50)));
        spacing[c] = Math.min(255, Math.round(result.soft.spacing[i]));
      }
      noise = this.#captureNoise(result.soft, result.pilotShift ?? 0);
      const sorted = Array.from(spacing).sort((a, b) => a - b);
      medianSpacing = sorted[N >> 1];
      misfit = Float32Array.from(this.#blockMisfit(result.soft.coord));
      const v = pilotBlockVariance(this.profile, this.pilots, result.soft.coord, objectPilotShift(fields, this.profile.levels));
      pilotVariance = v ? Float32Array.from(v) : null;
    }
    // Raw cell values (luma x 16, 0xffff = not read) for the mixing check.
    let values = null;
    if (result.values) {
      values = new Uint16Array(result.values.length);
      for (let i = 0; i < values.length; i++) {
        const v = result.values[i];
        values[i] = Number.isNaN(v) ? 0xffff : Math.max(0, Math.min(0xfffe, Math.round(v * 16)));
      }
    }
    this.failed.push({
      key,
      t: Math.round(t - (this.firstT ?? t)),
      frameType: fields.frameType,
      sourceBlock: fields.sourceBlock,
      sequence: fields.sequence,
      flags: fields.flags,
      headerCopies: headerCopies.map((c) => (c === 'ok' ? 1 : 0)).join(''),
      symbols,
      coord,
      spacing,
      noise,
      medianSpacing,
      misfit,
      pilotVariance,
      values,
      qShape: this.qShape ? Array.from(this.qShape) : null,
    });
  }

  // t: capture time (ms); result: pipeline.processCapture result;
  // options.cellErasures: per-cell flags of known-bad camera regions (or a
  // function returning them, called only when needed). Returns the class.
  add(t, result, { cellErasures = null } = {}) {
    this.firstT ??= t;
    this.lastT = t;
    const cls = this.#classify(t, result, cellErasures);
    this.counts[cls]++;
    return cls;
  }

  #classify(t, result, cellErasures) {
    const cls = this.#classifyCapture(t, result, cellErasures);
    // A newly decoded frame may be the partner that queued mixed captures wait for.
    if ((cls === 'segment' || cls === 'redundant' || cls === 'manifest') && this.mixedQueue.length) this.#retryMixed(t);
    return cls;
  }

  #classifyCapture(t, result, cellErasures) {
    this.lastFields = null;
    if (!result.ok || !result.symbols) return 'acquisition-failed';
    const h = readHeaders(result.symbols, this.profile, result.values ?? null);
    if (h.transition) return this.#transition(t, result, h, cellErasures);
    if (!h.fields) return isGuard(result) ? 'guard' : 'no-header';
    const f = h.fields;
    // Header fields of the last capture that had a valid header (diagnostics).
    this.lastFields = f;
    if (f.frameType !== FRAME_TYPE.DATA && f.frameType !== FRAME_TYPE.MANIFEST) return 'other-type';
    if (!knownFecFlags(f.flags)) return this.#reject('fec-rate');
    if (!fecRateFromFlags(f.flags)) return this.#reject('no-fec');
    const s = this.#session(f.sessionId, t);
    if (s.state !== 'collecting') return 'done';
    if (f.frameType === FRAME_TYPE.MANIFEST) {
      if (s.manifest) return 'known';
      const d = this.#decodeOrCombine(`${f.sessionId}:m`, result, f, cellErasures, t, h.copies);
      if (!d.ok) return d.cls;
      return this.#acceptManifest(s, d.body, d.layout, t);
    }
    const key = `${f.sourceBlock}:${f.sequence}`;
    if (s.manifest) {
      const known = this.#precheck(s, f.sourceBlock, f.sequence, key);
      if (known) return known;
    } else if (s.pending.has(key)) {
      return 'known';
    }
    const d = this.#decodeOrCombine(`${f.sessionId}:${key}`, result, f, cellErasures, t, h.copies);
    if (d.ok) {
      if (!s.manifest) return this.#buffer(s, key, f.sourceBlock, f.sequence, d.body);
      return this.#acceptData(s, f.sourceBlock, f.sequence, key, d.body, t);
    }
    // Perhaps mixed with a neighbouring frame (mixing.js).
    const u = s.manifest ? this.#unmix(s, f, this.#neighbours(s, f), result, t, cellErasures, h.copies) : null;
    if (u?.ok) return this.#acceptData(s, f.sourceBlock, f.sequence, key, u.body, t);
    return d.cls;
  }

  // ------------------------------------------------------------ mixed captures

  // Transition capture: valid header copies of two frames. Each may be
  // recovered once the other is known, by cancelling it (mixing.js).
  #transition(t, result, h, cellErasures) {
    const frames = h.frames.filter((f) => f.frameType === FRAME_TYPE.DATA && knownFecFlags(f.flags) && fecRateFromFlags(f.flags));
    if (frames.length !== 2 || frames[0].sessionId !== frames[1].sessionId) return 'transition';
    const s = this.sessions.get(frames[0].sessionId);
    if (!s?.manifest || s.state !== 'collecting') return 'transition';
    for (const [n, p] of [
      [frames[0], frames[1]],
      [frames[1], frames[0]],
    ]) {
      const key = `${n.sourceBlock}:${n.sequence}`;
      if (this.#precheck(s, n.sourceBlock, n.sequence, key)) continue;
      const u = this.#unmix(s, n, [p], result, t, cellErasures, h.copies);
      if (u?.ok) return this.#acceptData(s, n.sourceBlock, n.sequence, key, u.body, t);
    }
    return 'transition';
  }

  // Frames shown just before and after `f` (outer code 1: DATA frame d goes
  // to block d mod Z with ESI floor(d / Z)).
  #neighbours(s, f) {
    const m = s.manifest;
    if (m.outerCode !== OUTER_CODE_RLNC || f.frameType !== FRAME_TYPE.DATA) return [];
    const Z = m.blockCount;
    const d = f.sequence * Z + f.sourceBlock;
    return [d - 1, d + 1]
      .filter((x) => x >= 0)
      .map((x) => ({ sessionId: f.sessionId, frameType: FRAME_TYPE.DATA, sourceBlock: x % Z, sequence: Math.floor(x / Z), flags: f.flags }));
  }

  // Symbols of an already decoded frame, regenerated as the sender built
  // them, or null if its content is not known (yet).
  #frameSymbols(s, p) {
    const key = `${s.sessionId}:${p.frameType}:${p.sourceBlock}:${p.sequence}:${p.flags}`;
    const cached = this.partnerCache.get(key);
    if (cached) return cached;
    const m = s.manifest;
    let body = null;
    if (p.frameType === FRAME_TYPE.MANIFEST) {
      body = s.manifestBody;
    } else if (m.outerCode === OUTER_CODE_RLNC) {
      if (p.sourceBlock >= m.blockCount) return null;
      if (!s.decoders[p.sourceBlock]) body = this.#blockSymbol(s, p.sourceBlock, p.sequence);
      else body = this.recentBodies.get(`${s.sessionId}:${p.sourceBlock}:${p.sequence}`) ?? null;
    } else if (s.have[p.sequence]) {
      body = s.data.subarray(p.sequence * m.segmentSize, p.sequence * m.segmentSize + segmentLength(m, p.sequence));
    }
    if (!body) return null;
    const symbols = buildObjectFrame({ profile: this.profile, sessionId: s.sessionId, sequence: p.sequence, frameType: p.frameType, sourceBlock: p.sourceBlock, body, fec: fecRateFromFlags(p.flags) });
    if (this.partnerCache.size >= 8) this.partnerCache.delete(this.partnerCache.keys().next().value);
    this.partnerCache.set(key, symbols);
    return symbols;
  }

  // Encoding symbol `esi` of a completed block, from the decoded object.
  #blockSymbol(s, block, esi) {
    const m = s.manifest;
    const T = m.segmentSize;
    const { first, count } = s.blocks[block];
    const src = [];
    for (let i = first; i < first + count; i++) {
      const seg = new Uint8Array(T);
      seg.set(s.data.subarray(i * T, i * T + segmentLength(m, i)));
      src.push(seg);
    }
    return esi < count ? src[esi] : encodeSymbol(src, coefficients(s.sessionId, block, esi, count));
  }

  // Tries to recover frame `n` from a capture mixed with one of `partners`,
  // the best fitting first (the frames before and after can have the same
  // pilots, object-frame.js objectPilotShift; then both are tried). Returns
  // the decode result, or null (not mixed, or a partner unknown -> queued).
  #unmix(s, n, partners, result, t, cellErasures, copies, queue = true) {
    // Colour profiles: per-channel model on the cell colours (mixing.js).
    const colour = !!this.profile.palette;
    const q = colour ? this.colourGains : this.qShape;
    if (!q || !(colour ? result.rgb : result.values)) return null;
    const L = this.profile.levels;
    const sN = objectPilotShift(n, L);
    const fits = [];
    for (const p of partners) {
      const fit = colour
        ? fitMixingRgb(result.rgb, this.profile, this.pilots, sN, objectPilotShift(p, L), q)
        : fitMixing(result.values, this.profile, this.pilots, sN, objectPilotShift(p, L), q);
      if (fit && fit.share >= MIXED_MIN_SHARE) fits.push({ fit, p });
    }
    if (!fits.length) return null;
    fits.sort((a, b) => b.fit.share - a.fit.share);
    if (queue) this.fec.mixedDetected++;
    const key = `${n.sessionId}:${n.sourceBlock}:${n.sequence}`;
    let d = null;
    let unknown = false;
    for (const { fit, p } of fits) {
      const partner = this.#frameSymbols(s, p);
      if (!partner) {
        unknown = true;
        continue;
      }
      this.fec.mixedAttempts++;
      const pseudo = colour ? cancelPartnerRgb(result.rgb, this.profile, fit, partner, q, this.payloadIndex) : cancelPartner(result.values, this.profile, fit, partner, q, this.payloadIndex);
      // Decoded on its own: the capture itself is already in the combination.
      d = this.#decode(pseudo, n, cellErasures);
      if (d.ok) {
        this.combining.delete(key);
        this.fec.mixedRecoveries++;
        return d;
      }
    }
    if (unknown && queue) this.#queueMixed(s, n, partners, result, t, cellErasures, copies);
    return unknown ? null : d;
  }

  #queueMixed(s, n, partners, result, t, cellErasures, copies) {
    if (this.mixedQueue.length >= MAX_MIXED_QUEUE) this.mixedQueue.shift();
    const kept = { values: Float32Array.from(result.values) };
    if (result.rgb) kept.rgb = Float32Array.from(result.rgb);
    this.mixedQueue.push({ sessionId: s.sessionId, n, partners, result: kept, t, cellErasures, copies });
    this.fec.mixedQueued++;
  }

  // Queued mixed captures whose partner has become known in the meantime.
  #retryMixed(t) {
    for (let progress = true; progress; ) {
      progress = false;
      for (let i = 0; i < this.mixedQueue.length; i++) {
        const e = this.mixedQueue[i];
        const s = this.sessions.get(e.sessionId);
        const key = `${e.n.sourceBlock}:${e.n.sequence}`;
        if (!s?.manifest || s.state !== 'collecting' || this.#precheck(s, e.n.sourceBlock, e.n.sequence, key)) {
          this.mixedQueue.splice(i--, 1);
          continue;
        }
        if (!e.partners.some((p) => this.#frameSymbols(s, p))) continue;
        this.mixedQueue.splice(i--, 1);
        const u = this.#unmix(s, e.n, e.partners, e.result, e.t, e.cellErasures, e.copies, false);
        if (u?.ok) {
          this.#acceptData(s, e.n.sourceBlock, e.n.sequence, key, u.body, t);
          progress = true;
        }
      }
    }
  }

  // Class for a DATA frame that need not be decoded (known or invalid), or null.
  #precheck(s, block, esi, key) {
    const m = s.manifest;
    if (m.outerCode === OUTER_CODE_RLNC) {
      if (block >= m.blockCount) return this.#reject('block-index');
      if (!s.decoders[block] || s.seen.has(key)) return 'known';
      return null;
    }
    if (block !== 0 || esi >= m.segmentCount) return this.#reject('segment-index');
    return s.have[esi] ? 'known' : null;
  }

  #buffer(s, key, block, esi, body) {
    if (this.pendingBytes + body.length > this.maxPendingBytes) return this.#reject('pending-limit');
    s.pending.set(key, { block, esi, body: body.slice() });
    this.pendingBytes += body.length;
    s.segmentFrames++;
    return 'segment';
  }

  #acceptManifest(s, body, layout, t) {
    // Segments must fit a DATA frame of this profile (the highest FEC rate
    // bounds them).
    const m = decodeManifest(body, { maxObjectBytes: this.maxObjectBytes, maxSegmentSize: segmentSizeFor(this.profile, 1) });
    if (!m.ok) return this.#reject(m.reason);
    const manifest = m.manifest;
    // Allocated only now, after the size and block checks (SPEC §16.2).
    s.manifest = manifest;
    s.manifestBody = body.slice();
    s.name = sanitizeFilename(manifest.name);
    s.mime = sanitizeMime(manifest.mime);
    s.data = new Uint8Array(manifest.size);
    if (manifest.outerCode === OUTER_CODE_RLNC) {
      s.blocks = partitionBlocks(manifest.segmentCount, manifest.blockCount);
      s.decoders = s.blocks.map((b) => new BlockDecoder(b.count, manifest.segmentSize));
      s.blocksDone = 0;
    } else {
      s.have = new Uint8Array(manifest.segmentCount);
    }
    s.manifestT = t;
    s.manifestFrames++;
    const pending = [...s.pending.values()];
    s.pending.clear();
    for (const e of pending) {
      this.pendingBytes -= e.body.length;
      const key = `${e.block}:${e.esi}`;
      if (!this.#precheck(s, e.block, e.esi, key)) this.#acceptData(s, e.block, e.esi, key, e.body, t);
    }
    this.#checkComplete(s, t);
    return 'manifest';
  }

  // A decoded DATA frame of a session whose manifest is known.
  #acceptData(s, block, esi, key, body, t) {
    const m = s.manifest;
    if (m.outerCode !== OUTER_CODE_RLNC) {
      if (body.length !== segmentLength(m, esi)) return this.#reject('segment-length');
      s.segmentFrames++;
      s.data.set(body, esi * m.segmentSize);
      s.have[esi] = 1;
      this.#progress(s, t);
      this.#checkComplete(s, t);
      return 'segment';
    }
    if (body.length !== m.segmentSize) return this.#reject('symbol-length');
    s.segmentFrames++;
    s.seen.add(key);
    // Kept for cancelling this frame out of mixed captures of its neighbours.
    if (this.recentBodies.size >= MAX_RECENT_BODIES) this.recentBodies.delete(this.recentBodies.keys().next().value);
    this.recentBodies.set(`${s.sessionId}:${key}`, body.slice());
    const dec = s.decoders[block];
    if (!dec.add(coefficients(s.sessionId, block, esi, dec.k), body)) {
      s.redundant++;
      return 'redundant';
    }
    this.#progress(s, t);
    if (dec.complete) {
      // Row i of the reduced system is source symbol i of the block.
      const { first, count } = s.blocks[block];
      for (let i = 0; i < count; i++) {
        const idx = first + i;
        s.data.set(dec.source(i).subarray(0, segmentLength(m, idx)), idx * m.segmentSize);
      }
      s.decoders[block] = null; // frees the rows
      s.blocksDone++;
      this.#checkComplete(s, t);
    }
    return 'segment';
  }

  #progress(s, t) {
    s.received++;
    if (s.timeline.length < MAX_TIMELINE) s.timeline.push([Math.round(t - s.firstT), s.received]);
  }

  #checkComplete(s, t) {
    const m = s.manifest;
    const done = m.outerCode === OUTER_CODE_RLNC ? s.blocksDone === m.blockCount : s.received === m.segmentCount;
    if (!done) return;
    s.state = 'verifying';
    this.verifying = this.digest(s.data).then((hash) => {
      this.verifying = null;
      if (sameBytes(hash, s.manifest.sha256)) {
        s.state = 'complete';
        s.completeT = t;
        this.completed ??= s;
        this.onComplete?.(s);
      } else {
        // No way to tell which frame was wrong: start over, manifest included.
        s.hashMismatches++;
        s.state = 'collecting';
        s.manifest = null;
        s.data = null;
        s.have = null;
        s.decoders = null;
        s.blocks = null;
        s.blocksDone = 0;
        s.seen.clear();
        s.received = 0;
        this.onHashMismatch?.(s);
      }
    });
  }

  // Resolves once a pending SHA-256 verification has finished.
  async idle() {
    while (this.verifying) await this.verifying;
  }

  // The session to show: completed, else the one with the most progress.
  primary() {
    const all = [...this.sessions.values()];
    if (!all.length) return null;
    const score = (s) => (s.state === 'complete' ? Infinity : s.manifest ? s.received / s.manifest.segmentCount + 1 : s.pending.size / 1e9);
    return all.sort((a, b) => score(b) - score(a) || b.lastT - a.lastT)[0];
  }

  // Serializable state of one session (no object bytes).
  describe(s) {
    if (!s) return null;
    const m = s.manifest;
    return {
      sessionId: s.sessionId.toString(16).padStart(8, '0'),
      state: s.state,
      manifest: m && {
        size: m.size,
        segmentSize: m.segmentSize,
        segmentCount: m.segmentCount,
        sha256: toHex(m.sha256),
        name: s.name,
        mime: s.mime,
        rawNameChanged: s.name !== m.name,
        outerCode: m.outerCode,
        blockCount: m.blockCount,
      },
      received: s.received,
      redundant: s.redundant,
      blocksDone: s.blocksDone,
      pendingSegments: s.pending.size,
      firstFrameMs: s.firstT,
      manifestAfterMs: s.manifestT === null ? null : s.manifestT - s.firstT,
      completeAfterMs: s.completeT === null ? null : s.completeT - s.firstT,
      manifestFrames: s.manifestFrames,
      segmentFrames: s.segmentFrames,
      hashMismatches: s.hashMismatches,
    };
  }

  summary() {
    const captures = Object.values(this.counts).reduce((a, b) => a + b, 0);
    return {
      captures,
      counts: this.counts,
      rejections: this.rejections,
      fec: this.fec,
      durationMs: this.firstT === null ? 0 : this.lastT - this.firstT,
      sessions: [...this.sessions.values()].map((s) => this.describe(s)),
      primary: this.describe(this.primary()),
    };
  }
}
