import { describe, expect, it } from 'vitest';
import { foldIntoRange, rangeFit, suggestTransposition, transposeOctaves, transposeSong, transposeSongToRange } from './transpose';
import type { Song, SongNote } from './types';
import type { VocalRange } from '../storage/schema';

function makeSong(midis: number[], types: SongNote['type'][] = []): Song {
  const notes: SongNote[] = midis.map((midi, i) => ({ start: i, duration: 0.8, midi, lyric: `w${i}`, type: types[i] ?? 'normal' }));
  const pitched = midis.filter((_, i) => (types[i] ?? 'normal') === 'normal');
  return {
    id: 's',
    title: 'S',
    artist: '',
    source: 'bundled',
    bpm: 100,
    notes,
    phrases: [{ start: 0, end: midis.length, from: 0, to: midis.length }],
    offsetMs: 250,
    backingRef: null,
    difficulty: {
      lowestMidi: Math.min(...pitched),
      highestMidi: Math.max(...pitched),
      rangeSemitones: Math.max(...pitched) - Math.min(...pitched),
      maxLeapSemitones: 4,
      notesPerSec: 1,
      melismaRate: 0,
      longNoteRatio: 0.2,
      requiredWorld: 'vibrato',
    },
  };
}

const range = (cLow: number, cHigh: number, eLow: number, eHigh: number): VocalRange => ({
  comfortable: { low: cLow, high: cHigh },
  extended: { low: eLow, high: eHigh },
  measuredAt: '2026-10-21T00:00:00.000Z',
});
/** C3-C5 comfortable, A2-E5 extended. */
const TENOR = range(48, 72, 45, 76);
/** G2-G4 comfortable, E2-B4 extended. */
const BARITONE = range(43, 67, 40, 71);
/** C3-E4 comfortable (an untrained male voice). */
const BEGINNER = range(48, 64, 45, 69);

const span = (s: Song, shift = 0): [number, number] => {
  const m = s.notes.map((n) => n.midi + shift);
  return [Math.min(...m), Math.max(...m)];
};

describe('transposeSong', () => {
  it('shifts every pitch and the pitch fields of the difficulty, and nothing else', () => {
    const s = makeSong([60, 64, 67]);
    const t = transposeSong(s, 5);
    expect(t.notes.map((n) => n.midi)).toEqual([65, 69, 72]);
    expect(t.difficulty.lowestMidi).toBe(65);
    expect(t.difficulty.highestMidi).toBe(72);
    expect(t.difficulty.rangeSemitones).toBe(7);
    expect(t.difficulty.requiredWorld).toBe('vibrato'); // a key never changes what must be earned
    expect(t.difficulty.maxLeapSemitones).toBe(4);
    expect(t.notes.map((n) => [n.start, n.duration, n.lyric, n.type])).toEqual(s.notes.map((n) => [n.start, n.duration, n.lyric, n.type]));
    expect(t.phrases).toEqual(s.phrases);
    expect(t.offsetMs).toBe(250);
    expect(t.id).toBe('s');
  });

  it('is pure: the original is untouched and the copy shares nothing mutable', () => {
    const s = makeSong([60, 62]);
    const t = transposeSong(s, -2);
    expect(s.notes.map((n) => n.midi)).toEqual([60, 62]);
    t.notes[0].midi = 1;
    t.phrases[0].end = 99;
    t.difficulty.lowestMidi = 0;
    expect(s.notes[0].midi).toBe(60);
    expect(s.phrases[0].end).toBe(2);
    expect(s.difficulty.lowestMidi).toBe(60);
    const same = transposeSong(s, 0);
    expect(same).toEqual(s);
    expect(same.notes[0]).not.toBe(s.notes[0]);
  });

  it('accepts fractional semitones (tuning) and rejects non-finite ones', () => {
    expect(transposeSong(makeSong([60]), 0.5).notes[0].midi).toBe(60.5);
    expect(() => transposeSong(makeSong([60]), NaN)).toThrow(RangeError);
    expect(() => transposeSong(makeSong([60]), Infinity)).toThrow(RangeError);
  });
});

describe('transposeOctaves', () => {
  it('moves by whole octaves, up and down', () => {
    expect(transposeOctaves(makeSong([60, 64]), 1).notes.map((n) => n.midi)).toEqual([72, 76]);
    expect(transposeOctaves(makeSong([60, 64]), -2).notes.map((n) => n.midi)).toEqual([36, 40]);
    expect(transposeOctaves(makeSong([60]), 0).notes[0].midi).toBe(60);
    expect(transposeOctaves(makeSong([60]), 1.4).notes[0].midi).toBe(72); // rounds to a whole octave
  });
});

