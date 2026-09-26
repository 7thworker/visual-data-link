// Corner refinement from the frame's interior (after the outline edges).
//
// The corners come from lines fitted to the outline's outer edge
// (acquisition.js). Real captures (2026-09-26) still had them 2-7 px (up to
// 0.8 cell) off: blur and glow around the outline, and edges that are not
// quite straight. A misplaced corner shifts whole regions of cells off their
// sampling points, which the inner FEC cannot survive (7 of 8 saved failed
// transfer captures were readable once re-aligned).
//
// Every cell is one flat colour on the screen, so the samples inside a cell
// vary least where the sampling lattice sits on the cell. In a few patches of
// the interior (near the corners and the edge midpoints) the spread of the
// samples is measured for whole-pixel shifts of the lattice; the shift with
// the least spread (refined to sub-pixel by a parabola) moves the patch
// centre, and a homography is fitted to the moved centres. A second pass
// with a small range around the first result corrects patches whose shift
// was ambiguous (a shift of about one cell also lands the lattice on cells).
// No knowledge of levels, pilots or payload is used.

import { applyHomography, fitHomography, logicalCorners } from './homography.js';

// Patch centres as fractions of the grid, patch size in cells.
const PATCH_FX = [0.1, 0.5, 0.9];
const PATCH_FY = [0.13, 0.5, 0.87];
export const PATCH_W = 12;
export const PATCH_H = 10;
export const MAX_PATCHES = 8; // the GPU shader's patch uniforms
export const SPREAD_LATTICE = 4; // n x n samples per cell
export const SPREAD_EXTENT = 0.8; // fraction of the cell covered by the samples
// Patches whose moved centre misses the fitted homography by more than this
// (camera px) are dropped as long as at least MIN_PATCHES remain.
const OUTLIER_PX = 1.5;
const MIN_PATCHES = 6;

// Patches in grid coordinates: { cx, cy, x0, y0, x1, y1 } (cells [x0, x1) x [y0, y1)).
export function interiorPatches(profile) {
  const { gridWidth: w, gridHeight: h } = profile;
  const out = [];
  for (const fy of PATCH_FY) {
    for (const fx of PATCH_FX) {
      if (fx === 0.5 && fy === 0.5) continue;
      const x0 = Math.max(1, Math.min(w - 1 - PATCH_W, Math.round(fx * w - PATCH_W / 2)));
      const y0 = Math.max(1, Math.min(h - 1 - PATCH_H, Math.round(fy * h - PATCH_H / 2)));
      out.push({ cx: x0 + PATCH_W / 2, cy: y0 + PATCH_H / 2, x0, y0, x1: x0 + PATCH_W, y1: y0 + PATCH_H });
    }
  }
  return out;
}

// CPU spread: Float64Array(patches * offsets), the mean over the patch's
// cells of the summed RGB variance of the lattice samples (NaN if a sample
// falls outside the region). img: ImageRegion (x0, y0 = its origin).
export function spreadCpu(img, H, patches, offsets) {
  const n = SPREAD_LATTICE;
  const m = n * n;
  const out = new Float64Array(patches.length * offsets.length);
  const p = [0, 0];
  const { data, width: iw, height: ih, x0: ox = 0, y0: oy = 0 } = img;
  patches.forEach((pa, k) => {
    // Lattice points of the patch in region coordinates (shift-independent).
    const pts = [];
    for (let y = pa.y0; y < pa.y1; y++) {
      for (let x = pa.x0; x < pa.x1; x++) {
        for (let u = 0; u < n; u++) {
          for (let v = 0; v < n; v++) {
            applyHomography(H, x + 0.5 + SPREAD_EXTENT * ((v + 0.5) / n - 0.5), y + 0.5 + SPREAD_EXTENT * ((u + 0.5) / n - 0.5), p);
            pts.push(p[0] - ox, p[1] - oy);
          }
        }
      }
    }
    const cells = pts.length / (2 * m);
    offsets.forEach(([dx, dy], j) => {
      let total = 0;
      for (let c = 0; c < cells && !Number.isNaN(total); c++) {
        let r1 = 0;
        let g1 = 0;
        let b1 = 0;
        let s2 = 0;
        for (let q = 0; q < m; q++) {
          const px = Math.floor(pts[2 * (c * m + q)] + dx);
          const py = Math.floor(pts[2 * (c * m + q) + 1] + dy);
          if (px < 0 || py < 0 || px >= iw || py >= ih) {
            total = NaN;
            break;
          }
          const i = (py * iw + px) * 4;
          r1 += data[i];
          g1 += data[i + 1];
          b1 += data[i + 2];
          s2 += data[i] * data[i] + data[i + 1] * data[i + 1] + data[i + 2] * data[i + 2];
        }
        total += s2 / m - (r1 / m) ** 2 - (g1 / m) ** 2 - (b1 / m) ** 2;
      }
      out[k * offsets.length + j] = total / cells;
    });
  });
  return out;
}

