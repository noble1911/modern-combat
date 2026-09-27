/**
 * Deterministic transcendental functions for the simulation.
 *
 * Multiplayer runs the same battle in every player's browser (lockstep), so the simulation must
 * produce bit-identical results everywhere. JavaScript's `+ − × ÷` and `Math.sqrt` are exactly
 * rounded IEEE-754 operations, identical on every engine and CPU; `Math.sin`, `Math.exp` and friends
 * are not (engines are free to differ in the last bit, and Safari uses the platform's libm).
 * These are the classic fdlibm/FreeBSD algorithms, written with only exact operations, so they
 * agree with `Math.*` to within about 1 ulp and agree with themselves everywhere.
 */

const scratch = new DataView(new ArrayBuffer(8));

/** 2^k exactly, for integer k in [-1022, 1023]. */
function pow2(k: number): number {
  scratch.setUint32(0, ((k + 1023) & 0x7ff) << 20);
  scratch.setUint32(4, 0);
  return scratch.getFloat64(0);
}

// ------------------------------------------------------------------ sin / cos
const PIO2_1 = 1.5707963267341256e0; // first 33 bits of pi/2
const PIO2_2 = 6.077100506303966e-11;
const PIO2_2T = 2.0222662487959506e-21;
const INV_PIO2 = 6.366197723675814e-1;

const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;
const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.08757232129817482790e-9;
const C6 = -1.13596475577881948265e-11;

/** sin on [-pi/4, pi/4], with y the tail of x. */
function kSin(x: number, y: number): number {
  const z = x * x;
  const w = z * z;
  const r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6);
  const v = z * x;
  return x - ((z * (0.5 * y - v * r) - y) - v * S1);
}

/** cos on [-pi/4, pi/4], with y the tail of x. */
function kCos(x: number, y: number): number {
  const z = x * x;
  let w = z * z;
  const r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6));
  const hz = 0.5 * z;
  w = 1 - hz;
  return w + (((1 - w) - hz) + (z * r - x * y));
}

let redHi = 0;
let redLo = 0;
/** Cody–Waite reduction of x by pi/2 (fine for the angles a battle sees): quadrant, remainder in redHi+redLo. */
function reduce(x: number): number {
  const n = Math.round(x * INV_PIO2);
  // x - n·pi/2 with pi/2 split into three parts (33 + 33 + 53 bits), exact enough near multiples
  const t = x - n * PIO2_1;
  let w = n * PIO2_2;
  const r = t - w;
  w = n * PIO2_2T - ((t - r) - w);
  redHi = r - w;
  redLo = (r - redHi) - w;
  return n;
}

export function dsin(x: number): number {
  if (Math.abs(x) <= 0.7853981633974483) return kSin(x, 0);
  if (!Number.isFinite(x)) return NaN;
  const n = reduce(x);
  switch (n & 3) {
    case 0:
      return kSin(redHi, redLo);
    case 1:
      return kCos(redHi, redLo);
    case 2:
      return -kSin(redHi, redLo);
    default:
      return -kCos(redHi, redLo);
  }
}

export function dcos(x: number): number {
  if (Math.abs(x) <= 0.7853981633974483) return kCos(x, 0);
  if (!Number.isFinite(x)) return NaN;
  const n = reduce(x);
  switch (n & 3) {
    case 0:
      return kCos(redHi, redLo);
    case 1:
      return -kSin(redHi, redLo);
    case 2:
      return -kCos(redHi, redLo);
    default:
      return kSin(redHi, redLo);
  }
}

// ------------------------------------------------------------------ atan / atan2
const ATAN_HI = [4.63647609000806093515e-1, 7.85398163397448278999e-1, 9.82793723247329054082e-1, 1.57079632679489655800e0];
const ATAN_LO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const AT = [
  3.33333333333329318027e-1, -1.99999999998764832476e-1, 1.42857142725034663711e-1, -1.11111104054623557880e-1,
  9.09088713343650656196e-2, -7.69187620504482999495e-2, 6.66107313738753120669e-2, -5.83357013379057348645e-2,
  4.97687799461593236017e-2, -3.65315727442169155270e-2, 1.62858201153657823623e-2,
];

