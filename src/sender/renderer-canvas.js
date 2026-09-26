// Canvas 2D renderer with integer device-pixel scaling and letterboxing (SPEC §4.3).

// Largest integer scale that fits (optionally capped), centered. Pure function
// so it can be tested in Node. A cap keeps the pattern smaller than a large
// monitor so that a portrait-held phone can frame all of it from close by.
export function computeLayout(deviceWidth, deviceHeight, gridWidth, gridHeight, maxScale = Infinity) {
  const scale = Math.min(maxScale, Math.floor(Math.min(deviceWidth / gridWidth, deviceHeight / gridHeight)));
  const width = gridWidth * scale;
  const height = gridHeight * scale;
  return {
    deviceWidth,
    deviceHeight,
    scale,
    width,
    height,
    offsetX: Math.floor((deviceWidth - width) / 2),
    offsetY: Math.floor((deviceHeight - height) / 2),
    fits: scale >= 1,
  };
}

export class CanvasRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.logical = document.createElement('canvas');
    this.logicalCtx = this.logical.getContext('2d');
    this.layout = null;
    this.sizeSource = null;
    this.onResize = null;
    this.maxScale = Infinity;

    // device-pixel-content-box gives the exact physical pixel size even under
    // fractional devicePixelRatio. Browsers without it fall back to rounding.
    this.observer = new ResizeObserver((entries) => this.#handleResize(entries[entries.length - 1]));
    try {
      this.observer.observe(canvas, { box: 'device-pixel-content-box' });
    } catch {
      this.observer.observe(canvas);
    }
  }

  #handleResize(entry) {
    let w;
    let h;
    const dpcb = entry.devicePixelContentBoxSize?.[0];
    if (dpcb) {
      w = dpcb.inlineSize;
      h = dpcb.blockSize;
      this.sizeSource = 'device-pixel-content-box';
    } else {
      const dpr = window.devicePixelRatio || 1;
      w = Math.round(entry.contentRect.width * dpr);
      h = Math.round(entry.contentRect.height * dpr);
      this.sizeSource = 'contentRect x devicePixelRatio (approximate)';
    }
    if (w === this.canvas.width && h === this.canvas.height) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.onResize?.();
  }

  render(imageData, backgroundGray) {
    const { width: gw, height: gh } = imageData;
    if (this.logical.width !== gw || this.logical.height !== gh) {
      this.logical.width = gw;
      this.logical.height = gh;
    }
    this.logicalCtx.putImageData(imageData, 0, 0);

    const L = computeLayout(this.canvas.width, this.canvas.height, gw, gh, this.maxScale);
    this.layout = L;
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = `rgb(${backgroundGray},${backgroundGray},${backgroundGray})`;
    ctx.fillRect(0, 0, L.deviceWidth, L.deviceHeight);
    if (L.fits) ctx.drawImage(this.logical, 0, 0, gw, gh, L.offsetX, L.offsetY, L.width, L.height);
  }
}
