// Planar homography from four point correspondences (SPEC §2, receiver step 3).
// H is a row-major Float64Array(9) with H[8] = 1, mapping (x, y) -> (u, v).

// Solves A x = b in place (Gaussian elimination with partial pivoting).
// A is a row-major n x n Float64Array. Returns null if singular.
export function solveLinear(A, b, n) {
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r * n + c]) > Math.abs(A[p * n + c])) p = r;
    if (Math.abs(A[p * n + c]) < 1e-12) return null;
    if (p !== c) {
      for (let k = 0; k < n; k++) [A[c * n + k], A[p * n + k]] = [A[p * n + k], A[c * n + k]];
      [b[c], b[p]] = [b[p], b[c]];
    }
    for (let r = c + 1; r < n; r++) {
      const f = A[r * n + c] / A[c * n + c];
      for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k];
      b[r] -= f * b[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r * n + k] * x[k];
    x[r] = s / A[r * n + r];
  }
  return x;
}

// src, dst: arrays of four [x, y]. Returns null for degenerate input.
export function computeHomography(src, dst) {
  const A = new Float64Array(64);
  const b = new Float64Array(8);
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    const r0 = 2 * i * 8;
    const r1 = r0 + 8;
    A.set([x, y, 1, 0, 0, 0, -u * x, -u * y], r0);
    A.set([0, 0, 0, x, y, 1, -v * x, -v * y], r1);
    b[2 * i] = u;
    b[2 * i + 1] = v;
  }
  const h = solveLinear(A, b, 8);
  if (!h || !h.every(Number.isFinite)) return null;
  const H = new Float64Array(9);
  H.set(h);
  H[8] = 1;
  return H;
}

export function applyHomography(H, x, y, out = [0, 0]) {
  const w = H[6] * x + H[7] * y + H[8];
  out[0] = (H[0] * x + H[1] * y + H[2]) / w;
  out[1] = (H[3] * x + H[4] * y + H[5]) / w;
  return out;
}

export function invertHomography(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) return null;
  const inv = new Float64Array([
    A, -(b * i - c * h), b * f - c * e,
    B, a * i - c * g, -(a * f - c * d),
    C, -(a * h - b * g), a * e - b * d,
  ]);
  for (let k = 0; k < 9; k++) inv[k] /= det;
  const s = inv[8];
  for (let k = 0; k < 9; k++) inv[k] /= s;
  return inv;
}

// Logical-frame corners in cell units, in the TL, TR, BR, BL order used by
// corner selection (SPEC §0: origin at the top-left cell).
export function logicalCorners(gridWidth, gridHeight) {
  return [
    [0, 0],
    [gridWidth, 0],
    [gridWidth, gridHeight],
    [0, gridHeight],
  ];
}

// Least-squares homography from n >= 4 correspondences, with both point sets
// normalised (centroid at the origin, mean distance sqrt 2) for conditioning.
// Returns null for degenerate input.
export function fitHomography(src, dst) {
  const norm = (pts) => {
    const n = pts.length;
    const cx = pts.reduce((a, p) => a + p[0], 0) / n;
    const cy = pts.reduce((a, p) => a + p[1], 0) / n;
    const d = pts.reduce((a, p) => a + Math.hypot(p[0] - cx, p[1] - cy), 0) / n;
    const s = d > 0 ? Math.SQRT2 / d : 1;
    return { s, cx, cy, pts: pts.map(([x, y]) => [(x - cx) * s, (y - cy) * s]) };
  };
  const a = norm(src);
  const b = norm(dst);
  const A = new Float64Array(64);
  const r = new Float64Array(8);
  const add = (row, v) => {
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) A[i * 8 + j] += row[i] * row[j];
      r[i] += row[i] * v;
    }
  };
  for (let k = 0; k < src.length; k++) {
    const [x, y] = a.pts[k];
    const [u, v] = b.pts[k];
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    add([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  const h = solveLinear(A, r, 8);
  if (!h || !h.every(Number.isFinite)) return null;
  // H = Tb^-1 * Hn * Ta, where Ta maps p to s * (p - c).
  const Hn = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  const Ta = [a.s, 0, -a.s * a.cx, 0, a.s, -a.s * a.cy, 0, 0, 1];
  const Tbi = [1 / b.s, 0, b.cx, 0, 1 / b.s, b.cy, 0, 0, 1];
  const mul = (P, Q) => Array.from({ length: 9 }, (_, i) => {
    const row = 3 * Math.floor(i / 3);
    const col = i % 3;
    return P[row] * Q[col] + P[row + 1] * Q[3 + col] + P[row + 2] * Q[6 + col];
  });
  const M = mul(Tbi, mul(Hn, Ta));
  if (!M[8]) return null;
  const H = new Float64Array(9);
  for (let i = 0; i < 9; i++) H[i] = M[i] / M[8];
  return H.every(Number.isFinite) ? H : null;
}
