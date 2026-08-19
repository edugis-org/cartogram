import { Fft } from './fft.ts';

/**
 * Discrete cosine transforms, types II and III, on a power-of-two grid.
 *
 * The diffusion solver needs these because the heat equation with Neumann (no-flux)
 * boundaries diagonalizes in the cosine basis: a density field expanded in cosines
 * evolves by simply multiplying each coefficient by exp(-k^2 t). That turns "diffuse
 * for time t" into one multiplication per coefficient, at any t, with no time
 * stepping of the PDE at all -- which is what makes the flow-based method fast.
 *
 * No-flux boundaries are also physically what a map needs: mass must not leak out of
 * the map's bounding box.
 *
 * Both transforms are computed through an FFT of a symmetric extension of length 2N.
 * That costs a factor of two over a specialized DCT and is far easier to get right;
 * the tests check both against direct evaluation of the defining sums.
 */
export class Dct {
  readonly n: number;
  private readonly fft: Fft;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly cosHalf: Float64Array;
  private readonly sinHalf: Float64Array;

  constructor(n: number) {
    this.n = n;
    this.fft = new Fft(2 * n);
    this.re = new Float64Array(2 * n);
    this.im = new Float64Array(2 * n);
    // e^{-i pi k / (2N)} twiddles shared by both directions.
    this.cosHalf = new Float64Array(n + 1);
    this.sinHalf = new Float64Array(n + 1);
    for (let k = 0; k <= n; k++) {
      this.cosHalf[k] = Math.cos((-Math.PI * k) / (2 * n));
      this.sinHalf[k] = Math.sin((-Math.PI * k) / (2 * n));
    }
  }

  /**
   * DCT-II: X[k] = sum_n x[n] cos(pi k (n + 1/2) / N).
   * Operates on `data[offset + i * stride]`, in place.
   */
  forward(data: Float64Array, offset: number, stride: number): void {
    const { n, re, im } = this;
    // Even extension: y[i] = x[i], y[2N-1-i] = x[i].
    for (let i = 0; i < n; i++) {
      const v = data[offset + i * stride]!;
      re[i] = v;
      re[2 * n - 1 - i] = v;
      im[i] = 0;
      im[2 * n - 1 - i] = 0;
    }
    this.fft.transform(re, im);
    for (let k = 0; k < n; k++) {
      // X[k] = Re(Y[k] * e^{-i pi k / (2N)}) / 2, since the extension doubles the sum.
      data[offset + k * stride] =
        (re[k]! * this.cosHalf[k]! - im[k]! * this.sinHalf[k]!) / 2;
    }
  }

  /**
   * Sine counterpart of `inverse`: y[i] = (2/N) sum_{k>=1} Y[k] sin(pi k (i+1/2)/N).
   * The k = 0 coefficient has no sine component and is ignored.
   */
  inverseSine(data: Float64Array, offset: number, stride: number): void {
    const { n, re, im } = this;
    // Odd symmetry, Z[2N-k] = -conj(Z[k]), makes the transform purely imaginary; the
    // sine series is that imaginary part.
    re.fill(0);
    im.fill(0);
    for (let k = 1; k < n; k++) {
      const y = data[offset + k * stride]!;
      const c = this.cosHalf[k]!;
      const s = -this.sinHalf[k]!; // e^{+i pi k / (2N)}
      const vr = y * c;
      const vi = y * s;
      re[k] = vr;
      im[k] = vi;
      re[2 * n - k] = -vr;
      im[2 * n - k] = vi;
    }
    // Inverse via conjugation: ifft(z) = conj(fft(conj(z))), so the imaginary part of
    // the inverse is the negated imaginary part of the forward transform.
    for (let i = 0; i < 2 * n; i++) im[i] = -im[i]!;
    this.fft.transform(re, im);
    for (let i = 0; i < n; i++) data[offset + i * stride] = -im[i]! / n;
  }

