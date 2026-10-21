import { describe, expect, it } from 'vitest';
import { CONFIG } from '../../config';
import { createSmoother } from './smoother';

const FS = 1 / CONFIG.audio.hopSeconds; // ~93.75 Hz, matches the real engine's frame rate

function ampOf(values: number[]): number {
  return (Math.max(...values) - Math.min(...values)) / 2;
}
function stdOf(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
}

describe('createSmoother', () => {
  it('passes the first voiced sample straight through (no startup lerp from nothing)', () => {
    const sm = createSmoother(CONFIG.display.smoothing);
    expect(sm.update(60, 0, true)).toBeCloseTo(60, 9);
  });

  it('returns NaN and resets while unvoiced', () => {
    const sm = createSmoother(CONFIG.display.smoothing);
    sm.update(60, 0, true);
    expect(sm.update(NaN, 0.01, false)).toBeNaN();
  });

  it('starts fresh (no lerp-in from stale history) on the first voiced sample after a gap', () => {
    const sm = createSmoother(CONFIG.display.smoothing);
    sm.update(40, 0, true); // settle near 40
    for (let i = 1; i <= 10; i++) sm.update(40, i * CONFIG.audio.hopSeconds, true);
    sm.update(NaN, 11 * CONFIG.audio.hopSeconds, false); // gap
    const afterGap = sm.update(72, 12 * CONFIG.audio.hopSeconds, true); // big jump, new note
    expect(afterGap).toBeCloseTo(72, 9); // not dragged toward the pre-gap 40
  });

  it('median-of-3 rejects a single-frame octave-glitch spike without adding delay', () => {
    const sm = createSmoother(CONFIG.display.smoothing);
    const dt = CONFIG.audio.hopSeconds;
    sm.update(60, 0, true);
    sm.update(60, dt, true);
    const spiked = sm.update(72, 2 * dt, true); // one-frame glitch (+1 octave)
    // The median of {60, 60, 72} is 60: the spike is fully rejected, not just damped.
    expect(spiked).toBeCloseTo(60, 6);
    const recovered = sm.update(60, 3 * dt, true);
    expect(recovered).toBeCloseTo(60, 6);
  });

  /**
   * Acceptance targets from CONFIG.display.smoothing's doc comment: a 6 Hz
   * +/-50c vibrato keeps >= 80% displayed amplitude (the priority), and +/-5c
   * white jitter drops >= 1.8x. A first-order filter trades one against the
   * other; minCutoffHz was raised from 8 (73% / 2.1x) to meet the vibrato target.
   */
  it('retains >= 80% of a 6 Hz +/-50c vibrato', () => {
    const sm = createSmoother(CONFIG.display.smoothing);
    const freqHz = 6;
    const ampSemitones = 0.5; // +/-50 cents
    const durationSec = 3;
    const n = Math.round(durationSec * FS);
    const settled: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = i / FS;
      const raw = 60 + ampSemitones * Math.sin(2 * Math.PI * freqHz * t);
      const out = sm.update(raw, t, true);
      if (t > 1.0) settled.push(out); // after the filter has settled
    }
    const ratio = ampOf(settled) / ampSemitones;
    expect(ratio).toBeGreaterThanOrEqual(0.8);
  });

  it('reduces +/-5c white jitter by at least 1.8x', () => {
    const sm = createSmoother(CONFIG.display.smoothing);
    const n = Math.round(3 * FS);
    // Deterministic pseudo-random jitter (xorshift32) so the test is reproducible.
    let seed = 0x9e3779b9;
    function rand(): number {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0xffffffff;
    }
    const rawVals: number[] = [];
    const outVals: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = i / FS;
      const raw = 60 + (rand() * 2 - 1) * 0.05; // +/-5 cents = +/-0.05 semitone
      const out = sm.update(raw, t, true);
      if (t > 1.0) {
        rawVals.push(raw);
        outVals.push(out);
      }
    }
    const reduction = stdOf(rawVals) / stdOf(outVals);
    expect(reduction).toBeGreaterThanOrEqual(1.8);
  });
});
