import { describe, expect, it } from 'vitest';
import { computeSnapshot } from './engine';
import { COOL_DOWN_ROUTINE_ID, WARM_UP_ROUTINE_ID } from './routines';
import { P1, attempt, audition, bossLevel, fixtureWorlds, level, levelProgress, pass, passAudition, passAuditions, passThrough, world } from './test-fixtures';
import type { FeatureId, ProgressSnapshot } from './types';
import {
  FEATURES,
  FEATURE_IDS,
  LEVEL_REFS,
  auditionRequirementHint,
  bossLevelOf,
  continueLevel,
  currentLevelOf,
  currentWorldOf,
  isAuditionAvailable,
  isExerciseOpenable,
  isFeatureUnlocked,
  isKnownFeature,
  isLevelOpenable,
  isRecordAttemptAllowed,
  isSongUnlocked,
  isWorldUnlocked,
  levelRequirementHint,
  levelStatus,
  nextAuditionExercise,
  requirementHint,
  songRequirementHint,
  unlockedFeatures,
  worldRequirementHint,
} from './unlocks';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const worlds = fixtureWorlds();
const upTo = (levelId: string): ProgressSnapshot => computeSnapshot(P1, worlds, passThrough(worlds, levelId), NOW);
const fresh = (): ProgressSnapshot => computeSnapshot(P1, worlds, [], NOW);

/** The compiler fails this literal when a FeatureId is added without updating the tests. */
const ALL_FEATURES: Record<FeatureId, true> = {
  'live.basic': true,
  'live.cracks': true,
  'live.onset': true,
  'live.vibrato': true,
  'tool.vibrato-meter': true,
  'setting.vibratoStyle': true,
  'dashboard': true,
  'daily-workout': true,
  'song-stage': true,
  'song.import': true,
  'records': true,
  'export': true,
};

describe('FEATURES registry', () => {
  it('has a requirement for every feature id, with a one-line hint', () => {
    expect([...FEATURE_IDS].sort()).toEqual((Object.keys(ALL_FEATURES) as FeatureId[]).sort());
    for (const id of FEATURE_IDS) {
      const { hint } = FEATURES[id];
      expect(hint.length).toBeGreaterThan(10);
      expect(hint).not.toMatch(/\n/);
      expect(hint.endsWith('.')).toBe(true);
      expect(requirementHint(id)).toBe(hint);
    }
  });

  it('encodes the SPEC §11.2 unlock map', () => {
    expect(LEVEL_REFS.rangeFinder).toBe('foundations.01'); // Foundations L1 (Range finder): the first level, sung before any audition
    expect(FEATURES['live.basic'].kind).toBe('start');
    expect(FEATURES['export'].kind).toBe('start');
    expect(FEATURES['live.cracks']).toMatchObject({ kind: 'levelPassed', ref: LEVEL_REFS.sirens });
    expect(FEATURES['live.onset']).toMatchObject({ kind: 'levelPassed', ref: LEVEL_REFS.crispness });
    for (const id of ['live.vibrato', 'tool.vibrato-meter', 'setting.vibratoStyle'] as const) expect(FEATURES[id]).toMatchObject({ kind: 'worldUnlocked', ref: 'vibrato' });
    for (const id of ['dashboard', 'daily-workout', 'records'] as const) {
      expect(FEATURES[id].kind).toBe('levelPassed');
      expect(FEATURES[id].ref).toBeUndefined(); // no ref = "any level passed"
    }
    for (const id of ['song-stage', 'song.import'] as const) expect(FEATURES[id]).toMatchObject({ kind: 'levelPassed', ref: LEVEL_REFS.foundationsBoss });
  });

  it('names the thing to pass in each hint', () => {
    expect(FEATURES['live.cracks'].hint).toContain('Sirens & glides');
    expect(FEATURES['live.onset'].hint).toContain('Crispness');
    for (const id of ['live.vibrato', 'tool.vibrato-meter', 'setting.vibratoStyle', 'song-stage', 'song.import'] as const) expect(FEATURES[id].hint).toContain('Foundations Boss Recital');
    expect(FEATURES['dashboard'].hint).toContain('first level');
  });

  it('treats an unknown id as locked, with a neutral hint', () => {
    const bogus = 'secret.admin' as FeatureId;
    expect(isKnownFeature(bogus)).toBe(false);
    expect(isKnownFeature('dashboard')).toBe(true);
    expect(isFeatureUnlocked(bogus, upTo('foundations.boss'))).toBe(false);
    expect(requirementHint(bogus)).toBe('Not available.');
    expect(isKnownFeature('toString')).toBe(false);
    expect(isKnownFeature('__proto__')).toBe(false);
  });
});

