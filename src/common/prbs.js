// Deterministic PRBS (SPEC §8.1). Not cryptographic.

import { crc32c } from './crc.js';

// 0x03 seeds the outer code's coefficients with its own generator (rlnc.js).
export const PRBS_DOMAIN = Object.freeze({
  WHITENING: 0x01,
  TEST_PAYLOAD: 0x02,
  OUTER_CODE: 0x03,
});

export const ZERO_SEED_REPLACEMENT = 0x9e3779b9;

// seed = CRC32C(domain || session_id || sequence), with 0 replaced.
export function prbsSeed(domain, sessionId, sequence) {
  const buf = new Uint8Array(9);
  const view = new DataView(buf.buffer);
  buf[0] = domain & 0xff;
  view.setUint32(1, sessionId >>> 0);
  view.setUint32(5, sequence >>> 0);
  const seed = crc32c(buf);
  return seed === 0 ? ZERO_SEED_REPLACEMENT : seed;
}

// 32-bit xorshift; each step's state is emitted MSB first.
export class Xorshift32 {
  constructor(seed) {
    this.state = seed >>> 0 || ZERO_SEED_REPLACEMENT;
    this.word = 0;
    this.bitsLeft = 0;
  }

  nextU32() {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state;
  }

  nextBit() {
    if (this.bitsLeft === 0) {
      this.word = this.nextU32();
      this.bitsLeft = 32;
    }
    this.bitsLeft--;
    return (this.word >>> this.bitsLeft) & 1;
  }

  // Returns `n` bits (n <= 30) as an integer, first bit most significant.
  nextBits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.nextBit();
    return v;
  }

  fillBytes(out) {
    for (let i = 0; i < out.length; i++) out[i] = this.nextBits(8);
    return out;
  }
}

export function createPrbs(domain, sessionId, sequence) {
  return new Xorshift32(prbsSeed(domain, sessionId, sequence));
}
