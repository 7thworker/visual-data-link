// Frame header (SPEC §9.1 tentative layout, 144 bits, big-endian, MSB first):
//
//   magic 16 | version 4 | profile ID 8 | frame type 4 | flags 4 |
//   session ID 32 | sequence 32 | source block 8 | payload length 16 |
//   reserved 4 | CRC-16/CCITT-FALSE 16 (over the preceding 128 bits)

import { crc16CcittFalse } from './crc.js';
import { MAGIC, PROTOCOL_VERSION, HEADER_BITS } from './protocol.js';

const FIELDS = [
  ['magic', 16],
  ['version', 4],
  ['profileId', 8],
  ['frameType', 4],
  ['flags', 4],
  ['sessionId', 32],
  ['sequence', 32],
  ['sourceBlock', 8],
  ['payloadLength', 16],
  ['reserved', 4],
];

export const HEADER_BYTES = HEADER_BITS / 8;

function writeBits(bytes, pos, value, n) {
  for (let i = n - 1; i >= 0; i--, pos++) {
    // Arithmetic instead of bit shifts: 32-bit fields exceed the signed range.
    const bit = Math.floor(value / 2 ** i) & 1;
    if (bit) bytes[pos >> 3] |= 0x80 >> (pos & 7);
  }
  return pos;
}

function readBits(bytes, pos, n) {
  let v = 0;
  for (let i = 0; i < n; i++, pos++) v = v * 2 + ((bytes[pos >> 3] >> (7 - (pos & 7))) & 1);
  return v;
}

export function encodeHeader(fields) {
  const f = { magic: MAGIC, version: PROTOCOL_VERSION, flags: 0, sourceBlock: 0, reserved: 0, ...fields };
  const bytes = new Uint8Array(HEADER_BYTES);
  let pos = 0;
  for (const [name, n] of FIELDS) {
    const v = f[name];
    if (!Number.isInteger(v) || v < 0 || v >= 2 ** n) throw new RangeError(`header field ${name} out of range: ${v}`);
    pos = writeBits(bytes, pos, v, n);
  }
  const crc = crc16CcittFalse(bytes.subarray(0, 16));
  bytes[16] = crc >> 8;
  bytes[17] = crc & 0xff;
  return bytes;
}

// Returns { ok: true, fields } or { ok: false, reason }.
export function decodeHeader(bytes) {
  const crc = (bytes[16] << 8) | bytes[17];
  if (crc16CcittFalse(bytes.subarray(0, 16)) !== crc) return { ok: false, reason: 'crc' };
  const fields = {};
  let pos = 0;
  for (const [name, n] of FIELDS) {
    fields[name] = readBits(bytes, pos, n);
    pos += n;
  }
  if (fields.magic !== MAGIC) return { ok: false, reason: 'magic' };
  if (fields.version !== PROTOCOL_VERSION) return { ok: false, reason: 'version' };
  return { ok: true, fields };
}

// Header bytes <-> 144 bits (MSB first), one bit per binary header cell.
export function headerToBits(bytes) {
  const bits = new Uint8Array(HEADER_BITS);
  for (let i = 0; i < HEADER_BITS; i++) bits[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  return bits;
}

export function bitsToHeader(bits) {
  const bytes = new Uint8Array(HEADER_BYTES);
  for (let i = 0; i < HEADER_BITS; i++) if (bits[i]) bytes[i >> 3] |= 0x80 >> (i & 7);
  return bytes;
}