describe('isFeatureUnlocked along the Foundations line', () => {
  const open = (s: ProgressSnapshot) => unlockedFeatures(s);

  it('starts with only the basics and the export utility', () => {
    expect(open(fresh())).toEqual(['live.basic', 'export']);
  });

  it('opens the dashboard, daily workout and records after the first level', () => {
    expect(open(upTo('foundations.01'))).toEqual(['live.basic', 'dashboard', 'daily-workout', 'records', 'export']);
  });

  it('opens crack markers after Sirens & glides and settle readouts after Crispness, not before', () => {
    expect(isFeatureUnlocked('live.cracks', upTo('foundations.04'))).toBe(false);
    expect(isFeatureUnlocked('live.cracks', upTo('foundations.05'))).toBe(true);
    expect(isFeatureUnlocked('live.onset', upTo('foundations.05'))).toBe(false);
    expect(isFeatureUnlocked('live.onset', upTo('foundations.06'))).toBe(true);
  });

  it('keeps vibrato readouts, the meter, the style setting, Song Stage and import shut until the Foundations boss', () => {
    const before = upTo('foundations.09');
    const after = upTo('foundations.boss');
    for (const id of ['live.vibrato', 'tool.vibrato-meter', 'setting.vibratoStyle', 'song-stage', 'song.import'] as const) {
      expect(isFeatureUnlocked(id, before)).toBe(false);
      expect(isFeatureUnlocked(id, after)).toBe(true);
    }
  });

  it('is reached by an audition too: a level granted by audition counts as passed', () => {
    const s = computeSnapshot(P1, worlds, [pass('foundations.01'), ...passAuditions('foundations', 2)], NOW);
    expect(isFeatureUnlocked('live.cracks', s)).toBe(true);
    expect(isFeatureUnlocked('dashboard', s)).toBe(true);
    expect(isFeatureUnlocked('live.onset', s)).toBe(false);
  });

  it('is not reached by the audition test that judges Sirens alone, nor by any audition without the Range finder sung', () => {
    const lone = computeSnapshot(P1, worlds, [pass('foundations.01'), passAudition('foundations', 2)], NOW);
    expect(isFeatureUnlocked('live.cracks', lone)).toBe(false);
    const unsung = computeSnapshot(P1, worlds, passAuditions('foundations', 4), NOW);
    expect(unlockedFeatures(unsung)).toEqual(['live.basic', 'export']);
  });

  it('fails closed on a snapshot that does not mention the level', () => {
    const empty: ProgressSnapshot = { ...fresh(), levels: {}, worldsUnlocked: [] };
    expect(unlockedFeatures(empty)).toEqual(['live.basic', 'export']);
  });
});

