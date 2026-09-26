// One capture through the receiver chain (SPEC §2 steps 3–6):
// corner refinement -> homography -> cell sampling -> symbol decision.
// Pure function of an ImageRegion so it can run in tests and, later, a Worker.
//
// Symbol decision: with pilots (pattern "prbs-pilots", Milestone 2) the
// primary decision uses per-position level centers interpolated from nearby
// pilot tiles (it beat the single quadratic surface in every real run so far,
// because degradation was localized); the quadratic surface, position-
// independent pilot centers, and blind k-means are computed alongside for
// comparison. Without pilots, blind k-means is the only method (Milestone 1).

import { computeHomography, logicalCorners } from './homography.js';
import { refineFromProfiles, profilesCpu, pixelsPerCell } from './acquisition.js';
import { sampleCells, DEFAULT_KERNEL } from './sampler.js';
import { kmeans1d, classify } from './demodulator.js';
import { estimateLevelSurfaces, classifyLocal, classifyGlobal, estimateLevelGrid, classifyGrid } from './pilot-demod.js';
import { hasPilots, hasHeader, payloadMask, pilotLayoutFor } from '../common/test-frame.js';
import { headerLayout } from '../common/frame-layout.js';
import { bitsToHeader, decodeHeader } from '../common/header.js';
import { FRAME_TYPE } from '../common/protocol.js';
import { shiftedPilotLayout } from '../common/pilots.js';
import { objectPilotShift } from '../common/object-frame.js';

// A sample source provides the two things the chain reads from the camera
// image: refinement profiles and per-cell mean luma. The CPU source reads an
// ImageRegion; gl-sampler.js computes both on the GPU from the video frame.
export function cpuSource(img) {
  return {
    kind: 'cpu',
    profiles: (quad, radius) => profilesCpu(img, quad, radius),
    cells: (H, w, h, k) => sampleCells(img, H, w, h, k),
  };
}

const asSource = (img) => (typeof img.cells === 'function' ? img : cpuSource(img));

// Cell size when the corner order is unknown: the long side of the quad
// spans the grid's long side.
export function orientFreeCellSize(q, profile) {
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const s1 = Math.min(d(q[0], q[1]), d(q[3], q[2]));
  const s2 = Math.min(d(q[0], q[3]), d(q[1], q[2]));
  const long = Math.max(profile.gridWidth, profile.gridHeight);
  const short = Math.min(profile.gridWidth, profile.gridHeight);
  return Math.min(Math.max(s1, s2) / long, Math.min(s1, s2) / short);
}

// Minimum fraction of outline cells that must sample clearly bright. A
// misaligned grid samples the random payload (~50%) or the dark surroundings
// (~0%); a thin, blurred outline on the far side of an oblique view mixes
// with its surroundings, so 90% (the first value) rejected well-aligned
// oblique captures.
export const MIN_OUTLINE_MATCH = 0.75;

const payloadCache = new Map();

// Cell indices used for blind k-means: payload cells (never outline or pilots).
function payloadIndices(profile, pattern) {
  const key = `${profile.gridWidth}x${profile.gridHeight}x${profile.levels}:${pattern}`;
  if (!payloadCache.has(key)) {
    const mask = payloadMask(profile, pattern);
    const out = [];
    for (let i = 0; i < mask.length; i++) if (mask[i]) out.push(i);
    payloadCache.set(key, Uint32Array.from(out));
  }
  return payloadCache.get(key);
}

// Alignment check: the outline (always the brightest level) must sample
// clearly bright. It deliberately does not require an exact top-level
// decision, so that top-level confusions being measured do not reject
// otherwise well-aligned captures; a misaligned grid samples the dark
// surroundings or the random payload instead.
function outlineMatch(values, profile, darkest, brightest) {
  const { gridWidth: w, gridHeight: h } = profile;
  const mid = (darkest + brightest) / 2;
  let ok = 0;
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x !== 0 && y !== 0 && x !== w - 1 && y !== h - 1) continue;
      n++;
      if (values[y * w + x] > mid) ok++;
    }
  }
  return ok / n;
}

