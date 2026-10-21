import { describe, expect, it } from 'vitest';
import { Autocorrelator, FFT } from './fft';
import { seededRandom } from './test-signals';

/** O(N^2) reference: r(tau) = sum_{i=0}^{N-tau-1} x[i]*x[i+tau]. */
function naiveAutocorrelate(x: Float64Array): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  for (let tau = 0; tau < n; tau++) {
    let sum = 0;
    for (let i = 0; i + tau < n; i++) sum += x[i] * x[i + tau];
    out[tau] = sum;
  }
  return out;
}

describe('FFT', () => {
  it('rejects non-power-of-two or too-small sizes', () => {
    expect(() => new FFT(0)).toThrow();
    expect(() => new FFT(1)).toThrow();
    expect(() => new FFT(3)).toThrow();
    expect(() => new FFT(100)).toThrow();
  });

  it('round-trips forward + inverse back to the original signal', () => {
    const rng = seededRandom(1);
    for (const size of [2, 8, 16, 64, 256, 1024, 4096]) {
      const fft = new FFT(size);
      const re = new Float64Array(size);
      const im = new Float64Array(size);
      for (let i = 0; i < size; i++) re[i] = rng() * 2 - 1;
      const original = re.slice();
      fft.transform(re, im);
      fft.inverseTransform(re, im);
      for (let i = 0; i < size; i++) {
        expect(re[i]).toBeCloseTo(original[i], 9);
        expect(im[i]).toBeCloseTo(0, 9);
      }
    }
  });
});

describe('Autocorrelator', () => {
  it('matches a naive O(N^2) reference on random input at several sizes', () => {
    const rng = seededRandom(42);
    for (const windowSize of [1, 2, 7, 32, 100, 513, 2048]) {
      const x = new Float64Array(windowSize);
      for (let i = 0; i < windowSize; i++) x[i] = rng() * 2 - 1;
      const ac = new Autocorrelator(windowSize);
      const out = new Float64Array(windowSize);
      ac.autocorrelate(x, out);
      const expected = naiveAutocorrelate(x);
      for (let tau = 0; tau < windowSize; tau++) {
        expect(out[tau], `windowSize=${windowSize} tau=${tau}`).toBeCloseTo(expected[tau], 6);
      }
    }
  });

  it('reuses its internal buffers correctly across many calls on the same instance', () => {
    const windowSize = 256;
    const ac = new Autocorrelator(windowSize);
    const out = new Float64Array(windowSize);
    const rng = seededRandom(7);
    for (let call = 0; call < 50; call++) {
      const x = new Float64Array(windowSize);
      for (let i = 0; i < windowSize; i++) x[i] = rng() * 2 - 1;
      ac.autocorrelate(x, out);
      const expected = naiveAutocorrelate(x);
      expect(out[0]).toBeCloseTo(expected[0], 6);
      expect(out[windowSize - 1]).toBeCloseTo(expected[windowSize - 1], 6);
      expect(out[windowSize >> 1]).toBeCloseTo(expected[windowSize >> 1], 6);
    }
  });

  it('accepts Float32Array input directly', () => {
    const windowSize = 64;
    const rng = seededRandom(5);
    const x32 = new Float32Array(windowSize);
    for (let i = 0; i < windowSize; i++) x32[i] = rng() * 2 - 1;
    const x64 = Float64Array.from(x32); // same values the detectors see after float32 -> float64 widening
    const ac = new Autocorrelator(windowSize);
    const out = new Float64Array(windowSize);
    ac.autocorrelate(x32, out);
    const expected = naiveAutocorrelate(x64);
    for (let tau = 0; tau < windowSize; tau++) {
      expect(out[tau]).toBeCloseTo(expected[tau], 4);
    }
  });
});
