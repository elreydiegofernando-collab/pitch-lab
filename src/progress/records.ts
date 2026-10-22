/**
 * Personal records (SPEC §12 dashboard "personal bests"; ROADMAP "personal-record attempts").
 *
 * A record is the best value of one marquee metric of one exercise, from a PASSED attempt (a
 * failed or empty take can score a "perfect" 0 cracks, which is not a skill). It moves only on a
 * STRICT improvement, so a tie keeps the earlier attempt. Direction comes from METRIC_DIRECTION
 * (exercises/metrics.ts); two-sided metrics (vibrato rate/extent) and unknown metrics have no
 * "better", so they never produce records. With an exercise lookup, only the metrics the exercise
 * actually scores count; without one, every directional metric of the attempt does.
 */
import type { ExerciseDef } from '../exercises/types';
import { METRIC_DIRECTION } from '../exercises/metrics';
import type { LoggedAttempt } from './log';
import { RECORD_KINDS } from './log';
import type { ProgressSnapshot } from './types';

export type ExerciseLookup = (exerciseId: string) => ExerciseDef | undefined;
export type RecordEntry = ProgressSnapshot['records'][string];

const KEY_SEPARATOR = ':';

/** Key of a record in ProgressSnapshot.records: "<exerciseId>:<metric>". */
export function recordKey(exerciseId: string, metric: string): string {
  return `${exerciseId}${KEY_SEPARATOR}${metric}`;
}

/** Inverse of recordKey; null when the key has no separator. */
export function parseRecordKey(key: string): { exerciseId: string; metric: string } | null {
  const i = key.lastIndexOf(KEY_SEPARATOR);
  return i <= 0 ? null : { exerciseId: key.slice(0, i), metric: key.slice(i + 1) };
}

/** Which way is better for a metric; null when two-sided or unknown (no record is kept). */
export function recordDirection(metric: string): 'higher' | 'lower' | null {
  const d = (METRIC_DIRECTION as Readonly<Record<string, 'higher' | 'lower' | 'target' | undefined>>)[metric];
  return d === 'higher' || d === 'lower' ? d : null;
}

/** True only for a STRICT improvement over `best` in the metric's direction. */
export function isImprovement(direction: 'higher' | 'lower', value: number, best: number): boolean {
  return direction === 'higher' ? value > best : value < best;
}

/** One exercise's records (metric, value, attempt, time), in key order. */
export function recordsForExercise(snapshot: ProgressSnapshot, exerciseId: string): Array<RecordEntry & { metric: string }> {
  const out: Array<RecordEntry & { metric: string }> = [];
  for (const key of Object.keys(snapshot.records)) {
    const parsed = parseRecordKey(key);
    if (parsed && parsed.exerciseId === exerciseId) out.push({ ...snapshot.records[key], metric: parsed.metric });
  }
  return out;
}

/** Fold the (oldest-first) log into records. */
export function foldRecords(log: readonly LoggedAttempt[], getExercise?: ExerciseLookup): ProgressSnapshot['records'] {
  const records: ProgressSnapshot['records'] = {};
  const marquee = new Map<string, ReadonlySet<string> | null>();
  const marqueeOf = (exerciseId: string): ReadonlySet<string> | null => {
    let m = marquee.get(exerciseId);
    if (m === undefined) {
      const def = getExercise?.(exerciseId);
      m = def ? new Set(def.scoring.filter((t) => t.weight > 0).map((t) => t.metric as string)) : null;
      marquee.set(exerciseId, m);
    }
    return m;
  };

  for (const { a } of log) {
    if (!a.passed || !RECORD_KINDS.has(a.kind) || !a.metrics) continue;
    const scored = marqueeOf(a.exerciseId);
    for (const [metric, value] of Object.entries(a.metrics)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const direction = recordDirection(metric);
      if (direction === null || (scored !== null && !scored.has(metric))) continue;
      const key = recordKey(a.exerciseId, metric);
      const best = records[key];
      if (best === undefined || isImprovement(direction, value, best.value)) {
        records[key] = { value, attemptId: a.id, at: a.createdAt };
      }
    }
  }
  return records;
}
