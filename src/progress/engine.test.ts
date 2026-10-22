import { describe, expect, it } from 'vitest';
import { computeSnapshot, masteryForScore } from './engine';
import { computeMomentum } from './momentum';
import {
  P1,
  P2,
  at,
  attempt,
  audition,
  bossLevel,
  deepFreeze,
  exerciseDef,
  fail,
  fixtureWorlds,
  level,
  levelIds,
  pass,
  passAudition,
  passThrough,
  passedIds,
  statusesOf,
  world,
} from './test-fixtures';
import type { Mastery } from './types';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const worlds = fixtureWorlds();
const FOUNDATIONS = levelIds(worlds[0]);
const VIBRATO = levelIds(worlds[1]);
const INFLECTIONS = levelIds(worlds[2]);
const snap = (attempts: ReturnType<typeof attempt>[], options?: Parameters<typeof computeSnapshot>[4]) => computeSnapshot(P1, worlds, attempts, NOW, options);

describe('computeSnapshot: a fresh profile', () => {
  it('opens only the first level of the first world; everything else is locked', () => {
    const s = snap([]);
    expect(s.worldsUnlocked).toEqual(['foundations']);
    expect(statusesOf(s, FOUNDATIONS)).toEqual(['current', ...Array(9).fill('locked')]);
    expect(statusesOf(s, [...VIBRATO, ...INFLECTIONS]).every((x) => x === 'locked')).toBe(true);
    expect(s.features).toEqual(['live.basic', 'export']);
    expect(s.momentum).toBe(0);
    expect(s.lastPracticeDay).toBeNull();
    expect(s.records).toEqual({});
    expect(s.profileId).toBe(P1);
    expect(s.computedAt).toBe(NOW.toISOString());
  });

  it('lists every level of every world, with zeroed progress', () => {
    const s = snap([]);
    expect(Object.keys(s.levels).sort()).toEqual([...FOUNDATIONS, ...VIBRATO, ...INFLECTIONS].sort());
    expect(s.levels['foundations.01']).toEqual({ levelId: 'foundations.01', status: 'current', bestScore: 0, mastery: 0, attempts: 0, passedAt: null, viaAudition: false });
  });

  it('works with no worlds at all', () => {
    const s = computeSnapshot(P1, [], [pass('foundations.01')], NOW);
    expect(s.levels).toEqual({});
    expect(s.worldsUnlocked).toEqual([]);
    expect(s.features).toEqual(['live.basic', 'export']);
  });
});

describe('computeSnapshot: strictly linear inside a world', () => {
  it('passing level N opens level N+1, in order', () => {
    const s = snap([pass('foundations.01')]);
    expect(statusesOf(s, FOUNDATIONS.slice(0, 4))).toEqual(['passed', 'current', 'locked', 'locked']);
  });

  it('a failed attempt on the current level neither advances nor regresses anything, but is remembered', () => {
    const s = snap([fail('foundations.01', { score: 0.3 })]);
    expect(s.levels['foundations.01']).toMatchObject({ status: 'current', bestScore: 0.3, attempts: 1, mastery: 0, passedAt: null });
    expect(s.levels['foundations.02'].status).toBe('locked');
  });

  it('a pass recorded further along does not skip ahead; it counts the moment the gap is legitimately closed', () => {
    const stray = pass('foundations.05');
    const early = snap([stray]);
    expect(statusesOf(early, ['foundations.01', 'foundations.05', 'foundations.06'])).toEqual(['current', 'locked', 'locked']);
    expect(passedIds(early)).toEqual([]);

    const closed = snap([stray, ...FOUNDATIONS.slice(0, 4).map((id) => pass(id))]);
    expect(statusesOf(closed, ['foundations.04', 'foundations.05', 'foundations.06'])).toEqual(['passed', 'passed', 'current']);
  });

  it('keeps exactly one current level per unfinished open world, and none in a finished or closed one', () => {
    const s = snap([...passThrough(worlds, 'foundations.boss'), pass('vibrato.01')]);
    for (const w of worlds) {
      const ids = levelIds(w);
      const current = ids.filter((id) => s.levels[id].status === 'current').length;
      const unfinished = ids.some((id) => s.levels[id].status !== 'passed');
      expect(current).toBe(s.worldsUnlocked.includes(w.id) && unfinished ? 1 : 0);
    }
    expect(s.levels['vibrato.02'].status).toBe('current');
  });

  it('orders levels by index, not by their position in the array', () => {
    const shuffled = [{ ...worlds[0], levels: [...worlds[0].levels].reverse() }];
    const s = computeSnapshot(P1, shuffled, [pass('foundations.01')], NOW);
    expect(statusesOf(s, FOUNDATIONS.slice(0, 3))).toEqual(['passed', 'current', 'locked']);
  });
});

