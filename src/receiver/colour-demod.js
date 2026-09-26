// Symbol decisions for colour profiles (profile.palette, common/color.js).
//
// The pilot tiles carry every symbol, so the camera-side colour of each
// symbol is known locally: the tile lattice of pilot-demod.js
// (estimateLevelGrid) is built for R, G and B separately, interpolated per
// cell, and the cell takes the symbol whose local colour is nearest in RGB.
// Static and animated measurements (2026-09-26, tools/color-analyze.mjs) gave
// SER 0-0.5% at 8-9 camera px per cell with this rule.
//
// Soft values (for combining several captures of a frame, object-receiver.js):
// per cell and channel a continuous bit coordinate, 0 at the local mean colour
// of the symbols whose bit for that channel is 0 and 1 at those whose bit is
// 1 (symbol bits 2 / 1 / 0 = R / G / B, color.js). Cancelling the neighbouring
// frame (mixing.js) stays luma-only, i.e. off for colour profiles.

import { estimateLevelGrid, gridInterpolation } from './pilot-demod.js';
import { solveLinear } from './homography.js';

const LUMA = [0.2126, 0.7152, 0.0722];

// rgb: Float32Array(3 * cells), NaN where not read. layout: the (shifted)
// pilot layout. Writes symbols and confidence (margin between the nearest and
// the second nearest colour, 0..1) and, if given, bits (Float32Array(3 *
// cells), the soft bit coordinates, NaN where not read). Returns
// { lumaCenters, channelGains }: mean luma of each symbol's pilots (e.g. for
// the outline check) and per channel the mean pilot value with the bit set
// minus that with it clear (the clean contrast for mixing.js).
export function classifyColourGrid(rgb, profile, layout, symbols, confidence = null, bits = null) {
  const { gridWidth: w, gridHeight: h, levels } = profile;
  const n = w * h;
  const ch = [0, 1, 2].map((c) => {
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = rgb[3 * i + c];
    return v;
  });
  const grids = ch.map((v) => estimateLevelGrid(v, profile, layout));
  const { tilesX: tx } = grids[0];
  const { colI, colF, rowJ, rowF } = gridInterpolation(profile, grids[0]);
  const centers = new Float64Array(3 * levels);
  for (let y = 0; y < h; y++) {
    const j = rowJ[y];
    const fy = rowF[y];
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (Number.isNaN(rgb[3 * i])) {
        symbols[i] = 0;
        if (confidence) confidence[i] = NaN;
        if (bits) bits[3 * i] = bits[3 * i + 1] = bits[3 * i + 2] = NaN;
        continue;
      }
      const t = j * tx + colI[x];
      const fx = colF[x];
      for (let c = 0; c < 3; c++) {
        for (let l = 0; l < levels; l++) {
          const g = grids[c].smooth[l];
          centers[3 * l + c] = (g[t] * (1 - fx) + g[t + 1] * fx) * (1 - fy) + (g[t + tx] * (1 - fx) + g[t + tx + 1] * fx) * fy;
        }
      }
      let best = -1;
      let d1 = Infinity;
      let d2 = Infinity;
      for (let l = 0; l < levels; l++) {
        const d = (rgb[3 * i] - centers[3 * l]) ** 2 + (rgb[3 * i + 1] - centers[3 * l + 1]) ** 2 + (rgb[3 * i + 2] - centers[3 * l + 2]) ** 2;
        if (!(d >= 0)) continue; // NaN center (no pilots of that symbol nearby)
        if (d < d1) {
          d2 = d1;
          d1 = d;
          best = l;
        } else if (d < d2) {
          d2 = d;
        }
      }
      symbols[i] = Math.max(0, best);
      if (bits) {
        for (let c = 0; c < 3; c++) {
          const mask = 4 >> c;
          let lo = 0;
          let hi = 0;
          for (let l = 0; l < levels; l++) {
            if (l & mask) hi += centers[3 * l + c];
            else lo += centers[3 * l + c];
          }
          lo /= levels / 2;
          hi /= levels / 2;
          const u = (rgb[3 * i + c] - lo) / (hi - lo);
          bits[3 * i + c] = hi - lo > 1 && Number.isFinite(u) ? Math.max(-0.5, Math.min(1.5, u)) : symbols[i] & mask ? 1 : 0;
        }
      }
      if (confidence) {
        const a = Math.sqrt(d1);
        const b = Math.sqrt(d2);
        confidence[i] = best < 0 || !Number.isFinite(b) ? 0 : (b - a) / (b + a || 1);
      }
    }
  }
  // Mean luma per symbol over the pilots, and the channel contrasts.
  const sum = new Float64Array(levels);
  const cnt = new Float64Array(levels);
  const chSum = new Float64Array(6); // [c][bit]
  const chCnt = new Float64Array(6);
  for (let k = 0; k < layout.count; k++) {
    const i = layout.cells[k];
    if (Number.isNaN(rgb[3 * i])) continue;
    const l = layout.levels[k];
    sum[l] += LUMA[0] * rgb[3 * i] + LUMA[1] * rgb[3 * i + 1] + LUMA[2] * rgb[3 * i + 2];
    cnt[l]++;
    for (let c = 0; c < 3; c++) {
      const bit = l & (4 >> c) ? 1 : 0;
      chSum[2 * c + bit] += rgb[3 * i + c];
      chCnt[2 * c + bit]++;
    }
  }
  const channelGains = [0, 1, 2].map((c) => (chCnt[2 * c] && chCnt[2 * c + 1] ? chSum[2 * c + 1] / chCnt[2 * c + 1] - chSum[2 * c] / chCnt[2 * c] : NaN));
  return { lumaCenters: Array.from(sum, (v, l) => (cnt[l] ? v / cnt[l] : NaN)), channelGains };
}

