// Dynamic-frame reception (ROADMAP M4, EXPERIMENTS Experiment 6).
//
// Every processed capture is classified as
//   acquisition-failed  the screen was not located / aligned
//   no-header           no header copy passed its CRC
//   transition          valid header copies disagree (rolling shutter or
//                       display scan-out crossed a logical-frame change)
//   degraded            header valid, but payload SER above CLEAN_SER
//                       (a transition between copies, or blur)
//   guard               a guard frame (uniform gray between logical frames):
//                       outline found, no header, no level contrast
//   clean               first acceptable capture of a logical frame
//   duplicate           a further acceptable capture of an already-clean frame
// Payload errors are measured against the frame regenerated from the header's
// session ID and sequence number (TEST frames, SPEC §9.2 / §11.1).
//
// Frames with inner FEC (header flags, fec.js) are also decoded, errors-only
// and with erasures (low-confidence cells and cells in known-bad camera
// regions), and checked against the true data: a logical frame is
// "delivered" once any capture of it decodes to exactly the right bytes.

import { bitsToHeader, decodeHeader } from '../common/header.js';
import { headerLayout } from '../common/frame-layout.js';
import { buildTestFrame, payloadMask, fecTestData } from '../common/test-frame.js';
import { fecLayout, fecRateFromFlags, knownFecFlags, decodeFecBytes, symbolBitsToBytes, symbolFlagsToByteFlags } from '../common/fec.js';
import { bitsPerSymbol } from '../common/profiles.js';
import { symbolToBits } from '../common/gray.js';
import { FRAME_TYPE } from '../common/protocol.js';

export const CLEAN_SER = 0.02;
// Cells decided with less confidence than this are erasures (pilot-demod.js).
export const ERASURE_CONFIDENCE = 0.15;
// Pilot contrast (brightest - darkest center) below this means a guard frame.
const GUARD_CONTRAST = 20;
const MAX_RECORDS = 3000;
const PATTERN = 'dynamic';

// Reads the four header copies from decided symbols (binary: upper half of
// the alphabet = 1, so S3 -> S2 confusions still read as 1).
// values (optional): raw cell means; the header cells are then read with a
// binary threshold halfway between their dark and bright values, which also
// holds for captures blending two frames (header bits then sit between S1 and
// S2 and the 4-level decision would split them wrongly).
export function readHeaders(symbols, profile, values = null) {
  const { copies } = headerLayout(profile);
  const half = profile.levels / 2;
  let thr = null;
  if (values) {
    const hv = [];
    for (const c of copies) for (const i of c) if (!Number.isNaN(values[i])) hv.push(values[i]);
    hv.sort((a, b) => a - b);
    if (hv.length) thr = (hv[Math.floor(hv.length * 0.1)] + hv[Math.floor(hv.length * 0.9)]) / 2;
  }
  const results = copies.map((cells) => {
    const bits = new Uint8Array(cells.length);
    for (let b = 0; b < cells.length; b++) bits[b] = (thr === null ? symbols[cells[b]] >= half : values[cells[b]] > thr) ? 1 : 0;
    return decodeHeader(bitsToHeader(bits));
  });
  const valid = results.filter((r) => r.ok);
  // Frame type and source block too: a MANIFEST and DATA segment 0 share
  // sequence 0, and consecutive outer-code frames of different blocks share
  // their ESI (object-frame.js).
  const byKey = new Map(valid.map((r) => [`${r.fields.sessionId}:${r.fields.frameType}:${r.fields.sourceBlock}:${r.fields.sequence}`, r.fields]));
  return {
    copies: results.map((r) => (r.ok ? 'ok' : r.reason)),
    validCount: valid.length,
    transition: byKey.size > 1,
    fields: byKey.size === 1 ? valid[0].fields : null,
    frames: [...byKey.values()], // distinct frames with a valid copy
    sequences: [...new Set(valid.map((r) => r.fields.sequence))],
  };
}

// Guard frame: the outline was found but the pilots show no level contrast.
export function isGuard(result) {
  const c = result.pilot?.global;
  return !!c && c[c.length - 1] - c[0] < GUARD_CONTRAST;
}

function popcount(v) {
  let c = 0;
  while (v) {
    c += v & 1;
    v >>>= 1;
  }
  return c;
}

export class Reception {
  constructor(profile) {
    this.profile = profile;
    this.payload = payloadMask(profile, PATTERN);
    this.payloadCells = this.payload.reduce((a, b) => a + b, 0);
    this.bps = bitsPerSymbol(profile.levels);
    this.counts = { 'acquisition-failed': 0, guard: 0, 'no-header': 0, transition: 0, degraded: 0, clean: 0, duplicate: 0 };
    this.frames = new Map(); // sequence -> { captures, clean, firstT, ser }
    this.sessions = new Set();
    this.records = [];
    this.recordsTruncated = false;
    this.firstT = null;
    this.lastT = null;
    this.totals = { symbols: 0, symbolErrors: 0, bits: 0, bitErrors: 0 };
    this.headerCopiesValid = [0, 0, 0, 0, 0]; // histogram of valid copies per capture
    this.expectedCache = new Map();
    this.fecRates = new Set();
    this.fec = { decodes: 0, codewords: 0, codewordFailures: 0, codewordFailuresErrorsOnly: 0, corrected: 0, erasures: 0, miscorrections: 0, erasedBytes: 0, bytes: 0 };
  }

