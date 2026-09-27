import { describe, expect, it } from 'vitest';
import { datan, datan2, dcos, dexp, dhypot, dlog, dpow, dsin } from '../src/sim/dmath';

/** Pseudo-random but fixed inputs. */
function inputs(n: number, lo: number, hi: number): number[] {
  let s = 12345;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out.push(lo + (s / 2147483648) * (hi - lo));
  }
  return out;
}

const close = (a: number, b: number, rel = 4e-16, abs = 4e-16) => Math.abs(a - b) <= Math.max(abs, rel * Math.abs(b));

describe('deterministic math matches Math.* to ~1 ulp', () => {
  it('sin / cos over battle-sized angles', () => {
    for (const x of [...inputs(20000, -50, 50), ...inputs(2000, -4000, 4000), 0, 1e-12, Math.PI / 2, Math.PI, -Math.PI, 7 * Math.PI / 4]) {
      expect(close(dsin(x), Math.sin(x), 4e-16, 1e-15), `sin(${x})`).toBe(true);
      expect(close(dcos(x), Math.cos(x), 4e-16, 1e-15), `cos(${x})`).toBe(true);
    }
  });
  it('atan / atan2 in every quadrant', () => {
    for (const x of inputs(20000, -1000, 1000)) expect(close(datan(x), Math.atan(x)), `atan(${x})`).toBe(true);
    const ys = inputs(5000, -300, 300);
    const xs = inputs(5000, -300, 300).reverse();
    for (let i = 0; i < ys.length; i++) expect(close(datan2(ys[i], xs[i]), Math.atan2(ys[i], xs[i])), `atan2(${ys[i]}, ${xs[i]})`).toBe(true);
    for (const [y, x] of [[0, 1], [0, -1], [1, 0], [-1, 0], [0, 0], [3, 3], [-3, -3]]) expect(close(datan2(y, x), Math.atan2(y, x))).toBe(true);
  });
  it('exp / log / pow', () => {
    for (const x of inputs(20000, -60, 60)) expect(close(dexp(x), Math.exp(x), 6e-16), `exp(${x})`).toBe(true);
    for (const x of [...inputs(20000, 1e-6, 1e6), 1, 2, 0.5, 1e-300, 1e300]) expect(close(dlog(x), Math.log(x), 6e-16, 6e-16), `log(${x})`).toBe(true);
    for (const x of inputs(5000, 0, 1)) expect(close(dpow(x, 1.2), Math.pow(x, 1.2), 4e-15, 4e-16), `pow(${x}, 1.2)`).toBe(true);
    expect(dexp(0)).toBe(1);
    expect(dpow(0, 1.2)).toBe(0);
  });
  it('hypot', () => {
    const a = inputs(5000, -500, 500);
    for (let i = 1; i < a.length; i++) expect(close(dhypot(a[i - 1], a[i]), Math.hypot(a[i - 1], a[i]), 5e-16)).toBe(true);
  });
});
