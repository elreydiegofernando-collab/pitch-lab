/**
 * A lesson's progress for a profile, read back from the log (pure).
 *
 * A practice try is one row of the log with the drill's exercise id (the runner writes it as kind 'practice' with no
 * level, so it never moves a level: progress/engine.ts counts only rows that carry a level). It counts as GOOD when it
 * was sung to its end and every condition of its step's rule holds:
 *   sung to its end  not silent (the runner writes a take where nothing came through as 0 s) and not cut short: its
 *                    duration reaches the whole take (count-in plus material at the tempo sung, which does not depend
 *                    on the singer's range), as the runner writes a take that was stopped early, or went quiet before
 *                    its last note, shorter (checkup/summary.ts reads a take the same way)
 *   the rule         every condition holds on the take's metrics; one the take could not read fails (as a gate does)
 * Each step counts its good tries up to the number it asks for; the lesson is ready for its check once every step has
 * them, and passed once its level is (the snapshot: only the check, or a grant, passes a level).
 *
 * A missed check sends the singer back to practice (the owner's plan, 2026-10-23: "Pass it to move on; miss it and you go
 * back to practice, with coaching"): stepAfterMiss names the step to go back to, until a good try is sung there or
 * anywhere else in the lesson.
 */
import { gateHolds } from '../analysis/score';
import type { Metrics } from '../analysis/types';
import { getExercise, getLevel } from '../exercises/catalog';
import { realize } from '../exercises/transpose';
import type { ExerciseDef } from '../exercises/types';
import type { ProgressSnapshot } from '../progress/types';
import type { AttemptRecord } from '../storage/schema';
import { lessonFor } from './index';
import type { GoodTryRule, LessonDef, LessonProgress, PracticeStep } from './types';

/** A take this close to its whole length ran to its end (runtime/runner.ts COMPLETE_SLACK_SEC). */
const WHOLE_TAKE_SLACK_SEC = 0.25;

/** Count-in plus material of an exercise at a tempo, by `${exerciseId}@${bpm}` (catalog data is frozen, so it never goes stale). */
const wholeSecCache = new Map<string, number>();

/** How long a whole take of `exerciseId` at `bpm` lasts; null for an exercise the catalog does not have. */
function wholeTakeSec(exerciseId: string, bpm: number | null): number | null {
  const def = getExercise(exerciseId);
  if (!def) return null;
  const tempo = typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0 ? bpm : def.tempoBpm;
  const key = `${exerciseId}@${tempo}`;
  let sec = wholeSecCache.get(key);
  if (sec === undefined) {
    const r = realize(def, null, 'unknown', { bpm: tempo });
    sec = r.countInSec + r.totalSec;
    wholeSecCache.set(key, sec);
  }
  return sec;
}

/**
 * The row of a try as isGoodTry reads it: its metrics and duration, and (any attempt row has them) its exercise id and
 * tempo, which say how long a whole take is. Without the exercise id only a silent take is caught, so pass the row.
 */
export type TryRow = Pick<AttemptRecord, 'metrics' | 'durationSec'> & Partial<Pick<AttemptRecord, 'exerciseId' | 'tempoBpm'>>;

/** True when the try was sung to its end: not silent, and not stopped or gone quiet before it (see the module doc). */
function sungToEnd(attempt: TryRow): boolean {
  if (!(attempt.durationSec > 0)) return false;
  if (attempt.exerciseId === undefined) return true;
  const whole = wholeTakeSec(attempt.exerciseId, attempt.tempoBpm ?? null);
  return whole !== null && attempt.durationSec >= whole - WHOLE_TAKE_SLACK_SEC;
}

/**
 * True when a practice try counts as good: sung to its end and every condition of the rule holds. `metrics`, when
 * given, is read instead of the row's own (the take's analysis); a rule with no conditions asks only for the end.
 */
export function isGoodTry(rule: GoodTryRule, attempt: TryRow, metrics?: Metrics): boolean {
  if (!sungToEnd(attempt)) return false;
  const measured = metrics ?? attempt.metrics ?? {};
  return rule.conditions.every((c) => gateHolds(c, measured));
}

/** The good tries a step asks for: a whole number, at least 0 (a malformed count asks for one). */
function triesNeeded(step: PracticeStep): number {
  return Number.isFinite(step.goodTries) ? Math.max(0, Math.ceil(step.goodTries)) : 1;
}