// Symbol from soft bit coordinates (threshold 0.5 per channel) and its
// confidence (distance of the least certain channel from 0.5, scaled 0..1).
export function symbolFromBits(r, g, b) {
  const s = (r >= 0.5 ? 4 : 0) | (g >= 0.5 ? 2 : 0) | (b >= 0.5 ? 1 : 0);
  const conf = Math.min(1, 2 * Math.min(Math.abs(r - 0.5), Math.abs(g - 0.5), Math.abs(b - 0.5)));
  return { s, conf };
}

// ---------------------------------------------------------------- 27 colours


// 27 colours (palette rgb27, 3 levels per channel, symbol 9 r + 3 g + b):
// deciding each channel on its own fails (3.5-5.5% SER on real captures,
// against 0.3-1.1% with the true colour of every symbol) because the camera
// mixes the channels. An additive model fits them as well as the full
// colours: per channel c,
//
//   v_c = a_c + sum over channels k of (mid_k * m_ck + high_k * h_ck)
//
// (mid_k / high_k: channel k of the symbol is at its middle / high level),
// seven coefficients per channel, fitted per pilot tile from the 9-colour
// pilot tiles nearby (pilots.js PILOT_TILE_27; Gaussian over SIGMA27_TILES),
// then the 27 predicted colours are interpolated per cell and the nearest
// wins (same SER as the full colours on the 2026-09-26 captures).
const SIGMA27_TILES = 1.5;
const RIDGE27 = 1e-3;
const FEATURES27 = Array.from({ length: 27 }, (_, s) => {
  const d = [Math.floor(s / 9), Math.floor(s / 3) % 3, s % 3];
  const f = [1];
  for (let k = 0; k < 3; k++) f.push(d[k] === 1 ? 1 : 0, d[k] === 2 ? 1 : 0);
  return f;
});

