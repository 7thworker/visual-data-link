// Relative luminance of sRGB grays (WCAG 2.x formula), for the sender's guard
// gray and the photosensitivity check (SPEC §16.3, tools/flash-check.mjs).

export const relativeLuminance = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

// The 8-bit sRGB gray whose relative luminance is closest to the mean of the
// levels' (a data frame with whitened payload shows every level equally
// often). The mean of the sRGB codes instead (170 for 80 / 150 / 205 / 245)
// is 16% darker in light and made the guard flash (SPEC §16.3).
export function linearMeanGray(levels) {
  const target = levels.reduce((a, v) => a + relativeLuminance(v), 0) / levels.length;
  let best = 0;
  for (let v = 1; v < 256; v++) if (Math.abs(relativeLuminance(v) - target) < Math.abs(relativeLuminance(best) - target)) best = v;
  return best;
}

// The same for colours ([r, g, b] sRGB, e.g. the 8-colour palette of
// color.js): the gray matching their mean relative luminance.
export function linearMeanGrayRgb(colours) {
  const lum = ([r, g, b]) => 0.2126 * relativeLuminance(r) + 0.7152 * relativeLuminance(g) + 0.0722 * relativeLuminance(b);
  const target = colours.reduce((a, c) => a + lum(c), 0) / colours.length;
  let best = 0;
  for (let v = 1; v < 256; v++) if (Math.abs(relativeLuminance(v) - target) < Math.abs(relativeLuminance(best) - target)) best = v;
  return best;
}
