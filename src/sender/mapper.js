// Maps symbol indices to grayscale RGBA pixels of the logical canvas.

import { RENDER_LEVELS } from '../common/profiles.js';

// `gray` overrides the nominal levels (calibrated values, SPEC §6).
export function writeSymbolsRgba(symbols, levels, rgba, gray = RENDER_LEVELS[levels]) {
  if (!gray || gray.length !== levels) throw new RangeError(`no render levels for ${levels}`);
  if (rgba.length < symbols.length * 4) throw new RangeError('RGBA buffer too small');
  for (let i = 0, p = 0; i < symbols.length; i++, p += 4) {
    const g = gray[symbols[i]];
    rgba[p] = g;
    rgba[p + 1] = g;
    rgba[p + 2] = g;
    rgba[p + 3] = 255;
  }
  return rgba;
}
