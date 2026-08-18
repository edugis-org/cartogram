/**
 * Iterative in-place radix-2 complex FFT.
 *
 * Written here rather than pulled in as a dependency: the library ships with no
 * runtime dependencies, and this is the one piece of numerics the diffusion solver
 * cannot do without. It is validated against a naive O(n^2) DFT in the tests.
 */
export class Fft {
  readonly n: number;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Uint32Array;

  constructor(n: number) {
    if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`FFT size must be a power of two, got ${n}`);
    this.n = n;
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / n);
    }
    // Bit-reversal permutation table.
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  /** Forward transform, in place. `re` and `im` have length n. */
  transform(re: Float64Array, im: Float64Array): void {
    const { n, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i]!;
      if (j > i) {
        let t = re[i]!;
        re[i] = re[j]!;
        re[j] = t;
        t = im[i]!;
        im[i] = im[j]!;
        im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const wr = cos[k]!;
          const wi = sin[k]!;
          const tr = re[l]! * wr - im[l]! * wi;
          const ti = re[l]! * wi + im[l]! * wr;
          re[l] = re[j]! - tr;
          im[l] = im[j]! - ti;
          re[j]! += tr;
          im[j]! += ti;
        }
      }
    }
  }
}
