import { describe, expect, it } from 'vitest';
import { computeSnapshot } from './engine';
import { isImprovement, parseRecordKey, recordDirection, recordKey, recordsForExercise } from './records';
import { P1, attempt, exerciseDef, fixtureWorlds } from './test-fixtures';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const worlds = fixtureWorlds();
const records = (attempts: ReturnType<typeof attempt>[], getExercise?: (id: string) => ReturnType<typeof exerciseDef> | undefined) =>
  computeSnapshot(P1, worlds, attempts, NOW, { getExercise }).records;

describe('record keys and directions', () => {
  it('round-trips a key, even for ids with dots, dashes and colons', () => {
    for (const exerciseId of ['foundations.sustain.2', 'vibrato.boss-recital', 'odd:id.with:colons']) {
      expect(parseRecordKey(recordKey(exerciseId, 'accuracy.sdCents'))).toEqual({ exerciseId, metric: 'accuracy.sdCents' });
    }
    expect(parseRecordKey('no-separator')).toBeNull();
    expect(parseRecordKey(':leading')).toBeNull();
  });

  it('knows which way is better, and keeps no record for two-sided or unknown metrics', () => {
    expect(recordDirection('run.score')).toBe('higher');
    expect(recordDirection('onset.settleMs')).toBe('lower');
    expect(recordDirection('glide.cracks')).toBe('lower');
    expect(recordDirection('vibrato.rateHz')).toBeNull(); // two-sided
    expect(recordDirection('made.up')).toBeNull();
    expect(recordDirection('toString')).toBeNull();
  });

  it('counts only a STRICT improvement', () => {
    expect(isImprovement('higher', 2, 1)).toBe(true);
    expect(isImprovement('higher', 1, 1)).toBe(false);
    expect(isImprovement('lower', 1, 2)).toBe(true);
    expect(isImprovement('lower', 2, 2)).toBe(false);
  });
});

describe('personal records in the snapshot', () => {
  it('moves only on improvement, never back', () => {
    const r = records([
      attempt({ exerciseId: 'ex.run', metrics: { 'run.score': 0.6 } }),
      attempt({ exerciseId: 'ex.run', metrics: { 'run.score': 0.4 } }),
      attempt({ exerciseId: 'ex.run', metrics: { 'run.score': 0.9 } }),
      attempt({ exerciseId: 'ex.run', metrics: { 'run.score': 0.7 } }),
    ]);
    expect(r[recordKey('ex.run', 'run.score')].value).toBeCloseTo(0.9);
  });

  it('keeps the earlier attempt on a tie, and records which attempt and when', () => {
    const first = attempt({ id: 'first', exerciseId: 'ex.run', metrics: { 'run.score': 0.8 }, createdAt: '2026-03-01T10:00:00.000Z' });
    const tie = attempt({ id: 'tie', exerciseId: 'ex.run', metrics: { 'run.score': 0.8 }, createdAt: '2026-03-02T10:00:00.000Z' });
    expect(records([tie, first])[recordKey('ex.run', 'run.score')]).toEqual({ value: 0.8, attemptId: 'first', at: '2026-03-01T10:00:00.000Z' });
  });

  it('treats a LOWER value as the record for lower-is-better metrics', () => {
    const r = records([
      attempt({ exerciseId: 'ex.onset', metrics: { 'onset.settleMs': 300 } }),
      attempt({ exerciseId: 'ex.onset', metrics: { 'onset.settleMs': 150 } }),
      attempt({ exerciseId: 'ex.onset', metrics: { 'onset.settleMs': 400 } }),
    ]);
    expect(r[recordKey('ex.onset', 'onset.settleMs')].value).toBe(150);
  });

  it('keeps separate records per exercise and per metric', () => {
    const r = records([
      attempt({ exerciseId: 'a', metrics: { 'run.score': 0.5, 'run.definedRate': 0.6 } }),
      attempt({ exerciseId: 'b', metrics: { 'run.score': 0.9 } }),
    ]);
    expect(Object.keys(r).sort()).toEqual([recordKey('a', 'run.definedRate'), recordKey('a', 'run.score'), recordKey('b', 'run.score')].sort());
    expect(r[recordKey('a', 'run.score')].value).toBe(0.5);
  });

  it('records only from PASSED attempts: a failed or empty take cannot set "zero cracks"', () => {
    const r = records([
      attempt({ exerciseId: 'ex.siren', passed: false, metrics: { 'glide.cracks': 0, 'glide.smoothness': 1 } }),
      attempt({ exerciseId: 'ex.siren', passed: true, metrics: { 'glide.cracks': 2 } }),
    ]);
    expect(r[recordKey('ex.siren', 'glide.cracks')].value).toBe(2);
    expect(r[recordKey('ex.siren', 'glide.smoothness')]).toBeUndefined();
  });

  it('takes records from practice, boss, workout and record attempts, never from auditions or songs', () => {
    for (const kind of ['practice', 'boss', 'workout', 'record'] as const) {
      expect(Object.keys(records([attempt({ exerciseId: 'x', kind, metrics: { 'run.score': 0.5 } })]))).toHaveLength(1);
    }
    for (const kind of ['audition', 'song'] as const) {
      expect(records([attempt({ exerciseId: 'x', kind, metrics: { 'run.score': 0.5 } })])).toEqual({});
    }
  });

  it('skips non-finite values and metrics with no "better"', () => {
    const r = records([attempt({ exerciseId: 'x', metrics: { 'run.score': NaN, 'accuracy.sdCents': Infinity, 'vibrato.rateHz': 5.8, 'vibrato.extentCents': 40 } })]);
    expect(r).toEqual({});
  });

  it('with an exercise lookup, keeps only the metrics that exercise actually scores', () => {
    const def = exerciseDef('x', { scoring: [{ metric: 'run.score', weight: 1, best: 1, worst: 0 }, { metric: 'run.definedRate', weight: 0, best: 1, worst: 0 }] });
    const lookup = (id: string) => (id === 'x' ? def : undefined);
    const r = records(
      [
        attempt({ exerciseId: 'x', metrics: { 'run.score': 0.7, 'run.definedRate': 0.9, 'run.missedRate': 0.1 } }),
        attempt({ exerciseId: 'unknown', metrics: { 'run.missedRate': 0.2 } }),
      ],
      lookup,
    );
    expect(Object.keys(r).sort()).toEqual([recordKey('unknown', 'run.missedRate'), recordKey('x', 'run.score')].sort());
  });

  it('lists one exercise\'s records', () => {
    const s = computeSnapshot(P1, worlds, [attempt({ exerciseId: 'a', metrics: { 'run.score': 0.5, 'onset.settleMs': 200 } }), attempt({ exerciseId: 'ab', metrics: { 'run.score': 0.9 } })], NOW);
    const list = recordsForExercise(s, 'a');
    expect(list.map((x) => x.metric).sort()).toEqual(['onset.settleMs', 'run.score']);
    expect(list.find((x) => x.metric === 'run.score')).toMatchObject({ value: 0.5 });
    expect(recordsForExercise(s, 'nothing')).toEqual([]);
  });

  it('ignores other profiles and soft-deleted attempts', () => {
    const r = records([
      attempt({ exerciseId: 'x', profileId: 'other', metrics: { 'run.score': 1 } }),
      attempt({ exerciseId: 'x', deletedAt: '2026-03-02T00:00:00.000Z', metrics: { 'run.score': 1 } }),
      attempt({ exerciseId: 'x', metrics: { 'run.score': 0.3 } }),
    ]);
    expect(r[recordKey('x', 'run.score')].value).toBe(0.3);
  });
});