// Frame corners (TL, TR, BR, BL) as indices into the image-order quad
// (clockwise on screen): the four rotations, then the four mirrored orders
// (front camera or a mirrored preview; SPEC §4.1). Mirrored frame corners run
// counter-clockwise on screen, so tracking keeps the image-order quad and
// applies the order separately.
export const IDENTITY_ORDER = Object.freeze([0, 1, 2, 3]);
export const CORNER_ORDERS = Object.freeze(
  [
    [0, 1, 2, 3],
    [1, 2, 3, 0],
    [2, 3, 0, 1],
    [3, 0, 1, 2],
    [1, 0, 3, 2],
    [0, 3, 2, 1],
    [3, 2, 1, 0],
    [2, 1, 0, 3],
  ].map((o) => Object.freeze(o)),
);
// Mirrored orders run the frame's TL -> TR against the image's clockwise order.
export const isMirrored = (order) => (order[1] - order[0] + 4) % 4 === 3;
export const applyOrder = (quad, order) => order.map((i) => quad[i]);

// Header fields of every copy that decodes from raw cell values (binary
// threshold halfway between the 10th and 90th percentile of the header
// cells, which only hold the darkest and brightest level). Works before any
// level decision, e.g. to find the orientation or an object frame's pilot shift.
export function readHeaderFields(values, profile) {
  return readHeaderCopies(values, profile).filter(Boolean);
}

// Per copy (top, right, bottom, left): its fields, or null.
function readHeaderCopies(values, profile) {
  const { copies } = headerLayout(profile);
  const hv = [];
  for (const c of copies) for (const i of c) hv.push(values[i]);
  hv.sort((a, b) => a - b);
  const thr = (hv[Math.floor(hv.length * 0.1)] + hv[Math.floor(hv.length * 0.9)]) / 2;
  return copies.map((c) => {
    const bits = new Uint8Array(c.length);
    for (let b = 0; b < c.length; b++) bits[b] = values[c[b]] > thr ? 1 : 0;
    const d = decodeHeader(bitsToHeader(bits));
    return d.ok ? d.fields : null;
  });
}

// Orientation score of cell values read with one corner order. The left and
// right copies are placed mirror-symmetrically (and so are top and bottom),
// so an order that is wrong by a mirror still decodes one kind of copy; the
// right order decodes both kinds. Score: kinds decoded (x10) + copies decoded.
function orientationScore(values, profile) {
  const c = readHeaderCopies(values, profile);
  const horizontal = !!(c[0] || c[2]);
  const vertical = !!(c[1] || c[3]);
  return (horizontal + vertical) * 10 + c.filter(Boolean).length;
}

// Pilot layout of a capture: object frames ("file") shift their pilot levels
// per frame (object-frame.js objectPilotShift), read from the header first.
function capturePilots(values, profile, pattern) {
  const base = pilotLayoutFor(profile, pattern);
  if (pattern !== 'file') return { layout: base, shift: 0, header: null };
  const f = readHeaderFields(values, profile)[0] ?? null;
  const shift = f && (f.frameType === FRAME_TYPE.DATA || f.frameType === FRAME_TYPE.MANIFEST) ? objectPilotShift(f, profile.levels) : 0;
  return { layout: shiftedPilotLayout(base, shift, profile.levels), shift, header: f };
}

