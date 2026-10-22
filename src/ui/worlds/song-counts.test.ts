import { describe, expect, it } from 'vitest';
import { WORLDS } from '../../exercises';
import { songCounts } from './song-counts';
import { snapshotOf, songEntry } from './test-support';

const LIBRARY = [songEntry('twinkle', 'foundations'), songEntry('amazing-grace', 'vibrato'), songEntry('ave-maria', 'runs')];

describe('songCounts', () => {
  it('counts every song locked before any Boss Recital is passed', () => {
    expect(songCounts(LIBRARY, snapshotOf(null), WORLDS)).toEqual({ open: 0, locked: 3 });
  });

  it('opens a song with the Boss Recital of the world its difficulty needs', () => {
    expect(songCounts(LIBRARY, snapshotOf('foundations.boss'), WORLDS)).toEqual({ open: 1, locked: 2 });
    expect(songCounts(LIBRARY, snapshotOf('vibrato.boss'), WORLDS)).toEqual({ open: 2, locked: 1 });
  });

  it('is empty for an empty library', () => {
    expect(songCounts([], snapshotOf('foundations.boss'), WORLDS)).toEqual({ open: 0, locked: 0 });
  });
});
