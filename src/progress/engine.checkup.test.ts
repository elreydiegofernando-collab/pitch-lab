/**
 * computeSnapshot and the voice check-up (src/checkup): a placement test sung in a check-up (a row carrying a
 * checkupId) grants only what the placement audition itself could have granted at the moment it was sung: it must have
 * been the audition's NEXT test then (the Range finder sung, every level before its span passed). A check-up sings
 * every test whatever the one before it did, so a test it passed out of order measured the skill and grants nothing,
 * neither then nor later, once the levels before it are passed by some other route. Fixture worlds, as in engine.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { AttemptRecord } from '../storage/schema';
import { computeSnapshot } from './engine';
import { BASE_MS, DAY_MS, P1, attempt, fixtureWorlds, levelIds, pass, passAudition, passThrough } from './test-fixtures';
import type { ProgressSnapshot } from './types';
import { nextAuditionExercise } from './unlocks';

const worlds = fixtureWorlds();
const FOUNDATIONS = levelIds(worlds[0]);
const NOW = BASE_MS + 30 * DAY_MS;

const snap = (log: readonly AttemptRecord[]): ProgressSnapshot => computeSnapshot(P1, worlds, log, NOW);
const statusesOf = (s: ProgressSnapshot, ids: readonly string[]): string[] => ids.map((id) => s.levels[id].status);
const passedIds = (s: ProgressSnapshot): string[] => FOUNDATIONS.filter((id) => s.levels[id].status === 'passed');
const next = (s: ProgressSnapshot): string | null => nextAuditionExercise('foundations', s, worlds);

/** A check-up's Range finder take: a practice rep of level 01 tagged with the check-up's id. */
const rangeFinder = (passed: boolean, checkupId = 'c1'): AttemptRecord => ({ ...attempt({ kind: 'practice', levelId: 'foundations.01', passed }), checkupId });

/** A check-up's take of placement test n (1-based): an audition row tagged with the check-up's id. */
const test = (n: number, passed: boolean, checkupId = 'c1'): AttemptRecord => ({
  ...attempt({ kind: 'audition', exerciseId: `foundations.audition.${n}`, levelId: null, passed }),
  checkupId,
});

/** "passed" for levels before index `k` of FOUNDATIONS, "current" at k, "locked" after. */
const frontierAt = (k: number): string[] => FOUNDATIONS.map((_, i) => (i < k ? 'passed' : i === k ? 'current' : 'locked'));

