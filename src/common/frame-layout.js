// Dynamic test-frame layout (Milestone 4): outline, four header copies,
// pilots, payload (SPEC §4, §9.3).
//
// One header copy runs along each edge just inside the outline: rows at the
// top and bottom, columns at the left and right. With copies at opposite
// edges on both axes, a capture whose rolling-shutter readout crossed a
// logical-frame change carries two different valid headers, whatever the
// phone's orientation (SPEC §10.3). Pilots are inset so that they never
// overlap the copies.

import { HEADER_BITS } from './protocol.js';
import { testFrameInterior } from './test-frame.js';

const cache = new Map();

// Rows used by the top / bottom copies (rh) and columns used by the left /
// right copies (cv), such that the copies do not overlap at the corners.
function copyExtents(iw, ih) {
  let cv = 0;
  let rh = 0;
  for (let k = 0; k < 4; k++) {
    rh = Math.ceil(HEADER_BITS / (iw - 2 * cv));
    cv = Math.ceil(HEADER_BITS / (ih - 2 * rh));
  }
  return { rh, cv };
}

// Returns { copies: [Uint32Array(HEADER_BITS) x 4] (top, right, bottom, left;
// cell index per header bit), mask, inset: { x, y } }.
export function headerLayout(profile) {
  const { gridWidth: w, gridHeight: h } = profile;
  const key = `${w}x${h}`;
  if (cache.has(key)) return cache.get(key);
  const { x0, y0, width: iw, height: ih } = testFrameInterior(profile);
  const { rh, cv } = copyExtents(iw, ih);
  if (rh * 2 >= ih || cv * 2 >= iw) throw new RangeError(`grid ${w}x${h} too small for header copies`);

  const mask = new Uint8Array(w * h);
  const horizontal = (top) => {
    // Row-major over rh rows, columns between the vertical copies, centered.
    const span = iw - 2 * cv;
    const perRow = Math.ceil(HEADER_BITS / rh);
    const start = x0 + cv + Math.floor((span - perRow) / 2);
    const out = new Uint32Array(HEADER_BITS);
    for (let b = 0; b < HEADER_BITS; b++) {
      const r = Math.floor(b / perRow);
      const y = top ? y0 + r : y0 + ih - 1 - r;
      out[b] = y * w + start + (b % perRow);
    }
    return out;
  };
  const vertical = (left) => {
    // Column-major over cv columns, rows between the horizontal copies, centered.
    const span = ih - 2 * rh;
    const perCol = Math.ceil(HEADER_BITS / cv);
    const start = y0 + rh + Math.floor((span - perCol) / 2);
    const out = new Uint32Array(HEADER_BITS);
    for (let b = 0; b < HEADER_BITS; b++) {
      const c = Math.floor(b / perCol);
      const x = left ? x0 + c : x0 + iw - 1 - c;
      out[b] = (start + (b % perCol)) * w + x;
    }
    return out;
  };
  const copies = [horizontal(true), vertical(false), horizontal(false), vertical(true)];
  for (const c of copies) for (const i of c) mask[i] = 1;
  const layout = Object.freeze({ copies, mask, inset: { x: cv, y: rh } });
  cache.set(key, layout);
  return layout;
}
