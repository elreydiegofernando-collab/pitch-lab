/**
 * Scoring for ExerciseDefs. The canonical scorer is analysis/score.ts's
 * scoreExercise (the one the runner calls); evaluate() delegates to it, so
 * there is one source of truth, and adds what the exercise UI needs: failed
 * gates, per-term scores (tips.ts), the pass requirements shown before
 * singing ("Pass: 70% in tune, settle < 150 ms", DESIGN §10) and the 2-4
 * take-report tiles.
 *
 * Shared semantics:
 *  - a term maps its metric linearly from `worst` (0) to `best` (1), clamped;
 *  - the score is the weight-normalised mean of the terms; an unmeasured
 *    metric scores 0 and keeps its weight;
 *  - a gate on an unmeasured metric fails, so a take its analyzers could not
 *    measure never passes. Every exercise also gates its core metric
 *    (validate.ts), so excelling elsewhere can't hide a missing core skill;
 *  - given the take (analyzeTake's result), a realization that had to fold
 *    notes by octaves, or lost a figure doing so, never passes: what was sung
 *    was not the exercise (validate.ts keeps every exercise inside the
 *    narrowest range the Range finder saves, so only a bad saved range folds);
 *  - a take stopped before the end of the material (TakeConditions.complete
 *    false) is practice, never judged; and a take that left notes unsung
 *    (TakeConditions.reach, analyze.ts noteReach) never passes: the analyzers
 *    measure what WAS sung, so without these a take could pass on its first
 *    half (a Boss Recital, an audition test that grants levels).
 */
import { gateHolds, scoreExercise, valueScore } from '../analysis/score';
import type { MetricKey, Metrics } from '../analysis/types';
import type { Mastery } from '../progress/types';
import { formatMetric, METRIC_INFO } from './metrics';
import type { RealizedExercise } from './transpose';
import type { ExerciseDef, ScoreTerm } from './types';

/** True when the gate holds; an unmeasured (missing or non-finite) metric fails. The same rule the scorer applies. */
export { gateHolds };

/** 0..1 for one term, or null when the metric was not measured (it then scores 0). */
export function termScore(term: ScoreTerm, value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  return valueScore(value, term.best, term.worst);
}

/** How many of a take's target notes were sung at all (analyze.ts noteReach). */
export interface NoteReach {
  reached: number;
  total: number;
  /** Take time the last reached note ends (0 when none was): where the singing stopped, for a take that went quiet. */
  lastReachedEnd?: number;
}

/**
 * Why a take was not judged: 'folded' = the realization folded notes by octaves (or broke a figure), so what was sung
 * was not the exercise; 'stopped' = the singer stopped before the end of the material, so the take is practice only.
 */
export type NotJudgedReason = 'folded' | 'stopped';

export interface Evaluation {
  score: number;
  passed: boolean;
  mastery: Mastery;
  /** Gates that failed, by index into def.pass.gates. */
  failedGates: number[];
  /** Set when the take could not count at all (TakeConditions): the score is shown, but it never passes. */
  notJudged?: NotJudgedReason;
  /** Set when the take left too many notes unsung to pass (reachHolds): how many of them were sung. */
  unsung?: NoteReach;
}

/** How the take was realized (an analyzeTake result is one): what the pass depends on besides the metrics. */
export interface TakeConditions {
  /** RealizedExercise.fit: 'folded' moved notes by octaves to squeeze the material into too narrow a range. */
  fit?: RealizedExercise['fit'];
  /** AnalysisPlan.issues: figures the realization broke (a flip folded into a drop), so they were never judged. */
  plan?: { readonly issues: readonly string[] };
  /** False when the take ended before the material did (Stop while singing): it is practice, never judged. */
  complete?: boolean;
  /** How many of the target notes were sung (analyze.ts noteReach); too few, and the take cannot pass (reachHolds). */
  reach?: NoteReach;
}

/** A take passes only when at least this share of its notes were sung (every note in a Boss Recital). PROPOSED CONFIG.exercises. */
export const MIN_REACH_SHARE = 0.9;

/**
 * True when enough of the take's notes were sung for it to pass: every note of a Boss Recital, and at least
 * MIN_REACH_SHARE of them elsewhere. The Range finder measures rather than asks for notes (any honest exploration of
 * the voice passes it), so it is exempt; a take with no notes has nothing to miss.
 */
