/**
 * Lesson progress read back from the log: what counts as a good try (sung to its end, every condition holding), good
 * tries per step (capped), the current step, ready and passed; and the engine's side of the contract: a practice try
 * (kind 'practice', no level) never changes a level, whatever it sang.
 */
import { describe, expect, it } from 'vitest';
import { WORLDS, getExercise, realize } from '../exercises';
import { computeSnapshot, withRoutines } from '../progress';
import { BASE_MS, P1, attempt, pass, passAudition, passThrough } from '../progress/test-fixtures';
import type { ProgressSnapshot } from '../progress/types';
import type { AttemptRecord } from '../storage/schema';
import { lessonFor } from './index';
import { isCheckOpen, isGoodTry, isMeasuringLevel, lessonProgress, stepAfterMiss, stepForMiss } from './progress';
import type { GoodTryRule, LessonDef } from './types';

/** Two catalog exercises that stand in for drills (any catalog exercise works: the rule reads its length). */
const ECHO = 'foundations.audition.1';
const SLIDE = 'foundations.audition.2';

/** Count-in plus material of `exerciseId` at `bpm` (its own tempo by default): a whole take, as the runner writes it. */
function whole(exerciseId: string, bpm?: number): number {
  const r = realize(getExercise(exerciseId)!, null, 'unknown', bpm === undefined ? {} : { bpm });
  return r.countInSec + r.totalSec;
}

const IN_TUNE: GoodTryRule = { conditions: [{ metric: 'accuracy.inTolerancePct', op: '>=', value: 50 }] };

const LESSON: LessonDef = {
  levelId: 'foundations.02',
  title: 'Match one note',
  outcome: 'Hear a note, then sing it back on it.',
  learn: { what: 'Singing back a note you just heard.', why: 'Every song is notes you sing back.', how: ['Listen.', 'Think it.', 'Sing it.'], onScreen: ['The bar is the note.'], terms: ['note', 'echo'] },
  practice: [
    { exerciseId: ECHO, title: 'Echo one note', ask: 'Listen, then sing it back.', goodTries: 2, good: IN_TUNE },
    { exerciseId: SLIDE, title: 'One slide', ask: 'Slide up and back down.', goodTries: 3, good: { conditions: [] } },
  ],
};

/** A practice try of `exerciseId` as the runner writes it: kind 'practice', no level, sung to its end unless told. */
function drillTry(exerciseId: string, over: Partial<AttemptRecord> = {}): AttemptRecord {
  const def = getExercise(exerciseId)!;
  return attempt({
    exerciseId,
    levelId: null,
    kind: 'practice',
    passed: false,
    tempoBpm: def.tempoBpm,
    durationSec: whole(exerciseId),
    metrics: { 'accuracy.inTolerancePct': 80 },
    ...over,
  });
}

const snap = (log: AttemptRecord[]): ProgressSnapshot => computeSnapshot(P1, WORLDS, log, BASE_MS, { getExercise: withRoutines(getExercise) });
const EMPTY = snap([]);