describe('computeSnapshot: Boss Recital gates the next world', () => {
  it('clearing the whole Foundations line including the boss opens Vibrato and Song Stage', () => {
    const s = snap(passThrough(worlds, 'foundations.boss'));
    expect(s.worldsUnlocked).toEqual(['foundations', 'vibrato', 'song-stage']);
    expect(s.levels['foundations.boss'].status).toBe('passed');
    expect(statusesOf(s, VIBRATO)).toEqual(['current', 'locked', 'locked', 'locked']);
  });

  it('clearing every level BEFORE the boss does not open the next world; the boss is the current level', () => {
    const s = snap(passThrough(worlds, 'foundations.09'));
    expect(s.worldsUnlocked).toEqual(['foundations']);
    expect(s.levels['foundations.boss'].status).toBe('current');
  });

  it('a lone boss pass (earlier levels never cleared) opens nothing', () => {
    const s = snap([pass('foundations.boss')]);
    expect(s.worldsUnlocked).toEqual(['foundations']);
    expect(s.levels['foundations.boss'].status).toBe('locked');
    expect(s.levels['foundations.01'].status).toBe('current');
  });

  it('a boss run recorded as plain practice still counts (the level id is the identity, not the kind label)', () => {
    const s = snap([...passThrough(worlds, 'foundations.09'), attempt({ levelId: 'foundations.boss', kind: 'practice', passed: true })]);
    expect(s.worldsUnlocked).toContain('vibrato');
  });

  it('nothing counts inside a closed world, and a closed world cannot open the one after it', () => {
    const viaClosed = [...VIBRATO.map((id) => pass(id)), ...INFLECTIONS.map((id) => pass(id))];
    const s = snap(viaClosed);
    expect(s.worldsUnlocked).toEqual(['foundations']);
    expect(passedIds(s)).toEqual([]);
    expect(statusesOf(s, [...VIBRATO, ...INFLECTIONS]).every((x) => x === 'locked')).toBe(true);
  });

  it('chains all the way: each Boss Recital opens exactly the next world', () => {
    const s = snap(passThrough(worlds, 'vibrato.boss'));
    expect(s.worldsUnlocked).toEqual(['foundations', 'vibrato', 'inflections', 'song-stage']);
    expect(s.levels['inflections.01'].status).toBe('current');
    expect(snap(passThrough(worlds, 'vibrato.03')).worldsUnlocked).not.toContain('inflections');
  });

  it('a world whose gate level does not exist, or lives in itself, stays closed (fails closed)', () => {
    const orphan = world('vibrato', 'Vibrato', [level('vibrato', 1, 'V1')], 'nowhere.boss');
    const selfGated = world('inflections', 'Inflections', [level('inflections', 1, 'I1')], 'inflections.01');
    const s = computeSnapshot(P1, [worlds[0], orphan, selfGated], [pass('inflections.01'), pass('vibrato.01')], NOW);
    expect(s.worldsUnlocked).toEqual(['foundations']);
  });
});

