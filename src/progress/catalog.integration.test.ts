/**
 * Cross-check of the progression engine against the REAL exercise catalog: the registry's level
 * ids still resolve, a full playthrough of every real world unlocks in order, the real auditions
 * obey the gate, and workouts built from real exercise lengths fit their budgets. The other test
 * files use hand-built worlds; this one fails loudly if the catalog drifts from what progress
 * expects (renamed ids, a boss that is not last, an audition pointing at a boss...).
 */
import { describe, expect, it } from 'vitest';
import { WORLDS, getExercise, getLevel, levelForExercise } from '../exercises/catalog';
import type { LevelDef, WorldDef } from '../exercises/types';
import type { AttemptRecord } from '../storage/schema';
import { computeSnapshot } from './engine';
import { COOL_DOWN_ROUTINE_ID, WARM_UP_ROUTINE_ID } from './routines';
import { P1, attempt } from './test-fixtures';
import {
  FEATURES,
  FEATURE_IDS,
  LEVEL_REFS,
  auditionRequirementHint,
  bossLevelOf,
  isAuditionAvailable,
  isExerciseOpenable,
  isFeatureUnlocked,
  isLevelOpenable,
  isSongUnlocked,
  levelRequirementHint,
  nextAuditionExercise,
  unlockedFeatures,
  worldRequirementHint,
} from './unlocks';
import { buildDailyWorkout, estimateTakeSeconds } from './workout';
import type { WorkoutMinutes } from './workout';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const TRAINING = WORLDS.filter((w) => w.levels.length > 0);
const ordered = (w: WorldDef): LevelDef[] => [...w.levels].sort((a, b) => a.index - b.index);
const ALL_LEVELS = TRAINING.flatMap(ordered);
const snap = (attempts: AttemptRecord[], extra: { utcOffsetMinutes?: number } = {}) => computeSnapshot(P1, WORLDS, attempts, NOW, { getExercise, ...extra });

function realPass(level: LevelDef, extra: Partial<AttemptRecord> = {}): AttemptRecord {
  return attempt({ levelId: level.id, exerciseId: level.exerciseId, kind: level.kind === 'boss' ? 'boss' : 'practice', passed: true, score: 0.85, mastery: 1, ...extra });
}

/** Real passing attempts, in order, for every level up to and including `levelId`. */
function playThrough(levelId: string): AttemptRecord[] {
  const out: AttemptRecord[] = [];
  for (const level of ALL_LEVELS) {
    out.push(realPass(level));
    if (level.id === levelId) return out;
  }
  throw new Error(`unknown level ${levelId}`);
}