  /**
   * DCT-III, the inverse of DCT-II up to scale:
   * x[n] = (X[0] + 2 sum_{k>=1} X[k] cos(pi k (n + 1/2) / N)) / N.
   */
  inverse(data: Float64Array, offset: number, stride: number): void {
    const { n, re, im } = this;
    // Build the spectrum whose inverse transform is the even extension of the
    // samples: Z[k] = X[k] e^{+i pi k / (2N)} for k < N, Z[N] = 0, and
    // Z[2N-k] = conj(Z[k]) so that the result is real.
    re.fill(0);
    im.fill(0);
    re[0] = data[offset]!;
    for (let k = 1; k < n; k++) {
      const x = data[offset + k * stride]!;
      const c = this.cosHalf[k]!;
      const s = -this.sinHalf[k]!; // e^{+i pi k / (2N)}
      const vr = x * c;
      const vi = x * s;
      re[k] = vr;
      im[k] = vi;
      re[2 * n - k] = vr;
      im[2 * n - k] = -vi;
    }
    // Inverse FFT via conjugation: ifft(z) = conj(fft(conj(z))) / M.
    for (let i = 0; i < 2 * n; i++) im[i] = -im[i]!;
    this.fft.transform(re, im);
    for (let i = 0; i < n; i++) {
      data[offset + i * stride] = re[i]! / n;
    }
  }
}

/**
 * Sine reconstruction: y[i] = (2/N) * sum_{k>=1} Y[k] sin(pi k (i + 1/2) / N).
 *
 * The cosine basis diagonalizes the diffusion, so the density is a cosine series; its
 * derivative is therefore a *sine* series, and this is what evaluates it. That gives
 * the velocity field analytically instead of by differencing the reconstructed density
 * on the grid.
 *
 * Same 2N FFT as the cosine transforms, with the opposite spectral symmetry: the
 * odd extension makes the result purely imaginary, and the sine series is its
 * imaginary part.
 */
export function inverseSine(dct: Dct, data: Float64Array, offset: number, stride: number): void {
  dct.inverseSine(data, offset, stride);
}

/** Direct evaluation of DCT-II, for validating the fast path. O(n^2). */
export function naiveDctII(x: Float64Array): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += x[i]! * Math.cos((Math.PI * k * (i + 0.5)) / n);
    out[k] = sum;
  }
  return out;
}

/** Direct evaluation of DCT-III, for validating the fast path. O(n^2). */
export function naiveDctIII(x: Float64Array): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = x[0]!;
    for (let k = 1; k < n; k++) sum += 2 * x[k]! * Math.cos((Math.PI * k * (i + 0.5)) / n);
    out[i] = sum / n;
  }
  return out;
}

/** Direct evaluation of the sine reconstruction, for validating the fast path. */
export function naiveInverseSine(x: Float64Array): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = 1; k < n; k++) sum += 2 * x[k]! * Math.sin((Math.PI * k * (i + 0.5)) / n);
    out[i] = sum / n;
  }
  return out;
}

/** 2D DCT-II over a row-major nx by ny grid, in place. */
export function dct2Forward(grid: Float64Array, nx: number, ny: number, dctX: Dct, dctY: Dct): void {
  for (let y = 0; y < ny; y++) dctX.forward(grid, y * nx, 1);
  for (let x = 0; x < nx; x++) dctY.forward(grid, x, nx);
}

/** 2D DCT-III over a row-major nx by ny grid, in place. */
export function dct2Inverse(grid: Float64Array, nx: number, ny: number, dctX: Dct, dctY: Dct): void {
  for (let x = 0; x < nx; x++) dctY.inverse(grid, x, nx);
  for (let y = 0; y < ny; y++) dctX.inverse(grid, y * nx, 1);
}

/**
 * Mixed 2D inverse: sine along one axis, cosine along the other. This is what a
 * partial derivative of a cosine series looks like — sine in the direction
 * differentiated, cosine in the other.
 */
export function dct2InverseMixed(
  grid: Float64Array,
  nx: number,
  ny: number,
  dctX: Dct,
  dctY: Dct,
  sineAxis: 'x' | 'y',
): void {
  for (let x = 0; x < nx; x++) {
    if (sineAxis === 'y') dctY.inverseSine(grid, x, nx);
    else dctY.inverse(grid, x, nx);
  }
  for (let y = 0; y < ny; y++) {
    if (sineAxis === 'x') dctX.inverseSine(grid, y * nx, 1);
    else dctX.inverse(grid, y * nx, 1);
  }
}
