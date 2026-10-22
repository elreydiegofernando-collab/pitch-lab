import { describe, expect, it } from 'vitest';
import { seededRandom } from '../dsp/test-signals';
import { EXERCISES } from '../exercises/catalog';
import { evaluate } from '../exercises/evaluate';
import type { ExerciseDef, ScoreTerm } from '../exercises/types';
import { metricsFromResults, scoreExercise } from './score';
import type { AnalyzerResults } from './score';
import type { PulseResult } from './pulse';
import type { SwitchResult } from './switch';
import type {
  AccuracyResult,
  DynamicsResult,
  GlideResult,
  InflectionResult,
  MetricKey,
  Metrics,
  OnsetResult,
  PhraseScore,
  RunResult,
  TransitionResult,
  VibratoResult,
} from './types';

function accuracy(partial: Partial<AccuracyResult & { coverage: number }>): AccuracyResult & { coverage: number } {
  return { voicedSec: 2, biasCents: 0, medianAbsCents: 0, inTolerancePct: 100, sdCents: 0, driftCentsPerSec: null, coverage: 1, ...partial };
}

function onset(partial: Partial<OnsetResult>): OnsetResult {
  return { onsetT: 0, settleMs: 100, scoopCents: 0, overshootCents: 0, onsetType: 'balanced', riseMs: 100, crisp: true, ...partial };
}

function vibrato(partial: Partial<VibratoResult>): VibratoResult {
  return {
    present: false,
    rateHz: null,
    extentCents: null,
    rateSdHz: null,
    extentSdCents: null,
    regularity: null,
    centeringCents: null,
    inZone: false,
    flags: [],
    windows: [],
    ...partial,
  };
}

function pulse(partial: Partial<PulseResult>): PulseResult {
  return { measuredRateHz: 4.5, targetRateHz: 4.5, rateErrorHz: 0, regularity: 0.9, pulseCount: 12, swingCents: 50, ...partial };
}

function dyn(partial: Partial<DynamicsResult>): DynamicsResult {
  return { rangeDb: 20, slopeCentsPerDb: 0.2, correlation: 0.1, symmetry: 0.9, peakPosition: 0.5, verdict: 'steady', ...partial };
}

function sw(partial: Partial<SwitchResult>): SwitchResult {
  return { windows: [], boundaries: [], switchCleanRate: null, bloomOnCueLatencyMs: null, bloomOnCueScore: null, ...partial };
}

/** Minimal ExerciseDef with just the fields scoreExercise reads. */
function minimalDef(overrides: Partial<ExerciseDef> = {}): ExerciseDef {
  return {
    id: 'test.exercise',
    worldId: 'foundations',
    kind: 'sustain',
    title: 'Test',
    goal: 'Test',
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
    ...overrides,
  };
}

