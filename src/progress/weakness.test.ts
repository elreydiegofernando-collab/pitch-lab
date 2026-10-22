import { describe, expect, it } from 'vitest';
import { computeSnapshot } from './engine';
import { P1, P2, at, attempt, deepFreeze, fail, fixtureWorlds, pass, passAudition, passThrough } from './test-fixtures';
import { WEAKNESS_KNOBS, rankWeakness, weaknessInputsFromLog } from './weakness';
import type { WeaknessInput } from './weakness';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();
const worlds = fixtureWorlds();

function input(p: Partial<WeaknessInput> & { levelId: string }): WeaknessInput {
  return { worldId: 'foundations', mastery: 1, recent: [], lastPracticedAt: null, ...p };
}
const done = (score: number, passed = true) => ({ score, passed });

describe('rankWeakness', () => {
  it('scores a never-practiced level as fully weak', () => {
    const [top] = rankWeakness([input({ levelId: 'a' })], NOW);
    expect(top).toMatchObject({ score: 1, reasons: ['never-tried'], dueInDays: null });
  });

  it('ranks low recent scores weaker than high ones', () => {
    const ranked = rankWeakness([input({ levelId: 'strong', recent: [done(0.95)], lastPracticedAt: daysAgo(0) }), input({ levelId: 'weak', recent: [done(0.3)], lastPracticedAt: daysAgo(0) })], NOW);
    expect(ranked.map((r) => r.levelId)).toEqual(['weak', 'strong']);
    expect(ranked[0].reasons).toContain('low-score');
    expect(ranked[1].reasons).not.toContain('low-score');
  });

  it('ranks a high miss rate weaker than a clean record at the same average score', () => {
    const ranked = rankWeakness(
      [
        input({ levelId: 'clean', recent: [done(0.9), done(0.9)], lastPracticedAt: daysAgo(0) }),
        input({ levelId: 'missy', recent: [done(0.9, false), done(0.9, false)], lastPracticedAt: daysAgo(0) }),
      ],
      NOW,
    );
    expect(ranked[0].levelId).toBe('missy');
    expect(ranked[0].reasons).toContain('recent-misses');
  });

  it('weighs the newest attempts most: improving beats declining at the same average', () => {
    const ranked = rankWeakness(
      [
        input({ levelId: 'declining', recent: [done(0.2), done(0.9)], lastPracticedAt: daysAgo(0) }), // newest first: got worse
        input({ levelId: 'improving', recent: [done(0.9), done(0.2)], lastPracticedAt: daysAgo(0) }), // newest first: got better
      ],
      NOW,
    );
    expect(ranked.map((r) => r.levelId)).toEqual(['declining', 'improving']);
    expect(ranked[0].performance).toBeGreaterThan(ranked[1].performance);
  });

  it('only looks at the newest `window` attempts', () => {
    const recent = [...Array(5).fill(done(0.9)), ...Array(10).fill(done(0))];
    const [narrow] = rankWeakness([input({ levelId: 'a', recent, lastPracticedAt: daysAgo(0) })], NOW);
    const [wide] = rankWeakness([input({ levelId: 'a', recent, lastPracticedAt: daysAgo(0) })], NOW, { window: 15 });
    expect(narrow.performance).toBeCloseTo(0.1, 9);
    expect(wide.performance).toBeGreaterThan(narrow.performance);
  });

  describe('spaced repetition', () => {
    const base = { recent: [done(0.8)] };
    const stale = (mastery: 0 | 1 | 2 | 3, days: number) => rankWeakness([input({ levelId: 'x', mastery, lastPracticedAt: daysAgo(days), ...base })], NOW)[0];

    it('is half stale exactly when due, and fully stale at twice the interval', () => {
      const due = WEAKNESS_KNOBS.dueDaysByMastery[1];
      expect(stale(1, 0).staleness).toBe(0);
      expect(stale(1, due).staleness).toBeCloseTo(0.5, 9);
      expect(stale(1, due * 2).staleness).toBeCloseTo(1, 9);
      expect(stale(1, due * 10).staleness).toBe(1);
      expect(stale(1, due).dueInDays).toBeCloseTo(0, 9);
      expect(stale(1, due + 4).dueInDays).toBeCloseTo(-4, 9);
    });

    it('lets a higher-mastery level wait longer before it is due', () => {
      const days = 7;
      expect(stale(3, days).staleness).toBeLessThan(stale(2, days).staleness);
      expect(stale(2, days).staleness).toBeLessThan(stale(1, days).staleness);
      expect(stale(3, days).reasons).not.toContain('overdue');
      expect(stale(1, days).reasons).toContain('overdue');
    });

    it('ranks a long-overdue level weaker than a fresh one at equal performance', () => {
      const ranked = rankWeakness([input({ levelId: 'fresh', lastPracticedAt: daysAgo(0), ...base }), input({ levelId: 'overdue', lastPracticedAt: daysAgo(30), ...base })], NOW);
      expect(ranked[0].levelId).toBe('overdue');
    });
  });

  it('returns a total, deterministic order: score, then staleness, then mastery, then level id', () => {
    const same = [input({ levelId: 'b', recent: [done(0.5)], lastPracticedAt: daysAgo(1) }), input({ levelId: 'a', recent: [done(0.5)], lastPracticedAt: daysAgo(1) })];
    expect(rankWeakness(same, NOW).map((r) => r.levelId)).toEqual(['a', 'b']);
    expect(rankWeakness([...same].reverse(), NOW).map((r) => r.levelId)).toEqual(['a', 'b']);
    const mixed = [input({ levelId: 'perfect', recent: [done(1)], lastPracticedAt: daysAgo(0) }), input({ levelId: 'never' }), input({ levelId: 'mediocre', recent: [done(0.6)], lastPracticedAt: daysAgo(0) })];
    const scores = rankWeakness(mixed, NOW).map((r) => r.score);
    for (let i = 1; i < scores.length; i++) expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
    for (const s of scores) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it('does not mutate its inputs and rejects an invalid now', () => {
    const items = deepFreeze([input({ levelId: 'a', recent: [done(0.4)], lastPracticedAt: daysAgo(2) })]);
    expect(() => rankWeakness(items, NOW)).not.toThrow();
    expect(() => rankWeakness(items, 'later')).toThrow(RangeError);
  });

  it('treats bad data kindly: unparsable last-practiced time, non-finite scores', () => {
    const [r] = rankWeakness([input({ levelId: 'a', recent: [done(NaN)], lastPracticedAt: 'garbage' })], NOW);
    expect(r.dueInDays).toBeNull();
    expect(r.staleness).toBe(1);
    expect(Number.isFinite(r.score)).toBe(true);
  });
});

describe('weaknessInputsFromLog', () => {
  const snapshotOf = (attempts: ReturnType<typeof attempt>[]) => computeSnapshot(P1, worlds, attempts, NOW);

  it('includes only unlocked levels: a locked skill can never surface', () => {
    const attempts = passThrough(worlds, 'foundations.02');
    const ids = weaknessInputsFromLog(snapshotOf(attempts), worlds, attempts).map((i) => i.levelId);
    expect(ids).toEqual(['foundations.01', 'foundations.02', 'foundations.03']); // 03 is the current level
    expect(weaknessInputsFromLog(snapshotOf([]), worlds, []).map((i) => i.levelId)).toEqual(['foundations.01']);
  });

  it('lists recent attempts newest first, with the latest practice time', () => {
    const attempts = [
      fail('foundations.01', { score: 0.2, createdAt: at(1) }),
      pass('foundations.01', { score: 0.9, createdAt: at(2) }),
      fail('foundations.01', { score: 0.4, createdAt: at(3) }),
    ];
    const [first] = weaknessInputsFromLog(snapshotOf(attempts), worlds, attempts);
    expect(first.recent).toEqual([done(0.4, false), done(0.9, true), done(0.2, false)]);
    expect(first.lastPracticedAt).toBe(at(3));
    expect(first.mastery).toBe(1);
  });

  it('uses the latest TIME for last practiced even when append order disagrees', () => {
    const attempts = [
      pass('foundations.01', { createdAt: at(5), updatedAt: 'a' }),
      fail('foundations.01', { createdAt: at(3), updatedAt: 'b' }),
    ];
    const [first] = weaknessInputsFromLog(snapshotOf(attempts), worlds, attempts);
    expect(first.lastPracticedAt).toBe(at(5));
    expect(first.recent[0].passed).toBe(false); // newest by append order
  });

  it('counts practice, boss, workout and record attempts; not auditions; not other profiles; not deleted rows', () => {
    const attempts = [
      attempt({ levelId: 'foundations.01', kind: 'record', score: 0.5, passed: true }),
      attempt({ levelId: 'foundations.01', kind: 'workout', score: 0.6, passed: true }),
      attempt({ kind: 'audition', exerciseId: 'foundations.audition.1', levelId: 'foundations.01', score: 0.99, passed: true }),
      pass('foundations.01', { profileId: P2, score: 0.1 }),
      pass('foundations.01', { score: 0.2, deletedAt: at(1) }),
    ];
    const [first] = weaknessInputsFromLog(snapshotOf(attempts), worlds, attempts);
    expect(first.recent.map((r) => r.score).sort()).toEqual([0.5, 0.6]);
  });

  it('stands in the audition score for a level passed only by audition, practiced when it was granted', () => {
    const attempts = [pass('foundations.01'), passAudition('foundations', 1, { score: 0.9, createdAt: at(4) })];
    const items = weaknessInputsFromLog(snapshotOf(attempts), worlds, attempts);
    const granted = items.find((i) => i.levelId === 'foundations.03');
    expect(granted).toMatchObject({ recent: [done(0.9)], lastPracticedAt: at(4), mastery: 1 });
  });

  it('caps the window and honours the knob', () => {
    const attempts = Array.from({ length: 9 }, (_, i) => fail('foundations.01', { score: i / 10, createdAt: at(i) }));
    const [dflt] = weaknessInputsFromLog(snapshotOf(attempts), worlds, attempts);
    const [two] = weaknessInputsFromLog(snapshotOf(attempts), worlds, attempts, { window: 2 });
    expect(dflt.recent).toHaveLength(WEAKNESS_KNOBS.window);
    expect(two.recent.map((r) => r.score)).toEqual([0.8, 0.7]);
  });

  it('never-practiced current levels come through as never-tried', () => {
    const [first] = weaknessInputsFromLog(snapshotOf([]), worlds, []);
    expect(first).toMatchObject({ levelId: 'foundations.01', recent: [], lastPracticedAt: null, mastery: 0 });
    expect(rankWeakness([first], NOW)[0].reasons).toEqual(['never-tried']);
  });
});