describe('the catalog is what progress expects', () => {
  it('chains the worlds: Foundations from the start, each other world behind a previous Boss Recital', () => {
    expect(WORLDS[0].unlockedBy).toBeNull();
    const seen = new Set<string>();
    for (const w of WORLDS) {
      if (w.unlockedBy !== null) {
        const gate = getLevel(w.unlockedBy);
        expect(gate, `${w.id} gate ${w.unlockedBy}`).toBeDefined();
        expect(gate?.kind).toBe('boss');
        expect(seen.has(gate!.worldId)).toBe(true); // an earlier world's boss
        expect(gate!.worldId).not.toBe(w.id);
      }
      seen.add(w.id);
    }
  });

  it('ends every training world with exactly one Boss Recital, and gives every level an exercise', () => {
    for (const w of TRAINING) {
      const levels = ordered(w);
      expect(levels.filter((l) => l.kind === 'boss')).toHaveLength(1);
      expect(levels[levels.length - 1].kind).toBe('boss');
      expect(bossLevelOf(WORLDS, w.id)?.id).toBe(levels[levels.length - 1].id);
      expect(new Set(levels.map((l) => l.index)).size).toBe(levels.length);
      for (const l of levels) {
        expect(getExercise(l.exerciseId), l.id).toBeDefined();
        expect(levelForExercise(l.exerciseId)?.id).toBe(l.id);
      }
    }
  });

  it('keeps every audition inside its own world, short of the boss, with real exercises', () => {
    for (const w of TRAINING) {
      const a = w.audition;
      if (!a) continue;
      expect(a.exerciseIds.length).toBe(a.unlockThrough.length);
      const ids = ordered(w).map((l) => l.id);
      for (const [i, through] of a.unlockThrough.entries()) {
        expect(ids, `${w.id} unlockThrough[${i}]`).toContain(through);
        expect(getLevel(through)?.kind).toBe('level');
        expect(getExercise(a.exerciseIds[i]), a.exerciseIds[i]).toBeDefined();
        // A fresh profile can take no audition test anywhere: Foundations' waits for the Range finder, the rest are shut.
        expect(isExerciseOpenable(a.exerciseIds[i], snap([]), WORLDS)).toBe(false);
      }
    }
  });

  it('registry level ids still resolve to the levels the hints and requirements name', () => {
    for (const id of FEATURE_IDS) {
      const req = FEATURES[id];
      if (req.kind === 'levelPassed' && req.ref) {
        const level = getLevel(req.ref);
        expect(level, `${id} -> ${req.ref}`).toBeDefined();
        const named = level!.kind === 'boss' ? `${WORLDS.find((w) => w.id === level!.worldId)!.title} Boss Recital` : level!.title;
        expect(req.hint, id).toContain(named);
      }
      if (req.kind === 'worldUnlocked') expect(WORLDS.some((w) => w.id === req.ref)).toBe(true);
    }
    // The Range finder is the first level of the always-open world, and the only one that measures the range.
    const rangeFinder = getLevel(LEVEL_REFS.rangeFinder)!;
    expect(getExercise(rangeFinder.exerciseId)?.kind).toBe('range-finder');
    expect(ordered(WORLDS.find((w) => w.id === rangeFinder.worldId)!)[0].id).toBe(rangeFinder.id);
    expect(WORLDS.find((w) => w.id === rangeFinder.worldId)?.unlockedBy).toBeNull();
    expect(ALL_LEVELS.filter((l) => getExercise(l.exerciseId)?.kind === 'range-finder').map((l) => l.id)).toEqual([rangeFinder.id]);
    expect(getExercise(getLevel(LEVEL_REFS.sirens)!.exerciseId)?.kind).toBe('siren');
    expect(getExercise(getLevel(LEVEL_REFS.crispness)!.exerciseId)?.kind).toBe('staccato');
    expect(getLevel(LEVEL_REFS.foundationsBoss)?.worldId).toBe('foundations');
    for (const id of ['live.vibrato', 'tool.vibrato-meter', 'setting.vibratoStyle'] as const) {
      expect(WORLDS.find((w) => w.id === FEATURES[id].ref)?.unlockedBy).toBe(LEVEL_REFS.foundationsBoss);
    }
    expect(WORLDS.find((w) => w.id === 'song-stage')?.unlockedBy).toBe(LEVEL_REFS.foundationsBoss);
  });
});

