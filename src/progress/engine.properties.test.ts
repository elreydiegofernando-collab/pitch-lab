/**
 * Property tests for the gate: a simulated singer plays through the fixture worlds, and a chaotic
 * log throws garbage at it. After EVERY step the snapshot must still be linear, gated, never
 * re-locked and independent of input order. The PRNG is seeded, so a failure reproduces exactly.
 */
import { describe, expect, it } from 'vitest';
import { computeSnapshot } from './engine';
import { P1, P2, attempt, audition, bossLevel, fixtureWorlds, level, levelIds, pass, seeded, world } from './test-fixtures';
import type { AttemptRecord } from '../storage/schema';
import type { WorldDef, WorldId } from '../exercises/types';
import { LEVEL_REFS, isAuditionAvailable, isExerciseOpenable, isLevelOpenable, nextAuditionExercise, unlockedFeatures } from './unlocks';
import type { Mastery, ProgressSnapshot } from './types';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const worlds = fixtureWorlds();
const ALL_LEVEL_IDS = worlds.flatMap(levelIds);
const BOSS_IDS = new Set(worlds.flatMap((w) => w.levels.filter((l) => l.kind === 'boss').map((l) => l.id)));
const AUDITION_EXERCISES = worlds.flatMap((w) => w.audition?.exerciseIds ?? []);
const PASSING_KINDS = new Set(['practice', 'boss', 'workout']);

/**
 * An independent restatement of the audition rule (not the code under test): test i covers the levels past what
 * the tests before it reach, up to its own `unlockThrough`, both held short of the world's first Boss Recital.
 */
function ownSpan(w: WorldDef, i: number): string[] {
  const ids = [...w.levels].sort((a, b) => a.index - b.index).map((l) => l.id);
  const a = w.audition!;
  const boss = [...w.levels].sort((x, y) => x.index - y.index).findIndex((l) => l.kind === 'boss');
  const ceiling = boss < 0 ? ids.length - 1 : boss - 1;
  const reach = (k: number): number => Math.min(ids.indexOf(a.unlockThrough[k]), ceiling);
  let before = -1;
  for (let k = 0; k < i; k++) before = Math.max(before, reach(k));
  return ids.slice(before + 1, reach(i) + 1);
}

type Rand = () => number;
const pick = <T>(rand: Rand, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];

