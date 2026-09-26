// Screen Wake Lock wrapper (SPEC §14). The lock is released by the browser when
// the page is hidden, so it is re-acquired on return while still wanted.

export class WakeLock {
  constructor() {
    this.sentinel = null;
    this.wanted = false;
    this.lastError = null;
    document.addEventListener('visibilitychange', () => {
      if (this.wanted && document.visibilityState === 'visible') this.#request();
    });
  }

  get supported() {
    return 'wakeLock' in navigator;
  }

  get state() {
    if (!this.supported) return 'unsupported';
    if (this.sentinel && !this.sentinel.released) return 'active';
    return this.wanted ? 'lost' : 'inactive';
  }

  async acquire() {
    this.wanted = true;
    await this.#request();
  }

  async release() {
    this.wanted = false;
    const s = this.sentinel;
    this.sentinel = null;
    await s?.release();
  }

  async #request() {
    if (!this.supported) return;
    try {
      this.sentinel = await navigator.wakeLock.request('screen');
      this.lastError = null;
    } catch (e) {
      this.lastError = String(e);
    }
  }
}