/** The lesson's progress from the profile's log and snapshot (passed comes from the snapshot). */
export function lessonProgress(lesson: LessonDef, log: readonly AttemptRecord[], snapshot: ProgressSnapshot): LessonProgress {
  const byExercise = new Map<string, AttemptRecord[]>();
  for (const a of log) {
    if (a.deletedAt != null) continue;
    const rows = byExercise.get(a.exerciseId);
    if (rows) rows.push(a);
    else byExercise.set(a.exerciseId, [a]);
  }
  const steps = lesson.practice.map((step) => {
    const rows = byExercise.get(step.exerciseId) ?? [];
    const needed = triesNeeded(step);
    let good = 0;
    for (const a of rows) if (isGoodTry(step.good, a)) good += 1;
    good = Math.min(good, needed);
    return { exerciseId: step.exerciseId, good, needed, tries: rows.length, done: good >= needed };
  });
  const open = steps.findIndex((s) => !s.done);
  const currentStep = open < 0 ? steps.length : open;
  return {
    levelId: lesson.levelId,
    steps,
    currentStep,
    ready: currentStep === steps.length,
    passed: snapshot.levels[lesson.levelId]?.status === 'passed',
  };
}

/**
 * The practice step that trains what a missed check missed: the last step whose good-try rule reads the first gate of
 * the check that `metrics` miss (the step nearest the check on that skill), else the lesson's last step.
 */
export function stepForMiss(lesson: LessonDef, check: Pick<ExerciseDef, 'pass'>, metrics: Metrics): number {
  const failed = (check.pass.gates ?? []).find((g) => !gateHolds(g, metrics));
  if (failed) {
    for (let i = lesson.practice.length - 1; i >= 0; i--) {
      if (lesson.practice[i].good.conditions.some((c) => c.metric === failed.metric)) return i;
    }
  }
  return Math.max(0, lesson.practice.length - 1);
}

/**
 * Where practice picks up again after a missed check: when the latest take of the lesson's check (`check`, sung as its
 * level: a personal-record take does not count) missed and no good practice try of this lesson has been sung since, the
 * step to go back to (stepForMiss on that take); null otherwise (no check sung yet, the latest one passed, a good try
 * since, or a lesson with no practice). `log` is the profile's log, oldest first.
 */
export function stepAfterMiss(lesson: LessonDef, check: Pick<ExerciseDef, 'id' | 'pass'>, log: readonly AttemptRecord[]): number | null {
  if (lesson.practice.length === 0) return null;
  let missed = -1;
  for (let i = log.length - 1; i >= 0; i--) {
    const a = log[i];
    if (a.deletedAt != null || a.exerciseId !== check.id || a.levelId !== lesson.levelId || a.kind === 'record') continue;
    if (a.passed) return null;
    missed = i;
    break;
  }
  if (missed < 0) return null;
  const steps = new Map(lesson.practice.map((p) => [p.exerciseId, p] as const));
  for (let i = missed + 1; i < log.length; i++) {
    const a = log[i];
    const step = a.deletedAt == null ? steps.get(a.exerciseId) : undefined;
    if (step && isGoodTry(step.good, a)) return null;
  }
  return stepForMiss(lesson, check, log[missed].metrics ?? {});
}

/** The line shown where a lesson's check is still closed. */
export const CHECK_CLOSED_HINT = 'Finish every practice step first: then the check opens.';

/**
 * Is a level's check open? Owner, 2026-10-23: "it just tested me, and I passed it. But it doesn't train me to do
 * better". So the check of a lesson opens once its practice is done (every step), or once the lesson is passed (to sing
 * it again); a missed check keeps it open, since the practice was done. A level without a lesson keeps the classic flow.
 * The one exception is the Range finder: its check measures the voice rather than grading a skill ("nothing here is
 * graded"), and every exercise needs the range, so it is open from the start; its practice is a gentle way in.
 * The runner and the route guard both ask this (fail closed); the lesson screen shows it.
 */
export function isCheckOpen(levelId: string, log: readonly AttemptRecord[], snapshot: ProgressSnapshot): boolean {
  const lesson = lessonFor(levelId);
  if (!lesson) return true;
  if (isMeasuringLevel(levelId)) return true;
  const p = lessonProgress(lesson, log, snapshot);
  return p.passed || p.ready;
}

/** True for a level whose check measures rather than grades (the Range finder). */
export function isMeasuringLevel(levelId: string): boolean {
  const level = getLevel(levelId);
  return level !== undefined && getExercise(level.exerciseId)?.kind === 'range-finder';
}