describe('metricsFromResults: single results', () => {
  it('flattens accuracy and onset results, abs-ing the signed ones named "abs*"', () => {
    const results: AnalyzerResults = {
      accuracy: accuracy({ biasCents: -12, driftCentsPerSec: -3 }),
      onset: onset({ settleMs: 180, crisp: false }),
    };
    const m = metricsFromResults(results);
    expect(m['accuracy.absBiasCents']).toBe(12);
    expect(m['accuracy.absDriftCentsPerSec']).toBe(3);
    expect(m['onset.settleMs']).toBe(180);
    expect(m['onset.crispRate']).toBe(0);
  });

  it('omits a metric whose analyzer could not measure it, rather than setting NaN', () => {
    const m = metricsFromResults({ accuracy: accuracy({ driftCentsPerSec: null }) });
    expect('accuracy.absDriftCentsPerSec' in m).toBe(false);
    expect(m['accuracy.inTolerancePct']).toBe(100);
  });

  it('omits every key for an analyzer that did not run at all', () => {
    expect(Object.keys(metricsFromResults({})).length).toBe(0);
  });

  it('vibrato shares map to 0..1 and null facets are omitted', () => {
    const m = metricsFromResults({ vibrato: vibrato({ present: true, inZone: true, rateHz: 5.8, extentCents: 45, centeringCents: -7 }) });
    expect(m['vibrato.present']).toBe(1);
    expect(m['vibrato.inZone']).toBe(1);
    expect(m['vibrato.rateHz']).toBe(5.8);
    expect(m['vibrato.extentCents']).toBe(45);
    expect(m['vibrato.absCenteringCents']).toBe(7);
    expect('vibrato.regularity' in m).toBe(false);
  });

  it('range.spanSemitones is highest - lowest when both are known, and absent otherwise', () => {
    expect(metricsFromResults({ range: { lowestMidi: 48, highestMidi: 72, heldNotes: [] } })['range.spanSemitones']).toBe(24);
    expect('range.spanSemitones' in metricsFromResults({ range: { lowestMidi: null, highestMidi: null, heldNotes: [] } })).toBe(false);
    expect('range.spanSemitones' in metricsFromResults({ range: { lowestMidi: NaN, highestMidi: 60, heldNotes: [] } })).toBe(false); // never a NaN metric
  });

  it('pulse: absolute rate error, regularity, and an unmeasurable train counted as the worst', () => {
    const m = metricsFromResults({ pulse: pulse({ rateErrorHz: -0.4, regularity: 0.8 }) });
    expect(m['pulse.rateErrorHz']).toBe(0.4);
    expect(m['pulse.regularity']).toBe(0.8);
    const none = metricsFromResults({ pulse: pulse({ measuredRateHz: null, rateErrorHz: null, regularity: null, pulseCount: 0, swingCents: null }) });
    expect('pulse.rateErrorHz' in none).toBe(false); // no rate: omitted, so the scorer gives 0 and fails a gate on it
    expect(none['pulse.regularity']).toBe(0);
  });

  it('switch: clean rate and the bloom score pass through; a plan with no boundary has no switch metrics', () => {
    const ok = metricsFromResults({
      switch: sw({
        boundaries: [
          { t: 2, toVibrato: true, latencyMs: 100, clean: true, reattacked: false },
          { t: 4, toVibrato: false, latencyMs: 50, clean: false, reattacked: false },
        ],
        switchCleanRate: 0.5,
        bloomOnCueScore: 0.9,
        bloomOnCueLatencyMs: 100,
      }),
    });
    expect(ok['vibrato.switchCleanRate']).toBe(0.5);
    expect(ok['vibrato.bloomOnCue']).toBe(0.9);
    expect(Object.keys(metricsFromResults({ switch: sw({}) }))).toEqual([]);
  });

  it('glide, transitions, inflection, run and dynamics map as documented', () => {
    const glide: GlideResult = { durationMs: 900, startErrorCents: 4, endErrorCents: -22, monotonic: true, stairSteps: 0, smoothness: 0.8, cracks: [{ t: 1, kind: 'jump', cents: 300, durationMs: 10 }] };
    const trans: TransitionResult = { transitions: [{ fromIndex: 0, toIndex: 1, durationMs: 90, overshootCents: 5, clean: true }], cleanRate: 1 };
    const infl: InflectionResult = { kind: 'scoop', detected: true, sizeCents: 60, timeMs: 150, landingAbsCents: 9, score: 0.8, notes: [] };
    const run: RunResult = {
      notes: [
        { index: 0, targetMidi: 60, reached: true, reachedMs: 80, medianErrorCents: 3, definition: 0.9, timingErrorMs: 10, verdict: 'defined' },
        { index: 1, targetMidi: 62, reached: true, reachedMs: 60, medianErrorCents: 8, definition: 0.5, timingErrorMs: 20, verdict: 'smeared' },
        { index: 2, targetMidi: 64, reached: false, reachedMs: 0, medianErrorCents: null, definition: 0, timingErrorMs: null, verdict: 'missed' },
        { index: 3, targetMidi: 65, reached: true, reachedMs: 90, medianErrorCents: 2, definition: 0.95, timingErrorMs: 5, verdict: 'defined' },
      ],
      score: 0.7,
      components: { reached: 0.8, accuracy: 0.7, definition: 0.6, timing: 0.9 },
    };
    const m = metricsFromResults({ glide, transitions: trans, inflection: infl, run, dynamics: dyn({ slopeCentsPerDb: -1.5 }) });
    expect(m['glide.smoothness']).toBe(0.8);
    expect(m['glide.endAbsCents']).toBe(22);
    expect(m['glide.cracks']).toBe(1);
    expect(m['transition.cleanRate']).toBe(1);
    expect(m['inflection.score']).toBe(0.8);
    expect(m['inflection.landingAbsCents']).toBe(9);
    expect(m['run.score']).toBe(0.7);
    expect(m['run.definedRate']).toBe(0.5);
    expect(m['run.missedRate']).toBe(0.25);
    expect(m['dynamics.rangeDb']).toBe(20);
    expect(m['dynamics.absSlopeCentsPerDb']).toBe(1.5);
    expect(m['dynamics.symmetry']).toBe(0.9);
  });

  it('song phrases: duration-weighted phrase score and in-tolerance percent', () => {
    const phrases: PhraseScore[] = [
      { phraseIndex: 0, start: 0, end: 2, pitchScore: 1, inTolerancePct: 100, timingOffsetMs: 0, stabilitySdCents: 5, vibratoPresent: false },
      { phraseIndex: 1, start: 2, end: 8, pitchScore: 0.5, inTolerancePct: 40, timingOffsetMs: 0, stabilitySdCents: 5, vibratoPresent: false },
    ];
    const m = metricsFromResults({ phrases });
    expect(m['song.phraseScore']).toBeCloseTo((2 * 1 + 6 * 0.5) / 8, 9);
    expect(m['song.inTolerancePct']).toBeCloseTo((2 * 100 + 6 * 40) / 8, 9);
  });
});

