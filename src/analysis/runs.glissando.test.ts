/**
 * One continuous glissando through every note centre is not a run (F1 of the Wave 1 review).
 *
 * Definition measures dwell on a note's own plateau, not mere proximity. A slide through notes a
 * semitone apart spends ~50 ms inside +/-25 c of each at 9 notes/s, which used to count as defined;
 * the cluster is now narrow where the notes are close, and a cluster the voice is sliding through at
 * nearly the speed of a plain slide is not a note it sang. The same tests pin the other side: a
 * clean run, a sloppy run (8 c jitter, 70 ms transitions), a run on one repeated pitch and the real
 * detector's output for a clean run at every tempo up to 12 notes/s must all stay defined.
 *
 * What these tests do NOT claim: run.score can stay high for a slur (reached, accuracy and timing are
 * 75% of its weight and a slur does reach every note), so the tempo ladder has to look at
 * run.definedRate as well (src/exercises/ladder.ts, reported as a cross-module need).
 */
import { describe, expect, it } from 'vitest';
import type { TargetNote } from '../core/types';
import { analyzeTake } from '../exercises/analyze';
import { EXERCISES } from '../exercises/catalog';
import { evaluate } from '../exercises/evaluate';
import { nextTempo, startTempo } from '../exercises/ladder';
import { planAnalysis } from '../exercises/plan';
import { GOOD_SINGER, singTake, type SingerModel } from '../exercises/test-singer';
import { realize } from '../exercises/transpose';
import type { ExerciseDef } from '../exercises/types';
import { analyzeRun } from './runs';
import { makeTrack } from './fixtures';
import { runNotes, sungContour } from './advanced-test-helpers';
import { trackFromAudio } from './core-test-helpers';
import { midiToHz } from '../core/music';
import { synthesize } from '../dsp/test-signals';
import type { AnalyzeContext } from './types';

const CTX: AnalyzeContext = { toleranceCents: 25, vibratoStyle: 'pop' };

const PATTERNS: Record<string, number[]> = {
  'chromatic five': [60, 61, 62, 63, 64],
  'chromatic seven, down': [66, 65, 64, 63, 62, 61, 60],
  'blues five': [67, 66, 65, 63, 60],
  'blues seven': [60, 63, 65, 66, 67, 70, 72],
  'pentatonic eight': [60, 63, 65, 67, 70, 67, 65, 63],
};

/** One continuous slide through the centre of every note (held at the first note's pitch before its centre and the last one's after). */
function glissando(notes: readonly TargetNote[]): (t: number) => number {
  const pts = notes.map((n) => ({ t: (n.start + n.end) / 2, m: n.midi }));
  return (t) => {
    if (t < notes[0].start || t >= notes[notes.length - 1].end) return NaN;
    if (t <= pts[0].t) return pts[0].m;
    if (t >= pts[pts.length - 1].t) return pts[pts.length - 1].m;
    for (let i = 0; i + 1 < pts.length; i++) if (t >= pts[i].t && t < pts[i + 1].t) return pts[i].m + (pts[i + 1].m - pts[i].m) * ((t - pts[i].t) / (pts[i + 1].t - pts[i].t));
    return NaN;
  };
}

const definedRate = (r: ReturnType<typeof analyzeRun>): number => r.notes.filter((n) => n.verdict === 'defined').length / r.notes.length;
const f0Of = (m: (t: number) => number) => (t: number): number => (Number.isFinite(m(t)) ? midiToHz(m(t)) : NaN);
const sing = (notes: readonly TargetNote[], midi: (t: number) => number, jitter: number, seed: number) =>
  makeTrack({ duration: notes[notes.length - 1].end + 0.3, midi, jitterCents: jitter, seed });

