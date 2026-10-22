/**
 * Generic scoring glue the exercise runner calls after analyzing a take:
 * flatten whichever analyzers ran into the Metrics vocabulary
 * (metricsFromResults), then score an ExerciseDef against those metrics
 * (scoreExercise). Both are pure; neither knows which analyzers exist
 * beyond what's passed in.
 *
 * Semantics agree with src/exercises/evaluate.ts (the exercise-side
 * reference): a term maps its metric linearly worst -> 0 / best -> 1 and is
 * clamped; the score is the weight-normalised sum; a MISSING or non-finite
 * metric scores 0 and fails any gate on it -- an analyzer that could not
 * measure something never passes you.
 */
import { clamp01 } from '../core/math';
import type { ExerciseDef } from '../exercises/types';
import { combineInflectionScores } from './inflections';
import type {
  AccuracyResult,
  CrackEvent,
  DynamicsResult,
  GlideResult,
  InflectionResult,
  Metrics,
  MetricKey,
  OnsetResult,
  PhraseScore,
  RangeResult,
  RunResult,
  TransitionResult,
  VibratoResult,
} from './types';
import type { PulseResult } from './pulse';
import type { SwitchResult } from './switch';

type OneOrMany<T> = T | readonly T[];

/**
 * Whichever analyzers a given exercise ran -- all optional, since an exercise only runs the analyzers named in its `ExerciseDef.analyzers`.
 * A per-note analyzer (accuracy, onset, vibrato, pulse, dynamics, glide, inflection, run, switch) may be given ONE result or an ARRAY of them
 * (one per sung note / cue group / pulse train); see `metricsFromResults` for how they combine.
 */
export interface AnalyzerResults {
  /** An `AccuracyDetail` (accuracy.ts) is read for its `coverage`; a bare `AccuracyResult` is treated as fully covered. */
  accuracy?: OneOrMany<AccuracyResult & { coverage?: number }>;
  onset?: OneOrMany<OnsetResult>;
  vibrato?: OneOrMany<VibratoResult>;
  pulse?: OneOrMany<PulseResult>;
  switch?: OneOrMany<SwitchResult>;
  range?: RangeResult;
  dynamics?: OneOrMany<DynamicsResult>;
  glide?: OneOrMany<GlideResult>;
  /** detectCracks() over the whole take (the sirens' `cracks` analyzer). Combined with each glide's own cracks without double counting. */
  cracks?: readonly CrackEvent[];
  transitions?: OneOrMany<TransitionResult>;
  inflection?: OneOrMany<InflectionResult>;
  run?: OneOrMany<RunResult>;
  /** Song mode: per-phrase scores. */
  phrases?: readonly PhraseScore[];
}

function many<T>(x: OneOrMany<T> | undefined): readonly T[] {
  if (x === undefined) return [];
  return Array.isArray(x) ? (x as readonly T[]) : [x as T];
}

/** Median of the finite values; +Infinity entries count (as the worst); undefined when the list is empty or the median itself is not finite. */
function medianOrUndefined(values: readonly number[]): number | undefined {
  const xs = values.filter((v) => !Number.isNaN(v)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); // not a - b: Infinity - Infinity is NaN
  if (xs.length === 0) return undefined;
  const mid = xs.length >> 1;
  const m = xs.length % 2 === 0 ? (xs[mid - 1] + xs[mid]) / 2 : xs[mid];
  return Number.isFinite(m) ? m : undefined;
}

