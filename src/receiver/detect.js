// Coarse automatic screen detection (a simple precursor of ROADMAP M3).
//
// Works on a downscaled frame: box blur (so the random payload averages to a
// uniform mid-gray), Otsu threshold, largest bright connected component, and
// its extreme points as rough corners. refineCorners() then snaps them to the
// outline edge exactly as for manual taps. If the component still contains a
// darker letterbox (windowed sender), a second threshold inside it isolates
// the brighter pattern area.

import { isValidQuad, signedArea } from './acquisition.js';

const MIN_AREA_FRACTION = 0.01;
const MIN_FILL = 0.75; // component area / quad area
const SPLIT_MIN_CONTRAST = 40; // luma gap for the second (letterbox) split
const SPLIT_MIN_MINORITY = 0.1;
const MAX_CANDIDATES = 5; // bright regions tried per threshold, largest first
// A landscape monitor across a portrait frame covers ~6% (half the width) to ~25%.
const SECONDARY_MIN_AREA_FRACTION = 0.04;

function lumaOf(img) {
  const { data, width, height } = img;
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
  return out;
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++, n++) s += src[y * w + k];
      tmp[y * w + x] = s / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++, n++) s += tmp[k * w + x];
      out[y * w + x] = s / n;
    }
  }
  return out;
}

// Otsu threshold over the values selected by `mask` (all if null).
function otsu(values, mask) {
  const hist = new Float64Array(256);
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    if (mask && !mask[i]) continue;
    hist[Math.max(0, Math.min(255, values[i] | 0))]++;
    total++;
  }
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];
  let wB = 0;
  let sumB = 0;
  let best = -1;
  let thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  return thr;
}

// Largest 4-connected component of (values > thr) within `allowed` (optional).
function largestComponent(values, w, h, thr, allowed) {
  return components(values, w, h, thr, allowed, 1)[0] ?? null;
}

// 4-connected components of (values > thr) within `allowed`, largest first
// (at most `limit`), each with its mask.
function components(values, w, h, thr, allowed, limit, minArea = 1) {
  const labels = new Int32Array(w * h);
  const queue = new Int32Array(w * h);
  const all = [];
  let label = 0;
  for (let start = 0; start < labels.length; start++) {
    if (labels[start] || values[start] <= thr || (allowed && !allowed[start])) continue;
    label++;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = label;
    const c = { label, area: 0, tl: null, tr: null, br: null, bl: null, s1min: Infinity, s1max: -Infinity, s2min: Infinity, s2max: -Infinity, x0: w, y0: h, x1: -1, y1: -1 };
    while (head < tail) {
      const i = queue[head++];
      const x = i % w;
      const y = (i - x) / w;
      c.area++;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      const s1 = x + y;
      const s2 = x - y;
      if (s1 < c.s1min) (c.s1min = s1), (c.tl = [x, y]);
      if (s1 > c.s1max) (c.s1max = s1), (c.br = [x, y]);
      if (s2 > c.s2max) (c.s2max = s2), (c.tr = [x, y]);
      if (s2 < c.s2min) (c.s2min = s2), (c.bl = [x, y]);
      const push = (j) => {
        if (!labels[j] && values[j] > thr && (!allowed || allowed[j])) {
          labels[j] = label;
          queue[tail++] = j;
        }
      };
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (y > 0) push(i - w);
      if (y < h - 1) push(i + w);
    }
    if (c.area >= minArea) all.push(c);
  }
  all.sort((a, b) => b.area - a.area);
  const out = all.slice(0, limit);
  const byLabel = new Map(out.map((c) => [c.label, c]));
  for (const c of out) c.mask = new Uint8Array(w * h);
  for (let i = 0; i < labels.length; i++) {
    const c = labels[i] && byLabel.get(labels[i]);
    if (c) c.mask[i] = 1;
  }
  return out;
}

// Rough corners of a component, independent of its rotation in the image:
// extreme points of (u / su ± v / sv) in the component's principal axes
// (second moments; su, sv the standard deviations), so that a screen rolled
// by any angle, or appearing portrait because the phone is held sideways,
// still yields its four corners. Returned clockwise, starting with the
// corner nearest the image's top-left; which one is the frame's top-left is
// decided later from the header (pipeline.js orientation search).
function componentQuad(c, w) {
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < c.mask.length; i++) {
    if (!c.mask[i]) continue;
    n++;
    sx += i % w;
    sy += Math.floor(i / w);
  }
  const mx = sx / n + 0.5;
  const my = sy / n + 0.5;
  let cxx = 0;
  let cyy = 0;
  let cxy = 0;
  for (let i = 0; i < c.mask.length; i++) {
    if (!c.mask[i]) continue;
    const dx = (i % w) + 0.5 - mx;
    const dy = Math.floor(i / w) + 0.5 - my;
    cxx += dx * dx;
    cyy += dy * dy;
    cxy += dx * dy;
  }
  const theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  let suu = 0;
  let svv = 0;
  for (let i = 0; i < c.mask.length; i++) {
    if (!c.mask[i]) continue;
    const dx = (i % w) + 0.5 - mx;
    const dy = Math.floor(i / w) + 0.5 - my;
    suu += (dx * cos + dy * sin) ** 2;
    svv += (-dx * sin + dy * cos) ** 2;
  }
  const su = Math.sqrt(suu / n) || 1;
  const sv = Math.sqrt(svv / n) || 1;
  // Extremes of the four diagonal directions; pixel corners farthest out.
  const best = [-Infinity, -Infinity, -Infinity, -Infinity];
  const pts = [null, null, null, null];
  const dirs = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  for (let i = 0; i < c.mask.length; i++) {
    if (!c.mask[i]) continue;
    const x0 = i % w;
    const y0 = Math.floor(i / w);
    for (const [ox, oy] of [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]) {
      const dx = x0 + ox - mx;
      const dy = y0 + oy - my;
      const u = (dx * cos + dy * sin) / su;
      const v = (-dx * sin + dy * cos) / sv;
      for (let d = 0; d < 4; d++) {
        const s = dirs[d][0] * u + dirs[d][1] * v;
        if (s > best[d]) {
          best[d] = s;
          pts[d] = [x0 + ox, y0 + oy];
        }
      }
    }
  }
  // Clockwise on screen (y down) = increasing atan2 around the centroid.
  const q = pts.slice().sort((a, b) => Math.atan2(a[1] - my, a[0] - mx) - Math.atan2(b[1] - my, b[0] - mx));
  let start = 0;
  for (let k = 1; k < 4; k++) if (q[k][0] + q[k][1] < q[start][0] + q[start][1]) start = k;
  return [0, 1, 2, 3].map((k) => q[(start + k) % 4]);
}

