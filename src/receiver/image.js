// Luminance access on an RGBA image region (SPEC §5.2).
//
// An ImageRegion is { data: Uint8ClampedArray (RGBA), width, height, x0, y0 },
// where (x0, y0) is the region's offset in camera-image coordinates, so that
// callers can work in full-frame coordinates while only a region is read.

// Rec.709 luma on sRGB values, as recommended by SPEC §5.2.
export const LUMA_FORMULA = 'Rec.709 (0.2126 R + 0.7152 G + 0.0722 B) on sRGB';

export function lumaAt(img, x, y) {
  const px = Math.floor(x) - img.x0;
  const py = Math.floor(y) - img.y0;
  if (px < 0 || py < 0 || px >= img.width || py >= img.height) return NaN;
  const i = (py * img.width + px) * 4;
  const d = img.data;
  return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
}

// Bilinear luma; pixel (i, j) covers [i, i+1) x [j, j+1), centered at i + 0.5.
export function lumaBilinear(img, x, y) {
  const fx = x - img.x0 - 0.5;
  const fy = y - img.y0 - 0.5;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  if (ix < 0 || iy < 0 || ix + 1 >= img.width || iy + 1 >= img.height) return NaN;
  const tx = fx - ix;
  const ty = fy - iy;
  const d = img.data;
  const w = img.width;
  const l = (k) => 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2];
  const i00 = (iy * w + ix) * 4;
  const i10 = i00 + 4;
  const i01 = i00 + w * 4;
  const i11 = i01 + 4;
  return (l(i00) * (1 - tx) + l(i10) * tx) * (1 - ty) + (l(i01) * (1 - tx) + l(i11) * tx) * ty;
}
