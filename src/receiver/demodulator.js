// Symbol decision from sampled cell luminance.
//
// Milestone 1 has no pilot cells yet, so level centers are estimated blindly
// with 1-D k-means over the payload cells. Milestone 2 replaces this with
// pilot-based centers (SPEC §7).

export const DEMOD_METHOD = '1-D k-means over payload cells (no pilots)';

// values: Float32Array; indices: cells to use. Returns ascending centers.
export function kmeans1d(values, indices, k, iterations = 20) {
  let m = 0;
  const v = new Float32Array(indices.length);
  for (const i of indices) if (!Number.isNaN(values[i])) v[m++] = values[i];
  if (m < k) return null;
  // Typed-array sort is numeric and far faster than Array#sort with a comparator.
  const sorted = v.subarray(0, m).sort();
  // Initialize at evenly spaced quantiles.
  let centers = Array.from({ length: k }, (_, j) => sorted[Math.floor(((j + 0.5) * m) / k)]);
  const sums = new Float64Array(k);
  const counts = new Uint32Array(k);
  for (let it = 0; it < iterations; it++) {
    sums.fill(0);
    counts.fill(0);
    // The values are sorted, so assignment is a sweep over decision thresholds.
    let j = 0;
    for (const x of sorted) {
      while (j < k - 1 && x > (centers[j] + centers[j + 1]) / 2) j++;
      sums[j] += x;
      counts[j]++;
    }
    const next = centers.map((c, i) => (counts[i] ? sums[i] / counts[i] : c));
    const moved = next.some((c, i) => Math.abs(c - centers[i]) > 1e-6);
    centers = next;
    if (!moved) break;
  }
  return centers;
}

// Nearest-center decision. Returns symbol indices; `margin` receives the
// distance to the nearest decision threshold (a simple confidence measure).
export function classify(values, centers, out, margin) {
  const n = values.length;
  const symbols = out && out.length === n ? out : new Uint8Array(n);
  const k = centers.length;
  const thresholds = [];
  for (let j = 0; j < k - 1; j++) thresholds.push((centers[j] + centers[j + 1]) / 2);
  for (let i = 0; i < n; i++) {
    const x = values[i];
    let s = 0;
    while (s < k - 1 && x > thresholds[s]) s++;
    symbols[i] = s;
    if (margin) {
      let m = Infinity;
      if (s > 0) m = Math.min(m, x - thresholds[s - 1]);
      if (s < k - 1) m = Math.min(m, thresholds[s] - x);
      margin[i] = m;
    }
  }
  return symbols;
}