describe('analyzeRun: a glissando through the notes is not a run (contour)', () => {
  for (const [name, pattern] of Object.entries(PATTERNS)) {
    for (const nps of [3, 6, 9]) {
      it(`${name} at ${nps} notes/s: defined rate stays under 0.5${pattern.length === 8 ? '' : ', and no interior note counts as defined'} (3 noise seeds)`, () => {
        const notes = runNotes(pattern, nps, 0.3);
        for (let seed = 1; seed <= 3; seed++) {
          const r = analyzeRun(sing(notes, glissando(notes), 3, seed), notes, CTX);
          expect(definedRate(r), `seed ${seed}`).toBeLessThan(0.5);
          // The first and last note are held at their own pitch by the glissando's shape; everything it slides through is a smear.
          // (Not asserted for the up-and-back pattern: a glissando pauses at its apex exactly as a held note would.)
          if (pattern.length !== 8) for (const n of r.notes.slice(1, -1)) expect(n.verdict, `seed ${seed} note ${n.index}`).toBe('smeared');
        }
      });

      it(`${name} at ${nps} notes/s with 8 c of jitter: defined rate stays under 0.5 on average`, () => {
        const notes = runNotes(pattern, nps, 0.3);
        let sum = 0;
        for (let seed = 1; seed <= 6; seed++) sum += definedRate(analyzeRun(sing(notes, glissando(notes), 8, seed), notes, CTX));
        expect(sum / 6).toBeLessThan(0.5);
      });
    }
  }
});

describe('analyzeRun: a glissando through the notes is not a run (real detector)', () => {
  for (const SR of [48000, 44100]) {
    for (const [name, pattern] of Object.entries(PATTERNS)) {
      for (const nps of [3, 6, 9]) {
        it(`${SR} Hz, ${name} at ${nps} notes/s: defined rate stays under 0.5`, () => {
          const notes = runNotes(pattern, nps, 0.3);
          const audio = synthesize({ sampleRate: SR, duration: notes[notes.length - 1].end + 0.3, f0: f0Of(glissando(notes)) });
          const r = analyzeRun(trackFromAudio(audio, SR), notes, CTX);
          expect(definedRate(r)).toBeLessThan(0.5);
        });
      }
    }
  }
});

describe('analyzeRun: what the stricter definition must not take from a real run', () => {
  for (const [name, pattern] of Object.entries(PATTERNS)) {
    for (const nps of [3, 6, 9, 12]) {
      it(`${name} sung cleanly at ${nps} notes/s: every note defined (contour, 3 seeds)`, () => {
        const notes = runNotes(pattern, nps, 0.3);
        for (let seed = 1; seed <= 3; seed++) {
          expect(definedRate(analyzeRun(sing(notes, sungContour(notes, 30), 6, seed), notes, CTX)), `seed ${seed}`).toBe(1);
        }
      });

      it(`${name} sung cleanly at ${nps} notes/s through the real detector: every note defined`, () => {
        const notes = runNotes(pattern, nps, 0.3);
        const audio = synthesize({ sampleRate: 48000, duration: notes[notes.length - 1].end + 0.3, f0: f0Of(sungContour(notes, 30)) });
        expect(definedRate(analyzeRun(trackFromAudio(audio, 48000), notes, CTX))).toBe(1);
      });
    }
  }

  for (const [name, pattern] of Object.entries(PATTERNS)) {
    for (const nps of [3, 6, 9]) {
      it(`${name} sung sloppily (8 c jitter, 70 ms transitions) at ${nps} notes/s: still reads as a run`, () => {
        const notes = runNotes(pattern, nps, 0.3);
        let sum = 0;
        for (let seed = 1; seed <= 6; seed++) {
          const r = analyzeRun(sing(notes, sungContour(notes, 70), 8, seed), notes, CTX);
          const rate = definedRate(r);
          expect(rate, `seed ${seed}`).toBeGreaterThanOrEqual(0.6);
          sum += rate;
        }
        expect(sum / 6).toBeGreaterThanOrEqual(0.9);
      });
    }
  }

  it('a run on one repeated pitch (no different-pitch neighbour to size the band by) is defined', () => {
    const notes = runNotes([60, 60, 60, 60], 6, 0.3);
    const r = analyzeRun(sing(notes, sungContour(notes, 30), 6, 1), notes, CTX);
    expect(definedRate(r)).toBe(1);
  });

  it('repeated notes next to a different pitch are sized by that pitch, not by their own repeat', () => {
    const notes = runNotes([60, 60, 60, 62, 62], 6, 0.3);
    const r = analyzeRun(sing(notes, sungContour(notes, 30), 6, 1), notes, CTX);
    expect(definedRate(r)).toBe(1);
  });

  it('a note that is flat but distinct is still defined (its inaccuracy is accuracy\'s business)', () => {
    const notes = runNotes([60, 61, 62, 63, 64], 6, 0.3);
    const r = analyzeRun(sing(notes, (t) => sungContour(notes, 30)(t) - 0.3, 6, 1), notes, CTX);
    expect(definedRate(r)).toBe(1);
    expect(Math.abs(r.notes[2].medianErrorCents as number)).toBeGreaterThan(20);
  });
});