describe('computeSnapshot: placement auditions', () => {
  // The Range finder (foundations.01) is sung before any Foundations audition counts; these tests start from it.
  const SUNG_RANGE = () => pass('foundations.01');

  it('grant the levels past the Range finder up to unlockThrough, marked viaAudition, never played through', () => {
    const a = passAudition('foundations', 1, { score: 0.9, createdAt: at(1) });
    const s = snap([SUNG_RANGE(), a]);
    expect(statusesOf(s, FOUNDATIONS.slice(0, 6))).toEqual(['passed', 'passed', 'passed', 'passed', 'current', 'locked']);
    expect(s.levels['foundations.01']).toMatchObject({ viaAudition: false, attempts: 1 }); // sung, not granted
    expect(s.levels['foundations.03']).toMatchObject({ viaAudition: true, mastery: 1, attempts: 0, passedAt: at(1), bestScore: 0.9 });
    expect(s.worldsUnlocked).toEqual(['foundations']);
  });

  it('the tests in order each grant their own slice of levels; the last stops short of the boss', () => {
    const frontier = ['foundations.05', 'foundations.06', 'foundations.09', 'foundations.boss']; // the level after each test's reach
    frontier.forEach((next, i) => {
      const s = snap([SUNG_RANGE(), ...[1, 2, 3, 4].slice(0, i + 1).map((n) => passAudition('foundations', n))]);
      const frontierIdx = FOUNDATIONS.indexOf(next);
      expect(statusesOf(s, FOUNDATIONS), `after test ${i + 1}`).toEqual(FOUNDATIONS.map((_, k) => (k < frontierIdx ? 'passed' : k === frontierIdx ? 'current' : 'locked')));
      expect(FOUNDATIONS.filter((id) => s.levels[id].viaAudition)).toEqual(FOUNDATIONS.slice(1, frontierIdx));
      expect(s.worldsUnlocked).toEqual(['foundations']);
    });
  });

  it('a later test cannot vouch for the skills of the earlier ones: alone, or out of order, it grants nothing', () => {
    for (const n of [2, 3, 4]) {
      const s = snap([SUNG_RANGE(), passAudition('foundations', n)]);
      expect(statusesOf(s, FOUNDATIONS.slice(0, 4)), `test ${n} alone`).toEqual(['passed', 'current', 'locked', 'locked']);
      expect(passedIds(s)).toEqual(['foundations.01']);
    }
    const backwards = snap([SUNG_RANGE(), passAudition('foundations', 4), passAudition('foundations', 3), passAudition('foundations', 2)]);
    expect(passedIds(backwards)).toEqual(['foundations.01']);
    expect(backwards.levels['foundations.02'].status).toBe('current');
    expect(backwards.features).not.toContain('live.cracks');
  });

  it('a recorded later test waits, and counts the moment the earlier tests close the gap (whatever the row order)', () => {
    const rows = [passAudition('foundations', 4), passAudition('foundations', 3), passAudition('foundations', 2)];
    const waiting = snap([SUNG_RANGE(), ...rows]);
    expect(waiting.levels['foundations.02'].status).toBe('current');
    const closed = snap([SUNG_RANGE(), ...rows, passAudition('foundations', 1)]);
    expect(statusesOf(closed, FOUNDATIONS)).toEqual([...Array(9).fill('passed'), 'current']);
    const reordered = snap([passAudition('foundations', 1), SUNG_RANGE(), ...rows]);
    expect(statusesOf(reordered, FOUNDATIONS)).toEqual(statusesOf(closed, FOUNDATIONS));
    expect(reordered.features).toEqual(closed.features);
  });

  it('levels sung by hand close a gap for a later test just as an earlier test does', () => {
    const byHand = FOUNDATIONS.slice(0, 5).map((id) => pass(id)); // 01-05 sung: test 2's slice (05) is done too
    const s = snap([...byHand, passAudition('foundations', 3)]);
    expect(statusesOf(s, FOUNDATIONS.slice(4, 10))).toEqual(['passed', 'passed', 'passed', 'passed', 'current', 'locked']); // 06-08 granted, 09 next
    expect(FOUNDATIONS.filter((id) => s.levels[id].viaAudition)).toEqual(['foundations.06', 'foundations.07', 'foundations.08']);
    const gap = snap([...FOUNDATIONS.slice(0, 4).map((id) => pass(id)), passAudition('foundations', 3)]); // 05 not sung yet
    expect(statusesOf(gap, FOUNDATIONS.slice(3, 8))).toEqual(['passed', 'current', 'locked', 'locked', 'locked']);
  });

  it('a catalog that stops rising cannot widen a test: one that reaches nothing new grants nothing', () => {
    const levels = [1, 2, 3, 4, 5, 6].map((n) => level('vibrato', n, `v${n}`));
    const flat = world('vibrato', 'V', [...levels, bossLevel('vibrato', 7)], null, audition('vibrato', 3, ['vibrato.04', 'vibrato.02', 'vibrato.04']));
    const run = (...n: number[]) => computeSnapshot(P1, [flat], n.map((k) => passAudition('vibrato', k)), NOW);
    expect(passedIds(run(2))).toEqual([]);
    expect(passedIds(run(3))).toEqual([]);
    expect(passedIds(run(2, 3))).toEqual([]);
    expect(passedIds(run(1))).toEqual(['vibrato.01', 'vibrato.02', 'vibrato.03', 'vibrato.04']);
    expect(passedIds(run(1, 2, 3))).toEqual(['vibrato.01', 'vibrato.02', 'vibrato.03', 'vibrato.04']);

    // A dip in the middle: test 3 is the only one past test 1's reach, so it covers 05-06 and must not
    // also vouch for 03-04 (test 1's levels) just because test 2 reached back to 02.
    const dip = world('vibrato', 'V', [...levels, bossLevel('vibrato', 7)], null, audition('vibrato', 3, ['vibrato.04', 'vibrato.02', 'vibrato.06']));
    const dipped = computeSnapshot(P1, [dip], [pass('vibrato.01'), pass('vibrato.02'), passAudition('vibrato', 3)], NOW);
    expect(passedIds(dipped)).toEqual(['vibrato.01', 'vibrato.02']);
    expect(dipped.levels['vibrato.03'].status).toBe('current');
    const full = computeSnapshot(P1, [dip], [pass('vibrato.01'), pass('vibrato.02'), passAudition('vibrato', 1), passAudition('vibrato', 3)], NOW);
    expect(passedIds(full)).toEqual(['vibrato.01', 'vibrato.02', 'vibrato.03', 'vibrato.04', 'vibrato.05', 'vibrato.06']);
  });

  it('never grants a Boss Recital or anything past it, whatever unlockThrough says', () => {
    const w = world('foundations', 'F', [level('foundations', 1, 'a'), level('foundations', 2, 'b'), bossLevel('foundations', 3), level('foundations', 4, 'after')], null, audition('foundations', 1, ['foundations.04']));
    const next = world('vibrato', 'V', [level('vibrato', 1, 'v1')], 'foundations.boss');
    const s = computeSnapshot(P1, [w, next], [SUNG_RANGE(), passAudition('foundations', 1)], NOW);
    expect(statusesOf(s, ['foundations.01', 'foundations.02', 'foundations.boss', 'foundations.04'])).toEqual(['passed', 'passed', 'current', 'locked']);
    expect(s.worldsUnlocked).toEqual(['foundations']);

    const toBoss = world('foundations', 'F', w.levels, null, audition('foundations', 1, ['foundations.boss']));
    const s2 = computeSnapshot(P1, [toBoss, next], [SUNG_RANGE(), passAudition('foundations', 1)], NOW);
    expect(s2.levels['foundations.boss'].status).toBe('current');
    expect(s2.worldsUnlocked).toEqual(['foundations']);
  });

  it('never lets a later test reach past a Boss Recital either, not even once the boss has been sung', () => {
    // Test 1 reaches the boss (held short of it); test 2 reaches the level behind it. Neither may grant "after".
    const levels = [level('vibrato', 1, 'v1'), level('vibrato', 2, 'v2'), bossLevel('vibrato', 3), level('vibrato', 4, 'after')];
    const odd = world('vibrato', 'V', levels, null, audition('vibrato', 2, ['vibrato.boss', 'vibrato.04']));
    const both = computeSnapshot(P1, [odd], [passAudition('vibrato', 1), passAudition('vibrato', 2)], NOW);
    expect(statusesOf(both, ['vibrato.01', 'vibrato.02', 'vibrato.boss', 'vibrato.04'])).toEqual(['passed', 'passed', 'current', 'locked']);
    const sung = computeSnapshot(P1, [odd], [passAudition('vibrato', 1), passAudition('vibrato', 2), pass('vibrato.boss')], NOW);
    expect(statusesOf(sung, ['vibrato.boss', 'vibrato.04'])).toEqual(['passed', 'current']);
    expect(sung.levels['vibrato.04'].viaAudition).toBe(false);
  });

  it('can never open another world: a closed world grants nothing, and neither does an id from the wrong world', () => {
    const closed = snap([passAudition('vibrato', 2)]);
    expect(statusesOf(closed, VIBRATO)).toEqual(['locked', 'locked', 'locked', 'locked']);

    const cross = world('foundations', 'F', worlds[0].levels, null, audition('foundations', 1, ['vibrato.03']));
    expect(passedIds(computeSnapshot(P1, [cross, worlds[1]], [SUNG_RANGE(), passAudition('foundations', 1)], NOW))).toEqual(['foundations.01']);

    const unknown = world('foundations', 'F', worlds[0].levels, null, audition('foundations', 1, ['no.such.level']));
    expect(passedIds(computeSnapshot(P1, [unknown], [SUNG_RANGE(), passAudition('foundations', 1)], NOW))).toEqual(['foundations.01']);
  });

  it('never opens a world even when the catalog points a world gate at a non-boss level the audition covers', () => {
    const a = world('foundations', 'A', [level('foundations', 1, 'a1'), level('foundations', 2, 'a2'), bossLevel('foundations', 3)], null, audition('foundations', 1, ['foundations.02']));
    const b = world('vibrato', 'B', [level('vibrato', 1, 'b1')], 'foundations.02');
    const viaAudition = computeSnapshot(P1, [a, b], [SUNG_RANGE(), passAudition('foundations', 1)], NOW);
    expect(viaAudition.levels['foundations.02'].status).toBe('passed');
    expect(viaAudition.levels['foundations.02'].viaAudition).toBe(true);
    expect(viaAudition.worldsUnlocked).toEqual(['foundations']);

    const direct = computeSnapshot(P1, [a, b], [pass('foundations.01'), pass('foundations.02')], NOW);
    expect(direct.worldsUnlocked).toEqual(['foundations', 'vibrato']);
  });

  it('a failed audition grants nothing, and a failed retake never takes back what an earlier pass granted', () => {
    expect(passedIds(snap([SUNG_RANGE(), attempt({ kind: 'audition', exerciseId: 'foundations.audition.1', passed: false })]))).toEqual(['foundations.01']);
    const s = snap([SUNG_RANGE(), passAudition('foundations', 1, { createdAt: at(0) }), attempt({ kind: 'audition', exerciseId: 'foundations.audition.1', passed: false, createdAt: at(3) })]);
    expect(s.levels['foundations.04'].status).toBe('passed');
  });

  it('never passes the Range finder: a test recorded before it is sung leaves it current, and the grants wait for it', () => {
    const early = snap([passAudition('foundations', 1, { score: 0.95 })]);
    expect(early.levels['foundations.01']).toMatchObject({ status: 'current', viaAudition: false, passedAt: null, mastery: 0 });
    expect(statusesOf(early, FOUNDATIONS.slice(1, 5))).toEqual(['locked', 'locked', 'locked', 'locked']);
    expect(passedIds(early)).toEqual([]);
    expect(early.features).toEqual(['live.basic', 'export']);

    const all = snap([1, 2, 3, 4].map((n) => passAudition('foundations', n)));
    expect(passedIds(all)).toEqual([]);
    expect(all.levels['foundations.01'].status).toBe('current');

    const sung = snap([passAudition('foundations', 1), pass('foundations.01')]); // the row came first; the Range finder is sung later
    expect(statusesOf(sung, FOUNDATIONS.slice(0, 5))).toEqual(['passed', 'passed', 'passed', 'passed', 'current']);
    expect(sung.levels['foundations.01'].viaAudition).toBe(false);
    expect(sung.levels['foundations.02'].viaAudition).toBe(true);
  });

  it('only a take of the Range finder itself passes it: a record, song or levelId on an audition row does not', () => {
    const s = snap([
      attempt({ levelId: 'foundations.01', kind: 'record', passed: true }),
      attempt({ levelId: 'foundations.01', kind: 'song', passed: true }),
      attempt({ kind: 'audition', exerciseId: 'foundations.audition.1', levelId: 'foundations.01', passed: true }),
    ]);
    expect(s.levels['foundations.01']).toMatchObject({ status: 'current', viaAudition: false });
    expect(passedIds(s)).toEqual([]);
  });

  it('played-through levels keep their own record; audition fills in only the rest', () => {
    const s = snap([pass('foundations.01', { score: 0.7 }), pass('foundations.02', { score: 0.7 }), passAudition('foundations', 1, { score: 0.95 })]);
    expect(s.levels['foundations.01']).toMatchObject({ viaAudition: false, attempts: 1, bestScore: 0.7 });
    expect(s.levels['foundations.03']).toMatchObject({ viaAudition: true, attempts: 0, bestScore: 0.95 });
  });

  it('is only an audition: a levelId on the row does not pass that level directly', () => {
    const s = snap([SUNG_RANGE(), attempt({ kind: 'audition', exerciseId: 'foundations.audition.1', levelId: 'foundations.09', passed: true })]);
    expect(s.levels['foundations.09'].status).toBe('locked');
    expect(s.levels['foundations.04'].status).toBe('passed');
  });

  it('counts the audition score as the level best and keeps the earliest grant time', () => {
    const s = snap([SUNG_RANGE(), passAudition('foundations', 1, { score: 0.7, createdAt: at(1) }), passAudition('foundations', 1, { score: 0.9, createdAt: at(2) })]);
    expect(s.levels['foundations.02']).toMatchObject({ bestScore: 0.9, passedAt: at(1) });
  });

  it('scores each granted level with its OWN test, never lending a deeper test\'s score to the levels before it', () => {
    const s = snap([SUNG_RANGE(), passAudition('foundations', 1, { score: 0.7, createdAt: at(1) }), passAudition('foundations', 2, { score: 0.95, createdAt: at(2) })]);
    expect(s.levels['foundations.04']).toMatchObject({ bestScore: 0.7, passedAt: at(1) });
    expect(s.levels['foundations.05']).toMatchObject({ bestScore: 0.95, passedAt: at(2) });
  });

  it('lets playing continue after an audition: the next level is current and passing it advances', () => {
    const s = snap([SUNG_RANGE(), passAudition('foundations', 1), pass('foundations.05')]);
    expect(statusesOf(s, ['foundations.04', 'foundations.05', 'foundations.06'])).toEqual(['passed', 'passed', 'current']);
  });
});

