// Colour modulation experiment (ROADMAP M8 "color modulation"): symbols of
// an 8-level experimental profile drawn as colours instead of grays. Symbol s
// sets red / green / blue from its bits 2 / 1 / 0 (0 = dark, 1 = bright), so
// 0 is dark gray and 7 white (the outline), and each cell carries 3 bits
// against 2 for 4-level gray (P1). The header copies use only 0 and 7, so
// they read on luma as with grays; the receiver decides the other cells in
// RGB (receiver/colour-demod.js) for profiles with palette 'rgb8'.

export const RGB8_LEVELS = Object.freeze({ lo: 30, hi: 235 });

export const PALETTE_RGB8 = Object.freeze(
  Array.from({ length: 8 }, (_, s) => Object.freeze([s & 4 ? RGB8_LEVELS.hi : RGB8_LEVELS.lo, s & 2 ? RGB8_LEVELS.hi : RGB8_LEVELS.lo, s & 1 ? RGB8_LEVELS.hi : RGB8_LEVELS.lo])),
);

// 27 colours: 3 levels per channel, symbol s = 9 r + 3 g + b (26 = white, the
// outline). The middle level sits below the arithmetic mean because the
// camera compresses the highlights (P1 grays 80 / 150 / 205 / 245 read about
// 120 / 180 / 219 / 237). Per channel: with 115 for all three (2026-09-26,
// 11.4 px/cell) red and green were error-free but blue confused dark and
// middle in 3-4% of the cells (middle / bright only 0.02%), so blue's middle
// is raised. Static measurements (PRBS pattern, tools/color-analyze.mjs) and
// file transfer (19 bits per 4 cells, fec.js; receiver/colour-demod.js).
export const RGB27_LEVELS = Object.freeze([Object.freeze([30, 115, 235]), Object.freeze([30, 115, 235]), Object.freeze([30, 155, 235])]);
export const PALETTE_RGB27 = Object.freeze(
  Array.from({ length: 27 }, (_, s) => Object.freeze([RGB27_LEVELS[0][Math.floor(s / 9)], RGB27_LEVELS[1][Math.floor(s / 3) % 3], RGB27_LEVELS[2][s % 3]])),
);

export const COLOR_MODES = Object.freeze({ gray: 'グレー', rgb8: '8 色（R・G・B 各 2 段階、実験）', rgb27: '27 色（R・G・B 各 3 段階、実験）' });

// Palette of a profile (its palette field, or a colour mode chosen for it),
// or null (gray levels).
export function paletteFor(mode, profile) {
  const m = profile.palette ?? mode;
  if (m === 'rgb8' && profile.levels === 8) return PALETTE_RGB8;
  if (m === 'rgb27' && profile.levels === 27) return PALETTE_RGB27;
  return null;
}

export function writeSymbolsRgbPalette(symbols, palette, rgba) {
  if (rgba.length < symbols.length * 4) throw new RangeError('RGBA buffer too small');
  for (let i = 0, p = 0; i < symbols.length; i++, p += 4) {
    const c = palette[symbols[i]];
    rgba[p] = c[0];
    rgba[p + 1] = c[1];
    rgba[p + 2] = c[2];
    rgba[p + 3] = 255;
  }
  return rgba;
}
