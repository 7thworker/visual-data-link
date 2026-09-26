// Lightweight measurement helpers. No per-sample object allocation.

// Event rate over a sliding time window.
export class RateMeter {
  constructor(windowMs = 2000, capacity = 1024) {
    this.windowMs = windowMs;
    this.times = new Float64Array(capacity);
    this.head = 0;
    this.count = 0;
  }

  push(t) {
    const cap = this.times.length;
    this.times[(this.head + this.count) % cap] = t;
    if (this.count < cap) this.count++;
    else this.head = (this.head + 1) % cap;
    while (this.count > 1 && this.times[this.head] < t - this.windowMs) {
      this.head = (this.head + 1) % cap;
      this.count--;
    }
  }

  get rate() {
    if (this.count < 2) return 0;
    const cap = this.times.length;
    const first = this.times[this.head];
    const last = this.times[(this.head + this.count - 1) % cap];
    return last > first ? ((this.count - 1) * 1000) / (last - first) : 0;
  }

  reset() {
    this.head = 0;
    this.count = 0;
  }
}

// Count / mean / min / max / standard deviation (Welford).
export class RunningStats {
  constructor() {
    this.reset();
  }

  reset() {
    this.count = 0;
    this.mean = 0;
    this.m2 = 0;
    this.min = Infinity;
    this.max = -Infinity;
  }

  push(v) {
    this.count++;
    const d = v - this.mean;
    this.mean += d / this.count;
    this.m2 += d * (v - this.mean);
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
  }

  get std() {
    return this.count > 1 ? Math.sqrt(this.m2 / (this.count - 1)) : 0;
  }

  toJSON() {
    if (this.count === 0) return { count: 0 };
    return { count: this.count, mean: this.mean, std: this.std, min: this.min, max: this.max };
  }
}
