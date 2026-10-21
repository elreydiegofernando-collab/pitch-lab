import { describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import { centsBetweenHz } from '../core/music';
import { createDetector } from './detector';
import type { DetectResult } from './detector-types';
import { synthesize, vibratoContour } from './test-signals';

const { windowSize, minHz, maxHz, mpmK, yinThreshold } = CONFIG.audio;

describe('MPMDetector', () => {
  it('still returns the fundamental when it is weak and the 2nd/3rd harmonics are strong', () => {
    // A voice-like spectrum where the fundamental partial is weak (0.2) and the
    // 2nd and 3rd harmonics dominate (1, 0.8). Despite that, the *signal* is
    // still periodic at 1/f0 (any sum of integer harmonics of f0 is, whichever
    // of them are present), so the NSDF still has its global peak at the true
    // fundamental lag - this is MPM's headline advantage over naive
    // "loudest-partial" pitch tracking, and the whole reason k * nMax +
    // "first candidate above it" (rather than "tallest candidate") is the rule.
    for (const sampleRate of [44100, 48000] as const) {
      const det = createDetector('mpm', { sampleRate, windowSize, minHz, maxHz, mpmK, yinThreshold });
      const out: DetectResult = { f0Hz: NaN, confidence: 0 };
      const f0 = 196; // G3
      const window = synthesize({ sampleRate, duration: windowSize / sampleRate, f0, harmonics: [0.2, 1, 0.8] });
      det.detect(window, out);
      expect(out.f0Hz).not.toBeNaN();
      expect(Math.abs(centsBetweenHz(out.f0Hz, f0))).toBeLessThanOrEqual(3);
      expect(out.confidence).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('tracks 5.5 Hz +/-50c vibrato on 220 Hz within 8c RMS, recovering >= 85% of the extent', () => {
    // Detect every hop (512 samples @ 48 kHz, matching CONFIG.audio.hopSeconds)
    // across a 2-second vibrato tone, and compare each frame's f0 against the
    // TRUE instantaneous pitch at that window's centre (not the smoothed
    // display track - analyzers use the raw track, see docs/SPEC.md 8.3/8.7).
    const sampleRate = 48000;
    const hop = 512;
    const det = createDetector('mpm', { sampleRate, windowSize, minHz, maxHz, mpmK, yinThreshold });
    const out: DetectResult = { f0Hz: NaN, confidence: 0 };

    const baseHz = 220;
    const rateHz = 5.5;
    const extentCents = 50;
    const duration = 2;
    const contour = vibratoContour(baseHz, rateHz, extentCents);
    const signal = synthesize({ sampleRate, duration, f0: contour });

    let sumSqErr = 0;
    let frames = 0;
    const absDeviationFromBase: number[] = [];
    for (let center = windowSize; center + windowSize / 2 < signal.length; center += hop) {
      const window = signal.subarray(center - windowSize / 2, center - windowSize / 2 + windowSize);
      det.detect(window, out);
      if (Number.isNaN(out.f0Hz)) continue;
      const trueHz = contour(center / sampleRate);
      const err = centsBetweenHz(out.f0Hz, trueHz);
      sumSqErr += err * err;
      frames++;
      absDeviationFromBase.push(Math.abs(centsBetweenHz(out.f0Hz, baseHz)));
    }

    const rmsErrCents = Math.sqrt(sumSqErr / frames);
    // Half-extent estimate from the recovered track: the mean of its largest
    // decile of |deviation from base|, which approximates the vibrato peaks
    // without being dragged down by the many near-zero-crossing frames (the
    // same reasoning CONFIG.display's smoothing-acceptance comment uses).
    absDeviationFromBase.sort((a, b) => b - a);
    const topDecile = absDeviationFromBase.slice(0, Math.ceil(absDeviationFromBase.length * 0.1));
    const recoveredHalfExtent = topDecile.reduce((a, b) => a + b, 0) / topDecile.length;

    // Measured: frames ~182/182, RMS error ~2.6c, recovered half-extent ~46.3c
    // (92.6% of the true 50c) - the window (2048 samples ~= 2.37 vibrato
    // cycles) spans a meaningful fraction of one vibrato cycle, so some
    // averaging-down of the true peak deviation is expected and the 85% floor
    // the task sets already accounts for it; the measured value is comfortably
    // above that floor, not at it.
    expect(frames).toBeGreaterThan((signal.length - windowSize) / hop - 5);
    expect(rmsErrCents).toBeLessThanOrEqual(8);
    expect(recoveredHalfExtent).toBeGreaterThanOrEqual(0.85 * extentCents);
  });
});
