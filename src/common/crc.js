// CRC implementations (SPEC §8.1, §9.1, §13).

function makeReflectedTable(poly) {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ poly : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

const CRC32C_TABLE = makeReflectedTable(0x82f63b78);

// CRC-32C (Castagnoli). Pass a previous result as `crc` to continue a computation.
export function crc32c(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC32C_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return ~c >>> 0;
}

// CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, xorout 0.
export function crc16CcittFalse(bytes) {
  let c = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i] << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
}
