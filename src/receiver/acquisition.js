// Screen localization from rough corners (SPEC §15 stage 1, ROADMAP M1).
//
// The user taps the four logical-frame corners (TL, TR, BR, BL). Taps on a
// phone are off by tens of camera pixels at 4K, so each edge is refined by
// locating the outer boundary of the bright 1-cell outline (SPEC §4.3): the
// outermost strong dark-to-bright step when walking inward along the edge
// normal. A line is fitted per edge and adjacent lines are intersected.
// Interior cell boundaries also lie on straight lines, so each fitted edge is
// verified: half a cell inside must be uniformly bright (the outline) and half
// a cell outside uniformly dark, which the random payload never is.
// Starting from the previous result on every frame also tracks slow motion.

import { lumaBilinear } from './image.js';

const DEFAULTS = Object.freeze({
  samplesPerEdge: 32,
  edgeMargin: 0.06, // fraction of each edge skipped near the corners
  step: 0.5, // profile step in camera pixels
  minContrast: 12, // minimum luma step for an edge point
  relativeThreshold: 0.5, // edge must reach this fraction of the profile's strongest step
  minInlierRatio: 0.4,
  minUniformity: 0.85, // fraction of samples on the expected side of the edge
});

export function signedArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = q[i];
    const [x1, y1] = q[(i + 1) % 4];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

// Convex and clockwise on screen (image y axis points down).
export function isValidQuad(q) {
  if (signedArea(q) <= 0) return false;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i];
    const [bx, by] = q[(i + 1) % 4];
    const [cx, cy] = q[(i + 2) % 4];
    if ((bx - ax) * (cy - by) - (by - ay) * (cx - bx) <= 0) return false;
  }
  return true;
}