describe('a full playthrough of the real game', () => {
  it('opens one level at a time, in order, across every world', () => {
    const attempts: AttemptRecord[] = [];
    for (const world of TRAINING) {
      for (const level of ordered(world)) {
        const s = snap(attempts);
        expect(s.levels[level.id].status, `${level.id} should be the frontier`).toBe('current');
        expect(isLevelOpenable(level.id, s)).toBe(true);
        const later = ALL_LEVELS.slice(ALL_LEVELS.indexOf(level) + 1);
        for (const l of later) expect(isLevelOpenable(l.id, s), `${l.id} must be locked while ${level.id} is current`).toBe(false);
        attempts.push(realPass(level));
      }
    }
    const done = snap(attempts);
    expect(Object.values(done.levels).every((l) => l.status === 'passed')).toBe(true);
    expect(done.worldsUnlocked).toEqual(WORLDS.map((w) => w.id));
    expect(done.features).toEqual([...FEATURE_IDS]);
  });

  it('opens each world exactly when the previous Boss Recital is passed', () => {
    for (const [i, world] of TRAINING.slice(1).entries()) {
      const prev = TRAINING[i];
      const bossId = bossLevelOf(WORLDS, prev.id)!.id;
      const beforeBoss = playThrough(ordered(prev)[ordered(prev).length - 2].id);
      expect(snap(beforeBoss).worldsUnlocked).not.toContain(world.id);
      expect(snap([...beforeBoss, realPass(getLevel(bossId)!)]).worldsUnlocked).toContain(world.id);
    }
  });

  it('opens features along the way: dashboard, crack markers, onset readouts, then the Vibrato set and Song Stage', () => {
    const features = (id: string) => unlockedFeatures(snap(playThrough(id)));
    expect(features('foundations.01')).toEqual(expect.arrayContaining(['dashboard', 'daily-workout', 'records']));
    expect(features('foundations.01')).not.toContain('live.cracks');
    expect(features(LEVEL_REFS.sirens)).toContain('live.cracks');
    expect(features(LEVEL_REFS.sirens)).not.toContain('live.onset');
    expect(features(LEVEL_REFS.crispness)).toContain('live.onset');
    expect(features(LEVEL_REFS.crispness)).not.toContain('live.vibrato');
    const afterBoss = features(LEVEL_REFS.foundationsBoss);
    for (const id of ['live.vibrato', 'tool.vibrato-meter', 'setting.vibratoStyle', 'song-stage', 'song.import']) expect(afterBoss).toContain(id);
  });

  it('opens songs only when the world their difficulty needs has had its Boss Recital passed', () => {
    for (const world of TRAINING) {
      const bossId = bossLevelOf(WORLDS, world.id)!.id;
      const before = playThrough(ordered(world)[ordered(world).length - 2].id);
      expect(isSongUnlocked(world.id, snap(before), WORLDS)).toBe(false);
      expect(isSongUnlocked(world.id, snap([...before, realPass(getLevel(bossId)!)]), WORLDS)).toBe(true);
    }
  });

  it('keeps the snapshot plain JSON at every step (it is cached in IndexedDB)', () => {
    for (const level of ALL_LEVELS.filter((_, i) => i % 5 === 0)) {
      const s = snap(playThrough(level.id));
      expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    }
  });

  it('says how to unlock a locked tile in the catalog\'s own words', () => {
    const s = snap([]);
    expect(levelRequirementHint('foundations.03', s, WORLDS)).toBe('Pass Range finder to unlock.');
    expect(levelRequirementHint('vibrato.01', s, WORLDS)).toBe('Pass the Foundations Boss Recital to unlock Vibrato.');
    expect(worldRequirementHint('inflections', s, WORLDS)).toBe('Pass the Vibrato Boss Recital to unlock Inflections.');
    expect(levelRequirementHint('foundations.01', s, WORLDS)).toBeNull();
  });

  it('derives mastery from the real tiers: pass, solid, studio', () => {
    const level = getLevel('foundations.03')!;
    const tiers = getExercise(level.exerciseId)!.tiers;
    const tier = (score: number) => snap([...playThrough('foundations.02'), realPass(level, { score })]).levels[level.id].mastery;
    expect(tier(getExercise(level.exerciseId)!.pass.score)).toBe(1);
    expect(tier(tiers.solid)).toBe(2);
    expect(tier(tiers.studio)).toBe(3);
  });

  it('records only the metrics the real exercise scores', () => {
    const level = getLevel('foundations.03')!;
    const def = getExercise(level.exerciseId)!;
    const scored = def.scoring.map((t) => t.metric);
    const attempts = [...playThrough('foundations.02'), realPass(level, { metrics: { [scored[0]]: 80, 'onset.settleMs': 100, 'run.score': 0.9 } })];
    const keys = Object.keys(snap(attempts).records).filter((k) => k.startsWith(`${level.exerciseId}:`));
    expect(keys).toEqual([`${level.exerciseId}:${scored[0]}`]);
  });
});

