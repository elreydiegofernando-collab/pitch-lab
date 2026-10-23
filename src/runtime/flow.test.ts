/**
 * The report's next steps and the unlock events, over the real catalog and progression. Pure apart from the song
 * index, which is mocked here (the song builder owns it), and the lessons: one known lesson (Pitch match's) stands in
 * for the Foundations content, so these cases do not move with it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WORLDS, getExercise, getWorld, realize } from '../exercises';
import type { LessonDef } from '../lessons/types';
import { computeSnapshot } from '../progress';
import { BASE_MS, P1, attempt, pass, passAudition, passThrough } from '../progress/test-fixtures';
import type { ProgressSnapshot } from '../progress/types';
import { routeOf } from '../router';
import type { AttemptRecord } from '../storage/schema';
import { songIndex } from '../state/songs';
import { jargonIn } from '../coaching/plain';
import { FEATURE_TITLES, afterTakeActions, auditionTests, isGoodDrillTry, unlockEvents } from './flow';
import { guardRoute } from './guard';
import type { PreparedRun, RunTarget, TakeOutcome } from './types';
import type { WorkoutItem } from '../progress';

vi.mock('../state/songs', async () => {
  const { signal } = await import('@preact/signals');
  return { songIndex: signal(new Map()), songsLoaded: signal(true), songLoadErrors: signal([]), loadSongs: async () => undefined, getSong: async () => undefined };
});

/** Pitch match's lesson: two echo-shaped steps (catalog exercises stand in for the drills). */
const lessons = vi.hoisted(() => {
  const lesson: LessonDef = {
    levelId: 'foundations.02',
    title: 'Match one note',
    outcome: 'Hear a note, then sing it back on it.',
    learn: { what: 'Singing back a note you just heard.', why: 'Songs are notes sung back.', how: ['Listen.', 'Think it.', 'Sing it.'], onScreen: ['The bar is the note.'], terms: ['note', 'echo'] },
    practice: [
      { exerciseId: 'foundations.audition.1', title: 'Echo one note', ask: 'Listen, then sing it back.', goodTries: 2, good: { conditions: [{ metric: 'accuracy.inTolerancePct', op: '>=', value: 50 }] } },
      { exerciseId: 'foundations.audition.2', title: 'One slide', ask: 'Slide up and back down.', goodTries: 1, good: { conditions: [] } },
    ],
  };
  return { lesson };
});
vi.mock('../lessons/foundations', () => ({ FOUNDATIONS_LESSONS: { 'foundations.02': lessons.lesson } }));

afterEach(() => {
  songIndex.value = new Map();
});

const snap = (attempts: AttemptRecord[]): ProgressSnapshot => computeSnapshot(P1, WORLDS, attempts, BASE_MS);

/** Just what afterTakeActions reads from an outcome. */
function outcome(target: RunTarget, passed: boolean, after: ProgressSnapshot, workout: PreparedRun['workout'] = null): TakeOutcome {
  return { prepared: { target, workout }, attempt: { passed }, after } as unknown as TakeOutcome;
}

function item(takes: number): WorkoutItem {
  return { stage: 'world-item', source: 'level', levelId: 'foundations.02', exerciseId: 'foundations.match.1', worldId: 'foundations', title: 'Match one note', reason: 'current-level', takes, estSeconds: 60, estMinutes: 1 };
}

const kinds = (actions: ReturnType<typeof afterTakeActions>) => actions.map((a) => `${a.kind}${a.primary ? '*' : ''}`);

