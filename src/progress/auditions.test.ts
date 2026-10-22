import { describe, expect, it } from 'vitest';
import type { AuditionDef, LevelDef } from '../exercises/types';
import { auditionSpans } from './auditions';
import { audition, bossLevel, deepFreeze, fixtureWorlds, level, seeded } from './test-fixtures';

const W = 'vibrato';
/** `n` ordinary levels (vibrato.01...) and, when `bossAt` is given, a boss at that 1-based position among them. */
function levelsOf(n: number, bossAt?: number): LevelDef[] {
  const out: LevelDef[] = [];
  for (let pos = 1; pos <= n; pos++) out.push(pos === bossAt ? bossLevel(W, pos) : level(W, pos, `L${pos}`));
  return out;
}
const idOf = (levels: readonly LevelDef[], pos: number): string => levels[pos - 1].id;
const spans = (levels: readonly LevelDef[], through: string[]) => auditionSpans(audition(W, through.length, through), levels);

describe('auditionSpans', () => {
  it('splits a rising audition into consecutive slices, each test covering only the levels past the one before', () => {
    const [foundations, vibrato] = fixtureWorlds();
    expect(auditionSpans(foundations.audition!, foundations.levels)).toEqual([
      { exerciseId: 'foundations.audition.1', first: 0, last: 3 },
      { exerciseId: 'foundations.audition.2', first: 4, last: 4 },
      { exerciseId: 'foundations.audition.3', first: 5, last: 7 },
      { exerciseId: 'foundations.audition.4', first: 8, last: 8 },
    ]);
    expect(auditionSpans(vibrato.audition!, vibrato.levels)).toEqual([
      { exerciseId: 'vibrato.audition.1', first: 0, last: 1 },
      { exerciseId: 'vibrato.audition.2', first: 2, last: 2 },
    ]);
  });

  it('indexes into the levels as given (the caller sorts them by index)', () => {
    const levels = levelsOf(5);
    expect(spans(levels, [idOf(levels, 2), idOf(levels, 5)])).toEqual([
      { exerciseId: 'vibrato.audition.1', first: 0, last: 1 },
      { exerciseId: 'vibrato.audition.2', first: 2, last: 4 },
    ]);
  });

  it('gives a test that reaches nothing new no slice, so a catalog that stops rising cannot widen one', () => {
    const levels = levelsOf(6);
    const ids = (...pos: number[]) => pos.map((p) => idOf(levels, p));
    expect(spans(levels, ids(4, 2, 4, 6))).toEqual([
      { exerciseId: 'vibrato.audition.1', first: 0, last: 3 },
      { exerciseId: 'vibrato.audition.4', first: 4, last: 5 },
    ]);
    expect(spans(levels, ids(3, 3))).toHaveLength(1);
    expect(spans(levels, ids(6, 1, 2))).toHaveLength(1);
  });

  it('skips an unknown level id and a missing unlockThrough entry; later tests still start where the covered levels end', () => {
    const levels = levelsOf(6);
    expect(spans(levels, ['no.such.level'])).toEqual([]);
    expect(spans(levels, ['no.such.level', idOf(levels, 3)])).toEqual([{ exerciseId: 'vibrato.audition.2', first: 0, last: 2 }]);
    const short: AuditionDef = { id: 'x', worldId: W, exerciseIds: ['t1', 't2', 't3'], unlockThrough: [idOf(levels, 2)] };
    expect(auditionSpans(short, levels)).toEqual([{ exerciseId: 't1', first: 0, last: 1 }]);
    expect(auditionSpans({ id: 'x', worldId: W, exerciseIds: [], unlockThrough: [] }, levels)).toEqual([]);
    expect(auditionSpans(audition(W, 1, [idOf(levels, 2)]), [])).toEqual([]);
  });

  it('holds every slice short of the first Boss Recital: a test that reaches it, or lies behind it, stops before it', () => {
    const levels = levelsOf(6, 4); // L1 L2 L3 BOSS L5 L6
    expect(spans(levels, [idOf(levels, 2), idOf(levels, 4)])).toEqual([
      { exerciseId: 'vibrato.audition.1', first: 0, last: 1 },
      { exerciseId: 'vibrato.audition.2', first: 2, last: 2 }, // the boss itself is out of reach: held at the level before
    ]);
    // Behind the boss: nothing there is ever covered, however the tests are ordered.
    expect(spans(levels, [idOf(levels, 6)])).toEqual([{ exerciseId: 'vibrato.audition.1', first: 0, last: 2 }]);
    expect(spans(levels, [idOf(levels, 4), idOf(levels, 6)])).toEqual([{ exerciseId: 'vibrato.audition.1', first: 0, last: 2 }]);
    expect(spans(levels, [idOf(levels, 5), idOf(levels, 6)])).toEqual([{ exerciseId: 'vibrato.audition.1', first: 0, last: 2 }]);
  });

  it('covers nothing in a world whose first level is the boss, and may cover a world with no boss to its last level', () => {
    const bossFirst = levelsOf(4, 1);
    expect(spans(bossFirst, [idOf(bossFirst, 3)])).toEqual([]);
    const noBoss = levelsOf(4);
    expect(spans(noBoss, [idOf(noBoss, 4)])).toEqual([{ exerciseId: 'vibrato.audition.1', first: 0, last: 3 }]);
  });

  it('does not mutate its inputs and returns fresh spans each time', () => {
    const levels = deepFreeze(levelsOf(5, 5));
    const def = deepFreeze(audition(W, 2, [idOf(levels, 2), idOf(levels, 4)]));
    const a = auditionSpans(def, levels);
    expect(a).toEqual(auditionSpans(def, levels));
    expect(a).not.toBe(auditionSpans(def, levels));
  });

  it('on random worlds: slices start at the first level, never overlap or leave a gap, never include a boss or pass one', () => {
    const rand = seeded(2026);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
    for (let n = 0; n < 400; n++) {
      const total = 1 + Math.floor(rand() * 10);
      const bossAt = rand() < 0.3 ? undefined : 1 + Math.floor(rand() * total);
      const levels = levelsOf(total, bossAt);
      const tests = Math.floor(rand() * 6);
      const through = Array.from({ length: tests }, () => (rand() < 0.1 ? 'no.such.level' : pick(levels).id));
      const got = spans(levels, through);

      const bossIdx = levels.findIndex((l) => l.kind === 'boss');
      const ceiling = bossIdx < 0 ? total - 1 : bossIdx - 1;
      let expectedFirst = 0;
      for (const s of got) {
        expect(s.first, `${through.join()} -> ${s.exerciseId}`).toBe(expectedFirst); // no gap, no overlap, from level 0
        expect(s.last).toBeGreaterThanOrEqual(s.first);
        expect(s.last).toBeLessThanOrEqual(ceiling);
        for (let i = s.first; i <= s.last; i++) expect(levels[i].kind).toBe('level');
        expectedFirst = s.last + 1;
      }
      // Each slice ends at its own test's level (or at the ceiling), and a test is only listed when it reaches something new.
      let covered = -1;
      through.forEach((id, i) => {
        const reach = Math.min(levels.findIndex((l) => l.id === id), ceiling);
        const listed = got.find((s) => s.exerciseId === `vibrato.audition.${i + 1}`);
        expect(listed !== undefined, `${through.join()} test ${i + 1}`).toBe(reach > covered);
        if (listed) expect(listed.last).toBe(reach);
        covered = Math.max(covered, reach);
      });
    }
  });
});