export function reachHolds(def: Pick<ExerciseDef, 'kind'>, reach: NoteReach): boolean {
  return reach.reached >= notesNeeded(def, reach.total);
}

/**
 * How many of `total` target notes a take must sing to pass (reachHolds): every note of a Boss Recital or of an
 * exercise with fewer than ten notes, at least MIN_REACH_SHARE of a longer one; none for the Range finder.
 */
export function notesNeeded(def: Pick<ExerciseDef, 'kind'>, total: number): number {
  if (def.kind === 'range-finder' || total <= 0) return 0;
  if (def.kind === 'boss-recital') return total;
  return Math.ceil(MIN_REACH_SHARE * total - 1e-9);
}

/** True when `take` was not the exercise as written: folded by octaves, or with figures dropped. */
export function isFolded(take: TakeConditions): boolean {
  return take.fit === 'folded' || (take.plan?.issues.length ?? 0) > 0;
}

/**
 * Score, pass/fail, mastery tier and failed gates of an attempt. A metric that is missing or NaN counts as not
 * measured. Pass the take (`evaluate(def, a.metrics, a)`) so a folded realization, or a take that left notes unsung,
 * can never pass; the runner adds `complete: false` for a take stopped before its end.
 */
export function evaluate(def: ExerciseDef, metrics: Metrics, take?: TakeConditions): Evaluation {
  const { score, passed, mastery, failedGates } = scoreExercise(def, metrics);
  if (take !== undefined && isFolded(take)) return { score, passed: false, mastery: 0, failedGates, notJudged: 'folded' };
  if (take?.complete === false) return { score, passed: false, mastery: 0, failedGates, notJudged: 'stopped' };
  if (take?.reach !== undefined && !reachHolds(def, take.reach)) {
    return { score, passed: false, mastery: 0, failedGates, unsung: { ...take.reach } };
  }
  return { score, passed, mastery, failedGates };
}

/** One requirement line, e.g. "In tune ≥ 55%". metric null = the overall score. */
export interface Requirement {
  metric: MetricKey | null;
  text: string;
}

/** What the level screen shows before singing: the overall score, then each gate. */
export function passRequirements(def: ExerciseDef): Requirement[] {
  const out: Requirement[] = [{ metric: null, text: `Score ≥ ${Math.round(def.pass.score * 100)}%` }];
  for (const g of def.pass.gates ?? []) {
    out.push({ metric: g.metric, text: `${METRIC_INFO[g.metric].label} ${g.op === '>=' ? '≥' : '≤'} ${formatMetric(g.metric, g.value)}` });
  }
  return out;
}

export interface ReportTile {
  metric: MetricKey;
  label: string;
  /** Null when the take could not measure it. */
  value: number | null;
  display: string;
  /** The value to reach: the gate's, or the value at which this term scores the level's pass mark. */
  target: number;
  targetDisplay: string;
  op: '>=' | '<=';
  /** Null when not measured. */
  met: boolean | null;
}

/** The 2-4 take-report tiles: gated metrics first, then the heaviest-weighted terms. */
export function reportTiles(def: ExerciseDef, metrics: Metrics, max = 4): ReportTile[] {
  const tiles: ReportTile[] = [];
  const seen = new Set<MetricKey>();
  const push = (metric: MetricKey, target: number, op: '>=' | '<=') => {
    if (seen.has(metric) || tiles.length >= max) return;
    seen.add(metric);
    const raw = metrics[metric];
    const value = raw !== undefined && Number.isFinite(raw) ? raw : null;
    tiles.push({
      metric,
      label: METRIC_INFO[metric].label,
      value,
      display: value === null ? '–' : formatMetric(metric, value),
      target,
      targetDisplay: formatMetric(metric, target),
      op,
      met: value === null ? null : op === '>=' ? value >= target : value <= target,
    });
  };
  for (const g of def.pass.gates ?? []) push(g.metric, g.value, g.op);
  const byWeight = [...def.scoring].sort((a, b) => b.weight - a.weight);
  for (const t of byWeight) {
    const target = t.worst + def.pass.score * (t.best - t.worst);
    push(t.metric, target, t.best >= t.worst ? '>=' : '<=');
  }
  return tiles;
}
