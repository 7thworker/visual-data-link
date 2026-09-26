// Raw-channel error measurement against a known test frame (SPEC §11.1,
// EXPERIMENTS Experiments 1–2). SER/BER cover payload cells (interior minus
// pilots) of acquired captures only; acquisition failures are counted
// separately. Optionally also: per-level luminance statistics, decision
// confidence bins with an erasure simulation, and alternative decision
// methods evaluated on the same captures.

import { bitsPerSymbol } from '../common/profiles.js';
import { symbolToBits } from '../common/gray.js';
import { testFrameInterior } from '../common/test-frame.js';
import { RunningStats } from './metrics.js';

// Normalized confidence bins (pilot-demod.js: 0 = on a decision boundary).
export const CONFIDENCE_BINS = Object.freeze([0, 0.1, 0.2, 0.35, 0.5, 1.0001]);
// Erasure thresholds for the "treat low-confidence cells as erasures" simulation.
export const ERASURE_THRESHOLDS = Object.freeze([0.1, 0.2]);

// Distance (in cells) from the frame border; the outline itself is d = 0.
export const RING_BINS = Object.freeze([
  { label: 'd=1', min: 1, max: 1 },
  { label: 'd=2-3', min: 2, max: 3 },
  { label: 'd=4-7', min: 4, max: 7 },
  { label: 'd>=8', min: 8, max: Infinity },
]);

const REGION_LABELS = ['TL', 'T', 'TR', 'L', 'C', 'R', 'BL', 'B', 'BR'];
const MAX_ERROR_CELLS = 2000;

function popcount(v) {
  let c = 0;
  while (v) {
    c += v & 1;
    v >>>= 1;
  }
  return c;
}

// Upper 95% bound on an error rate when zero errors were observed ("rule of three").
export function zeroErrorUpperBound(trials) {
  return trials > 0 ? 3 / trials : null;
}

