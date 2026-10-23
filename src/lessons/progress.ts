/**
 * A lesson's progress for a profile, read back from the log (pure).
 * CONTRACT STUB: the lesson engine builder replaces the bodies and keeps these signatures.
 */
import type { Metrics } from '../analysis/types';
import type { ProgressSnapshot } from '../progress/types';
import type { AttemptRecord } from '../storage/schema';
import type { GoodTryRule, LessonDef, LessonProgress } from './types';

/** True when a practice try counts as good: sung to its end and every condition of the rule holds. */
export function isGoodTry(rule: GoodTryRule, attempt: Pick<AttemptRecord, 'metrics' | 'durationSec'>, metrics?: Metrics): boolean {
  void rule;
  void attempt;
  void metrics;
  throw new Error('isGoodTry: not built yet');
}

/** The lesson's progress from the profile's log and snapshot (passed comes from the snapshot). */
export function lessonProgress(lesson: LessonDef, log: readonly AttemptRecord[], snapshot: ProgressSnapshot): LessonProgress {
  void lesson;
  void log;
  void snapshot;
  throw new Error('lessonProgress: not built yet');
}