describe('computeSnapshot: never re-locks', () => {
  it('a passed level stays passed through any run of later failures, keeping its best score', () => {
    const s = snap([pass('foundations.01', { score: 0.9 }), fail('foundations.01', { score: 0.1 }), fail('foundations.01', { score: 0.2 })]);
    expect(s.levels['foundations.01']).toMatchObject({ status: 'passed', bestScore: 0.9, attempts: 3 });
    expect(s.levels['foundations.02'].status).toBe('current');
  });

  it('a world stays open however long ago its boss was passed, and however wrong the clock is', () => {
    const attempts = passThrough(worlds, 'foundations.boss');
    const states = [new Date('2020-01-01T00:00:00Z'), NOW, new Date('2099-01-01T00:00:00Z')].map((now) => computeSnapshot(P1, worlds, attempts, now));
    for (const s of states) {
      expect(s.worldsUnlocked).toEqual(['foundations', 'vibrato', 'song-stage']);
      expect(s.levels['vibrato.01'].status).toBe('current');
    }
    expect(states[0].levels).toEqual(states[2].levels);
  });

  it('counts attempts dated after `now` (a clock set backwards must not undo progress)', () => {
    const s = snap([pass('foundations.01', { createdAt: '2099-01-01T00:00:00.000Z' })]);
    expect(s.levels['foundations.01'].status).toBe('passed');
  });
});