export function datan(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const neg = x < 0;
  let ax = Math.abs(x);
  if (ax >= 7.37869762948382064640e19) return neg ? -1.5707963267948966 : 1.5707963267948966;
  let id: number;
  if (ax < 0.4375) {
    if (ax < 3.725290298461914e-9) return x;
    id = -1;
  } else if (ax < 1.1875) {
    if (ax < 0.6875) {
      id = 0;
      ax = (2 * ax - 1) / (2 + ax);
    } else {
      id = 1;
      ax = (ax - 1) / (ax + 1);
    }
  } else if (ax < 2.4375) {
    id = 2;
    ax = (ax - 1.5) / (1 + 1.5 * ax);
  } else {
    id = 3;
    ax = -1 / ax;
  }
  const z = ax * ax;
  const w = z * z;
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  if (id < 0) {
    const r = ax - ax * (s1 + s2);
    return neg ? -r : r;
  }
  const r = ATAN_HI[id] - ((ax * (s1 + s2) - ATAN_LO[id]) - ax);
  return neg ? -r : r;
}

const PI = 3.141592653589793;
const PI_LO = 1.2246467991473532e-16;

export function datan2(y: number, x: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  if (x === 0) return y > 0 ? PI / 2 : y < 0 ? -PI / 2 : x >= 0 && 1 / x > 0 ? y : 1 / y < 0 ? -PI : PI;
  if (y === 0) return x > 0 ? y : 1 / y < 0 ? -PI : PI;
  const t = datan(Math.abs(y / x));
  if (x > 0) return y >= 0 ? t : -t;
  const r = PI - (t - PI_LO);
  return y >= 0 ? r : -r;
}

// ------------------------------------------------------------------ exp / log / pow
const LN2_HI = 6.93147180369123816490e-1;
const LN2_LO = 1.90821492927058770002e-10;
const INV_LN2 = 1.44269504088896338700e0;
const P1 = 1.66666666666666019037e-1;
const P2 = -2.77777777770155933842e-3;
const P3 = 6.61375632143793436117e-5;
const P4 = -1.65339022054652515390e-6;
const P5 = 4.13813679705723846039e-8;

export function dexp(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x > 709.782712893384) return Infinity;
  if (x < -745.1332191019411) return 0;
  const ax = Math.abs(x);
  let k = 0;
  let hi = 0;
  let lo = 0;
  if (ax > 0.34657359027997264) {
    if (ax < 1.0397207708399179) {
      k = x < 0 ? -1 : 1;
      hi = x - k * LN2_HI;
      lo = k * LN2_LO;
    } else {
      k = Math.trunc(INV_LN2 * x + (x < 0 ? -0.5 : 0.5));
      hi = x - k * LN2_HI;
      lo = k * LN2_LO;
    }
    x = hi - lo;
  } else if (ax < 3.725290298461914e-9) {
    return 1 + x;
  }
  const t = x * x;
  const c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k === 0) return 1 - ((x * c) / (c - 2) - x);
  const y = 1 - ((lo - (x * c) / (2 - c)) - hi);
  // scale by 2^k in two steps so subnormal/overflowing k stay in range
  if (k < -1021) return y * pow2(k + 1000) * pow2(-1000);
  if (k > 1023) return y * pow2(k - 1000) * pow2(1000);
  return y * pow2(k);
}

/** Natural log for x > 0: x = m·2^e with m in [√½, √2), then a fast atanh series on m. */
export function dlog(x: number): number {
  if (Number.isNaN(x) || x < 0) return NaN;
  if (x === 0) return -Infinity;
  if (x === Infinity) return Infinity;
  let e = 0;
  if (x < 2.2250738585072014e-308) {
    x *= 18014398509481984; // 2^54: lift subnormals into the normal range
    e = -54;
  }
  scratch.setFloat64(0, x);
  const hiWord = scratch.getUint32(0);
  e += ((hiWord >>> 20) & 0x7ff) - 1023;
  // mantissa in [1, 2)
  scratch.setUint32(0, (hiWord & 0x800fffff) | 0x3ff00000);
  let m = scratch.getFloat64(0);
  if (m > 1.4142135623730951) {
    m *= 0.5;
    e += 1;
  }
  const s = (m - 1) / (m + 1);
  const s2 = s * s;
  // 2·atanh(s) = 2(s + s³/3 + s⁵/5 + …), |s| < 0.1716: 13 terms reach double precision
  let term = s;
  let sum = s;
  for (let k = 3; k <= 27; k += 2) {
    term *= s2;
    sum += term / k;
  }
  return e * LN2_HI + (2 * sum + e * LN2_LO);
}

/** x^y for x > 0 (and the trivial cases); the simulation only raises positive bases. */
export function dpow(x: number, y: number): number {
  if (y === 0) return 1;
  if (x === 1) return 1;
  if (x === 0) return y > 0 ? 0 : Infinity;
  if (x < 0) return NaN;
  return dexp(y * dlog(x));
}

/** √(Σ aᵢ²): sqrt is exactly rounded, unlike Math.hypot (whose algorithm varies by engine). */
export function dhypot(a: number, b: number, c = 0): number {
  return Math.sqrt(a * a + b * b + c * c);
}