describe('metricsFromResults: several notes, windows or trains', () => {
  it('accuracy.inTolerancePct is the MEAN over notes of (percent x coverage): a note never sung counts as a miss, not as nothing', () => {
    const never = accuracy({ voicedSec: 0, biasCents: NaN, medianAbsCents: NaN, inTolerancePct: 0, sdCents: NaN, coverage: 0 });
    const good = accuracy({ inTolerancePct: 100 });
    const m = metricsFromResults({ accuracy: [good, good, good, never, never] });
    expect(m['accuracy.inTolerancePct']).toBeCloseTo(60, 9);
    // the cents figures describe the notes that WERE sung
    expect(m['accuracy.medianAbsCents']).toBe(0);
    expect(m['accuracy.sdCents']).toBe(0);
  });

  it('coverage scales a note\'s percent: perfect for a quarter of the note is 25%', () => {
    expect(metricsFromResults({ accuracy: accuracy({ inTolerancePct: 100, coverage: 0.25 }) })['accuracy.inTolerancePct']).toBeCloseTo(25, 9);
    // a bare AccuracyResult (no coverage field) is treated as fully covered
    const bare: AccuracyResult = { voicedSec: 2, biasCents: 0, medianAbsCents: 0, inTolerancePct: 80, sdCents: 0, driftCentsPerSec: null };
    expect(metricsFromResults({ accuracy: bare })['accuracy.inTolerancePct']).toBe(80);
  });

  it('accuracy magnitudes are the median over the notes they were measured on (robust to one bad note)', () => {
    const notes = [3, 4, 5, 6, 90].map((c) => accuracy({ medianAbsCents: c, sdCents: c, biasCents: -c, driftCentsPerSec: c / 10 }));
    const m = metricsFromResults({ accuracy: notes });
    expect(m['accuracy.medianAbsCents']).toBe(5);
    expect(m['accuracy.sdCents']).toBe(5);
    expect(m['accuracy.absBiasCents']).toBe(5);
    expect(m['accuracy.absDriftCentsPerSec']).toBeCloseTo(0.5, 9);
  });

  it('onset.settleMs: a note that never settled (or was never sung) counts as the worst, so a mostly-unsettled take has no settle time', () => {
    const settled = (ms: number) => onset({ settleMs: ms });
    const unsettled = onset({ settleMs: null, crisp: false });
    const never = onset({ onsetT: null, settleMs: null, crisp: false, onsetType: 'unknown', riseMs: null });
    expect(metricsFromResults({ onset: [settled(100), settled(120), settled(140), unsettled, never] })['onset.settleMs']).toBe(140);
    expect('onset.settleMs' in metricsFromResults({ onset: [settled(100), unsettled, never] })).toBe(false);
  });

  it('onset.crispRate is the share of ALL notes that were crisp; scoop and overshoot are medians over the notes that were sung', () => {
    const m = metricsFromResults({
      onset: [
        onset({ crisp: true, scoopCents: 5, overshootCents: 2 }),
        onset({ crisp: true, scoopCents: 9, overshootCents: 4 }),
        onset({ crisp: false, scoopCents: 40, overshootCents: 30 }),
        onset({ onsetT: null, settleMs: null, crisp: false, scoopCents: 0, overshootCents: 0 }),
      ],
    });
    expect(m['onset.crispRate']).toBe(0.5);
    expect(m['onset.scoopCents']).toBe(9);
    expect(m['onset.overshootCents']).toBe(4);
  });

  it('vibrato: present / inZone are shares of all notes; rate, extent, regularity and centring come from the notes with vibrato', () => {
    const m = metricsFromResults({
      vibrato: [
        vibrato({ present: true, inZone: true, rateHz: 5.6, extentCents: 40, regularity: 0.9, centeringCents: -4 }),
        vibrato({ present: true, inZone: false, rateHz: 6.4, extentCents: 80, regularity: 0.6, centeringCents: 10 }),
        vibrato({ present: false, extentCents: 4 }),
        vibrato({ present: true, inZone: true, rateHz: 5.8, extentCents: 50, regularity: 0.8, centeringCents: 2 }),
      ],
    });
    expect(m['vibrato.present']).toBe(0.75);
    expect(m['vibrato.inZone']).toBe(0.5);
    expect(m['vibrato.rateHz']).toBe(5.8);
    expect(m['vibrato.extentCents']).toBe(50);
    expect(m['vibrato.regularity']).toBe(0.8);
    expect(m['vibrato.absCenteringCents']).toBe(4);
  });

  it('a straight take has no vibrato rate/extent/regularity/centring keys at all (so a vibrato exercise scores them 0)', () => {
    const m = metricsFromResults({ vibrato: [vibrato({ present: false }), vibrato({ present: false })] });
    expect(m['vibrato.present']).toBe(0);
    for (const k of ['vibrato.rateHz', 'vibrato.extentCents', 'vibrato.regularity', 'vibrato.absCenteringCents'] as const) expect(k in m).toBe(false);
  });

  it('switch: clean rate and bloom score are weighted by how many boundaries each result had', () => {
    const b = (toVibrato: boolean, clean: boolean) => ({ t: 1, toVibrato, latencyMs: 100, clean, reattacked: false });
    const a = sw({ boundaries: [b(true, true), b(false, true), b(true, true)], bloomOnCueScore: 1 }); // 2 blooms, 3 boundaries, all clean
    const c = sw({ boundaries: [b(true, false)], bloomOnCueScore: 0 }); // 1 bloom, 1 boundary, unclean
    const m = metricsFromResults({ switch: [a, c] });
    expect(m['vibrato.switchCleanRate']).toBeCloseTo(3 / 4, 9);
    expect(m['vibrato.bloomOnCue']).toBeCloseTo((2 * 1 + 1 * 0) / 3, 9);
  });

  it('pulse trains: median over trains, an unpulsed train counts as the worst', () => {
    const good = pulse({ rateErrorHz: 0.1, regularity: 0.9 });
    const none = pulse({ measuredRateHz: null, rateErrorHz: null, regularity: null, pulseCount: 0, swingCents: null });
    const m = metricsFromResults({ pulse: [good, good, none] });
    expect(m['pulse.rateErrorHz']).toBe(0.1);
    expect(m['pulse.regularity']).toBe(0.9);
    const bad = metricsFromResults({ pulse: [good, none, none] });
    expect('pulse.rateErrorHz' in bad).toBe(false);
    expect(bad['pulse.regularity']).toBe(0);
  });

  it('glide.cracks: summed over glides, and the whole-take crack detector is not double counted with them', () => {
    const crack = { t: 1, kind: 'jump' as const, cents: 300, durationMs: 10 };
    const glide = (n: number): GlideResult => ({ durationMs: 900, startErrorCents: 0, endErrorCents: 5, monotonic: true, stairSteps: 0, smoothness: 0.9, cracks: Array.from({ length: n }, () => crack) });
    expect(metricsFromResults({ glide: [glide(1), glide(2)] })['glide.cracks']).toBe(3);
    expect(metricsFromResults({ glide: [glide(1), glide(2)], cracks: [crack, crack, crack] })['glide.cracks']).toBe(3);
    expect(metricsFromResults({ glide: [glide(0)], cracks: [crack, crack] })['glide.cracks']).toBe(2); // a crack between glides is still a crack
    expect(metricsFromResults({ cracks: [] })['glide.cracks']).toBe(0);
  });

  it('transition.cleanRate is weighted by transitions; run.score is a mean, inflection.score half the mean and half the worst figure; run rates pool all notes', () => {
    const tr = (n: number, clean: number): TransitionResult => ({
      transitions: Array.from({ length: n }, (_, i) => ({ fromIndex: i, toIndex: i + 1, durationMs: 80, overshootCents: 4, clean: i < clean })),
      cleanRate: clean / n,
    });
    expect(metricsFromResults({ transitions: [tr(4, 4), tr(1, 0)] })['transition.cleanRate']).toBeCloseTo(0.8, 9);
    const infl = (score: number, landing: number | null): InflectionResult => ({ kind: 'scoop', detected: true, sizeCents: 50, timeMs: 100, landingAbsCents: landing, score, notes: [] });
    const mi = metricsFromResults({ inflection: [infl(0.9, 10), infl(0.5, null), infl(0.7, 20)] });
    expect(mi['inflection.score']).toBeCloseTo(0.5 * 0.7 + 0.5 * 0.5, 9); // mean 0.7, worst 0.5 (combineInflectionScores)
    expect(mi['inflection.landingAbsCents']).toBe(15);
    // One figure, or figures that all score alike, keep exactly that score.
    expect(metricsFromResults({ inflection: infl(0.83, 10) })['inflection.score']).toBeCloseTo(0.83, 12);
    expect(metricsFromResults({ inflection: [infl(0.6, 10), infl(0.6, 10)] })['inflection.score']).toBeCloseTo(0.6, 12);
    // A Boss Recital whose timed slide was skipped (turn, turn, slide, flip) must not hide in the mean: it lands under the 0.57 studio gate.
    const skipped = metricsFromResults({ inflection: [infl(1, 5), infl(1, 5), infl(0.2, null), infl(0.98, 5)] })['inflection.score']!;
    expect(skipped).toBeCloseTo(0.5 * ((1 + 1 + 0.2 + 0.98) / 4) + 0.5 * 0.2, 12);
    expect(skipped).toBeLessThan(0.57);
    expect('inflection.score' in metricsFromResults({ inflection: [] })).toBe(false);
    const runOf = (verdicts: Array<'defined' | 'smeared' | 'missed'>, score: number): RunResult => ({
      notes: verdicts.map((verdict, index) => ({ index, targetMidi: 60, reached: verdict !== 'missed', reachedMs: 50, medianErrorCents: 5, definition: 0.5, timingErrorMs: 0, verdict })),
      score,
      components: { reached: 1, accuracy: 1, definition: 1, timing: 1 },
    });
    const mr = metricsFromResults({ run: [runOf(['defined', 'defined'], 0.9), runOf(['missed', 'smeared'], 0.3)] });
    expect(mr['run.score']).toBeCloseTo(0.6, 9);
    expect(mr['run.definedRate']).toBe(0.5);
    expect(mr['run.missedRate']).toBe(0.25);
  });

  it('dynamics across notes: median range, median |slope| with unmeasurable notes counting as the worst, symmetry 0 for notes with no shape', () => {
    const ok = dyn({ rangeDb: 22, slopeCentsPerDb: 0.4, symmetry: 0.9 });
    const flat = dyn({ rangeDb: 4, slopeCentsPerDb: null, symmetry: null, verdict: 'insufficient-range' });
    const m = metricsFromResults({ dynamics: [ok, ok, flat] });
    expect(m['dynamics.rangeDb']).toBe(22);
    expect(m['dynamics.absSlopeCentsPerDb']).toBeCloseTo(0.4, 9);
    expect(m['dynamics.symmetry']).toBe(0.9);
    const mostly = metricsFromResults({ dynamics: [ok, flat, flat] });
    expect('dynamics.absSlopeCentsPerDb' in mostly).toBe(false);
    expect(mostly['dynamics.symmetry']).toBe(0);
  });

  it('never produces NaN, Infinity or a non-number, even from degenerate inputs, and the result survives a JSON round trip', () => {
    const nan = accuracy({ voicedSec: 0, biasCents: NaN, medianAbsCents: NaN, inTolerancePct: NaN, sdCents: NaN, driftCentsPerSec: NaN, coverage: NaN });
    const m = metricsFromResults({
      accuracy: [nan, nan],
      onset: [onset({ onsetT: null, settleMs: null, crisp: false })],
      dynamics: [dyn({ rangeDb: NaN, slopeCentsPerDb: NaN })],
      pulse: [pulse({ rateErrorHz: NaN })],
    });
    for (const v of Object.values(m)) expect(Number.isFinite(v)).toBe(true);
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });

  it('empty arrays behave like an analyzer that did not run', () => {
    expect(Object.keys(metricsFromResults({ accuracy: [], onset: [], vibrato: [], pulse: [], dynamics: [], run: [], transitions: [], phrases: [] }))).toEqual([]);
  });
});