describe('afterTakeActions', () => {
  it('a passed level offers the next level (primary) and a retry; a miss offers a retry (primary) and the level', () => {
    const after = snap(passThrough(WORLDS, 'foundations.02'));
    const passed = afterTakeActions(outcome({ kind: 'level', levelId: 'foundations.02' }, true, after));
    expect(kinds(passed)).toEqual(['next-level*', 'retry']);
    expect(passed[0]).toMatchObject({ label: 'Next level', route: routeOf('level', { levelId: 'foundations.03' }) });
    expect(passed[1]).toMatchObject({ label: 'Retry', route: routeOf('sing', { target: 'level', levelId: 'foundations.02' }) });

    const missed = afterTakeActions(outcome({ kind: 'level', levelId: 'foundations.03' }, false, after));
    expect(kinds(missed)).toEqual(['retry*', 'level']);
    expect(missed[1]).toMatchObject({ label: 'Back to level', route: routeOf('level', { levelId: 'foundations.03' }) });
  });

  it('a tempo-ladder take that climbed a rung says the retry sings at the new tempo', () => {
    const after = snap(passThrough(WORLDS, 'foundations.02'));
    const ladderTake = (bpm: number, nextBpm: number | null) =>
      ({ prepared: { target: { kind: 'level', levelId: 'foundations.03' }, workout: null, bpm }, attempt: { passed: false }, after, nextBpm }) as unknown as TakeOutcome;
    const climbed = afterTakeActions(ladderTake(45, 68));
    expect(kinds(climbed)).toEqual(['retry*', 'level']);
    expect(climbed[0]).toMatchObject({ label: 'Sing at 68 bpm', route: routeOf('sing', { target: 'level', levelId: 'foundations.03' }) });
    expect(afterTakeActions(ladderTake(45, 45))[0].label).toBe('Retry');
    expect(afterTakeActions(ladderTake(60, null))[0].label).toBe('Retry');
  });

  it('after a Boss Recital, "Next level" is the first level of the world it opened; after the last one, the map', () => {
    const afterBoss = snap(passThrough(WORLDS, 'foundations.boss'));
    expect(afterTakeActions(outcome({ kind: 'level', levelId: 'foundations.boss' }, true, afterBoss))[0]).toMatchObject({
      kind: 'next-level',
      route: routeOf('level', { levelId: 'vibrato.01' }),
    });
    const all = snap(passThrough(WORLDS, 'dynamics.boss'));
    const last = afterTakeActions(outcome({ kind: 'level', levelId: 'dynamics.boss' }, true, all));
    expect(kinds(last)).toEqual(['map*', 'retry']);
    expect(last[0]).toMatchObject({ label: 'World map', route: routeOf('map', { worldId: 'dynamics' }) });
  });

  it('never offers a next level the guard would refuse', () => {
    // A replayed level passes, but the singer is further on: its next level is passed (open) and is offered.
    const after = snap(passThrough(WORLDS, 'foundations.05'));
    const replay = afterTakeActions(outcome({ kind: 'level', levelId: 'foundations.02' }, true, after));
    expect(replay[0].route).toEqual(routeOf('level', { levelId: 'foundations.03' }));
    const ctx = { snapshot: after, worlds: WORLDS, songRequiredWorld: () => undefined, songsLoaded: true, hasOutcome: true, workoutItems: 3 };
    for (const a of replay) expect(guardRoute(a.route, ctx), a.kind).toEqual({ ok: true });
  });

  it('a record attempt: retry (primary) and back to the level, pass or miss', () => {
    const after = snap(passThrough(WORLDS, 'foundations.02'));
    for (const passed of [true, false]) {
      expect(kinds(afterTakeActions(outcome({ kind: 'record', levelId: 'foundations.02' }, passed, after)))).toEqual(['retry*', 'level']);
    }
  });

  it('an audition: the next test after a pass, the placement after a miss or the last test', () => {
    const target: RunTarget = { kind: 'audition', worldId: 'foundations' };
    const afterTest1 = snap([pass('foundations.01'), passAudition('foundations', 5)]);
    const next = afterTakeActions(outcome(target, true, afterTest1));
    expect(kinds(next)).toEqual(['next-test*', 'audition-results']);
    expect(next[0]).toMatchObject({ label: 'Next test', route: routeOf('sing', { target: 'audition', worldId: 'foundations' }) });
    expect(next[1]).toMatchObject({ label: 'See your placement', route: routeOf('audition', { worldId: 'foundations' }) });

    expect(kinds(afterTakeActions(outcome(target, false, afterTest1)))).toEqual(['audition-results*']);
    const allTests = snap([pass('foundations.01'), ...[5, 6, 7, 8].map((n) => passAudition('foundations', n))]);
    expect(kinds(afterTakeActions(outcome(target, true, allTests)))).toEqual(['audition-results*']);
  });

  it('a workout: another take of the item, then the next item, then the summary', () => {
    const after = snap(passThrough(WORLDS, 'foundations.01'));
    const at = (itemIndex: number, take: number, takes: number, itemCount = 3) =>
      afterTakeActions(outcome({ kind: 'workout', itemIndex }, true, after, { item: item(takes), itemIndex, itemCount, take }));
    const more = at(0, 1, 2);
    expect(kinds(more)).toEqual(['next-take*', 'next-item']);
    expect(more[0].route).toEqual(routeOf('sing', { target: 'workout', itemIndex: '0' }));
    expect(more[1].route).toEqual(routeOf('sing', { target: 'workout', itemIndex: '1' }));
    expect(kinds(at(0, 2, 2))).toEqual(['next-item*', 'finish-workout']);
    expect(kinds(at(2, 1, 2))).toEqual(['next-take*', 'finish-workout']);
    const done = at(2, 2, 2);
    expect(kinds(done)).toEqual(['finish-workout*']);
    expect(done[0]).toMatchObject({ label: 'Finish workout', route: routeOf('workout') });
  });

  it('always has exactly one primary action', () => {
    const after = snap(passThrough(WORLDS, 'foundations.03'));
    const targets: RunTarget[] = [
      { kind: 'level', levelId: 'foundations.03' },
      { kind: 'level', levelId: 'foundations.02' }, // taught by a lesson
      { kind: 'record', levelId: 'foundations.03' },
      { kind: 'audition', worldId: 'foundations' },
    ];
    for (const t of targets) for (const passed of [true, false]) expect(afterTakeActions(outcome(t, passed, after)).filter((a) => a.primary)).toHaveLength(1);
  });

  it('a missed check of a level taught by a lesson goes back to practice first: "Back to practice" leads, the check is second (review R4)', () => {
    const after = snap(passThrough(WORLDS, 'foundations.01'));
    const missed = afterTakeActions(outcome({ kind: 'level', levelId: 'foundations.02' }, false, after));
    expect(kinds(missed)).toEqual(['lesson*', 'retry']);
    expect(missed[0]).toEqual({ kind: 'lesson', label: 'Back to practice', primary: true, route: routeOf('level', { levelId: 'foundations.02' }) });
    expect(missed[1]).toEqual({ kind: 'retry', label: 'Take the check again', primary: false, route: routeOf('sing', { target: 'level', levelId: 'foundations.02' }) });
    const ctx = { snapshot: after, worlds: WORLDS, songRequiredWorld: () => undefined, songsLoaded: true, hasOutcome: true, workoutItems: null };
    for (const a of missed) expect(guardRoute(a.route, ctx), a.kind).toEqual({ ok: true });
    // A pass moves on as before; a level with no lesson keeps "Back to level".
    expect(kinds(afterTakeActions(outcome({ kind: 'level', levelId: 'foundations.02' }, true, snap(passThrough(WORLDS, 'foundations.02')))))).toEqual(['next-level*', 'retry']);
    expect(kinds(afterTakeActions(outcome({ kind: 'level', levelId: 'foundations.03' }, false, after)))).toEqual(['retry*', 'level']);
  });
});