describe('levels', () => {
  it('reports unknown levels as locked and not openable (a deep link to a made-up id)', () => {
    const s = fresh();
    expect(levelStatus('nope', s)).toBe('locked');
    expect(isLevelOpenable('nope', s)).toBe(false);
    expect(isLevelOpenable('__proto__', s)).toBe(false);
  });

  it('opens a level iff it is current or passed, never while locked', () => {
    const s = upTo('foundations.02');
    expect(isLevelOpenable('foundations.01', s)).toBe(true); // passed: replay allowed
    expect(isLevelOpenable('foundations.03', s)).toBe(true); // current
    expect(isLevelOpenable('foundations.04', s)).toBe(false);
    expect(isLevelOpenable('foundations.boss', s)).toBe(false);
    expect(isLevelOpenable('vibrato.01', s)).toBe(false);
    expect(isLevelOpenable('inflections.01', s)).toBe(false);
  });

  it('cannot open a locked world level even by hand-building a snapshot entry that says passed elsewhere', () => {
    const s = { ...fresh(), levels: { x: levelProgress({ levelId: 'x', status: 'locked' }) } };
    expect(isLevelOpenable('x', s)).toBe(false);
  });

  it('knows which worlds are open', () => {
    const s = upTo('foundations.boss');
    expect(isWorldUnlocked('vibrato', s)).toBe(true);
    expect(isWorldUnlocked('inflections', s)).toBe(false);
  });
});

describe('current world and "Continue"', () => {
  it('starts at the first level of Foundations', () => {
    expect(currentWorldOf(fresh(), worlds)?.id).toBe('foundations');
    expect(currentLevelOf('foundations', fresh(), worlds)?.id).toBe('foundations.01');
    expect(continueLevel(fresh(), worlds)?.id).toBe('foundations.01');
  });

  it('follows the frontier across a Boss Recital into the next world', () => {
    expect(continueLevel(upTo('foundations.04'), worlds)?.id).toBe('foundations.05');
    expect(continueLevel(upTo('foundations.09'), worlds)?.id).toBe('foundations.boss');
    expect(continueLevel(upTo('foundations.boss'), worlds)?.id).toBe('vibrato.01');
    expect(currentWorldOf(upTo('foundations.boss'), worlds)?.id).toBe('vibrato');
  });

  it('prefers the furthest world when two have a level in progress (a level added behind the singer)', () => {
    const s = upTo('foundations.boss');
    const anomalous: ProgressSnapshot = { ...s, levels: { ...s.levels, 'foundations.03': levelProgress({ levelId: 'foundations.03', status: 'current' }) } };
    expect(currentWorldOf(anomalous, worlds)?.id).toBe('vibrato');
  });

  it('has nowhere to continue once everything is passed, but still names the last world', () => {
    const done = upTo('inflections.boss');
    expect(continueLevel(done, worlds)).toBeNull();
    expect(currentWorldOf(done, worlds)?.id).toBe('inflections'); // song-stage has no levels, so it never counts
    expect(currentLevelOf('inflections', done, worlds)).toBeNull();
  });

  it('knows nothing about closed or unknown worlds', () => {
    expect(currentLevelOf('vibrato', fresh(), worlds)).toBeNull();
    expect(currentLevelOf('nowhere' as never, fresh(), worlds)).toBeNull();
    expect(currentWorldOf(fresh(), [])).toBeNull();
  });
});

describe('bossLevelOf', () => {
  it('finds the boss level, wherever it sits, and null when a world has none', () => {
    expect(bossLevelOf(worlds, 'foundations')?.id).toBe('foundations.boss');
    expect(bossLevelOf(worlds, 'song-stage')).toBeNull();
    expect(bossLevelOf(worlds, 'dynamics')).toBeNull();
    const odd = world('runs', 'Runs', [bossLevel('runs', 1), level('runs', 2, 'late')], null);
    expect(bossLevelOf([odd], 'runs')?.id).toBe('runs.boss');
  });
});

describe('isSongUnlocked', () => {
  it('needs the REQUIRED world\'s Boss Recital passed, not merely that world reachable', () => {
    expect(isSongUnlocked('foundations', fresh(), worlds)).toBe(false);
    expect(isSongUnlocked('foundations', upTo('foundations.09'), worlds)).toBe(false);
    const bossed = upTo('foundations.boss');
    expect(isSongUnlocked('foundations', bossed, worlds)).toBe(true);
    expect(isSongUnlocked('vibrato', bossed, worlds)).toBe(false); // reachable, boss not yet passed
    expect(isSongUnlocked('vibrato', upTo('vibrato.boss'), worlds)).toBe(true);
    expect(isSongUnlocked('inflections', upTo('vibrato.boss'), worlds)).toBe(false);
  });

  it('is locked for an unknown world, and a world without a boss counts once it is open', () => {
    expect(isSongUnlocked('dynamics', upTo('foundations.boss'), worlds)).toBe(false);
    expect(isSongUnlocked('song-stage', fresh(), worlds)).toBe(false);
    expect(isSongUnlocked('song-stage', upTo('foundations.boss'), worlds)).toBe(true);
  });
});