// options.compare: also compute the comparison decisions (quadratic surface,
// global pilot centers, blind k-means) for measurements; continuous reception
// turns it off to save time on phones.
// quad: corners in image order, clockwise on screen (TL, TR, BR, BL of the
// image when the frame is upright). options.order: which of them are the
// frame's TL, TR, BR, BL (CORNER_ORDERS; identity by default).
// options.orient: the order is not known (fresh detection): for patterns with
// header copies, try the eight orders and keep the one whose header decodes,
// so that a rolled, sideways or mirrored view works (SPEC §4.1 without finder
// markers). result.imageCorners: refined corners in image order (for
// tracking); result.corners: in frame order; result.order / orientation.
export function processCapture(img, quad, profile, { radius, kernel = DEFAULT_KERNEL, refine = true, pattern = 'prbs', compare = true, orient = false, order = IDENTITY_ORDER } = {}) {
  const source = asSource(img);
  const cellSize = orient ? orientFreeCellSize(quad, profile) : pixelsPerCell(applyOrder(quad, order), profile.gridWidth, profile.gridHeight).min;
  const refined = refine ? refineFromProfiles(source.profiles(quad, radius), quad, radius, { cellSize }) : { ok: true, corners: quad };
  const result = { ok: false, reason: null, refine: refined, corners: refined.corners };
  if (!refined.ok) {
    result.reason = refined.reason;
    return result;
  }
  const { gridWidth: w, gridHeight: h, levels } = profile;
  result.imageCorners = refined.corners;
  let corners = applyOrder(refined.corners, order);
  result.order = order;
  let H = null;
  let values = null;
  if (orient && hasHeader(pattern)) {
    // Best-scoring order; ties go to the earlier (unmirrored) one.
    let bestScore = 0;
    for (let k = 0; k < CORNER_ORDERS.length && bestScore < 24; k++) {
      const q = applyOrder(refined.corners, CORNER_ORDERS[k]);
      const Hk = computeHomography(logicalCorners(w, h), q);
      if (!Hk) continue;
      const v = source.cells(Hk, w, h, kernel);
      const score = orientationScore(v, profile);
      if (score > bestScore) {
        bestScore = score;
        corners = q;
        H = Hk;
        values = v;
        result.orientation = k;
        result.order = CORNER_ORDERS[k];
      }
    }
    if (!values) {
      result.reason = 'orientation-unknown';
      return result;
    }
  } else {
    H = computeHomography(logicalCorners(w, h), corners);
    if (!H) {
      result.reason = 'homography-failed';
      return result;
    }
    values = source.cells(H, w, h, kernel);
  }
  result.corners = corners;
  // The corners are trustworthy from here on (each edge verified as the
  // outline, orientation known) even if the capture turns out undecodable
  // below, e.g. too blurred: the receiver keeps tracking with them.
  result.geometryOk = true;
  result.ppc = pixelsPerCell(corners, w, h);

  result.values = values;
  const pilots = hasPilots(pattern);
  let kmeansSymbols = null;
  if (!pilots || compare) {
    const centers = kmeans1d(values, payloadIndices(profile, pattern), levels);
    if (!centers) {
      result.reason = 'too-few-samples';
      return result;
    }
    kmeansSymbols = classify(values, centers);
    result.centers = centers;
  }

  if (pilots) {
    const { layout: pilotLayout, shift, header } = capturePilots(values, profile, pattern);
    result.pilotShift = shift;
    // Header fields read from the raw values ("file"), e.g. for profile identification.
    result.headerFields = header;
    const est = estimateLevelSurfaces(values, profile, pilotLayout);
    if (!est) {
      result.reason = 'pilot-fit-failed';
      return result;
    }
    const n = w * h;
    const gridSymbols = new Uint8Array(n);
    const confidence = new Float32Array(n);
    // Soft values for combining captures of the same frame (object-receiver.js).
    const soft = hasHeader(pattern) ? { coord: new Float32Array(n), spacing: new Float32Array(n) } : null;
    classifyGrid(values, profile, estimateLevelGrid(values, profile, pilotLayout), gridSymbols, confidence, soft);
    result.symbols = gridSymbols;
    result.confidence = confidence;
    result.soft = soft;
    result.pilot = est;
    if (compare) {
      const surface = new Uint8Array(n);
      classifyLocal(values, profile, est, surface, null);
      const global = new Uint8Array(n);
      classifyGlobal(values, est.global, global, null);
      result.alternatives = { pilotSurface: surface, pilotGlobal: global, kmeans: kmeansSymbols };
    }
    result.method = 'pilot-grid';
  } else {
    result.symbols = kmeansSymbols;
    result.method = 'kmeans';
  }

  const ref = result.pilot ? result.pilot.global : result.centers;
  result.outlineMatch = outlineMatch(values, profile, ref[0], ref[levels - 1]);
  if (result.outlineMatch < MIN_OUTLINE_MATCH) {
    result.reason = 'outline-mismatch';
    return result;
  }
  result.ok = true;
  return result;
}

// processCapture() on a region read at reduced resolution. The region image
// covers camera pixels [x0, x0 + w/sx) x [y0, y0 + h/sy) scaled by (sx, sy);
// the quad goes in and the corners come out in full camera coordinates.
// Reading the region at ~7 px per cell instead of 10-12 cuts the pixel
// readback, the dominant cost on phones.
export function processRegion(img, quad, profile, options, { x0, y0, sx, sy }) {
  const q = quad.map(([x, y]) => [(x - x0) * sx, (y - y0) * sy]);
  const r = processCapture({ ...img, x0: 0, y0: 0 }, q, profile, { ...options, radius: options.radius * Math.min(sx, sy) });
  const back = ([x, y]) => [x0 + x / sx, y0 + y / sy];
  r.corners = r.corners.map(back);
  if (r.imageCorners) r.imageCorners = r.imageCorners.map(back);
  if (r.ppc) {
    const px = r.ppc.x / sx;
    const py = r.ppc.y / sy;
    r.ppc = { x: px, y: py, min: Math.min(px, py) };
  }
  r.readScale = Math.min(sx, sy);
  return r;
}