describe('afterTakeActions: a lesson’s practice try', () => {
  const LEVEL = 'foundations.02';
  const [ECHO, SLIDE] = lessons.lesson.practice;
  /** Level 02 is open: everything the report offers must get past the guard. */
  const open = snap(passThrough(WORLDS, 'foundations.01'));

  /** Count-in plus material at the exercise's own tempo: a try sung to its end, as the runner writes it. */
  function whole(exerciseId: string): number {
    const r = realize(getExercise(exerciseId)!, null, 'unknown');
    return r.countInSec + r.totalSec;
  }

  type How = 'good' | 'off' | 'stopped' | 'silent';
  /** The row of a try of `step` sung `how`, and the step's good tries counting it (the runner's PreparedRun.drill). */
  function tryOf(step: number, how: How, counted: { good: number; needed: number }, passed = false): TakeOutcome {
    const exerciseId = lessons.lesson.practice[step].exerciseId;
    const full = whole(exerciseId);
    const row = attempt({
      exerciseId,
      levelId: null,
      kind: 'practice',
      passed,
      tempoBpm: getExercise(exerciseId)!.tempoBpm,
      durationSec: how === 'silent' ? 0 : how === 'stopped' ? full / 2 : full,
      metrics: { 'accuracy.inTolerancePct': how === 'off' ? 12 : 88 },
    });
    const drill = { levelId: LEVEL, step, stepCount: lessons.lesson.practice.length, ...counted };
    return { prepared: { target: { kind: 'drill', levelId: LEVEL, step }, workout: null, drill }, attempt: row, after: open } as unknown as TakeOutcome;
  }

  const sing = (step: number) => routeOf('sing', { target: 'drill', levelId: LEVEL, itemIndex: String(step) });
  const ctx = { snapshot: open, worlds: WORLDS, songRequiredWorld: () => undefined, songsLoaded: true, hasOutcome: true, workoutItems: null };

  it('a good try short of its step: "Again" (primary) and back to the lesson', () => {
    const actions = afterTakeActions(tryOf(0, 'good', { good: 1, needed: ECHO.goodTries }));
    expect(actions).toEqual([
      { kind: 'next-try', label: 'Again', primary: true, route: sing(0) },
      { kind: 'lesson', label: 'Back to the lesson', primary: false, route: routeOf('level', { levelId: LEVEL }) },
    ]);
  });

  it('a good try that finished its step: "Next step" (primary), with one more try of this one', () => {
    const actions = afterTakeActions(tryOf(0, 'good', { good: 2, needed: 2 }));
    expect(actions).toEqual([
      { kind: 'next-step', label: 'Next step', primary: true, route: sing(1) },
      { kind: 'next-try', label: 'One more try', primary: false, route: sing(0) },
    ]);
  });

  it('a good try that finished the last step: "Take the check" (primary), which sings the level itself', () => {
    const actions = afterTakeActions(tryOf(1, 'good', { good: 1, needed: SLIDE.goodTries }));
    expect(actions).toEqual([
      { kind: 'take-check', label: 'Take the check', primary: true, route: routeOf('sing', { target: 'level', levelId: LEVEL }) },
      { kind: 'next-try', label: 'One more try', primary: false, route: sing(1) },
    ]);
  });

  it('a try that was not good (off, stopped early or silent): "Try again" (primary) and back to the lesson, even on a step already done', () => {
    for (const how of ['off', 'stopped', 'silent'] as const) {
      for (const counted of [{ good: 0, needed: 2 }, { good: 2, needed: 2 }]) {
        const take = tryOf(0, how, counted);
        expect(isGoodDrillTry(LEVEL, 0, take.attempt), how).toBe(false);
        expect(afterTakeActions(take), `${how} ${counted.good}`).toEqual([
          { kind: 'next-try', label: 'Try again', primary: true, route: sing(0) },
          { kind: 'lesson', label: 'Back to the lesson', primary: false, route: routeOf('level', { levelId: LEVEL }) },
        ]);
      }
    }
  });

  it('practice has no pass or fail: the attempt’s own verdict never changes what comes next', () => {
    expect(kinds(afterTakeActions(tryOf(0, 'off', { good: 1, needed: 2 }, true)))).toEqual(['next-try*', 'lesson']);
    expect(kinds(afterTakeActions(tryOf(0, 'good', { good: 2, needed: 2 }, false)))).toEqual(['next-step*', 'next-try']);
  });

  it('a step or lesson that does not exist is never a good try: sing it again, or go back', () => {
    const take = tryOf(0, 'good', { good: 2, needed: 2 });
    expect(isGoodDrillTry(LEVEL, 0, take.attempt)).toBe(true);
    expect(isGoodDrillTry(LEVEL, 7, take.attempt)).toBe(false);
    expect(isGoodDrillTry('foundations.03', 0, take.attempt)).toBe(false);
    const stale = { ...take, prepared: { ...take.prepared, target: { kind: 'drill', levelId: LEVEL, step: 7 }, drill: null } } as unknown as TakeOutcome;
    expect(kinds(afterTakeActions(stale))).toEqual(['next-try*', 'lesson']);
  });

  it('always exactly one primary, and nothing the guard would refuse', () => {
    const cases: TakeOutcome[] = [];
    for (const how of ['good', 'off', 'stopped', 'silent'] as const) {
      for (const step of [0, 1]) {
        const needed = lessons.lesson.practice[step].goodTries;
        for (let good = 0; good <= needed; good++) cases.push(tryOf(step, how, { good, needed }));
      }
    }
    for (const take of cases) {
      const actions = afterTakeActions(take);
      expect(actions.filter((a) => a.primary)).toHaveLength(1);
      for (const a of actions) expect(guardRoute(a.route, ctx), `${a.kind} ${JSON.stringify(a.route)}`).toEqual({ ok: true });
    }
  });
});