describe('isAuditionAvailable', () => {
  it('needs the world open and something left for the audition to unlock', () => {
    expect(isAuditionAvailable('foundations', upTo('foundations.01'), worlds)).toBe(true);
    expect(isAuditionAvailable('vibrato', fresh(), worlds)).toBe(false); // closed world
    expect(isAuditionAvailable('inflections', upTo('vibrato.boss'), worlds)).toBe(false); // no audition defined
    expect(isAuditionAvailable('nowhere' as never, fresh(), worlds)).toBe(false);
  });

  it('stops being offered once everything it could unlock is passed', () => {
    expect(isAuditionAvailable('foundations', upTo('foundations.08'), worlds)).toBe(true); // 09 still open to it
    expect(isAuditionAvailable('foundations', upTo('foundations.09'), worlds)).toBe(false);
    expect(isAuditionAvailable('vibrato', upTo('foundations.boss'), worlds)).toBe(true);
    expect(isAuditionAvailable('vibrato', upTo('vibrato.03'), worlds)).toBe(false);
  });

  it('waits for the Range finder to be sung: an audition can neither skip it nor come before it', () => {
    expect(isAuditionAvailable('foundations', fresh(), worlds)).toBe(false);
    expect(isAuditionAvailable('foundations', upTo('foundations.01'), worlds)).toBe(true);
    // Even a lot of audition passes (a forged or imported log) do not make it available, or pass the Range finder.
    expect(isAuditionAvailable('foundations', computeSnapshot(P1, worlds, passAuditions('foundations', 4), NOW), worlds)).toBe(false);
  });

  it('counts only a Range finder that was SUNG, and fails closed when the snapshot does not mention it', () => {
    const sung = upTo('foundations.01');
    const lp = sung.levels['foundations.01'];
    const granted: ProgressSnapshot = { ...sung, levels: { ...sung.levels, 'foundations.01': { ...lp, viaAudition: true } } };
    expect(isAuditionAvailable('foundations', granted, worlds)).toBe(false);
    expect(nextAuditionExercise('foundations', granted, worlds)).toBeNull();
    const current: ProgressSnapshot = { ...sung, levels: { ...sung.levels, 'foundations.01': { ...lp, status: 'current' } } };
    expect(isAuditionAvailable('foundations', current, worlds)).toBe(false);
    const without = { ...sung.levels };
    delete without['foundations.01'];
    expect(isAuditionAvailable('foundations', { ...sung, levels: without }, worlds)).toBe(false);
  });

  it('only the world that holds the Range finder waits for it', () => {
    const plain = world('vibrato', 'Vibrato', [level('vibrato', 1, 'a'), level('vibrato', 2, 'b'), bossLevel('vibrato', 3)], null, audition('vibrato', 1, ['vibrato.02']));
    expect(isAuditionAvailable('vibrato', computeSnapshot(P1, [plain], [], NOW), [plain])).toBe(true); // no Range finder to wait for
    // A (hand-built) snapshot with Vibrato open but the Range finder not sung: Foundations waits, Vibrato does not care.
    const open = upTo('foundations.boss');
    const odd: ProgressSnapshot = { ...open, levels: { ...open.levels, 'foundations.01': { ...open.levels['foundations.01'], status: 'current' } } };
    expect(isAuditionAvailable('foundations', odd, worlds)).toBe(false);
    expect(isAuditionAvailable('vibrato', odd, worlds)).toBe(true);
  });
});