describe('the real catalog: a glissando fails the run levels that are about distinct notes (end to end)', () => {
  const byId = (id: string): ExerciseDef => EXERCISES.find((d) => d.id === id) as ExerciseDef;
  const runScored = EXERCISES.filter((d) => d.analyzers.includes('run'));

  /** One continuous slide through the centre of every sung step of each phrase of the exercise (held at the phrase's first pitch before its centre and its last after). */
  function slur(def: ExerciseDef, seed: number) {
    const rz = realize(def, null, 'tenor');
    const phrases = planAnalysis(rz).phrases;
    const centres = phrases.map((p) => p.steps.map((st) => ({ t: (st.start + st.end) / 2, m: ((st.toMidi !== undefined ? ((st.midi as number) + st.toMidi) / 2 : (st.midi as number)) + 0.02) })));
    const midi = (t: number): number => {
      for (let pi = 0; pi < phrases.length; pi++) {
        if (t < phrases[pi].start || t >= phrases[pi].end) continue;
        const pts = centres[pi];
        if (t <= pts[0].t) return pts[0].m;
        if (t >= pts[pts.length - 1].t) return pts[pts.length - 1].m;
        for (let i = 0; i + 1 < pts.length; i++) if (t >= pts[i].t && t < pts[i + 1].t) return pts[i].m + (pts[i + 1].m - pts[i].m) * ((t - pts[i].t) / (pts[i + 1].t - pts[i].t));
      }
      return Number.NaN;
    };
    return { rz, track: makeTrack({ duration: rz.totalSec + 1, t0: -0.5, midi, jitterCents: 3, seed }) };
  }

  // Blues five (default, the finding's example), Blues seven down (studio), the pentatonic fives and sevens, the Boss and the longer auditions.
  // (The three-note riffs end on a long held note and the oscillation drills ARE a slide between two notes: a slur is not wrong for those.)
  const SLUR_FAILS = ['runs.run.3', 'runs.run.4', 'runs.run.5', 'runs.run.6', 'runs.run.7', 'runs.run.8', 'runs.boss-recital', 'runs.audition.2', 'runs.audition.3', 'inflections.turn.2', 'inflections.boss-recital', 'inflections.audition.4'];
  for (const id of SLUR_FAILS) {
    it(`${id}: a glissando through every note fails, in every one of 3 takes, and does not move the tempo ladder up`, () => {
      const def = byId(id);
      for (let seed = 1; seed <= 3; seed++) {
        const { rz, track } = slur(def, seed);
        const a = analyzeTake(def, rz, track, { vibratoStyle: 'pop' });
        expect(evaluate(def, a.metrics, a).passed, `seed ${seed}`).toBe(false);
        expect(nextTempo(def, startTempo(def), a.metrics, a), `seed ${seed}`).toBe(startTempo(def));
      }
    });
  }

  const TIGHT: SingerModel = { ...GOOD_SINGER, jitterCents: 2, transitionMs: 25, scoopCents: 5, biasCents: 0 };
  const SLOPPY: SingerModel = { ...GOOD_SINGER, jitterCents: 8, transitionMs: 70, scoopCents: 25, biasCents: 12 };
  const singers: Array<[string, SingerModel]> = [['good', GOOD_SINGER], ['tight', TIGHT], ['sloppy (8 c jitter, 70 ms transitions)', SLOPPY]];
  for (const [label, singer] of singers) {
    it(`a ${label} singer still passes all ${runScored.length} run-scored exercises (3 takes each)`, () => {
      expect(runScored.length).toBeGreaterThanOrEqual(19);
      for (const def of runScored) {
        const rz = realize(def, null, 'tenor');
        for (let seed = 1; seed <= 3; seed++) {
          const a = analyzeTake(def, rz, singTake(rz, { ...singer, seed }), { vibratoStyle: 'pop' });
          expect(evaluate(def, a.metrics, a).passed, `${def.id} seed ${seed}`).toBe(true);
        }
      }
    });
  }
});