describe('computeSnapshot: which attempts count', () => {
  it('ignores another profile, soft-deleted rows, rows for unknown levels, and worlds not supplied', () => {
    const s = snap([
      pass('foundations.01', { profileId: P2 }),
      pass('foundations.01', { deletedAt: at(1) }),
      pass('no.such.level'),
      pass('dynamics.01'),
    ]);
    expect(s.levels['foundations.01'].status).toBe('current');
    expect(Object.keys(s.levels)).not.toContain('dynamics.01');
  });

  it('lets a soft-delete remove the evidence (the singer erasing their own attempt)', () => {
    const a = pass('foundations.01');
    expect(snap([a]).levels['foundations.01'].status).toBe('passed');
    expect(snap([{ ...a, deletedAt: at(2) }]).levels['foundations.01'].status).toBe('current');
  });

  it('only practice, boss and workout attempts can pass a level; record and song rows cannot', () => {
    for (const kind of ['record', 'song'] as const) {
      const s = snap([attempt({ levelId: 'foundations.01', kind, passed: true })]);
      expect(s.levels['foundations.01'].status).toBe('current');
    }
    const w = snap([attempt({ levelId: 'foundations.01', kind: 'workout', passed: true })]);
    expect(w.levels['foundations.01'].status).toBe('passed');
  });

  it('counts record attempts as attempts on the level without letting them pass it', () => {
    const s = snap([attempt({ levelId: 'foundations.01', kind: 'record', passed: true, score: 0.99 })]);
    expect(s.levels['foundations.01']).toMatchObject({ attempts: 1, bestScore: 0.99, status: 'current' });
  });

  it('routine attempts (no level) change no status but still count as practice', () => {
    const s = snap([attempt({ kind: 'workout', exerciseId: 'routine.warm-up', levelId: null, passed: true, durationSec: 600, createdAt: NOW.toISOString() })]);
    expect(passedIds(s)).toEqual([]);
    expect(s.levels['foundations.01'].status).toBe('current');
    expect(s.momentum).toBeGreaterThan(0);
    expect(s.lastPracticeDay).toBe('2026-06-01');
  });

  it('survives corrupt rows: non-finite or out-of-range scores are forced into 0..1', () => {
    const s = snap([
      attempt({ levelId: 'foundations.01', passed: false, score: NaN }),
      attempt({ levelId: 'foundations.01', passed: false, score: 7 }),
      attempt({ levelId: 'foundations.01', passed: false, score: -3 }),
    ]);
    expect(s.levels['foundations.01'].bestScore).toBe(1);
    expect(s.levels['foundations.01'].attempts).toBe(3);
    expect(Number.isFinite(s.momentum)).toBe(true);
  });

  it('an unparsable time still counts as evidence, but not as a practice day', () => {
    const s = snap([attempt({ levelId: 'foundations.01', passed: true, createdAt: 'not a time' })]);
    expect(s.levels['foundations.01'].status).toBe('passed');
    expect(s.lastPracticeDay).toBeNull();
    expect(s.momentum).toBe(0);
  });
});