describe('isGoodTry', () => {
  it('a try sung to its end is good when every condition holds; one failing or unread condition makes it not', () => {
    expect(isGoodTry(IN_TUNE, drillTry(ECHO))).toBe(true);
    expect(isGoodTry(IN_TUNE, drillTry(ECHO, { metrics: { 'accuracy.inTolerancePct': 50 } }))).toBe(true); // the bound itself holds
    expect(isGoodTry(IN_TUNE, drillTry(ECHO, { metrics: { 'accuracy.inTolerancePct': 49.9 } }))).toBe(false);
    expect(isGoodTry(IN_TUNE, drillTry(ECHO, { metrics: {} }))).toBe(false); // not measured: fails, as a gate does
    const both: GoodTryRule = { conditions: [...IN_TUNE.conditions, { metric: 'accuracy.sdCents', op: '<=', value: 30 }] };
    expect(isGoodTry(both, drillTry(ECHO, { metrics: { 'accuracy.inTolerancePct': 90, 'accuracy.sdCents': 25 } }))).toBe(true);
    expect(isGoodTry(both, drillTry(ECHO, { metrics: { 'accuracy.inTolerancePct': 90, 'accuracy.sdCents': 31 } }))).toBe(false);
    // No condition: any try sung to its end, however it went.
    expect(isGoodTry({ conditions: [] }, drillTry(ECHO, { metrics: {} }))).toBe(true);
  });

  it('a silent try, or one stopped or gone quiet before its end, is never good', () => {
    const any: GoodTryRule = { conditions: [] };
    expect(isGoodTry(any, drillTry(ECHO, { durationSec: 0 }))).toBe(false); // nothing came through: written as 0 s
    expect(isGoodTry(any, drillTry(ECHO, { durationSec: 0.6 * whole(ECHO) }))).toBe(false);
    expect(isGoodTry(IN_TUNE, drillTry(ECHO, { durationSec: whole(ECHO) - 1 }))).toBe(false);
    expect(isGoodTry(any, drillTry(ECHO, { durationSec: whole(ECHO) - 0.2 }))).toBe(true); // stopped in its last moment: whole
    expect(isGoodTry(any, drillTry(ECHO, { durationSec: Number.NaN }))).toBe(false);
  });

  it('reads the whole length at the tempo sung, and fails closed for an exercise the catalog does not have', () => {
    const any: GoodTryRule = { conditions: [] };
    const slow = getExercise(ECHO)!.tempoBpm / 2;
    expect(whole(ECHO, slow)).toBeGreaterThan(whole(ECHO));
    expect(isGoodTry(any, drillTry(ECHO, { tempoBpm: slow, durationSec: whole(ECHO) }))).toBe(false); // half of a slow take
    expect(isGoodTry(any, drillTry(ECHO, { tempoBpm: slow, durationSec: whole(ECHO, slow) }))).toBe(true);
    expect(isGoodTry(any, drillTry(ECHO, { tempoBpm: null }))).toBe(true); // no tempo written: its own
    expect(isGoodTry(any, { ...drillTry(ECHO), exerciseId: 'foundations.no-such-drill' })).toBe(false);
  });

  it('given the take’s metrics, reads them instead of the row’s; given no exercise id, catches only silence', () => {
    const row = drillTry(ECHO, { metrics: {} });
    expect(isGoodTry(IN_TUNE, row)).toBe(false);
    expect(isGoodTry(IN_TUNE, row, { 'accuracy.inTolerancePct': 75 })).toBe(true);
    expect(isGoodTry(IN_TUNE, drillTry(ECHO), { 'accuracy.inTolerancePct': 10 })).toBe(false);
    expect(isGoodTry(IN_TUNE, { metrics: { 'accuracy.inTolerancePct': 75 }, durationSec: 1 })).toBe(true);
    expect(isGoodTry(IN_TUNE, { metrics: { 'accuracy.inTolerancePct': 75 }, durationSec: 0 })).toBe(false);
  });
});

