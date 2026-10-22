/**
 * A hole in the middle of one phonation is a break however long it is (F4 of the Wave 1 review).
 *
 * detectCracks reads a long silence as a pause (a breath between glides) by default, which is right
 * for a whole take or a live buffer. A glide, or a phrase of continuous singing, is continuous by
 * construction: for those the caller passes `maxDropoutMs: Infinity`, and a 0.4 s hole must not score
 * better than a 0.12 s one. Silence before the voice starts or after it stops is never a break.
 */
import { describe, expect, it } from 'vitest';
import type { PitchFrame, TargetNote } from '../core/types';
import { CONFIG } from '../config';
import { analyzeTake } from '../exercises/analyze';
import { FOUNDATIONS_EXERCISES } from '../exercises/catalog/foundations';
import { evaluate } from '../exercises/evaluate';
import { realize } from '../exercises/transpose';
import type { ExerciseDef } from '../exercises/types';
import { detectCracks } from './cracks';
import { analyzeGlide } from './glide';
import { framesInWindow } from './track';
import { makeTrack } from './fixtures';
import { sungContour } from './advanced-test-helpers';
import { trackFromAudio } from './core-test-helpers';
import { midiToHz } from '../core/music';
import { synthesize } from '../dsp/test-signals';
import type { AnalyzeContext } from './types';

const CTX: AnalyzeContext = { toleranceCents: 25, vibratoStyle: 'pop' };
const HOLES = [0.12, 0.25, 0.4, 0.6, 1.0];

describe('detectCracks: maxDropoutMs', () => {
  const siren = (holeAt: number, holeSec: number) => makeTrack({ duration: 3, midi: (t) => (t >= holeAt && t < holeAt + holeSec ? NaN : 48 + 12 * (t / 3)), jitterCents: 6 });

  it('by default reads a hole longer than 300 ms as a pause (a whole take has rests), and a shorter one as a break', () => {
    expect(detectCracks(siren(1, 0.25))).toHaveLength(1);
    for (const hole of [0.4, 0.6, 1.0]) expect(detectCracks(siren(1, hole))).toEqual([]);
  });

  for (const hole of HOLES) {
    it(`with maxDropoutMs: Infinity a ${hole} s hole mid-siren is one dropout of that length`, () => {
      const events = detectCracks(siren(1, hole), { maxDropoutMs: Infinity });
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('dropout');
      expect(events[0].t).toBeGreaterThan(0.95);
      expect(events[0].t).toBeLessThan(1.05);
      expect(Math.abs(events[0].durationMs - hole * 1000)).toBeLessThan(30);
    });
  }

  it('leading and trailing silence is never a dropout, however long, even with maxDropoutMs: Infinity', () => {
    const track = makeTrack({ duration: 4, midi: (t) => (t >= 1.5 && t < 2.5 ? 60 + t : NaN) });
    expect(detectCracks(track, { maxDropoutMs: Infinity })).toEqual([]);
  });

  it('a custom limit applies: 500 ms flags a 0.4 s hole but not a 0.6 s one', () => {
    expect(detectCracks(siren(1, 0.4), { maxDropoutMs: 500 })).toHaveLength(1);
    expect(detectCracks(siren(1, 0.6), { maxDropoutMs: 500 })).toEqual([]);
  });

  it('two separate long holes are two events', () => {
    const track = makeTrack({ duration: 4, midi: (t) => ((t >= 1 && t < 1.5) || (t >= 2.5 && t < 3.2) ? NaN : 48 + 12 * (t / 4)) });
    expect(detectCracks(track, { maxDropoutMs: Infinity })).toHaveLength(2);
  });

  it('a long hole that returns at another pitch carries the discontinuity', () => {
    const track = makeTrack({ duration: 3, midi: (t) => (t >= 1 && t < 1.6 ? NaN : t < 1 ? 60 : 64) });
    const [e] = detectCracks(track, { maxDropoutMs: Infinity });
    expect(e.kind).toBe('dropout');
    expect(e.cents ?? 0).toBeGreaterThan(300);
  });

  it('keeps the contract signature: callable with just a track', () => {
    expect(detectCracks(siren(1, 0.12))).toHaveLength(1);
  });
});

