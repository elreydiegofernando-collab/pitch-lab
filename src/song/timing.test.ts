import { describe, expect, it } from 'vitest';
import { backingTimeAt, phraseIndexAt, songDurationSec, songTimeAtBacking } from './timing';
import { parseUltraStar } from './ultrastar';
import type { Song } from './types';

function song(offsetMs: number, phrases: Array<[number, number]> = [], noteEnds: number[] = []): Song {
  return {
    id: 's',
    title: 's',
    artist: '',
    source: 'ultrastar',
    bpm: 100,
    notes: noteEnds.map((end, i) => ({ start: i, duration: end - i, midi: 60, lyric: '', type: 'normal' as const })),
    phrases: phrases.map(([start, end], i) => ({ start, end, from: i, to: i + 1 })),
    offsetMs,
    backingRef: null,
    difficulty: { lowestMidi: 60, highestMidi: 60, rangeSemitones: 0, maxLeapSemitones: 0, notesPerSec: 0, melismaRate: 0, longNoteRatio: 0, requiredWorld: 'foundations' },
  };
}

describe('backing-track timing', () => {
  it('backing position = song time + offset: an UltraStar #GAP of 2 s means beat 0 sits 2 s into the audio', () => {
    const { song: s } = parseUltraStar(`#BPM:120\n#GAP:2000\n: 0 4 0 a\nE\n`);
    expect(s.offsetMs).toBe(2000);
    expect(backingTimeAt(s, 0)).toBe(2); // start the audio at its 2 s mark when the notes start...
    expect(backingTimeAt(s, 1.5)).toBe(3.5);
    expect(backingTimeAt(s, -2)).toBe(0); // ...or start it 2 s before song time 0 and play from the top
  });

  it('a negative offset means the audio starts after song time 0', () => {
    expect(backingTimeAt(song(-500), 0)).toBe(-0.5);
    expect(backingTimeAt(song(-500), 1)).toBe(0.5);
  });

  it('the two conversions are inverses', () => {
    const s = song(1234.5);
    for (const t of [-3, 0, 0.25, 17.125]) expect(songTimeAtBacking(s, backingTimeAt(s, t))).toBeCloseTo(t, 12);
  });

  it('a larger offset makes the backing play EARLIER against the notes (raise it when the audio sounds late)', () => {
    expect(backingTimeAt(song(300), 1)).toBeGreaterThan(backingTimeAt(song(100), 1));
  });
});

describe('songDurationSec', () => {
  it('is the end of the last note, even when an earlier note runs longer', () => {
    expect(songDurationSec(song(0, [], [1, 7, 3]))).toBe(7);
    expect(songDurationSec(song(0))).toBe(0);
  });
});

describe('phraseIndexAt', () => {
  const s = song(0, [[1, 3], [5, 7], [9, 12]]);

  it('finds the phrase being sung', () => {
    expect(phraseIndexAt(s, 1)).toBe(0);
    expect(phraseIndexAt(s, 2.9)).toBe(0);
    expect(phraseIndexAt(s, 5)).toBe(1);
    expect(phraseIndexAt(s, 12)).toBe(2);
  });

  it('during a rest, or before the start, names the NEXT phrase', () => {
    expect(phraseIndexAt(s, 0)).toBe(0);
    expect(phraseIndexAt(s, 4)).toBe(1);
    expect(phraseIndexAt(s, 8.5)).toBe(2);
  });

  it('is -1 once the last phrase has ended, and for a song with no phrases', () => {
    expect(phraseIndexAt(s, 12.01)).toBe(-1);
    expect(phraseIndexAt(song(0), 1)).toBe(-1);
  });
});
