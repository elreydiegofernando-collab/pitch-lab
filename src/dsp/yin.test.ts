import { describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import { centsBetweenHz } from '../core/music';
import { createDetector } from './detector';
import type { DetectResult } from './detector-types';
import { sine, synthesize, vibratoContour } from './test-signals';

const { windowSize, minHz, maxHz, mpmK, yinThreshold } = CONFIG.audio;

describe('YINDetector', () => {
  it('tracks 5.5 Hz +/-50c vibrato on 220 Hz within 8c RMS, recovering >= 85% of the extent', () => {
    // Same measurement as mpm.test.ts's vibrato test, same bounds: YIN's
    // FFT-based difference function is driven by the same autocorrelation
    // primitive as MPM, so it tracks a clean vibrato tone just as well in
    // practice (measured ~2.6c RMS, ~46.3c recovered half-extent here - all
    // but identical to MPM's numbers on this signal).
    const sampleRate = 48000;
    const hop = 512;
    const det = createDetector('yin', { sampleRate, windowSize, minHz, maxHz, mpmK, yinThreshold });
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
    absDeviationFromBase.sort((a, b) => b - a);
    const topDecile = absDeviationFromBase.slice(0, Math.ceil(absDeviationFromBase.length * 0.1));
    const recoveredHalfExtent = topDecile.reduce((a, b) => a + b, 0) / topDecile.length;

    expect(frames).toBeGreaterThan((signal.length - windowSize) / hop - 5);
    expect(rmsErrCents).toBeLessThanOrEqual(8);
    expect(recoveredHalfExtent).toBeGreaterThanOrEqual(0.85 * extentCents);
  });

  it('falls back to the global minimum (with low confidence) when nothing drops under yinThreshold', () => {
    // de Cheveigne & Kawahara: "if no local minimum is found [under the
    // threshold], ... take the global minimum" and report it with its (low)
    // confidence, rather than refusing to answer. A 50 Hz sine at 48 kHz has
    // no periodicity match inside this config's bounded search range (its
    // true period lies beyond maxLag), so it exercises exactly that path -
    // unlike MPM, which has no such fallback and returns NaN outright for the
    // same input (see detector.test.ts). The number returned here is not a
    // usable pitch (CONFIG.audio.minConfidence gates it out downstream); this
    // test's job is only to confirm the fallback behaves as specified, not to
    // treat its output as a real detection.
    const sampleRate = 48000;
    const det = createDetector('yin', { sampleRate, windowSize, minHz, maxHz, mpmK, yinThreshold });
    const out: DetectResult = { f0Hz: NaN, confidence: 0 };
    det.detect(sine(sampleRate, windowSize / sampleRate, 50), out);
    expect(out.f0Hz).not.toBeNaN();
    expect(out.f0Hz).toBeGreaterThanOrEqual(minHz);
    expect(out.f0Hz).toBeLessThanOrEqual(maxHz);
    expect(out.confidence).toBeLessThan(CONFIG.audio.minConfidence);
  });
});
