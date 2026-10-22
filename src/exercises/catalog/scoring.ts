/**
 * Score bands and gates for the catalog, by tolerance tier. A level's tier
 * (CONFIG.tolerance: easy ±50, default ±25, studio ±10) sets both how strict
 * the analyzers are and which band each metric is scored against, so one
 * skill gets stricter as a world progresses.
 *
 * Calibration model (PROVISIONAL until tuned on the real-voice corpus): four
 * typical singers per skill, POPULATION below: B struggling beginner, D
 * developing, A competent amateur, T trained. Held notes, for example: bias /
 * spread B 20/30¢, D 10/20¢, A 6/13¢, T 3/8¢ (trained singers are ~30-40¢ off
 * on melodies and ±10 is an elite bar, RESEARCH §6), and in-tune time also
 * counts the share of each note actually voiced (~93% with natural breaths).
 * Each tier has an entry singer L and the next one up U (easy B->D, default
 * D->A, studio A->T), and every band is DERIVED: [best, worst] =
 * [U, 2.5·L − 1.5·U], clamped to the metric's domain. So L scores ~0.6, the
 * usual pass mark, and U scores 1, the studio tally. Tuning means editing the
 * typical values; calibration.test.ts checks every level against them.
 *
 * Gates are floors, not the main criterion: a gate sits a quarter of the way
 * up its band (GATE_POINT), so a take that all but fails one judged aspect
 * can't pass on the others; a world's defining skill is gated half way up
 * (CORE_POINT). A gate on an unmeasured metric fails (evaluate.ts).
 *
 * POPULATION, GATE_POINT, CORE_POINT and RANGE_MIN_SPAN are proposed
 * CONFIG.scoring knobs.
 */
import { CONFIG } from '../../config';
import type { ToleranceLevel } from '../../core/types';
import type { MetricKey } from '../../analysis/types';
import { METRIC_INFO } from '../metrics';
import type { PassRule, ScoreTerm } from '../types';

export type Band = readonly [best: number, worst: number];
type Gate = NonNullable<PassRule['gates']>[number];

/** Metrics the catalog may score (song.* belong to Song Stage; vibrato rate/extent are two-sided, judged via inZone). */
export type ScoredMetric = Exclude<MetricKey, 'song.phraseScore' | 'song.inTolerancePct' | 'vibrato.rateHz' | 'vibrato.extentCents'>;

export type Population = 'B' | 'D' | 'A' | 'T';
type ByPop = Readonly<Record<Population, number>>;
type ByTier = Readonly<Record<ToleranceLevel, ByPop>>;

/** Entry singer and next singer up, per tier. */
export const ENTRY: Readonly<Record<ToleranceLevel, Population>> = { easy: 'B', default: 'D', studio: 'A' };
export const NEXT: Readonly<Record<ToleranceLevel, Population>> = { easy: 'D', default: 'A', studio: 'T' };

const S = CONFIG.onset.settleTargetMs;

/**
 * Typical take-level values of each singer, in the metric's stored units.
 * Values measured against the level's tolerance (time in the band, settling
 * into it, clean note changes) are given per tier.
 */
