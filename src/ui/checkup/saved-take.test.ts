/**
 * A check-up task's saved take read back for the pitch lines: the pitch line from storage, the notes it was sung against
 * (rebuilt in the key and at the tempo it was sung), and the cracks found again. A take that is gone or unreadable is a
 * plain sentence, never a throw.
 */
import { describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../../config';
import { getExercise, realize } from '../../exercises';
import { GOOD_SINGER, singTake } from '../../exercises/test-singer';
import { jargonIn } from '../../coaching/plain';
import type { AttemptRecord, TakeRecord, VocalRange } from '../../storage/schema';
import { encodeTrack } from '../../storage/track-codec';
import { attemptAt, takeRecord } from '../progress/test-fixtures';
import { NOT_READABLE, NOT_SAVED, NOT_SUNG, loadSavedTake, type SavedTakeSources } from './saved-take';

const RANGE: VocalRange = { comfortable: { low: 47, high: 69 }, extended: { low: 45, high: 72 }, measuredAt: '2026-10-21T09:00:00.000Z' };
const SLIDE = 'foundations.audition.2';

/** The slide task sung by the synthetic singer (voice breaks at the given take times), as the attempt and take the runner would write. */
function sungSlide(breaks: readonly number[] = []): { attempt: AttemptRecord; record: TakeRecord; sources: SavedTakeSources } {
  const def = getExercise(SLIDE);
  if (!def) throw new Error('no slide');
  const realized = realize(def, RANGE, 'tenor', { bpm: def.tempoBpm });
  const track = singTake(realized, { ...GOOD_SINGER, breaks });
  const attempt: AttemptRecord = {
    ...attemptAt('foundations.02'),
    kind: 'audition',
    exerciseId: SLIDE,
    levelId: null,
    takeId: 'take-1',
    tonicMidi: realized.tonicMidi,
    tempoBpm: realized.bpm,
    checkupId: 'c1',
  };
  const record = takeRecord({ id: 'take-1', exerciseId: SLIDE, track: encodeTrack(track) });
  const get = vi.fn(async (id: string) => (id === 'take-1' ? record : undefined));
  return { attempt, record, sources: { takes: { get }, profile: { range: RANGE, voiceType: 'tenor' }, vibratoStyle: 'pop' } };
}

describe('loadSavedTake', () => {
  it('reads the pitch line back with the notes it was sung against and the tolerance of the exercise', async () => {
    const { attempt, sources } = sungSlide();
    const state = await loadSavedTake(attempt, sources);
    expect(state.status).toBe('ready');
    if (state.status !== 'ready') return;
    const def = getExercise(SLIDE)!;
    const realized = realize(def, RANGE, 'tenor', { bpm: def.tempoBpm });
    expect(state.take.track.length).toBeGreaterThan(100);
    expect(state.take.notes).toEqual(realized.notes);
    expect(state.take.totalSec).toBeCloseTo(realized.totalSec, 6);
    expect(state.take.toleranceCents).toBe(CONFIG.tolerance[def.tolerance]);
    expect(state.take.cracks).toEqual([]);
  });

  it('draws the targets in the key the take was sung in, even if the saved range has moved since', async () => {
    const { attempt, sources } = sungSlide();
    const sungFirst = (await loadSavedTake(attempt, sources)) as Extract<Awaited<ReturnType<typeof loadSavedTake>>, { status: 'ready' }>;
    const moved: VocalRange = { ...RANGE, comfortable: { low: 52, high: 74 }, extended: { low: 50, high: 77 } };
    const later = (await loadSavedTake(attempt, { ...sources, profile: { range: moved, voiceType: 'tenor' } })) as typeof sungFirst;
    expect(later.take.notes.map((n) => n.midi)).toEqual(sungFirst.take.notes.map((n) => n.midi));
  });

  it('finds the cracks again, for the markers on the replay', async () => {
    const { attempt, sources } = sungSlide([2.0]);
    const state = await loadSavedTake(attempt, sources);
    expect(state.status).toBe('ready');
    if (state.status === 'ready') expect(state.take.cracks.length).toBeGreaterThanOrEqual(1);
  });

  it('says plainly when the task was not sung, or its take was not saved', async () => {
    const { attempt, sources } = sungSlide();
    expect(await loadSavedTake(undefined, sources)).toEqual({ status: 'missing', message: NOT_SUNG });
    expect(await loadSavedTake({ ...attempt, takeId: null }, sources)).toEqual({ status: 'missing', message: NOT_SAVED });
    expect(await loadSavedTake(attempt, { ...sources, takes: null })).toEqual({ status: 'missing', message: NOT_SAVED });
    expect(await loadSavedTake({ ...attempt, takeId: 'gone' }, sources)).toEqual({ status: 'missing', message: NOT_SAVED });
  });

  it('says plainly when the take cannot be read, and never throws', async () => {
    const { attempt, sources } = sungSlide();
    const broken = { get: vi.fn(async () => Promise.reject(new Error('disk'))) };
    expect(await loadSavedTake(attempt, { ...sources, takes: broken })).toEqual({ status: 'missing', message: NOT_READABLE });
    const garbage = { get: vi.fn(async () => takeRecord({ id: 'take-1', track: { frameRate: 93.75, t0: 0, midi: '!!', rmsDb: '', confidence: '', voiced: '' } })) };
    expect(await loadSavedTake(attempt, { ...sources, takes: garbage })).toEqual({ status: 'missing', message: NOT_READABLE });
    expect(await loadSavedTake({ ...attempt, exerciseId: 'no.such.exercise' }, sources)).toEqual({ status: 'missing', message: NOT_READABLE });
  });

  it('still draws the line when there is no profile range to realize from (the key it was sung in decides the bars)', async () => {
    const { attempt, sources } = sungSlide();
    const state = await loadSavedTake(attempt, { ...sources, profile: null });
    expect(state.status).toBe('ready');
    if (state.status === 'ready') expect(state.take.notes[0].midi).toBe(getExercise(SLIDE) ? realize(getExercise(SLIDE)!, RANGE, 'tenor', { bpm: 60 }).notes[0].midi : -1);
  });

  it('uses plain words for every message', () => {
    for (const m of [NOT_SUNG, NOT_SAVED, NOT_READABLE]) {
      expect(jargonIn(m)).toEqual([]);
      expect(m.endsWith('.')).toBe(true);
    }
  });
});
