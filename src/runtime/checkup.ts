/**
 * The check-up session: one sitting that sings CHECKUP_TASKS in order through the runner
 * (RunTarget { kind: 'checkup', taskIndex }). Unlike the placement audition it never stops at a miss: every task is
 * sung so the profile is complete (the progress engine still grants levels only in order). Every take is a durable
 * attempt tagged with the check-up's id, so nothing is lost if the page dies mid-way; an unfinished check-up is simply
 * not shown as finished.
 *
 * CONTRACT STUB: the check-up engine builder replaces the bodies and keeps these signatures.
 */
import { signal } from '@preact/signals';
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
  throw new Error('startCheckup: not built yet');
}

/** The runner calls this after each check-up take is written. */
export function recordCheckupTake(taskIndex: number, outcome: TakeOutcome): void {
  void taskIndex;
  void outcome;
}

/** Mark the active check-up finished (after its last task); returns its id. */
export function finishCheckup(): string | null {
  return null;
}

export function abandonCheckup(): void {
  activeCheckup.value = null;
}