export const POPULATION: Readonly<Record<ScoredMetric, ByPop | ByTier>> = {
  'accuracy.inTolerancePct': {
    easy: { B: 77, D: 91, A: 93, T: 93 },
    default: { B: 46, D: 68, A: 85, T: 93 },
    studio: { B: 20, D: 32, A: 48, T: 70 },
  },
  'accuracy.medianAbsCents': { B: 25, D: 15, A: 10, T: 6 },
  'accuracy.sdCents': { B: 30, D: 20, A: 13, T: 8 },
  'accuracy.absBiasCents': { B: 20, D: 10, A: 6, T: 3 },
  'accuracy.absDriftCentsPerSec': { B: 7, D: 4.5, A: 2.5, T: 1.5 },
  // The entry singer of each tier settles in exactly CONFIG.onset.settleTargetMs.
  'onset.settleMs': {
    easy: { B: S.easy, D: S.easy * 0.6, A: 150, T: 100 },
    default: { B: 600, D: S.default, A: S.default * 0.6, T: 90 },
    studio: { B: 900, D: 400, A: S.studio, T: S.studio * 0.6 },
  },
  'onset.scoopCents': { B: 50, D: 30, A: 15, T: 8 },
  'onset.overshootCents': { B: 35, D: 20, A: 10, T: 5 },
  'onset.crispRate': { B: 0.15, D: 0.35, A: 0.6, T: 0.85 },
  'vibrato.present': { B: 0.2, D: 0.6, A: 0.9, T: 1 },
  'vibrato.inZone': { B: 0.1, D: 0.4, A: 0.7, T: 0.9 },
  'vibrato.regularity': { B: 0.3, D: 0.5, A: 0.7, T: 0.85 },
  'vibrato.absCenteringCents': { B: 25, D: 15, A: 8, T: 4 },
  'vibrato.switchCleanRate': { B: 0.3, D: 0.6, A: 0.8, T: 0.95 },
  'vibrato.bloomOnCue': { B: 0.2, D: 0.5, A: 0.75, T: 0.9 },
  'pulse.rateErrorHz': { B: 1, D: 0.6, A: 0.3, T: 0.15 },
  'pulse.regularity': { B: 0.5, D: 0.65, A: 0.8, T: 0.9 },
  'glide.smoothness': { B: 0.22, D: 0.37, A: 0.51, T: 0.66 },
  'glide.endAbsCents': { B: 60, D: 35, A: 20, T: 10 },
  'glide.cracks': { B: 3, D: 2, A: 1, T: 0 },
  'transition.cleanRate': {
    easy: { B: 0.5, D: 0.7, A: 0.9, T: 0.97 },
    default: { B: 0.3, D: 0.55, A: 0.8, T: 0.92 },
    studio: { B: 0.1, D: 0.3, A: 0.55, T: 0.8 },
  },
  'inflection.score': { B: 0.4, D: 0.55, A: 0.7, T: 0.85 },
  'inflection.landingAbsCents': { B: 40, D: 25, A: 15, T: 8 },
  'run.score': { B: 0.55, D: 0.7, A: 0.82, T: 0.92 },
  'run.definedRate': { B: 0.5, D: 0.7, A: 0.85, T: 0.95 },
  'run.missedRate': { B: 0.2, D: 0.1, A: 0.05, T: 0.02 },
  'dynamics.rangeDb': { B: 11, D: 13, A: 16, T: 22 },
  'dynamics.absSlopeCentsPerDb': { B: 2.5, D: 1.5, A: 0.8, T: 0.4 },
  'dynamics.symmetry': { B: 0.4, D: 0.55, A: 0.7, T: 0.85 },
  // A first, timid sweep; the band is RANGE_BAND, not derived from this row (the Range finder measures, it doesn't grade).
  'range.spanSemitones': { B: 10, D: 13, A: 16, T: 20 },
};

/** A singer's typical value of `metric` on a level of tier `tol`. */
export function populationValue(metric: ScoredMetric, tol: ToleranceLevel, pop: Population): number {
  const row = POPULATION[metric];
  return 'easy' in row ? row[tol][pop] : row[pop];
}

/** Standard mastery tally thresholds (light 1 = pass). */
export const TIERS = { solid: 0.8, studio: 0.92 } as const;
/** The usual pass mark: a tier's entry singer scores about this. */
export const PASS = 0.6;

/**
 * Range finder: the measured span must reach an octave. That is both the
 * widest material in the catalog and the span of the Range finder's own guide
 * bars (validate.ts checks both against this gate), so every exercise fits any
 * range the Range finder saves without folding notes by octaves, and a singer
 * who holds exactly the guides passes.
 */
export const RANGE_MIN_SPAN = 12;
/** An untrained male's comfortable C3-E4 (16 semitones) is full marks. */
const RANGE_FULL_MARKS = 16;
/**
 * Range span is a measurement, not a skill tier: one band for every tier, with
 * RANGE_MIN_SPAN on the pass mark and RANGE_FULL_MARKS at 1, so the standard
 * tallies read pass = an octave, solid = 14, studio = 16 (worst = 6).
 */
const RANGE_BAND: Band = [RANGE_FULL_MARKS, RANGE_FULL_MARKS - (RANGE_FULL_MARKS - RANGE_MIN_SPAN) / (1 - PASS)];

