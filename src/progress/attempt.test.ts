import { describe, expect, it } from 'vitest';
import { computeSnapshot } from './engine';
import { buildAttempt, buildSongAttempt, songExerciseId, type AttemptInput } from './attempt';
import { COOL_DOWN_ROUTINE, WARM_UP_ROUTINE } from './routines';
import { P1, bossLevel, exerciseDef, level, world } from './test-fixtures';

const REALIZED = { tonicMidi: 57, bpm: 60, countInSec: 2, totalSec: 14 };
const GOOD = { score: 0.93, passed: true, mastery: 3 as const };
const LEVEL = level('foundations', 3, 'Sustain I');
const DEF = exerciseDef(LEVEL.exerciseId, { tempoBpm: 60 });

const input = (over: Partial<AttemptInput> = {}): AttemptInput => ({
  profileId: P1,
  def: DEF,
  source: { type: 'level', level: LEVEL },
  realized: REALIZED,
  evaluation: GOOD,
  metrics: { 'accuracy.inTolerancePct': 97 },
  ...over,
});

describe('buildAttempt: the kind and level id of each kind of take', () => {
  it('a practice rep is kind practice with its level', () => {
    expect(buildAttempt(input())).toMatchObject({ kind: 'practice', levelId: LEVEL.id, exerciseId: DEF.id, profileId: P1 });
  });

  it('a Boss Recital is kind boss: the level says it is one', () => {
    const boss = bossLevel('foundations', 10);
    const out = buildAttempt(input({ def: exerciseDef(boss.exerciseId), source: { type: 'level', level: boss } }));
    expect(out).toMatchObject({ kind: 'boss', levelId: boss.id });
  });

  it('a personal-record attempt and a workout level carry the level too', () => {
    expect(buildAttempt(input({ source: { type: 'record', level: LEVEL } }))).toMatchObject({ kind: 'record', levelId: LEVEL.id });
    expect(buildAttempt(input({ source: { type: 'workout-level', level: LEVEL } }))).toMatchObject({ kind: 'workout', levelId: LEVEL.id });
  });

  it('a warm-up or cool-down is a workout take with NO level, so it can never pass or unlock anything', () => {
    for (const routine of [WARM_UP_ROUTINE, COOL_DOWN_ROUTINE]) {
      const out = buildAttempt(input({ def: routine, source: { type: 'workout-routine' } }));
      expect(out).toMatchObject({ kind: 'workout', levelId: null, exerciseId: routine.id });
    }
  });

  it('an audition test is filed under the audition exercise with no level', () => {
    const audition = exerciseDef('foundations.audition.2', { kind: 'audition' });
    expect(buildAttempt(input({ def: audition, source: { type: 'audition' } }))).toMatchObject({ kind: 'audition', levelId: null, exerciseId: 'foundations.audition.2' });
  });

  it('refuses a take that contradicts its source (a wrong exercise for the level, a non-routine as a routine)', () => {
    expect(() => buildAttempt(input({ def: exerciseDef('foundations.04.ex') }))).toThrow(/foundations.03/);
    expect(() => buildAttempt(input({ source: { type: 'workout-routine' } }))).toThrow(/routine/);
  });
});

describe('buildAttempt: what is recorded about the take', () => {
  it('copies the score, metrics and take id, and records the tonic, tempo and a duration that counts the count-in', () => {
    const out = buildAttempt(input({ takeId: 'take-1' }));
    expect(out).toMatchObject({
      score: 0.93,
      passed: true,
      mastery: 3,
      metrics: { 'accuracy.inTolerancePct': 97 },
      tonicMidi: 57,
      tempoBpm: 60,
      durationSec: 16,
      takeId: 'take-1',
    });
    expect(buildAttempt(input()).takeId).toBeNull();
  });

  it('a failed take is not passed and shows no tally lights, whatever mastery the evaluation carried', () => {
    const out = buildAttempt(input({ evaluation: { score: 0.4, passed: false, mastery: 2 } }));
    expect(out).toMatchObject({ passed: false, mastery: 0, score: 0.4 });
  });

  it('a take whose realization was folded by octaves is never written as passed, even from a runner that skipped the check in evaluate()', () => {
    // evaluate(def, metrics, analysis) refuses such a take; this is the second line (a good evaluation, a folded realization).
    const folded = buildAttempt(input({ realized: { ...REALIZED, fit: 'folded' } }));
    expect(folded).toMatchObject({ passed: false, mastery: 0, score: 0.93 });
    for (const fit of ['fits', 'extended'] as const) expect(buildAttempt(input({ realized: { ...REALIZED, fit } })), fit).toMatchObject({ passed: true, mastery: 3 });
  });
});

describe('buildAttempt: a tempo ladder passes only at its pass tempo', () => {
  const ladder = exerciseDef('runs.03.ex', { kind: 'run', tempoBpm: 90, tempoLadder: [45, 68, 90] });
  const runLevel = level('runs', 3, 'Pentatonic five, down');
  const at = (bpm: number) => buildAttempt(input({ def: ladder, source: { type: 'level', level: runLevel }, realized: { ...REALIZED, bpm } }));

  it('writes a lower rung as practice even though it was sung perfectly', () => {
    for (const rung of [45, 68]) expect(at(rung), `rung ${rung}`).toMatchObject({ passed: false, mastery: 0, tempoBpm: rung, score: 0.93 });
  });

  it('counts the pass tempo', () => {
    expect(at(90)).toMatchObject({ passed: true, mastery: 3, tempoBpm: 90 });
  });

  it('and the progression engine would not count a lower rung either, even from a runner that forgot', () => {
    const worlds = [world('runs', 'Runs', [runLevel, bossLevel('runs', 9)], null)];
    const getExercise = (id: string) => (id === ladder.id ? ladder : undefined);
    const row = (bpm: number) => ({ ...at(bpm), passed: true, id: `a-${bpm}`, createdAt: '2026-03-01T10:00:00.000Z', updatedAt: `u-${bpm}`, deletedAt: null });
    expect(computeSnapshot(P1, worlds, [row(45)], new Date('2026-03-02T00:00:00Z'), { getExercise }).levels['runs.03'].status).toBe('current');
    expect(computeSnapshot(P1, worlds, [row(90)], new Date('2026-03-02T00:00:00Z'), { getExercise }).levels['runs.03'].status).toBe('passed');
  });
});

describe('buildSongAttempt', () => {
  it('files a song take under the song, with no level and no tally lights', () => {
    const out = buildSongAttempt({
      profileId: P1,
      songId: 'amazing-grace',
      score: 0.81,
      passed: true,
      metrics: { 'song.phraseScore': 0.81, 'song.inTolerancePct': 78 },
      durationSec: 70,
      tonicMidi: 55,
    });
    expect(out).toEqual({
      profileId: P1,
      exerciseId: songExerciseId('amazing-grace'),
      levelId: null,
      kind: 'song',
      score: 0.81,
      passed: true,
      mastery: 0,
      metrics: { 'song.phraseScore': 0.81, 'song.inTolerancePct': 78 },
      durationSec: 70,
      tonicMidi: 55,
      tempoBpm: null,
      takeId: null,
      songId: 'amazing-grace',
    });
    expect(songExerciseId('amazing-grace')).toBe('song.amazing-grace');
  });
});