describe('nextAuditionExercise', () => {
  it('starts at the first test, once the Range finder is sung, and moves on as the levels it reaches are passed', () => {
    expect(nextAuditionExercise('foundations', fresh(), worlds)).toBeNull(); // the Range finder comes first
    expect(nextAuditionExercise('foundations', upTo('foundations.01'), worlds)).toBe('foundations.audition.1');
    expect(nextAuditionExercise('foundations', upTo('foundations.03'), worlds)).toBe('foundations.audition.1'); // 04 still open to test 1
    expect(nextAuditionExercise('foundations', upTo('foundations.04'), worlds)).toBe('foundations.audition.2');
    expect(nextAuditionExercise('foundations', upTo('foundations.07'), worlds)).toBe('foundations.audition.3');
    expect(nextAuditionExercise('foundations', upTo('foundations.08'), worlds)).toBe('foundations.audition.4');
    expect(nextAuditionExercise('foundations', upTo('foundations.09'), worlds)).toBeNull();
  });

  it('follows what the audition granted: a passed test 1 moves the run on to test 2', () => {
    const range = pass('foundations.01');
    const afterTest1 = computeSnapshot(P1, worlds, [range, ...passAuditions('foundations', 1)], NOW);
    expect(levelStatus('foundations.04', afterTest1)).toBe('passed');
    expect(nextAuditionExercise('foundations', afterTest1, worlds)).toBe('foundations.audition.2');
    const afterTest3 = computeSnapshot(P1, worlds, [range, ...passAuditions('foundations', 3)], NOW);
    expect(nextAuditionExercise('foundations', afterTest3, worlds)).toBe('foundations.audition.4');
    const done = computeSnapshot(P1, worlds, [range, ...passAuditions('foundations', 4)], NOW);
    expect(nextAuditionExercise('foundations', done, worlds)).toBeNull(); // the boss is never the audition's to grant
  });

  it('keeps offering a test after a miss (retake it), and never skips ahead past one that was not passed', () => {
    const range = pass('foundations.01');
    const missed = attempt({ kind: 'audition', exerciseId: 'foundations.audition.2', levelId: null, passed: false });
    const afterMiss = computeSnapshot(P1, worlds, [range, ...passAuditions('foundations', 1), missed], NOW);
    expect(nextAuditionExercise('foundations', afterMiss, worlds)).toBe('foundations.audition.2');
    // A test 3 row with test 2 never passed (a forged or out-of-order log) leaves the run where it is.
    const outOfOrder = computeSnapshot(P1, worlds, [range, ...passAuditions('foundations', 1), passAudition('foundations', 3)], NOW);
    expect(nextAuditionExercise('foundations', outOfOrder, worlds)).toBe('foundations.audition.2');
  });

  it('is the next test by what is passed, however it was passed: levels sung by hand close tests too', () => {
    expect(nextAuditionExercise('foundations', upTo('foundations.05'), worlds)).toBe('foundations.audition.3'); // 01-05 sung: tests 1 and 2 have nothing left
    expect(nextAuditionExercise('vibrato', upTo('foundations.boss'), worlds)).toBe('vibrato.audition.1');
    expect(nextAuditionExercise('vibrato', upTo('vibrato.02'), worlds)).toBe('vibrato.audition.2');
  });

  it('is null for a closed world, a world without an audition, and an unknown world', () => {
    expect(nextAuditionExercise('vibrato', fresh(), worlds)).toBeNull();
    expect(nextAuditionExercise('inflections', upTo('vibrato.boss'), worlds)).toBeNull();
    expect(nextAuditionExercise('nowhere' as never, fresh(), worlds)).toBeNull();
  });

  it('never offers a test that reaches nothing new (an unknown level, or one not past the earlier tests), and holds a boss-pointing test short of the boss', () => {
    const odd = (through: string[]) => {
      const w = world('vibrato', 'V', [level('vibrato', 1, 'a'), level('vibrato', 2, 'b'), level('vibrato', 3, 'c'), bossLevel('vibrato', 4)], null, audition('vibrato', through.length, through));
      return { w, s: computeSnapshot(P1, [w], [], NOW) };
    };
    for (const [through, expected] of [
      [['vibrato.02', 'no.such.level', 'vibrato.03'], 'vibrato.audition.1'],
      [['no.such.level'], null],
      [['vibrato.03', 'vibrato.01'], 'vibrato.audition.1'], // test 2 reaches less than test 1
    ] as const) {
      const { w, s } = odd([...through]);
      expect(nextAuditionExercise('vibrato', s, [w]), through.join()).toBe(expected);
    }
    // After test 1 is done, the non-rising test 2 is never the next one, so nothing is offered.
    const { w } = odd(['vibrato.03', 'vibrato.01']);
    const after = computeSnapshot(P1, [w], [passAudition('vibrato', 1)], NOW);
    expect(nextAuditionExercise('vibrato', after, [w])).toBeNull();
    // A test pointing at the boss is held short of it: it can still grant the levels before it, never the boss itself.
    const toBoss = world('vibrato', 'V', [level('vibrato', 1, 'a'), level('vibrato', 2, 'b'), bossLevel('vibrato', 3)], null, audition('vibrato', 1, ['vibrato.boss']));
    expect(nextAuditionExercise('vibrato', computeSnapshot(P1, [toBoss], [], NOW), [toBoss])).toBe('vibrato.audition.1');
    expect(nextAuditionExercise('vibrato', computeSnapshot(P1, [toBoss], [pass('vibrato.01'), pass('vibrato.02')], NOW), [toBoss])).toBeNull();
  });

  it('agrees with isAuditionAvailable at every step of the game', () => {
    const steps: ProgressSnapshot[] = [fresh()];
    for (const w of worlds) for (const level of w.levels) steps.push(upTo(level.id));
    for (const [i, s] of steps.entries()) {
      for (const world of worlds) expect(nextAuditionExercise(world.id, s, worlds) !== null, `${world.id} at step ${i}`).toBe(isAuditionAvailable(world.id, s, worlds));
    }
  });
});

