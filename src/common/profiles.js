// PHY profile definitions (SPEC §3).
// Single source of truth shared by sender and receiver (ARCHITECTURE §1).

export const EXPERIMENTAL_ID_MIN = 0xf0;
export const EXPERIMENTAL_ID_MAX = 0xff;

export const SUPPORTED_LEVELS = Object.freeze([2, 4, 8]);

// Nominal sRGB gray render levels (SPEC §6). Non-normative; to be calibrated.
// 2-level uses S0/S3 of the 4-level set (SPEC §6.2). 8-level is evenly spaced
// over the same range and exists only for experimental profiles.
export const RENDER_LEVELS = Object.freeze({
  2: Object.freeze([80, 245]),
  4: Object.freeze([80, 150, 205, 245]),
  8: Object.freeze([80, 104, 127, 151, 174, 198, 221, 245]),
});

const GRID_MIN = 8;
const GRID_MAX = 1024;
const DWELL_MAX = 600;

function defineProfile(p) {
  return Object.freeze({ ...p, experimental: p.id >= EXPERIMENTAL_ID_MIN });
}

export const PROFILES = Object.freeze({
  P0: defineProfile({ id: 0, key: 'P0', name: 'P0 Rescue', gridWidth: 96, gridHeight: 54, levels: 2, dwellRefreshes: 12 }),
  P1: defineProfile({ id: 1, key: 'P1', name: 'P1 Base', gridWidth: 160, gridHeight: 90, levels: 4, dwellRefreshes: 6 }),
  // SPEC allows 3–4 refreshes; 4 (66.7 ms) is the default until measured.
  P2: defineProfile({ id: 2, key: 'P2', name: 'P2 Fast candidate', gridWidth: 240, gridHeight: 135, levels: 4, dwellRefreshes: 4 }),
  // 8 colours (common/color.js), 3 refreshes without a guard (SPEC §3, 2026-09-27):
  // P3 reads held upright or sideways on both test phones (1 MiB in 12-25 s),
  // P4 held upright only on the newer one (8.5-9.3 s), sideways on both.
  P3: defineProfile({ id: 3, key: 'P3', name: 'P3 Colour', gridWidth: 200, gridHeight: 112, levels: 8, dwellRefreshes: 3, palette: 'rgb8' }),
  P4: defineProfile({ id: 4, key: 'P4', name: 'P4 Colour fine', gridWidth: 240, gridHeight: 135, levels: 8, dwellRefreshes: 3, palette: 'rgb8' }),
});

export function getProfileById(id) {
  return Object.values(PROFILES).find((p) => p.id === id) ?? null;
}

function assertInt(name, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer in [${min}, ${max}], got ${value}`);
  }
}

// Colour palettes of experimental profiles (common/color.js): symbols drawn
// as colours instead of grays, with the number of symbols each needs. 27
// colours (3 levels per channel) are not a power of two: 19 bits per 4 cells
// (fec.js symbolGrouping) and 9-colour pilot tiles (pilots.js).
export const PALETTE_LEVELS = Object.freeze({ rgb8: 8, rgb27: 27 });
export const PALETTES = Object.freeze(Object.keys(PALETTE_LEVELS));

// Ad-hoc configuration for experiments (SPEC §3 "Experimental profiles").
// Its parameters must be logged because the ID alone does not identify them.
// palette: null (grays) or 'rgb8' (8 symbols as the corners of the RGB cube).
export function makeExperimentalProfile({ id = EXPERIMENTAL_ID_MIN, gridWidth, gridHeight, levels, dwellRefreshes, palette = null }) {
  assertInt('id', id, EXPERIMENTAL_ID_MIN, EXPERIMENTAL_ID_MAX);
  assertInt('gridWidth', gridWidth, GRID_MIN, GRID_MAX);
  assertInt('gridHeight', gridHeight, GRID_MIN, GRID_MAX);
  assertInt('dwellRefreshes', dwellRefreshes, 1, DWELL_MAX);
  if (palette !== null && PALETTE_LEVELS[palette] !== levels) throw new RangeError(`palette ${palette} needs ${PALETTE_LEVELS[palette] ?? '?'} levels`);
  if (!SUPPORTED_LEVELS.includes(levels) && !(palette && PALETTE_LEVELS[palette] === levels)) {
    throw new RangeError(`levels must be one of ${SUPPORTED_LEVELS.join(', ')}, got ${levels}`);
  }
  return defineProfile({
    id,
    key: 'EXP',
    name: `Experimental 0x${id.toString(16)} ${gridWidth}x${gridHeight} L${levels}${palette ? ` ${palette}` : ''}`,
    gridWidth,
    gridHeight,
    levels,
    dwellRefreshes,
    palette,
  });
}

export function bitsPerSymbol(levels) {
  return Math.log2(levels);
}

export function nominalDwellMs(profile, refreshHz = 60) {
  return (profile.dwellRefreshes * 1000) / refreshHz;
}

// Inverse of describeProfile(): the standard profile for its ID, or an
// experimental profile rebuilt from the recorded parameters.
export function profileFromDescription(p) {
  if (!p.experimental) {
    const known = getProfileById(p.id);
    if (known) return known;
  }
  return makeExperimentalProfile({
    id: p.id,
    gridWidth: p.gridWidth,
    gridHeight: p.gridHeight,
    levels: p.levels,
    dwellRefreshes: p.dwellRefreshes,
    palette: p.palette ?? null,
  });
}

// Serializable description for test logs.
export function describeProfile(profile) {
  const { id, key, name, gridWidth, gridHeight, levels, dwellRefreshes, experimental, palette = null } = profile;
  return { id, key, name, gridWidth, gridHeight, levels, bitsPerSymbol: bitsPerSymbol(levels), dwellRefreshes, experimental, ...(palette ? { palette } : {}) };
}
