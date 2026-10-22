/**
 * Performance guard: every analysis-core analyzer must stay well under
 * real-time on a 60 s take in node (budget: < 20 ms per analyzer, per the
 * Phase 2 build brief). The assertion is on the BEST of many runs after a
 * warm-up: when the whole suite runs in parallel across dozens of worker
 * processes the machine is oversubscribed and any single run (or the median)
 * can be 3x slower than on a quiet box, while the best run is a stable
 * estimate of the real cost. The median is printed too (run with
 * --disableConsoleIntercept) and is what the build report quotes.
 */
import { describe, expect, it } from 'vitest';
import { analyzeAccuracy } from './accuracy';
import { analyzeOnset } from './onset';
import { analyzeVibrato, findVibratoEpisodes } from './vibrato';
import { analyzePulse } from './pulse';
import { analyzeSwitch, type VibratoCue } from './switch';
import { analyzeRange } from './range';
import { analyzeDynamics } from './dynamics';
import { metricsFromResults, scoreExercise } from './score';
import { cleanSpikes, framesInWindow, heldPortion, theilSenSlope, voicedRuns } from './track';
import { makeTrack, sustained, withVibrato } from './fixtures';
import type { AnalyzeContext } from './types';
import type { ExerciseDef } from '../exercises/types';

const DURATION = 60;
const ctx: AnalyzeContext = { toleranceCents: 25, vibratoStyle: 'pop' };
const BUDGET_MS = 20;

interface Timing {
  best: number;
  median: number;
}

/** Wall-clock ms of `fn` over `runs` runs after `warm` untimed ones: best and median. */
function measure(fn: () => void, runs = 25, warm = 3): Timing {
  for (let i = 0; i < warm; i++) fn();
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return { best: samples[0], median: samples[samples.length >> 1] };
}

/** The number a budget is asserted against (the best run; see the header). */
function timeIt(fn: () => void, runs = 25, warm = 3): number {
  const t = measure(fn, runs, warm);
  lastMedian = t.median;
  return t.best;
}
let lastMedian = 0;

function report(name: string, ms: number): void {
  console.log(`${name}: best ${ms.toFixed(2)} ms, median ${lastMedian.toFixed(2)} ms / 60 s take`);
}

