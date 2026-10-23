/**
 * Reading check-ups back from the log, and comparing two (pure).
 *
 * CONTRACT STUB: the check-up engine builder replaces the bodies and keeps these signatures.
 */
import type { Notation } from '../core/music';
import type { ProgressSnapshot } from '../progress/types';
import type { AttemptRecord } from '../storage/schema';
import type { CheckupComparison, CheckupSummary } from './types';

/** Every finished check-up of a profile in its log, oldest first. A check-up counts once its last task was sung. */
export function checkupsOf(log: readonly AttemptRecord[], snapshotAfter: (checkupId: string) => ProgressSnapshot | null, notation: Notation): CheckupSummary[] {
  void log;
  void snapshotAfter;
  void notation;
  throw new Error('checkupsOf: not built yet');
}

/** "Then and now" between two check-ups (the older first). */
export function compareCheckups(before: CheckupSummary, after: CheckupSummary): CheckupComparison {
  void before;
  void after;
  throw new Error('compareCheckups: not built yet');
}

/** True when a re-check is worth suggesting: no check-up yet, or the last one is RECHECK_AFTER_DAYS old or more. */
export function recheckDue(summaries: readonly CheckupSummary[], now: number): boolean {
  void summaries;
  void now;
  throw new Error('recheckDue: not built yet');
}
