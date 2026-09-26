// Pilot-based symbol decision (SPEC §7, ROADMAP M2).
//
// For every level, the pilot samples are fitted with a quadratic surface over
// the frame, c_l(x, y), which absorbs vignetting, viewing-angle and display
// non-uniformity. Each cell is then assigned to the nearest *local* center.
// The confidence of a decision is how far the cell lies from the boundary
// between its two nearest local centers, normalized to [0, 1]
// (0 = on the boundary, 1 = on a center), for use as soft / erasure
// information later (SPEC §11.2).

import { solveLinear } from './homography.js';

export const PILOT_DEMOD_METHOD = 'per-level quadratic surface over distributed pilots, nearest local center';

const TERMS = 6; // 1, u, v, u^2, uv, v^2
const MIN_ROBUST_SIGMA = 2; // luma; floor for the outlier threshold

function basis(u, v, out) {
  out[0] = 1;
  out[1] = u;
  out[2] = v;
  out[3] = u * u;
  out[4] = u * v;
  out[5] = v * v;
  return out;
}

// Normalized coordinates of a cell center in [-1, 1].
function cellUV(i, w, h, out) {
  const x = i % w;
  const y = (i - x) / w;
  out[0] = ((x + 0.5) / w) * 2 - 1;
  out[1] = ((y + 0.5) / h) * 2 - 1;
  return out;
}

function fit(points) {
  const A = new Float64Array(TERMS * TERMS);
  const b = new Float64Array(TERMS);
  const phi = new Float64Array(TERMS);
  for (const [u, v, val] of points) {
    basis(u, v, phi);
    for (let r = 0; r < TERMS; r++) {
      b[r] += phi[r] * val;
      for (let c = 0; c < TERMS; c++) A[r * TERMS + c] += phi[r] * phi[c];
    }
  }
  return solveLinear(A, b, TERMS);
}

function evalSurface(coef, u, v) {
  return coef[0] + coef[1] * u + coef[2] * v + coef[3] * u * u + coef[4] * u * v + coef[5] * v * v;
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : NaN;
};

// Robust quadratic fit: two rounds of rejecting residuals beyond 3 sigma (MAD).
function robustFit(points) {
  let pts = points;
  let coef = null;
  for (let round = 0; round < 3; round++) {
    if (pts.length < TERMS * 2) return pts.length ? { coef: [median(pts.map((p) => p[2])), 0, 0, 0, 0, 0], used: pts.length, sigma: null } : null;
    coef = fit(pts);
    if (!coef) return null;
    const res = pts.map(([u, v, val]) => val - evalSurface(coef, u, v));
    const sigma = Math.max(MIN_ROBUST_SIGMA, 1.4826 * median(res.map(Math.abs)));
    if (round === 2) return { coef: [...coef], used: pts.length, sigma };
    const next = pts.filter((_, k) => Math.abs(res[k]) <= 3 * sigma);
    if (next.length === pts.length) return { coef: [...coef], used: pts.length, sigma };
    pts = next;
  }
  return { coef: [...coef], used: pts.length, sigma: null };
}

// values: Float32Array of cell means; layout: pilots.js layout.
// Returns { global: [L] medians, surfaces: [{ coef, used, sigma }] } or null.
export function estimateLevelSurfaces(values, profile, layout) {
  const { gridWidth: w, gridHeight: h, levels } = profile;
  const byLevel = Array.from({ length: levels }, () => []);
  const uv = [0, 0];
  for (let k = 0; k < layout.count; k++) {
    const i = layout.cells[k];
    const val = values[i];
    if (Number.isNaN(val)) continue;
    cellUV(i, w, h, uv);
    byLevel[layout.levels[k]].push([uv[0], uv[1], val]);
  }
  const surfaces = byLevel.map(robustFit);
  if (surfaces.some((s) => !s)) return null;
  return { global: byLevel.map((pts) => median(pts.map((p) => p[2]))), surfaces };
}