describe('scoreExercise', () => {
  it('a perfect metric against best=100/worst=0 scores 1.0 and passes', () => {
    const outcome = scoreExercise(minimalDef(), { 'accuracy.inTolerancePct': 100 });
    expect(outcome.score).toBe(1);
    expect(outcome.passed).toBe(true);
    expect(outcome.mastery).toBe(3); // >= studio (0.95)
    expect(outcome.failedGates).toEqual([]);
  });

  it('linearly interpolates between worst and best, clamped', () => {
    const def = minimalDef();
    expect(scoreExercise(def, { 'accuracy.inTolerancePct': 50 }).score).toBeCloseTo(0.5, 6);
    expect(scoreExercise(def, { 'accuracy.inTolerancePct': -50 }).score).toBe(0); // clamped below worst
    expect(scoreExercise(def, { 'accuracy.inTolerancePct': 150 }).score).toBe(1); // clamped above best
  });

  it('handles a lower-is-better term (best < worst)', () => {
    const def = minimalDef({ scoring: [{ metric: 'onset.settleMs', weight: 1, best: 0, worst: 400 }] });
    expect(scoreExercise(def, { 'onset.settleMs': 0 }).score).toBe(1);
    expect(scoreExercise(def, { 'onset.settleMs': 400 }).score).toBe(0);
    expect(scoreExercise(def, { 'onset.settleMs': 200 }).score).toBeCloseTo(0.5, 6);
    expect(scoreExercise(def, { 'onset.settleMs': 900 }).score).toBe(0);
  });

  it('a degenerate band (best == worst) scores 1 only at exactly that value', () => {
    const def = minimalDef({ scoring: [{ metric: 'vibrato.present', weight: 1, best: 1, worst: 1 }] });
    expect(scoreExercise(def, { 'vibrato.present': 1 }).score).toBe(1);
    expect(scoreExercise(def, { 'vibrato.present': 0.9 }).score).toBe(0);
  });

  it('a metric that was never computed scores 0 but KEEPS its weight (it does not quietly drop out of the average)', () => {
    const def = minimalDef({
      scoring: [
        { metric: 'accuracy.inTolerancePct', weight: 3, best: 100, worst: 0 },
        { metric: 'onset.settleMs', weight: 1, best: 0, worst: 400 },
      ],
    });
    const outcome = scoreExercise(def, { 'accuracy.inTolerancePct': 80 });
    expect(outcome.score).toBeCloseTo((3 * 0.8 + 1 * 0) / 4, 6); // 0.6, not 0.8
    expect(outcome.terms[1]).toEqual({ metric: 'onset.settleMs', weight: 1, value: null, score: 0 });
    expect(outcome.terms[0].score).toBeCloseTo(0.8, 9);
    expect(outcome.terms[0].value).toBe(80);
  });

  it('a non-finite metric scores 0 and fails a gate (an unmeasurable value never passes you)', () => {
    const def = minimalDef({ pass: { score: 0.5, gates: [{ metric: 'accuracy.inTolerancePct', op: '>=', value: 10 }] } });
    for (const bad of [NaN, Infinity, -Infinity]) {
      const outcome = scoreExercise(def, { 'accuracy.inTolerancePct': bad });
      expect(outcome.score).toBe(0);
      expect(outcome.passed).toBe(false);
      expect(outcome.failedGates).toEqual([0]);
      expect(outcome.terms[0].value).toBeNull();
    }
  });

  it('a failed gate fails the exercise even with a high score, and is reported by index', () => {
    const def = minimalDef({ pass: { score: 0.5, gates: [{ metric: 'onset.scoopCents', op: '<=', value: 30 }] } });
    const outcome = scoreExercise(def, { 'accuracy.inTolerancePct': 100, 'onset.scoopCents': 50 });
    expect(outcome.score).toBe(1);
    expect(outcome.passed).toBe(false);
    expect(outcome.mastery).toBe(0);
    expect(outcome.failedGates).toEqual([0]);
  });

  it('a gate on a metric that was never computed fails closed', () => {
    const def = minimalDef({ pass: { score: 0.5, gates: [{ metric: 'onset.scoopCents', op: '<=', value: 30 }] } });
    const outcome = scoreExercise(def, { 'accuracy.inTolerancePct': 100 });
    expect(outcome.passed).toBe(false);
    expect(outcome.failedGates).toEqual([0]);
  });

  it('both gate operators, inclusive at the boundary', () => {
    const def = minimalDef({
      pass: {
        score: 0,
        gates: [
          { metric: 'accuracy.inTolerancePct', op: '>=', value: 60 },
          { metric: 'onset.scoopCents', op: '<=', value: 30 },
        ],
      },
    });
    expect(scoreExercise(def, { 'accuracy.inTolerancePct': 60, 'onset.scoopCents': 30 }).passed).toBe(true);
    const fail = scoreExercise(def, { 'accuracy.inTolerancePct': 59.9, 'onset.scoopCents': 30.1 });
    expect(fail.failedGates).toEqual([0, 1]);
  });

  it('mastery tiers: 1 (pass) / 2 (solid) / 3 (studio), 0 when it did not pass', () => {
    const def = minimalDef({ pass: { score: 0.5 }, tiers: { solid: 0.8, studio: 0.95 } });
    expect(scoreExercise(def, { 'accuracy.inTolerancePct': 40 }).mastery).toBe(0);
    expect(scoreExercise(def, { 'accuracy.inTolerancePct': 60 }).mastery).toBe(1);
    expect(scoreExercise(def, { 'accuracy.inTolerancePct': 85 }).mastery).toBe(2);
    expect(scoreExercise(def, { 'accuracy.inTolerancePct': 97 }).mastery).toBe(3);
  });

  it('a score that is exactly the threshold passes despite float noise (0.6 computed as 0.5999999999999999)', () => {
    const def = minimalDef({
      scoring: [
        { metric: 'accuracy.inTolerancePct', weight: 0.35, best: 100, worst: 0 },
        { metric: 'accuracy.medianAbsCents', weight: 0.3, best: 0, worst: 100 },
        { metric: 'onset.settleMs', weight: 0.35, best: 0, worst: 100 },
      ],
      pass: { score: 0.6 },
    });
    const outcome = scoreExercise(def, { 'accuracy.inTolerancePct': 60, 'accuracy.medianAbsCents': 40, 'onset.settleMs': 40 });
    expect(Math.abs(outcome.score - 0.6)).toBeLessThan(1e-12);
    expect(outcome.passed).toBe(true);
  });

  it('no scoring terms computed at all scores 0 and does not throw; an exercise with no terms scores 0', () => {
    const outcome = scoreExercise(minimalDef(), {});
    expect(outcome.score).toBe(0);
    expect(outcome.passed).toBe(false);
    expect(scoreExercise(minimalDef({ scoring: [] }), { 'accuracy.inTolerancePct': 100 }).score).toBe(0);
  });

  it('per-term outcomes let the report find the weakest metric', () => {
    const def = minimalDef({
      scoring: [
        { metric: 'accuracy.inTolerancePct', weight: 1, best: 100, worst: 0 },
        { metric: 'onset.settleMs', weight: 1, best: 0, worst: 400 },
        { metric: 'onset.scoopCents', weight: 1, best: 0, worst: 60 },
      ],
    });
    const outcome = scoreExercise(def, { 'accuracy.inTolerancePct': 95, 'onset.settleMs': 300, 'onset.scoopCents': 6 });
    const weakest = outcome.terms.reduce((a, b) => (b.score < a.score ? b : a));
    expect(weakest.metric).toBe('onset.settleMs');
  });
});

