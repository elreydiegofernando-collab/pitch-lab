/**
 * "Since last time" (coach.ts progressLines): the problem's measure and every measure a pass gate failed on in this
 * take, read on the previous take of the exercise and on this one, in the same plain words the located problem uses
 * (measures.ts), with better or worse. A measure one of the two takes could not read is left out (there is nothing to
 * compare, and "about the same" would be untrue); when nothing else is left (a clean take, a take that sang nothing)
 * the overall score is the line.
 */
import type { MetricKey } from '../analysis/types';
import type { VibratoStyle } from '../core/types';
import { evaluate } from '../exercises/evaluate';
import type { ExerciseDef } from '../exercises/types';
import type { AttemptRecord } from '../storage/schema';
import { MEASURES, compareMeasure } from './measures';
import { shareText } from './plain';
import type { ProgressLine, TakeProblem } from './types';

const NOT_MEASURED = 'not measured';

/** One measure on the two takes. */
export function measureLine(metric: MetricKey, before: number | undefined, now: number | undefined, style?: VibratoStyle): ProgressLine {
  const m = MEASURES[metric];
  const words = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? NOT_MEASURED : m.words(v));
  return { label: m.label, before: words(before), now: words(now), better: compareMeasure(metric, before, now, style) };
}

/** The overall score on the two takes. */
export function scoreLine(before: number, now: number): ProgressLine {
  const b = shareText(before);
  const n = shareText(now);
  return { label: 'Score', before: b, now: n, better: b === n ? null : now > before };
}

/** The measures to compare: the problem's, then each gate this take failed on, once each. */
export function progressMetrics(def: ExerciseDef, current: AttemptRecord, problem: Pick<TakeProblem, 'metric'>): MetricKey[] {
  const out: MetricKey[] = [];
  if (problem.metric) out.push(problem.metric);
  const gates = def.pass.gates ?? [];
  for (const i of evaluate(def, current.metrics).failedGates) {
    const m = gates[i]?.metric;
    if (m && !out.includes(m)) out.push(m);
  }
  return out;
}

export function progressLinesFor(
  def: ExerciseDef,
  previous: AttemptRecord | null,
  current: AttemptRecord,
  problem: Pick<TakeProblem, 'metric'>,
  style?: VibratoStyle,
): ProgressLine[] {
  if (!previous) return [];
  const lines = progressMetrics(def, current, problem)
    .map((m) => measureLine(m, previous.metrics[m], current.metrics[m], style))
    .filter((line) => line.before !== NOT_MEASURED && line.now !== NOT_MEASURED);
  return lines.length > 0 ? lines : [scoreLine(previous.score, current.score)];
}
