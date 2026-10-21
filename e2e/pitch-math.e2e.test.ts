/**
 * Sanity checks for the e2e suite's own analysis helpers, against a
 * synthetic track (no browser needed) rather than the real detector. If
 * these fail, a failure in pitch.e2e.test.ts or vibrato.e2e.test.ts means
 * the *test math* is wrong, not the app — worth knowing before debugging
 * the browser-driven tests.
 */
import { describe, expect, it } from 'vitest';
import type { PitchFrame } from '../src/core/types';
import {
  centsFromReference,
  detrend,
  estimateHalfExtent,
  estimateRateHz,
  frameRateOverWindow,
  median,
  voicedFrames,
} from './pitch-math';

function syntheticVibratoTrack(opts: {
  carrierHz: number;
  rateHz: number;
  depthCents: number;
  driftCents?: number;
  noiseCents?: number;
  fps?: number;
  durationSec?: number;
}) {
  const fps = opts.fps ?? 94;
  const n = Math.round((opts.durationSec ?? 10) * fps);
  const times: number[] = [];
  const cents: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / fps;
    const drift = (opts.driftCents ?? 0) * Math.sin(2 * Math.PI * 0.05 * t);
    const vib = opts.depthCents * Math.sin(2 * Math.PI * opts.rateHz * t);
    const noise = opts.noiseCents ? (Math.sin(i * 12.9898) * 43758.5453 % 1 - 0.5) * opts.noiseCents : 0;
    times.push(t);
    cents.push(drift + vib + noise);
  }
  return { times, cents };
}

describe('median', () => {
  it('averages the middle two for an even-length array', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it('returns the middle value for an odd-length array', () => {
    expect(median([5, 1, 3])).toBe(3);
  });
  it('is NaN for an empty array', () => {
    expect(median([])).toBeNaN();
  });
});

describe('centsFromReference', () => {
  it('is 0 at the reference and +1200 an octave up', () => {
    expect(centsFromReference(220, 220)).toBeCloseTo(0, 6);
    expect(centsFromReference(440, 220)).toBeCloseTo(1200, 6);
  });
});

describe('voicedFrames', () => {
  it('keeps only voiced frames with a finite f0', () => {
    const frames: PitchFrame[] = [
      { t: 0, f0Hz: 220, midi: 57, centsFromNearest: 0, confidence: 0.95, rmsDb: -20, voiced: true },
      { t: 0.01, f0Hz: NaN, midi: NaN, centsFromNearest: NaN, confidence: 0.1, rmsDb: -60, voiced: false },
      { t: 0.02, f0Hz: 221, midi: 57.1, centsFromNearest: 8, confidence: 0.9, rmsDb: -19, voiced: true },
    ];
    expect(voicedFrames(frames).map((f) => f.f0Hz)).toEqual([220, 221]);
  });
});

describe('frameRateOverWindow', () => {
  it('reports ~94 fps for an evenly spaced 94 Hz track', () => {
    const fps = 94;
    const frames: PitchFrame[] = Array.from({ length: fps * 3 }, (_, i) => ({
      t: i / fps,
      f0Hz: 220,
      midi: 57,
      centsFromNearest: 0,
      confidence: 1,
      rmsDb: -10,
      voiced: true,
    }));
    expect(frameRateOverWindow(frames, 2)).toBeCloseTo(fps, 0);
  });
  it('is 0 for fewer than two frames', () => {
    expect(frameRateOverWindow([], 2)).toBe(0);
  });
});

describe('detrend + estimateRateHz + estimateHalfExtent (vibrato recovery)', () => {
  it('recovers a clean 5.5 Hz / 50c vibrato from a drifting, noisy cents track', () => {
    const { times, cents } = syntheticVibratoTrack({
      carrierHz: 330,
      rateHz: 5.5,
      depthCents: 50,
      driftCents: 3,
      noiseCents: 1.5,
    });
    const dt = detrend(times, cents, 0.7);
    expect(estimateRateHz(times, dt)).toBeGreaterThan(5.4);
    expect(estimateRateHz(times, dt)).toBeLessThan(5.6);
    const halfExtent = estimateHalfExtent(dt);
    expect(halfExtent).toBeGreaterThan(38);
    expect(halfExtent).toBeLessThan(62);
  });

  it('removes a slow drift that would otherwise bias a naive peak-to-peak measurement', () => {
    const { times, cents } = syntheticVibratoTrack({ carrierHz: 330, rateHz: 6, depthCents: 40, driftCents: 25 });
    const dt = detrend(times, cents, 0.7);
    // The drift's own range (+/-25c) is wider than anything vibrato-sized;
    // after detrending its slow contribution should mostly be gone.
    const residualDriftiness = Math.max(...dt) - Math.min(...dt);
    expect(residualDriftiness).toBeLessThan(2 * 40 + 10);
  });
});
