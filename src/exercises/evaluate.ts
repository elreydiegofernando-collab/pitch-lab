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
 *    narrowest range the Range finder saves, so only a bad saved range folds).
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

export interface Evaluation {
  score: number;
  passed: boolean;
  mastery: Mastery;
  /** Gates that failed, by index into def.pass.gates. */
  failedGates: number[];
  /** Set when the take could not count at all (TakeConditions): the score is shown, but it never passes. */
  notJudged?: 'folded';
}

/** How the take was realized (an analyzeTake result is one): what the pass depends on besides the metrics. */
export interface TakeConditions {
  /** RealizedExercise.fit: 'folded' moved notes by octaves to squeeze the material into too narrow a range. */
  fit?: RealizedExercise['fit'];
  /** AnalysisPlan.issues: figures the realization broke (a flip folded into a drop), so they were never judged. */
  plan?: { readonly issues: readonly string[] };
}

/** True when `take` was not the exercise as written: folded by octaves, or with figures dropped. */
export function isFolded(take: TakeConditions): boolean {
  return take.fit === 'folded' || (take.plan?.issues.length ?? 0) > 0;
}

/**
 * Score, pass/fail, mastery tier and failed gates of an attempt. A metric that is missing or NaN counts as not
 * measured. Pass the take (`evaluate(def, a.metrics, a)`) so a folded realization can never pass.
 */
export function evaluate(def: ExerciseDef, metrics: Metrics, take?: TakeConditions): Evaluation {
  const { score, passed, mastery, failedGates } = scoreExercise(def, metrics);
  if (take !== undefined && isFolded(take)) return { score, passed: false, mastery: 0, failedGates, notJudged: 'folded' };
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
