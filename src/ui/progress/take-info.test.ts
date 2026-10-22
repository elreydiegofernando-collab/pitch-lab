import { describe, expect, it } from 'vitest';
import { takeFileName, takeSeconds, takeTitle } from './take-info';
import { takeRecord } from './test-fixtures';

describe('take length', () => {
  it('counts frames from the stored pitch array without decoding it', () => {
    const take = takeRecord({ id: 't1' });
    expect(takeSeconds(take.track)).toBeCloseTo(188 / 93.75, 6);
  });

  it('reads padding, and an empty track is zero long', () => {
    // 8 bytes (2 frames) = "AAAAAAAAAAA=" (12 chars, one pad).
    expect(takeSeconds({ frameRate: 100, t0: 0, midi: 'AAAAAAAAAAA=', rmsDb: '', confidence: '', voiced: '' })).toBeCloseTo(0.02, 9);
    expect(takeSeconds({ frameRate: 93.75, t0: 0, midi: '', rmsDb: '', confidence: '', voiced: '' })).toBe(0);
  });
});

describe('takeTitle', () => {
  it('names a catalog exercise, a built-in routine and an audition test', () => {
    expect(takeTitle('foundations.sustain.1')).toBe('Sustain I');
    expect(takeTitle('routine.warm-up')).toBe('Warm-up sirens');
    expect(takeTitle('foundations.audition.2')).toBe('Audition: siren');
  });

  it('names a song take after its song, and falls back to plain words', () => {
    expect(takeTitle('song.amazing-grace', (id) => (id === 'amazing-grace' ? 'Amazing Grace' : undefined))).toBe('Amazing Grace');
    expect(takeTitle('song.unknown')).toBe('Song take');
    expect(takeTitle('mystery')).toBe('Practice take');
  });
});

describe('takeFileName', () => {
  it('is pitch-lab-take-<date>.wav, dated by the singer\'s own day', () => {
    const local = new Date(2026, 9, 21, 20, 30, 0);
    expect(takeFileName({ createdAt: local.toISOString() })).toBe('pitch-lab-take-2026-10-21.wav');
  });
});
