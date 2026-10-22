/**
 * The attempt log as progression reads it. The log is APPEND-ONLY (storage/attempts-repo.ts);
 * everything in progress/* is derived by replaying it, so nothing here stores state.
 */
import type { AttemptRecord } from '../storage/schema';

/** Attempt kinds that can PASS a level: practice reps, Boss Recital runs and daily-workout items. */
export const LEVEL_PASSING_KINDS: ReadonlySet<AttemptRecord['kind']> = new Set<AttemptRecord['kind']>(['practice', 'boss', 'workout']);

/** Attempt kinds that count as an attempt ON a level (its attempt count, best score, recent history). */
export const LEVEL_ATTEMPT_KINDS: ReadonlySet<AttemptRecord['kind']> = new Set<AttemptRecord['kind']>(['practice', 'boss', 'workout', 'record']);

/** Attempt kinds a personal record may come from (passed exercise attempts; never auditions or songs). */
export const RECORD_KINDS: ReadonlySet<AttemptRecord['kind']> = new Set<AttemptRecord['kind']>(['practice', 'boss', 'workout', 'record']);

/** An attempt with its `createdAt` parsed once (null when unparsable, so one bad row can't poison the log). */
export interface LoggedAttempt {
  readonly a: AttemptRecord;
  readonly ms: number | null;
}

export function logged(a: AttemptRecord): LoggedAttempt {
  const ms = Date.parse(a.createdAt);
  return { a, ms: Number.isFinite(ms) ? ms : null };
}

/** Append order: HLC `updatedAt` (set once at append), then createdAt, then id, so replay is deterministic. */
function byAppendOrder(x: LoggedAttempt, y: LoggedAttempt): number {
  const ux = x.a.updatedAt ?? '';
  const uy = y.a.updatedAt ?? '';
  if (ux !== uy) return ux < uy ? -1 : 1;
  const mx = x.ms ?? -Infinity;
  const my = y.ms ?? -Infinity;
  if (mx !== my) return mx < my ? -1 : 1;
  return x.a.id < y.a.id ? -1 : x.a.id > y.a.id ? 1 : 0;
}

/** One profile's live attempts, oldest first. Drops other profiles' rows and soft-deleted rows. */
export function replayLog(profileId: string, attempts: readonly AttemptRecord[]): LoggedAttempt[] {
  const out: LoggedAttempt[] = [];
  for (const a of attempts) if (a.profileId === profileId && a.deletedAt == null) out.push(logged(a));
  return out.sort(byAppendOrder);
}

/** A score forced into 0..1 (non-finite -> 0), so one corrupt row can't produce NaN. */
export function cleanScore(score: unknown): number {
  const s = typeof score === 'number' && Number.isFinite(score) ? score : 0;
  return s < 0 ? 0 : s > 1 ? 1 : s;
}