describe('lessonProgress', () => {
  it('nothing sung: every step at 0 of its good tries, the first step current, not ready, not passed', () => {
    expect(lessonProgress(LESSON, [], EMPTY)).toEqual({
      levelId: 'foundations.02',
      steps: [
        { exerciseId: ECHO, good: 0, needed: 2, tries: 0, done: false },
        { exerciseId: SLIDE, good: 0, needed: 3, tries: 0, done: false },
      ],
      currentStep: 0,
      ready: false,
      passed: false,
    });
  });

  it('counts each step’s good tries from the log by its drill’s exercise id; every try counts as a try', () => {
    const log = [
      drillTry(ECHO),
      drillTry(ECHO, { metrics: { 'accuracy.inTolerancePct': 20 } }), // off: a try, not a good one
      drillTry(ECHO, { durationSec: 3 }), // stopped early
      drillTry(ECHO, { deletedAt: '2026-03-02T00:00:00.000Z' }), // deleted: gone
      drillTry(SLIDE, { metrics: {} }),
      pass('foundations.02', { exerciseId: 'foundations.match.1' }), // the level's own take: not practice of a step
      drillTry('foundations.audition.6'), // another exercise
    ];
    const p = lessonProgress(LESSON, log, snap(log));
    expect(p.steps).toEqual([
      { exerciseId: ECHO, good: 1, needed: 2, tries: 3, done: false },
      { exerciseId: SLIDE, good: 1, needed: 3, tries: 1, done: false },
    ]);
    expect(p).toMatchObject({ currentStep: 0, ready: false });
  });

  it('caps a step’s good tries at what it asks for, and moves on to the next step', () => {
    const log = [drillTry(ECHO), drillTry(ECHO), drillTry(ECHO), drillTry(ECHO), drillTry(SLIDE)];
    const p = lessonProgress(LESSON, log, EMPTY);
    expect(p.steps[0]).toEqual({ exerciseId: ECHO, good: 2, needed: 2, tries: 4, done: true });
    expect(p.steps[1]).toMatchObject({ good: 1, needed: 3, done: false });
    expect(p).toMatchObject({ currentStep: 1, ready: false });
  });

  it('the steps go in order: a later step done first leaves the current step at the first one not done', () => {
    const log = [drillTry(SLIDE), drillTry(SLIDE), drillTry(SLIDE), drillTry(ECHO)];
    const p = lessonProgress(LESSON, log, EMPTY);
    expect(p.steps.map((s) => s.done)).toEqual([false, true]);
    expect(p).toMatchObject({ currentStep: 0, ready: false });
    const all = lessonProgress(LESSON, [...log, drillTry(ECHO)], EMPTY);
    expect(all).toMatchObject({ currentStep: 2, ready: true });
  });

  it('ready once every step has its good tries; a lesson with no practice is ready at once', () => {
    const log = [drillTry(ECHO), drillTry(ECHO), drillTry(SLIDE), drillTry(SLIDE), drillTry(SLIDE)];
    expect(lessonProgress(LESSON, log, EMPTY)).toMatchObject({ currentStep: 2, ready: true, passed: false });
    expect(lessonProgress({ ...LESSON, practice: [] }, [], EMPTY)).toMatchObject({ steps: [], currentStep: 0, ready: true });
  });

  it('passed comes from the snapshot alone: a pass of the level, or a grant; never from practice', () => {
    const practiced = [drillTry(ECHO), drillTry(ECHO), drillTry(SLIDE), drillTry(SLIDE), drillTry(SLIDE)];
    expect(lessonProgress(LESSON, practiced, snap(practiced)).passed).toBe(false);
    const passed = snap(passThrough(WORLDS, 'foundations.02'));
    expect(lessonProgress(LESSON, [], passed)).toMatchObject({ passed: true, ready: false });
    const granted = snap([pass('foundations.01'), passAudition('foundations', 5)]);
    expect(granted.levels['foundations.02']).toMatchObject({ status: 'passed', viaAudition: true });
    expect(lessonProgress(LESSON, [], granted).passed).toBe(true);
  });
});

describe('the engine and practice tries', () => {
  it('a practice try never changes a level, a world or a feature, however well it went and whatever it sang', () => {
    for (const base of [[], passThrough(WORLDS, 'foundations.01'), passThrough(WORLDS, 'foundations.13')]) {
      const tries = [
        // The level's own exercise, passed with every tally: still no level.
        drillTry('foundations.match.1', { passed: true, mastery: 3, score: 1 }),
        // An audition test's exercise (today's, or a retired one), passed: a practice row grants nothing.
        drillTry('foundations.audition.5', { passed: true, mastery: 3, score: 1 }),
        drillTry('foundations.audition.8', { passed: true, mastery: 1, score: 0.9 }),
        drillTry('foundations.audition.1', { passed: true, mastery: 3, score: 1 }),
        drillTry('foundations.boss-tune', { passed: true, mastery: 3, score: 1 }),
      ];
      const before = snap(base);
      const after = snap([...base, ...tries]);
      expect(after.levels).toEqual(before.levels);
      expect(after.worldsUnlocked).toEqual(before.worldsUnlocked);
      expect(after.features).toEqual(before.features);
    }
  });
});