describe('computeSnapshot: tempo ladders', () => {
  // A Runs-style level: practice climbs 45 -> 68 -> 90 bpm, and only a take at 90 can pass the level.
  const ladder = exerciseDef('foundations.01.ex', { kind: 'run', tempoBpm: 90, tempoLadder: [45, 68, 90] });
  const getExercise = (id: string) => (id === ladder.id ? ladder : undefined);
  const at = (bpm: number | null, extra: Partial<Parameters<typeof pass>[1]> = {}) => pass('foundations.01', { tempoBpm: bpm, ...extra });

  it('a take below the pass tempo never passes the level, even recorded as passed', () => {
    for (const bpm of [45, 68]) {
      const s = snap([at(bpm, { score: 0.99 })], { getExercise });
      expect(s.levels['foundations.01'], `${bpm} bpm`).toMatchObject({ status: 'current', attempts: 1, bestScore: 0.99, mastery: 0 });
    }
  });

  it('the take at the pass tempo passes it, after any number of lower rungs', () => {
    const s = snap([at(45), at(68), at(90, { score: 0.9, mastery: 2 })], { getExercise });
    expect(s.levels['foundations.01']).toMatchObject({ status: 'passed', attempts: 3, mastery: 2 });
    expect(s.levels['foundations.02'].status).toBe('current');
  });

  it('mastery comes from the passing take, not from a better-scoring lower rung', () => {
    const s = snap([at(68, { score: 1, mastery: 3 }), at(90, { score: 0.65, mastery: 1 })], { getExercise });
    expect(s.levels['foundations.01']).toMatchObject({ status: 'passed', mastery: 1, bestScore: 1 });
  });

  it('cannot tell without the catalog lookup, or when the tempo was not recorded, so the recorded pass stands', () => {
    expect(snap([at(45)]).levels['foundations.01'].status).toBe('passed');
    expect(snap([at(null)], { getExercise }).levels['foundations.01'].status).toBe('passed');
  });

  it('leaves exercises without a ladder alone, whatever tempo was recorded', () => {
    const plain = exerciseDef('foundations.01.ex', { tempoBpm: 90 });
    const s = snap([at(30)], { getExercise: (id) => (id === plain.id ? plain : undefined) });
    expect(s.levels['foundations.01'].status).toBe('passed');
  });

  it('keeps the world locked behind a laddered Boss Recital until it is sung at tempo', () => {
    const bossLadder = exerciseDef('foundations.boss.ex', { kind: 'boss-recital', tempoBpm: 90, tempoLadder: [60, 90] });
    const lookup = (id: string) => (id === bossLadder.id ? bossLadder : undefined);
    const before = [...passThrough(worlds, 'foundations.09'), pass('foundations.boss', { tempoBpm: 60 })];
    expect(snap(before, { getExercise: lookup }).worldsUnlocked).toEqual(['foundations']);
    expect(snap([...before, pass('foundations.boss', { tempoBpm: 90 })], { getExercise: lookup }).worldsUnlocked).toContain('vibrato');
  });
});