describe('isExerciseOpenable', () => {
  const s = upTo('foundations.02');

  it('opens a level exercise exactly when its level is current or passed', () => {
    expect(isExerciseOpenable('foundations.01.ex', s, worlds)).toBe(true);
    expect(isExerciseOpenable('foundations.03.ex', s, worlds)).toBe(true);
    expect(isExerciseOpenable('foundations.04.ex', s, worlds)).toBe(false);
    expect(isExerciseOpenable('vibrato.01.ex', s, worlds)).toBe(false);
    expect(isExerciseOpenable('foundations.boss.ex', s, worlds)).toBe(false);
  });

  it('opens an audition exercise only while it is the audition\'s NEXT test', () => {
    expect(isExerciseOpenable('foundations.audition.1', s, worlds)).toBe(true);
    for (const n of [2, 3, 4]) expect(isExerciseOpenable(`foundations.audition.${n}`, s, worlds), `test ${n} is not next`).toBe(false);
    expect(isExerciseOpenable('vibrato.audition.1', s, worlds)).toBe(false);
    expect(isExerciseOpenable('foundations.audition.1', upTo('foundations.09'), worlds)).toBe(false);
    for (const n of [1, 2, 3, 4]) expect(isExerciseOpenable(`foundations.audition.${n}`, upTo('foundations.09'), worlds)).toBe(false);
  });

  it('walks the audition one test at a time: a miss keeps the test open, a pass closes it and opens the next', () => {
    const range = pass('foundations.01');
    const missed = (n: number) => attempt({ kind: 'audition', exerciseId: `foundations.audition.${n}`, levelId: null, passed: false });
    const open = (log: ReturnType<typeof pass>[]) => {
      const snap = computeSnapshot(P1, worlds, log, NOW);
      return [1, 2, 3, 4].filter((n) => isExerciseOpenable(`foundations.audition.${n}`, snap, worlds));
    };
    expect(open([])).toEqual([]); // the Range finder comes first
    expect(open([range])).toEqual([1]);
    expect(open([range, missed(1)])).toEqual([1]);
    expect(open([range, ...passAuditions('foundations', 1)])).toEqual([2]);
    expect(open([range, ...passAuditions('foundations', 1), missed(2)])).toEqual([2]);
    expect(open([range, ...passAuditions('foundations', 2)])).toEqual([3]);
    expect(open([range, ...passAuditions('foundations', 3)])).toEqual([4]);
    expect(open([range, ...passAuditions('foundations', 4)])).toEqual([]); // nothing left for it to grant
  });

  it('refuses a deep link to a later test: one short test cannot pass the skills of the levels before it', () => {
    const range = pass('foundations.01');
    const afterRange = computeSnapshot(P1, worlds, [range], NOW);
    for (const n of [2, 3, 4]) {
      expect(isExerciseOpenable(`foundations.audition.${n}`, afterRange, worlds), `test ${n} right after the Range finder`).toBe(false);
      // ...and a pass row for it (however it got there) neither opens it nor moves the run on.
      const forged = computeSnapshot(P1, worlds, [range, passAudition('foundations', n)], NOW);
      expect(isExerciseOpenable('foundations.audition.1', forged, worlds)).toBe(true);
      expect(isExerciseOpenable(`foundations.audition.${n}`, forged, worlds)).toBe(false);
    }
  });

  it('keeps the Foundations audition shut until the Range finder is sung, then opens its first test', () => {
    expect(isExerciseOpenable('foundations.audition.1', fresh(), worlds)).toBe(false);
    expect(isExerciseOpenable('foundations.audition.1', upTo('foundations.01'), worlds)).toBe(true);
    // The other worlds' tests are unaffected by it: they open as soon as their world is open.
    expect(isExerciseOpenable('vibrato.audition.1', upTo('foundations.boss'), worlds)).toBe(true);
    expect(isExerciseOpenable('vibrato.audition.2', upTo('foundations.boss'), worlds)).toBe(false);
  });

  it('opens the built-in routines with the daily-workout feature, and nothing unknown', () => {
    expect(isExerciseOpenable(WARM_UP_ROUTINE_ID, fresh(), worlds)).toBe(false);
    for (const id of [WARM_UP_ROUTINE_ID, COOL_DOWN_ROUTINE_ID]) expect(isExerciseOpenable(id, upTo('foundations.01'), worlds)).toBe(true);
    expect(isExerciseOpenable('imported.pack.x', upTo('foundations.boss'), worlds)).toBe(false);
    expect(isExerciseOpenable('', upTo('foundations.boss'), worlds)).toBe(false);
  });
});

