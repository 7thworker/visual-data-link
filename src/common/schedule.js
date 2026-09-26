// Display schedule of animated frames (sender-ui.js): each logical frame is
// shown for `dwell` refreshes, then `guard` refreshes of gray.
//
// Phase stepping (M8, 2026-09-26): without a guard, 2 refreshes at 60 Hz
// (33.4 ms) are within 0.1 ms of the camera's 30 fps, so the camera's
// exposure keeps the same position within the frame for tens of seconds.
// Where it straddles the frame change, every capture is blended (a 1 MiB
// transfer took 64 s instead of 9 s). With stepEvery = K, every K-th frame is
// shown one refresh longer: the frames after it start half a period later
// relative to the camera, so the exposure alternates between two positions
// half a period apart every K frames and at most one of them straddles the
// change. Costs 1 refresh per K frames.

// Mean refreshes per logical frame.
export function meanPeriodRefreshes({ dwell, guard = 0, stepEvery = 0 }) {
  return dwell + guard + (stepEvery > 0 ? 1 / stepEvery : 0);
}

// Refresh n since the start (0-based) -> { index: logical frame since the
// start, inGuard }. The extra refresh of a stepped frame extends its content.
export function slotAt(n, { dwell, guard = 0, stepEvery = 0 }) {
  const period = dwell + guard;
  if (!(stepEvery > 0)) return { index: Math.floor(n / period), inGuard: n % period >= dwell };
  const block = stepEvery * period + 1;
  const b = Math.floor(n / block);
  const r = n - b * block;
  const k = Math.min(stepEvery - 1, Math.floor(r / period));
  const m = r - k * period;
  const content = k === stepEvery - 1 ? dwell + 1 : dwell;
  return { index: b * stepEvery + k, inGuard: m >= content };
}
