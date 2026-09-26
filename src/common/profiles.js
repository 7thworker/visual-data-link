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
});

export function getProfileById(id) {
  return Object.values(PROFILES).find((p) => p.id === id) ?? null;
}

function assertInt(name, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer in [${min}, ${max}], got ${value}`);
  }
}

// Ad-hoc configuration for experiments (SPEC §3 "Experimental profiles").
// Its parameters must be logged because the ID alone does not identify them.
export function makeExperimentalProfile({ id = EXPERIMENTAL_ID_MIN, gridWidth, gridHeight, levels, dwellRefreshes }) {
  assertInt('id', id, EXPERIMENTAL_ID_MIN, EXPERIMENTAL_ID_MAX);
  assertInt('gridWidth', gridWidth, GRID_MIN, GRID_MAX);
  assertInt('gridHeight', gridHeight, GRID_MIN, GRID_MAX);
  assertInt('dwellRefreshes', dwellRefreshes, 1, DWELL_MAX);
  if (!SUPPORTED_LEVELS.includes(levels)) {
    throw new RangeError(`levels must be one of ${SUPPORTED_LEVELS.join(', ')}, got ${levels}`);
  }
  return defineProfile({
    id,
    key: 'EXP',
    name: `Experimental 0x${id.toString(16)} ${gridWidth}x${gridHeight} L${levels}`,
    gridWidth,
    gridHeight,
    levels,
    dwellRefreshes,
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
  });
}

// Serializable description for test logs.
export function describeProfile(profile) {
  const { id, key, name, gridWidth, gridHeight, levels, dwellRefreshes, experimental } = profile;
  return { id, key, name, gridWidth, gridHeight, levels, bitsPerSymbol: bitsPerSymbol(levels), dwellRefreshes, experimental };
}
