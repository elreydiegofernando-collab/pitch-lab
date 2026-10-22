import { describe, expect, it } from 'vitest';
import { WORLDS, getExercise } from '../../exercises';
import { buildDailyWorkout, withRoutines, type WorkoutItem } from '../../progress';
import type { WorkoutSession, WorkoutSummary } from '../../runtime/workout';
import { itemMeta, reasonCaption, sessionView, stageHeading, summaryFacts, totalText } from './workout-view';
import { passWorld, snapshotOf } from './test-fixtures';

function item(over: Partial<WorkoutItem> = {}): WorkoutItem {
  return {
    stage: 'world-item',
    source: 'level',
    levelId: 'foundations.06',
    exerciseId: 'foundations.staccato.1',
    worldId: 'foundations',
    title: 'Crispness',
    reason: 'current-level',
    takes: 3,
    estSeconds: 250,
    estMinutes: 250 / 60,
    ...over,
  };
}

function session(items: WorkoutItem[], taken: number[], finishedAt: string | null = null): WorkoutSession {
  return {
    workout: { minutes: 10, locked: false, hint: null, items, totalEstSeconds: 0, totalEstMinutes: 0 },
    startedAt: '2026-10-21T10:00:00.000Z',
    results: taken.map((n) => ({ attemptIds: Array.from({ length: n }, (_, i) => `a${i}`), bestScore: null, passedAny: false })),
    finishedAt,
  };
}

describe('stage headings', () => {
  it('names each stage, and the world the world items come from', () => {
    expect(stageHeading(item({ stage: 'warm-up', worldId: null }))).toBe('Warm-up');
    expect(stageHeading(item({ stage: 'world-item' }))).toBe('From Foundations');
    expect(stageHeading(item({ stage: 'review' }))).toBe('Review');
    expect(stageHeading(item({ stage: 'cool-down', worldId: null }))).toBe('Cool-down');
  });
});

describe('reason captions', () => {
  it('says why each kind of item is in the set', () => {
    expect(reasonCaption(item({ reason: 'warm-up' }))).toBe('Easy sirens to wake the voice');
    expect(reasonCaption(item({ reason: 'cool-down' }))).toBe('Slow glides to let the voice settle');
    expect(reasonCaption(item({ reason: 'current-level' }))).toBe('Your next level');
    expect(reasonCaption(item({ reason: 'consolidate' }))).toBe('Making a level you passed solid');
  });

  it('names the weakest skill by what the exercise trains', () => {
    expect(reasonCaption(item({ reason: 'weakest', exerciseId: 'foundations.staccato.1' }))).toBe('Your weakest skill: Crispness');
    expect(reasonCaption(item({ reason: 'weakest', exerciseId: 'foundations.sustain.1' }))).toBe('Your weakest skill: Stability');
    expect(reasonCaption(item({ reason: 'weakest', exerciseId: 'nothing.known' }))).toBe('Your weakest level');
  });

  it('reads sensibly for a real built workout', () => {
    const attempts = passWorld('foundations', 'foundations.07');
    const snapshot = snapshotOf(attempts);
    const workout = buildDailyWorkout({ minutes: 20, snapshot, worlds: WORLDS, attempts, now: Date.now(), getExercise: withRoutines(getExercise) });
    expect(workout.locked).toBe(false);
    for (const it of workout.items) {
      expect(reasonCaption(it)).not.toBe('');
      expect(itemMeta(it)).toMatch(/^\d+ takes? · about \d+ min$/);
    }
    expect(workout.items[0].stage).toBe('warm-up');
    expect(workout.items[workout.items.length - 1].stage).toBe('cool-down');
  });
});

describe('item and total text', () => {
  it('says takes and a rounded duration, at least a minute', () => {
    expect(itemMeta(item({ takes: 3, estSeconds: 250 }))).toBe('3 takes · about 4 min');
    expect(itemMeta(item({ takes: 1, estSeconds: 20 }))).toBe('1 take · about 1 min');
  });

  it('says the total against the length picked', () => {
    expect(totalText({ minutes: 10, locked: false, hint: null, items: [], totalEstSeconds: 540, totalEstMinutes: 9 })).toBe('About 9 of 10 min');
  });
});

describe('sessionView', () => {
  const items = [item({ takes: 2 }), item({ takes: 1 }), item({ takes: 3 })];

  it('points at the first item still short of its takes', () => {
    const view = sessionView(session(items, [2, 0, 0]));
    expect(view.items.map((s) => s.complete)).toEqual([true, false, false]);
    expect(view.nextIndex).toBe(1);
    expect(view.takes).toBe(2);
  });

  it('keeps a half-sung item as the next one', () => {
    expect(sessionView(session(items, [1, 1, 0])).nextIndex).toBe(0);
  });

  it('has no next item once every item has all its takes', () => {
    const view = sessionView(session(items, [2, 1, 3]));
    expect(view.nextIndex).toBeNull();
    expect(view.takes).toBe(6);
  });

  it('treats a missing result as no takes', () => {
    expect(sessionView(session(items, [])).nextIndex).toBe(0);
  });
});

describe('summaryFacts', () => {
  const summary: WorkoutSummary = { itemsDone: 3, itemCount: 3, takes: 6, minutes: 8.4, momentumBefore: 41.2, momentumAfter: 44.6 };

  it('reports the runtime\'s figures: items, takes, minutes sung, momentum before and after', () => {
    const facts = summaryFacts(session([item(), item(), item()], [2, 2, 2], '2026-10-21T10:09:00.000Z'), summary);
    expect(facts.title).toBe('Workout complete');
    expect(Object.fromEntries(facts.tiles.map((t) => [t.label, t.value]))).toEqual({
      Items: '3 of 3',
      Takes: '6',
      'Minutes sung': '8 min',
      Momentum: '41 → 45',
    });
  });

  it('says it ended early when items were left', () => {
    const facts = summaryFacts(session([item(), item(), item()], [1, 0, 0]), { ...summary, itemsDone: 1 });
    expect(facts.title).toBe('Workout ended early');
  });

  it('never invents the minutes or the momentum when it has no summary', () => {
    const facts = summaryFacts(session([item(), item()], [1, 0]), null);
    expect(facts.title).toBe('Workout ended early');
    expect(facts.tiles.map((t) => t.label)).toEqual(['Items', 'Takes']);
    expect(facts.tiles[0].value).toBe('1 of 2');
  });
});