describe('placement auditions on the real catalog', () => {
  const auditionRow = (exerciseId: string, extra: Partial<AttemptRecord> = {}): AttemptRecord => attempt({ kind: 'audition', exerciseId, levelId: null, passed: true, ...extra });
  const rangeFinderSung = (): AttemptRecord => realPass(getLevel(LEVEL_REFS.rangeFinder)!);

  /**
   * Real passes of everything before `world`, leaving `world` open with nothing passed in it, except that the
   * Range finder (the only level an audition may never stand in for) has really been sung.
   */
  function justOpened(world: WorldDef): AttemptRecord[] {
    const sungRange = world.levels.some((l) => l.id === LEVEL_REFS.rangeFinder) ? [rangeFinderSung()] : [];
    return world.unlockedBy === null ? sungRange : playThrough(world.unlockedBy);
  }

  for (const world of TRAINING.filter((w) => w.audition)) {
    it(`${world.id}: the tests in order each grant exactly their own levels, never the boss, never another world`, () => {
      const a = world.audition!;
      const levels = ordered(world);
      const base = justOpened(world);
      const rows: AttemptRecord[] = [];
      for (const [i, exerciseId] of a.exerciseIds.entries()) {
        // Exactly one test is on offer, and it is the next one in the audition.
        const before = snap([...base, ...rows]);
        expect(nextAuditionExercise(world.id, before, WORLDS), `${world.id}: next before test ${i + 1}`).toBe(exerciseId);
        expect(isAuditionAvailable(world.id, before, WORLDS)).toBe(true);
        for (const other of a.exerciseIds) expect(isExerciseOpenable(other, before, WORLDS), `${other} before test ${i + 1}`).toBe(other === exerciseId);

        rows.push(auditionRow(exerciseId, { score: 0.9 }));
        const s = snap([...base, ...rows]);
        const throughIdx = levels.findIndex((l) => l.id === a.unlockThrough[i]);
        levels.forEach((l, idx) => {
          const expected = idx <= throughIdx ? 'passed' : idx === throughIdx + 1 ? 'current' : 'locked';
          expect(s.levels[l.id].status, `${exerciseId} -> ${l.id}`).toBe(expected);
          if (expected !== 'passed') return;
          // The Range finder was sung to get here; every other level is granted, and never played through.
          const how = l.id === LEVEL_REFS.rangeFinder ? { viaAudition: false, attempts: 1 } : { viaAudition: true, mastery: 1, attempts: 0 };
          expect(s.levels[l.id], `${exerciseId} -> ${l.id}`).toMatchObject(how);
        });
        expect(s.levels[levels[levels.length - 1].id].status).not.toBe('passed');
        expect(s.worldsUnlocked).toEqual(snap(base).worldsUnlocked); // nothing new opens
      }
      expect(nextAuditionExercise(world.id, snap([...base, ...rows]), WORLDS)).toBeNull(); // nothing left for it to grant
    });

    it(`${world.id}: a later test sung alone is neither openable nor worth anything`, () => {
      const base = justOpened(world);
      const before = snap(base);
      world.audition!.exerciseIds.slice(1).forEach((exerciseId) => {
        expect(isExerciseOpenable(exerciseId, before, WORLDS), `${exerciseId} opened out of order`).toBe(false);
        const forged = snap([...base, auditionRow(exerciseId, { score: 1 })]);
        expect(forged.levels, `${exerciseId} alone`).toEqual(before.levels); // not a level changed, nothing granted
        expect(forged.features).toEqual(before.features);
        expect(nextAuditionExercise(world.id, forged, WORLDS)).toBe(world.audition!.exerciseIds[0]); // the run still starts at test 1
      });
    });
  }

  it('closes the reported bypasses: the last test of a world no longer passes the levels the earlier ones judge', () => {
    // A fresh profile and one passed Foundations test 4: it used to pass levels 01-09, opening cracks, onset and the dashboard.
    const lastFoundations = WORLDS[0].audition!.exerciseIds.at(-1)!;
    const fresh = snap([]);
    const s = snap([auditionRow(lastFoundations)]);
    expect(s.levels).toEqual(fresh.levels);
    expect(s.features).toEqual(['live.basic', 'export']);
    expect(isExerciseOpenable(lastFoundations, fresh, WORLDS)).toBe(false);
    // Vibrato just opened: test 4 used to grant vibrato.01-08 without checking oscillation or pulses.
    const vibrato = WORLDS.find((w) => w.id === 'vibrato')!;
    const open = justOpened(vibrato);
    const vibratoLast = vibrato.audition!.exerciseIds.at(-1)!;
    expect(isExerciseOpenable(vibratoLast, snap(open), WORLDS)).toBe(false);
    expect(snap([...open, auditionRow(vibratoLast)]).levels).toEqual(snap(open).levels);
    // Runs just opened: test 3 used to grant runs.01-08 and leave the boss current.
    const runs = WORLDS.find((w) => w.id === 'runs')!;
    const runsOpen = justOpened(runs);
    const runsLast = runs.audition!.exerciseIds.at(-1)!;
    expect(isExerciseOpenable(runsLast, snap(runsOpen), WORLDS)).toBe(false);
    expect(snap([...runsOpen, auditionRow(runsLast)]).levels).toEqual(snap(runsOpen).levels);
  });

  it('grants nothing in a world that is not open yet', () => {
    for (const world of TRAINING.filter((w) => w.audition && w.unlockedBy !== null)) {
      const s = snap(world.audition!.exerciseIds.map((exerciseId) => auditionRow(exerciseId)));
      expect(ordered(world).every((l) => s.levels[l.id].status === 'locked'), world.id).toBe(true);
      expect(isAuditionAvailable(world.id, s, WORLDS)).toBe(false);
      for (const exerciseId of world.audition!.exerciseIds) expect(isExerciseOpenable(exerciseId, s, WORLDS), exerciseId).toBe(false);
    }
  });

  it('passing every audition in every world, in catalog order, still leaves every Boss Recital to be sung', () => {
    const all = TRAINING.flatMap((w) => (w.audition?.exerciseIds ?? []).map((exerciseId) => auditionRow(exerciseId)));
    const s = snap([rangeFinderSung(), ...all]);
    expect(s.worldsUnlocked).toEqual(['foundations']);
    const foundations = ordered(WORLDS[0]);
    expect(foundations.slice(0, -1).every((l) => s.levels[l.id].status === 'passed')).toBe(true);
    expect(s.levels[bossLevelOf(WORLDS, 'foundations')!.id].status).toBe('current');
    for (const world of TRAINING.slice(1)) expect(ordered(world).every((l) => s.levels[l.id].status === 'locked'), world.id).toBe(true);
  });

  it('GUARD: an audition passed before the Range finder is sung neither passes it nor grants anything yet', () => {
    const first = WORLDS[0].audition!.exerciseIds[0];
    const all = WORLDS[0].audition!.exerciseIds.map((exerciseId) => auditionRow(exerciseId));
    for (const log of [[auditionRow(first)], all]) {
      const s = snap(log);
      expect(s.levels[LEVEL_REFS.rangeFinder]).toMatchObject({ status: 'current', viaAudition: false, passedAt: null, mastery: 0 });
      expect(Object.values(s.levels).filter((l) => l.status === 'passed')).toEqual([]);
      expect(s.features).toEqual(['live.basic', 'export']);
      expect(isAuditionAvailable('foundations', s, WORLDS)).toBe(false);
      expect(nextAuditionExercise('foundations', s, WORLDS)).toBeNull();
      expect(isExerciseOpenable(first, s, WORLDS)).toBe(false);
      expect(auditionRequirementHint('foundations', s, WORLDS)).toBe('Pass Range finder to unlock the audition.');
    }
  });

  it('GUARD: once the Range finder is really sung, the test recorded before it counts and the audition opens', () => {
    const first = WORLDS[0].audition!.exerciseIds[0];
    const row = auditionRow(first);
    const s = snap([row, rangeFinderSung()]);
    expect(s.levels[LEVEL_REFS.rangeFinder]).toMatchObject({ status: 'passed', viaAudition: false, attempts: 1 });
    const through = ordered(WORLDS[0]).findIndex((l) => l.id === WORLDS[0].audition!.unlockThrough[0]);
    ordered(WORLDS[0]).forEach((l, idx) => {
      if (idx > 0 && idx <= through) expect(s.levels[l.id], l.id).toMatchObject({ status: 'passed', viaAudition: true });
    });
    expect(auditionRequirementHint('foundations', snap([rangeFinderSung()]), WORLDS)).toBeNull();
    expect(nextAuditionExercise('foundations', snap([rangeFinderSung()]), WORLDS)).toBe(first);
    expect(isExerciseOpenable(first, snap([rangeFinderSung()]), WORLDS)).toBe(true);
  });

  it('passing every audition in every world without ever singing the Range finder grants nothing at all', () => {
    const all = TRAINING.flatMap((w) => (w.audition?.exerciseIds ?? []).map((exerciseId) => auditionRow(exerciseId)));
    const s = snap(all);
    expect(s.worldsUnlocked).toEqual(['foundations']);
    expect(Object.values(s.levels).filter((l) => l.status === 'passed')).toEqual([]);
    expect(s.levels[LEVEL_REFS.rangeFinder].status).toBe('current');
    expect(s.features).toEqual(['live.basic', 'export']);
  });
});