function shuffled<T>(rand: Rand, xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Everything that must hold for ANY log. */
function expectInvariants(s: ProgressSnapshot, attempts: readonly AttemptRecord[]): void {
  const mine = attempts.filter((a) => a.profileId === P1 && a.deletedAt === null);
  const directPass = (levelId: string) => mine.some((a) => a.levelId === levelId && a.passed && PASSING_KINDS.has(a.kind));

  for (const w of worlds) {
    const ids = levelIds(w);
    const open = s.worldsUnlocked.includes(w.id);

    // Strictly linear: passed*, current?, locked*; and a closed world is wholly locked.
    if (ids.length > 0) {
      const statuses = ids.map((id) => s.levels[id].status);
      expect(`${statuses.join(',')},`).toMatch(/^(passed,)*(current,)?(locked,)*$/);
      if (!open) expect(statuses.every((x) => x === 'locked')).toBe(true);
      if (open && statuses.some((x) => x !== 'passed')) expect(statuses.filter((x) => x === 'current')).toHaveLength(1);
    }

    // A world is open only from the start, or because its gate level was passed by a real attempt.
    if (w.unlockedBy !== null && open) {
      expect(s.levels[w.unlockedBy].status).toBe('passed');
      expect(s.levels[w.unlockedBy].viaAudition).toBe(false);
      expect(directPass(w.unlockedBy)).toBe(true);
    }
  }

  for (const lp of Object.values(s.levels)) {
    expect(lp.mastery >= 1).toBe(lp.status === 'passed'); // tally lights exactly when passed
    if (lp.status !== 'passed') continue;
    if (lp.viaAudition) expect(BOSS_IDS.has(lp.levelId)).toBe(false); // an audition never grants a Boss Recital
    else expect(directPass(lp.levelId)).toBe(true); // everything else was really sung
  }

  // Provenance: a level granted by audition lies inside the OWN span of a test that was really passed (a later
  // test never vouches for an earlier test's levels), and the Range finder is never granted at all.
  expect(s.levels[LEVEL_REFS.rangeFinder].viaAudition).toBe(false);
  const passedTests = new Set(mine.filter((a) => a.kind === 'audition' && a.passed === true).map((a) => a.exerciseId));
  for (const w of worlds) {
    const owned = new Set<string>();
    w.audition?.exerciseIds.forEach((exerciseId, i) => {
      if (passedTests.has(exerciseId)) for (const id of ownSpan(w, i)) owned.add(id);
    });
    for (const id of levelIds(w)) if (s.levels[id].viaAudition) expect(owned.has(id), `${id} granted by audition without a passed test covering it`).toBe(true);
  }

  expect(s.features).toEqual(unlockedFeatures(s));
  expect(s.levels).not.toHaveProperty('dynamics.01');
}

function expectNoRelock(prev: ProgressSnapshot, next: ProgressSnapshot): void {
  for (const lp of Object.values(prev.levels)) if (lp.status === 'passed') expect(next.levels[lp.levelId].status).toBe('passed');
  for (const w of prev.worldsUnlocked) expect(next.worldsUnlocked).toContain(w);
  for (const f of prev.features) expect(next.features).toContain(f);
}

interface Run {
  attempts: AttemptRecord[];
  final: ProgressSnapshot;
  /** An audition granted at least one level at some point in the run. */
  sawAuditionGrant: boolean;
}

const runs = new Map<number, Run>();
const SINGER_STEPS = 300;

/** A singer who only ever opens what the gate lets them open (memoized: the runs are shared by several tests). */
function singerRun(seed: number): Run {
  let run = runs.get(seed);
  if (!run) {
    run = simulateSinger(seed, SINGER_STEPS);
    runs.set(seed, run);
  }
  return run;
}

function simulateSinger(seed: number, steps: number): Run {
  const rand = seeded(seed);
  const attempts: AttemptRecord[] = [];
  let prev = computeSnapshot(P1, worlds, attempts, NOW);
  let sawAuditionGrant = false;
  for (let step = 0; step < steps; step++) {
    const r = rand();
    const openTests = AUDITION_EXERCISES.filter((id) => isExerciseOpenable(id, prev, worlds)); // at most one per open audition: the next test
    if (r < 0.08 && openTests.length > 0) {
      attempts.push(attempt({ kind: 'audition', exerciseId: pick(rand, openTests), passed: rand() < 0.5, score: 0.6 + rand() * 0.4 }));
    } else if (r < 0.12) {
      attempts.push(attempt({ kind: 'workout', exerciseId: 'routine.warm-up', passed: true }));
    } else {
      const openable = ALL_LEVEL_IDS.filter((id) => isLevelOpenable(id, prev));
      const current = openable.filter((id) => prev.levels[id].status === 'current');
      const levelId = rand() < 0.65 && current.length > 0 ? pick(rand, current) : pick(rand, openable);
      const passed = rand() < 0.55;
      attempts.push(attempt({ levelId, kind: BOSS_IDS.has(levelId) ? 'boss' : 'practice', passed, score: passed ? 0.6 + rand() * 0.4 : rand() * 0.6, mastery: (passed ? 1 + Math.floor(rand() * 3) : 0) as Mastery }));
    }
    const next = computeSnapshot(P1, worlds, attempts, NOW);
    expectInvariants(next, attempts);
    expectNoRelock(prev, next);
    if (Object.values(next.levels).some((l) => l.viaAudition)) sawAuditionGrant = true;
    prev = next;
  }
  return { attempts, final: prev, sawAuditionGrant };
}

function randomAttempt(rand: Rand, snapshot: ProgressSnapshot): AttemptRecord {
  const kind = pick(rand, ['practice', 'audition', 'boss', 'record', 'song', 'workout'] as const);
  const current = ALL_LEVEL_IDS.filter((id) => snapshot.levels[id].status === 'current');
  const r = rand();
  const levelId = r < 0.45 && current.length > 0 ? pick(rand, current) : r < 0.75 ? pick(rand, ALL_LEVEL_IDS) : r < 0.8 ? 'unknown.level' : null;
  return attempt({
    profileId: rand() < 0.9 ? P1 : P2,
    kind,
    levelId,
    exerciseId: kind === 'audition' ? pick(rand, AUDITION_EXERCISES) : levelId ? `${levelId}.ex` : 'free',
    passed: rand() < 0.6,
    score: rand(),
    mastery: Math.floor(rand() * 4) as Mastery,
  });
}

describe('the gate, under a simulated singer', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`keeps every invariant at every step (seed ${seed})`, () => {
      const { attempts, final } = singerRun(seed);
      expect(attempts.length).toBe(SINGER_STEPS);
      expectInvariants(final, attempts);
    });
  }

  it('reaches the end of the fixture game and uses auditions on the way, so every rule was exercised', () => {
    const all = [1, 2, 3, 4, 5, 6].map(singerRun);
    expect(all.some((r) => r.final.levels['inflections.boss'].status === 'passed')).toBe(true);
    expect(all.some((r) => r.final.worldsUnlocked.includes('song-stage'))).toBe(true);
    expect(all.some((r) => r.sawAuditionGrant)).toBe(true);
  });

  it('is independent of the order the rows arrive in', () => {
    const rand = seeded(99);
    const { attempts, final } = singerRun(1);
    for (let i = 0; i < 5; i++) expect(computeSnapshot(P1, worlds, shuffled(rand, attempts), NOW)).toEqual(final);
  });
});