// small: RGBA ImageRegion of the downscaled frame; scale: full-res px per small px.
// gridAspect: expected width / height of the logical frame (loose check only).
//
// Several candidates are tried, largest first: a bright wall or window that
// is larger than the screen (often cut off by the image border) must not
// hide it. A second threshold, Otsu within the darker class, handles scenes
// where such a region is so bright that the screen falls into the dark class.
// On failure the reason of the largest candidate is reported.
export function detectScreen(small, scale, { gridAspect = 16 / 9, blurRadius = 2 } = {}) {
  const { width: w, height: h } = small;
  const luma = boxBlur(lumaOf(small), w, h, blurRadius);
  const t1 = otsu(luma, null);
  const darker = new Uint8Array(luma.length);
  for (let i = 0; i < luma.length; i++) darker[i] = luma[i] <= t1 ? 1 : 0;
  const minArea = MIN_AREA_FRACTION * w * h;
  let first = null;
  let tried = 0;
  for (const thr of [t1, otsu(luma, darker)]) {
    for (const comp of components(luma, w, h, thr, null, MAX_CANDIDATES, minArea)) {
      // Apart from the very first, candidates must be screen-sized, so that a
      // lamp is not taken for the screen while the screen itself is cut off.
      if (tried && comp.area < SECONDARY_MIN_AREA_FRACTION * w * h) continue;
      tried++;
      const r = checkCandidate(luma, w, h, comp, scale, gridAspect);
      if (r.ok) return { ...r, candidates: tried };
      first ??= r;
    }
  }
  return first ? { ...first, candidates: tried } : { ok: false, reason: 'no-bright-region', candidates: 0 };
}

function checkCandidate(luma, w, h, comp, scale, gridAspect) {
  // A windowed sender leaves a darker S0 letterbox inside the bright region.
  const inner = otsu(luma, comp.mask);
  let lo = 0;
  let hi = 0;
  let nLo = 0;
  let nHi = 0;
  for (let i = 0; i < luma.length; i++) {
    if (!comp.mask[i]) continue;
    if (luma[i] > inner) (hi += luma[i]), nHi++;
    else (lo += luma[i]), nLo++;
  }
  const minority = Math.min(nLo, nHi) / (nLo + nHi);
  if (nLo && nHi && hi / nHi - lo / nLo >= SPLIT_MIN_CONTRAST && minority >= SPLIT_MIN_MINORITY) {
    const split = largestComponent(luma, w, h, inner, comp.mask);
    if (split && split.area >= comp.area * 0.3) comp = split;
  }

  if (comp.area < MIN_AREA_FRACTION * w * h) return { ok: false, reason: 'region-too-small' };
  // A region touching the image border is (most likely) cut off.
  const cut = [comp.y0 === 0 && 'top', comp.x1 === w - 1 && 'right', comp.y1 === h - 1 && 'bottom', comp.x0 === 0 && 'left'].filter(Boolean);
  if (cut.length) return { ok: false, reason: `out-of-view-${cut[0]}`, cut };
  const q = componentQuad(comp, w);
  if (!isValidQuad(q)) return { ok: false, reason: 'region-not-quad' };
  const fill = comp.area / signedArea(q);
  if (fill < MIN_FILL) return { ok: false, reason: 'region-not-rectangular', fill };
  const top = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]);
  const left = Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]);
  // Long side over short side: the screen may appear portrait (phone sideways).
  const aspect = Math.max(top, left) / Math.min(top, left);
  const g = Math.max(gridAspect, 1 / gridAspect);
  if (aspect < g / 2 || aspect > g * 2) return { ok: false, reason: 'aspect-mismatch', aspect };
  return { ok: true, corners: q.map(([x, y]) => [x * scale, y * scale]), fill, aspect };
}

// Box-filter downscale of an RGBA ImageRegion (tests / non-browser use; the
// browser path lets drawImage do the scaling).
export function downscale(img, factor) {
  const w = Math.floor(img.width / factor);
  const h = Math.floor(img.height / factor);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) r += img.data[((y * factor + dy) * img.width + x * factor + dx) * 4];
      }
      const v = r / (factor * factor);
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h, x0: 0, y0: 0 };
}
