// Reed-Solomon over GF(256) (SPEC §11.2 inner FEC).
//
// Primitive polynomial 0x11d, generator alpha = 2, first consecutive root
// alpha^0 (the common "reedsolo" convention). Systematic: a codeword is the
// message followed by nsym parity bytes. Codewords may be shortened (n < 255).
// decode() corrects e errors and E erasures as long as 2e + E <= nsym.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
const div = (a, b) => {
  if (b === 0) throw new RangeError('GF division by zero');
  return a === 0 ? 0 : EXP[(LOG[a] + 255 - LOG[b]) % 255];
};
const pow = (a, n) => (a === 0 ? 0 : EXP[(((LOG[a] * n) % 255) + 255) % 255]);
const inv = (a) => EXP[255 - LOG[a]];

// Polynomials are arrays of coefficients, highest degree first.
function polyMul(p, q) {
  const r = new Uint8Array(p.length + q.length - 1);
  for (let j = 0; j < q.length; j++) {
    if (!q[j]) continue;
    for (let i = 0; i < p.length; i++) r[i + j] ^= mul(p[i], q[j]);
  }
  return r;
}

function polyEval(p, x) {
  let y = p[0];
  for (let i = 1; i < p.length; i++) y = mul(y, x) ^ p[i];
  return y;
}

function polyScale(p, x) {
  return p.map((c) => mul(c, x));
}

function polyAdd(p, q) {
  const r = new Uint8Array(Math.max(p.length, q.length));
  for (let i = 0; i < p.length; i++) r[i + r.length - p.length] = p[i];
  for (let i = 0; i < q.length; i++) r[i + r.length - q.length] ^= q[i];
  return r;
}

const generators = new Map();
function generator(nsym) {
  let g = generators.get(nsym);
  if (!g) {
    g = Uint8Array.of(1);
    for (let i = 0; i < nsym; i++) g = polyMul(g, Uint8Array.of(1, EXP[i]));
    generators.set(nsym, g);
  }
  return g;
}

// Returns the nsym parity bytes for `data` (data.length + nsym <= 255).
export function rsEncode(data, nsym) {
  if (data.length + nsym > 255) throw new RangeError('codeword longer than 255');
  const g = generator(nsym);
  const buf = new Uint8Array(data.length + nsym);
  buf.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = buf[i];
    if (!coef) continue;
    const lc = LOG[coef];
    for (let j = 1; j < g.length; j++) if (g[j]) buf[i + j] ^= EXP[lc + LOG[g[j]]];
  }
  return buf.subarray(data.length);
}

// Syndromes S_i = msg(alpha^i), with a leading 0 pad (reedsolo convention,
// which the locator and Forney steps below follow). Null if all are zero.
function syndromes(msg, nsym) {
  const s = new Uint8Array(nsym + 1);
  let any = false;
  for (let i = 0; i < nsym; i++) {
    s[i + 1] = polyEval(msg, EXP[i]);
    if (s[i + 1]) any = true;
  }
  return any ? s : null;
}

// Berlekamp-Massey, seeded with the erasure locator: returns the errata
// locator (highest degree first) or null if uncorrectable.
function findErrataLocator(synd, nsym, erasureLoc, eraseCount) {
  let errLoc = erasureLoc ? Uint8Array.from(erasureLoc) : Uint8Array.of(1);
  let oldLoc = erasureLoc ? Uint8Array.from(erasureLoc) : Uint8Array.of(1);
  const shift = synd.length - nsym; // the leading pad
  for (let i = 0; i < nsym - eraseCount; i++) {
    const K = eraseCount + i + shift;
    let delta = synd[K];
    for (let j = 1; j < errLoc.length; j++) delta ^= mul(errLoc[errLoc.length - 1 - j], synd[K - j]);
    const shifted = new Uint8Array(oldLoc.length + 1);
    shifted.set(oldLoc);
    oldLoc = shifted;
    if (delta) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = polyScale(oldLoc, delta);
        oldLoc = polyScale(errLoc, inv(delta));
        errLoc = newLoc;
      }
      errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
    }
  }
  let k = 0;
  while (k < errLoc.length - 1 && errLoc[k] === 0) k++;
  errLoc = errLoc.subarray(k);
  const errs = errLoc.length - 1;
  if ((errs - eraseCount) * 2 + eraseCount > nsym) return null;
  return errLoc;
}

// Chien search: indices into msg of the errata, or null if the locator does
// not have exactly deg(locator) roots (uncorrectable).
function findErrors(errLoc, n) {
  const rev = Uint8Array.from(errLoc).reverse();
  const errs = errLoc.length - 1;
  const pos = [];
  for (let i = 0; i < n; i++) if (polyEval(rev, pow(2, i)) === 0) pos.push(n - 1 - i);
  return pos.length === errs ? pos : null;
}

// Locator for coefficient positions (exponents counted from the end).
function erasureLocator(coefPos) {
  let loc = Uint8Array.of(1);
  for (const p of coefPos) loc = polyMul(loc, polyAdd(Uint8Array.of(1), Uint8Array.of(pow(2, p), 0)));
  return loc;
}

// Forney: corrects msg in place at errPos (indices into msg).
function correctErrata(msg, synd, errPos) {
  const n = msg.length;
  const coefPos = errPos.map((p) => n - 1 - p);
  const errLoc = erasureLocator(coefPos);
  // Evaluator: (S(x) * Lambda(x)) mod x^deg(Lambda)+1, S reversed with its pad.
  const prod = polyMul(Uint8Array.from(synd).reverse(), errLoc);
  const omega = prod.subarray(prod.length - errLoc.length);
  const X = coefPos.map((p) => pow(2, p));
  for (let i = 0; i < X.length; i++) {
    const xiInv = inv(X[i]);
    let denom = 1;
    for (let j = 0; j < X.length; j++) if (j !== i) denom = mul(denom, 1 ^ mul(xiInv, X[j]));
    if (denom === 0) return false;
    const y = mul(X[i], polyEval(omega, xiInv)); // X_i^(1 - fcr), fcr = 0
    msg[errPos[i]] ^= div(y, denom);
  }
  return true;
}

// msg: Uint8Array codeword (data + parity), corrected in place on success.
// erasures: indices into msg known to be unreliable.
// Returns { ok, errors, erasures }: errors = symbols corrected in total.
export function rsDecode(msg, nsym, erasures = []) {
  const n = msg.length;
  if (erasures.length > nsym) return { ok: false, reason: 'too-many-erasures' };
  // Erased values are unknown; zero them (any value works, zero is conventional).
  for (const p of erasures) msg[p] = 0;
  let synd = syndromes(msg, nsym);
  if (!synd) return { ok: true, errors: 0, erasures: erasures.length };
  const erasureLoc = erasures.length ? erasureLocator(erasures.map((p) => n - 1 - p)) : null;
  const errLoc = findErrataLocator(synd, nsym, erasureLoc, erasures.length);
  if (!errLoc) return { ok: false, reason: 'too-many-errors' };
  const pos = findErrors(errLoc, n);
  if (!pos) return { ok: false, reason: 'locator-roots' };
  if (!correctErrata(msg, synd, pos)) return { ok: false, reason: 'forney' };
  synd = syndromes(msg, nsym);
  if (synd) return { ok: false, reason: 'residual-syndrome' };
  return { ok: true, errors: pos.length, erasures: erasures.length };
}
