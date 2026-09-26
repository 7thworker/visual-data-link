// Capture-processing worker: region pixels -> processCapture() -> decisions.
// Runs the whole per-capture chain off the main thread so that the page keeps
// receiving camera frames at full rate (Milestone 4 throughput).

import { processRegion } from './pipeline.js';
import { profileFromDescription } from '../common/profiles.js';

let canvas = null;
let ctx = null;

self.onmessage = (e) => {
  const { id, bitmap, roi, quad, profile, pattern, radius, scale = 1, compare = true, orient = false, order, interior = false } = e.data;
  try {
    const t0 = performance.now();
    const cw = Math.max(1, Math.round(roi.w * scale));
    const ch = Math.max(1, Math.round(roi.h * scale));
    if (!canvas || canvas.width !== cw || canvas.height !== ch) {
      canvas = new OffscreenCanvas(cw, ch);
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
    ctx.drawImage(bitmap, 0, 0, cw, ch);
    bitmap.close();
    const { data } = ctx.getImageData(0, 0, cw, ch);
    const t1 = performance.now();
    const r = processRegion({ data, width: cw, height: ch }, quad, profileFromDescription(profile), { radius, pattern, compare, orient, interior, ...(order ? { order } : {}) }, {
      x0: roi.x0,
      y0: roi.y0,
      sx: cw / roi.w,
      sy: ch / roi.h,
    });
    const t2 = performance.now();
    // Only what the main thread uses; typed arrays are transferred, not copied.
    const out = {
      ok: r.ok,
      reason: r.reason,
      corners: r.corners,
      imageCorners: r.imageCorners,
      order: r.order,
      orientation: r.orientation,
      geometryOk: r.geometryOk,
      pilotShift: r.pilotShift,
      headerFields: r.headerFields,
      soft: r.soft,
      ppc: r.ppc,
      outlineMatch: r.outlineMatch,
      centers: r.centers,
      method: r.method,
      refine: r.refine && { ok: r.refine.ok, reason: r.refine.reason, edges: r.refine.edges, moved: r.refine.moved },
      symbols: r.symbols,
      values: r.values,
      confidence: r.confidence,
      alternatives: r.alternatives,
      pilot: r.pilot && { global: r.pilot.global },
      readScale: r.readScale,
    };
    const arrays = [out.symbols, out.values, out.confidence, out.soft?.coord, out.soft?.spacing, out.soft?.bits, out.rgb, ...Object.values(out.alternatives ?? {})].filter(Boolean);
    self.postMessage({ id, r: out, readMs: t1 - t0, procMs: t2 - t1 }, arrays.map((a) => a.buffer));
  } catch (err) {
    bitmap?.close?.();
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
};

self.postMessage({ ready: true, offscreenCanvas: typeof OffscreenCanvas !== 'undefined' });