function deriveBand(metric: ScoredMetric, tol: ToleranceLevel): Band {
  if (metric === 'range.spanSemitones') return RANGE_BAND;
  const L = populationValue(metric, tol, ENTRY[tol]);
  const U = populationValue(metric, tol, NEXT[tol]);
  // A count's only perfect value is zero; the entry singer's count still scores 0.6.
  if (metric === 'glide.cracks') return [0, 2.5 * L];
  const info = METRIC_INFO[metric];
  const worst = Math.min(info.max, Math.max(info.min, 2.5 * L - 1.5 * U));
  return [U, worst];
}

const TIERS_LIST: readonly ToleranceLevel[] = ['easy', 'default', 'studio'];

/** [best, worst] per tier and metric, derived from POPULATION. */
export const SCORE_BANDS: Readonly<Record<ToleranceLevel, Readonly<Record<ScoredMetric, Band>>>> = Object.fromEntries(
  TIERS_LIST.map((tol) => [tol, Object.fromEntries((Object.keys(POPULATION) as ScoredMetric[]).map((m) => [m, deriveBand(m, tol)]))]),
) as Record<ToleranceLevel, Record<ScoredMetric, Band>>;

/** Default gates sit this far up the band from `worst` (0 = worst, 1 = best). */
export const GATE_POINT = 0.25;
/**
 * A world's defining skill (every run note distinct, a slide or flip landing
 * centred) is gated half way up its band: just under where the tier's entry
 * singer scores (0.6), so excelling at everything else can't carry it.
 */
export const CORE_POINT = 0.5;
/** "Most notes": gates on 0/1 shares such as vibrato.present. */
export const MOST = 0.5;

/** Round a gate value to a readable precision. */
function nice(v: number): number {
  const a = Math.abs(v);
  const p = a < 1 ? 100 : a < 10 ? 10 : 1;
  return Math.round(v * p) / p;
}

export function band(metric: ScoredMetric, tol: ToleranceLevel): Band {
  return SCORE_BANDS[tol][metric];
}

/** One weighted term on the tier's band. */
export function term(metric: ScoredMetric, tol: ToleranceLevel, weight: number): ScoreTerm {
  const [best, worst] = band(metric, tol);
  return { metric, weight, best, worst };
}

/** Weighted terms on the tier's bands, in the given order. */
export function terms(tol: ToleranceLevel, weights: Readonly<Partial<Record<ScoredMetric, number>>>): ScoreTerm[] {
  return (Object.entries(weights) as Array<[ScoredMetric, number]>).map(([m, w]) => term(m, tol, w));
}

/** The tier's gate on `metric`, `point` of the way up its band (default GATE_POINT), in the metric's better direction. */
export function gate(metric: ScoredMetric, tol: ToleranceLevel, point: number = GATE_POINT): Gate {
  const [best, worst] = band(metric, tol);
  const value = nice(worst + point * (best - worst));
  return { metric, op: best >= worst ? '>=' : '<=', value };
}

/** A gate with an explicit value. */
export function gateAt(metric: MetricKey, op: '<=' | '>=', value: number): Gate {
  return { metric, op, value };
}

/** dynamics.rangeDb must reach CONFIG.dynamics.minRangeDb, below which the analyzer can't judge pitch vs loudness. */
export const swellRangeGate = (): Gate => gateAt('dynamics.rangeDb', '>=', CONFIG.dynamics.minRangeDb);

/**
 * A scoop gate no stricter than the onset analyzer's own "crisp" limit
 * (CONFIG.onset.crispMaxScoopCents). The scoop is the lowest raw frame in the
 * opening 150 ms, so frame jitter alone reads as ~2 sigma of scoop; a studio
 * gate below the crisp limit would fail clean singers on a noisy mic.
 */
export const crispScoopGate = (): Gate => gateAt('onset.scoopCents', '<=', CONFIG.onset.crispMaxScoopCents);

/**
 * For levels that judge a technique (pulses, vibrato, loudness) and score centring only lightly: the centre must
 * still sit inside the level's own tolerance (CONFIG.tolerance: ±50 easy, ±25 default, ±10 studio), because the
 * tolerance is set by the level (SPEC §11). It is the level's in-tune band rather than a band-derived gate: on a
 * pulse train the bumps lift the measured centre a few cents, which a tighter gate would mistake for a centring
 * error.
 */
export const onTheNote = (metric: 'accuracy.absBiasCents' | 'vibrato.absCenteringCents', tol: ToleranceLevel): Gate =>
  gateAt(metric, '<=', CONFIG.tolerance[tol]);
