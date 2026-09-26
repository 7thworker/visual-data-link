// Captures mixing two object frames (ROADMAP M8, SPEC §12.1).
//
// The M8 failure analysis found that 10–35% of the failed captures blend
// frame N with the next (or previous) data frame P: the exposure (~33 ms) is
// longer than the guard (16.7 ms). Object frames shift their pilot levels
// from frame to frame (objectPilotShift), so each pilot tile — L cells whose
// levels in N and in P are both known — gives, per tile,
//
//   v = alpha + beta * q(level in N) + gamma * q(level in P)
//
// where q is the camera-side level shape normalized to q(0) = 0, q(L-1) = 1
// (learned from clean captures) and alpha absorbs offset and any guard gray.
// The least-squares solution is smoothed over the tile lattice and
// interpolated per cell. gamma / (beta + gamma) is the share of P.
//
// Once P has been decoded elsewhere, its symbols are known and its
// contribution can be cancelled: v' = v - alpha - gamma * q(s_P) leaves N at
// contrast beta, decided against the centers beta * q(l). Tiles where beta
// is small (almost only P) are marked unusable. The result has the shape of
// a pipeline result (symbols, confidence, soft) so that the receiver can
// decode it or combine it with other captures of N.

import { solveLinear } from './homography.js';
import { levelCoord } from './pilot-demod.js';

const SMOOTH_SIGMA_TILES = 1.0;
// Below this share of N contrast (beta relative to the clean level range) a
// cell is not decided.
const MIN_BETA = 0.12;

// Tile lattice of a pilot layout: per tile the cell indices k and centers.
function tileGeometry(profile, layout) {
  const { gridWidth: w, levels } = profile;
  const T = layout.count / levels;
  const cx = new Float64Array(T);
  const cy = new Float64Array(T);
  for (let k = 0; k < layout.count; k++) {
    const t = Math.floor(k / levels);
    const i = layout.cells[k];
    cx[t] += ((i % w) + 0.5) / levels;
    cy[t] += (Math.floor(i / w) + 0.5) / levels;
  }
  return { T, cx, cy, tx: layout.tilesX, ty: layout.tilesY };
}

function smooth(arr, tx, ty, sigma) {
  const r = Math.ceil(2.5 * sigma);
  const out = new Float64Array(arr.length);
  for (let j = 0; j < ty; j++) {
    for (let i = 0; i < tx; i++) {
      let s = 0;
      let ws = 0;
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= tx || jj >= ty) continue;
          const v = arr[jj * tx + ii];
          if (Number.isNaN(v)) continue;
          const wgt = Math.exp(-(di * di + dj * dj) / (2 * sigma * sigma));
          s += wgt * v;
          ws += wgt;
        }
      }
      out[j * tx + i] = ws ? s / ws : NaN;
    }
  }
  return out;
}

// values: cell means of the capture; layout: the *base* pilot layout;
// shiftN / shiftP: pilot shifts of the two frames; q: level shape [L].
// Returns { alpha, beta, gamma (smoothed per tile), share, geometry } or null.
export function fitMixing(values, profile, layout, shiftN, shiftP, q) {
  const L = profile.levels;
  if (((shiftN - shiftP) % L + L) % L === 0) return null; // not identifiable
  const geo = tileGeometry(profile, layout);
  const alpha = new Float64Array(geo.T).fill(NaN);
  const beta = new Float64Array(geo.T).fill(NaN);
  const gamma = new Float64Array(geo.T).fill(NaN);
  const A = new Float64Array(9);
  const b = new Float64Array(3);
  const row = new Float64Array(3);
  for (let t = 0; t < geo.T; t++) {
    A.fill(0);
    b.fill(0);
    let n = 0;
    for (let m = 0; m < L; m++) {
      const k = t * L + m;
      const v = values[layout.cells[k]];
      if (Number.isNaN(v)) continue;
      row[0] = 1;
      row[1] = q[(layout.levels[k] + shiftN) % L];
      row[2] = q[(layout.levels[k] + shiftP) % L];
      for (let r = 0; r < 3; r++) {
        b[r] += row[r] * v;
        for (let c = 0; c < 3; c++) A[r * 3 + c] += row[r] * row[c];
      }
      n++;
    }
    if (n < 3) continue;
    const x = solveLinear(A, b, 3);
    if (!x) continue;
    [alpha[t], beta[t], gamma[t]] = x;
  }
  const sa = smooth(alpha, geo.tx, geo.ty, SMOOTH_SIGMA_TILES);
  const sb = smooth(beta, geo.tx, geo.ty, SMOOTH_SIGMA_TILES);
  const sg = smooth(gamma, geo.tx, geo.ty, SMOOTH_SIGMA_TILES);
  const shares = [];
  for (let t = 0; t < geo.T; t++) {
    const tot = sb[t] + sg[t];
    if (tot > 1e-6) shares.push(Math.max(0, Math.min(1, sg[t] / tot)));
  }
  shares.sort((x, y) => x - y);
  return { alpha: sa, beta: sb, gamma: sg, share: shares.length ? shares[shares.length >> 1] : 0, geo };
}

