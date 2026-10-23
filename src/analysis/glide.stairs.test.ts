/**
 * Stair steps versus vibrato on a glide (F5 / F6 of the Wave 1 review).
 *
 * A staircase and a vibrato on a siren are both a periodic stall at 4-9 Hz. Telling them apart is a
 * question of shape: vibrato is one sinusoid riding the glide (and, once its speed beats the siren's,
 * it must move the contour backward each cycle); a staircase has flat plateaus and never goes back.
 * These tests pin both directions of that call: staircases are flagged at any step rate, and vibrato at
 * any plausible speed and extent is not, whether the contour is built directly or comes out of the real
 * detector (synthesized audio -> Framer -> MPM).
 *
 * Where the two coincide (a short plateau followed by a ramp at 5-7 steps/s, which a vibrato of that
 * size and rhythm reproduces exactly) the module deliberately calls it vibrato; nothing here asserts
 * the other way for those.
 */
import { describe, expect, it } from 'vitest';
import type { TargetNote } from '../core/types';
import { analyzeTake } from '../exercises/analyze';
import { FOUNDATIONS_EXERCISES } from '../exercises/catalog/foundations';
import { evaluate } from '../exercises/evaluate';
import { realize } from '../exercises/transpose';
import type { ExerciseDef } from '../exercises/types';
import { analyzeGlide } from './glide';
import { makeTrack } from './fixtures';
import { trackFromAudio } from './core-test-helpers';
import { midiToHz } from '../core/music';
import { synthesize } from '../dsp/test-signals';
import type { AnalyzeContext } from './types';

const CTX: AnalyzeContext = { toleranceCents: 25, vibratoStyle: 'pop' };

/** Linear ramp from g.midi to g.toMidi over [start, end], holding either side. */
function ramp(g: TargetNote): (t: number) => number {
  const to = g.toMidi as number;
  return (t) => g.midi + (to - g.midi) * Math.min(1, Math.max(0, (t - g.start) / (g.end - g.start)));
}

function track(midi: (t: number) => number, opts: { duration: number; jitter?: number; seed?: number }) {
  return makeTrack({ duration: opts.duration, midi, jitterCents: opts.jitter ?? 6, seed: opts.seed ?? 1 });
}

/** A staircase over glide `g`: `rate` steps/s, each a flat plateau followed by a quick ramp of `rampMs` to the next level. */
function ramped(g: TargetNote, rate: number, rampMs: number, phaseSec = 0): (t: number) => number {
  const to = g.toMidi as number;
  const T = 1 / rate;
  const rampSec = Math.min(T, rampMs / 1000);
  const n = Math.round(rate * (g.end - g.start));
  return (t) => {
    const x = t - g.start - phaseSec;
    if (x < 0) return g.midi;
    const k = Math.floor(x / T);
    if (k >= n) return to;
    const lo = g.midi + ((to - g.midi) * k) / n;
    const hi = g.midi + ((to - g.midi) * (k + 1)) / n;
    const within = x - k * T;
    return within < T - rampSec ? lo : lo + (hi - lo) * ((within - (T - rampSec)) / rampSec);
  };
}

/** A smooth linear glide over `g` with vibrato (+/-`cents` at `hz`, starting phase `phi`) on top. */
function sirenWithVibrato(g: TargetNote, cents: number, hz: number, phi = 0): (t: number) => number {
  const base = ramp(g);
  return (t) => base(t) + (cents / 100) * Math.sin(2 * Math.PI * hz * t + phi);
}

const UP: TargetNote = { midi: 60, toMidi: 72, start: 0.3, end: 1.3 };
const DOWN: TargetNote = { midi: 72, toMidi: 60, start: 0.3, end: 1.3 };

