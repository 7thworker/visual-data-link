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

// 27 colours (palette rgb27): a tile of all 27 would be too long. Nine colours
// in which every channel takes each of its three levels three times, with the
// other channels varying (a Latin square), are enough for the receiver's
// additive colour model (receiver/colour-demod.js): tile slot t is
// r = t mod 3, g = floor(t / 3), b = (t + g) mod 3, symbol 9 r + 3 g + b.
export const PILOT_TILE_27 = Object.freeze(Array.from({ length: 9 }, (_, t) => 9 * (t % 3) + 3 * Math.floor(t / 3) + ((t + Math.floor(t / 3)) % 3)));

// Cells per pilot tile: one per level, or the 9-colour tile for 27 colours.
export const pilotTileLength = (levels) => (levels === 27 ? 9 : levels);

// Returns { count, cells: Uint32Array (cell index), levels: Uint8Array,
// mask: Uint8Array per cell (1 = pilot), tilesX, tilesY, tileLength, slots
// (27 colours: the tile slot of each pilot, for shifting) }.
// inset: cells kept free inside the outline (e.g. for header copies).
export function pilotLayout(profile, inset = { x: 0, y: 0 }) {
  const { gridWidth: w, gridHeight: h, levels } = profile;
  const tile = pilotTileLength(levels);
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
  const slots = [];
  const mask = new Uint8Array(w * h);
  let t = 0;
  for (let j = 0; j < tilesY; j++) {
    const y = y0 + Math.floor(((j + 0.5) * ih) / tilesY);
    for (let i = 0; i < tilesX; i++, t++) {
      const cx = x0 + Math.floor(((i + 0.5) * iw) / tilesX);
      const start = Math.max(x0, Math.min(x0 + iw - tile, cx - Math.floor(tile / 2)));
      for (let k = 0; k < tile; k++) {
        const idx = y * w + start + k;
        cells.push(idx);
        const slot = (k + t) % tile;
        slots.push(slot);
        lv.push(levels === 27 ? PILOT_TILE_27[slot] : slot);
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
    tileLength: tile,
    slots: levels === 27 ? Uint8Array.from(slots) : null,
  });
  cache.set(key, layout);
  return layout;
}

// The same layout with every pilot level shifted by `shift` (mod L): object
// frames vary their pilots from frame to frame (object-frame.js
// objectPilotShift), so that a capture mixing two frames shows it in the
// pilots too.
const shiftedCache = new WeakMap();
// 27 colours: the slots rotate within the 9-colour tile (shift mod 9).
export function shiftedPilotLayout(layout, shift, levels) {
  const n = layout.slots ? 9 : levels;
  const s = ((shift % n) + n) % n;
  if (!s) return layout;
  let byShift = shiftedCache.get(layout);
  if (!byShift) shiftedCache.set(layout, (byShift = new Map()));
  let out = byShift.get(s);
  if (!out) {
    const lv = layout.slots ? Uint8Array.from(layout.slots, (t) => PILOT_TILE_27[(t + s) % 9]) : Uint8Array.from(layout.levels, (l) => (l + s) % levels);
    out = Object.freeze({ ...layout, levels: lv });
    byShift.set(s, out);
  }
  return out;
}
