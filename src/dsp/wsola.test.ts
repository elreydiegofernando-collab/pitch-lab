import { describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../config';
import { centsBetweenHz, midiToHz } from '../core/music';
import { createDetector } from './detector';
import type { DetectResult } from './detector-types';
import { glideContour, harmonicTone, notesContour, synthesize, vibratoContour, whiteNoise } from './test-signals';
import { WSOLA_MAX_RATE, WSOLA_MIN_RATE, WsolaStretcher, timeStretch } from './wsola';

// Signal synthesis and detector sweeps are CPU-heavy; give them room when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 60_000 });

const { windowSize, minHz, maxHz, mpmK, yinThreshold } = CONFIG.audio;
const HOP = 512;

interface F0Point {
  t: number;
  f0: number;
  confidence: number;
}

/** Run the in-house MPM detector over `signal` at the production hop. */
function f0Contour(signal: Float32Array, sampleRate: number): F0Point[] {
  const det = createDetector('mpm', { sampleRate, windowSize, minHz, maxHz, mpmK, yinThreshold });
  const out: DetectResult = { f0Hz: NaN, confidence: 0 };
  const points: F0Point[] = [];
  for (let c = windowSize / 2; c + windowSize / 2 <= signal.length; c += HOP) {
    det.detect(signal.subarray(c - windowSize / 2, c + windowSize / 2), out);
    points.push({ t: c / sampleRate, f0: out.f0Hz, confidence: out.confidence });
  }
  return points;
}

/** Frames away from the (legitimately imperfect) first and last window. */
const interior = (points: F0Point[], totalSec: number, marginSec = 0.25): F0Point[] =>
  points.filter((p) => p.t > marginSec && p.t < totalSec - marginSec);

function maxAbsStep(signal: Float32Array, from = 0, to = signal.length): number {
  let m = 0;
  for (let i = Math.max(1, from); i < Math.min(signal.length, to); i++) m = Math.max(m, Math.abs(signal[i] - signal[i - 1]));
  return m;
}

function rmsOf(signal: Float32Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += signal[i] * signal[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

/** Largest |difference| over the common length. */
function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  let m = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

describe('timeStretch: duration', () => {
  const sr = 48000;
  const x = harmonicTone(sr, 2, 220);

  it('scales duration by 1 / rate: 0.5x is twice as long, 0.75x is 4/3 as long', () => {
    expect(timeStretch(x, sr, 0.5).length).toBe(x.length * 2);
    expect(timeStretch(x, sr, 0.75).length).toBe(Math.round(x.length / 0.75));
    expect(timeStretch(x, sr, 0.9).length).toBe(Math.round(x.length / 0.9));
    expect(timeStretch(x, sr, 1.5).length).toBe(Math.round(x.length / 1.5));
  });

  it('also holds at 44.1 kHz and for lengths that are not a multiple of the hop', () => {
    const y44 = harmonicTone(44100, 1.2345, 330);
    expect(timeStretch(y44, 44100, 0.5).length).toBe(Math.round(y44.length / 0.5));
    expect(timeStretch(y44, 44100, 0.75).length).toBe(Math.round(y44.length / 0.75));
    const odd = harmonicTone(sr, 0.7777, 196);
    expect(timeStretch(odd, sr, 0.6).length).toBe(Math.round(odd.length / 0.6));
  });

  it('rate 1 returns an equal copy, not the same array', () => {
    const y = timeStretch(x, sr, 1);
    expect(y).not.toBe(x);
    expect(y.length).toBe(x.length);
    expect(maxAbsDiff(x, y)).toBe(0);
  });

  it('clamps rates outside the supported range, and the stretcher reports the rate it used', () => {
    expect(WSOLA_MIN_RATE).toBeLessThanOrEqual(0.5);
    expect(WSOLA_MAX_RATE).toBeGreaterThanOrEqual(1.5);
    const tiny = harmonicTone(sr, 0.3, 220);
    const slow = new WsolaStretcher(tiny, sr, 0.01);
    expect(slow.rate).toBe(WSOLA_MIN_RATE);
    expect(slow.outputLength).toBe(Math.round(tiny.length / WSOLA_MIN_RATE));
    expect(new WsolaStretcher(tiny, sr, 9).rate).toBe(WSOLA_MAX_RATE);
    expect(new WsolaStretcher(tiny, sr, 0.5).rate).toBe(0.5);
  });

  it('rejects nonsense arguments', () => {
    const tiny = new Float32Array(100);
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(() => timeStretch(tiny, 48000, bad)).toThrow(RangeError);
      expect(() => timeStretch(tiny, bad, 0.5)).toThrow(RangeError);
    }
  });
});

describe('timeStretch: pitch is preserved', () => {
  // The spec bar is +/-5 cents. Measured worst cases are under ~2.5 cents even at E2, so this has real headroom.
  for (const sr of [48000, 44100]) {
    for (const f0 of [110, 220, 440]) {
      for (const rate of [0.5, 0.75]) {
        it(`${f0} Hz harmonic tone at ${rate}x, ${sr} Hz: every frame within +/-5 cents`, () => {
          const x = harmonicTone(sr, 3, f0);
          const y = timeStretch(x, sr, rate);
          const frames = interior(f0Contour(y, sr), y.length / sr);
          expect(frames.length).toBeGreaterThan(100);
          let worst = 0;
          for (const p of frames) worst = Math.max(worst, Math.abs(centsBetweenHz(p.f0, f0)));
          expect(worst).toBeLessThanOrEqual(5); // NaN (undetected) also fails this
          const sorted = frames.map((p) => Math.abs(centsBetweenHz(p.f0, f0))).sort((a, b) => a - b);
          expect(sorted[sorted.length >> 1]).toBeLessThan(1.5); // median
        });
      }
    }
  }

  it('works at other device sample rates too (22.05, 32, 88.2, 96 kHz)', () => {
    for (const sr of [22050, 32000, 88200, 96000]) {
      const x = harmonicTone(sr, 2.5, 247);
      const y = timeStretch(x, sr, 0.6);
      expect(y.length).toBe(Math.round(x.length / 0.6));
      expect(y.every((v) => Number.isFinite(v))).toBe(true);
      // The detector's window is a fixed 2048 samples, so measure in 2048-sample frames at this rate.
      const det = createDetector('mpm', { sampleRate: sr, windowSize, minHz, maxHz, mpmK, yinThreshold });
      const out: DetectResult = { f0Hz: NaN, confidence: 0 };
      let frames = 0;
      for (let c = Math.round(0.4 * sr); c + windowSize / 2 < y.length - Math.round(0.4 * sr); c += 512) {
        det.detect(y.subarray(c - windowSize / 2, c + windowSize / 2), out);
        frames++;
        expect(Math.abs(centsBetweenHz(out.f0Hz, 247)), `${sr} Hz`).toBeLessThanOrEqual(5);
      }
      expect(frames).toBeGreaterThan(20);
    }
  });

  it('keeps the lowest and highest singing notes (E2, C6) in tune', () => {
    const sr = 48000;
    for (const midi of [40, 84]) {
      const f0 = midiToHz(midi);
      const y = timeStretch(harmonicTone(sr, 3, f0), sr, 0.5);
      for (const p of interior(f0Contour(y, sr), y.length / sr)) {
        expect(Math.abs(centsBetweenHz(p.f0, f0))).toBeLessThanOrEqual(5);
      }
    }
  });

  it('keeps a speeding-up pitch (rate > 1) in tune as well', () => {
    const sr = 48000;
    const y = timeStretch(harmonicTone(sr, 3, 262), sr, 1.5);
    for (const p of interior(f0Contour(y, sr), y.length / sr)) {
      expect(Math.abs(centsBetweenHz(p.f0, 262))).toBeLessThanOrEqual(5);
    }
  });
});

describe('timeStretch: vibrato and glides are slowed, not re-pitched', () => {
  const sr = 48000;

  it('5.5 Hz +/-40 c vibrato at 0.5x: same centre pitch and extent, half the rate', () => {
    const base = 220;
    const x = synthesize({ sampleRate: sr, duration: 4, f0: vibratoContour(base, 5.5, 40) });
    const y = timeStretch(x, sr, 0.5);
    const frames = interior(f0Contour(y, sr), y.length / sr, 0.3);
    const cents = frames.map((p) => centsBetweenHz(p.f0, base));
    const mean = cents.reduce((a, b) => a + b, 0) / cents.length;
    const peak = Math.max(...cents.map((c) => Math.abs(c - mean)));
    expect(Math.abs(mean)).toBeLessThan(5); //            centre pitch unchanged
    expect(peak).toBeGreaterThan(0.85 * 40); //           extent kept (the detector window smooths a little)
    expect(peak).toBeLessThan(46);
    // Upward zero crossings of the detrended contour per second = vibrato rate.
    let crossings = 0;
    for (let i = 1; i < cents.length; i++) if (cents[i - 1] - mean < 0 && cents[i] - mean >= 0) crossings++;
    const rate = crossings / (frames[frames.length - 1].t - frames[0].t);
    expect(rate).toBeGreaterThan(2.75 * 0.85);
    expect(rate).toBeLessThan(2.75 * 1.15);
  });

  it('a siren glide follows the original contour, time-scaled', () => {
    const contour = glideContour(200, 400, 0.5, 2.5);
    const x = synthesize({ sampleRate: sr, duration: 3, f0: contour });
    for (const rate of [0.5, 0.75]) {
      const y = timeStretch(x, sr, rate);
      for (const p of interior(f0Contour(y, sr), y.length / sr, 0.3)) {
        // Output time t came from input time t * rate; the glide must be there to within ~10 cents.
        expect(Math.abs(centsBetweenHz(p.f0, contour(p.t * rate)))).toBeLessThan(10);
      }
    }
  });

  it('twelve notes a second stay distinct when slowed', () => {
    const midis = [60, 64, 67, 72, 67, 64, 60, 62, 65, 69, 65, 62];
    const noteSec = 1 / 12;
    const spans = midis.map((midi, i) => ({ midi, start: 0.5 + i * noteSec, end: 0.5 + (i + 1) * noteSec }));
    const x = synthesize({ sampleRate: sr, duration: 0.5 + midis.length * noteSec + 0.5, f0: notesContour(spans), amp: 0.5 });
    for (const rate of [0.5, 0.75]) {
      const frames = f0Contour(timeStretch(x, sr, rate), sr);
      let on = 0;
      let total = 0;
      for (const s of spans) {
        const a = s.start / rate;
        const b = s.end / rate;
        for (const p of frames.filter((q) => q.t > a + 0.15 * (b - a) && q.t < b - 0.15 * (b - a))) {
          total++;
          if (Math.abs(centsBetweenHz(p.f0, midiToHz(s.midi))) < 30) on++;
        }
      }
      expect(total).toBeGreaterThan(40);
      expect(on / total).toBeGreaterThanOrEqual(0.95);
    }
  });

  it('a noisy voice-like tone keeps its centre pitch and vibrato extent', () => {
    const base = 196;
    const x = synthesize({
      sampleRate: sr,
      duration: 6,
      f0: vibratoContour(base, 5.5, 45),
      amp: (t) => 0.4 * (0.7 + 0.3 * Math.sin(t * 3.3)),
      harmonics: [1, 0.7, 0.5, 0.35, 0.2, 0.15, 0.1, 0.06, 0.04],
      noiseDb: -32,
    });
    const y = timeStretch(x, sr, 0.5);
    const cents = interior(f0Contour(y, sr), y.length / sr, 0.3)
      .filter((p) => p.confidence > 0.8)
      .map((p) => centsBetweenHz(p.f0, base));
    expect(cents.length).toBeGreaterThan(500);
    const mean = cents.reduce((a, b) => a + b, 0) / cents.length;
    expect(Math.abs(mean)).toBeLessThan(5);
    expect(Math.max(...cents.map((c) => Math.abs(c - mean)))).toBeLessThan(45 * 1.15);
  });
});

describe('timeStretch: no clicks at window joins', () => {
  const sr = 48000;

  it('never produces a sample-to-sample jump larger than the input already has', () => {
    const signals: Array<[string, Float32Array]> = [
      ['220 Hz tone', harmonicTone(sr, 3, 220)],
      ['880 Hz tone', harmonicTone(sr, 3, 880, undefined, 0.8)],
      [
        'noisy vibrato voice',
        synthesize({ sampleRate: sr, duration: 4, f0: vibratoContour(247, 5.8, 40), amp: 0.4, noiseDb: -30, harmonics: [1, 0.6, 0.4, 0.3, 0.2, 0.1] }),
      ],
      ['broadband noise', whiteNoise(sr, 2, -12)],
    ];
    for (const [name, x] of signals) {
      for (const rate of [0.5, 0.75]) {
        const y = timeStretch(x, sr, rate);
        const inStep = maxAbsStep(x);
        const outStep = maxAbsStep(y, 2000, y.length - 2000);
        expect(outStep, `${name} at ${rate}x`).toBeLessThanOrEqual(inStep * 1.05);
      }
    }
  });

  it('keeps a steady tone at a steady level (no cancellation dips where windows are joined)', () => {
    // 240 Hz at 48 kHz is exactly 200 samples per period, so a two-period RMS window is exactly constant for a perfect stretch.
    const x = harmonicTone(sr, 4, 240);
    const reference = rmsOf(x, 8000, 16000);
    for (const rate of [0.5, 0.75]) {
      const y = timeStretch(x, sr, rate);
      let lo = Infinity;
      let hi = 0;
      for (let i = 12000; i + 400 < y.length - 12000; i += 400) {
        const r = rmsOf(y, i, i + 400);
        lo = Math.min(lo, r);
        hi = Math.max(hi, r);
      }
      expect(20 * Math.log10(hi / lo)).toBeLessThan(0.5);
      expect(Math.abs(20 * Math.log10(((hi + lo) / 2) / reference))).toBeLessThan(0.3);
    }
  });

  it('a hop-by-hop check around every join: the signal is as smooth there as anywhere', () => {
    const x = harmonicTone(sr, 3, 262);
    const y = timeStretch(x, sr, 0.5);
    const hop = Math.round(0.04 * sr * 0.5); // the window hop (N / 2)
    const inStep = maxAbsStep(x);
    for (let j = 3; (j + 3) * hop < y.length; j++) {
      expect(maxAbsStep(y, j * hop - 6, j * hop + 6)).toBeLessThanOrEqual(inStep * 1.05);
    }
  });
});

describe('timeStretch: level, timing and edge cases', () => {
  const sr = 48000;

  it('preserves loudness', () => {
    const x = harmonicTone(sr, 4, 261.63, undefined, 0.3);
    for (const rate of [0.5, 0.75, 1.5]) {
      const y = timeStretch(x, sr, rate);
      const a = rmsOf(x, Math.round(x.length * 0.2), Math.round(x.length * 0.8));
      const b = rmsOf(y, Math.round(y.length * 0.2), Math.round(y.length * 0.8));
      expect(Math.abs(20 * Math.log10(b / a))).toBeLessThan(0.1);
    }
  });

  it('puts a note onset at 1 / rate of its original time, to within 25 ms', () => {
    const x = synthesize({ sampleRate: sr, duration: 3, f0: (t) => (t >= 1 && t < 2 ? 220 : NaN), amp: 0.5 });
    const block = Math.round(0.002 * sr);
    for (const rate of [0.5, 0.75]) {
      const y = timeStretch(x, sr, rate);
      const env: number[] = [];
      for (let i = 0; i + block <= y.length; i += block) env.push(rmsOf(y, i, i + block));
      const thr = 0.1 * Math.max(...env);
      const first = env.findIndex((v) => v > thr) * 0.002;
      expect(Math.abs(first - 1 / rate)).toBeLessThan(0.025);
      let last = 0;
      env.forEach((v, i) => {
        if (v > thr) last = (i + 1) * 0.002;
      });
      expect(Math.abs(last - 2 / rate)).toBeLessThan(0.025);
    }
  });

  it('at rate 1 the window machinery reconstructs the input exactly (checks the overlap-add indexing)', () => {
    const x = synthesize({ sampleRate: sr, duration: 1.5, f0: vibratoContour(300, 5, 30), amp: 0.5, noiseDb: -40 });
    const s = new WsolaStretcher(x, sr, 1);
    s.process();
    expect(s.output.length).toBe(x.length);
    expect(maxAbsDiff(s.output, x)).toBeLessThan(1e-5);
  });

  it('turns silence into silence and a constant into the same constant', () => {
    const quiet = timeStretch(new Float32Array(48000), sr, 0.5);
    expect(quiet.length).toBe(96000);
    expect(quiet.every((v) => v === 0)).toBe(true);
    const dc = timeStretch(new Float32Array(48000).fill(0.3), sr, 0.6);
    for (let i = 2000; i < dc.length - 2000; i++) expect(Math.abs(dc[i] - 0.3)).toBeLessThan(1e-5);
  });

  it('copes with empty and tiny inputs at every rate', () => {
    for (const n of [0, 1, 2, 10, 100, 1000, 3000]) {
      const tiny = harmonicTone(sr, n / sr, 220);
      for (const rate of [0.25, 0.5, 0.75, 1, 1.7, 2]) {
        const y = timeStretch(tiny, sr, rate);
        expect(y.length).toBe(rate === 1 ? n : Math.round(n / rate));
        expect(y.every((v) => Number.isFinite(v))).toBe(true);
      }
    }
  });

  it('does not modify its input and is deterministic', () => {
    const x = synthesize({ sampleRate: sr, duration: 1, f0: vibratoContour(220, 5, 30), noiseDb: -35 });
    const copy = x.slice();
    const a = timeStretch(x, sr, 0.5);
    const b = timeStretch(x, sr, 0.5);
    expect(maxAbsDiff(x, copy)).toBe(0);
    expect(maxAbsDiff(a, b)).toBe(0);
  });
});

describe('WsolaStretcher: sliced processing', () => {
  const sr = 48000;
  const x = synthesize({ sampleRate: sr, duration: 1.3, f0: vibratoContour(330, 5.5, 35), noiseDb: -40 });

  it('produces exactly the one-shot result however the work is sliced, and reports progress', () => {
    const whole = timeStretch(x, sr, 0.6);
    for (const slice of [1, 7, 50]) {
      const s = new WsolaStretcher(x, sr, 0.6);
      expect(s.done).toBe(false);
      expect(s.progress).toBe(0);
      let last = 0;
      let calls = 0;
      while (!s.process(slice)) {
        calls++;
        expect(s.progress).toBeGreaterThan(last);
        expect(s.progress).toBeLessThan(1);
        last = s.progress;
      }
      expect(calls).toBeGreaterThan(0);
      expect(s.done).toBe(true);
      expect(s.progress).toBe(1);
      expect(maxAbsDiff(s.output, whole)).toBe(0);
      expect(s.process()).toBe(true); // already finished: a no-op
    }
  });

  it('an empty input is immediately done', () => {
    const s = new WsolaStretcher(new Float32Array(0), sr, 0.5);
    expect(s.done).toBe(true);
    expect(s.progress).toBe(1);
    expect(s.output.length).toBe(0);
  });
});

describe('timeStretch: speed', () => {
  it('stretches 60 s of audio at 0.5x in well under a second', () => {
    const sr = 48000;
    const notes = [196, 220, 247, 262, 294, 330, 294, 262];
    const x = synthesize({
      sampleRate: sr,
      duration: 60,
      f0: (t) => vibratoContour(notes[Math.floor(t / 1.5) % notes.length], 5.8, 35)(t),
      amp: (t) => 0.5 * (0.6 + 0.4 * Math.sin(t * 2.1)),
      noiseDb: -50,
    });
    timeStretch(x.subarray(0, sr * 5), sr, 0.5); // warm the JIT so the timing below is the steady state
    const times: number[] = [];
    for (const rate of [0.5, 0.5, 0.5, 0.75]) {
      const t0 = performance.now();
      const y = timeStretch(x, sr, rate);
      times.push(performance.now() - t0);
      expect(y.length).toBe(Math.round(x.length / rate));
    }
    const best05 = Math.min(times[0], times[1], times[2]);
    console.info(`wsola 60 s @ 48 kHz: 0.5x best ${best05.toFixed(0)} ms (runs ${times.slice(0, 3).map((t) => t.toFixed(0)).join('/')}), 0.75x ${times[3].toFixed(0)} ms`);
    // Typically ~0.2 s on a desktop core. The bound is loose on purpose: CI boxes and parallel test workers are noisy.
    expect(best05).toBeLessThan(2500);
  });
});
