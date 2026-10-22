/**
 * The report's next steps and the unlock events, over the real catalog and progression. Pure apart from the song
 * index, which is mocked here (the song builder owns it).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WORLDS, getWorld } from '../exercises';
import { computeSnapshot } from '../progress';
import { BASE_MS, P1, pass, passAudition, passThrough } from '../progress/test-fixtures';
import type { ProgressSnapshot } from '../progress/types';
import { routeOf } from '../router';
import type { AttemptRecord } from '../storage/schema';
import { songIndex } from '../state/songs';
import { afterTakeActions, auditionTests, unlockEvents } from './flow';
import { guardRoute } from './guard';
import type { PreparedRun, RunTarget, TakeOutcome } from './types';
import type { WorkoutItem } from '../progress';

vi.mock('../state/songs', async () => {
  const { signal } = await import('@preact/signals');
  return { songIndex: signal(new Map()), songsLoaded: signal(true), songLoadErrors: signal([]), loadSongs: async () => undefined, getSong: async () => undefined };
});

afterEach(() => {
  songIndex.value = new Map();
});

const snap = (attempts: AttemptRecord[]): ProgressSnapshot => computeSnapshot(P1, WORLDS, attempts, BASE_MS);

/** Just what afterTakeActions reads from an outcome. */
function outcome(target: RunTarget, passed: boolean, after: ProgressSnapshot, workout: PreparedRun['workout'] = null): TakeOutcome {
  return { prepared: { target, workout }, attempt: { passed }, after } as unknown as TakeOutcome;
}

function item(takes: number): WorkoutItem {
  return { stage: 'world-item', source: 'level', levelId: 'foundations.02', exerciseId: 'foundations.pitch-match.1', worldId: 'foundations', title: 'Pitch match', reason: 'current-level', takes, estSeconds: 60, estMinutes: 1 };
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
    const afterTest1 = snap([pass('foundations.01'), passAudition('foundations', 1)]);
    const next = afterTakeActions(outcome(target, true, afterTest1));
    expect(kinds(next)).toEqual(['next-test*', 'audition-results']);
    expect(next[0]).toMatchObject({ label: 'Next test', route: routeOf('sing', { target: 'audition', worldId: 'foundations' }) });
    expect(next[1]).toMatchObject({ label: 'See your placement', route: routeOf('audition', { worldId: 'foundations' }) });

    expect(kinds(afterTakeActions(outcome(target, false, afterTest1)))).toEqual(['audition-results*']);
    const allTests = snap([pass('foundations.01'), ...[1, 2, 3, 4].map((n) => passAudition('foundations', n))]);
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
      { kind: 'record', levelId: 'foundations.03' },
      { kind: 'audition', worldId: 'foundations' },
    ];
    for (const t of targets) for (const passed of [true, false]) expect(afterTakeActions(outcome(t, passed, after)).filter((a) => a.primary)).toHaveLength(1);
  });
});

describe('auditionTests', () => {
  it('captions each test with the levels it unlocks, never the Range finder (always sung)', () => {
    expect(auditionTests(getWorld('foundations')!)).toEqual([
      { exerciseId: 'foundations.audition.1', index: 0, unlocksFirst: 'Pitch match', unlocksLast: 'Sustain II' },
      { exerciseId: 'foundations.audition.2', index: 1, unlocksFirst: 'Sirens & glides', unlocksLast: 'Sirens & glides' },
      { exerciseId: 'foundations.audition.3', index: 2, unlocksFirst: 'Crispness', unlocksLast: 'Interval jumps II' },
      { exerciseId: 'foundations.audition.4', index: 3, unlocksFirst: 'Legato lines', unlocksLast: 'Legato lines' },
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
      { kind: 'level-opened', levelId: 'foundations.02', title: 'Pitch match' },
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
    const events = unlockEvents(snap(base), snap([...base, passAudition('foundations', 1)]), WORLDS);
    expect(events).toEqual([
      { kind: 'level-opened', levelId: 'foundations.02', title: 'Pitch match' },
      { kind: 'level-opened', levelId: 'foundations.03', title: 'Sustain I' },
      { kind: 'level-opened', levelId: 'foundations.04', title: 'Sustain II' },
      { kind: 'level-opened', levelId: 'foundations.05', title: 'Sirens & glides' },
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
    const before = snap(passThrough(WORLDS, 'foundations.09'));
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