export class Measurement {
  // options.payload: Uint8Array mask of cells to count (default: whole interior).
  constructor(profile, expected, { payload = null } = {}) {
    const { gridWidth: w, gridHeight: h, levels } = profile;
    if (expected.length !== w * h) throw new RangeError('expected frame size mismatch');
    this.profile = profile;
    this.expected = expected;
    this.bps = bitsPerSymbol(levels);
    this.interior = testFrameInterior(profile);

    const n = w * h;
    this.ringOf = new Int8Array(n).fill(-1);
    this.regionOf = new Int8Array(n).fill(-1);
    const { x0, y0, width: iw, height: ih } = this.interior;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const d = Math.min(x, y, w - 1 - x, h - 1 - y);
        if (d === 0 || (payload && !payload[i])) continue;
        this.ringOf[i] = RING_BINS.findIndex((b) => d >= b.min && d <= b.max);
        const rx = Math.min(2, Math.floor(((x - x0) * 3) / iw));
        const ry = Math.min(2, Math.floor(((y - y0) * 3) / ih));
        this.regionOf[i] = ry * 3 + rx;
      }
    }

    this.errorCounts = new Uint32Array(n);
    this.ringTotals = RING_BINS.map(() => ({ symbols: 0, errors: 0 }));
    this.regionTotals = REGION_LABELS.map(() => ({ symbols: 0, errors: 0 }));
    // confusion[expected][observed]
    this.confusion = Array.from({ length: levels }, () => new Array(levels).fill(0));
    this.totals = { captures: 0, symbols: 0, symbolErrors: 0, bits: 0, bitErrors: 0, unsampled: 0 };
    this.levelStats = Array.from({ length: levels }, () => new RunningStats());
    this.confBins = CONFIDENCE_BINS.slice(0, -1).map(() => ({ symbols: 0, errors: 0 }));
    this.erasure = ERASURE_THRESHOLDS.map((t) => ({ threshold: t, erased: 0, erasedErrors: 0, keptErrors: 0 }));
    this.alternatives = {};
    this.mapErasure = { erased: 0, erasedErrors: 0, keptErrors: 0, used: false };
  }

  // Compares one acquired capture. `values` marks unsampled cells as NaN.
  // extras.confidence: per-cell decision confidence; extras.alternatives:
  // { name: symbols } decided by other methods from the same samples.
  // extras.erasures: per-cell mask of cells in known-bad camera regions
  // (reliability-map.js), evaluated as erasures.
  add(observed, values, { confidence = null, alternatives = null, erasures = null } = {}) {
    const r = { symbols: 0, symbolErrors: 0, bits: 0, bitErrors: 0, unsampled: 0 };
    const exp = this.expected;
    const alts = alternatives ? Object.entries(alternatives) : [];
    for (const [name] of alts) this.alternatives[name] ??= { symbols: 0, errors: 0 };
    for (let i = 0; i < exp.length; i++) {
      const ring = this.ringOf[i];
      if (ring < 0) continue;
      if (values && Number.isNaN(values[i])) {
        r.unsampled++;
        continue;
      }
      const wrong = observed[i] !== exp[i];
      if (values) this.levelStats[exp[i]].push(values[i]);
      if (confidence) {
        const c = confidence[i];
        const bin = this.confBins[Math.max(0, CONFIDENCE_BINS.findIndex((b, k) => c >= b && c < CONFIDENCE_BINS[k + 1]))];
        bin.symbols++;
        if (wrong) bin.errors++;
        for (const e of this.erasure) {
          if (c < e.threshold) {
            e.erased++;
            if (wrong) e.erasedErrors++;
          } else if (wrong) {
            e.keptErrors++;
          }
        }
      }
      if (erasures) {
        this.mapErasure.used = true;
        if (erasures[i]) {
          this.mapErasure.erased++;
          if (wrong) this.mapErasure.erasedErrors++;
        } else if (wrong) {
          this.mapErasure.keptErrors++;
        }
      }
      for (const [name, sym] of alts) {
        const a = this.alternatives[name];
        a.symbols++;
        if (sym[i] !== exp[i]) a.errors++;
      }
      r.symbols++;
      r.bits += this.bps;
      this.ringTotals[ring].symbols++;
      this.regionTotals[this.regionOf[i]].symbols++;
      this.confusion[exp[i]][observed[i]]++;
      if (wrong) {
        r.symbolErrors++;
        r.bitErrors += popcount(symbolToBits(observed[i]) ^ symbolToBits(exp[i]));
        this.errorCounts[i]++;
        this.ringTotals[ring].errors++;
        this.regionTotals[this.regionOf[i]].errors++;
      }
    }
    const t = this.totals;
    t.captures++;
    t.symbols += r.symbols;
    t.symbolErrors += r.symbolErrors;
    t.bits += r.bits;
    t.bitErrors += r.bitErrors;
    t.unsampled += r.unsampled;
    r.ser = r.symbols ? r.symbolErrors / r.symbols : null;
    r.ber = r.bits ? r.bitErrors / r.bits : null;
    return r;
  }

  summary() {
    const t = this.totals;
    const rate = (e, n) => (n ? e / n : null);
    const w = this.profile.gridWidth;
    const errorCells = [];
    for (let i = 0; i < this.errorCounts.length; i++) {
      if (this.errorCounts[i]) errorCells.push([i % w, Math.floor(i / w), this.errorCounts[i]]);
    }
    errorCells.sort((a, b) => b[2] - a[2]);
    return {
      ...t,
      ser: rate(t.symbolErrors, t.symbols),
      ber: rate(t.bitErrors, t.bits),
      berUpper95IfZero: t.bitErrors === 0 ? zeroErrorUpperBound(t.bits) : null,
      rings: RING_BINS.map((b, i) => ({ label: b.label, ...this.ringTotals[i], ser: rate(this.ringTotals[i].errors, this.ringTotals[i].symbols) })),
      regions: REGION_LABELS.map((label, i) => ({ label, ...this.regionTotals[i], ser: rate(this.regionTotals[i].errors, this.regionTotals[i].symbols) })),
      confusion: this.confusion,
      levelStats: this.levelStats.map((s) => s.toJSON()),
      confidence: this.confBins.some((b) => b.symbols)
        ? this.confBins.map((b, k) => ({ from: CONFIDENCE_BINS[k], to: Math.min(1, CONFIDENCE_BINS[k + 1]), ...b, share: rate(b.symbols, t.symbols), ser: rate(b.errors, b.symbols) }))
        : null,
      // If cells below the threshold were erasures: how many, how many of the
      // errors they would catch, and the residual SER of the kept cells.
      erasureSimulation: this.confBins.some((b) => b.symbols)
        ? this.erasure.map((e) => ({ ...e, erasureRate: rate(e.erased, t.symbols), residualSer: rate(e.keptErrors, t.symbols - e.erased) }))
        : null,
      mapErasure: this.mapErasure.used
        ? {
            erased: this.mapErasure.erased,
            erasedErrors: this.mapErasure.erasedErrors,
            keptErrors: this.mapErasure.keptErrors,
            erasureRate: rate(this.mapErasure.erased, t.symbols),
            errorsCaught: rate(this.mapErasure.erasedErrors, t.symbolErrors),
            residualSer: rate(this.mapErasure.keptErrors, t.symbols - this.mapErasure.erased),
          }
        : null,
      alternatives: Object.fromEntries(Object.entries(this.alternatives).map(([k, a]) => [k, { ...a, ser: rate(a.errors, a.symbols) }])),
      errorCellCount: errorCells.length,
      errorCells: errorCells.slice(0, MAX_ERROR_CELLS),
      errorCellsTruncated: errorCells.length > MAX_ERROR_CELLS,
    };
  }
}