/**
 * An independent reference written straight from the documented semantics (NOT calling scoreExercise): a term maps worst -> 0 and
 * best -> 1 linearly and clamped; the score is the weight-normalised sum; a missing or non-finite metric scores 0 and keeps its weight and
 * fails any gate on it. exercises/evaluate.ts now delegates its score/pass/mastery to scoreExercise, so this oracle is what keeps the
 * scorer honest against the written rules.
 */
function oracle(def: ExerciseDef, metrics: Metrics): { score: number; passed: boolean; failedGates: number[]; mastery: number } {
  let num = 0;
  let den = 0;
  for (const t of def.scoring) {
    const v = metrics[t.metric];
    let s = 0;
    if (v !== undefined && Number.isFinite(v)) {
      if (t.best === t.worst) s = v === t.best ? 1 : 0;
      else s = Math.min(1, Math.max(0, (v - t.worst) / (t.best - t.worst)));
    }
    num += t.weight * s;
    den += t.weight;
  }
  const score = den > 0 ? num / den : 0;
  const failedGates: number[] = [];
  (def.pass.gates ?? []).forEach((g, i) => {
    const v = metrics[g.metric];
    const ok = v !== undefined && Number.isFinite(v) && (g.op === '<=' ? v <= g.value : v >= g.value);
    if (!ok) failedGates.push(i);
  });
  const passed = score >= def.pass.score - 1e-9 && failedGates.length === 0;
  const mastery = !passed ? 0 : score >= def.tiers.studio - 1e-9 ? 3 : score >= def.tiers.solid - 1e-9 ? 2 : 1;
  return { score, passed, failedGates, mastery };
}