describe('stepAfterMiss: a missed check goes back to practice (review R4)', () => {
  /** The check of LESSON's level (Match one note): gated on in-tune time, then on the time to find the note. */
  const CHECK = getExercise('foundations.match.1')!;
  const checkTake = (passed: boolean, metrics: AttemptRecord['metrics'] = {}, over: Partial<AttemptRecord> = {}): AttemptRecord =>
    attempt({ levelId: 'foundations.02', exerciseId: CHECK.id, kind: 'practice', passed, metrics, ...over });

  it('after a miss: the last step whose good-try rule reads the first gate the check missed, else the last step', () => {
    expect(CHECK.pass.gates!.map((g) => g.metric)).toEqual(['accuracy.inTolerancePct', 'onset.settleMs']);
    // Out of tune: the step that practises in-tune time.
    expect(stepAfterMiss(LESSON, CHECK, [checkTake(false, { 'accuracy.inTolerancePct': 10, 'onset.settleMs': 100 })])).toBe(0);
    expect(stepForMiss(LESSON, CHECK, { 'accuracy.inTolerancePct': 10 })).toBe(0);
    // In tune but slow to find the note: no step reads that, so the last step, the one nearest the check.
    expect(stepAfterMiss(LESSON, CHECK, [checkTake(false, { 'accuracy.inTolerancePct': 95, 'onset.settleMs': 3000 })])).toBe(1);
    // A miss on the score alone (no gate missed): the last step too.
    expect(stepForMiss(LESSON, CHECK, { 'accuracy.inTolerancePct': 95, 'onset.settleMs': 50 })).toBe(1);
  });

  it('stays until a good try is sung: a try that is not good leaves the singer on practice', () => {
    const missed = checkTake(false, { 'accuracy.inTolerancePct': 10 });
    expect(stepAfterMiss(LESSON, CHECK, [missed, drillTry(ECHO, { metrics: { 'accuracy.inTolerancePct': 10 } })])).toBe(0);
    expect(stepAfterMiss(LESSON, CHECK, [missed, drillTry(ECHO, { durationSec: 1 })])).toBe(0); // stopped early: not good
    expect(stepAfterMiss(LESSON, CHECK, [missed, drillTry(ECHO)])).toBeNull(); // a good try: the check is the move again
    expect(stepAfterMiss(LESSON, CHECK, [missed, drillTry(SLIDE)])).toBeNull(); // a good try on any step of the lesson
  });

  it('has nothing to go back for without a missed check: none sung, the latest passed, a record attempt, retired material', () => {
    expect(stepAfterMiss(LESSON, CHECK, [])).toBeNull();
    expect(stepAfterMiss(LESSON, CHECK, [checkTake(false), checkTake(true)])).toBeNull();
    expect(stepAfterMiss(LESSON, CHECK, [checkTake(false, {}, { kind: 'record' })])).toBeNull();
    // A take of the material this lesson replaced (sung before the rebuild) is not a take of its check.
    expect(stepAfterMiss(LESSON, CHECK, [checkTake(false, {}, { exerciseId: 'foundations.pitch-match.1' })])).toBeNull();
    expect(stepAfterMiss(LESSON, CHECK, [checkTake(false, {}, { deletedAt: '2026-03-02T00:00:00.000Z' })])).toBeNull();
    expect(stepAfterMiss({ ...LESSON, practice: [] }, CHECK, [checkTake(false)])).toBeNull();
  });
});

describe('isCheckOpen: practice first, then the check (owner, 2026-10-23)', () => {
  /** A good try of every practice step of the lesson, as the runner writes them: each condition met exactly. */
  function practiceDone(levelId: string): AttemptRecord[] {
    const lesson = lessonFor(levelId)!;
    return lesson.practice.flatMap((step) =>
      Array.from({ length: step.goodTries }, () =>
        drillTry(step.exerciseId, { metrics: Object.fromEntries(step.good.conditions.map((c) => [c.metric, c.value])) }),
      ),
    );
  }

  it('keeps a lesson’s check closed until every practice step is done', () => {
    expect(lessonFor('foundations.13')).toBeDefined();
    expect(isCheckOpen('foundations.13', [], EMPTY)).toBe(false);
    const done = practiceDone('foundations.13');
    expect(isCheckOpen('foundations.13', done.slice(0, -1), snap(done.slice(0, -1)))).toBe(false);
    expect(isCheckOpen('foundations.13', done, snap(done))).toBe(true);
  });

  it('opens the check of a passed lesson (to sing it again), even with no practice in the log', () => {
    const log = passThrough(WORLDS, 'foundations.13');
    expect(isCheckOpen('foundations.13', log, snap(log))).toBe(true);
  });

  it('opens the Range finder from the start: it measures the voice, it does not grade a skill', () => {
    expect(isMeasuringLevel('foundations.01')).toBe(true);
    expect(isMeasuringLevel('foundations.13')).toBe(false);
    expect(isCheckOpen('foundations.01', [], EMPTY)).toBe(true);
  });

  it('leaves a level without a lesson in the classic flow (open)', () => {
    expect(lessonFor('vibrato.01')).toBeUndefined();
    expect(isCheckOpen('vibrato.01', [], EMPTY)).toBe(true);
  });
});
