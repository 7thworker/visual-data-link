// Why captures fail the inner FEC (diagnostics for Milestone 8).
//
// During a file transfer the receiver cannot know a frame's content until
// the whole object has arrived. Afterwards it can: every MANIFEST / DATA
// frame is regenerated from the verified object exactly as the sender built
// it (object-frame.js), and the captures kept by ObjectReceiver
// (keepFailed) are compared with it. Per failed capture this gives the
// symbol error rate, its distribution over row and column bands of the
// frame (rolling-shutter stripes, blur, regional loss), which header copies
// were valid, and — for frames with several failed captures — the error rate
// of the soft combination (object-receiver.js #combine), to judge whether
// combining could have worked.
//
// Mixing check (mixing.js): for DATA frames of the outer code, the frames
// shown just before and after are regenerated too, the mixing is fitted
// against each and the true partner is cancelled. The error rate after the
// cancellation shows whether the receiver could have recovered the capture
// had it known the partner, i.e. whether the mixing model fits real captures.
// rawSamples of the failed captures carry their raw cell values and the true
// symbols of the frame and its neighbours, for offline work on the model
// (tools/mixing-replay.mjs).

import { FRAME_TYPE } from '../common/protocol.js';
import { fecRateFromFlags } from '../common/fec.js';
import { payloadMask, pilotLayoutFor } from '../common/test-frame.js';
import { prepareTransfer, buildObjectFrame, dataBody, objectPilotShift, OUTER_CODE_RLNC } from '../common/object-frame.js';
import { combineBlockOf, combineWeight } from './object-receiver.js';
import { fitMixing, cancelPartner } from './mixing.js';

const ROW_BANDS = 9;
const COL_BANDS = 10;
const CHUNK = 8; // captures analyzed between yields to the event loop
const SER_BUCKETS = [0.02, 0.05, 0.1, 0.2, 0.4, Infinity];
// Below this symbol error rate the inner FEC (中) decodes nearly always.
const DECODABLE_SER = 0.03;

const yieldToLoop = () => new Promise((r) => setTimeout(r, 0));

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Symbols (0..3) packed four per byte, first symbol in the high bits.
function packSymbols(symbols) {
  const out = new Uint8Array(Math.ceil(symbols.length / 4));
  for (let i = 0; i < symbols.length; i++) out[i >> 2] |= (symbols[i] & 3) << (6 - 2 * (i & 3));
  return out;
}

// Raw values of a failed record back to luma (NaN = not read).
export function recordValues(u16) {
  return Float32Array.from(u16, (v) => (v === 0xffff ? NaN : v / 16));
}

