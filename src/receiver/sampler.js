// Cell sampling through the homography (SPEC §5.1).
//
// Each cell is sampled on a k x k lattice covering its central 50% x 50% and
// averaged. Only the camera pixels actually needed are touched; there is no
// full perspective warp.

import { applyHomography } from './homography.js';

export const DEFAULT_KERNEL = 3;

export function describeKernel(k = DEFAULT_KERNEL) {
  return `${k}x${k} points over the central 50% x 50% of each cell, nearest pixel, averaged`;
}

// Returns Float32Array(gridWidth * gridHeight) of mean luma, NaN where the
// cell falls outside the region.
//
// The homography is evaluated only at the (gridWidth + 1) x (gridHeight + 1)
// cell corners; points inside a cell are interpolated bilinearly between its
// four mapped corners (the projective distortion within one cell is far below
// a pixel), which makes sampling several times cheaper on phones.
export function sampleCells(img, H, gridWidth, gridHeight, k = DEFAULT_KERNEL, out) {
  const n = gridWidth * gridHeight;
  const values = out && out.length === n ? out : new Float32Array(n);
  const offsets = new Float64Array(k);
  for (let i = 0; i < k; i++) offsets[i] = 0.25 + (0.5 * (i + 0.5)) / k;

  const cw = gridWidth + 1;
  const cornersX = new Float64Array(cw * (gridHeight + 1));
  const cornersY = new Float64Array(cw * (gridHeight + 1));
  const p = [0, 0];
  for (let y = 0; y <= gridHeight; y++) {
    for (let x = 0; x <= gridWidth; x++) {
      applyHomography(H, x, y, p);
      cornersX[y * cw + x] = p[0];
      cornersY[y * cw + x] = p[1];
    }
  }

  const { data, width: iw, height: ih, x0, y0 } = img;
  for (let y = 0; y < gridHeight; y++) {
    for (let x = 0; x < gridWidth; x++) {
      const a = y * cw + x;
      const ax = cornersX[a];
      const ay = cornersY[a];
      const bx = cornersX[a + 1];
      const by = cornersY[a + 1];
      const cx = cornersX[a + cw];
      const cy = cornersY[a + cw];
      const dx = cornersX[a + cw + 1];
      const dy = cornersY[a + cw + 1];
      let sum = 0;
      let count = 0;
      for (let u = 0; u < k; u++) {
        const oy = offsets[u];
        // Left and right edges at this height, then interpolate across.
        const lx = ax + (cx - ax) * oy - x0;
        const ly = ay + (cy - ay) * oy - y0;
        const ex = bx + (dx - bx) * oy - x0 - lx;
        const ey = by + (dy - by) * oy - y0 - ly;
        for (let v = 0; v < k; v++) {
          const ox = offsets[v];
          const fx = lx + ex * ox;
          const fy = ly + ey * ox;
          if (fx < 0 || fy < 0) continue;
          // Truncation equals floor for the non-negative coordinates left here.
          const px = fx | 0;
          const py = fy | 0;
          if (px >= iw || py >= ih) continue;
          const i = (py * iw + px) * 4;
          sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
          count++;
        }
      }
      values[y * gridWidth + x] = count ? sum / count : NaN;
    }
  }
  return values;
}