describe('analyzeGlide: a hole of any length inside a glide is a break', () => {
  const g: TargetNote = { midi: 60, toMidi: 72, start: 0.3, end: 2.3 };
  const withHole = (holeSec: number) => makeTrack({
    duration: 3,
    midi: (t) => (t >= 1.2 && t < 1.2 + holeSec ? NaN : 60 + 12 * Math.min(1, Math.max(0, (t - 0.3) / 2))),
    jitterCents: 6,
  });

  it('a clean 2 s glide has no cracks', () => {
    expect(analyzeGlide(withHole(0), g, CTX).cracks).toEqual([]);
  });

  for (const hole of [0.12, 0.29, 0.32, 0.5, 0.8, 1.0]) {
    it(`reports a ${hole} s hole as exactly one dropout of about that length`, () => {
      const r = analyzeGlide(withHole(hole), g, CTX);
      expect(r.cracks).toHaveLength(1);
      expect(r.cracks[0].kind).toBe('dropout');
      expect(Math.abs(r.cracks[0].durationMs - hole * 1000)).toBeLessThan(30);
    });
  }

  it('does not report the rest after a glide that stops early (trailing silence)', () => {
    const r = analyzeGlide(makeTrack({ duration: 3, midi: (t) => (t < 1.5 ? 60 + 12 * ((t - 0.3) / 2) : NaN), jitterCents: 6 }), g, CTX);
    expect(r.cracks).toEqual([]);
  });
});

describe('a phrase of continuous singing: its span is checked with maxDropoutMs: Infinity', () => {
  it('a 0.6 s hole inside one phrase is a crack; the breath between two phrases is not (they are separate spans)', () => {
    const take = makeTrack({ duration: 8, midi: (t) => ((t >= 2.0 && t < 2.6) || (t >= 4 && t < 5) ? NaN : 55 + 3 * Math.sin(t)), jitterCents: 6 });
    const phraseA = framesInWindow(take, 0.2, 3.9);
    const phraseB = framesInWindow(take, 5.0, 7.5);
    expect(detectCracks(phraseA, { maxDropoutMs: Infinity })).toHaveLength(1);
    expect(detectCracks(phraseB, { maxDropoutMs: Infinity })).toEqual([]);
  });
});

describe('the real sirens: a long hole costs score, however long (contour and real detector)', () => {
  const real = (def: ExerciseDef) => realize(def, null, 'tenor');
  const byId = (id: string) => FOUNDATIONS_EXERCISES.find((d) => d.id === id) as ExerciseDef;
  /** Ideal singing of `rz` with a silent hole in the middle of its third glide. */
  function holed(rz: ReturnType<typeof real>, holeSec: number): PitchFrame[] {
    const glides = rz.notes.filter((n) => n.toMidi !== undefined && n.end - n.start > 1.5);
    const target = glides[glides.length > 2 ? 2 : glides.length - 1];
    const mid = (target.start + target.end) / 2;
    const base = sungContour(rz.notes, 30);
    return makeTrack({ duration: rz.totalSec + 0.5, midi: (t) => (t >= mid && t < mid + holeSec ? NaN : base(t)), jitterCents: 6, seed: 11 });
  }

  for (const id of ['foundations.siren.1', 'foundations.audition.2']) {
    const def = byId(id);
    const rz = real(def);
    const clean = analyzeTake(def, rz, holed(rz, 0), { vibratoStyle: 'pop' });
    const cleanScore = evaluate(def, clean.metrics).score;

    it(`${id}: the clean take has no cracks`, () => {
      expect(clean.metrics['glide.cracks']).toBe(0);
    });

    for (const hole of [0.12, 0.25, 0.4, 0.6, 1.0]) {
      it(`${id}: a ${hole} s hole is one crack and the score drops by the same amount whatever its length`, () => {
        const a = analyzeTake(def, rz, holed(rz, hole), { vibratoStyle: 'pop' });
        expect(a.metrics['glide.cracks']).toBe(1);
        const score = evaluate(def, a.metrics).score;
        expect(score).toBeLessThan(cleanScore);
        expect(score).toBeGreaterThan(cleanScore - 0.15); // one crack is one crack: it costs its band, not the whole take
      });
    }
  }

  it('through the real detector: a 0.6 s hole mid-siren is still found (analyzeGlide on Framer/MPM output)', () => {
    const SR = 48000;
    const g: TargetNote = { midi: 52, toMidi: 64, start: 0.5, end: 3.0 };
    const f0 = (t: number): number => (t >= 1.7 && t < 2.3 ? NaN : midiToHz(52 + 12 * Math.min(1, Math.max(0, (t - 0.5) / 2.5))));
    const r = analyzeGlide(trackFromAudio(synthesize({ sampleRate: SR, duration: 3.6, f0 }), SR), g, CTX);
    expect(r.cracks).toHaveLength(1);
    expect(r.cracks[0].kind).toBe('dropout');
    expect(r.cracks[0].durationMs).toBeGreaterThan(500);
    expect(CONFIG.transitions.dropoutMinMs).toBeLessThan(r.cracks[0].durationMs);
  });
});
