// Protocol constants (SPEC §9, header encoding in header.js). Protocol version 1
// is the freeze candidate of v0.1/FREEZE-CANDIDATE.md.

export const MAGIC = 0x5644; // "VD"
export const PROTOCOL_VERSION = 1;
export const HEADER_BITS = 144;

// Revision of the object-frame format within protocol version 1, published
// with the sender config so that the receiver can tell a stale sender page
// (its frames then all fail the CRC32C). Bump when the frame content changes.
// m7-1: CRC32C covers the source block; outer code 1 (rlnc.js).
// m8-1: object-frame pilot levels shift from frame to frame (objectPilotShift).
// m8-2: the pilot shift uses the parity of the source block (differs for 3+ blocks).
// m8-3: pilot shift (source block mod 3) + 3 x ESI (neighbours also tell apart).
// m9-1: whitening seed includes frame type and source block; freeze candidate
//       (FREEZE-CANDIDATE.md). Later incompatible changes change the header
//       version or the profile ID (SPEC §17); this string only checks that the
//       harness pages are of the same build.
export const FORMAT_REVISION = 'm9-1';

export const FRAME_TYPE = Object.freeze({
  TEST: 0,
  DATA: 1,
  MANIFEST: 2,
  IDLE: 3,
});

export { PRBS_DOMAIN } from './prbs.js';