// Bilinear interpolation weights on the tile lattice, per column and row
// (as pilot-demod.js classifyGrid).
function lattice(profile, geo) {
  const { gridWidth: w, gridHeight: h } = profile;
  const { tx, ty, cx, cy } = geo;
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const colI = new Int32Array(w);
  const colF = new Float64Array(w);
  for (let x = 0; x < w; x++) {
    let i = 0;
    while (i < tx - 2 && cx[i + 1] <= x + 0.5) i++;
    colI[x] = i;
    colF[x] = clamp01((x + 0.5 - cx[i]) / (cx[i + 1] - cx[i]));
  }
  const rowJ = new Int32Array(h);
  const rowF = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    let j = 0;
    while (j < ty - 2 && cy[(j + 1) * tx] <= y + 0.5) j++;
    rowJ[y] = j;
    rowF[y] = clamp01((y + 0.5 - cy[j * tx]) / (cy[(j + 1) * tx] - cy[j * tx]));
  }
  return { colI, colF, rowJ, rowF, tx };
}

function interp(arr, lat, x, y) {
  const t = lat.rowJ[y] * lat.tx + lat.colI[x];
  const fx = lat.colF[x];
  const fy = lat.rowF[y];
  return (arr[t] * (1 - fx) + arr[t + 1] * fx) * (1 - fy) + (arr[t + lat.tx] * (1 - fx) + arr[t + lat.tx + 1] * fx) * fy;
}

// Cancels the known partner frame. partner: its symbols per cell; cells: the
// cells to decide (payload). Returns a pipeline-like result.
export function cancelPartner(values, profile, fit, partner, q, cells) {
  const { gridWidth: w, levels: L } = profile;
  const n = values.length;
  const lat = lattice(profile, fit.geo);
  const symbols = new Uint8Array(n);
  const confidence = new Float32Array(n).fill(0);
  const coord = new Float32Array(n).fill(NaN);
  const spacing = new Float32Array(n);
  const centers = new Float64Array(L);
  // Full clean level range at this point, for the MIN_BETA test.
  for (const i of cells) {
    const x = i % w;
    const y = Math.floor(i / w);
    const a = interp(fit.alpha, lat, x, y);
    const b = interp(fit.beta, lat, x, y);
    const g = interp(fit.gamma, lat, x, y);
    const v = values[i];
    if (!(b > 0) || Number.isNaN(v) || !(b / (Math.abs(b) + Math.abs(g)) >= MIN_BETA)) continue;
    const r = v - a - g * q[partner[i]];
    for (let l = 0; l < L; l++) centers[l] = b * q[l];
    let best = 0;
    for (let l = 1; l < L; l++) if (Math.abs(r - centers[l]) < Math.abs(r - centers[best])) best = l;
    symbols[i] = best;
    coord[i] = levelCoord(r, centers, L, best);
    spacing[i] = b / (L - 1);
    const u = coord[i];
    confidence[i] = Math.max(0, Math.min(1, 1 - 2 * Math.abs(u - best)));
  }
  return { ok: true, symbols, confidence, soft: { coord, spacing } };
}

// Level shape from a capture's pilot centers (global medians), or null.
export function levelShape(centers) {
  if (!centers || centers.length < 2) return null;
  const lo = centers[0];
  const span = centers[centers.length - 1] - lo;
  if (!(span > 10)) return null;
  const q = centers.map((c) => (c - lo) / span);
  for (let l = 1; l < q.length; l++) if (!(q[l] > q[l - 1])) return null;
  return q;
}