export function classifyRgb27(rgb, profile, layout, symbols, confidence = null) {
  const { gridWidth: w, gridHeight: h } = profile;
  const T = layout.tileLength;
  const tiles = layout.count / T;
  const tx = layout.tilesX;
  const ty = layout.tilesY;
  // Normal equations per tile (7 x 7, and 3 right-hand sides) and tile centres.
  const Araw = new Float64Array(tiles * 49);
  const Braw = new Float64Array(tiles * 21);
  const cx = new Float64Array(tiles);
  const cy = new Float64Array(tiles);
  for (let k = 0; k < layout.count; k++) {
    const t = Math.floor(k / T);
    const i = layout.cells[k];
    cx[t] += ((i % w) + 0.5) / T;
    cy[t] += (Math.floor(i / w) + 0.5) / T;
    if (Number.isNaN(rgb[3 * i])) continue;
    const f = FEATURES27[layout.levels[k]];
    for (let u = 0; u < 7; u++) {
      for (let v = 0; v < 7; v++) Araw[t * 49 + u * 7 + v] += f[u] * f[v];
      for (let c = 0; c < 3; c++) Braw[t * 21 + c * 7 + u] += f[u] * rgb[3 * i + c];
    }
  }
  // Smoothed fit per tile -> predicted colours of the 27 symbols.
  const pred = new Float64Array(tiles * 81).fill(NaN);
  const r = Math.ceil(2.5 * SIGMA27_TILES);
  const A = new Float64Array(49);
  const B = new Float64Array(21);
  for (let j = 0; j < ty; j++) {
    for (let i = 0; i < tx; i++) {
      A.fill(0);
      B.fill(0);
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= tx || jj >= ty) continue;
          const t2 = jj * tx + ii;
          const wgt = Math.exp(-(di * di + dj * dj) / (2 * SIGMA27_TILES * SIGMA27_TILES));
          for (let q = 0; q < 49; q++) A[q] += wgt * Araw[t2 * 49 + q];
          for (let q = 0; q < 21; q++) B[q] += wgt * Braw[t2 * 21 + q];
        }
      }
      const scale = A[0] || 1;
      const t = j * tx + i;
      for (let c = 0; c < 3; c++) {
        const Ac = Float64Array.from(A);
        for (let u = 0; u < 7; u++) Ac[u * 7 + u] += RIDGE27 * scale;
        const x = solveLinear(Ac, B.slice(c * 7, c * 7 + 7), 7);
        if (!x) continue;
        for (let s = 0; s < 27; s++) {
          let v = 0;
          for (let u = 0; u < 7; u++) v += x[u] * FEATURES27[s][u];
          pred[t * 81 + s * 3 + c] = v;
        }
      }
    }
  }
  const { colI, colF, rowJ, rowF } = gridInterpolation(profile, { tilesX: tx, tilesY: ty, cx, cy });
  const centers = new Float64Array(81);
  const lumaSum = new Float64Array(27);
  let lumaN = 0;
  for (let y = 0; y < h; y++) {
    const j = rowJ[y];
    const fy = rowF[y];
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (Number.isNaN(rgb[3 * i])) {
        symbols[i] = 0;
        if (confidence) confidence[i] = NaN;
        continue;
      }
      const t = j * tx + colI[x];
      const fx = colF[x];
      for (let q = 0; q < 81; q++) centers[q] = (pred[t * 81 + q] * (1 - fx) + pred[(t + 1) * 81 + q] * fx) * (1 - fy) + (pred[(t + tx) * 81 + q] * (1 - fx) + pred[(t + tx + 1) * 81 + q] * fx) * fy;
      let best = -1;
      let d1 = Infinity;
      let d2 = Infinity;
      for (let s = 0; s < 27; s++) {
        const d = (rgb[3 * i] - centers[3 * s]) ** 2 + (rgb[3 * i + 1] - centers[3 * s + 1]) ** 2 + (rgb[3 * i + 2] - centers[3 * s + 2]) ** 2;
        if (!(d >= 0)) continue;
        if (d < d1) {
          d2 = d1;
          d1 = d;
          best = s;
        } else if (d < d2) d2 = d;
      }
      symbols[i] = Math.max(0, best);
      if (confidence) {
        const a = Math.sqrt(d1);
        const b = Math.sqrt(d2);
        confidence[i] = best < 0 || !Number.isFinite(b) ? 0 : (b - a) / (b + a || 1);
      }
      if (best >= 0 && x % 8 === 0 && y % 8 === 0) {
        for (let s = 0; s < 27; s++) lumaSum[s] += LUMA[0] * centers[3 * s] + LUMA[1] * centers[3 * s + 1] + LUMA[2] * centers[3 * s + 2];
        lumaN++;
      }
    }
  }
  return { lumaCenters: Array.from(lumaSum, (v) => (lumaN ? v / lumaN : NaN)) };
}