describe('auditionTests', () => {
  it('captions each test with the levels it unlocks, never the Range finder (always sung)', () => {
    expect(auditionTests(getWorld('foundations')!)).toEqual([
      { exerciseId: 'foundations.audition.5', index: 0, unlocksFirst: 'Match one note', unlocksLast: 'Hold it steady' },
      { exerciseId: 'foundations.audition.6', index: 1, unlocksFirst: 'Two notes, one step apart', unlocksLast: 'Bigger jumps' },
      { exerciseId: 'foundations.audition.7', index: 2, unlocksFirst: 'Three notes: do-re-mi', unlocksLast: 'Five notes in a row' },
      { exerciseId: 'foundations.audition.8', index: 3, unlocksFirst: 'Small slides', unlocksLast: 'Sirens' },
    ]);
    expect(auditionTests(getWorld('song-stage')!)).toEqual([]);
  });
});

describe('unlockEvents', () => {
  it('the first pass: the level, the next level, then the features it opened', () => {
    const before = snap([]);
    const after = snap([pass('foundations.01', { mastery: 3 })]);
    expect(unlockEvents(before, after, WORLDS)).toEqual([
      { kind: 'level-passed', levelId: 'foundations.01', title: 'Range finder', mastery: 3 },
      { kind: 'level-opened', levelId: 'foundations.02', title: 'Match one note' },
      { kind: 'feature', featureId: 'dashboard', title: 'Progress dashboard' },
      { kind: 'feature', featureId: 'daily-workout', title: 'Daily workout' },
      { kind: 'feature', featureId: 'records', title: 'Personal records' },
    ]);
  });

  it('a higher tally on a passed level is a mastery event; the same snapshot twice is nothing', () => {
    const first = [pass('foundations.01', { mastery: 1 })];
    const before = snap(first);
    const after = snap([...first, pass('foundations.01', { mastery: 3 })]);
    expect(unlockEvents(before, after, WORLDS)).toEqual([{ kind: 'mastery', levelId: 'foundations.01', title: 'Range finder', mastery: 3 }]);
    expect(unlockEvents(after, after, WORLDS)).toEqual([]);
  });

  it('an audition test opens its span (granted, not "passed") and the level after it', () => {
    const base = [pass('foundations.01')];
    const events = unlockEvents(snap(base), snap([...base, passAudition('foundations', 5)]), WORLDS);
    expect(events).toEqual([
      { kind: 'level-opened', levelId: 'foundations.02', title: 'Match one note' },
      { kind: 'level-opened', levelId: 'foundations.03', title: 'Hold it' },
      { kind: 'level-opened', levelId: 'foundations.13', title: 'Hold it steady' },
      { kind: 'level-opened', levelId: 'foundations.10', title: 'Two notes, one step apart' },
    ]);
  });

  it('a Boss Recital: the boss by its world, the next world, its features, and the songs it opened', () => {
    songIndex.value = new Map(
      (
        [
          ['twinkle-twinkle', 'foundations'],
          ['auld-lang-syne', 'foundations'],
          ['ave-maria', 'runs'],
        ] as const
      ).map(([id, requiredWorld]) => [id, { id, difficulty: { requiredWorld } }] as never),
    );
    const before = snap(passThrough(WORLDS, 'foundations.06')); // every level but the boss: Clean starts is last
    const after = snap(passThrough(WORLDS, 'foundations.boss'));
    const events = unlockEvents(before, after, WORLDS);
    expect(events[0]).toEqual({ kind: 'level-passed', levelId: 'foundations.boss', title: 'Foundations Boss Recital', mastery: 1 });
    expect(events).toContainEqual({ kind: 'level-opened', levelId: 'vibrato.01', title: expect.any(String) });
    expect(events.filter((e) => e.kind === 'world-opened')).toEqual([{ kind: 'world-opened', worldId: 'vibrato', title: 'Vibrato' }]); // Song Stage is told by its feature
    expect(events.filter((e) => e.kind === 'feature').map((e) => (e.kind === 'feature' ? e.featureId : ''))).toEqual([
      'live.vibrato',
      'tool.vibrato-meter',
      'setting.vibratoStyle',
      'song-stage',
      'song.import',
    ]);
    expect(events[events.length - 1]).toEqual({ kind: 'songs', requiredWorld: 'foundations', count: 2 });
    expect(events.map((e) => e.kind)).toEqual(['level-passed', 'level-opened', 'world-opened', 'feature', 'feature', 'feature', 'feature', 'feature', 'songs']);
  });

  it('no song event when the index has none for that world', () => {
    const events = unlockEvents(snap(passThrough(WORLDS, 'foundations.09')), snap(passThrough(WORLDS, 'foundations.boss')), WORLDS);
    expect(events.some((e) => e.kind === 'songs')).toBe(false);
  });
});

describe('FEATURE_TITLES', () => {
  it('names every feature in plain words: no settle, scoop, readouts, units or old level names (review R6)', () => {
    for (const [id, title] of Object.entries(FEATURE_TITLES)) {
      expect(jargonIn(title), id).toEqual([]);
      expect(title, id).not.toMatch(/settl|scoop|readout|trace|onset|latency|crispness/i);
    }
    expect(FEATURE_TITLES['live.onset']).toBe('How each note starts, on Live');
    expect(FEATURE_TITLES['live.cracks']).toBe('Cracks marked on your Live line');
  });
});