// failed: ObjectReceiver.failed records; session: the verified session;
// rawSamples: failed captures (spread over the trial) exported with raw values.
export async function analyzeFailedCaptures(profile, session, failed, { rawSamples = 0 } = {}) {
  if (!failed.length) return { captures: 0 };
  const m = session.manifest;
  const mask = payloadMask(profile, 'file');
  const index = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) index.push(i);
  const { gridWidth: w, gridHeight: h, levels } = profile;
  const rowOf = index.map((i) => Math.min(ROW_BANDS - 1, Math.floor((Math.floor(i / w) * ROW_BANDS) / h)));
  const colOf = index.map((i) => Math.min(COL_BANDS - 1, Math.floor(((i % w) * COL_BANDS) / w)));
  const blockOf = combineBlockOf(profile, index);
  const transfers = new Map(); // FEC rate -> prepared transfer (regenerates frames)
  // Full frame symbols of a frame (header fields), as the sender built it.
  const frameOf = (rec) => {
    const fec = fecRateFromFlags(rec.flags);
    let tx = transfers.get(fec);
    if (!tx) {
      tx = prepareTransfer({ profile, fec, sessionId: session.sessionId, bytes: session.data, sha256: m.sha256, name: m.name, mime: m.mime, manifestEvery: 1, outerCode: m.outerCode });
      transfers.set(fec, tx);
    }
    const entry =
      rec.frameType === FRAME_TYPE.MANIFEST
        ? null
        : { sourceBlock: rec.sourceBlock, sequence: rec.sequence, repair: m.outerCode === 1 && rec.sequence >= tx.plan.blocks[rec.sourceBlock].count };
    const body = entry ? dataBody(tx, entry) : tx.manifestBody;
    return buildObjectFrame({ profile, sessionId: session.sessionId, sequence: rec.sequence, frameType: rec.frameType, sourceBlock: rec.sourceBlock, body, fec });
  };
  const serOf = (symbols, frame) => {
    let e = 0;
    for (const i of index) if (symbols[i] !== frame[i]) e++;
    return e / index.length;
  };
  // DATA frames shown just before and after (object-receiver.js #neighbours).
  const Z = m.blockCount;
  const neighbours = (rec) => {
    if (m.outerCode !== OUTER_CODE_RLNC || rec.frameType !== FRAME_TYPE.DATA) return [];
    const d = rec.sequence * Z + rec.sourceBlock;
    return [
      ['prev', d - 1],
      ['next', d + 1],
    ]
      .filter(([, x]) => x >= 0)
      .map(([name, x]) => [name, { frameType: FRAME_TYPE.DATA, sourceBlock: x % Z, sequence: Math.floor(x / Z), flags: rec.flags }]);
  };
  const pilots = pilotLayoutFor(profile, 'file');
  const rawPick = new Set();
  if (rawSamples > 0) {
    const data = failed.map((r, k) => (r.values && r.frameType === FRAME_TYPE.DATA ? k : -1)).filter((k) => k >= 0);
    const n = Math.min(rawSamples, data.length);
    for (let j = 0; j < n; j++) rawPick.add(data[Math.floor(((j + 0.5) * data.length) / n)]);
  }
  const raw = [];
  let unmixTried = 0;
  let unmixDecodable = 0;
  const unmixBuckets = new Array(SER_BUCKETS.length).fill(0);

  const out = [];
  const byKey = new Map(); // key -> records so far (for the combination)
  const buckets = new Array(SER_BUCKETS.length).fill(0);
  let serSum = 0;
  let combinedTried = 0;
  let combinedBetter = 0;
  for (let k = 0; k < failed.length; k++) {
    const rec = failed[k];
    let frame;
    let truth;
    try {
      frame = frameOf(rec);
      truth = Uint8Array.from(index, (i) => frame[i]);
    } catch {
      continue; // e.g. a frame of another object
    }
    const N = truth.length;
    const rowErr = new Array(ROW_BANDS).fill(0);
    const rowN = new Array(ROW_BANDS).fill(0);
    const colErr = new Array(COL_BANDS).fill(0);
    const colN = new Array(COL_BANDS).fill(0);
    let errors = 0;
    let lowSpacing = 0;
    for (let c = 0; c < N; c++) {
      rowN[rowOf[c]]++;
      colN[colOf[c]]++;
      if (rec.symbols[c] !== truth[c]) {
        errors++;
        rowErr[rowOf[c]]++;
        colErr[colOf[c]]++;
      }
      if (rec.spacing && rec.spacing[c] < rec.medianSpacing * 0.5) lowSpacing++;
    }
    const ser = errors / N;
    serSum += ser;
    buckets[SER_BUCKETS.findIndex((b) => ser < b)]++;
    const item = {
      t: rec.t,
      type: rec.frameType === FRAME_TYPE.MANIFEST ? 'M' : 'D',
      block: rec.sourceBlock,
      esi: rec.sequence,
      headerCopies: rec.headerCopies,
      ser: +ser.toFixed(4),
      rows: rowErr.map((e, i) => +(e / rowN[i]).toFixed(3)),
      cols: colErr.map((e, i) => +(e / colN[i]).toFixed(3)),
      noise: rec.noise === null ? null : +rec.noise.toFixed(2),
      medianSpacing: rec.medianSpacing,
      lowSpacingShare: rec.spacing ? +(lowSpacing / N).toFixed(3) : null,
      // Payload misfit (level units^2, ~0.083 for garbage): mean and worst block.
      misfit: rec.misfit ? +(rec.misfit.reduce((a, b) => a + b, 0) / rec.misfit.length).toFixed(4) : null,
      misfitMax: rec.misfit ? +Math.max(...rec.misfit).toFixed(4) : null,
      // sqrt(pilot variance): level-coordinate noise (combining weights), mean and worst block.
      sigmaU: rec.pilotVariance ? +Math.sqrt(rec.pilotVariance.reduce((a, b) => a + b, 0) / rec.pilotVariance.length).toFixed(3) : null,
      sigmaUMax: rec.pilotVariance ? +Math.sqrt(Math.max(...rec.pilotVariance)).toFixed(3) : null,
    };
    // Mixing check against the true neighbours.
    const partners = neighbours(rec).map(([name, p]) => [name, p, frameOf(p)]);
    if (rec.values && rec.qShape && partners.length) {
      const values = recordValues(rec.values);
      const sN = objectPilotShift(rec, levels);
      let best = null;
      item.unmix = {};
      for (const [name, p, pf] of partners) {
        const fit = fitMixing(values, profile, pilots, sN, objectPilotShift(p, levels), rec.qShape);
        if (!fit) {
          item.unmix[name] = null;
          continue;
        }
        const ser2 = serOf(cancelPartner(values, profile, fit, pf, rec.qShape, index).symbols, frame);
        item.unmix[name] = { share: +fit.share.toFixed(3), ser: +ser2.toFixed(4) };
        if (best === null || ser2 < best) best = ser2;
      }
      if (best !== null) {
        unmixTried++;
        if (best < DECODABLE_SER) unmixDecodable++;
        unmixBuckets[SER_BUCKETS.findIndex((b) => best < b)]++;
      }
    }
    if (rawPick.has(k)) {
      const sample = {
        record: out.length,
        block: rec.sourceBlock,
        esi: rec.sequence,
        qShape: rec.qShape,
        values: toBase64(new Uint8Array(rec.values.buffer, rec.values.byteOffset, rec.values.byteLength)),
        truth: toBase64(packSymbols(frame)),
      };
      for (const [name, , pf] of partners) sample[name] = toBase64(packSymbols(pf));
      raw.push(sample);
    }
    // Soft combination with the earlier failed captures of the same frame.
    const prev = byKey.get(rec.key) ?? [];
    if (prev.length && rec.coord) {
      const group = [...prev, rec];
      let cErr = 0;
      for (let c = 0; c < N; c++) {
        let s = 0;
        let ws = 0;
        for (const g of group) {
          if (g.coord[c] === 255) continue; // not read
          const u = g.coord[c] / 50 - 0.5;
          // Same rule as ObjectReceiver #combine.
          const wt = g.pilotVariance ? combineWeight(g.pilotVariance[blockOf[c]]) : 1;
          s += wt * u;
          ws += wt;
        }
        const sym = ws ? Math.max(0, Math.min(levels - 1, Math.round(s / ws))) : 0;
        if (sym !== truth[c]) cErr++;
      }
      item.combinedWith = prev.length;
      item.combinedSer = +(cErr / N).toFixed(4);
      item.bestSingleSer = +Math.min(ser, ...prev.map((p) => p.ser)).toFixed(4);
      combinedTried++;
      if (item.combinedSer < item.bestSingleSer) combinedBetter++;
    }
    rec.ser = ser;
    byKey.set(rec.key, [...prev, rec]);
    out.push(item);
    if ((k + 1) % CHUNK === 0) await yieldToLoop();
  }
  return {
    captures: out.length,
    meanSer: out.length ? serSum / out.length : null,
    serHistogram: Object.fromEntries(SER_BUCKETS.map((b, i) => [`<${b === Infinity ? 'inf' : b}`, buckets[i]])),
    combinedTried,
    combinedBetter,
    // Best SER after cancelling the true partner (prev or next).
    unmixByTruth: {
      tried: unmixTried,
      decodable: unmixDecodable,
      serHistogram: Object.fromEntries(SER_BUCKETS.map((b, i) => [`<${b === Infinity ? 'inf' : b}`, unmixBuckets[i]])),
    },
    records: out,
    rawFormat: raw.length ? 'values: uint16 LE luma x 16 (0xffff = not read), all grid cells; truth / prev / next: symbols packed 4 per byte, high bits first' : undefined,
    rawSamples: raw.length ? raw : undefined,
  };
}