describe('analysis-core performance on a 60 s take', () => {
  const note = sustained(60, 0, DURATION);
  const vibratoTrack = makeTrack({ duration: DURATION, midi: withVibrato(() => 60, 5.8, 45, 5), rmsDb: (t) => -30 + 10 * Math.sin(t), jitterCents: 5, seed: 4 });
  const sirenTrack = makeTrack({ duration: DURATION, midi: (t) => 48 + 24 * ((t % 10) / 10), jitterCents: 8 });
  const noisyTrack = makeTrack({ duration: DURATION, midi: () => 60, jitterCents: 6, seed: 9 });

  it('analyzeAccuracy', () => {
    const ms = timeIt(() => analyzeAccuracy(vibratoTrack, note, ctx));
    report('analyzeAccuracy', ms);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('analyzeOnset', () => {
    const ms = timeIt(() => analyzeOnset(vibratoTrack, note, ctx));
    report('analyzeOnset', ms);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('analyzeVibrato (with per-window live estimates)', () => {
    const ms = timeIt(() => analyzeVibrato(vibratoTrack, note, ctx));
    report('analyzeVibrato (windows on)', ms);
    expect(ms).toBeLessThan(BUDGET_MS);
    const noisy = timeIt(() => analyzeVibrato(noisyTrack, note, ctx));
    report('analyzeVibrato (straight, jittery)', noisy);
    expect(noisy).toBeLessThan(BUDGET_MS);
  });

  it('analyzeVibrato on a live-meter-sized trailing window is far under a millisecond or two', () => {
    const live = makeTrack({ duration: 1.5, midi: withVibrato(() => 60, 5.8, 45), jitterCents: 5, seed: 4 });
    const ms = timeIt(() => analyzeVibrato(live, null, ctx, { windows: false }), 25, 5);
    console.log(`analyzeVibrato (1.5 s live window): best ${ms.toFixed(3)} ms, median ${lastMedian.toFixed(3)} ms`);
    expect(ms).toBeLessThan(2);
  });

  it('findVibratoEpisodes', () => {
    const ms = timeIt(() => findVibratoEpisodes(vibratoTrack));
    report('findVibratoEpisodes', ms);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('analyzePulse', () => {
    const pulses = makeTrack({ duration: DURATION, midi: (t) => 60 + 0.4 * Math.max(0, Math.sin(2 * Math.PI * 4.5 * t)), jitterCents: 5, seed: 3 });
    const ms = timeIt(() => analyzePulse(pulses, note, 4.5));
    report('analyzePulse', ms);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('analyzeSwitch (30 contiguous cue windows)', () => {
    const cues: VibratoCue[] = Array.from({ length: 30 }, (_, i) => ({ start: i * 2, end: (i + 1) * 2, vibrato: i % 2 === 0 }));
    const track = makeTrack({ duration: DURATION, midi: (t) => 60 + (Math.floor(t / 2) % 2 === 0 ? 0.45 * Math.sin(2 * Math.PI * 5.8 * t) : 0), jitterCents: 5, seed: 6 });
    const ms = timeIt(() => analyzeSwitch(track, cues));
    report('analyzeSwitch', ms);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('analyzeRange (a siren, and one 60 s hold with vibrato: a single run, the most work for the centre-line filters)', () => {
    const ms = timeIt(() => analyzeRange(sirenTrack));
    report('analyzeRange', ms);
    expect(ms).toBeLessThan(BUDGET_MS);
    const held = timeIt(() => analyzeRange(vibratoTrack));
    report('analyzeRange (60 s hold, vibrato)', held);
    expect(held).toBeLessThan(BUDGET_MS);
  });

  it('analyzeDynamics (was O(n^2) before the block-median reduction: 23 s)', () => {
    const ms = timeIt(() => analyzeDynamics(vibratoTrack, note, ctx));
    report('analyzeDynamics', ms);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('the track.ts helpers every analyzer leans on', () => {
    const spiky = vibratoTrack.map((f, i) => (i % 97 === 5 ? { ...f, midi: f.midi + 12 } : f));
    const clean = timeIt(() => cleanSpikes(spiky));
    report('cleanSpikes', clean);
    expect(clean).toBeLessThan(BUDGET_MS);
    const win = timeIt(() => {
      for (let t = 0; t < 59; t += 0.5) framesInWindow(vibratoTrack, t, t + 0.5);
    });
    report('framesInWindow x118', win);
    expect(win).toBeLessThan(BUDGET_MS);
    const runs = timeIt(() => voicedRuns(vibratoTrack, 0.045));
    report('voicedRuns', runs);
    expect(runs).toBeLessThan(BUDGET_MS);
    const held = timeIt(() => heldPortion(vibratoTrack, note, 150));
    report('heldPortion', held);
    expect(held).toBeLessThan(BUDGET_MS);
    const xs = vibratoTrack.map((f) => f.t);
    const ys = vibratoTrack.map((f) => f.rmsDb);
    const ts = timeIt(() => theilSenSlope(xs, ys));
    report('theilSenSlope (thinned)', ts);
    expect(ts).toBeLessThan(BUDGET_MS * 2.5); // 400 points = 80k slopes: its own bound, not the analyzers'
  });

  it('metricsFromResults + scoreExercise', () => {
    const def: ExerciseDef = {
      id: 'perf.test',
      worldId: 'foundations',
      kind: 'sustain',
      title: 'Perf',
      goal: 'Perf',
      pattern: [],
      tempoBpm: 100,
      tonicPlacement: 'mid',
      countInBeats: 0,
      metronome: false,
      demo: { timbre: 'sine' },
      analyzers: ['accuracy'],
      scoring: [{ metric: 'accuracy.inTolerancePct', weight: 1, best: 100, worst: 0 }],
      pass: { score: 0.7 },
      tolerance: 'default',
      tiers: { solid: 0.85, studio: 0.95 },
    };
    const acc = analyzeAccuracy(vibratoTrack, note, ctx);
    const manyNotes = Array.from({ length: 200 }, () => acc);
    const ms = timeIt(() => scoreExercise(def, metricsFromResults({ accuracy: manyNotes })));
    report('metricsFromResults(200 notes) + scoreExercise', ms);
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});
