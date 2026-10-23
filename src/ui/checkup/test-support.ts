/**
 * Test support for the check-up screens (imported by tests only): finished check-ups, comparisons and running sessions
 * built by hand, and doubles for the three modules the screens lean on that other builders own: the session, the
 * check-up session (src/runtime/checkup.ts) and the check-up engine (src/checkup/summary.ts). The screens are tested
 * against these contracts, so the engine's own tests are the only ones that depend on how the engine reads the log.
 */
import { signal } from '@preact/signals';
import { vi } from 'vitest';
import { CHECKUP_TASKS, type CheckupComparison, type CheckupSkill, type CheckupSummary, type SkillRating, type SkillResult } from '../../checkup/types';
import type { CheckupSession } from '../../runtime/checkup';
import type { AppStorage } from '../../storage';
import { sessionDouble } from '../worlds/test-support';

export { attempt, byTestId, flush, installGuardOver, mount, profileRecord, settingsDouble, snapshotOf, textOf, waitUntil, type Mounted } from '../worlds/test-support';

export const DAY_MS = 86_400_000;

/** A rated skill with the engine's kind of sentence. */
export function skill(name: CheckupSkill, rating: SkillRating, what = `${name} sentence.`): SkillResult {
  return { skill: name, rating, what };
}

/** The six skills of a typical first check-up: a crack on slides to focus on, one skill not measured. */
export function typicalSkills(): SkillResult[] {
  return [
    skill('range', 'solid', 'You can sing about an octave and a half comfortably.'),
    skill('pitch', 'solid', 'You matched each note closely.'),
    skill('steadiness', 'getting-there', 'You held each note, wavering a little near the end.'),
    skill('slides', 'focus', 'Your voice broke 5 times on the way up and back.'),
    skill('starts', 'solid', 'Your notes started right on the note.'),
    skill('connected', 'not-measured', 'This task was not sung.'),
  ];
}

/** A finished check-up; override anything. `finishedAt` defaults to `daysAgo` days before `now`. */
export function summaryOf(
  checkupId: string,
  over: Partial<CheckupSummary> & { daysAgo?: number; now?: number } = {},
): CheckupSummary {
  const { daysAgo = 0, now = Date.now(), ...rest } = over;
  const finished = new Date(now - daysAgo * DAY_MS);
  return {
    checkupId,
    profileId: 'profile-1',
    startedAt: new Date(finished.getTime() - 4 * 60_000).toISOString(),
    finishedAt: finished.toISOString(),
    tasks: CHECKUP_TASKS.map((t, i) => ({ exerciseId: t.exerciseId, title: t.title, attemptId: `${checkupId}-task-${i}`, passed: true, score: 0.8 })),
    skills: typicalSkills(),
    focus: ['slides'],
    startLevelId: 'foundations.05',
    opened: ['foundations.02', 'foundations.03', 'foundations.04'],
    range: 'B2–A4',
    ...rest,
  };
}

/** "Then and now" between two check-ups, in the engine's kind of words. */
export function comparisonOf(before: CheckupSummary, after: CheckupSummary, over: Partial<CheckupComparison> = {}): CheckupComparison {
  return {
    before,
    after,
    headline: 'Your slides are much smoother and your range is two notes wider.',
    lines: [
      { skill: 'slides', label: 'Slides', before: '5 breaks', now: '1 break', better: true },
      { skill: 'range', label: 'Range', before: 'B2–A4', now: 'A2–B4', better: true },
      { skill: 'steadiness', label: 'Holding steady', before: 'steady', now: 'a little wavery', better: false },
      { skill: 'pitch', label: 'Matching a note', before: 'close', now: 'close', better: null },
    ],
    ...over,
  };
}

/** A running check-up: `sung` tasks done (attempt ids), the rest still to sing. */
export function sessionOf(sung: number, over: Partial<CheckupSession> = {}): CheckupSession {
  return {
    checkupId: 'run-1',
    startedAt: '2026-10-22T14:00:00.000Z',
    attemptIds: CHECKUP_TASKS.map((_, i) => (i < sung ? `run-1-task-${i}` : null)),
    finishedAt: null,
    ...over,
  };
}

// ---------------------------------------------------------------- module doubles (for vi.mock factories)

/** `vi.mock('../../state/session', ...)`: the world screens' session double, plus the open storage. */
export function sessionModule() {
  return { ...sessionDouble(), appStorage: signal<AppStorage | null>(null) };
}

/** `vi.mock('../../runtime/checkup', ...)`: the running check-up as a signal, and spies for its calls. */
export function checkupRuntimeModule() {
  const activeCheckup = signal<CheckupSession | null>(null);
  return {
    activeCheckup,
    startCheckup: vi.fn(() => {
      const started = sessionOf(0, { checkupId: 'run-new' });
      activeCheckup.value = started;
      return started;
    }),
    recordCheckupTake: vi.fn(),
    finishCheckup: vi.fn(() => null),
    abandonCheckup: vi.fn(() => {
      activeCheckup.value = null;
    }),
  };
}

/** `vi.mock('../../checkup/summary', ...)`: the engine as spies; a test sets what `checkupsOf` returns. */
export function summaryModule() {
  return {
    checkupsOf: vi.fn((): CheckupSummary[] => []),
    compareCheckups: vi.fn((before: CheckupSummary, after: CheckupSummary): CheckupComparison => comparisonOf(before, after)),
    // The contract: no check-up yet, or the last one is RECHECK_AFTER_DAYS (21) old or more.
    recheckDue: vi.fn((summaries: readonly CheckupSummary[], now: number): boolean => {
      const last = summaries[summaries.length - 1];
      return !last || now - Date.parse(last.finishedAt) >= 21 * DAY_MS;
    }),
  };
}