describe('computeSnapshot: mastery', () => {
  it('takes the best tier from PASSING attempts only', () => {
    const s = snap([pass('foundations.01', { mastery: 1 }), pass('foundations.01', { mastery: 3 }), fail('foundations.01', { mastery: 3 })]);
    expect(s.levels['foundations.01'].mastery).toBe(3);
    const failedOnly = snap([fail('foundations.01', { mastery: 2 })]);
    expect(failedOnly.levels['foundations.01'].mastery).toBe(0);
  });

  it('derives the tier from the best passing score against the exercise tiers when a lookup is supplied', () => {
    const lookup = (id: string) => (id === 'foundations.01.ex' ? exerciseDef(id, { tiers: { solid: 0.8, studio: 0.92 } }) : undefined);
    const tier = (score: number, recorded: Mastery = 1) => snap([pass('foundations.01', { score, mastery: recorded })], { getExercise: lookup }).levels['foundations.01'].mastery;
    expect(tier(0.7)).toBe(1);
    expect(tier(0.85)).toBe(2);
    expect(tier(0.95)).toBe(3);
    expect(tier(0.7, 3)).toBe(3); // a recorded tier is never taken away
    expect(snap([pass('foundations.01', { score: 0.95 })]).levels['foundations.01'].mastery).toBe(1); // no lookup: recorded only
  });

  it('masteryForScore maps tiers like the evaluator does', () => {
    const def = { tiers: { solid: 0.8, studio: 0.92 } };
    expect([0.6, 0.8, 0.919, 0.92, 1].map((x) => masteryForScore(def, x))).toEqual([1, 2, 2, 3, 3]);
  });

  it('gives an audition-granted level one tally light, however high the audition scored', () => {
    const s = snap([pass('foundations.01'), passAudition('foundations', 1, { mastery: 3, score: 1 })]);
    expect(s.levels['foundations.03'].mastery).toBe(1);
  });
});