describe('isRecordAttemptAllowed', () => {
  it('allows record attempts only on an exercise that has been passed', () => {
    const s = upTo('foundations.02');
    expect(isRecordAttemptAllowed('foundations.02.ex', s, worlds)).toBe(true);
    expect(isRecordAttemptAllowed('foundations.03.ex', s, worlds)).toBe(false); // current, not yet passed
    expect(isRecordAttemptAllowed('foundations.04.ex', s, worlds)).toBe(false);
    expect(isRecordAttemptAllowed('unknown', s, worlds)).toBe(false);
  });

  it('never on the Range finder, passed or not: a wider span is a strained one, not a record', () => {
    expect(LEVEL_REFS.rangeFinder).toBe('foundations.01');
    expect(isRecordAttemptAllowed('foundations.01.ex', upTo('foundations.boss'), worlds)).toBe(false);
  });
});

describe('requirement lines for locked tiles', () => {
  it('names the level right before a locked one inside an open world: passing it is what opens it', () => {
    const s = upTo('foundations.03'); // current: Sustain II
    expect(levelRequirementHint('foundations.05', s, worlds)).toBe('Pass Sustain II to unlock.');
    expect(levelRequirementHint('foundations.06', s, worlds)).toBe('Pass Sirens & glides to unlock.');
    expect(levelRequirementHint('foundations.boss', s, worlds)).toBe('Pass Legato lines to unlock.');
    const atBoss = upTo('foundations.09');
    expect(levelRequirementHint('vibrato.01', atBoss, worlds)).toBe('Pass the Foundations Boss Recital to unlock Vibrato.');
  });

  it('names the boss in the hint when the boss is the blocker', () => {
    const s = upTo('vibrato.03');
    expect(levelRequirementHint('inflections.01', s, worlds)).toBe('Pass the Vibrato Boss Recital to unlock Inflections.');
  });

  it('is null for an openable or unknown level', () => {
    const s = upTo('foundations.02');
    expect(levelRequirementHint('foundations.01', s, worlds)).toBeNull();
    expect(levelRequirementHint('foundations.03', s, worlds)).toBeNull();
    expect(levelRequirementHint('nope', s, worlds)).toBeNull();
  });

  it('describes how to open each world', () => {
    expect(worldRequirementHint('vibrato', fresh(), worlds)).toBe('Pass the Foundations Boss Recital to unlock Vibrato.');
    expect(worldRequirementHint('inflections', upTo('foundations.boss'), worlds)).toBe('Pass the Vibrato Boss Recital to unlock Inflections.');
    expect(worldRequirementHint('song-stage', fresh(), worlds)).toBe('Pass the Foundations Boss Recital to unlock Song Stage.');
    expect(worldRequirementHint('vibrato', upTo('foundations.boss'), worlds)).toBeNull();
    expect(worldRequirementHint('foundations', fresh(), worlds)).toBeNull(); // open from the start
    expect(worldRequirementHint('nowhere' as never, fresh(), worlds)).toBeNull();
  });

  it('describes how to open a song', () => {
    expect(songRequirementHint('foundations', fresh(), worlds)).toBe('Pass the Foundations Boss Recital to unlock this song.');
    expect(songRequirementHint('vibrato', upTo('foundations.boss'), worlds)).toBe('Pass the Vibrato Boss Recital to unlock this song.');
    expect(songRequirementHint('foundations', upTo('foundations.boss'), worlds)).toBeNull();
    expect(songRequirementHint('song-stage', fresh(), worlds)).toBe('Pass the Foundations Boss Recital to unlock Song Stage.');
    expect(songRequirementHint('dynamics', fresh(), worlds)).toBe('Not available yet.');
  });

  it('describes why an audition is locked: the Range finder first, or the world that has not opened', () => {
    expect(auditionRequirementHint('foundations', fresh(), worlds)).toBe('Pass Range finder to unlock the audition.');
    expect(auditionRequirementHint('vibrato', fresh(), worlds)).toBe('Pass the Foundations Boss Recital to unlock Vibrato.');
    expect(auditionRequirementHint('foundations', upTo('foundations.01'), worlds)).toBeNull(); // can be taken now
    expect(auditionRequirementHint('foundations', upTo('foundations.09'), worlds)).toBeNull(); // nothing left to unlock
    expect(auditionRequirementHint('vibrato', upTo('foundations.boss'), worlds)).toBeNull();
    expect(auditionRequirementHint('inflections', upTo('vibrato.boss'), worlds)).toBeNull(); // no audition at all
    expect(auditionRequirementHint('nowhere' as never, fresh(), worlds)).toBeNull();
  });

  it('only gives an audition hint while the audition is actually locked', () => {
    const steps: ProgressSnapshot[] = [fresh()];
    for (const w of worlds) for (const l of w.levels) steps.push(upTo(l.id));
    for (const [i, s] of steps.entries()) {
      for (const w of worlds) {
        const hint = auditionRequirementHint(w.id, s, worlds);
        if (hint !== null) expect(isAuditionAvailable(w.id, s, worlds), `${w.id} at step ${i}`).toBe(false);
        if (isAuditionAvailable(w.id, s, worlds)) expect(hint, `${w.id} at step ${i}`).toBeNull();
        if (hint !== null) expect(hint).toMatch(/^Pass .+ to unlock.*\.$/);
      }
    }
  });
});
