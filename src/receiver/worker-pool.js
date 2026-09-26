// Pool of capture-processing workers (worker.js).
//
// The main thread crops the tracked region from the video into an
// ImageBitmap and hands it to an idle worker; with several workers, captures
// are processed in parallel so that the full camera frame rate can be used.
// If workers, OffscreenCanvas or createImageBitmap are unavailable, or a job
// fails, the pool reports itself unusable and the caller falls back to the
// main thread.

export function workersSupported() {
  return typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function';
}

class PoolWorker {
  constructor(url) {
    this.worker = new Worker(url, { type: 'module' });
    this.busy = false;
    this.pending = new Map();
    this.nextId = 1;
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker start timeout')), 5000);
      this.worker.addEventListener('message', (e) => {
        if (e.data.ready) {
          clearTimeout(timer);
          if (e.data.offscreenCanvas) resolve();
          else reject(new Error('OffscreenCanvas unavailable in worker'));
          return;
        }
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        if (e.data.error) p.reject(new Error(e.data.error));
        else p.resolve(e.data);
      });
      this.worker.addEventListener('error', (e) => {
        clearTimeout(timer);
        reject(new Error(e.message || 'worker error'));
        for (const p of this.pending.values()) p.reject(new Error(e.message || 'worker error'));
        this.pending.clear();
      });
    });
  }

  call(message, transfer) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id }, transfer);
    });
  }

  terminate() {
    this.worker.terminate();
  }
}

export class WorkerPool {
  constructor(size) {
    this.size = size;
    this.usable = false;
    this.error = null;
    const url = new URL('./worker.js', import.meta.url);
    this.workers = Array.from({ length: size }, () => new PoolWorker(url));
    this.ready = Promise.all(this.workers.map((w) => w.ready)).then(
      () => {
        this.usable = true;
      },
      (e) => {
        this.fail(e);
      },
    );
  }

  fail(e) {
    this.usable = false;
    this.error = String(e?.message ?? e);
  }

  hasIdle() {
    return this.usable && this.workers.some((w) => !w.busy);
  }

  busyCount() {
    return this.workers.filter((w) => w.busy).length;
  }

  // roi: integer { x0, y0, w, h } in video pixels; job: processCapture inputs.
  async run(video, roi, job) {
    const w = this.workers.find((x) => !x.busy);
    if (!w) throw new Error('no idle worker');
    w.busy = true;
    const t0 = performance.now();
    try {
      const bitmap = await createImageBitmap(video, roi.x0, roi.y0, roi.w, roi.h);
      const tBitmap = performance.now();
      const res = await w.call({ ...job, roi, bitmap }, [bitmap]);
      return {
        r: res.r,
        timing: { readMs: tBitmap - t0 + res.readMs, procMs: res.procMs, totalMs: performance.now() - t0, radius: job.radius },
      };
    } finally {
      w.busy = false;
    }
  }

  terminate() {
    for (const w of this.workers) w.terminate();
    this.usable = false;
  }
}