function meanOrUndefined(values: readonly number[]): number | undefined {
  const xs = values.filter(Number.isFinite);
  return xs.length === 0 ? undefined : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function set(m: Metrics, key: MetricKey, value: number | undefined): void {
  if (value !== undefined && Number.isFinite(value)) m[key] = value;
}

/**
 * Flattens whichever `results` are present into the MetricKey vocabulary.
 * A key is omitted (never NaN, never null) when its analyzer didn't run, or
 * ran but could not measure that facet. The scorer treats an omitted key as
 * "not achieved": score 0, failed gate.
 *
 * With a result ARRAY (several notes, windows or trains) the numbers combine
 * as follows -- a note that was missed counts against the take instead of
 * quietly dropping out of it:
 *  - magnitudes (cents, ms, Hz, dB, slopes): the MEDIAN over the notes they
 *    could be measured on; a note where the facet could not be measured (never
 *    settled, no pulses, too little range) counts as +Infinity, i.e. the
 *    worst, so a take that never managed it has no value for it;
 *  - shares (*Pct, *Rate, vibrato.present/inZone): the share of ALL notes;
 *  - counts (glide.cracks): summed over the take;
 *  - 0..1 scores (run, glide smoothness): the mean. inflection.score is half the mean and half the WORST figure
 *    (combineInflectionScores): a figure that was never sung cannot hide among several that were. One figure, or
 *    figures that all score alike, keep exactly that score.
 *
 * Units:
 *  - accuracy.inTolerancePct: 0..100, the mean over notes of (% of the held voiced time in tolerance x coverage). Coverage (0..1) is the fraction of
 *    the held window actually voiced: a note sung perfectly for a quarter of its length is 25%, a note never sung is 0. A start within a
 *    reaction time of the cue is not held against the note, a much later one is (the last second of a four-second hold is not a pass).
 *    accuracy.medianAbsCents / sdCents / absBiasCents: cents. absDriftCentsPerSec: cents/sec.
 *  - onset.settleMs: ms. scoopCents / overshootCents: cents. crispRate: 0..1 (share of notes that were crisp).
 *  - vibrato.present / inZone: 0..1 (share of notes or windows). rateHz: Hz. extentCents: cents (half peak-to-trough). regularity: 0..1.
 *    absCenteringCents: cents. All of these come from the notes where vibrato was present.
 *  - vibrato.switchCleanRate: 0..1 (clean cue changes / all cue changes). vibrato.bloomOnCue: 0..1 (the switch analyzer's bloom score).
 *  - pulse.rateErrorHz: |Hz| (absolute: a ScoreTerm's best/worst is one-directional). pulse.regularity: 0..1 (0 for a train with no measurable rhythm).
 *  - glide.smoothness: 0..1. endAbsCents: cents. cracks: count. transition.cleanRate: 0..1.
 *  - inflection.score: 0..1. landingAbsCents: cents.
 *  - run.score: 0..1. definedRate / missedRate: 0..1, share of all notes in the run.
 *  - dynamics.rangeDb: dB (relative to the take's own floor, never absolute). absSlopeCentsPerDb: cents/dB. symmetry: 0..1.
 *  - range.spanSemitones: semitones (highestMidi - lowestMidi).
 *  - song.phraseScore: 0..1. song.inTolerancePct: 0..100. Both duration-weighted over the phrases.
 */
export function metricsFromResults(results: AnalyzerResults): Metrics {
  const m: Metrics = {};

  const acc = many(results.accuracy);
  if (acc.length > 0) {
    set(m, 'accuracy.inTolerancePct', meanOrUndefined(acc.map((a) => (Number.isFinite(a.inTolerancePct) ? a.inTolerancePct * clamp01(a.coverage ?? 1) : 0))));
    set(m, 'accuracy.medianAbsCents', medianOrUndefined(acc.map((a) => a.medianAbsCents).filter(Number.isFinite)));
    set(m, 'accuracy.sdCents', medianOrUndefined(acc.map((a) => a.sdCents).filter(Number.isFinite)));
    set(m, 'accuracy.absBiasCents', medianOrUndefined(acc.map((a) => Math.abs(a.biasCents)).filter(Number.isFinite)));
    set(m, 'accuracy.absDriftCentsPerSec', medianOrUndefined(acc.filter((a) => a.driftCentsPerSec !== null).map((a) => Math.abs(a.driftCentsPerSec as number))));
  }

  const ons = many(results.onset);
  if (ons.length > 0) {
    set(m, 'onset.settleMs', medianOrUndefined(ons.map((o) => (o.settleMs !== null ? o.settleMs : Infinity))));
    const sung = ons.filter((o) => o.onsetT !== null);
    set(m, 'onset.scoopCents', medianOrUndefined(sung.map((o) => o.scoopCents)));
    set(m, 'onset.overshootCents', medianOrUndefined(sung.map((o) => o.overshootCents)));
    m['onset.crispRate'] = ons.filter((o) => o.crisp).length / ons.length;
  }

  const vib = many(results.vibrato);
  if (vib.length > 0) {
    m['vibrato.present'] = vib.filter((v) => v.present).length / vib.length;
    m['vibrato.inZone'] = vib.filter((v) => v.inZone).length / vib.length;
    const on = vib.filter((v) => v.present);
    set(m, 'vibrato.rateHz', medianOrUndefined(on.filter((v) => v.rateHz !== null).map((v) => v.rateHz as number)));
    set(m, 'vibrato.extentCents', medianOrUndefined(on.filter((v) => v.extentCents !== null).map((v) => v.extentCents as number)));
    set(m, 'vibrato.regularity', medianOrUndefined(on.filter((v) => v.regularity !== null).map((v) => v.regularity as number)));
    set(m, 'vibrato.absCenteringCents', medianOrUndefined(on.filter((v) => v.centeringCents !== null).map((v) => Math.abs(v.centeringCents as number))));
  }

  const sws = many(results.switch);
  if (sws.length > 0) {
    let boundaries = 0;
    let clean = 0;
    let blooms = 0;
    let bloomSum = 0;
    for (const s of sws) {
      boundaries += s.boundaries.length;
      clean += s.boundaries.filter((b) => b.clean).length;
      const n = s.boundaries.filter((b) => b.toVibrato).length;
      if (n > 0 && s.bloomOnCueScore !== null) {
        blooms += n;
        bloomSum += s.bloomOnCueScore * n;
      }
    }
    if (boundaries > 0) m['vibrato.switchCleanRate'] = clean / boundaries;
    if (blooms > 0) m['vibrato.bloomOnCue'] = bloomSum / blooms;
  }

  const pls = many(results.pulse);
  if (pls.length > 0) {
    set(m, 'pulse.rateErrorHz', medianOrUndefined(pls.map((p) => (p.rateErrorHz !== null ? Math.abs(p.rateErrorHz) : Infinity))));
    set(m, 'pulse.regularity', medianOrUndefined(pls.map((p) => p.regularity ?? 0)));
  }

  const gls = many(results.glide);
  if (gls.length > 0 || results.cracks !== undefined) {
    if (gls.length > 0) {
      set(m, 'glide.smoothness', meanOrUndefined(gls.map((g) => g.smoothness)));
      set(m, 'glide.endAbsCents', medianOrUndefined(gls.filter((g) => g.endErrorCents !== null).map((g) => Math.abs(g.endErrorCents as number))));
    }
    const perGlide = gls.reduce((n, g) => n + g.cracks.length, 0);
    m['glide.cracks'] = Math.max(perGlide, results.cracks?.length ?? 0);
  }

  const trs = many(results.transitions);
  if (trs.length > 0) {
    let total = 0;
    let weighted = 0;
    for (const t of trs) {
      const n = t.transitions.length;
      total += n;
      weighted += t.cleanRate * n;
    }
    if (total > 0) m['transition.cleanRate'] = weighted / total;
  }

  const infs = many(results.inflection);
  if (infs.length > 0) {
    set(m, 'inflection.score', combineInflectionScores(infs.map((i) => i.score))); // half the mean, half the worst figure: a skipped figure cannot hide in the mean
    set(m, 'inflection.landingAbsCents', meanOrUndefined(infs.filter((i) => i.landingAbsCents !== null).map((i) => i.landingAbsCents as number))); // already an abs median per its own doc
  }

  const runs = many(results.run);
  if (runs.length > 0) {
    set(m, 'run.score', meanOrUndefined(runs.map((r) => r.score)));
    let notes = 0;
    let defined = 0;
    let missed = 0;
    for (const r of runs) {
      notes += r.notes.length;
      defined += r.notes.filter((n) => n.verdict === 'defined').length;
      missed += r.notes.filter((n) => n.verdict === 'missed').length;
    }
    if (notes > 0) {
      m['run.definedRate'] = defined / notes;
      m['run.missedRate'] = missed / notes;
    }
  }

  const dyns = many(results.dynamics);
  if (dyns.length > 0) {
    set(m, 'dynamics.rangeDb', medianOrUndefined(dyns.map((d) => d.rangeDb)));
    set(m, 'dynamics.absSlopeCentsPerDb', medianOrUndefined(dyns.map((d) => (d.slopeCentsPerDb !== null ? Math.abs(d.slopeCentsPerDb) : Infinity))));
    set(m, 'dynamics.symmetry', medianOrUndefined(dyns.map((d) => d.symmetry ?? 0)));
  }

  const r = results.range;
  if (r && r.lowestMidi !== null && r.highestMidi !== null) set(m, 'range.spanSemitones', r.highestMidi - r.lowestMidi);

  const ph = results.phrases;
  if (ph && ph.length > 0) {
    let w = 0;
    let score = 0;
    let tol = 0;
    for (const p of ph) {
      const d = Math.max(0, p.end - p.start) || 1;
      w += d;
      score += d * p.pitchScore;
      tol += d * p.inTolerancePct;
    }
    set(m, 'song.phraseScore', score / w);
    set(m, 'song.inTolerancePct', tol / w);
  }

  return m;
}

/** Tolerance for comparing a float score with a threshold: a score of 0.6 computed as 0.5999999999999999 still passes a 0.6 rule. */
const SCORE_EPSILON = 1e-9;

/** Linear map from `worst` (-> 0) to `best` (-> 1), clamped. `best` may be < `worst` for a lower-is-better metric. */
export function valueScore(value: number, best: number, worst: number): number {
  if (best === worst) return value === best ? 1 : 0;
  return clamp01((value - worst) / (best - worst));
}

/** True when the gate holds. A metric that is missing or not finite never holds (an unmeasured take cannot pass). */
export function gateHolds(gate: { metric: MetricKey; op: '<=' | '>='; value: number }, metrics: Metrics): boolean {
  const v = metrics[gate.metric];
  return v !== undefined && Number.isFinite(v) && (gate.op === '<=' ? v <= gate.value : v >= gate.value);
}

/** One scoring term's contribution, for the take report ("your weakest metric is ...") and coaching. */
export interface TermOutcome {
  metric: MetricKey;
  weight: number;
  /** The measured value; null when the metric was missing or not finite. */
  value: number | null;
  /** 0..1 for this term alone (0 when the value is missing). */
  score: number;
}

export interface ScoreOutcome {
  /** 0..1: each term's value linearly mapped worst->best (clamped), weight-averaged. A missing metric contributes 0 but keeps its weight. */
  score: number;
  /** `score >= def.pass.score` AND every one of `def.pass.gates` held. A gate on a metric that never got computed fails. */
  passed: boolean;
  /** 0 (didn't pass) .. 3 (studio), from def.tiers once passed. */
  mastery: 0 | 1 | 2 | 3;
  /** Indices into `def.pass.gates` of the gates that did not hold. */
  failedGates: number[];
  /** Every scoring term with its value and 0..1 score, in `def.scoring` order. */
  terms: TermOutcome[];
}

/** scoreExercise(def, metrics) -- the generic scorer every exercise runner calls after metricsFromResults(...). */
export function scoreExercise(def: ExerciseDef, metrics: Metrics): ScoreOutcome {
  let weightedSum = 0;
  let weightTotal = 0;
  const terms: TermOutcome[] = def.scoring.map((term) => {
    const raw = metrics[term.metric];
    const value = raw !== undefined && Number.isFinite(raw) ? raw : null;
    const score = value === null ? 0 : valueScore(value, term.best, term.worst);
    weightedSum += term.weight * score;
    weightTotal += term.weight;
    return { metric: term.metric, weight: term.weight, value, score };
  });
  const score = weightTotal > 0 ? clamp01(weightedSum / weightTotal) : 0;

  const gates = def.pass.gates ?? [];
  const failedGates: number[] = [];
  gates.forEach((g, i) => {
    if (!gateHolds(g, metrics)) failedGates.push(i);
  });
  const passed = score >= def.pass.score - SCORE_EPSILON && failedGates.length === 0;

  let mastery: 0 | 1 | 2 | 3 = 0;
  if (passed) {
    mastery = score >= def.tiers.studio - SCORE_EPSILON ? 3 : score >= def.tiers.solid - SCORE_EPSILON ? 2 : 1;
  }
  return { score, passed, mastery, failedGates, terms };
}
