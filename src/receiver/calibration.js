// Render-level calibration (SPEC §6: levels MUST be calibrated empirically).
//
// Given the sRGB levels the sender rendered and the camera-side centers the
// receiver observed, the display -> camera response is approximated as
// piecewise linear through those points and inverted to find render levels
// with the desired camera-side centers. By default the gaps are made equal;
// with per-level noise (standard deviation), gap i is made proportional to
// sigma_i + sigma_(i+1), which maximizes the worst-case normalized separation
// when some levels are noisier (e.g. dark cells brightened by neighbors).
// Iterating (render, measure, recommend) converges on the actual response.

function targets(observed, noise) {
  const n = observed.length;
  const lo = observed[0];
  const hi = observed[n - 1];
  const weights = [];
  for (let i = 0; i < n - 1; i++) weights.push(noise ? noise[i] + noise[i + 1] : 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const out = [lo];
  let acc = lo;
  for (let i = 0; i < n - 2; i++) {
    acc += ((hi - lo) * weights[i]) / total;
    out.push(acc);
  }
  out.push(hi);
  return out;
}

// options.noise: per-level standard deviation of the observed values.
export function recommendLevels(renderLevels, observedCenters, { noise = null } = {}) {
  const n = renderLevels.length;
  if (n !== observedCenters.length || n < 2) return null;
  for (let i = 1; i < n; i++) {
    // The response must be increasing for the inverse to exist.
    if (!(observedCenters[i] > observedCenters[i - 1]) || !(renderLevels[i] > renderLevels[i - 1])) return null;
  }
  if (noise && (noise.length !== n || noise.some((s) => !(s > 0)))) noise = null;
  const goal = targets(observedCenters, noise);
  const out = [renderLevels[0]];
  for (let k = 1; k < n - 1; k++) {
    const target = goal[k];
    let s = 1;
    while (s < n - 1 && observedCenters[s] < target) s++;
    const c0 = observedCenters[s - 1];
    const c1 = observedCenters[s];
    const t = (target - c0) / (c1 - c0);
    out.push(Math.round(renderLevels[s - 1] + t * (renderLevels[s] - renderLevels[s - 1])));
  }
  out.push(renderLevels[n - 1]);
  return out;
}

// Smallest gap between adjacent observed centers relative to the full span:
// 1 when perfectly equal, smaller when some levels are crowded.
export function spacingUniformity(centers) {
  const span = centers[centers.length - 1] - centers[0];
  if (!(span > 0)) return null;
  let min = Infinity;
  for (let i = 1; i < centers.length; i++) min = Math.min(min, centers[i] - centers[i - 1]);
  return (min / span) * (centers.length - 1);
}

// Worst-case separation of adjacent levels in units of their combined noise:
// min_i (c_(i+1) - c_i) / (sigma_i + sigma_(i+1)). Larger is better; the
// quantity that level calibration should maximize.
export function minSeparation(centers, noise) {
  if (!noise || noise.length !== centers.length) return null;
  let min = Infinity;
  for (let i = 1; i < centers.length; i++) {
    const s = noise[i - 1] + noise[i];
    if (!(s > 0)) return null;
    min = Math.min(min, (centers[i] - centers[i - 1]) / s);
  }
  return min;
}