// Local alternative to the quadratic surfaces: every pilot tile contributes
// one sample per level; the samples are smoothed with a Gaussian over the
// tile lattice and interpolated bilinearly. It follows localized degradation
// (reflections, moiré, local blur) that a single quadratic cannot, at the
// price of more noise per center.
export const PILOT_GRID_SIGMA_TILES = 1.0;
export const PILOT_GRID_METHOD = 'pilot tiles per level, Gaussian-smoothed lattice (sigma 1 tile), bilinear, nearest local center';

export function estimateLevelGrid(values, profile, layout, sigmaTiles = PILOT_GRID_SIGMA_TILES) {
  const { gridWidth: w, levels } = profile;
  const { tilesX: tx, tilesY: ty } = layout;
  const raw = Array.from({ length: levels }, () => new Float64Array(tx * ty).fill(NaN));
  // Tile centers in cell coordinates (mean of the tile's cells).
  const cx = new Float64Array(tx * ty);
  const cy = new Float64Array(tx * ty);
  for (let k = 0; k < layout.count; k++) {
    const t = Math.floor(k / levels);
    const i = layout.cells[k];
    cx[t] += (i % w) + 0.5;
    cy[t] += Math.floor(i / w) + 0.5;
    const v = values[i];
    if (!Number.isNaN(v)) raw[layout.levels[k]][t] = v;
  }
  for (let t = 0; t < tx * ty; t++) {
    cx[t] /= levels;
    cy[t] /= levels;
  }
  const r = Math.ceil(2.5 * sigmaTiles);
  const smooth = raw.map((g) => {
    const out = new Float64Array(tx * ty);
    for (let j = 0; j < ty; j++) {
      for (let i = 0; i < tx; i++) {
        let s = 0;
        let ws = 0;
        for (let dj = -r; dj <= r; dj++) {
          for (let di = -r; di <= r; di++) {
            const ii = i + di;
            const jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= tx || jj >= ty) continue;
            const v = g[jj * tx + ii];
            if (Number.isNaN(v)) continue;
            const wgt = Math.exp(-(di * di + dj * dj) / (2 * sigmaTiles * sigmaTiles));
            s += wgt * v;
            ws += wgt;
          }
        }
        out[j * tx + i] = ws ? s / ws : NaN;
      }
    }
    return out;
  });
  return { tilesX: tx, tilesY: ty, cx, cy, smooth };
}

// Nearest-center decision with per-cell centers interpolated bilinearly from
// the smoothed tile lattice. The lattice is regular, so the interpolation
// index and weight are computed once per column and per row.
// soft (optional { coord, spacing }, Float32Arrays): per cell, the continuous
// level coordinate (levelCoord) and the local mean spacing between adjacent
// level centers in luma, for combining several captures of the same frame.
export function classifyGrid(values, profile, grid, symbols, confidence, soft = null) {
  const coord = soft?.coord;
  const spacing = soft?.spacing;
  const { gridWidth: w, gridHeight: h, levels } = profile;
  const { tilesX: tx, tilesY: ty, cx, cy, smooth } = grid;
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const colI = new Int32Array(w);
  const colF = new Float64Array(w);
  for (let x = 0; x < w; x++) {
    const xc = x + 0.5;
    let i = 0;
    while (i < tx - 2 && cx[i + 1] <= xc) i++;
    colI[x] = i;
    colF[x] = clamp01((xc - cx[i]) / (cx[i + 1] - cx[i]));
  }
  const rowJ = new Int32Array(h);
  const rowF = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    const yc = y + 0.5;
    let j = 0;
    while (j < ty - 2 && cy[(j + 1) * tx] <= yc) j++;
    rowJ[y] = j;
    rowF[y] = clamp01((yc - cy[j * tx]) / (cy[(j + 1) * tx] - cy[j * tx]));
  }
  const centers = new Float64Array(levels);
  for (let y = 0; y < h; y++) {
    const j = rowJ[y];
    const fy = rowF[y];
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (Number.isNaN(values[i])) {
        symbols[i] = 0;
        if (confidence) confidence[i] = NaN;
        if (coord) coord[i] = NaN;
        if (spacing) spacing[i] = 0;
        continue;
      }
      const t = j * tx + colI[x];
      const fx = colF[x];
      for (let l = 0; l < levels; l++) {
        const g = smooth[l];
        centers[l] = (g[t] * (1 - fx) + g[t + 1] * fx) * (1 - fy) + (g[t + tx] * (1 - fx) + g[t + tx + 1] * fx) * fy;
      }
      decide(values[i], centers, levels, i, symbols, confidence);
      if (coord) coord[i] = levelCoord(values[i], centers, levels, symbols[i]);
      if (spacing) spacing[i] = Math.max(0, (centers[levels - 1] - centers[0]) / (levels - 1));
    }
  }
}