export function quadBounds(q, margin = 0) {
  const xs = q.map((p) => p[0]);
  const ys = q.map((p) => p[1]);
  return {
    x0: Math.min(...xs) - margin,
    y0: Math.min(...ys) - margin,
    x1: Math.max(...xs) + margin,
    y1: Math.max(...ys) + margin,
  };
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Obliqueness of the view from opposite edge lengths: leftRight > 1 means the
// left edge appears longer, i.e. the right side of the screen is farther away
// (smaller cells there, and possibly out of focus).
export function perspectiveRatios(q) {
  const [tl, tr, br, bl] = q;
  return { leftRight: dist(tl, bl) / dist(tr, br), topBottom: dist(tl, tr) / dist(bl, br) };
}

// SPEC §5: measured on the camera image from the logical-frame quadrilateral.
export function pixelsPerCell(q, gridWidth, gridHeight) {
  const [tl, tr, br, bl] = q;
  const x = Math.min(dist(tl, tr), dist(bl, br)) / gridWidth;
  const y = Math.min(dist(tl, bl), dist(tr, br)) / gridHeight;
  return { x, y, min: Math.min(x, y) };
}

// Differences over +-span samples tried in turn: a sharp edge is found at the
// finest scale as before; a blurred one (the far side of an oblique view,
// out of focus or with motion) spreads its step over several pixels, so that
// no single-pixel difference reaches the threshold (real slanted runs lost
// the far edge this way).
const EDGE_SPANS = [1, 4, 8];

// Position (along the inward profile) of the outermost strong rising step, or null.
function findEdge(profile, step, opts) {
  for (const span of EDGE_SPANS) {
    const pos = findEdgeAt(profile, step, opts, span);
    if (pos !== null) return pos;
  }
  return null;
}

function findEdgeAt(profile, step, opts, span) {
  const n = profile.length;
  let best = 0;
  const grad = new Float64Array(n);
  for (let i = span; i < n - span; i++) {
    const g = profile[i + span] - profile[i - span];
    grad[i] = Number.isFinite(g) ? g : 0;
    if (grad[i] > best) best = grad[i];
  }
  if (best < opts.minContrast * 2) return null; // the difference spans two or more steps
  const thr = best * opts.relativeThreshold;
  for (let i = 1; i < n - 1; i++) {
    if (grad[i] < thr) continue;
    let k = i;
    while (k + 1 < n - 1 && grad[k + 1] >= grad[k]) k++;
    // Sub-sample peak by parabola fit through (k-1, k, k+1).
    const a = grad[k - 1];
    const b = grad[k];
    const c = grad[k + 1];
    const den = a - 2 * b + c;
    const off = den < 0 ? (0.5 * (a - c)) / den : 0;
    return (k + Math.max(-0.5, Math.min(0.5, off))) * step;
  }
  return null;
}

// Total least squares line through points; returns { cx, cy, dx, dy }.
function fitLine(points) {
  let cx = 0;
  let cy = 0;
  for (const [x, y] of points) {
    cx += x;
    cy += y;
  }
  cx /= points.length;
  cy /= points.length;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of points) {
    const dx = x - cx;
    const dy = y - cy;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { cx, cy, dx: Math.cos(theta), dy: Math.sin(theta) };
}

function lineDistance(line, [x, y]) {
  return Math.abs((x - line.cx) * line.dy - (y - line.cy) * line.dx);
}

function robustLine(points, minCount) {
  let pts = points;
  let line = null;
  for (let iter = 0; iter < 3; iter++) {
    if (pts.length < minCount) return null;
    line = fitLine(pts);
    const res = pts.map((p) => lineDistance(line, p));
    const sorted = [...res].sort((a, b) => a - b);
    const mad = sorted[sorted.length >> 1];
    const limit = Math.max(1.0, 3 * mad);
    const next = pts.filter((_, i) => res[i] <= limit);
    if (next.length === pts.length) break;
    pts = next;
  }
  if (pts.length < minCount) return null;
  line = fitLine(pts);
  const rms = Math.sqrt(pts.reduce((s, p) => s + lineDistance(line, p) ** 2, 0) / pts.length);
  return { line, inliers: pts.length, rms };
}

function intersect(l1, l2) {
  const den = l1.dx * l2.dy - l1.dy * l2.dx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((l2.cx - l1.cx) * l2.dy - (l2.cy - l1.cy) * l2.dx) / den;
  return [l1.cx + t * l1.dx, l1.cy + t * l1.dy];
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
};

// Geometry of the refinement profiles: for each edge of the rough quad, the
// outward normal and `samplesPerEdge` points along the edge. Profile k of a
// point runs from +radius (outside) to -radius (inside) in `step` pixels.
export function edgeGeometry(rough, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const edges = [];
  for (let e = 0; e < 4; e++) {
    const [ax, ay] = rough[e];
    const [bx, by] = rough[(e + 1) % 4];
    const len = Math.hypot(bx - ax, by - ay);
    const dx = (bx - ax) / len;
    const dy = (by - ay) / len;
    // Outward normal for a clockwise quad in y-down coordinates.
    const nx = dy;
    const ny = -dx;
    const points = [];
    for (let s = 0; s < opts.samplesPerEdge; s++) {
      const t = opts.edgeMargin + ((1 - 2 * opts.edgeMargin) * s) / (opts.samplesPerEdge - 1);
      points.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
    }
    edges.push({ ax, ay, bx, by, nx, ny, points });
  }
  return edges;
}

export function profileSteps(radius, options = {}) {
  const step = options.step ?? DEFAULTS.step;
  return Math.ceil((2 * radius) / step) + 1;
}

// Profiles sampled on the CPU from an ImageRegion: Float32Array laid out as
// [edge][sample][step], NaN outside the region.
export function profilesCpu(img, rough, radius, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const geo = edgeGeometry(rough, opts);
  const n = profileSteps(radius, opts);
  const data = new Float32Array(4 * opts.samplesPerEdge * n);
  let o = 0;
  for (const g of geo) {
    for (const [px, py] of g.points) {
      for (let k = 0; k < n; k++) {
        const off = radius - k * opts.step;
        data[o++] = lumaBilinear(img, px + g.nx * off, py + g.ny * off);
      }
    }
  }
  return data;
}

// Linear interpolation of one profile at a (fractional) step index.
function profileAt(data, base, n, k) {
  if (!(k >= 0 && k <= n - 1)) return NaN;
  const i = Math.floor(k);
  const f = k - i;
  return i + 1 < n ? data[base + i] * (1 - f) + data[base + i + 1] * f : data[base + i];
}

// Checks the strips half a cell inside and outside a fitted edge, read from
// the profiles where each profile's normal crosses the fitted line.
function verifyOutlineEdge(data, e, g, line, radius, cellSize, n, opts) {
  const inside = [];
  const outside = [];
  const h = cellSize / 2;
  // Line normal m; offset along the profile normal where it meets the line.
  const mx = line.dy;
  const my = -line.dx;
  const denom = g.nx * mx + g.ny * my;
  if (Math.abs(denom) < 1e-6) return { ok: false, uniformity: 0 };
  for (let s = 0; s < g.points.length; s++) {
    const [px, py] = g.points[s];
    const off = ((line.cx - px) * mx + (line.cy - py) * my) / denom;
    const base = (e * g.points.length + s) * n;
    const vi = profileAt(data, base, n, (radius - (off - h)) / opts.step);
    const vo = profileAt(data, base, n, (radius - (off + h)) / opts.step);
    if (Number.isFinite(vi) && Number.isFinite(vo)) {
      inside.push(vi);
      outside.push(vo);
    }
  }
  if (inside.length < opts.samplesPerEdge / 2) return { ok: false, uniformity: 0 };
  const mi = median(inside);
  const mo = median(outside);
  if (mi - mo < opts.minContrast) return { ok: false, uniformity: 0, contrast: mi - mo };
  const thr = (mi + mo) / 2;
  const fi = inside.filter((v) => v > thr).length / inside.length;
  const fo = outside.filter((v) => v < thr).length / outside.length;
  const uniformity = Math.min(fi, fo);
  return { ok: uniformity >= opts.minUniformity, uniformity, contrast: mi - mo };
}

// Corner refinement from precomputed profiles (CPU: profilesCpu, GPU:
// gl-sampler.js). rough: [TL, TR, BR, BL] in camera pixels, clockwise.
// options.cellSize: approximate cell size in camera pixels; enables the
// outline verification (strongly recommended).
export function refineFromProfiles(data, rough, radius, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  if (!isValidQuad(rough)) return { ok: false, reason: 'invalid-quad', corners: rough };
  const n = profileSteps(radius, opts);
  const geo = edgeGeometry(rough, opts);
  const lines = [];
  const edges = [];

  for (let e = 0; e < 4; e++) {
    const g = geo[e];
    const points = [];
    for (let s = 0; s < g.points.length; s++) {
      const base = (e * g.points.length + s) * n;
      const pos = findEdge(data.subarray(base, base + n), opts.step, opts);
      if (pos === null) continue;
      const off = radius - pos;
      const [px, py] = g.points[s];
      points.push([px + g.nx * off, py + g.ny * off]);
    }
    const minCount = Math.max(6, Math.ceil(opts.samplesPerEdge * opts.minInlierRatio));
    const fit = robustLine(points, minCount);
    const edge = { found: points.length, inliers: fit?.inliers ?? 0, rms: fit?.rms ?? null };
    edges.push(edge);
    if (!fit) return { ok: false, reason: `edge-${e}-not-found`, corners: rough, edges };
    if (opts.cellSize) {
      const v = verifyOutlineEdge(data, e, g, fit.line, radius, opts.cellSize, n, opts);
      edge.uniformity = v.uniformity;
      edge.contrast = v.contrast ?? null;
      if (!v.ok) return { ok: false, reason: `edge-${e}-not-outline`, corners: rough, edges };
    }
    lines.push(fit.line);
  }

  // Corner i lies between edge i-1 and edge i.
  const corners = [];
  for (let i = 0; i < 4; i++) {
    const p = intersect(lines[(i + 3) % 4], lines[i]);
    if (!p) return { ok: false, reason: 'parallel-edges', corners: rough, edges };
    corners.push(p);
  }
  if (!isValidQuad(corners)) return { ok: false, reason: 'refined-quad-invalid', corners: rough, edges };
  const moved = Math.max(...corners.map((c, i) => dist(c, rough[i])));
  if (moved > radius * 1.5) return { ok: false, reason: 'moved-too-far', corners: rough, edges, moved };
  return { ok: true, corners, edges, moved };
}

// img: ImageRegion (image.js) covering the quad plus `radius`.
export function refineCorners(img, rough, radius, options = {}) {
  if (!isValidQuad(rough)) return { ok: false, reason: 'invalid-quad', corners: rough };
  return refineFromProfiles(profilesCpu(img, rough, radius, options), rough, radius, options);
}