describe('computeSnapshot: features and dates', () => {
  it('opens features in step with progress, in registry order', () => {
    expect(snap([pass('foundations.01')]).features).toEqual(['live.basic', 'dashboard', 'daily-workout', 'records', 'export']);
    const afterSirens = snap(passThrough(worlds, 'foundations.05')).features;
    expect(afterSirens).toContain('live.cracks');
    expect(afterSirens).not.toContain('live.onset');
    const afterCrisp = snap(passThrough(worlds, 'foundations.06')).features;
    expect(afterCrisp).toContain('live.onset');
    expect(afterCrisp).not.toContain('live.vibrato');
    const afterBoss = snap(passThrough(worlds, 'foundations.boss')).features;
    for (const id of ['live.vibrato', 'tool.vibrato-meter', 'setting.vibratoStyle', 'song-stage', 'song.import']) expect(afterBoss).toContain(id);
  });

  it('a Foundations audition through Sirens opens crack markers without playing the level', () => {
    const range = pass('foundations.01');
    expect(snap([range, passAudition('foundations', 1)]).features).not.toContain('live.cracks'); // test 1 stops at Sustain II
    expect(snap([range, passAudition('foundations', 1), passAudition('foundations', 2)]).features).toContain('live.cracks');
    expect(snap([range, passAudition('foundations', 2)]).features).not.toContain('live.cracks'); // test 2 alone judges nothing before it
  });

  it('reports lastPracticeDay in the requested day frame, never in the future', () => {
    const late = pass('foundations.01', { createdAt: '2026-05-20T23:30:00.000Z' });
    expect(snap([late]).lastPracticeDay).toBe('2026-05-20');
    expect(snap([late], { utcOffsetMinutes: 120 }).lastPracticeDay).toBe('2026-05-21');
    expect(snap([pass('foundations.01', { createdAt: '2099-01-01T00:00:00.000Z' })]).lastPracticeDay).toBe('2026-06-01');
  });

  it('reports momentum as the rounded momentum of the same attempts', () => {
    const attempts = [pass('foundations.01', { createdAt: at(0), durationSec: 900 }), pass('foundations.02', { createdAt: at(2), durationSec: 900 })];
    const s = snap(attempts);
    expect(s.momentum).toBeCloseTo(computeMomentum(attempts, NOW), 3);
    expect(s.momentum).toBeGreaterThan(0);
  });
});

describe('computeSnapshot: determinism and purity', () => {
  const log = [
    ...passThrough(worlds, 'foundations.04'),
    passAudition('foundations', 2),
    fail('foundations.06', { score: 0.4 }),
    attempt({ kind: 'workout', levelId: 'foundations.06', passed: false }),
  ];

  it('is the same for any input order and for equivalent `now` types', () => {
    const a = computeSnapshot(P1, worlds, log, NOW);
    expect(computeSnapshot(P1, worlds, [...log].reverse(), NOW)).toEqual(a);
    expect(computeSnapshot(P1, worlds, log, NOW.getTime())).toEqual(a);
    expect(computeSnapshot(P1, worlds, log, NOW.toISOString())).toEqual(a);
  });

  it('never mutates its inputs', () => {
    const frozenWorlds = deepFreeze(fixtureWorlds());
    const frozenLog = deepFreeze(log.map((x) => ({ ...x, metrics: { ...x.metrics } })));
    expect(() => computeSnapshot(P1, frozenWorlds, frozenLog, NOW)).not.toThrow();
  });

  it('rejects an invalid `now` loudly', () => {
    expect(() => computeSnapshot(P1, worlds, log, 'yesterday')).toThrow(RangeError);
    expect(() => computeSnapshot(P1, worlds, log, new Date(NaN))).toThrow(RangeError);
  });
});