export const shiftGrid = (r) => {
  const o = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) o.push([dx, dy]);
  return o;
};

// Sub-pixel offset of a minimum from three samples at -1, 0, +1.
const parabola = (a, b, c) => {
  const den = a - 2 * b + c;
  return den > 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
};

// One pass: best shift per patch within +-r, then the fitted homography.
function pass(spread, H, patches, r) {
  const offsets = shiftGrid(r);
  const s = spread(H, patches, offsets);
  const W = 2 * r + 1;
  const src = [];
  const dst = [];
  patches.forEach((pa, k) => {
    const base = k * offsets.length;
    let best = -1;
    for (let j = 0; j < offsets.length; j++) {
      const v = s[base + j];
      if (Number.isFinite(v) && (best < 0 || v < s[base + best] - 1e-9)) best = j;
    }
    if (best < 0) return;
    const bx = best % W;
    const by = Math.floor(best / W);
    const at = (x, y) => s[base + y * W + x];
    const fx = bx > 0 && bx < W - 1 ? parabola(at(bx - 1, by), at(bx, by), at(bx + 1, by)) : 0;
    const fy = by > 0 && by < W - 1 ? parabola(at(bx, by - 1), at(bx, by), at(bx, by + 1)) : 0;
    const c = applyHomography(H, pa.cx, pa.cy, [0, 0]);
    src.push([pa.cx, pa.cy]);
    dst.push([c[0] + offsets[best][0] + fx, c[1] + offsets[best][1] + fy]);
  });
  // Mean spread without a shift (the input homography), for the acceptance test.
  const z = offsets.findIndex(([dx, dy]) => !dx && !dy);
  const unshifted = patches.reduce((a, _, k) => a + s[k * offsets.length + z], 0) / patches.length;
  if (src.length < MIN_PATCHES) return null;
  // Robust fit: drop the worst patch while it misses by more than OUTLIER_PX.
  let Hn = fitHomography(src, dst);
  while (Hn && src.length > MIN_PATCHES) {
    let worst = -1;
    let wd = OUTLIER_PX;
    src.forEach(([x, y], i) => {
      const q = applyHomography(Hn, x, y, [0, 0]);
      const d = Math.hypot(q[0] - dst[i][0], q[1] - dst[i][1]);
      if (d > wd) (wd = d), (worst = i);
    });
    if (worst < 0) break;
    src.splice(worst, 1);
    dst.splice(worst, 1);
    Hn = fitHomography(src, dst);
  }
  return Hn ? { H: Hn, used: src.length, unshifted } : null;
}

// spread(H, patches, offsets): e.g. (H, p, o) => spreadCpu(img, H, p, o).
// ppc: camera px per cell. Returns { H, corners (frame order), moved (largest
// corner displacement, px), before / after (mean spread over the patches),
// patches (used) } or null when the result is not trustworthy (the edge-based
// corners stay in use).
export function refineInterior(spread, H, profile, ppc) {
  const patches = interiorPatches(profile);
  const r1 = Math.max(2, Math.min(6, Math.floor(0.45 * ppc)));
  const first = pass(spread, H, patches, r1);
  if (!first) return null;
  const second = pass(spread, first.H, patches, 2);
  const Hn = second?.H ?? first.H;
  // Accept only if the patches got more uniform: the unshifted spread of the
  // second pass (at the first result) against that of the first (at the
  // input). Two GPU passes per capture, no extra readback.
  const before = first.unshifted;
  const after = second ? second.unshifted : before;
  if (!(after < before)) return null;
  const { gridWidth: w, gridHeight: h } = profile;
  const corners = logicalCorners(w, h).map(([x, y]) => applyHomography(Hn, x, y, [0, 0]));
  const old = logicalCorners(w, h).map(([x, y]) => applyHomography(H, x, y, [0, 0]));
  const moved = Math.max(...corners.map((c, i) => Math.hypot(c[0] - old[i][0], c[1] - old[i][1])));
  if (moved > ppc) return null; // more than a cell: something else went wrong
  return { H: Hn, corners, moved, before, after, patches: second?.used ?? first.used };
}
