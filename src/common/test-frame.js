// Builds deterministic test frames as symbol arrays (one Uint8 symbol index
// per cell, row-major from the top-left cell, SPEC §0). Shared by the sender
// (rendering) and the receiver (expected pattern for BER measurement).
//
// Test frames: a 1-cell outline of the brightest level around a
// test pattern. The outline delimits the logical frame against the S0
// letterbox, which is otherwise indistinguishable from S0 edge cells
// (SPEC §4.3). The "prbs-pilots" pattern adds distributed calibration pilots
// (pilots.js, Milestone 2); "dynamic" adds four binary header copies carrying
// session ID and sequence number (frame-layout.js, header.js, Milestone 4),
// so that the receiver can identify every logical frame. There are no finder
// markers: the receiver detects the outline and takes the orientation from
// the header copies (SPEC §4, §4.1).

import { bitsPerSymbol } from './profiles.js';
import { createPrbs, PRBS_DOMAIN } from './prbs.js';
import { bitsToSymbol } from './gray.js';
import { pilotLayout, shiftedPilotLayout } from './pilots.js';
import { headerLayout } from './frame-layout.js';
import { encodeHeader, headerToBits } from './header.js';
import { FRAME_TYPE } from './protocol.js';
import { fecLayout, fecFlags, encodeFecBytes, bytesToSymbolBits } from './fec.js';

export const PATTERNS = Object.freeze({
  prbs: 'PRBS test frame',
  'prbs-pilots': 'PRBS + pilots (M2)',
  dynamic: '動的テスト: header + pilots + PRBS (M4)',
  file: 'ファイル転送 (M6)',
  levels: 'Level bands',
  checker: 'Checkerboard',
});

// Patterns whose layout contains header copies (per-frame identification).
// File transfer (object-frame.js) uses the same layout as the dynamic test.
export function hasHeader(pattern) {
  return pattern === 'dynamic' || pattern === 'file';
}

// Patterns whose layout contains calibration pilots.
export function hasPilots(pattern) {
  return pattern === 'prbs-pilots' || hasHeader(pattern);
}

export function pilotLayoutFor(profile, pattern) {
  return hasHeader(pattern) ? pilotLayout(profile, headerLayout(profile).inset) : pilotLayout(profile);
}

// Payload cells of a test frame: interior cells that are not pilots.
export function payloadMask(profile, pattern) {
  const { gridWidth: w, gridHeight: h } = profile;
  const mask = new Uint8Array(w * h);
  const { x0, y0, width, height } = testFrameInterior(profile);
  const pilots = hasPilots(pattern) ? pilotLayoutFor(profile, pattern).mask : null;
  const header = hasHeader(pattern) ? headerLayout(profile).mask : null;
  for (let y = y0; y < y0 + height; y++) {
    for (let x = x0; x < x0 + width; x++) {
      const i = y * w + x;
      if ((!pilots || !pilots[i]) && (!header || !header[i])) mask[i] = 1;
    }
  }
  return mask;
}

export const OUTLINE_CELLS = 1;

// Interior region enclosed by the outline, in cells.
export function testFrameInterior(profile) {
  return {
    x0: OUTLINE_CELLS,
    y0: OUTLINE_CELLS,
    width: profile.gridWidth - 2 * OUTLINE_CELLS,
    height: profile.gridHeight - 2 * OUTLINE_CELLS,
  };
}

export function fillOutline(out, profile) {
  const { gridWidth: w, gridHeight: h, levels } = profile;
  const hi = levels - 1;
  for (let x = 0; x < w; x++) {
    out[x] = hi;
    out[(h - 1) * w + x] = hi;
  }
  for (let y = 1; y < h - 1; y++) {
    out[y * w] = hi;
    out[y * w + w - 1] = hi;
  }
}

// TEST payload (SPEC §9.2): PRBS domain 0x02 bits, Gray-mapped to symbols,
// assigned to interior cells in row-major order.
function fillPrbs(out, profile, sessionId, sequence) {
  const prbs = createPrbs(PRBS_DOMAIN.TEST_PAYLOAD, sessionId, sequence);
  const bps = bitsPerSymbol(profile.levels);
  const { x0, y0, width, height } = testFrameInterior(profile);
  for (let y = y0; y < y0 + height; y++) {
    const row = y * profile.gridWidth;
    for (let x = x0; x < x0 + width; x++) out[row + x] = bitsToSymbol(prbs.nextBits(bps));
  }
}

// Pilot cells get their fixed level; the PRBS stream fills the remaining
// interior cells in row-major order.
function fillPrbsWithPilots(out, profile, sessionId, sequence) {
  const layout = pilotLayout(profile);
  const prbs = createPrbs(PRBS_DOMAIN.TEST_PAYLOAD, sessionId, sequence);
  const bps = bitsPerSymbol(profile.levels);
  const { x0, y0, width, height } = testFrameInterior(profile);
  for (let y = y0; y < y0 + height; y++) {
    const row = y * profile.gridWidth;
    for (let x = x0; x < x0 + width; x++) {
      if (!layout.mask[row + x]) out[row + x] = bitsToSymbol(prbs.nextBits(bps));
    }
  }
  for (let k = 0; k < layout.count; k++) out[layout.cells[k]] = layout.levels[k];
}

