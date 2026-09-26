// Canvas overlay on the <video> preview: maps taps to camera-image
// coordinates and draws the tracked quad and error cells.
//
// While corners are being picked, touching the preview shows a magnifier
// above the finger; the point is placed where the finger is released, so it
// can be dragged onto the corner with camera-pixel precision.

const LOUPE_RADIUS = 70; // CSS px
const LOUPE_OFFSET = 110; // CSS px above the finger
const LOUPE_IMAGE_PX_PER_CSS_PX = 1; // magnification: one camera pixel per CSS pixel

export class PreviewOverlay {
  constructor(video, canvas) {
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onTap = null;
    this.picking = false;
    this.loupe = null; // { client: [x, y], image: [x, y] } while dragging
    this.lastState = {};

    canvas.addEventListener('pointerdown', (e) => {
      if (!this.picking) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      this.#moveLoupe(e);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.loupe) this.#moveLoupe(e);
    });
    canvas.addEventListener('pointerup', (e) => {
      if (!this.loupe) return;
      this.#moveLoupe(e);
      const p = this.loupe.image;
      this.loupe = null;
      this.draw(this.lastState);
      if (p) this.onTap?.(p);
    });
    canvas.addEventListener('pointercancel', () => {
      this.loupe = null;
      this.draw(this.lastState);
    });
  }

  setPicking(picking) {
    this.picking = picking;
    // Only block page scrolling over the preview while picking.
    this.canvas.style.touchAction = picking ? 'none' : 'auto';
    this.canvas.style.pointerEvents = picking ? 'auto' : 'none';
  }

  #moveLoupe(e) {
    this.loupe = { client: [e.clientX, e.clientY], image: this.toImage(e.clientX, e.clientY) };
    this.draw(this.lastState);
  }

  // Letterboxed rectangle of the video content inside the element (object-fit: contain).
  contentRect() {
    const r = this.video.getBoundingClientRect();
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh || !r.width || !r.height) return null;
    const scale = Math.min(r.width / vw, r.height / vh);
    return { left: r.left + (r.width - vw * scale) / 2, top: r.top + (r.height - vh * scale) / 2, scale, box: r };
  }

  toImage(clientX, clientY) {
    const c = this.contentRect();
    if (!c) return null;
    const x = (clientX - c.left) / c.scale;
    const y = (clientY - c.top) / c.scale;
    if (x < 0 || y < 0 || x > this.video.videoWidth || y > this.video.videoHeight) return null;
    return [x, y];
  }

  // Resizes the backing store and returns a function mapping image -> canvas px.
  #prepare() {
    const c = this.contentRect();
    const dpr = window.devicePixelRatio || 1;
    const box = this.canvas.getBoundingClientRect();
    const w = Math.round(box.width * dpr);
    const h = Math.round(box.height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.clearRect(0, 0, w, h);
    if (!c) return null;
    return { map: ([x, y]) => [(c.left - box.left + x * c.scale) * dpr, (c.top - box.top + y * c.scale) * dpr], box, dpr };
  }

  #drawLoupe(box, dpr) {
    const { client, image } = this.loupe;
    if (!image) return;
    const ctx = this.ctx;
    const r = LOUPE_RADIUS * dpr;
    const cx = (client[0] - box.left) * dpr;
    // Keep the loupe inside the preview even near the top edge.
    const cy = Math.max(r + 4, (client[1] - box.top - LOUPE_OFFSET) * dpr);
    const half = LOUPE_RADIUS * LOUPE_IMAGE_PX_PER_CSS_PX; // camera px from center to rim
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#000';
    ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.video, image[0] - half, image[1] - half, 2 * half, 2 * half, cx - r, cy - r, 2 * r, 2 * r);
    ctx.restore();
    ctx.strokeStyle = '#ffd24d';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.moveTo(cx - r, cy);
    ctx.lineTo(cx - 6 * dpr, cy);
    ctx.moveTo(cx + 6 * dpr, cy);
    ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx, cy - 6 * dpr);
    ctx.moveTo(cx, cy + 6 * dpr);
    ctx.lineTo(cx, cy + r);
    ctx.stroke();
  }

  // state: { taps, quad, quadOk, errorPoints }
  draw(state = {}) {
    this.lastState = state;
    const { taps = [], quad = null, quadOk = false, errorPoints = [], badRects = [] } = state;
    const prep = this.#prepare();
    if (!prep) return;
    const { map, box, dpr } = prep;
    const ctx = this.ctx;

    // Known-bad camera regions (reliability-map.js), below everything else.
    if (badRects.length) {
      ctx.fillStyle = 'rgba(255, 150, 0, 0.3)';
      for (const [x0, y0, x1, y1] of badRects) {
        const [ax, ay] = map([x0, y0]);
        const [bx, by] = map([x1, y1]);
        ctx.fillRect(ax, ay, bx - ax, by - ay);
      }
    }

    if (quad) {
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = quadOk ? '#3ddc84' : '#ff5c5c';
      ctx.beginPath();
      quad.forEach((p, i) => {
        const [x, y] = map(p);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.stroke();
      // Mark the top-left corner so orientation mistakes are visible.
      const [x0, y0] = map(quad[0]);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.arc(x0, y0, 5 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = 'rgba(255, 60, 60, 0.9)';
    for (const p of errorPoints) {
      const [x, y] = map(p);
      ctx.fillRect(x - 1.5 * dpr, y - 1.5 * dpr, 3 * dpr, 3 * dpr);
    }

    ctx.font = `${12 * dpr}px system-ui, sans-serif`;
    taps.forEach((p, i) => {
      const [x, y] = map(p);
      ctx.strokeStyle = '#ffd24d';
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.moveTo(x - 8 * dpr, y);
      ctx.lineTo(x + 8 * dpr, y);
      ctx.moveTo(x, y - 8 * dpr);
      ctx.lineTo(x, y + 8 * dpr);
      ctx.stroke();
      ctx.fillStyle = '#ffd24d';
      ctx.fillText(String(i + 1), x + 6 * dpr, y - 6 * dpr);
    });

    if (this.loupe) this.#drawLoupe(box, dpr);
  }
}
