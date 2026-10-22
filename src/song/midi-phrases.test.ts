import { describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import { buildPhrases, endsClause, isBareLyrics, PHRASE_RULES, spacedSyllable, stripPhraseLeadingSpace } from './midi-phrases';
import { seededRandom } from './song-invariants';
import type { SongNote, SongPhrase } from './types';

const note = (start: number, duration: number, lyric = '', midi = 60): SongNote => ({ start, duration, midi, lyric, type: 'normal' });

/** Contiguous (legato) notes from [lyric, seconds] pairs, the first at `from`. Seconds are binary fractions, so the sums are exact. */
function legato(specs: ReadonlyArray<readonly [string, number]>, from = 0): SongNote[] {
  let t = from;
  return specs.map(([lyric, sec], i) => {
    const n = note(t, sec, lyric, 60 + (i % 5));
    t += sec;
    return n;
  });
}

/** `count` half-second notes, the lyric of note i given by `lyricAt(i)`. */
const halves = (count: number, lyricAt: (i: number) => string = () => 'la'): SongNote[] => legato(Array.from({ length: count }, (_, i) => [lyricAt(i), 0.5] as const));

const spans = (phrases: SongPhrase[]): number[][] => phrases.map((p) => [p.from, p.to]);
const noMarks: ReadonlySet<number> = new Set();
const endOf = (n: SongNote): number => n.start + n.duration;

describe('endsClause', () => {
  it('accepts , ; : . ! ? with or without the word-break space that follows the syllable', () => {
    for (const text of ['a,', 'a, ', 'found;', 'see.', 'me!', 'what?', 'so:', ' grace!', 'a,  ']) expect(endsClause(text)).toBe(true);
  });

  it('accepts a closing quote or bracket after the mark, an ellipsis and the full-width marks of CJK karaoke', () => {
    for (const text of ['go,"', 'stop.”', 'yes!)', 'maybe?]', "fine,'", 'ok,’ ', 'wait…', 'ok。', 'ok，', 'ok！', 'ok？']) expect(endsClause(text)).toBe(true);
  });

  it('rejects hyphens, apostrophes, marks inside a word, plain words, and empty or blank text', () => {
    for (const text of ['Ma-', "o'", 'the', 'a,b', 'e.g', ' ', '', '(', '"quoted"', 'ah ...ah', '-']) expect(endsClause(text)).toBe(false);
  });
});

describe('buildPhrases: rests and karaoke marks', () => {
  const gap = CONFIG.song.phraseGapMs / 1000;

  it('is empty for no notes, and one phrase for one note', () => {
    expect(buildPhrases([], noMarks)).toEqual([]);
    expect(buildPhrases([note(2, 1, 'la')], noMarks)).toEqual([{ start: 2, end: 3, from: 0, to: 1 }]);
  });

  it('starts a phrase after a rest of at least CONFIG.song.phraseGapMs, and not after a shorter one', () => {
    const notes = [note(0, 0.5), note(0.5, 0.5), note(1 + gap + 0.01, 0.5), note(1.5 + gap + 0.01 + (gap - 0.05), 0.5)];
    const phrases = buildPhrases(notes, noMarks);
    expect(spans(phrases)).toEqual([[0, 2], [2, 4]]);
    expect(phrases[0]).toMatchObject({ start: 0, end: 1 });
    expect(phrases[1].start).toBe(notes[2].start);
    expect(phrases[1].end).toBe(endOf(notes[3]));
  });

  it('pins the 350 ms: a rest of 0.375 s starts a phrase, one of 0.3125 s does not', () => {
    expect(CONFIG.song.phraseGapMs).toBe(350);
    const after = (rest: number) => buildPhrases([note(0, 0.5), note(0.5, 0.5), note(1 + rest, 0.5), note(1.5 + rest, 0.5)], noMarks);
    expect(spans(after(0.375))).toEqual([[0, 2], [2, 4]]);
    expect(spans(after(0.3125))).toEqual([[0, 4]]);
  });

  it('starts a phrase at a karaoke line mark, and ignores marks that are not between two notes', () => {
    const notes = halves(8);
    expect(spans(buildPhrases(notes, new Set([3, 6])))).toEqual([[0, 3], [3, 6], [6, 8]]);
    expect(spans(buildPhrases(notes, new Set([0, 8, 99, -1])))).toEqual([[0, 8]]);
  });
});

describe('buildPhrases: the ends of lyric clauses', () => {
  it('cuts after a syllable ending in a comma, before the next syllable, even though "a, " has a trailing space', () => {
    const notes = legato([['Ma', 0.5], ['ri', 0.5], ['a, ', 0.5], ['Do', 0.5], ['mi', 0.5], ['nus ', 0.5], ['te', 0.5], ['cum, ', 0.5]]);
    expect(spans(buildPhrases(notes, noMarks))).toEqual([[0, 3], [3, 8]]); // three notes and 1.5 s: exactly enough
  });

  it('waits for the next syllable: a held "~" tail stays with its word and no phrase starts on one', () => {
    const notes = legato([['Ma', 0.5], ['ri', 0.5], ['a, ', 0.5], ['', 0.5], ['', 0.5], ['Do', 0.5], ['mi', 0.5], ['nus ', 0.5], ['te', 0.5], ['cum, ', 0.5]]);
    expect(spans(buildPhrases(notes, noMarks))).toEqual([[0, 5], [5, 10]]);
  });

  it('does not take a blank lyric for the next syllable', () => {
    const notes = legato([['Ma', 0.5], ['ri', 0.5], ['a, ', 0.5], [' ', 0.5], ['Do', 0.5], ['mi', 0.5], ['nus', 0.5], ['te', 0.5]]);
    expect(spans(buildPhrases(notes, noMarks))).toEqual([[0, 4], [4, 8]]);
  });

  it('cuts at every other kind of clause end too, each before the following syllable', () => {
    const lines = [['Oh', 'say', 'can', 'you', 'see;'], ['by', 'the', 'dawn’s', 'early', 'light!'], ['what', 'so', 'proudly', 'we', 'hailed?']];
    const notes = legato(lines.flat().map((l) => [l, 0.5] as const));
    expect(spans(buildPhrases(notes, noMarks))).toEqual([[0, 5], [5, 10], [10, 15]]);
  });

  it('does not cut after a mark when the phrase so far is a runt: under 3 notes ...', () => {
    // "Oh," is one note: its break is dropped (and does not linger for a later syllable); "see," ends a real clause
    const notes = legato(['Oh,', 'say', 'can', 'you', 'see,', 'by', 'the', 'dawn', 'light'].map((l) => [l, 0.5] as const));
    expect(spans(buildPhrases(notes, noMarks))).toEqual([[0, 5], [5, 9]]);
    const stale = legato(['Oh,', 'say', 'you', 'see', 'it', 'now', 'so'].map((l) => [l, 0.5] as const));
    expect(spans(buildPhrases(stale, noMarks))).toEqual([[0, 7]]);
  });

  it('... or under 1.5 s, and the rule is inclusive', () => {
    const short = (sec: number): SongNote[] => legato(['a', 'b', 'c,', 'd', 'e', 'f', 'g'].map((l) => [l, sec] as const));
    expect(spans(buildPhrases(short(0.4375), noMarks))).toEqual([[0, 7]]); // 3 notes = 1.3125 s
    expect(spans(buildPhrases(short(0.5), noMarks))).toEqual([[0, 3], [3, 7]]); // 3 notes = 1.5 s
    expect(PHRASE_RULES.minPhraseNotes).toBe(3);
    expect(PHRASE_RULES.minPhraseSec).toBe(1.5);
  });

  it('and does not leave a runt behind either: the rest of the piece needs 3 notes and 1.5 s too', () => {
    const tail = (n: number): SongNote[] => legato(['la', 'la', 'la', 'la,', ...Array.from({ length: n }, () => 'la')].map((l) => [l, 0.5] as const));
    expect(spans(buildPhrases(tail(1), noMarks))).toEqual([[0, 5]]);
    expect(spans(buildPhrases(tail(2), noMarks))).toEqual([[0, 6]]);
    expect(spans(buildPhrases(tail(3), noMarks))).toEqual([[0, 4], [4, 7]]);
    const slow = legato([['la', 0.5], ['la', 0.5], ['la', 0.5], ['la,', 0.5], ['la', 0.4375], ['la', 0.4375], ['la', 0.4375]]);
    expect(spans(buildPhrases(slow, noMarks))).toEqual([[0, 7]]); // the remainder is 1.3125 s
  });

  it('a mark on the last note of a piece cuts nothing', () => {
    expect(spans(buildPhrases(halves(4, (i) => (i === 3 ? 'la.' : 'la')), noMarks))).toEqual([[0, 4]]);
  });

  it('works inside each rest-separated piece on its own, and keeps the rests as phrase starts', () => {
    const line = (from: number): SongNote[] => legato([['Ma', 0.5], ['ri', 0.5], ['a, ', 0.5], ['Do', 0.5], ['mi', 0.5], ['nus', 0.5]], from);
    const first = line(0);
    const second = line(endOf(first[5]) + 0.5); // a 0.5 s rest
    expect(spans(buildPhrases([...first, ...second], noMarks))).toEqual([[0, 3], [3, 6], [6, 9], [9, 12]]);
  });

  it('applies to the pieces a karaoke line mark leaves, and a mark is never merged away', () => {
    const notes = legato([['Ma', 0.5], ['ri', 0.5], ['a, ', 0.5], ['Do', 0.5], ['mi', 0.5], ['nus', 0.5], ['te', 0.5], ['cum', 0.5], ['x', 0.5]]);
    expect(spans(buildPhrases(notes, new Set([6])))).toEqual([[0, 3], [3, 6], [6, 9]]);
    // a piece too short to hold two phrases is not cut (the mark at 5 leaves only 2 notes after "a, ")
    expect(spans(buildPhrases(notes, new Set([5])))).toEqual([[0, 5], [5, 9]]);
  });

  it('never cuts a song with no lyrics at a clause (there are none) and never mutates its input', () => {
    const notes = Object.freeze(halves(12, () => '').map((n) => Object.freeze(n))) as SongNote[];
    expect(spans(buildPhrases(notes, noMarks))).toEqual([[0, 12]]);
  });
});

describe('buildPhrases: the length cap (the fallback for legato, lyric-less tunes)', () => {
  it('leaves a piece of up to the cap alone, and splits a longer one at the middle when nothing stands out', () => {
    expect(PHRASE_RULES.maxPhraseSec).toBe(10);
    expect(spans(buildPhrases(halves(20, () => ''), noMarks))).toEqual([[0, 20]]); // exactly 10 s
    expect(spans(buildPhrases(halves(21, () => ''), noMarks))).toEqual([[0, 10], [10, 21]]); // 10.5 s, cut nearest the middle (5.25 s: note 10 or 11)
    expect(spans(buildPhrases(halves(36, () => ''), noMarks))).toEqual([[0, 18], [18, 36]]);
  });

  it('cuts after the long held note that ends a line (the strongest boundary near the middle), not at the exact middle', () => {
    const line = (): Array<readonly [string, number]> => Array.from({ length: 12 }, () => ['', 0.5] as const);
    const notes = legato([...line(), ['', 2], ...line()]); // 6 s, a 2 s note, 6 s
    expect(spans(buildPhrases(notes, noMarks))).toEqual([[0, 13], [13, 25]]);
  });

  it('ignores a strong boundary far from the middle: the cut stays in the central window', () => {
    // the 3 s note at the start ends in the strongest boundary of all, but the cut belongs near the middle of 16 s
    const specs: Array<readonly [string, number]> = [['', 3], ...Array.from({ length: 26 }, () => ['', 0.5] as const)]; // 3 s + 13 s = 16 s
    const phrases = buildPhrases(legato(specs), noMarks);
    expect(phrases.length).toBe(2);
    expect(phrases[0].end - phrases[0].start).toBeCloseTo(8, 6);
  });

  it('with lyrics, only cuts before a syllable (a lyric line must start on a word), nearest the middle among equals', () => {
    const notes = halves(30, (i) => (i % 4 === 0 ? 'la' : '')); // a syllable every 4th note: 15 s
    expect(spans(buildPhrases(notes, noMarks))).toEqual([[0, 16], [16, 30]]);
    for (const p of buildPhrases(notes, noMarks)) expect(notes[p.from].lyric).not.toBe('');
  });

  it('falls back to any note when no syllable-bearing boundary leaves room', () => {
    const notes = halves(30, (i) => (i === 0 ? 'la' : '')); // one syllable, then a 15 s held tail
    expect(spans(buildPhrases(notes, noMarks))).toEqual([[0, 15], [15, 30]]);
  });

  it('leaves at least 2 s each side of a cut, and no cut at all when that is impossible', () => {
    expect(PHRASE_RULES.minSplitSideSec).toBe(2);
    const early = legato([['', 9], ...Array.from({ length: 6 }, () => ['', 0.5] as const)]); // 9 s then 3 s: 12 s
    expect(spans(buildPhrases(early, noMarks))).toEqual([[0, 1], [1, 7]]);
    expect(spans(buildPhrases(legato([['', 11], ['', 1]]), noMarks))).toEqual([[0, 2]]); // 1 s would be left on the right
    expect(spans(buildPhrases(legato([['', 1], ['', 11]]), noMarks))).toEqual([[0, 2]]); // and on the left
    expect(spans(buildPhrases(legato([['', 12]]), noMarks))).toEqual([[0, 1]]); // one long note is one phrase
  });

  it('keeps cutting until every piece fits: 45 s becomes phrases of 2 to 10 s', () => {
    const phrases = buildPhrases(halves(90, () => ''), noMarks);
    expect(phrases.length).toBeGreaterThanOrEqual(5);
    for (const p of phrases) {
      expect(p.end - p.start).toBeLessThanOrEqual(10);
      expect(p.end - p.start).toBeGreaterThanOrEqual(2);
    }
  });

  it('is applied after the clause cuts, to each piece on its own', () => {
    // "la," ends a 2 s clause; the other 20 s are one long clause that the cap halves
    const notes = halves(44, (i) => (i === 3 ? 'la,' : 'la'));
    expect(spans(buildPhrases(notes, noMarks))).toEqual([[0, 4], [4, 24], [24, 44]]);
  });

  it('is applied inside a piece a karaoke mark leaves, and never merges across the mark', () => {
    const notes = halves(28, () => '');
    expect(spans(buildPhrases(notes, new Set([10])))).toEqual([[0, 10], [10, 28]]); // 5 s and 9 s: nothing to cap
    expect(spans(buildPhrases(notes, new Set([2])))).toEqual([[0, 2], [2, 15], [15, 28]]); // 13 s after the mark is cut again
  });

  it('copes with a thousand seconds of notes (no recursion, no quadratic blow-up)', () => {
    const notes = halves(2000, () => '');
    const t0 = performance.now();
    const phrases = buildPhrases(notes, noMarks);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(phrases.length).toBeGreaterThanOrEqual(100);
    for (const p of phrases) expect(p.end - p.start).toBeLessThanOrEqual(10);
  });
});

describe('buildPhrases: properties (seeded random notes)', () => {
  const gapSec = CONFIG.song.phraseGapMs / 1000;

  it('always tiles the notes, keeps every rest and mark, spans note starts to note ends, and cuts everything that can be cut to the cap', () => {
    const rnd = seededRandom(11);
    const lyrics = ['', '', 'la', 'la', 'la,', 'a. ', ' la!', ' '];
    for (let round = 0; round < 400; round++) {
      const count = 1 + Math.floor(rnd() * 70);
      const notes: SongNote[] = [];
      const marks = new Set<number>();
      let t = 0;
      for (let i = 0; i < count; i++) {
        if (rnd() < 0.15) t += 0.2 + rnd() * 1.5; // a rest, sometimes long enough to end a phrase
        const dur = [0.1, 0.25, 0.5, 1, 2, 4, 7][Math.floor(rnd() * 7)];
        notes.push(Object.freeze(note(t, dur, lyrics[Math.floor(rnd() * lyrics.length)])));
        t += dur;
        if (i > 0 && rnd() < 0.05) marks.add(i);
      }
      const phrases = buildPhrases(notes, marks);

      expect(phrases[0].from).toBe(0);
      expect(phrases[phrases.length - 1].to).toBe(count);
      const starts = new Set(phrases.map((p) => p.from));
      phrases.forEach((p, k) => {
        if (k > 0) expect(p.from).toBe(phrases[k - 1].to);
        expect(p.to).toBeGreaterThan(p.from);
        expect(p.start).toBe(notes[p.from].start);
        expect(p.end).toBe(endOf(notes[p.to - 1]));
        if (p.end - p.start > PHRASE_RULES.maxPhraseSec) {
          // too long only if no cut leaves 2 s on both sides
          for (let c = p.from + 1; c < p.to; c++) {
            const left = endOf(notes[c - 1]) - p.start;
            const right = p.end - notes[c].start;
            expect(left < PHRASE_RULES.minSplitSideSec || right < PHRASE_RULES.minSplitSideSec).toBe(true);
          }
        }
      });
      for (let i = 1; i < count; i++) {
        if (marks.has(i) || notes[i].start - endOf(notes[i - 1]) >= gapSec) expect(starts.has(i)).toBe(true);
      }
      expect(buildPhrases(notes, marks)).toEqual(phrases); // deterministic
    }
  });
});

describe('lyric spacing helpers', () => {
  it('isBareLyrics: true only for a non-empty list where no syllable holds whitespace (hyphens are fine)', () => {
    expect(isBareLyrics([])).toBe(false);
    expect(isBareLyrics([{ text: 'A' }, { text: 'maz' }, { text: 'grace!' }])).toBe(true);
    expect(isBareLyrics([{ text: 'Ma-' }, { text: 'ry' }])).toBe(true);
    expect(isBareLyrics([{ text: 'A' }, { text: 'lo ' }])).toBe(false);
    expect(isBareLyrics([{ text: ' A' }])).toBe(false);
    expect(isBareLyrics([{ text: 'a\u{a0}b' }])).toBe(false); // a no-break space is whitespace too
    expect(isBareLyrics([{ text: 'a\tb' }])).toBe(false);
  });

  it('isBareLyrics: accented Latin, Greek and Cyrillic syllables are bare (those scripts are spaced), CJK, Korean and Thai are not', () => {
    expect(isBareLyrics([{ text: 'café' }, { text: 'naïve' }])).toBe(true);
    expect(isBareLyrics([{ text: 'αγά' }, { text: 'πη' }])).toBe(true); // Greek
    expect(isBareLyrics([{ text: 'При' }, { text: 'вет' }])).toBe(true); // Cyrillic
    expect(isBareLyrics([{ text: '你' }, { text: '好' }])).toBe(false); // Han
    expect(isBareLyrics([{ text: 'こ' }, { text: 'ん' }])).toBe(false); // Hiragana
    expect(isBareLyrics([{ text: 'コ' }, { text: 'ン' }])).toBe(false); // Katakana
    expect(isBareLyrics([{ text: '나' }, { text: '는' }])).toBe(false); // Hangul
    expect(isBareLyrics([{ text: 'ส' }, { text: 'วั' }])).toBe(false); // Thai
    expect(isBareLyrics([{ text: 'la' }, { text: '你' }])).toBe(false); // one such syllable is enough: the file is not English
  });

  it('spacedSyllable: one leading space, unless the previous syllable ends in a hyphen', () => {
    expect(spacedSyllable('maz', 'A')).toBe(' maz');
    expect(spacedSyllable('A', undefined)).toBe(' A');
    expect(spacedSyllable('ry', 'Ma-')).toBe('ry');
    expect(spacedSyllable('tle', 'lit-')).toBe('tle');
    expect(spacedSyllable('-x', 'foo')).toBe(' -x');
  });

  it('stripPhraseLeadingSpace: takes the added space off the first syllable of each phrase, in place', () => {
    const notes = [note(0, 1, ' a'), note(1, 1, ' b'), note(2, 1, ''), note(3, 1, ' c'), note(4, 1, 'ry'), note(5, 1, ''), note(6, 1, '')];
    stripPhraseLeadingSpace(notes, [
      { start: 0, end: 2, from: 0, to: 2 },
      { start: 2, end: 4, from: 2, to: 4 }, // starts on a tail: the space comes off "c"
      { start: 4, end: 6, from: 4, to: 6 }, // "ry" had none (it finishes "Ma-"): untouched
      { start: 6, end: 7, from: 6, to: 7 }, // no syllable at all
    ]);
    expect(notes.map((n) => n.lyric)).toEqual(['a', ' b', '', 'c', 'ry', '', '']);
  });
});