describe('the daily workout on the real catalog', () => {
  const BUDGETS: WorkoutMinutes[] = [5, 10, 20];
  const plan = (attempts: AttemptRecord[], minutes: WorkoutMinutes) => {
    const snapshot = snap(attempts);
    return { snapshot, workout: buildDailyWorkout({ minutes, snapshot, worlds: WORLDS, attempts, now: NOW, getExercise }) };
  };

  it('has real take lengths for every level of the catalog (nothing zero, nothing huge)', () => {
    for (const l of ALL_LEVELS) {
      const sec = estimateTakeSeconds(getExercise(l.exerciseId));
      expect(sec, l.id).toBeGreaterThan(3);
      expect(sec, l.id).toBeLessThan(300);
    }
  });

  it('is locked until the first level is passed', () => {
    for (const minutes of BUDGETS) expect(plan([], minutes).workout.locked).toBe(true);
  });

  it('after only the Range finder offers the next level and the routines, not the range finder again', () => {
    for (const minutes of BUDGETS) {
      const { workout } = plan(playThrough('foundations.01'), minutes);
      const levels = workout.items.filter((i) => i.source === 'level').map((i) => i.levelId);
      expect(levels).toEqual(['foundations.02']);
      expect(workout.items[0].exerciseId).toBe(WARM_UP_ROUTINE_ID);
      expect(workout.items[workout.items.length - 1].exerciseId).toBe(COOL_DOWN_ROUTINE_ID);
    }
  });

  it('at every point of the game: only unlocked content, no bosses, never a measurement, always within budget', () => {
    for (const level of ALL_LEVELS) {
      const attempts = playThrough(level.id);
      for (const minutes of BUDGETS) {
        const { snapshot, workout } = plan(attempts, minutes);
        expect(workout.locked).toBe(false);
        expect(workout.totalEstSeconds).toBeLessThanOrEqual(minutes * 60);
        expect(workout.items.length).toBeGreaterThanOrEqual(2); // at least the routines
        for (const it of workout.items) {
          expect(isExerciseOpenable(it.exerciseId, snapshot, WORLDS), `${level.id}: ${it.exerciseId}`).toBe(true);
          if (it.source === 'level') {
            const lvl = getLevel(it.levelId!)!;
            expect(lvl.kind).toBe('level');
            expect(['range-finder', 'boss-recital', 'audition']).not.toContain(getExercise(lvl.exerciseId)!.kind);
            expect(isFeatureUnlocked('daily-workout', snapshot)).toBe(true);
          }
        }
      }
    }
  });

  it('fills longer budgets: 10 and 20 minute workouts use most of their time once there is material', () => {
    const attempts = playThrough('foundations.09');
    for (const minutes of [10, 20] as const) {
      const { workout } = plan(attempts, minutes);
      expect(workout.totalEstSeconds, `${minutes} min`).toBeGreaterThanOrEqual(minutes * 60 * 0.7);
    }
  });

  it('works in the world the singer is in once Vibrato opens, and reviews older skills', () => {
    const { workout } = plan(playThrough('vibrato.02'), 20);
    const world = workout.items.filter((i) => i.stage === 'world-item');
    expect(world[0]).toMatchObject({ levelId: 'vibrato.03', reason: 'current-level', worldId: 'vibrato' });
    expect(world.every((i) => i.worldId === 'vibrato')).toBe(true);
    expect(workout.items.filter((i) => i.stage === 'review')).toHaveLength(1);
  });
});
