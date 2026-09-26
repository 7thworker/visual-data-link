// Distributed calibration pilots (SPEC §7, ROADMAP M2).
//
// Pilot tiles of 1 x L cells (one cell per symbol level) are spread over the
// interior on a regular lattice, so that the receiver can estimate level
// centers as a function of position (vignetting, viewing angle, display
// non-uniformity). The level order is rotated from tile to tile so that no
// level always has the same neighbors. About 4% of the interior is used
// (SPEC §4: 3–5% calibration).
//
// Frozen for frames with header copies (SPEC §7, protocol version 1); sender
// and receiver share this module.

// Circular with test-frame.js, which is safe: both only call each other's
// function declarations at run time, never during module evaluation.
import { testFrameInterior } from './test-frame.js';

export const TILE_SPACING_X = 11; // cells between tile origins, horizontally
export const TILE_SPACING_Y = 9; // and vertically

const cache = new Map();

// Returns { count, cells: Uint32Array (cell index), levels: Uint8Array,
// mask: Uint8Array per cell (1 = pilot), tilesX, tilesY }.
// inset: cells kept free inside the outline (e.g. for header copies).
export function pilotLayout(profile, inset = { x: 0, y: 0 }) {
  const { gridWidth: w, gridHeight: h, levels } = profile;
  const key = `${w}x${h}x${levels}:${inset.x},${inset.y}`;
  if (cache.has(key)) return cache.get(key);

  const interior = testFrameInterior(profile);
  const x0 = interior.x0 + inset.x;
  const y0 = interior.y0 + inset.y;
  const iw = interior.width - 2 * inset.x;
  const ih = interior.height - 2 * inset.y;
  const tilesX = Math.max(2, Math.round(iw / TILE_SPACING_X));
  const tilesY = Math.max(2, Math.round(ih / TILE_SPACING_Y));
  const cells = [];
  const lv = [];
  const mask = new Uint8Array(w * h);
  let t = 0;
  for (let j = 0; j < tilesY; j++) {
    const y = y0 + Math.floor(((j + 0.5) * ih) / tilesY);
    for (let i = 0; i < tilesX; i++, t++) {
      const cx = x0 + Math.floor(((i + 0.5) * iw) / tilesX);
      const start = Math.max(x0, Math.min(x0 + iw - levels, cx - Math.floor(levels / 2)));
      for (let k = 0; k < levels; k++) {
        const idx = y * w + start + k;
        cells.push(idx);
        lv.push((k + t) % levels);
        mask[idx] = 1;
      }
    }
  }
  const layout = Object.freeze({
    count: cells.length,
    cells: Uint32Array.from(cells),
    levels: Uint8Array.from(lv),
    mask,
    tilesX,
    tilesY,
  });
  cache.set(key, layout);
  return layout;
}

// The same layout with every pilot level shifted by `shift` (mod L): object
// frames vary their pilots from frame to frame (object-frame.js
// objectPilotShift), so that a capture mixing two frames shows it in the
// pilots too.
const shiftedCache = new WeakMap();
export function shiftedPilotLayout(layout, shift, levels) {
  const s = ((shift % levels) + levels) % levels;
  if (!s) return layout;
  let byShift = shiftedCache.get(layout);
  if (!byShift) shiftedCache.set(layout, (byShift = new Map()));
  let out = byShift.get(s);
  if (!out) {
    out = Object.freeze({ ...layout, levels: Uint8Array.from(layout.levels, (l) => (l + s) % levels) });
    byShift.set(s, out);
  }
  return out;
}
