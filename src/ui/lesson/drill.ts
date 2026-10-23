/**
 * A practice try, read for its report (pure): training, not testing. Whether it was a good try (the step's lenient
 * rule, src/lessons/progress.ts isGoodTry, read from the try's row as the lesson's progress and the report's actions read
 * it), the step's good tries after it, whether it finished the step and whether every step is done now. The counts come
 * from the lesson's progress over the log, which already holds the try (with and without it); should that be
 * unreadable, from the counts the runner wrote into the outcome (PreparedRun.drill, this try included).
 */
import { getLevel, getWorld } from '../../exercises';
import { lessonFor } from '../../lessons';
import { isGoodTry } from '../../lessons/progress';
import type { LessonDef, PracticeStep } from '../../lessons/types';
import type { ProgressSnapshot } from '../../progress/types';
import type { TakeOutcome } from '../../runtime/types';
import type { AttemptRecord } from '../../storage/schema';
import { lessonLabel, lessonNumber, readProgress } from './model';

/** How a try went, never a grade: a good try, not quite yet, or why it could not be read. */
export type DrillVerdictKind = 'good' | 'not-yet' | 'silent' | 'not-judged';

export interface DrillSummary {
  levelId: string;
  /** The step (0-based) and how many the lesson has. */
  step: number;
  stepCount: number;
  lesson: LessonDef | null;
  practice: PracticeStep | null;
  /** "Lesson 5", for the caption; null when the lesson is unknown. */
  lessonName: string | null;
  verdict: { kind: DrillVerdictKind; word: string; reason: string | null };
  /** This try counted as a good one. */
  good: boolean;
  /** Good tries on the step now (this one included, capped at `needed`). */
  goodTries: number;
  needed: number;
  /** This try was the one that finished the step. */
  finishedStep: boolean;
  /** Every practice step is done now (the check is the next move). */
  ready: boolean;
  /** The lesson is passed already (practising again). */
  passed: boolean;
}

/**
 * The step's rule on the try's row (sung to its end, and every condition held), never throwing; without a step to read,
 * a whole take that passed the drill's own rule.
 */
function goodTry(outcome: TakeOutcome, practice: PracticeStep | null): boolean {
  const { evaluation, analysis, attempt } = outcome;
  const whole = !evaluation.notJudged && analysis.tipContext.noVoice !== true;
  if (!practice) return whole && evaluation.passed;
  try {
    return isGoodTry(practice.good, attempt);
  } catch {
    return whole && evaluation.passed;
  }
}

function verdictOf(outcome: TakeOutcome, good: boolean): DrillSummary['verdict'] {
  const { evaluation, analysis } = outcome;
  if (good) return { kind: 'good', word: 'Good try', reason: null };
  if (analysis.tipContext.noVoice) return { kind: 'silent', word: 'Nothing came through', reason: 'Nothing came through the microphone. Check it is on, then try again.' };
  if (evaluation.notJudged === 'stopped') return { kind: 'not-yet', word: 'Not quite yet', reason: 'Stopped early: a try counts when you sing it to the end.' };
  if (evaluation.notJudged === 'folded') return { kind: 'not-judged', word: 'Not judged', reason: 'This exercise does not fit your saved range, so this try could not count.' };
  return { kind: 'not-yet', word: 'Not quite yet', reason: null };
}

/** The summary of a practice try's take; null for any other take. */
export function drillSummary(outcome: TakeOutcome, log: readonly AttemptRecord[], snapshot: ProgressSnapshot): DrillSummary | null {
  const target = outcome.prepared.target;
  if (target.kind !== 'drill') return null;
  const lesson = lessonFor(target.levelId) ?? null;
  const practice = lesson?.practice[target.step] ?? null;
  const prepared = outcome.prepared.drill ?? null;
  const good = goodTry(outcome, practice);

  // From the outcome: the runner counts this try into the step's good tries once it is written.
  let needed = Math.max(1, prepared?.needed ?? practice?.goodTries ?? 1);
  let goodTries = Math.min(needed, Math.max(0, prepared?.good ?? (good ? 1 : 0)));
  let goodBefore = Math.max(0, goodTries - (good ? 1 : 0));
  let ready = false;
  let passed = snapshot.levels[target.levelId]?.status === 'passed';

  // The log already holds this try (the runner writes it before the report opens): the lesson's own counts, with and
  // without it.
  const id = outcome.attempt.id;
  if (lesson && log.some((a) => a.id === id)) {
    const after = readProgress(lesson, log, snapshot);
    const step = after.steps[target.step];
    if (step && step.tries > 0) {
      const prior = readProgress(lesson, log.filter((a) => a.id !== id), snapshot).steps[target.step];
      needed = Math.max(1, step.needed);
      goodTries = Math.min(needed, Math.max(0, step.good));
      goodBefore = Math.min(needed, Math.max(0, prior?.good ?? 0));
      ready = after.ready;
      passed = after.passed;
    }
  }

  const level = getLevel(target.levelId);
  return {
    levelId: target.levelId,
    step: target.step,
    stepCount: lesson?.practice.length ?? prepared?.stepCount ?? target.step + 1,
    lesson,
    practice,
    lessonName: lesson && level ? lessonLabel(lessonNumber(getWorld(level.worldId), level)) : null,
    verdict: verdictOf(outcome, good),
    good,
    goodTries,
    needed,
    finishedStep: good && goodBefore < needed && goodTries >= needed,
    ready,
    passed,
  };
}

/**
 * What comes next, in a sentence, when this try finished its step: the next step, or the check once every step is
 * done (practising a passed lesson again just says the step is done). Null otherwise.
 */
export function drillNextLine(summary: Pick<DrillSummary, 'finishedStep' | 'ready' | 'passed'>): string | null {
  if (!summary.finishedStep) return null;
  if (summary.passed) return 'This step is done.';
  if (summary.ready) return 'Every practice step is done: you are ready for the check.';
  return 'This step is done. On to the next one.';
}