describe('the gate, under chaos', () => {
  for (const seed of [11, 12, 13, 14]) {
    it(`survives garbage logs without ever skipping a level, a boss or a world (seed ${seed})`, () => {
      const rand = seeded(seed);
      const attempts: AttemptRecord[] = [];
      let prev = computeSnapshot(P1, worlds, attempts, NOW);
      for (let step = 0; step < 400; step++) {
        attempts.push(randomAttempt(rand, prev));
        const next = computeSnapshot(P1, worlds, attempts, NOW);
        expectInvariants(next, attempts);
        expectNoRelock(prev, next); // no deletions in this log: evidence only ever accumulates
        prev = next;
      }
      expect(computeSnapshot(P1, worlds, shuffled(rand, attempts), NOW)).toEqual(prev);
    });
  }

  it('cannot be bypassed by passing every audition in every world, in any order', () => {
    const rand = seeded(5);
    const all = [pass('foundations.01'), ...AUDITION_EXERCISES.map((exerciseId) => attempt({ kind: 'audition', exerciseId, passed: true }))];
    for (let round = 0; round < 6; round++) {
      const s = computeSnapshot(P1, worlds, shuffled(rand, all), NOW);
      expect(s.worldsUnlocked).toEqual(['foundations']);
      expect(s.levels['foundations.boss'].status).toBe('current');
      expect(s.levels['foundations.09'].status).toBe('passed');
      for (const id of ['vibrato.01', 'vibrato.boss', 'inflections.01']) expect(isLevelOpenable(id, s)).toBe(false);
      expectInvariants(s, all);
    }
  });

  it('cannot be bypassed by passing every audition when the Range finder was never sung', () => {
    const rand = seeded(6);
    const all = AUDITION_EXERCISES.map((exerciseId) => attempt({ kind: 'audition', exerciseId, passed: true }));
    for (let round = 0; round < 6; round++) {
      const s = computeSnapshot(P1, worlds, shuffled(rand, all), NOW);
      expect(s.worldsUnlocked).toEqual(['foundations']);
      expect(Object.values(s.levels).filter((l) => l.status === 'passed')).toEqual([]); // not even a level of another open world
      expect(s.levels[LEVEL_REFS.rangeFinder].status).toBe('current');
      expect(s.features).toEqual(['live.basic', 'export']);
      expect(isAuditionAvailable('foundations', s, worlds)).toBe(false);
      for (const id of AUDITION_EXERCISES) expect(isExerciseOpenable(id, s, worlds), id).toBe(false);
      expectInvariants(s, all);
    }
  });

  it('cannot be bypassed by recording passes on every level in reverse order', () => {
    const all = [...ALL_LEVEL_IDS].reverse().map((levelId) => attempt({ levelId, kind: BOSS_IDS.has(levelId) ? 'boss' : 'practice', passed: true }));
    const s = computeSnapshot(P1, worlds, all, NOW);
    // Every level has a real pass on record, so the order the rows were written in is irrelevant:
    // nothing is skipped, and the result is the same as the forward run.
    expectInvariants(s, all);
    const forwardOnly = computeSnapshot(P1, worlds, [...all].reverse(), NOW);
    expect(s).toEqual(forwardOnly);
  });
});