describe('analyzeGlide: a staircase is stepped at any rate, not mistaken for vibrato (F5)', () => {
  // [steps per second, plateau ms]: 12 semitones in 1 s, so the ramp is (1000 / rate - plateau) ms.
  // Not listed: 5-7 steps/s with plateaus of 100 ms or less. A vibrato of that size and rhythm reproduces them exactly (see the file header).
  const cases: Array<[number, number]> = [[3, 250], [4, 100], [4, 150], [4, 200], [5, 150], [6, 133], [6, 150], [7, 120], [8, 100], [9, 75], [9, 90]];
  for (const g of [UP, DOWN]) {
    for (const [rate, plateau] of cases) {
      it(`${g === UP ? 'rising' : 'falling'}: ${rate} steps/s with ${plateau} ms plateaus is stair-stepped (3 noise seeds)`, () => {
        for (let seed = 1; seed <= 3; seed++) {
          const phase = seed === 2 ? 0.5 / rate : 0;
          const r = analyzeGlide(track(ramped(g, rate, 1000 / rate - plateau, phase), { duration: 1.9, seed }), g, CTX);
          expect(r.stairSteps, `seed ${seed}`).toBeGreaterThanOrEqual(2);
          expect(r.smoothness, `seed ${seed}`).toBeLessThan(0.5);
        }
      });
    }
  }

  it('keeps flagging a staircase as the detector noise goes from 3 c to 10 c', () => {
    for (const jitter of [3, 10]) {
      const r = analyzeGlide(track(ramped(UP, 5, 50), { duration: 1.9, jitter }), UP, CTX);
      expect(r.stairSteps, `jitter ${jitter}`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('analyzeGlide: vibrato on a siren is not stair-stepping, at any speed or extent (F6)', () => {
  // The catalog's sirens run 350-600 c/s; the grid goes from a very slow one to an octave per second.
  const speeds = [100, 200, 300, 400, 600, 800, 1200];
  const extents = [10, 15, 20, 25, 30, 40];
  for (const dir of ['rising', 'falling'] as const) {
    for (const speed of speeds) {
      it(`${dir} at ${speed} c/s: +/-10..40 c vibrato at 5-7 Hz leaves no stairs and a high smoothness`, () => {
        const dur = 1200 / speed;
        const g: TargetNote = dir === 'rising' ? { midi: 60, toMidi: 72, start: 0.3, end: 0.3 + dur } : { midi: 72, toMidi: 60, start: 0.3, end: 0.3 + dur };
        let worst = 1;
        let stairs = 0;
        let n = 0;
        for (const cents of extents) {
          for (let i = 0; i < 4; i++) {
            const hz = 5 + (2 * i) / 3;
            const r = analyzeGlide(track(sirenWithVibrato(g, cents, hz, 1.7 * i), { duration: dur + 0.9, seed: 10 + i }), g, CTX);
            worst = Math.min(worst, r.smoothness);
            stairs += r.stairSteps;
            n++;
          }
        }
        expect(n).toBe(24);
        expect(stairs).toBe(0);
        expect(worst).toBeGreaterThan(0.85);
      });
    }
  }

  it('+/-10..30 c vibrato on a 300-400 c/s siren (the speed range of the catalog) in 10 phases each', () => {
    for (const speed of [300, 350, 400]) {
      const dur = 1200 / speed;
      const g: TargetNote = { midi: 60, toMidi: 72, start: 0.3, end: 0.3 + dur };
      for (const cents of [10, 15, 20, 25, 30]) {
        for (let i = 0; i < 10; i++) {
          const hz = 5 + (2 * (i + 0.5)) / 10;
          const r = analyzeGlide(track(sirenWithVibrato(g, cents, hz, 2 * Math.PI * ((i * 0.381966) % 1)), { duration: dur + 0.9, seed: 20 + i }), g, CTX);
          expect(r.stairSteps, `${speed} c/s +/-${cents} c #${i}`).toBe(0);
          expect(r.smoothness, `${speed} c/s +/-${cents} c #${i}`).toBeGreaterThan(0.85);
        }
      }
    }
  });

  it('vibrato whose speed equals the siren speed (a stationary inflection every cycle) is still vibrato', () => {
    // +/-8 c at 5.5 Hz has a peak speed of 8 x 2 pi x 5.5 = 276 c/s, the speed of this 276 c/s siren.
    const dur = 1200 / 276;
    const g: TargetNote = { midi: 60, toMidi: 72, start: 0.3, end: 0.3 + dur };
    const r = analyzeGlide(track(sirenWithVibrato(g, 8, 5.5), { duration: dur + 0.9 }), g, CTX);
    expect(r.stairSteps).toBe(0);
    expect(r.smoothness).toBeGreaterThan(0.85);
  });

  it('vibrato with a drifting rate, a blooming extent and a little harmonic distortion is still vibrato', () => {
    const g: TargetNote = { midi: 60, toMidi: 72, start: 0.3, end: 2.3 };
    const base = ramp(g);
    const midi = (t: number): number => {
      const u = Math.min(1, Math.max(0, (t - g.start) / (g.end - g.start)));
      const phase = 2 * Math.PI * (5.2 * t + 0.4 * u * (t - g.start)); // rate drifts 5.2 -> 6 Hz
      const extent = 0.2 * (0.6 + 0.8 * u); // 12 -> 28 c
      return base(t) + extent * (Math.sin(phase) + 0.15 * Math.sin(2 * phase + 0.8));
    };
    const r = analyzeGlide(track(midi, { duration: 3.2 }), g, CTX);
    expect(r.stairSteps).toBe(0);
    expect(r.smoothness).toBeGreaterThan(0.85);
  });

  it('does not penalise a wide vibrato as a reversal either (the oscillation is taken out before backslide is measured)', () => {
    // A 5-semitone siren (tolerance max(60 c, 12% of 500 c) = 60 c) with +/-45 c vibrato at 5.5 Hz backslides ~80 c at its slow end.
    const g: TargetNote = { midi: 60, toMidi: 65, start: 0.3, end: 2.3 };
    const r = analyzeGlide(track(sirenWithVibrato(g, 45, 5.5), { duration: 3.0 }), g, CTX);
    expect(r.monotonic).toBe(true);
    expect(r.stairSteps).toBe(0);
    expect(r.smoothness).toBeGreaterThan(0.85);
  });

  it('a real reversal under the vibrato is still a reversal', () => {
    const g: TargetNote = { midi: 60, toMidi: 72, start: 0.3, end: 2.3 };
    const base = ramp(g);
    // slides back ~250 c once, over 0.2 s (the siren rises 120 c meanwhile): a net backslide of ~190 c that is not a vibrato-rate event
    const midi = (t: number): number => {
      const u = Math.min(1, Math.max(0, (t - g.start) / (g.end - g.start)));
      return base(t) - (u > 0.4 && u < 0.5 ? 2.5 * Math.sin(((u - 0.4) / 0.1) * Math.PI) : 0) + 0.2 * Math.sin(2 * Math.PI * 5.8 * t);
    };
    const r = analyzeGlide(track(midi, { duration: 3.0 }), g, CTX);
    expect(r.monotonic).toBe(false);
    expect(r.smoothness).toBeLessThan(0.85);
  });
});

describe('analyzeGlide: staircases and vibrato through the real detector (F5 / F6)', () => {
  // [steps per second, ramp ms]: the finding's own examples (250 ms + 50 ms ramps, 6/s with 40 ms ramps) among them.
  const staircases: Array<[number, number]> = [[3, 60], [4, 50], [5, 40], [6, 40], [4, 80]];
  // [semitones, seconds, +/- cents, Hz]: 350-600 c/s sirens (the catalog's) and a slow one.
  const sirens: Array<[number, number, number, number]> = [[7, 2, 25, 5.8], [12, 3, 30, 5.8], [12, 2, 15, 5.5], [12, 3, 40, 6.5], [12, 5, 20, 5.2]];

  for (const SR of [48000, 44100]) {
    for (const up of [true, false]) {
      const g: TargetNote = up ? { midi: 52, toMidi: 64, start: 0.5, end: 3.0 } : { midi: 64, toMidi: 52, start: 0.5, end: 3.0 };
      for (const [rate, rampMs] of staircases) {
        it(`${SR} Hz ${up ? 'rising' : 'falling'} octave siren sung as ${rate} steps/s with ${rampMs} ms ramps is stair-stepped`, () => {
          const mid = ramped(g, rate, rampMs);
          const audio = synthesize({ sampleRate: SR, duration: 3.6, f0: (t) => midiToHz(mid(t)) });
          const r = analyzeGlide(trackFromAudio(audio, SR), g, CTX);
          expect(r.stairSteps).toBeGreaterThanOrEqual(3);
          expect(r.smoothness).toBeLessThan(0.4);
        });
      }

      for (const [span, secs, cents, hz] of sirens) {
        it(`${SR} Hz ${up ? 'rising' : 'falling'} ${span}-semitone siren in ${secs} s with +/-${cents} c vibrato at ${hz} Hz is smooth`, () => {
          const sg: TargetNote = up ? { midi: 52, toMidi: 52 + span, start: 0.5, end: 0.5 + secs } : { midi: 52 + span, toMidi: 52, start: 0.5, end: 0.5 + secs };
          const mid = sirenWithVibrato(sg, cents, hz);
          const audio = synthesize({ sampleRate: SR, duration: secs + 1.2, f0: (t) => midiToHz(mid(t)) });
          const r = analyzeGlide(trackFromAudio(audio, SR), sg, CTX);
          expect(r.stairSteps).toBe(0);
          expect(r.smoothness).toBeGreaterThan(0.9);
          expect(r.monotonic).toBe(true);
        });
      }
    }
  }
});

describe('the real sirens through analyzeTake + evaluate (F5 / F6)', () => {
  const real = (def: ExerciseDef) => realize(def, null, 'tenor');
  const byId = (id: string) => FOUNDATIONS_EXERCISES.find((d) => d.id === id) as ExerciseDef;
  const SR = 48000;

  /** The pitch of `rz` as sung: its glides replaced by `glideAt(note)`, plain notes held, vibrato on top when asked. Take time 0 is the downbeat. */
  function pitchOf(rz: ReturnType<typeof real>, glideAt: (n: TargetNote) => (t: number) => number, vibrato?: { cents: number; hz: number }): (t: number) => number {
    const fns = rz.notes.map((n) => (n.toMidi !== undefined ? glideAt(n) : () => n.midi));
    return (t) => {
      const i = rz.notes.findIndex((n) => t >= n.start && t < n.end);
      return i < 0 ? Number.NaN : fns[i](t) + (vibrato ? (vibrato.cents / 100) * Math.sin(2 * Math.PI * vibrato.hz * t) : 0);
    };
  }
  /** That take as a contour with 6 c of jitter (the take starts 0.5 s before the downbeat) ... */
  const contourTake = (rz: ReturnType<typeof real>, midi: (t: number) => number) => makeTrack({ duration: rz.totalSec + 1, t0: -0.5, midi, jitterCents: 6, seed: 3 });
  /** ... or as synthesized audio decoded by the real detector. */
  const audioTake = (rz: ReturnType<typeof real>, midi: (t: number) => number) => {
    const lead = 0.5;
    const audio = synthesize({ sampleRate: SR, duration: rz.totalSec + 1, f0: (t) => (Number.isFinite(midi(t - lead)) ? midiToHz(midi(t - lead)) : Number.NaN) });
    return trackFromAudio(audio, SR).map((f) => ({ ...f, t: f.t - lead }));
  };

  it('foundations.audition.8 (one smooth octave siren), real detector: a staircase of 6 steps/s with 40 ms ramps no longer passes', () => {
    const def = byId('foundations.audition.8');
    const rz = real(def);
    const smooth = analyzeTake(def, rz, audioTake(rz, pitchOf(rz, (n) => ramp(n))), { vibratoStyle: 'pop' });
    expect(evaluate(def, smooth.metrics).passed).toBe(true);
    expect(smooth.metrics['glide.smoothness'] as number).toBeGreaterThan(0.9);

    for (const [rate, rampMs] of [[6, 40], [5, 40], [4, 50], [3, 50]] as const) {
      const steps = analyzeTake(def, rz, audioTake(rz, pitchOf(rz, (n) => ramped(n, rate, rampMs))), { vibratoStyle: 'pop' });
      expect(steps.details.glides.every((g) => g.result.stairSteps >= 3), `${rate}/s`).toBe(true);
      expect(steps.metrics['glide.smoothness'] as number, `${rate}/s`).toBeLessThan(0.3);
      expect(evaluate(def, steps.metrics).passed, `${rate}/s`).toBe(false);
    }
  });

  it('foundations.audition.8, contour: a staircase of 3 steps/s fails; a smooth siren passes', () => {
    const def = byId('foundations.audition.8');
    const rz = real(def);
    expect(evaluate(def, analyzeTake(def, rz, contourTake(rz, pitchOf(rz, (n) => ramp(n))), { vibratoStyle: 'pop' }).metrics).passed).toBe(true);
    const steps = analyzeTake(def, rz, contourTake(rz, pitchOf(rz, (n) => ramped(n, 3, 50))), { vibratoStyle: 'pop' });
    expect(steps.details.glides.every((g) => g.result.stairSteps >= 3)).toBe(true);
    expect(evaluate(def, steps.metrics).passed).toBe(false);
  });

  it('foundations.sirens.1: +/-25 c vibrato at 5.8 Hz on every glide is smooth, and the take passes (contour and real detector)', () => {
    const def = byId('foundations.sirens.1');
    const rz = real(def);
    for (const take of [contourTake(rz, pitchOf(rz, (n) => ramp(n), { cents: 25, hz: 5.8 })), audioTake(rz, pitchOf(rz, (n) => ramp(n), { cents: 25, hz: 5.8 }))]) {
      const a = analyzeTake(def, rz, take, { vibratoStyle: 'pop' });
      expect(a.details.glides.length).toBeGreaterThanOrEqual(5);
      for (const g of a.details.glides) {
        expect(g.result.stairSteps).toBe(0);
        expect(g.result.smoothness).toBeGreaterThan(0.9);
      }
      expect(a.metrics['glide.smoothness'] as number).toBeGreaterThan(0.9);
      expect(a.metrics['glide.cracks']).toBe(0);
      expect(evaluate(def, a.metrics).passed).toBe(true);
    }
  });

  it('foundations.sirens.1: a staircase siren fails the smoothness the level is about (contour 3 steps/s; real detector 5 steps/s)', () => {
    const def = byId('foundations.sirens.1');
    const rz = real(def);
    const contour = analyzeTake(def, rz, contourTake(rz, pitchOf(rz, (n) => ramped(n, 3, 50))), { vibratoStyle: 'pop' });
    expect(contour.metrics['glide.smoothness'] as number).toBeLessThan(0.3);
    expect(evaluate(def, contour.metrics).passed).toBe(false);
    const audio = analyzeTake(def, rz, audioTake(rz, pitchOf(rz, (n) => ramped(n, 5, 40))), { vibratoStyle: 'pop' });
    expect(audio.metrics['glide.smoothness'] as number).toBeLessThan(0.3);
    expect(evaluate(def, audio.metrics).passed).toBe(false);
  });
});
