// Display-refresh counter driven by requestAnimationFrame (SPEC §10.1).
// Runs continuously so the refresh interval is known before transmission starts.
// A late callback advances the count by the number of refreshes that elapsed,
// so logical-frame timing stays locked to the display even when frames are missed.

const WINDOW = 120;
const MIN_SAMPLES = 10;

export class FrameClock {
  constructor(onTick) {
    this.onTick = onTick;
    this.vsync = 0;
    this.missed = 0;
    this.lastTs = null;
    this.deltas = [];
    this.handle = null;
    this.loop = this.loop.bind(this);
  }

  start() {
    if (this.handle !== null) return;
    this.lastTs = null;
    this.handle = requestAnimationFrame(this.loop);
  }

  stop() {
    if (this.handle !== null) cancelAnimationFrame(this.handle);
    this.handle = null;
  }

  // Median rAF delta; robust against occasional missed refreshes.
  get refreshIntervalMs() {
    if (this.deltas.length < MIN_SAMPLES) return null;
    const sorted = [...this.deltas].sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  }

  get refreshHz() {
    const iv = this.refreshIntervalMs;
    return iv ? 1000 / iv : null;
  }

  loop(ts) {
    if (this.lastTs !== null) {
      const d = ts - this.lastTs;
      this.deltas.push(d);
      if (this.deltas.length > WINDOW) this.deltas.shift();
      const iv = this.refreshIntervalMs ?? d;
      const steps = Math.max(1, Math.round(d / iv));
      this.missed += steps - 1;
      this.vsync += steps;
    }
    this.lastTs = ts;
    this.onTick(this.vsync, ts);
    this.handle = requestAnimationFrame(this.loop);
  }
}
