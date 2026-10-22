import { describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import { analyzeSong, rateSong, RATING_RULES } from './difficulty';
import { transposeSong } from './transpose';
import { parseUltraStar } from './ultrastar';
import type { Song, SongNote } from './types';
import type { WorldId } from '../exercises/types';

const RANK: Record<string, number> = { foundations: 0, vibrato: 1, inflections: 2, runs: 3, dynamics: 4 };
const rank = (w: WorldId): number => RANK[w];

const note = (start: number, duration: number, midi: number, lyric = 'la', type: SongNote['type'] = 'normal'): SongNote => ({ start, duration, midi, lyric, type });

function song(notes: SongNote[]): Song {
  return {
    id: 't',
    title: 't',
    artist: '',
    source: 'bundled',
    bpm: 100,
    notes,
    phrases: [],
    offsetMs: 0,
    backingRef: null,
    difficulty: { lowestMidi: 0, highestMidi: 0, rangeSemitones: 0, maxLeapSemitones: 0, notesPerSec: 0, melismaRate: 0, longNoteRatio: 0, requiredWorld: 'foundations' },
  };
}

/** `n` notes `gap` s apart, each `len` s long, cycling `pitches`. */
function steady(n: number, gap: number, len: number, pitches: number[] = [60, 62, 64, 65]): SongNote[] {
  return Array.from({ length: n }, (_, i) => note(i * gap, len, pitches[i % pitches.length]));
}

const worldOf = (notes: SongNote[]): WorldId => rateSong(song(notes)).requiredWorld;
const codes = (notes: SongNote[]): string[] => analyzeSong(song(notes)).reasons.map((r) => r.code);

describe('rateSong: statistics', () => {
  it('rates an empty song as Foundations with zeros and no reasons', () => {
    const a = analyzeSong(song([]));
    expect(a.difficulty).toEqual({ lowestMidi: 0, highestMidi: 0, rangeSemitones: 0, maxLeapSemitones: 0, notesPerSec: 0, melismaRate: 0, longNoteRatio: 0, requiredWorld: 'foundations' });
    expect(a.reasons).toEqual([]);
    expect(a.lyricsAvailable).toBe(false);
  });

  it('reports range and the widest leap', () => {
    const d = rateSong(song([note(0, 0.5, 60), note(1, 0.5, 67), note(2, 0.5, 62)]));
    expect([d.lowestMidi, d.highestMidi, d.rangeSemitones, d.maxLeapSemitones]).toEqual([60, 67, 7, 7]);
  });

  it('ignores freestyle and rap pitches, but rates an all-freestyle chart on its own timing', () => {
    const mixed = rateSong(song([note(0, 0.5, 60), note(1, 0.5, 62), note(2, 0.5, 100, 'x', 'rap'), note(3, 0.5, 20, 'x', 'freestyle')]));
    expect([mixed.lowestMidi, mixed.highestMidi]).toEqual([60, 62]);
    const free = rateSong(song([note(0, 0.5, 30, 'x', 'freestyle'), note(1, 0.5, 40, 'x', 'freestyle')]));
    expect([free.lowestMidi, free.highestMidi]).toEqual([30, 40]);
  });

  it('accepts notes in any order', () => {
    const notes = steady(10, 1, 0.5);
    expect(rateSong(song([...notes].reverse()))).toEqual(rateSong(song(notes)));
  });

  it('counts the share of notes held 1 s or longer', () => {
    const d = rateSong(song([note(0, 1, 60), note(2, 0.99, 62), note(4, 2, 64), note(7, 0.5, 65)]));
    expect(d.longNoteRatio).toBe(0.5);
  });

  it('measures the peak over HALF-OPEN 2 s windows: a steady 4 notes/s is 4.0, not 4.5', () => {
    expect(rateSong(song(steady(17, 0.25, 0.2))).notesPerSec).toBe(4);
    // a burst of five notes in half a second and then nothing: 5 notes in the busiest window
    expect(rateSong(song([...steady(5, 0.125, 0.1), note(30, 0.5, 60)])).notesPerSec).toBe(2.5);
  });

  it('measures melisma density from the lyrics: syllables carrying 3+ notes', () => {
    const lyrics = ['a', '', '', 'b', 'c', '', '', '', ''];
    const a = analyzeSong(song(lyrics.map((l, i) => note(i, 0.5, 60 + i, l))));
    expect(a.lyricsAvailable).toBe(true);
    expect(a.difficulty.melismaRate).toBeCloseTo(2 / 3, 9); // groups: a(3), b(1), c(5): two of three are melismatic
  });

  it('cannot measure melisma without lyrics, and says so', () => {
    const none = analyzeSong(song(steady(10, 1, 0.5).map((n) => ({ ...n, lyric: '' }))));
    expect(none.lyricsAvailable).toBe(false);
    expect(none.difficulty.melismaRate).toBe(0);
    const sparse = analyzeSong(song(steady(10, 1, 0.5).map((n, i) => ({ ...n, lyric: i === 0 ? 'x' : '' }))));
    expect(sparse.lyricsAvailable).toBe(false); // 1 of 10 is below the coverage floor
  });

  it('never mutates its input', () => {
    const notes = Object.freeze(steady(6, 1, 0.5).map((n) => Object.freeze(n))) as SongNote[];
    expect(() => rateSong(song(notes))).not.toThrow();
  });
});

describe('rateSong: world rules', () => {
  it('rates an ordinary hymn-paced tune as Foundations, with nothing to explain', () => {
    const a = analyzeSong(song(steady(24, 0.5, 0.45)));
    expect(a.difficulty.requiredWorld).toBe('foundations');
    expect(a.reasons).toEqual([]);
  });

  it('Vibrato: a third or more of the notes held 1 s or longer', () => {
    const withLong = (longCount: number): SongNote[] => Array.from({ length: 9 }, (_, i) => note(i * 2, i < longCount ? 1.2 : 0.3, 60 + (i % 3)));
    expect(RATING_RULES.sustainedLongNoteShare).toBeCloseTo(1 / 3, 12);
    expect(worldOf(withLong(3))).toBe('vibrato'); // exactly a third
    expect(worldOf(withLong(2))).toBe('foundations');
    expect(codes(withLong(4))).toEqual(['sustained-style']);
  });

  it('Inflections: a leap wider than an octave (an octave is a Foundations drill)', () => {
    const leap = (semis: number): SongNote[] => [note(0, 0.5, 60), note(2, 0.5, 60 + semis), note(4, 0.5, 62)];
    expect(worldOf(leap(RATING_RULES.maxFoundationsLeap))).toBe('foundations');
    const wide = analyzeSong(song(leap(RATING_RULES.maxFoundationsLeap + 1)));
    expect(wide.difficulty.requiredWorld).toBe('inflections');
    expect(wide.reasons[0]).toMatchObject({ code: 'wide-leap', world: 'inflections', atSec: 2 });
    expect(wide.reasons[0].detail).toBe('a leap of 13 semitones near 0:02');
  });

  it('Inflections: a range past the comfortable 16 semitones', () => {
    const climb = (span: number): SongNote[] => Array.from({ length: span + 1 }, (_, i) => note(i, 0.5, 60 + i));
    expect(worldOf(climb(RATING_RULES.wideRangeSemitones - 1))).toBe('foundations');
    const wide = analyzeSong(song(climb(RATING_RULES.wideRangeSemitones)));
    expect(wide.difficulty.requiredWorld).toBe('inflections');
    expect(wide.reasons.map((r) => r.code)).toEqual(['wide-range']);
    expect(wide.reasons[0].detail).toMatch(/range of 17 semitones/);
  });

  it('Runs: a chain of 3+ notes at or above the fast line, wider than an ornament', () => {
    const at = 61; // a minute in
    const run = [note(0, 0.5, 60), ...[60, 62, 64, 65].map((m, i) => note(at + i * 0.2, 0.15, m))];
    const a = analyzeSong(song(run));
    expect(a.difficulty.requiredWorld).toBe('runs');
    expect(a.reasons[0]).toMatchObject({ code: 'fast-run', world: 'runs', atSec: at });
    expect(a.reasons[0].detail).toBe('4 notes in 0.6 s (5.0 notes/s) near 1:01');
  });

  it('the fast line is inclusive and a hair slower is not fast', () => {
    const gap = 1 / RATING_RULES.fastNps;
    const chain = (g: number): SongNote[] => [60, 62, 64, 65].map((m, i) => note(i * g, 0.1, m));
    expect(worldOf(chain(gap))).toBe('runs');
    expect(worldOf(chain(gap + 0.01))).toBe('foundations');
  });

  it('two quick notes are not a chain', () => {
    expect(worldOf([note(0, 0.1, 60), note(0.1, 0.1, 70), note(5, 0.5, 62)])).toBe('foundations');
  });

  it('Inflections: a short, narrow fast figure is an ornament (turns live there); longer or wider is a run', () => {
    const fig = (pitches: number[]): SongNote[] => pitches.map((m, i) => note(i * 0.15, 0.12, m));
    expect(codes(fig([60, 61, 60]))).toEqual(['ornament']);
    expect(worldOf(fig([60, 61, 60]))).toBe('inflections');
    expect(worldOf(fig([60, 62, 60, 62, 60]))).toBe('inflections'); // five notes, a whole tone wide
    expect(worldOf(fig([60, 62, 60, 62, 60, 62]))).toBe('runs'); // six notes: a trill is a run
    expect(worldOf(fig([60, 62, 64]))).toBe('runs'); // three notes but four semitones wide
    expect(worldOf(fig([60, 63, 60]))).toBe('inflections'); // exactly the narrow limit
    expect(worldOf(fig([60, 64, 60]))).toBe('runs');
  });

  it('Runs: a dense passage that is never a single fast chain (4.5 notes/s sustained over 2 s)', () => {
    const dense = (gap: number): SongNote[] => steady(12, gap, 0.1, [60, 62, 64, 65]);
    // 0.24 s apart: slower than the fast chain line but 9 notes in every 2 s
    expect(codes(dense(0.24))).toEqual(['dense-passage']);
    expect(worldOf(dense(0.24))).toBe('runs');
    // steady eighth notes at 120 bpm (4 notes/s) are ordinary singing
    expect(worldOf(dense(0.25))).toBe('foundations');
  });

  it('Runs: melisma-heavy lyrics, but only when there are lyrics to read', () => {
    const lyrics = ['a', '', '', 'b', 'c', '', '', 'd'];
    const notes = (ls: string[]): SongNote[] => ls.map((l, i) => note(i * 1.5, 0.5, 60 + (i % 3), l));
    const heavy = analyzeSong(song(notes(lyrics)));
    expect(heavy.difficulty.requiredWorld).toBe('runs');
    expect(heavy.reasons.map((r) => r.code)).toEqual(['melisma-heavy']);
    expect(heavy.reasons[0].detail).toBe('50% of syllables are sung across 3 or more notes');
    expect(worldOf(notes(lyrics.map(() => '')))).toBe('foundations'); // no lyrics: nothing to prove it
    expect(worldOf(notes(['a', '', '', 'b', 'c', 'd', 'e', 'f']))).toBe('foundations'); // 1 melisma in 6 syllables is 17%
  });

  it('takes the LATEST world when several rules fire, and lists every reason strongest first', () => {
    const notes = [
      ...Array.from({ length: 18 }, (_, i) => note(i * 2, 1.2, 60 + i)), // long notes (vibrato) climbing 17 semitones (inflections)
      ...[77, 75, 73, 72].map((m, i) => note(100 + i * 0.2, 0.15, m)), // and a fast run that starts where the climb ended (no extra leap)
    ];
    const a = analyzeSong(song(notes));
    expect(a.difficulty.requiredWorld).toBe('runs');
    expect(a.reasons.map((r) => r.code)).toEqual(['fast-run', 'wide-range', 'sustained-style']);
    expect(a.reasons.map((r) => r.world)).toEqual(['runs', 'inflections', 'vibrato']);
    expect(a.difficulty.requiredWorld).toBe(a.reasons[0].world);
  });

  it('formats the sustained-style caption', () => {
    const a = analyzeSong(song(Array.from({ length: 9 }, (_, i) => note(i * 2, i < 3 ? 1.2 : 0.3, 60 + (i % 3)))));
    expect(a.reasons[0].detail).toBe('33% of the notes are held 1 s or longer');
  });

  it('is the rating the other helpers rely on: rateSong === analyzeSong().difficulty', () => {
    const s = song(steady(30, 0.2, 0.15, [60, 64, 70, 61]));
    expect(rateSong(s)).toEqual(analyzeSong(s).difficulty);
  });
});

describe('rateSong: one long melisma is Runs technique', () => {
  /** `count` short notes `gap` s apart from `at`; the first carries the syllable `first`, the others continue it. */
  const chain = (at: number, count: number, first = 'Glo', gap = 0.3): SongNote[] =>
    Array.from({ length: count }, (_, i) => note(at + i * gap, 0.2, 60 + (i % 5), i === 0 ? first : ''));
  /** `count` ordinary one-note syllables a second apart from `at`. */
  const plain = (at: number, count = 6): SongNote[] => Array.from({ length: count }, (_, i) => note(at + i, 0.5, 60 + (i % 3)));
  /** Six plain syllables, ONE syllable ("Glo") across `count` notes `gap` s apart from 0:07, then six more plain syllables. */
  const withMelisma = (count: number, gap: number): SongNote[] => [...plain(0), ...chain(7, count, 'Glo', gap), ...plain(7 + count * gap + 1)];

  /**
   * A Gloria-style UltraStar chart: 8 plain syllables (quarter notes), "Glo" sung across 16 consecutive
   * eighth notes (a scale up an octave and back), "ria", then 9 more plain syllables. At #BPM:100 an eighth
   * is 0.3 s (3.3 notes/s). Plain notes are 3 beats long so none reaches a second even at #BPM:60.
   */
  function gloriaChart(bpm: number, withLyrics = true): string {
    const out = [`#BPM:${bpm}`];
    let beat = 0;
    const plain = (pitches: number[]): void => {
      for (const p of pitches) {
        out.push(`: ${beat} 3 ${p} ${withLyrics ? ' la' : '~'}`);
        beat += 4;
      }
    };
    plain([0, 2, 4, 5, 4, 2, 4, 0]);
    [0, 2, 4, 5, 7, 9, 11, 12, 11, 9, 7, 5, 4, 2, 0, 2].forEach((p, i) => {
      out.push(`: ${beat} 2 ${p} ${i === 0 && withLyrics ? 'Glo' : '~'}`);
      beat += 2;
    });
    out.push(`: ${beat} 3 0 ${withLyrics ? ' ria' : '~'}`);
    beat += 4;
    plain([0, 2, 4, 5, 4, 2, 4, 2, 0]);
    out.push('E');
    return out.join('\n') + '\n';
  }

  it('rates a 16-note Gloria melisma at eighth notes of 100 bpm as Runs: no fast chain, dense window or melisma share sees it', () => {
    const { song } = parseUltraStar(gloriaChart(100));
    const a = analyzeSong(song);
    expect(a.lyricsAvailable).toBe(true);
    expect(a.difficulty.notesPerSec).toBe(3.5); // 7 eighths in the busiest 2 s: below the 4.5 "fast" line
    expect(a.difficulty.melismaRate).toBeCloseTo(1 / 19, 9); // one syllable in nineteen carries 3+ notes: below the 25% share
    expect(a.difficulty.requiredWorld).toBe('runs');
    expect(a.reasons.map((r) => r.code)).toEqual(['long-melisma']);
    expect(a.reasons[0]).toMatchObject({ world: 'runs', code: 'long-melisma', detail: 'a 16-note melisma near 0:05' });
    expect(a.reasons[0].atSec).toBeCloseTo(8 * 0.6, 9); // the first of the sixteen notes
    expect(song.difficulty).toEqual(a.difficulty); // the parser stored the real rating
  });

  it('the same sixteen notes at 60 bpm (1 note per half second) stay in Foundations', () => {
    const a = analyzeSong(parseUltraStar(gloriaChart(60)).song);
    expect(a.difficulty.requiredWorld).toBe('foundations');
    expect(a.reasons).toEqual([]);
  });

  it('a chart with no lyric text cannot show a melisma: the documented blind spot stays Foundations', () => {
    const a = analyzeSong(parseUltraStar(gloriaChart(100, false)).song);
    expect(a.lyricsAvailable).toBe(false);
    expect(a.difficulty.melismaRate).toBe(0);
    expect(a.difficulty.requiredWorld).toBe('foundations');
    expect(a.reasons).toEqual([]);
  });

  it('takes its speed from the Runs ladder: the first rung, which is slower than the "fast" line that cannot see it', () => {
    expect(RATING_RULES.longMelismaNps).toBe(CONFIG.runs.tempoLadderNps[0]);
    expect(RATING_RULES.longMelismaNps).toBeLessThan(RATING_RULES.fastNps);
  });

  it('needs six notes in a row: five stay in Foundations, six are Runs', () => {
    expect(RATING_RULES.longMelismaNotes).toBe(6);
    const five = analyzeSong(song(withMelisma(RATING_RULES.longMelismaNotes - 1, 0.3)));
    expect(five.difficulty.requiredWorld).toBe('foundations');
    expect(five.reasons).toEqual([]);
    const six = analyzeSong(song(withMelisma(RATING_RULES.longMelismaNotes, 0.3)));
    expect(six.difficulty.requiredWorld).toBe('runs');
    expect(six.reasons).toMatchObject([{ code: 'long-melisma', world: 'runs', atSec: 7, detail: 'a 6-note melisma near 0:07' }]);
  });

  it('needs onsets at most 1/3 s apart: the line is inclusive and a hair slower is not a run', () => {
    const line = 1 / RATING_RULES.longMelismaNps;
    expect(codes(withMelisma(8, line))).toEqual(['long-melisma']);
    expect(codes(withMelisma(8, line + 0.01))).toEqual([]);
    expect(worldOf(withMelisma(8, line + 0.01))).toBe('foundations');
  });

  it('a held "~" tail or a breath inside the melisma does not dilute it: the quick chain is what counts', () => {
    // 8 quick notes, a 1.5 s breath, 8 more quick notes, all on the one syllable "Glo"
    const breathAt = 7 + 8 * 0.3 + 1.5;
    const a = analyzeSong(song([...plain(0), ...chain(7, 8), ...chain(breathAt, 8, ''), ...plain(20)]));
    expect(a.difficulty.requiredWorld).toBe('runs');
    expect(a.reasons.map((r) => r.code)).toEqual(['long-melisma']);
    expect(a.reasons[0].detail).toBe('an 8-note melisma near 0:07'); // "an": the caption reads aloud
    // ... but two chains of five on one syllable are still short figures, not one long melisma
    const short = [...plain(0), ...chain(7, 5), ...chain(7 + 5 * 0.3 + 1.5, 5, ''), ...plain(20)];
    expect(analyzeSong(song(short)).reasons).toEqual([]);
    expect(worldOf(short)).toBe('foundations');
  });

  it('words the caption for reading aloud: "a 6-note", "an 8-note", "an 11-note", "a 16-note", "an 18-note"', () => {
    const caption = (count: number): string => analyzeSong(song(withMelisma(count, 0.3))).reasons[0].detail;
    expect([6, 8, 11, 16, 18].map(caption)).toEqual([
      'a 6-note melisma near 0:07',
      'an 8-note melisma near 0:07',
      'an 11-note melisma near 0:07',
      'a 16-note melisma near 0:07',
      'an 18-note melisma near 0:07',
    ]);
  });

  it('reports the LONGEST chain (the earlier one on a tie) as the caption', () => {
    const notes = [...plain(0, 4), ...chain(6, 7), ...plain(12, 4), ...chain(20, 10), ...plain(30, 4), ...chain(36, 10), ...plain(46, 4)];
    const mel = analyzeSong(song(notes)).reasons.filter((r) => r.code === 'long-melisma');
    expect(mel).toHaveLength(1);
    expect(mel[0]).toMatchObject({ atSec: 20, detail: 'a 10-note melisma near 0:20' });
  });

  it('six quick SYLLABLES in a row are not a melisma (a new syllable starts a new run)', () => {
    const notes = Array.from({ length: 24 }, (_, i) => note(i * 0.3, 0.2, 60 + (i % 5), 'la'));
    const a = analyzeSong(song(notes));
    expect(a.reasons.map((r) => r.code)).not.toContain('long-melisma');
    expect(a.difficulty.requiredWorld).toBe('foundations');
  });

  it('is reported alongside the melisma-heavy share when both hold', () => {
    // three syllables each sung across 7 notes at 3.3 notes/s, among four plain ones: 3 of 7 syllables are melismas
    const notes = [...plain(0, 2), ...chain(3, 7), ...chain(9, 7), ...plain(14, 2), ...chain(18, 7)];
    const a = analyzeSong(song(notes));
    expect(a.lyricsAvailable).toBe(true);
    expect(a.reasons.map((r) => r.code)).toEqual(['melisma-heavy', 'long-melisma']);
    expect(a.difficulty.requiredWorld).toBe('runs');
  });

  it('is independent of the key and of note order', () => {
    const notes = withMelisma(16, 0.3);
    expect(rateSong(song([...notes].reverse()))).toEqual(rateSong(song(notes)));
    expect(rateSong(transposeSong(song(notes), -7)).requiredWorld).toBe('runs');
  });
});

describe('rateSong: properties (seeded random songs)', () => {
  function random(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }
  function randomSong(rnd: () => number): Song {
    const n = 4 + Math.floor(rnd() * 40);
    let t = 0;
    const notes: SongNote[] = [];
    for (let i = 0; i < n; i++) {
      const gap = [0.1, 0.15, 0.2, 0.25, 0.5, 1, 2][Math.floor(rnd() * 7)];
      t += gap;
      notes.push(note(t, [0.1, 0.5, 1.2, 2][Math.floor(rnd() * 4)], 50 + Math.floor(rnd() * 26), rnd() < 0.7 ? 'la' : ''));
    }
    return song(notes);
  }

  it('is invariant under transposition (a key never changes what must be earned)', () => {
    const rnd = random(7);
    for (let i = 0; i < 150; i++) {
      const s = randomSong(rnd);
      const shift = Math.floor(rnd() * 25) - 12;
      expect(rateSong(transposeSong(s, shift)).requiredWorld).toBe(rateSong(s).requiredWorld);
    }
  });

  it('never rates a sped-up song below Inflections if the original was Inflections or higher', () => {
    const rnd = random(11);
    for (let i = 0; i < 150; i++) {
      const s = randomSong(rnd);
      const faster = song(s.notes.map((n) => ({ ...n, start: n.start * 0.5, duration: n.duration * 0.5 })));
      const before = rank(rateSong(s).requiredWorld);
      if (before >= 2) expect(rank(rateSong(faster).requiredWorld)).toBeGreaterThanOrEqual(before);
    }
  });

  it('always names a real, unlockable world and keeps its numbers finite', () => {
    const rnd = random(23);
    for (let i = 0; i < 200; i++) {
      const a = analyzeSong(randomSong(rnd));
      expect(['foundations', 'vibrato', 'inflections', 'runs']).toContain(a.difficulty.requiredWorld); // never dynamics or song-stage
      for (const v of [a.difficulty.lowestMidi, a.difficulty.highestMidi, a.difficulty.rangeSemitones, a.difficulty.maxLeapSemitones, a.difficulty.notesPerSec, a.difficulty.melismaRate, a.difficulty.longNoteRatio]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      expect(a.difficulty.requiredWorld).toBe(a.reasons.length > 0 ? a.reasons[0].world : 'foundations');
      for (let k = 1; k < a.reasons.length; k++) expect(rank(a.reasons[k - 1].world)).toBeGreaterThanOrEqual(rank(a.reasons[k].world));
    }
  });
});
