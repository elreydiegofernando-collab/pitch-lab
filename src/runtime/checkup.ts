/**
 * The check-up session: one sitting that sings CHECKUP_TASKS in order through the runner
 * (RunTarget { kind: 'checkup', taskIndex }). Unlike the placement audition it never stops at a miss: every task is
 * sung so the profile is complete (the progress engine still grants levels only as the audition would: a test passed
 * out of the audition's order grants nothing, progress/engine.ts). Every take is a durable attempt tagged with the
 * check-up's id, so nothing is lost if the page dies mid-way; an unfinished check-up is simply not shown as finished.
 *
 * Like the daily workout (runtime/workout.ts), the session lives in memory, and a profile switch, a backup import or
 * Delete all data drops it (src/state/session.ts). Because iOS often closes a home-screen app left in the background,
 * loading a profile picks its unfinished check-up up again from the log (resumeCheckup) while it is recent
 * (checkup/summary.ts RESUME_WITHIN_MS). A task can be sung again while the check-up runs; each task keeps its latest
 * take. The take of the last task finishes it once that take measured something (one that measured nothing, a slip of
 * the Stop button or a silent take, can be sung again); finishCheckup ends it either way ("See your results").
 */
import { signal } from '@preact/signals';
import { isTaskMeasured, unfinishedCheckup } from '../checkup/summary';
import { CHECKUP_TASKS } from '../checkup/types';
import { newId } from '../storage/ids';
import type { AttemptRecord } from '../storage/schema';
import type { TakeOutcome } from './types';

export interface CheckupSession {
  checkupId: string;
  startedAt: string;
  /** Per task: the attempt id once sung (null before). */
  attemptIds: Array<string | null>;
  finishedAt: string | null;
}

export const activeCheckup = signal<CheckupSession | null>(null);

/** Start a check-up for the active profile (a new id; any unfinished one is dropped). */
export function startCheckup(): CheckupSession {
  const session: CheckupSession = {
    checkupId: newId(),
    startedAt: new Date().toISOString(),
    attemptIds: CHECKUP_TASKS.map(() => null),
    finishedAt: null,
  };
  activeCheckup.value = session;
  return session;
}

/**
 * The runner calls this after each check-up take is written. A task sung again keeps its latest take. A take of another
 * check-up (one that was replaced while it was being sung), or of a finished one, is not counted here; it is in the log
 * under its own id either way. A take of the last task that measured something finishes the check-up.
 */
export function recordCheckupTake(taskIndex: number, outcome: TakeOutcome): void {
  const session = activeCheckup.value;
  if (!session || session.finishedAt !== null) return;
  if (!Number.isInteger(taskIndex) || taskIndex < 0 || taskIndex >= session.attemptIds.length) return;
  const { attempt } = outcome;
  if (attempt.checkupId !== session.checkupId) return;
  const attemptIds = session.attemptIds.map((id, i) => (i === taskIndex ? attempt.id : id));
  const finishes = taskIndex === attemptIds.length - 1 && isTaskMeasured(taskIndex, attempt);
  activeCheckup.value = { ...session, attemptIds, finishedAt: finishes ? new Date().toISOString() : null };
}

/**
 * Mark the active check-up finished (after its last task); returns its id. Idempotent: a finished check-up returns its
 * id again. Null when there is none, or its last task has not been sung (it cannot be finished, and is left running).
 */
export function finishCheckup(): string | null {
  const session = activeCheckup.value;
  if (!session) return null;
  if (session.finishedAt !== null) return session.checkupId;
  if (session.attemptIds[session.attemptIds.length - 1] === null) return null;
  activeCheckup.value = { ...session, finishedAt: new Date().toISOString() };
  return session.checkupId;
}

export function abandonCheckup(): void {
  activeCheckup.value = null;
}

/**
 * The session for a profile just loaded: its unfinished check-up from the log while it is recent (summary.ts
 * unfinishedCheckup), so the tasks already sung are kept after Pitch Lab was closed; otherwise none. `log` is that
 * profile's attempt log.
 */
export function resumeCheckup(log: readonly AttemptRecord[], profileId: string, now: number): CheckupSession | null {
  const found = unfinishedCheckup(log, profileId, now);
  const session: CheckupSession | null = found ? { ...found, finishedAt: null } : null;
  activeCheckup.value = session;
  return session;
}