// ---------------------------------------------------------------- colour profiles

// Colour profiles (palette 'rgb8'): each channel of a symbol depends only on
// its own bit (bits 2 / 1 / 0 = R / G / B), so per tile, over the pilot cells
// and the three channels,
//
//   v_c = alpha_c + K_c * (beta * bit_c(level in N) + gamma * bit_c(level in P))
//
// with K_c the clean contrast of channel c (learned from clean captures,
// colour-demod.js channelGains). Five unknowns from 3 x L equations: a
// channel whose bits in N and P are not separable at this pilot shift (e.g.
// red for a shift of 4) is covered by the others.
export function fitMixingRgb(rgb, profile, layout, shiftN, shiftP, gains) {
  const L = profile.levels;
  if (((shiftN - shiftP) % L + L) % L === 0) return null;
  const geo = tileGeometry(profile, layout);
  const out = Array.from({ length: 5 }, () => new Float64Array(geo.T).fill(NaN));
  const A = new Float64Array(25);
  const b = new Float64Array(5);
  const row = new Float64Array(5);
  for (let t = 0; t < geo.T; t++) {
    A.fill(0);
    b.fill(0);
    let n = 0;
    for (let m = 0; m < L; m++) {
      const k = t * L + m;
      const i = layout.cells[k];
      if (Number.isNaN(rgb[3 * i])) continue;
      const sN = (layout.levels[k] + shiftN) % L;
      const sP = (layout.levels[k] + shiftP) % L;
      for (let c = 0; c < 3; c++) {
        const mask = 4 >> c;
        row.fill(0);
        row[c] = 1;
        row[3] = gains[c] * (sN & mask ? 1 : 0);
        row[4] = gains[c] * (sP & mask ? 1 : 0);
        const v = rgb[3 * i + c];
        for (let r = 0; r < 5; r++) {
          b[r] += row[r] * v;
          for (let q = 0; q < 5; q++) A[r * 5 + q] += row[r] * row[q];
        }
        n++;
      }
    }
    if (n < 6) continue;
    const x = solveLinear(A, b, 5);
    if (!x) continue;
    for (let r = 0; r < 5; r++) out[r][t] = x[r];
  }
  const s = out.map((a) => smooth(a, geo.tx, geo.ty, SMOOTH_SIGMA_TILES));
  const shares = [];
  for (let t = 0; t < geo.T; t++) {
    const tot = s[3][t] + s[4][t];
    if (tot > 1e-6) shares.push(Math.max(0, Math.min(1, s[4][t] / tot)));
  }
  shares.sort((x, y) => x - y);
  return { alpha: s.slice(0, 3), beta: s[3], gamma: s[4], share: shares.length ? shares[shares.length >> 1] : 0, geo };
}

// Cancels the known partner frame of a colour capture: per channel the
// remainder over K_c * beta is the soft bit coordinate of N (colour-demod.js).
export function cancelPartnerRgb(rgb, profile, fit, partner, gains, cells) {
  const { gridWidth: w } = profile;
  const n = rgb.length / 3;
  const lat = lattice(profile, fit.geo);
  const symbols = new Uint8Array(n);
  const confidence = new Float32Array(n).fill(0);
  const bits = new Float32Array(3 * n).fill(NaN);
  for (const i of cells) {
    const x = i % w;
    const y = Math.floor(i / w);
    const b = interp(fit.beta, lat, x, y);
    const g = interp(fit.gamma, lat, x, y);
    if (!(b > 0) || Number.isNaN(rgb[3 * i]) || !(b / (Math.abs(b) + Math.abs(g)) >= MIN_BETA)) continue;
    let s = 0;
    let conf = 1;
    for (let c = 0; c < 3; c++) {
      const mask = 4 >> c;
      const a = interp(fit.alpha[c], lat, x, y);
      const u = (rgb[3 * i + c] - a - gains[c] * g * (partner[i] & mask ? 1 : 0)) / (gains[c] * b);
      const uc = Math.max(-0.5, Math.min(1.5, u));
      bits[3 * i + c] = uc;
      if (uc >= 0.5) s |= mask;
      conf = Math.min(conf, Math.min(1, 2 * Math.abs(uc - 0.5)));
    }
    symbols[i] = s;
    confidence[i] = conf;
  }
  return { ok: true, symbols, confidence, soft: { bits } };
}