describe('suggestTransposition', () => {
  it('centres a melody that fits, with no shift when it is already centred', () => {
    expect(suggestTransposition(makeSong([56, 60, 64]), TENOR)).toBe(0);
    const high = makeSong([72, 76, 79]); // a soprano chart
    const shift = suggestTransposition(high, TENOR);
    const [lo, hi] = span(high, shift);
    expect(lo).toBeGreaterThanOrEqual(TENOR.comfortable.low);
    expect(hi).toBeLessThanOrEqual(TENOR.comfortable.high);
  });

  it('fits any melody no wider than the comfortable range inside it (seeded fuzz)', () => {
    let s = 99;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (const r of [TENOR, BARITONE, BEGINNER]) {
      const width = r.comfortable.high - r.comfortable.low;
      for (let i = 0; i < 100; i++) {
        const lo = 30 + Math.floor(rnd() * 40);
        const w = Math.floor(rnd() * (width + 1));
        const song = makeSong([lo, lo + w, lo + Math.floor(w / 2)]);
        const [a, b] = span(song, suggestTransposition(song, r));
        expect(a).toBeGreaterThanOrEqual(r.comfortable.low);
        expect(b).toBeLessThanOrEqual(r.comfortable.high);
      }
    }
  });

  it('keeps a melody wider than the comfortable range inside the EXTENDED range when it can', () => {
    const wide = makeSong([50, 64, 78]); // 28 semitones: wider than C3-C5 (24) but inside A2-E5 (31)
    const shift = suggestTransposition(wide, TENOR);
    const [lo, hi] = span(wide, shift);
    expect(lo).toBeGreaterThanOrEqual(TENOR.extended.low);
    expect(hi).toBeLessThanOrEqual(TENOR.extended.high);
  });

  it('still returns a whole-semitone shift for a melody wider than everything', () => {
    const huge = makeSong([30, 90]);
    const shift = suggestTransposition(huge, TENOR);
    expect(Number.isInteger(shift)).toBe(true);
    expect(span(huge, shift)[1]).toBeLessThanOrEqual(TENOR.comfortable.high); // favours keeping the top in range
  });

  it('returns 0 for a song without notes and for a range without usable bounds', () => {
    expect(suggestTransposition({ ...makeSong([60]), notes: [] }, TENOR)).toBe(0);
    const nonsense = { ...TENOR, comfortable: { low: NaN, high: 1 }, extended: { low: 90, high: 10 } };
    expect(suggestTransposition(makeSong([60]), nonsense)).toBe(0);
  });

  it('falls back to whichever range is usable', () => {
    const onlyExtended = { ...TENOR, comfortable: { low: 70, high: 60 } };
    const song = makeSong([56, 60, 64]);
    const [lo, hi] = span(song, suggestTransposition(song, onlyExtended));
    expect(lo).toBeGreaterThanOrEqual(TENOR.extended.low);
    expect(hi).toBeLessThanOrEqual(TENOR.extended.high);
  });

  it('ignores freestyle and rap pitches when fitting', () => {
    const plain = makeSong([56, 60, 64]);
    const withRap = makeSong([56, 60, 64, 100], ['normal', 'normal', 'normal', 'rap']);
    expect(suggestTransposition(withRap, TENOR)).toBe(suggestTransposition(plain, TENOR));
  });

  it('puts tenor and baritone on different shifts for the same chart', () => {
    const chart = makeSong([60, 64, 67, 72]);
    expect(suggestTransposition(chart, BARITONE)).toBeLessThan(suggestTransposition(chart, TENOR));
  });
});

describe('transposeSongToRange and rangeFit', () => {
  it('transposeSongToRange is transposeSong by the suggested shift', () => {
    const song = makeSong([60, 64, 67]);
    expect(transposeSongToRange(song, BARITONE)).toEqual(transposeSong(song, suggestTransposition(song, BARITONE)));
  });

  it('keeps every note inside the detector range E2-C6 for tenor and baritone alike', () => {
    for (const r of [TENOR, BARITONE, BEGINNER]) {
      for (const base of [[36, 60], [55, 79], [60, 84], [67, 91]]) {
        const song = makeSong([base[0], (base[0] + base[1]) / 2 | 0, base[1]]);
        const out = transposeSongToRange(song, r);
        const [lo, hi] = span(out);
        expect(lo).toBeGreaterThanOrEqual(40);
        expect(hi).toBeLessThanOrEqual(84);
      }
    }
  });

  it('reports how well a transposed song sits in the singer\'s range', () => {
    const song = makeSong([50, 60, 70, 80]);
    const fit = rangeFit(song, TENOR, 0);
    expect(fit).toEqual({ shift: 0, lowest: 50, highest: 80, outsideComfortable: 1, outsideExtended: 1, total: 4 });
    const auto = rangeFit(song, TENOR);
    expect(auto.shift).toBe(suggestTransposition(song, TENOR));
    expect(auto.lowest).toBe(50 + auto.shift);
  });

  it('rangeFit on an empty song or an unusable range is all zeros', () => {
    const empty = { ...makeSong([60]), notes: [] };
    expect(rangeFit(empty, TENOR)).toMatchObject({ lowest: 0, highest: 0, outsideComfortable: 0, outsideExtended: 0, total: 0 });
    const nonsense = { ...TENOR, comfortable: { low: 5, high: 1 }, extended: { low: 5, high: 1 } };
    expect(rangeFit(makeSong([60]), nonsense)).toMatchObject({ outsideComfortable: 0, outsideExtended: 0, total: 1 });
  });
});

describe('foldIntoRange', () => {
  it('leaves a pitch already inside alone and moves others by whole octaves', () => {
    const r = { low: 48, high: 72 };
    expect(foldIntoRange(60, r)).toBe(60);
    expect(foldIntoRange(48, r)).toBe(48);
    expect(foldIntoRange(72, r)).toBe(72);
    expect(foldIntoRange(84, r)).toBe(72);
    expect(foldIntoRange(88, r)).toBe(64);
    expect(foldIntoRange(30, r)).toBe(54);
    expect(foldIntoRange(36, r)).toBe(48);
  });

  it('returns the pitch unchanged when no octave of it fits or the input is unusable', () => {
    expect(foldIntoRange(70, { low: 60, high: 63 })).toBe(70); // a range narrower than an octave with no 70-class pitch inside
    expect(foldIntoRange(NaN, { low: 48, high: 72 })).toBeNaN();
    expect(foldIntoRange(60, { low: 72, high: 48 })).toBe(60);
  });

  it('works for a narrow range that does contain the pitch class', () => {
    expect(foldIntoRange(70, { low: 57, high: 60 })).toBe(58);
  });
});