describe('the audition ladder', () => {
  const grantedBy = (w: WorldDef, rows: AttemptRecord[], rand: Rand): string[] => {
    const s = computeSnapshot(P1, worlds, shuffled(rand, rows), NOW);
    expectInvariants(s, rows);
    return levelIds(w).filter((id) => s.levels[id].status === 'passed');
  };

  it('grants exactly the longest passed prefix of a world\'s tests, whatever subset is passed and in whatever order', () => {
    const rand = seeded(21);
    const [foundations, vibrato] = worlds;
    const base = levelIds(foundations).map((id) => pass(id)); // Foundations really sung to its boss: Vibrato is open
    for (const [w, before] of [[foundations, [pass('foundations.01')]], [vibrato, base]] as const) {
      const ids = levelIds(w);
      const tests = w.audition!.exerciseIds;
      const lastBefore = w === foundations ? 1 : 0; // levels already passed by hand
      for (let mask = 0; mask < 1 << tests.length; mask++) {
        let prefix = 0;
        while (prefix < tests.length && (mask & (1 << prefix)) !== 0) prefix++;
        const rows = [...before, ...tests.filter((_, i) => (mask & (1 << i)) !== 0).map((exerciseId) => attempt({ kind: 'audition', exerciseId, passed: true }))];
        const reach = prefix === 0 ? lastBefore : ids.indexOf(w.audition!.unlockThrough[prefix - 1]) + 1;
        for (let round = 0; round < 3; round++) {
          expect(grantedBy(w, rows, rand), `${w.id} tests ${mask.toString(2)}`).toEqual(ids.slice(0, reach));
        }
      }
    }
  });

  /** A random OPEN world with a placement audition: 3-9 levels and a boss (usually last), 1-4 tests that mostly rise and sometimes point nowhere. */
  function randomWorld(rand: Rand, id: WorldId): WorldDef {
    const total = 4 + Math.floor(rand() * 7); // levels plus the boss
    const bossPos = rand() < 0.8 ? total : 1 + Math.floor(rand() * total);
    const levels = Array.from({ length: total }, (_, k) => (k + 1 === bossPos ? bossLevel(id, k + 1) : level(id, k + 1, `L${k + 1}`)));
    const tests = 1 + Math.floor(rand() * 4);
    const picks = Array.from({ length: tests }, () => (rand() < 0.1 ? 'no.such.level' : pick(rand, levels).id));
    const position = (levelId: string) => levels.findIndex((l) => l.id === levelId);
    if (rand() < 0.7) picks.sort((a, b) => position(a) - position(b));
    return world(id, 'Random', levels, null, audition(id, tests, picks));
  }

  /** The singer follows the registry: ask for the next test, pass it, repeat. The engine and the registry must stay in step. */
  function walk(w: WorldDef): void {
    const ids = levelIds(w);
    const tests = w.audition!.exerciseIds;
    const rangeFirst = ids.includes(LEVEL_REFS.rangeFinder);
    const log: AttemptRecord[] = [];
    const snap = () => computeSnapshot(P1, [w], log, NOW);
    const passedCount = (s: ProgressSnapshot) => ids.filter((id) => s.levels[id].status === 'passed').length;

    if (rangeFirst) {
      // Nothing opens, and nothing is granted, until the Range finder is really sung.
      for (const t of tests) expect(isExerciseOpenable(t, snap(), [w]), `${w.id}: ${t} before the Range finder`).toBe(false);
      const forged = computeSnapshot(P1, [w], tests.map((exerciseId) => attempt({ kind: 'audition', exerciseId, passed: true })), NOW);
      expect(passedCount(forged), `${w.id}: forged audition rows`).toBe(0);
      log.push(pass(LEVEL_REFS.rangeFinder));
    }
    for (let step = 0; step <= tests.length; step++) {
      const s = snap();
      const next = nextAuditionExercise(w.id, s, [w]);
      expect(isAuditionAvailable(w.id, s, [w])).toBe(next !== null);
      for (const t of tests) expect(isExerciseOpenable(t, s, [w]), `${w.id}: ${t} at step ${step}`).toBe(t === next);
      if (next === null) {
        // Done: exactly what the tests cover is passed (plus the Range finder, which was sung), never a boss or what lies past it.
        const covered = new Set(tests.flatMap((_, i) => ownSpan(w, i)));
        for (const id of ids) expect(s.levels[id].status === 'passed', `${w.id}: ${id} at the end`).toBe(covered.has(id) || (rangeFirst && id === LEVEL_REFS.rangeFinder));
        return;
      }
      const before = passedCount(s);
      log.push(attempt({ kind: 'audition', exerciseId: next, passed: true }));
      const after = snap();
      expect(passedCount(after), `${w.id}: ${next} was offered but granted nothing`).toBeGreaterThan(before);
      expect(`${ids.map((id) => after.levels[id].status).join(',')},`, `${w.id}: statuses stay linear`).toMatch(/^(passed,)*(current,)?(locked,)*$/);
      expect(ids.filter((id) => BOSS_IDS.has(id) && after.levels[id].status === 'passed'), `${w.id}: an audition granted a boss`).toEqual([]);
    }
    throw new Error(`${w.id}: the audition kept offering tests after every one was passed`);
  }

  it('offers one test at a time and every offered test is worth passing, on 300 random worlds', () => {
    const rand = seeded(33);
    for (let n = 0; n < 150; n++) {
      walk(randomWorld(rand, 'vibrato'));
      walk(randomWorld(rand, 'foundations')); // its first level is the Range finder
    }
  });
});