// Continuous level coordinate of a value between the local centers: l at
// center l, l + 0.5 halfway to center l + 1 (so rounding reproduces the
// nearest-center decision), clamped to [-0.5, L - 0.5]. Unlike luma it does
// not depend on the capture's exposure or contrast, so coordinates of
// several captures of the same cell can be averaged. Falls back to the hard
// decision if the centers are not increasing.
export function levelCoord(val, c, levels, hard) {
  for (let l = 1; l < levels; l++) if (!(c[l] > c[l - 1])) return hard;
  if (val <= c[0]) return Math.max(-0.5, -(c[0] - val) / (c[1] - c[0]));
  for (let l = 0; l < levels - 1; l++) if (val <= c[l + 1]) return l + (val - c[l]) / (c[l + 1] - c[l]);
  return Math.min(levels - 0.5, levels - 1 + (val - c[levels - 1]) / (c[levels - 1] - c[levels - 2]));
}

// Nearest-center decision with per-cell centers from the surfaces.
// Writes symbols and confidence (Float32Array, NaN for unsampled cells).
export function classifyLocal(values, profile, est, symbols, confidence = null) {
  const { gridWidth: w, gridHeight: h, levels } = profile;
  const centers = new Float64Array(levels);
  const uv = [0, 0];
  for (let i = 0; i < values.length; i++) {
    const val = values[i];
    if (Number.isNaN(val)) {
      symbols[i] = 0;
      if (confidence) confidence[i] = NaN;
      continue;
    }
    cellUV(i, w, h, uv);
    for (let l = 0; l < levels; l++) centers[l] = evalSurface(est.surfaces[l].coef, uv[0], uv[1]);
    decide(val, centers, levels, i, symbols, confidence);
  }
}

// Same decision with position-independent centers (for comparison).
export function classifyGlobal(values, centers, symbols, confidence) {
  const c = Float64Array.from(centers);
  for (let i = 0; i < values.length; i++) {
    if (Number.isNaN(values[i])) {
      symbols[i] = 0;
      if (confidence) confidence[i] = NaN;
      continue;
    }
    decide(values[i], c, c.length, i, symbols, confidence);
  }
}

function decide(val, centers, levels, i, symbols, confidence) {
  let best = 0;
  let second = -1;
  for (let l = 1; l < levels; l++) {
    if (Math.abs(val - centers[l]) < Math.abs(val - centers[best])) {
      second = best;
      best = l;
    } else if (second < 0 || Math.abs(val - centers[l]) < Math.abs(val - centers[second])) {
      second = l;
    }
  }
  symbols[i] = best;
  if (!confidence) return;
  const gap = Math.abs(centers[best] - centers[second]);
  const d1 = Math.abs(val - centers[best]);
  const d2 = Math.abs(val - centers[second]);
  confidence[i] = gap > 0 ? Math.min(1, (d2 - d1) / gap) : 0;
}