describe('computeSnapshot: placement tests sung in a voice check-up', () => {
  it('passed in order, they grant exactly what the audition grants', () => {
    const checkup = snap([rangeFinder(true), test(1, true), test(2, true), test(3, true), test(4, true)]);
    const audition = snap([pass('foundations.01'), passAudition('foundations', 1), passAudition('foundations', 2), passAudition('foundations', 3), passAudition('foundations', 4)]);
    expect(statusesOf(checkup, FOUNDATIONS)).toEqual(frontierAt(9)); // the Boss Recital is next
    expect(statusesOf(checkup, FOUNDATIONS)).toEqual(statusesOf(audition, FOUNDATIONS));
    expect(FOUNDATIONS.filter((id) => checkup.levels[id].viaAudition)).toEqual(FOUNDATIONS.slice(1, 9));
    expect(checkup.worldsUnlocked).toEqual(['foundations']);
  });

  it('the voice cracks on the siren: the tests after it grant nothing, and passing Sirens & glides later opens only the next level', () => {
    const log = [rangeFinder(true), test(1, true), test(2, false), test(3, true), test(4, true)];
    const after = snap(log);
    expect(statusesOf(after, FOUNDATIONS)).toEqual(frontierAt(4)); // 02-04 granted by test 1; Sirens & glides is next
    expect(next(after)).toBe('foundations.audition.2');

    const later = snap([...log, pass('foundations.05')]);
    expect(statusesOf(later, FOUNDATIONS)).toEqual(frontierAt(5)); // Crispness is current, nothing past it opened
    expect(FOUNDATIONS.filter((id) => later.levels[id].viaAudition)).toEqual(['foundations.02', 'foundations.03', 'foundations.04']);
    expect(next(later)).toBe('foundations.audition.3'); // the audition can still be taken for those levels

    // The same rows sung through the audition itself would be its delayed grants (the registry never lets that happen).
    const asAudition = snap([pass('foundations.01'), passAudition('foundations', 1), passAudition('foundations', 3), passAudition('foundations', 4), pass('foundations.05')]);
    expect(statusesOf(asAudition, FOUNDATIONS)).toEqual(frontierAt(9));
  });

  it('a Range finder that missed holds every test back, even once the Range finder is passed later', () => {
    const log = [rangeFinder(false), test(1, true), test(2, true), test(3, true), test(4, true)];
    const after = snap(log);
    expect(statusesOf(after, FOUNDATIONS)).toEqual(frontierAt(0));
    expect(passedIds(after)).toEqual([]);
    expect(next(after)).toBeNull();

    const later = snap([...log, pass('foundations.01')]);
    expect(statusesOf(later, FOUNDATIONS)).toEqual(frontierAt(1)); // Pitch match is current: nothing was granted
    expect(next(later)).toBe('foundations.audition.1');
    expect(later.features).not.toContain('live.cracks');
  });

  it('a test sung before the one ahead of it in the battery grants nothing, whatever is passed afterwards', () => {
    const log = [rangeFinder(true), test(1, false), test(2, true), test(3, true), test(4, true)];
    expect(statusesOf(snap(log), FOUNDATIONS)).toEqual(frontierAt(1));
    const byHand = snap([...log, pass('foundations.02'), pass('foundations.03'), pass('foundations.04')]);
    expect(statusesOf(byHand, FOUNDATIONS)).toEqual(frontierAt(4));
    expect(FOUNDATIONS.some((id) => byHand.levels[id].viaAudition)).toBe(false);
  });

  it('a missed test sung again in the same check-up grants once the retake passes, and the tests after it then count', () => {
    const log = [rangeFinder(true), test(1, true), test(2, false), test(2, true), test(3, true), test(4, true)];
    expect(statusesOf(snap(log), FOUNDATIONS)).toEqual(frontierAt(9));
  });

  it('levels already passed by hand make a later test the next one, as for the audition', () => {
    const byHand = FOUNDATIONS.slice(0, 5).map((id) => pass(id)); // 01-05 sung: tests 1 and 2 have nothing left to grant
    const log = [...byHand, rangeFinder(true, 'c2'), test(1, true, 'c2'), test(2, true, 'c2'), test(3, true, 'c2'), test(4, true, 'c2')];
    const s = snap(log);
    expect(statusesOf(s, FOUNDATIONS)).toEqual(frontierAt(9));
    expect(FOUNDATIONS.filter((id) => s.levels[id].viaAudition)).toEqual(['foundations.06', 'foundations.07', 'foundations.08', 'foundations.09']);
  });

  it('a re-check: a Range finder passed in an earlier sitting counts, though this check-up’s missed', () => {
    const log = [pass('foundations.01'), rangeFinder(false, 'c2'), test(1, true, 'c2'), test(2, false, 'c2')];
    expect(statusesOf(snap(log), FOUNDATIONS)).toEqual(frontierAt(4));
  });

  it('never in a world that was closed when it was sung, even once that world opens', () => {
    const vibrato = levelIds(worlds[1]);
    const early: AttemptRecord = { ...attempt({ kind: 'audition', exerciseId: 'vibrato.audition.1', levelId: null, passed: true }), checkupId: 'c1' };
    const s = snap([early, ...passThrough(worlds, 'foundations.boss')]);
    expect(s.worldsUnlocked).toContain('vibrato');
    expect(statusesOf(s, vibrato)).toEqual(['current', 'locked', 'locked', 'locked']);
  });

  it('is read in append order, whatever order the rows arrive in', () => {
    const log = [rangeFinder(true), test(1, true), test(2, false), test(3, true), test(4, true), pass('foundations.05')];
    const reversed = [...log].reverse();
    const shuffled = [log[3], log[0], log[5], log[2], log[4], log[1]];
    for (const rows of [reversed, shuffled]) expect(statusesOf(snap(rows), FOUNDATIONS)).toEqual(statusesOf(snap(log), FOUNDATIONS));
  });

  it('an empty check-up id is no check-up: the row is an ordinary audition take', () => {
    const plain = (n: number): AttemptRecord => ({ ...passAudition('foundations', n), checkupId: '' });
    expect(statusesOf(snap([pass('foundations.01'), plain(1), plain(3), plain(4), pass('foundations.05')]), FOUNDATIONS)).toEqual(frontierAt(9));
  });
});
