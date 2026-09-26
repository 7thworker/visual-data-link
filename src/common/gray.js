// Gray mapping between symbol index and bit group (SPEC §6.1).
// For 4 levels: S0 -> 00, S1 -> 01, S2 -> 11, S3 -> 10.

export function symbolToBits(symbol) {
  return symbol ^ (symbol >>> 1);
}

export function bitsToSymbol(bits) {
  let s = bits;
  for (let shift = 1; shift < 32; shift <<= 1) s ^= s >>> shift;
  return s;
}