export function dynamicPayloadCells(profile) {
  return payloadMask(profile, 'dynamic').reduce((a, b) => a + b, 0);
}

// Ground truth of a FEC test frame: the data bytes and the padding, both from
// the TEST PRBS of the frame (domain 0x02).
export function fecTestData(profile, sessionId, sequence, layout) {
  const prbs = createPrbs(PRBS_DOMAIN.TEST_PAYLOAD, sessionId >>> 0, sequence >>> 0);
  const data = prbs.fillBytes(new Uint8Array(layout.dataBytes));
  const pad = prbs.fillBytes(new Uint8Array(layout.bytes - layout.codewords * layout.n));
  return { data, pad };
}

// Header copies (binary: S0 / S(L-1)) and pilots of a framed layout
// ("dynamic" / "file"); header: the fields for encodeHeader() apart from the
// profile ID; pilotShift: added to every pilot level (object frames).
export function writeHeaderAndPilots(out, profile, header, pilotShift = 0) {
  const pilots = shiftedPilotLayout(pilotLayoutFor(profile, 'dynamic'), pilotShift, profile.levels);
  const bits = headerToBits(encodeHeader({ profileId: profile.id, ...header }));
  const top = profile.levels - 1;
  for (const copy of headerLayout(profile).copies) for (let b = 0; b < copy.length; b++) out[copy[b]] = bits[b] ? top : 0;
  for (let k = 0; k < pilots.count; k++) out[pilots.cells[k]] = pilots.levels[k];
}

// Frame bytes (fec.js layout.bytes) -> payload cells, bits MSB first.
export function writePayloadBytes(out, profile, bytes) {
  const payload = payloadMask(profile, 'dynamic');
  const groups = bytesToSymbolBits(bytes, bitsPerSymbol(profile.levels), dynamicPayloadCells(profile));
  let c = 0;
  for (let i = 0; i < payload.length; i++) if (payload[i]) out[i] = bitsToSymbol(groups[c++]);
}

// Header, pilots, and the payload: raw PRBS symbols, or with `fec` (rate
// index, fec.js) PRBS data bytes protected by interleaved Reed-Solomon
// codewords.
function fillDynamic(out, profile, sessionId, sequence, fec) {
  const payloadCells = dynamicPayloadCells(profile);
  const bps = bitsPerSymbol(profile.levels);
  const layout = fec ? fecLayout(profile, payloadCells, fec) : null;
  writeHeaderAndPilots(out, profile, {
    frameType: FRAME_TYPE.TEST,
    flags: fecFlags(fec),
    sessionId,
    sequence,
    payloadLength: Math.min(0xffff, layout ? layout.dataBytes : Math.floor((payloadCells * bps) / 8)),
  });
  if (layout) {
    const { data, pad } = fecTestData(profile, sessionId, sequence, layout);
    writePayloadBytes(out, profile, encodeFecBytes(layout, data, pad));
    return;
  }
  const payload = payloadMask(profile, 'dynamic');
  const prbs = createPrbs(PRBS_DOMAIN.TEST_PAYLOAD, sessionId, sequence);
  for (let i = 0; i < payload.length; i++) if (payload[i]) out[i] = bitsToSymbol(prbs.nextBits(bps));
}

// Vertical bands S0..S(n-1), left to right. Used to eyeball level separation.
function fillLevels(out, profile) {
  const { levels } = profile;
  const { x0, y0, width, height } = testFrameInterior(profile);
  for (let y = y0; y < y0 + height; y++) {
    const row = y * profile.gridWidth;
    for (let x = x0; x < x0 + width; x++) out[row + x] = Math.floor(((x - x0) * levels) / width);
  }
}

// Single-cell checkerboard of the extreme levels. Uneven cell widths or
// resampling at the sender show up as visible beating. Deliberately static:
// a phase-reversing checkerboard is a photosensitivity hazard (SPEC §16.3).
function fillChecker(out, profile) {
  const hi = profile.levels - 1;
  const { x0, y0, width, height } = testFrameInterior(profile);
  for (let y = y0; y < y0 + height; y++) {
    const row = y * profile.gridWidth;
    for (let x = x0; x < x0 + width; x++) out[row + x] = (x + y) & 1 ? hi : 0;
  }
}

// fec: inner FEC rate index for the "dynamic" pattern (0 = none, fec.js).
export function buildTestFrame({ pattern, profile, sessionId, sequence, fec = 0 }, out) {
  const n = profile.gridWidth * profile.gridHeight;
  const symbols = out && out.length === n ? out : new Uint8Array(n);
  switch (pattern) {
    case 'prbs':
      fillPrbs(symbols, profile, sessionId >>> 0, sequence >>> 0);
      break;
    case 'prbs-pilots':
      fillPrbsWithPilots(symbols, profile, sessionId >>> 0, sequence >>> 0);
      break;
    case 'dynamic':
      fillDynamic(symbols, profile, sessionId >>> 0, sequence >>> 0, fec);
      break;
    case 'levels':
      fillLevels(symbols, profile);
      break;
    case 'checker':
      fillChecker(symbols, profile);
      break;
    default:
      throw new RangeError(`unknown pattern: ${pattern}`);
  }
  fillOutline(symbols, profile);
  return symbols;
}