describe('scoreExercise agrees with the documented rules (independent oracle) and with exercises/evaluate.ts', () => {
  /** A random metric set for `def`: each key present or missing, in range, out of range, or non-finite. */
  function randomMetrics(def: ExerciseDef, rnd: () => number): Metrics {
    const keys = new Set<MetricKey>([...def.scoring.map((t) => t.metric), ...(def.pass.gates ?? []).map((g) => g.metric)]);
    const m: Metrics = {};
    for (const k of keys) {
      const term = def.scoring.find((t: ScoreTerm) => t.metric === k);
      const lo = term ? Math.min(term.best, term.worst) : 0;
      const hi = term ? Math.max(term.best, term.worst) : 100;
      const pick = rnd();
      if (pick < 0.12) continue; // missing
      if (pick < 0.17) m[k] = NaN;
      else if (pick < 0.22) m[k] = Infinity;
      else m[k] = lo - (hi - lo) * 0.3 + (hi - lo) * 1.6 * rnd();
    }
    return m;
  }

  it('gives the same score, pass/fail, failed gates and mastery as the oracle on every catalog exercise under randomized metrics', () => {
    const rnd = seededRandom(20261021);
    let compared = 0;
    for (const def of EXERCISES) {
      for (let i = 0; i < 40; i++) {
        const metrics = randomMetrics(def, rnd);
        const mine = scoreExercise(def, metrics);
        const ref = oracle(def, metrics);
        expect(mine.score, `${def.id} #${i}`).toBeCloseTo(ref.score, 9);
        expect(mine.passed, `${def.id} #${i}`).toBe(ref.passed);
        expect(mine.failedGates, `${def.id} #${i}`).toEqual(ref.failedGates);
        expect(mine.mastery, `${def.id} #${i}`).toBe(ref.mastery);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(500);
  });

  it('exercises/evaluate.ts (which delegates to scoreExercise and recomputes the failed gates itself) agrees on everything', () => {
    const rnd = seededRandom(7);
    for (const def of EXERCISES) {
      for (let i = 0; i < 20; i++) {
        const metrics = randomMetrics(def, rnd);
        const mine = scoreExercise(def, metrics);
        const theirs = evaluate(def, metrics);
        expect(mine.score, `${def.id} #${i}`).toBeCloseTo(theirs.score, 9);
        expect(mine.passed, `${def.id} #${i}`).toBe(theirs.passed);
        expect(mine.failedGates, `${def.id} #${i}`).toEqual(theirs.failedGates);
        expect(mine.mastery, `${def.id} #${i}`).toBe(theirs.mastery);
      }
    }
  });

  it('a perfect singer (every scored metric at its best, every gate satisfied) passes every catalog exercise at the top tier', () => {
    for (const def of EXERCISES) {
      const m: Metrics = {};
      // metrics that are only gated get a value that satisfies the gate; metrics that are scored get their best value
      for (const g of def.pass.gates ?? []) m[g.metric] = g.op === '<=' ? g.value - 1e-6 : g.value + 1e-6;
      for (const t of def.scoring) m[t.metric] = t.best;
      const out = scoreExercise(def, m);
      expect(out.failedGates, def.id).toEqual([]); // best must satisfy every gate on a scored metric, or the catalog contradicts itself
      expect(out.score, def.id).toBeCloseTo(1, 9);
      expect(out.passed, def.id).toBe(true);
      expect(out.mastery, def.id).toBe(3);
    }
  });

  it('a singer who produced nothing measurable fails every catalog exercise', () => {
    for (const def of EXERCISES) {
      const out = scoreExercise(def, {});
      expect(out.score, def.id).toBe(0);
      expect(out.passed, def.id).toBe(false);
      expect(out.mastery, def.id).toBe(0);
    }
  });
});
