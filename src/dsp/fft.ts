/**
 * Radix-2 FFT for power-of-two sizes, and a zero-allocation autocorrelator
 * built on it. This is the one FFT primitive the rest of `src/dsp` needs:
 * MPM's NSDF and YIN's FFT-based difference function both reduce to the
 * linear autocorrelation `r(tau)` of a (zero-padded) window.
 *
 * `FFT` precomputes its bit-reversal table and twiddle factors once per
 * size; `transform`/`inverseTransform` then run allocation-free, writing
 * in place into the caller's buffers. `Autocorrelator` wraps one `FFT` plus
 * its own scratch buffers (also preallocated) so `autocorrelate()` never
 * allocates either.
 */

/** Rounds `v` up to the next power of two (v itself if already one). */
function ceilPow2(v: number): number {
  let n = v - 1;
  n |= n >> 1;
  n |= n >> 2;
  n |= n >> 4;
  n |= n >> 8;
  n |= n >> 16;
  return n + 1;
}

/** Reverses the low `bits` bits of `x`. */
function reverseBits(x: number, bits: number): number {
  let r = 0;
  for (let i = 0; i < bits; i++) {
    r = (r << 1) | (x & 1);
    x >>= 1;
  }
  return r;
}

/**
 * In-place iterative Cooley-Tukey (decimation-in-time) FFT for a fixed
 * power-of-two size. `transform` is the forward DFT, `X[k] = sum_n x[n]
 * exp(-2*pi*i*k*n/N)`; `inverseTransform` is its normalised inverse
 * (divided by N), so `inverseTransform(transform(x)) === x` up to
 * floating-point error. Both take parallel real/imaginary `Float64Array`
 * buffers of length `size` and mutate them in place - no allocation after
 * construction.
 */
export class FFT {
  readonly size: number;
  private readonly bitReversal: Uint32Array;
  /** cosTable[i] = cos(2*pi*i/size), sinTable[i] = sin(2*pi*i/size), for i in [0, size/2). */
  private readonly cosTable: Float64Array;
  private readonly sinTable: Float64Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two >= 2, got ${size}`);
    }
    this.size = size;
    const levels = Math.log2(size);
    const bitReversal = new Uint32Array(size);
    for (let i = 0; i < size; i++) bitReversal[i] = reverseBits(i, levels);
    this.bitReversal = bitReversal;

    const half = size / 2;
    const cosTable = new Float64Array(half);
    const sinTable = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      const angle = (2 * Math.PI * i) / size;
      cosTable[i] = Math.cos(angle);
      sinTable[i] = Math.sin(angle);
    }
    this.cosTable = cosTable;
    this.sinTable = sinTable;
  }

  /** Forward DFT, in place. `re`/`im` must have length `this.size`. */
  transform(re: Float64Array, im: Float64Array): void {
    this.butterfly(re, im, -1);
  }

  /** Normalised inverse DFT, in place. `re`/`im` must have length `this.size`. */
  inverseTransform(re: Float64Array, im: Float64Array): void {
    this.butterfly(re, im, 1);
    const n = this.size;
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }

  /** Shared bit-reversal + butterfly pass. `sign` is -1 for forward, +1 for inverse (pre-normalisation). */
  private butterfly(re: Float64Array, im: Float64Array, sign: number): void {
    const n = this.size;
    const rev = this.bitReversal;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }

    const cos = this.cosTable;
    const sin = this.sinTable;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const tableStep = n / size;
      for (let start = 0; start < n; start += size) {
        let t = 0;
        for (let k = start; k < start + half; k++, t += tableStep) {
          const l = k + half;
          const wr = cos[t];
          const wi = sign * sin[t];
          const tr = re[l] * wr - im[l] * wi;
          const ti = re[l] * wi + im[l] * wr;
          re[l] = re[k] - tr;
          im[l] = im[k] - ti;
          re[k] += tr;
          im[k] += ti;
        }
      }
    }
  }
}

/**
 * Computes the linear autocorrelation of a window via the Wiener-Khinchin
 * theorem (FFT -> power spectrum -> inverse FFT), zero-padded to at least
 * twice the window size so the result is the *linear* autocorrelation
 * (no circular wrap-around) for every lag the caller can ask for.
 *
 * This is the same overall approach as the `pitchy` package's
 * `Autocorrelator` (github.com/ianprime0509/pitchy, MIT) - pad to a
 * power of two >= 2x the input length, transform, square the magnitude,
 * inverse-transform - credited here since MPM and this autocorrelator
 * are directly informed by reading its source. The difference is that
 * this one is built on the FFT above instead of `fft.js`, so the whole
 * detector stays a self-contained, dependency-free module suitable for
 * the AudioWorklet bundle.
 */
export class Autocorrelator {
  readonly windowSize: number;
  private readonly fft: FFT;
  private readonly re: Float64Array;
  private readonly im: Float64Array;

  constructor(windowSize: number) {
    if (windowSize < 1) throw new Error('windowSize must be >= 1');
    this.windowSize = windowSize;
    const fftSize = ceilPow2(2 * windowSize);
    this.fft = new FFT(fftSize);
    this.re = new Float64Array(fftSize);
    this.im = new Float64Array(fftSize);
  }

  /**
   * Writes `r(tau) = sum_{i=0}^{windowSize-tau-1} window[i] * window[i+tau]`
   * for `tau` in `[0, windowSize)` into `out` (length >= `windowSize`).
   * Zero allocation. `window` must have length `windowSize`.
   */
  autocorrelate(window: Float32Array | Float64Array, out: Float64Array): void {
    const { re, im, fft, windowSize } = this;
    const fftSize = fft.size;
    for (let i = 0; i < windowSize; i++) {
      re[i] = window[i];
      im[i] = 0;
    }
    for (let i = windowSize; i < fftSize; i++) {
      re[i] = 0;
      im[i] = 0;
    }

    fft.transform(re, im);
    for (let i = 0; i < fftSize; i++) {
      const power = re[i] * re[i] + im[i] * im[i];
      re[i] = power;
      im[i] = 0;
    }
    fft.inverseTransform(re, im);

    for (let i = 0; i < windowSize; i++) out[i] = re[i];
  }
}