  #expected(sessionId, sequence, fec) {
    const key = `${sessionId}:${sequence}:${fec}`;
    let e = this.expectedCache.get(key);
    if (!e) {
      const layout = fec ? fecLayout(this.profile, this.payloadCells, fec) : null;
      e = {
        symbols: buildTestFrame({ pattern: PATTERN, profile: this.profile, sessionId, sequence, fec }),
        data: layout ? fecTestData(this.profile, sessionId, sequence, layout).data : null,
        layout,
      };
      this.expectedCache.set(key, e);
      if (this.expectedCache.size > 16) this.expectedCache.delete(this.expectedCache.keys().next().value);
    }
    return e;
  }

  // Decodes the inner FEC of one capture twice (errors only / with erasures).
  #decodeFec(result, expected, cellErasures) {
    const { layout, data: truth } = expected;
    const groups = new Uint8Array(this.payloadCells);
    const flags = new Uint8Array(this.payloadCells);
    let c = 0;
    for (let i = 0; i < this.payload.length; i++) {
      if (!this.payload[i]) continue;
      groups[c] = symbolToBits(result.symbols[i]);
      const conf = result.confidence ? result.confidence[i] : 1;
      flags[c] = !(conf >= ERASURE_CONFIDENCE) || (cellErasures && cellErasures[i]) ? 1 : 0;
      c++;
    }
    const bytes = symbolBitsToBytes(groups, this.bps, layout.bytes);
    const erased = symbolFlagsToByteFlags(flags, this.bps, layout.bytes);
    const eo = decodeFecBytes(layout, Uint8Array.from(bytes), null);
    const er = decodeFecBytes(layout, Uint8Array.from(bytes), erased);
    const same = (d) => d.every((v, i) => v === truth[i]);
    const eoOk = eo.ok && same(eo.data);
    const erOk = er.ok && same(er.data);
    const f = this.fec;
    f.decodes++;
    f.codewords += layout.codewords;
    f.codewordFailures += er.codewords.filter((r) => !r.ok).length;
    f.codewordFailuresErrorsOnly += eo.codewords.filter((r) => !r.ok).length;
    f.corrected += er.corrected;
    f.erasures += er.erasures;
    f.erasedBytes += erased.reduce((a, b) => a + b, 0);
    f.bytes += layout.bytes;
    if ((er.ok && !erOk) || (eo.ok && !eoOk)) f.miscorrections++;
    return { ok: erOk, okErrorsOnly: eoOk, failed: er.codewords.filter((r) => !r.ok).length, corrected: er.corrected, erasures: er.erasures };
  }

  #compare(symbols, expected) {
    let errors = 0;
    let bitErrors = 0;
    for (let i = 0; i < symbols.length; i++) {
      if (!this.payload[i] || symbols[i] === expected[i]) continue;
      errors++;
      bitErrors += popcount(symbolToBits(symbols[i]) ^ symbolToBits(expected[i]));
    }
    return { errors, bitErrors, ser: errors / this.payloadCells };
  }

  // t: capture time (ms); result: pipeline.processCapture result.
  // options.cellErasures: per-cell flags of known-bad camera regions.
  add(t, result, { cellErasures = null } = {}) {
    // With parallel workers, results can arrive slightly out of order.
    if (this.firstT === null || t < this.firstT) this.firstT = t;
    if (this.lastT === null || t > this.lastT) this.lastT = t;
    this.originT ??= t;
    let cls;
    let rec = { t: Math.round(t - this.originT) };
    if (!result.ok || !result.symbols) {
      cls = 'acquisition-failed';
      rec.reason = result.reason;
    } else {
      const h = readHeaders(result.symbols, this.profile);
      this.headerCopiesValid[h.validCount]++;
      rec.headerCopies = h.validCount;
      if (h.transition) {
        cls = 'transition';
        rec.sequences = h.sequences;
      } else if (!h.fields) {
        cls = isGuard(result) ? 'guard' : 'no-header';
      } else if (h.fields.frameType !== FRAME_TYPE.TEST) {
        // File-transfer frames carry no known test payload to compare with.
        cls = 'no-header';
        rec.reason = `frame-type-${h.fields.frameType}`;
      } else if (!knownFecFlags(h.fields.flags)) {
        cls = 'no-header';
        rec.reason = 'fec-rate';
      } else {
        const { sessionId, sequence, flags } = h.fields;
        this.sessions.add(sessionId);
        const fec = fecRateFromFlags(flags);
        const expected = this.#expected(sessionId, sequence, fec);
        const cmp = this.#compare(result.symbols, expected.symbols);
        let f = this.frames.get(sequence);
        if (!f) {
          f = { captures: 0, clean: false, firstT: t, rawErrorFree: false, delivered: false, deliveredErrorsOnly: false, fec };
          this.frames.set(sequence, f);
        }
        f.captures++;
        rec.sequence = sequence;
        rec.ser = +cmp.ser.toFixed(5);
        if (cmp.errors === 0) f.rawErrorFree = true;
        if (fec) {
          this.fecRates.add(fec);
          // Skip decoding once a frame has been delivered both ways.
          if (!f.delivered || !f.deliveredErrorsOnly) {
            const d = this.#decodeFec(result, expected, cellErasures);
            f.delivered ||= d.ok;
            f.deliveredErrorsOnly ||= d.okErrorsOnly;
            rec.fec = d;
          }
        }
        if (cmp.ser > CLEAN_SER) {
          cls = 'degraded';
        } else if (f.clean) {
          cls = 'duplicate';
        } else {
          cls = 'clean';
          f.clean = true;
          f.ser = cmp.ser;
          // Error statistics count one capture per logical frame.
          this.totals.symbols += this.payloadCells;
          this.totals.symbolErrors += cmp.errors;
          this.totals.bits += this.payloadCells * this.bps;
          this.totals.bitErrors += cmp.bitErrors;
        }
      }
    }
    this.counts[cls]++;
    rec.class = cls;
    if (this.records.length < MAX_RECORDS) this.records.push(rec);
    else this.recordsTruncated = true;
    return cls;
  }

  summary() {
    const captures = Object.values(this.counts).reduce((a, b) => a + b, 0);
    const seqs = [...this.frames.keys()].sort((a, b) => a - b);
    const clean = seqs.filter((s) => this.frames.get(s).clean);
    const durationMs = this.firstT === null ? 0 : this.lastT - this.firstT;
    const span = seqs.length ? seqs[seqs.length - 1] - seqs[0] + 1 : 0;
    const perFrame = {};
    for (const s of seqs) {
      const n = this.frames.get(s).captures;
      perFrame[n] = (perFrame[n] ?? 0) + 1;
    }
    const t = this.totals;
    const ber = t.bits ? t.bitErrors / t.bits : null;
    const goodFps = durationMs > 0 ? clean.length / (durationMs / 1000) : null;
    const perSecond = (count) => (durationMs > 0 ? count / (durationMs / 1000) : null);
    const frames = [...this.frames.values()];
    const rawErrorFree = frames.filter((f) => f.rawErrorFree).length;
    const fecRate = [...this.fecRates][0] ?? 0;
    const layout = fecRate ? fecLayout(this.profile, this.payloadCells, fecRate) : null;
    let fec = null;
    if (layout) {
      const delivered = frames.filter((f) => f.delivered).length;
      const deliveredEO = frames.filter((f) => f.deliveredErrorsOnly).length;
      const x = this.fec;
      fec = {
        rateIndex: fecRate,
        name: layout.name,
        codewordsPerFrame: layout.codewords,
        n: layout.n,
        nsym: layout.nsym,
        k: layout.k,
        codeRate: layout.codeRate,
        dataBytesPerFrame: layout.dataBytes,
        framesDelivered: delivered,
        framesDeliveredErrorsOnly: deliveredEO,
        deliveredRate: span ? delivered / span : null,
        goodputBitsPerSecond: perSecond(delivered * layout.dataBytes * 8),
        goodputErrorsOnlyBitsPerSecond: perSecond(deliveredEO * layout.dataBytes * 8),
        ...x,
        codewordFailureRate: x.codewords ? x.codewordFailures / x.codewords : null,
        codewordFailureRateErrorsOnly: x.codewords ? x.codewordFailuresErrorsOnly / x.codewords : null,
        erasedByteShare: x.bytes ? x.erasedBytes / x.bytes : null,
        correctedPerDecode: x.decodes ? x.corrected / x.decodes : null,
      };
    }
    return {
      captures,
      counts: this.counts,
      shares: Object.fromEntries(Object.entries(this.counts).map(([k, v]) => [k, captures ? v / captures : null])),
      headerCopiesValidHistogram: this.headerCopiesValid,
      sessions: [...this.sessions].map((s) => s.toString(16).padStart(8, '0')),
      durationMs,
      firstSequence: seqs[0] ?? null,
      lastSequence: seqs[seqs.length - 1] ?? null,
      sequenceSpan: span,
      framesSeen: seqs.length,
      framesClean: clean.length,
      // Frames within the observed sequence range with no clean capture.
      framesMissed: span - clean.length,
      cleanFrameRate: span ? clean.length / span : null,
      capturesPerFrameHistogram: perFrame,
      goodLogicalFramesPerSecond: goodFps,
      payloadBitsPerFrame: this.payloadCells * this.bps,
      rawPayloadBitsPerSecond: goodFps !== null && ber !== null ? goodFps * this.payloadCells * this.bps * (1 - ber) : null,
      // Without FEC a frame is only usable when it has no symbol error at all.
      framesRawErrorFree: rawErrorFree,
      rawErrorFreeBitsPerSecond: perSecond(rawErrorFree * this.payloadCells * this.bps),
      fec,
      ser: t.symbols ? t.symbolErrors / t.symbols : null,
      ber,
      ...t,
    };
  }
}
