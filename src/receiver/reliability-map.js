// Per-camera reliability map in camera-image coordinates.
//
// Real measurements showed low-contrast regions that stay at the same place
// in the camera image regardless of framing, distance, holding posture, or
// monitor tilt (camera-side optics / processing). The receiver therefore
// learns, per camera and orientation, which image blocks produce errors:
// every measurement adds its sharp captures' per-block symbol and error
// counts (older data decays), and blocks whose smoothed SER is far above the
// camera's overall SER are marked bad. Bad blocks are shown on the preview,
// used to warn when the pattern overlaps them, and treated as erasures in the
// measurement's erasure simulation (for the inner FEC, SPEC §11.2).

export const BLOCK_PX = 40; // block size at 2160 px on the short side
const REFERENCE_SHORT_SIDE = 2160;
const DECAY = 0.7; // weight of the stored map when a new measurement is merged
const PRIOR_SYMBOLS = 200; // shrinkage toward the global SER for sparse blocks
const MIN_SYMBOLS = 100; // blocks with less (decayed) data are never marked bad
const BAD_FACTOR = 5; // bad = smoothed SER above this multiple of the global SER...
const BAD_FLOOR = 0.01; // ...and above this absolute SER
const STORAGE_PREFIX = 'vdl-reliability-v1:';

// Block grid for a video size; blocks scale with resolution so that maps
// learned at 4K stay meaningful at 1080p.
export function blockGrid(videoWidth, videoHeight) {
  const size = (BLOCK_PX * Math.min(videoWidth, videoHeight)) / REFERENCE_SHORT_SIDE;
  return { size, cols: Math.ceil(videoWidth / size), rows: Math.ceil(videoHeight / size) };
}

export function mapKey(cameraLabel, videoWidth, videoHeight) {
  const orientation = videoWidth >= videoHeight ? 'landscape' : 'portrait';
  const aspect = (Math.max(videoWidth, videoHeight) / Math.min(videoWidth, videoHeight)).toFixed(2);
  return `${cameraLabel || 'camera'}|${orientation}|${aspect}`;
}

export class ReliabilityMap {
  constructor(cols, rows, { symbols = null, errors = null, measurements = 0 } = {}) {
    this.cols = cols;
    this.rows = rows;
    this.symbols = symbols ?? new Float64Array(cols * rows);
    this.errors = errors ?? new Float64Array(cols * rows);
    this.measurements = measurements;
    this.#recompute();
  }

  static empty(videoWidth, videoHeight) {
    const g = blockGrid(videoWidth, videoHeight);
    return new ReliabilityMap(g.cols, g.rows);
  }

  // Adds counts from one measurement (arrays of the same block layout).
  merge(symbols, errors) {
    for (let i = 0; i < this.symbols.length; i++) {
      this.symbols[i] = this.symbols[i] * DECAY + symbols[i];
      this.errors[i] = this.errors[i] * DECAY + errors[i];
    }
    this.measurements++;
    this.#recompute();
  }

  #recompute() {
    const n = this.cols * this.rows;
    let s = 0;
    let e = 0;
    for (let i = 0; i < n; i++) {
      s += this.symbols[i];
      e += this.errors[i];
    }
    this.globalSer = s ? e / s : 0;
    // Shrink sparse blocks toward the global rate, then smooth over 3 x 3.
    const shrunk = new Float64Array(n);
    for (let i = 0; i < n; i++) shrunk[i] = (this.errors[i] + PRIOR_SYMBOLS * this.globalSer) / (this.symbols[i] + PRIOR_SYMBOLS);
    this.ser = new Float64Array(n);
    this.bad = new Uint8Array(n);
    const threshold = Math.max(BAD_FLOOR, BAD_FACTOR * this.globalSer);
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        let sum = 0;
        let cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= this.cols || yy >= this.rows) continue;
            const j = yy * this.cols + xx;
            if (!this.symbols[j]) continue;
            sum += shrunk[j];
            cnt++;
          }
        }
        const i = y * this.cols + x;
        this.ser[i] = cnt ? sum / cnt : 0;
        this.bad[i] = this.symbols[i] >= MIN_SYMBOLS && this.ser[i] > threshold ? 1 : 0;
      }
    }
    this.badCount = this.bad.reduce((a, b) => a + b, 0);
  }

  blockAt(x, y, grid) {
    const bx = Math.floor(x / grid.size);
    const by = Math.floor(y / grid.size);
    if (bx < 0 || by < 0 || bx >= this.cols || by >= this.rows) return -1;
    return by * this.cols + bx;
  }

  isBad(x, y, grid) {
    const b = this.blockAt(x, y, grid);
    return b >= 0 && this.bad[b] === 1;
  }

  // Bad blocks as rectangles in camera pixels, for drawing.
  badRects(grid) {
    const out = [];
    for (let i = 0; i < this.bad.length; i++) {
      if (!this.bad[i]) continue;
      const x = (i % this.cols) * grid.size;
      const y = Math.floor(i / this.cols) * grid.size;
      out.push([x, y, x + grid.size, y + grid.size]);
    }
    return out;
  }

  toJSON() {
    // Sparse and rounded: [blockIndex, symbols, errors] for blocks with data.
    const blocks = [];
    for (let i = 0; i < this.symbols.length; i++) {
      if (this.symbols[i] >= 1) blocks.push([i, Math.round(this.symbols[i]), Math.round(this.errors[i] * 10) / 10]);
    }
    return { cols: this.cols, rows: this.rows, measurements: this.measurements, blocks };
  }

  static fromJSON(j) {
    const symbols = new Float64Array(j.cols * j.rows);
    const errors = new Float64Array(j.cols * j.rows);
    for (const [i, s, e] of j.blocks) {
      symbols[i] = s;
      errors[i] = e;
    }
    return new ReliabilityMap(j.cols, j.rows, { symbols, errors, measurements: j.measurements });
  }

  summary() {
    return { measurements: this.measurements, globalSer: this.globalSer, badBlocks: this.badCount, blocks: this.cols * this.rows };
  }
}

// localStorage persistence (browser only).
export function loadMap(key, videoWidth, videoHeight) {
  const g = blockGrid(videoWidth, videoHeight);
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    if (raw) {
      const m = ReliabilityMap.fromJSON(JSON.parse(raw));
      if (m.cols === g.cols && m.rows === g.rows) return m;
    }
  } catch {
    // Corrupt or unavailable storage: start over.
  }
  return ReliabilityMap.empty(videoWidth, videoHeight);
}

export function saveMap(key, map) {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(map.toJSON()));
    return true;
  } catch {
    return false;
  }
}

export function clearMap(key) {
  try {
    localStorage.removeItem(STORAGE_PREFIX + key);
  } catch {
    // ignore
  }
}
