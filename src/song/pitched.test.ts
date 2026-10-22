import { describe, expect, it } from 'vitest';
import { isPitchedNote, pitchedView } from './pitched';
import type { Song, SongNote } from './types';

const n = (start: number, type: SongNote['type'], lyric: string, midi = 60): SongNote => ({ start, duration: 0.5, midi, lyric, type });

function song(notes: SongNote[], phrases: Array<[number, number]>): Song {
  return {
    id: 's',
    title: 's',
    artist: '',
    source: 'ultrastar',
    bpm: 100,
    notes,
    phrases: phrases.map(([from, to]) => ({ start: notes[from]?.start ?? 0, end: (notes[to - 1]?.start ?? 0) + 0.5, from, to })),
    offsetMs: 0,
    backingRef: null,
    difficulty: { lowestMidi: 60, highestMidi: 60, rangeSemitones: 0, maxLeapSemitones: 0, notesPerSec: 0, melismaRate: 0, longNoteRatio: 0, requiredWorld: 'foundations' },
  };
}

describe('isPitchedNote', () => {
  it('is true for normal and golden notes only', () => {
    expect(isPitchedNote(n(0, 'normal', 'a'))).toBe(true);
    expect(isPitchedNote(n(0, 'golden', 'a'))).toBe(true);
    expect(isPitchedNote(n(0, 'freestyle', 'a'))).toBe(false);
    expect(isPitchedNote(n(0, 'rap', 'a'))).toBe(false);
  });
});

describe('pitchedView', () => {
  it('drops freestyle and rap notes and re-indexes the phrases', () => {
    const s = song(
      [n(0, 'normal', 'a'), n(1, 'rap', 'b'), n(2, 'golden', 'c'), n(3, 'freestyle', 'd'), n(4, 'normal', 'e'), n(5, 'normal', 'f')],
      [[0, 2], [2, 4], [4, 6]],
    );
    const v = pitchedView(s);
    expect(v.notes.map((x) => x.lyric)).toEqual(['a', 'c', 'e', 'f']);
    expect(v.sourceIndex).toEqual([0, 2, 4, 5]);
    expect(v.phrases.map((p) => [p.from, p.to])).toEqual([[0, 1], [1, 2], [2, 4]]);
    // every phrase still brackets exactly its own notes
    for (const p of v.phrases) for (let k = p.from; k < p.to; k++) expect(v.notes[k].start).toBeGreaterThanOrEqual(p.start);
  });

  it('drops a phrase that has no pitched note left', () => {
    const s = song([n(0, 'normal', 'a'), n(1, 'rap', 'b'), n(2, 'rap', 'c'), n(3, 'normal', 'd')], [[0, 1], [1, 3], [3, 4]]);
    expect(pitchedView(s).phrases.map((p) => [p.from, p.to])).toEqual([[0, 1], [1, 2]]);
  });

  it('is the identity for an all-pitched song and never mutates the input', () => {
    const s = song([n(0, 'normal', 'a'), n(1, 'golden', 'b')], [[0, 2]]);
    const before = JSON.stringify(s);
    const v = pitchedView(s);
    expect(v.notes).toEqual(s.notes);
    expect(v.phrases).toEqual(s.phrases);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('copes with an empty song, no phrases, and out-of-range phrase indices', () => {
    expect(pitchedView(song([], []))).toEqual({ notes: [], phrases: [], sourceIndex: [] });
    const noPhrases = song([n(0, 'normal', 'a')], []);
    expect(pitchedView(noPhrases).phrases).toEqual([]);
    const sloppy = song([n(0, 'normal', 'a'), n(1, 'rap', 'b')], [[0, 99]]);
    expect(pitchedView(sloppy).phrases.map((p) => [p.from, p.to])).toEqual([[0, 1]]);
  });
});
