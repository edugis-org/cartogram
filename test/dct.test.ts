import { describe, expect, it } from 'vitest';
import { Fft } from '../src/methods/diffusion/fft.ts';
import { Dct, naiveDctII, naiveDctIII, dct2Forward, dct2Inverse } from '../src/methods/diffusion/dct.ts';

function naiveDft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    for (let t = 0; t < n; t++) {
      const a = (-2 * Math.PI * k * t) / n;
      outRe[k]! += re[t]! * Math.cos(a) - im[t]! * Math.sin(a);
      outIm[k]! += re[t]! * Math.sin(a) + im[t]! * Math.cos(a);
    }
  }
  return { re: outRe, im: outIm };
}

const random = (n: number, seed = 1) => {
  // Deterministic pseudo-random input; the transforms must be exact, not lucky.
  let s = seed;
  return Float64Array.from({ length: n }, () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648 - 0.5;
  });
};

describe('FFT', () => {
  it('matches a direct DFT', () => {
    for (const n of [2, 8, 64]) {
      const re = random(n, 7);
      const im = random(n, 13);
      const expected = naiveDft(re, im);
      const gotRe = Float64Array.from(re);
      const gotIm = Float64Array.from(im);
      new Fft(n).transform(gotRe, gotIm);
      for (let k = 0; k < n; k++) {
        expect(gotRe[k]).toBeCloseTo(expected.re[k]!, 9);
        expect(gotIm[k]).toBeCloseTo(expected.im[k]!, 9);
      }
    }
  });

  it('rejects non-power-of-two sizes rather than returning nonsense', () => {
    expect(() => new Fft(12)).toThrow(/power of two/);
  });
});

describe('DCT', () => {
  it('DCT-II matches the defining sum', () => {
    for (const n of [4, 16, 128]) {
      const x = random(n, 3);
      const expected = naiveDctII(x);
      const got = Float64Array.from(x);
      new Dct(n).forward(got, 0, 1);
      for (let k = 0; k < n; k++) expect(got[k]).toBeCloseTo(expected[k]!, 8);
    }
  });

  it('DCT-III matches the defining sum', () => {
    for (const n of [4, 16, 128]) {
      const x = random(n, 5);
      const expected = naiveDctIII(x);
      const got = Float64Array.from(x);
      new Dct(n).inverse(got, 0, 1);
      for (let i = 0; i < n; i++) expect(got[i]).toBeCloseTo(expected[i]!, 8);
    }
  });

  it('round-trips exactly', () => {
    const n = 64;
    const x = random(n, 11);
    const got = Float64Array.from(x);
    const dct = new Dct(n);
    dct.forward(got, 0, 1);
    dct.inverse(got, 0, 1);
    for (let i = 0; i < n; i++) expect(got[i]).toBeCloseTo(x[i]!, 10);
  });

  it('works on strided data, so 2D transforms can run over columns', () => {
    const n = 8;
    const grid = new Float64Array(n * n);
    const col = random(n, 17);
    for (let i = 0; i < n; i++) grid[i * n + 3] = col[i]!;
    const dct = new Dct(n);
    dct.forward(grid, 3, n);
    const expected = naiveDctII(col);
    for (let k = 0; k < n; k++) expect(grid[k * n + 3]).toBeCloseTo(expected[k]!, 8);
  });

  it('2D transform round-trips', () => {
    const nx = 16;
    const ny = 8;
    const grid = random(nx * ny, 23);
    const original = Float64Array.from(grid);
    const dctX = new Dct(nx);
    const dctY = new Dct(ny);
    dct2Forward(grid, nx, ny, dctX, dctY);
    dct2Inverse(grid, nx, ny, dctX, dctY);
    for (let i = 0; i < grid.length; i++) expect(grid[i]).toBeCloseTo(original[i]!, 9);
  });

  it('diffuses a step function towards uniform, conserving mass', () => {
    // The property the whole method rests on: multiplying cosine coefficients by
    // exp(-k^2 t) must solve the heat equation with no-flux boundaries, which
    // conserves total mass and flattens any initial field.
    const n = 64;
    const grid = new Float64Array(n);
    for (let i = 0; i < n; i++) grid[i] = i < n / 2 ? 2 : 0;
    const mass0 = grid.reduce((a, b) => a + b, 0);

    const dct = new Dct(n);
    dct.forward(grid, 0, 1);
    // Relaxation time of the slowest mode is (N/pi)^2, about 415 cells^2 here, so a
    // time of 50 barely blurs the step: it must be several relaxation times to flatten.
    const t = 5000;
    for (let k = 0; k < n; k++) {
      const kx = (Math.PI * k) / n;
      grid[k]! *= Math.exp(-kx * kx * t);
    }
    dct.inverse(grid, 0, 1);

    const mass1 = grid.reduce((a, b) => a + b, 0);
    expect(mass1).toBeCloseTo(mass0, 6);
    const min = Math.min(...grid);
    const max = Math.max(...grid);
    expect(max - min).toBeLessThan(0.2); // nearly uniform
  });
});
