/**
 * "Last time": the latest take of an exercise, read back and coached before the next try. A saved pitch line is
 * re-analyzed (spots and all); without one the attempt's metrics still give the advice.
 */
import { describe, expect, it, vi } from 'vitest';
import { getExercise, getLevel } from '../exercises';
import { unvoiced } from '../exercises/test-singer';
import type { TakeRecord } from '../storage/schema';
import { encodeTrack } from '../storage/track-codec';
import { lastTakeMissed, lastTimeCoaching, latestTake, type LastTimeSources } from './last-time';
import { attemptOf, sing, TEST_RANGE, type SungTake } from './test-takes';

function stored(take: SungTake, id: string): TakeRecord {
  return {
    id,
    profileId: 'singer-1',
    createdAt: '2026-10-22T12:00:00.000Z',
    updatedAt: '2026-10-22T12:00:00.000Z',
    deletedAt: null,
    exerciseId: take.def.id,
    track: encodeTrack(take.track),
    audioRef: null,
    sampleRate: 48000,
    latencyMs: 0,
  };
}

function sources(take: SungTake, log: LastTimeSources['log'], records: TakeRecord[] = []): LastTimeSources {
  return {
    def: take.def,
    log,
    profile: { range: TEST_RANGE, voiceType: 'tenor' },
    takes: { get: vi.fn(async (id: string) => records.find((r) => r.id === id)) },
    notation: 'sharps',
    vibratoStyle: 'pop',
    isLevelPassed: () => false,
    now: Date.parse('2026-10-22T18:00:00.000Z'),
  };
}

const MISS = sing('foundations.05', { breaks: [1.8, 2.5] , biasCents: -60 });
const PASS = sing('foundations.05');

describe('latestTake and lastTakeMissed', () => {
  it('finds the newest live take of the exercise and whether it missed', () => {
    const a = attemptOf(MISS);
    const b = attemptOf(PASS);
    const other = attemptOf(null, { exerciseId: 'foundations.sustain.1' });
    expect(latestTake(MISS.def.id, [a, b, other])?.id).toBe(b.id);
    expect(lastTakeMissed(MISS.def, [a, b, other])).toBe(false);
    expect(lastTakeMissed(MISS.def, [b, a, other])).toBe(true);
    expect(lastTakeMissed(MISS.def, [b, a, { ...attemptOf(MISS), deletedAt: '2026-10-22T13:00:00.000Z' }])).toBe(true);
    expect(lastTakeMissed(MISS.def, [other])).toBe(false);
  });

  it('does not call a lower rung that passed its own rule a miss', () => {
    const def = getExercise(getLevel('runs.03')!.exerciseId)!;
    const rung = sing('runs.03', {}, { bpm: def.tempoLadder![0] });
    expect(lastTakeMissed(def, [attemptOf(rung)])).toBe(false);
    expect(lastTakeMissed(def, [attemptOf(sing('runs.03', { offsetSemis: 1 }))])).toBe(true);
  });
});

describe('lastTimeCoaching', () => {
  it('re-analyzes the saved take: the problem is placed, and the depth counts the misses in a row', async () => {
    expect(MISS.evaluation.passed).toBe(false);
    const log = [attemptOf(MISS), attemptOf(MISS, { takeId: 'take-1' })];
    const src = sources(MISS, log, [stored(MISS, 'take-1')]);
    const c = await lastTimeCoaching(src);
    expect(c).not.toBeNull();
    expect(src.takes!.get).toHaveBeenCalledWith('take-1');
    expect(c!.depth).toBe(2);
    expect(c!.missesInARow).toBe(2);
    expect(c!.passed).toBe(false);
    expect(c!.problem.tipId).toBe(MISS.tip.id);
    expect(c!.problem.spots.length).toBeGreaterThan(0);
  });

  it('coaches from the attempt’s metrics when the pitch line was not saved', async () => {
    const log = [attemptOf(MISS, { takeId: 'gone' })];
    const c = await lastTimeCoaching(sources(MISS, log));
    expect(c).not.toBeNull();
    expect(c!.depth).toBe(1);
    expect(c!.problem.spots).toEqual([]);
    expect(c!.problem.what.length).toBeGreaterThan(0);
  });

  it('still advises when storage is closed or the take cannot be read', async () => {
    const log = [attemptOf(MISS, { takeId: 'take-1' })];
    expect(await lastTimeCoaching({ ...sources(MISS, log), takes: null })).not.toBeNull();
    const broken = { ...sources(MISS, log), takes: { get: vi.fn(async () => Promise.reject(new Error('locked'))) } };
    expect(await lastTimeCoaching(broken)).not.toBeNull();
  });

  it('has nothing to say before the first take, or after a pass', async () => {
    expect(await lastTimeCoaching(sources(MISS, []))).toBeNull();
    expect(await lastTimeCoaching(sources(PASS, [attemptOf(MISS), attemptOf(PASS)]))).toBeNull();
  });

  it('calls a take the log says missed, but that measures clean when read back, stopped', async () => {
    const stoppedLate = sing('foundations.03', {}, { edit: (t, r) => unvoiced(t, r.totalSec - 0.4, 99) });
    const row = attemptOf(stoppedLate, { passed: false, mastery: 0, takeId: 'late' });
    const c = await lastTimeCoaching(sources(stoppedLate, [row], [stored(stoppedLate, 'late')]));
    expect(c?.problem.tipId).toBe('general.stopped');
  });
});
