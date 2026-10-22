import { describe, expect, it } from 'vitest';
import { decodeUltraStarBytes, parseUltraStar, serializeUltraStar, UltraStarParseError } from './ultrastar';
import { expectValidSong, seededRandom } from './song-invariants';
import type { Song } from './types';

/** 120 #BPM => one beat (a sixteenth) = 60 / (120 * 4) = 0.125 s. */
const SPB = 0.125;

const BASIC = `#VERSION:1.1.0
#TITLE:Test Song
#ARTIST:Test Artist
#BPM:120
#GAP:500
#MP3:test.mp3
: 0 4 0 Hel
: 4 4 2 lo
- 10
: 10 8 4  World
E
`;

function errorOf(text: string): UltraStarParseError {
  try {
    parseUltraStar(text);
  } catch (e) {
    if (e instanceof UltraStarParseError) return e;
    throw e;
  }
  throw new Error('expected parseUltraStar to throw');
}

function expectSameSong(a: Song, b: Song): void {
  expect(b.title).toBe(a.title);
  expect(b.artist).toBe(a.artist);
  expect(b.bpm).toBeCloseTo(a.bpm ?? NaN, 6);
  expect(b.offsetMs).toBeCloseTo(a.offsetMs, 6);
  expect(b.notes).toHaveLength(a.notes.length);
  a.notes.forEach((n, i) => {
    expect(b.notes[i].midi).toBe(n.midi);
    expect(b.notes[i].lyric).toBe(n.lyric);
    expect(b.notes[i].type).toBe(n.type);
    expect(b.notes[i].start).toBeCloseTo(n.start, 6);
    expect(b.notes[i].duration).toBeCloseTo(n.duration, 6);
  });
  expect(b.phrases).toHaveLength(a.phrases.length);
  a.phrases.forEach((p, i) => {
    expect(b.phrases[i].from).toBe(p.from);
    expect(b.phrases[i].to).toBe(p.to);
    expect(b.phrases[i].start).toBeCloseTo(p.start, 6);
    expect(b.phrases[i].end).toBeCloseTo(p.end, 6);
  });
}

describe('parseUltraStar: headers and notes', () => {
  it('reads title, artist, bpm, gap and the audio filename', () => {
    const { song, audioFile } = parseUltraStar(BASIC);
    expect(song.title).toBe('Test Song');
    expect(song.artist).toBe('Test Artist');
    expect(song.bpm).toBe(120); // the file's #BPM (see ultrastar.ts header)
    expect(song.offsetMs).toBe(500);
    expect(song.source).toBe('ultrastar');
    expect(song.backingRef).toBeNull();
    expect(audioFile).toBe('test.mp3');
  });

  it('prefers #AUDIO over the legacy #MP3, and null when neither is set', () => {
    expect(parseUltraStar(BASIC.replace('#MP3:test.mp3', '#MP3:old.mp3\n#AUDIO:new.mp3')).audioFile).toBe('new.mp3');
    expect(parseUltraStar(BASIC.replace('#MP3:test.mp3\n', '')).audioFile).toBeNull();
  });

  it('exposes every header, keyed by UPPERCASE name, values trimmed', () => {
    const { headers } = parseUltraStar(BASIC.replace('#TITLE:Test Song', '#title :  Spaced Out  '));
    expect(headers.TITLE).toBe('Spaced Out');
    expect(headers.BPM).toBe('120');
  });

  it('maps pitch 0 to C4 (MIDI 60) and keeps negative pitches', () => {
    const { song } = parseUltraStar(`#BPM:120\n: 0 4 0 a\n: 4 4 2 b\n: 8 4 -12 c\nE\n`);
    expect(song.notes.map((n) => n.midi)).toEqual([60, 62, 48]);
  });

  it('computes difficulty itself: never an unrated placeholder', () => {
    const { song } = parseUltraStar(BASIC);
    expect(song.difficulty.lowestMidi).toBe(60);
    expect(song.difficulty.highestMidi).toBe(64);
    expect(song.difficulty.rangeSemitones).toBe(4);
    expect(Number.isNaN(song.difficulty.lowestMidi)).toBe(false);
    // ...and a hard chart is rated hard (4 quick notes at 400 BPM => about 27 notes/s):
    const fast = parseUltraStar(`#BPM:400\n${[0, 1, 2, 3, 4, 5].map((i) => `: ${i * 2} 2 ${i} x`).join('\n')}\nE\n`).song;
    expect(fast.difficulty.requiredWorld).toBe('runs');
  });

  it('refuses a chart without notes', () => {
    expect(() => parseUltraStar('#BPM:120\n#TITLE:Nothing\nE\n')).toThrow(/No notes/);
  });
});

describe('beat and GAP maths (quarter-beat convention)', () => {
  it('one beat lasts 60 / (BPM * 4) seconds', () => {
    const { song } = parseUltraStar(BASIC);
    expect(song.notes[0].start).toBeCloseTo(0, 12);
    expect(song.notes[0].duration).toBeCloseTo(4 * SPB, 12);
    expect(song.notes[1].start).toBeCloseTo(4 * SPB, 12);
    expect(song.notes[2].start).toBeCloseTo(10 * SPB, 12);
    expect(song.notes[2].duration).toBeCloseTo(8 * SPB, 12);
  });

  it('scales with BPM: 60 BPM doubles every time', () => {
    const { song } = parseUltraStar(BASIC.replace('#BPM:120', '#BPM:60'));
    expect(song.notes[1].start).toBeCloseTo(4 * 0.25, 12);
  });

  it('GAP becomes Song.offsetMs and is NOT folded into note times', () => {
    const { song } = parseUltraStar(BASIC);
    expect(song.offsetMs).toBe(500);
    expect(song.notes[0].start).toBe(0);
  });

  it('GAP defaults to 0, may be negative or fractional, and a bad one is ignored with a warning', () => {
    const noGap = BASIC.replace('#GAP:500\n', '');
    expect(parseUltraStar(noGap).song.offsetMs).toBe(0);
    expect(parseUltraStar(BASIC.replace('#GAP:500', '#GAP:-250')).song.offsetMs).toBe(-250);
    const bad = parseUltraStar(BASIC.replace('#GAP:500', '#GAP:soon'));
    expect(bad.song.offsetMs).toBe(0);
    expect(bad.warnings.join(' ')).toMatch(/GAP/);
  });

  it('accepts comma decimals in BPM and GAP', () => {
    const { song } = parseUltraStar(BASIC.replace('#BPM:120', '#BPM:120,5').replace('#GAP:500', '#GAP:12,5'));
    expect(song.bpm).toBeCloseTo(120.5, 9);
    expect(song.offsetMs).toBeCloseTo(12.5, 9);
  });

  it('follows `B beat bpm` tempo changes', () => {
    // beats 0-8 at 120 (0.125 s each) = 1.0 s; from beat 8 at 240 (0.0625 s each).
    const { song } = parseUltraStar(`#BPM:120\n: 0 4 0 a\n: 8 4 0 b\nB 8 240\n: 12 4 0 c\nE\n`);
    expect(song.notes[1].start).toBeCloseTo(1.0, 12);
    expect(song.notes[1].duration).toBeCloseTo(4 * 0.0625, 12);
    expect(song.notes[2].start).toBeCloseTo(1.0 + 4 * 0.0625, 12);
    expect(song.bpm).toBe(120); // the opening tempo
  });
});

describe('several tempo changes accumulate segment by segment', () => {
  const starts = (text: string): number[] => parseUltraStar(text).song.notes.map((n) => n.start);
  const lengths = (text: string): number[] => parseUltraStar(text).song.notes.map((n) => n.duration);
  const expectClose = (actual: number[], want: number[]): void => {
    expect(actual).toHaveLength(want.length);
    want.forEach((w, i) => expect(actual[i]).toBeCloseTo(w, 12));
  };

  it('two changes (120 -> 240 -> 120): the seconds of every earlier segment are carried forward', () => {
    // beats 0-8 at 120 (0.125 s each) = 1.0 s; beats 8-16 at 240 (0.0625 s each) = 0.5 s; from beat 16 at 120 again.
    const text = `#BPM:120\n: 0 4 0 a\nB 8 240\n: 8 4 0 b\nB 16 120\n: 20 4 0 c\nE\n`;
    expectClose(starts(text), [0, 1.0, 2.0]); // beat 20 = 1.0 + 0.5 + 4 * 0.125
    expectClose(lengths(text), [0.5, 0.25, 0.5]);
  });

  it('three changes (100 -> 200 -> 50 -> 100) with a different length in every segment', () => {
    // 0.15 s per beat, then 0.075, then 0.3, then 0.15: the segments start at 0, 0.6, 1.2 and 3.6 s.
    const text = `#BPM:100\n: 0 2 0 a\nB 4 200\n: 6 2 0 b\nB 12 50\n: 14 2 0 c\nB 20 100\n: 24 4 0 d\nE\n`;
    expectClose(starts(text), [0, 0.6 + 2 * 0.075, 1.2 + 2 * 0.3, 3.6 + 4 * 0.15]);
    expectClose(lengths(text), [2 * 0.15, 2 * 0.075, 2 * 0.3, 4 * 0.15]);
  });

  it('puts the lines in beat order whatever order the file lists them', () => {
    const inOrder = `#BPM:100\n: 0 2 0 a\nB 4 200\nB 12 50\nB 20 100\n: 6 2 0 b\n: 14 2 0 c\n: 24 4 0 d\nE\n`;
    const shuffled = `#BPM:100\n: 0 2 0 a\nB 20 100\nB 4 200\n: 6 2 0 b\nB 12 50\n: 14 2 0 c\n: 24 4 0 d\nE\n`;
    expectClose(starts(shuffled), starts(inOrder));
    expectClose(lengths(shuffled), lengths(inOrder));
    expectClose(starts(shuffled), [0, 0.6 + 2 * 0.075, 1.2 + 2 * 0.3, 3.6 + 4 * 0.15]);
  });

  it('measures a note that straddles a change in both tempi', () => {
    // beats 6-10: two beats at 0.125 s, then two at 0.0625 s
    const text = `#BPM:120\n: 6 4 0 x\nB 8 240\nE\n`;
    expectClose(starts(text), [0.75]);
    expectClose(lengths(text), [2 * 0.125 + 2 * 0.0625]);
  });

  it('a change at beat 0 retimes the whole song, and of two changes on one beat the later line wins', () => {
    expectClose(starts(`#BPM:120\nB 0 240\n: 4 4 0 a\nE\n`), [4 * 0.0625]);
    expectClose(starts(`#BPM:120\n: 0 2 0 a\nB 8 240\nB 8 60\n: 10 2 0 b\nE\n`), [0, 1.0 + 2 * 0.25]);
  });
});

describe('lyrics are kept verbatim', () => {
  it('keeps leading and trailing spaces (they mark word breaks)', () => {
    const { song } = parseUltraStar(`#BPM:120\n: 0 4 0 Hel\n: 4 4 0 lo \n: 8 4 0  wor\n: 12 4 0 ld\nE\n`);
    expect(song.notes.map((n) => n.lyric)).toEqual(['Hel', 'lo ', ' wor', 'ld']);
  });

  it('reads "~" (hold the syllable) and a missing text as the empty string', () => {
    const { song } = parseUltraStar(`#BPM:120\n: 0 4 0 a\n: 4 4 0 ~\n: 8 4 0 \n: 12 4 0\nE\n`);
    expect(song.notes.map((n) => n.lyric)).toEqual(['a', '', '', '']);
  });

  it('keeps a lyric that is only a space', () => {
    const { song } = parseUltraStar(`#BPM:120\n: 0 4 0  \nE\n`);
    expect(song.notes[0].lyric).toBe(' ');
  });

  it('keeps accented and non-Latin text', () => {
    const { song } = parseUltraStar(`#BPM:120\n: 0 4 0 café\n: 4 4 0 こん\nE\n`);
    expect(song.notes.map((n) => n.lyric)).toEqual(['café', 'こん']);
  });
});

describe('note types', () => {
  it('maps : * F R to normal, golden, freestyle, rap', () => {
    const { song } = parseUltraStar(`#BPM:100\n: 0 4 0 a\n* 4 4 0 b\nF 8 4 0 c\nR 12 4 0 d\nE\n`);
    expect(song.notes.map((n) => n.type)).toEqual(['normal', 'golden', 'freestyle', 'rap']);
  });

  it('maps golden rap (G) to rap: SongNoteType has no golden-rap', () => {
    expect(parseUltraStar(`#BPM:100\nG 0 4 0 a\nE\n`).song.notes[0].type).toBe('rap');
  });

  it('reads a zero-length note as freestyle (as USDX does) and says so', () => {
    const { song, warnings } = parseUltraStar(`#BPM:100\n: 0 0 0 a\n: 4 4 0 b\nE\n`);
    expect(song.notes[0].type).toBe('freestyle');
    expect(song.notes[0].duration).toBe(0);
    expect(warnings.join(' ')).toMatch(/zero-length/);
  });
});

describe('phrases', () => {
  it('splits on line breaks in FILE order and widens windows to the break beat', () => {
    const { song } = parseUltraStar(BASIC);
    expect(song.phrases).toHaveLength(2);
    expect(song.phrases[0]).toMatchObject({ from: 0, to: 2 });
    expect(song.phrases[1]).toMatchObject({ from: 2, to: 3 });
    expect(song.phrases[0].start).toBeCloseTo(0, 12);
    // "- 10": the first line is cleared at beat 10 (the notes end at beat 8), inside the gap before beat 10.
    expect(song.phrases[0].end).toBeCloseTo(10 * SPB, 12);
    expect(song.phrases[1].start).toBeCloseTo(10 * SPB, 12);
    expect(song.phrases[1].end).toBeCloseTo(18 * SPB, 12);
  });

  it('uses the optional second beat as the moment the next line appears', () => {
    // gap between the notes' end (beat 4) and the next note (beat 14): end at 10, next appears at 12.
    const { song } = parseUltraStar(`#BPM:120\n: 0 4 0 a\n- 10 12\n: 14 4 0 b\nE\n`);
    expect(song.phrases[0].end).toBeCloseTo(10 * SPB, 12);
    expect(song.phrases[1].start).toBeCloseTo(12 * SPB, 12);
  });

  it('without break numbers a phrase is exactly its notes', () => {
    const { song } = parseUltraStar(`#BPM:120\n: 0 4 0 a\n-\n: 14 4 0 b\nE\n`);
    expect(song.phrases[0].end).toBeCloseTo(4 * SPB, 12);
    expect(song.phrases[1].start).toBeCloseTo(14 * SPB, 12);
  });

  it('clamps hints into the gap: a sloppy break can never swallow a note or shrink a phrase', () => {
    // after the next note's start
    const late = parseUltraStar(`#BPM:120\n: 0 4 0 a\n- 99 99\n: 14 4 0 b\nE\n`).song;
    expect(late.phrases[0].end).toBeCloseTo(14 * SPB, 12);
    expect(late.phrases[1].start).toBeCloseTo(14 * SPB, 12);
    // before the previous note's end
    const early = parseUltraStar(`#BPM:120\n: 0 8 0 a\n- 2 3\n: 14 4 0 b\nE\n`).song;
    expect(early.phrases[0].end).toBeCloseTo(8 * SPB, 12);
    expect(early.phrases[1].start).toBeCloseTo(8 * SPB, 12);
    // the notes keep their phrases whatever the numbers say
    expect(late.phrases.map((p) => [p.from, p.to])).toEqual([[0, 1], [1, 2]]);
  });

  it('is one phrase without line breaks, and ignores empty phrases from stray breaks', () => {
    expect(parseUltraStar(`#BPM:120\n: 0 4 0 a\n: 4 4 0 b\nE\n`).song.phrases).toHaveLength(1);
    const stray = parseUltraStar(`#BPM:120\n- 0\n: 0 4 0 a\n- 4\n- 8\n: 8 4 0 b\n- 12\nE\n`).song;
    expect(stray.phrases.map((p) => [p.from, p.to])).toEqual([[0, 1], [1, 2]]);
  });

  it('phrase windows never overlap and always cover their notes', () => {
    const { song } = parseUltraStar(`#BPM:200\n: 0 4 0 a\n: 4 2 0 b\n- 12 14\n: 16 4 0 c\n- 30\n: 40 8 0 d\nE\n`);
    for (let i = 0; i < song.phrases.length; i++) {
      const p = song.phrases[i];
      for (let k = p.from; k < p.to; k++) {
        expect(song.notes[k].start).toBeGreaterThanOrEqual(p.start - 1e-9);
        expect(song.notes[k].start + song.notes[k].duration).toBeLessThanOrEqual(p.end + 1e-9);
      }
      if (i > 0) expect(p.start).toBeGreaterThanOrEqual(song.phrases[i - 1].end - 1e-9);
    }
  });
});

describe('duets and the end marker', () => {
  it('imports P1 and reports the rest', () => {
    const { song, warnings } = parseUltraStar(`#BPM:120\nP1\n: 0 4 0 his\n- 8\n: 8 4 2 own\nP2\n: 0 4 0 hers\nE\n`);
    expect(song.notes.map((n) => n.lyric)).toEqual(['his', 'own']);
    expect(song.phrases).toHaveLength(2);
    expect(warnings.join(' ')).toMatch(/player 2/);
  });

  it('accepts "P 1" spacing and an `E` after each voice', () => {
    const { song } = parseUltraStar(`#BPM:120\nP 1\n: 0 4 0 a\nE\nP 2\n: 0 4 0 b\nE\n`);
    expect(song.notes.map((n) => n.lyric)).toEqual(['a']);
  });

  it('falls back to player 2 when player 1 has no notes', () => {
    const { song, warnings } = parseUltraStar(`#BPM:120\nP1\nP2\n: 0 4 0 only\nE\n`);
    expect(song.notes.map((n) => n.lyric)).toEqual(['only']);
    expect(warnings.join(' ')).toMatch(/player 2 instead/);
  });

  it('has no warnings for a normal file', () => {
    expect(parseUltraStar(BASIC).warnings).toEqual([]);
  });

  it('ignores whatever follows the final `E`, with a warning', () => {
    const { song, warnings } = parseUltraStar(`#BPM:120\n: 0 4 0 a\nE\nthis is not a note\n: 4 4 0 b\n`);
    expect(song.notes).toHaveLength(1);
    expect(warnings.join(' ')).toMatch(/2 line\(s\) after the final "E"/);
  });

  it('reads a file with no `E` at all', () => {
    expect(parseUltraStar(`#BPM:120\n: 0 4 0 a\n: 4 4 0 b\n`).song.notes).toHaveLength(2);
  });
});

describe('#RELATIVE (legacy): the second number of a line break is the offset delta', () => {
  it('follows the USDX rule: break at a + Rel, then Rel += b', () => {
    const text = `#BPM:120\n#RELATIVE:YES\n: 0 4 0 a\n: 4 4 0 b\n- 8 10\n: 0 4 0 c\n- 6 6\n: 2 4 0 d\nE\n`;
    const { song } = parseUltraStar(text);
    // Rel starts 0: a@0 b@4. "- 8 10": Rel becomes 10. c@0+10. "- 6 6": Rel becomes 16. d@2+16.
    expect(song.notes.map((n) => Math.round(n.start / SPB))).toEqual([0, 4, 10, 18]);
    expect(song.phrases.map((p) => [p.from, p.to])).toEqual([[0, 2], [2, 3], [3, 4]]);
  });

  it('treats a missing second number as an offset delta of 0', () => {
    const { song } = parseUltraStar(`#BPM:120\n#RELATIVE:YES\n: 0 4 0 a\n- 8\n: 12 4 0 b\nE\n`);
    expect(Math.round(song.notes[1].start / SPB)).toBe(12);
  });

  it('keeps each duet voice its own running offset', () => {
    const { song } = parseUltraStar(`#BPM:120\n#RELATIVE:YES\nP1\n: 0 4 0 a\n- 4 6\n: 0 4 0 b\nP2\n: 0 4 0 z\n- 4 100\n: 0 4 0 y\nE\n`);
    expect(song.notes.map((n) => Math.round(n.start / SPB))).toEqual([0, 6]);
  });

  it('warns when a 1.0.0+ file still says RELATIVE', () => {
    const { warnings } = parseUltraStar(`#VERSION:1.0.0\n#BPM:120\n#RELATIVE:YES\n: 0 4 0 a\nE\n`);
    expect(warnings.join(' ')).toMatch(/RELATIVE/);
  });

  it('rejects a note that lands before beat 0', () => {
    const e = errorOf(`#BPM:120\n#RELATIVE:YES\n: 0 4 0 a\n- 4 -10\n: 2 4 0 b\nE\n`);
    expect(e.line).toBe(5);
  });
});

describe('tolerance', () => {
  it('strips a leading BOM', () => {
    expect(parseUltraStar(String.fromCharCode(0xfeff) + BASIC).song.title).toBe('Test Song');
  });

  it('reads CRLF, lone CR and LF the same (and hashes them to the same id)', () => {
    const lf = parseUltraStar(BASIC);
    const crlf = parseUltraStar(BASIC.replace(/\n/g, '\r\n'));
    const cr = parseUltraStar(BASIC.replace(/\n/g, '\r'));
    expect(crlf.song.notes).toHaveLength(3);
    expect(cr.song.notes).toHaveLength(3);
    expect(crlf.song.id).toBe(lf.song.id);
    expect(cr.song.id).toBe(lf.song.id);
    expect(crlf.song.notes[2].lyric).toBe(' World'); // no stray \r in the lyric
  });

  it('tolerates tabs, indentation and extra spaces between numeric fields', () => {
    const { song } = parseUltraStar(`#BPM:120\n:   0\t4   0 a\n   : 4 4 0 b\n  - 8\n: 8 4 0 c\nE\n`);
    expect(song.notes.map((n) => n.lyric)).toEqual(['a', 'b', 'c']);
    expect(song.phrases).toHaveLength(2);
  });

  it('ignores a malformed `#` line with a warning instead of failing', () => {
    const { song, warnings } = parseUltraStar(`#BPM:120\n#just a comment without a colon\n: 0 4 0 a\nE\n`);
    expect(song.notes).toHaveLength(1);
    expect(warnings.join(' ')).toMatch(/malformed header/);
  });
});

describe('malformed input: clear errors with line numbers', () => {
  it('reports an unrecognised line', () => {
    const e = errorOf(`#BPM:120\n: 0 4 0 a\n???garbage???\nE\n`);
    expect(e.line).toBe(3);
    expect(e.message).toMatch(/^Line 3: Unrecognized line/);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('UltraStarParseError');
  });

  it('reports a malformed note line (non-numeric fields)', () => {
    const e = errorOf(`#BPM:120\n: 0 four 0 a\nE\n`);
    expect(e.line).toBe(2);
    expect(e.message).toMatch(/Malformed note line/);
  });

  it('reports a malformed line break', () => {
    const e = errorOf(`#BPM:120\n: 0 4 0 a\n- x y\nE\n`);
    expect(e.line).toBe(3);
    expect(e.message).toMatch(/Malformed line break/);
  });

  it('reports a negative note length and a negative start with their lines', () => {
    expect(errorOf(`#BPM:120\n: 0 -4 0 a\nE\n`).line).toBe(2);
    expect(errorOf(`#BPM:120\n: 0 4 0 a\n: -3 4 0 b\nE\n`).line).toBe(3);
  });

  it('reports a missing or invalid #BPM as a whole-file error (line 0)', () => {
    const missing = errorOf(`#TITLE:x\n: 0 4 0 a\nE\n`);
    expect(missing.line).toBe(0);
    expect(missing.message).toMatch(/#BPM/);
    expect(errorOf(`#BPM:not-a-number\n: 0 4 0 a\nE\n`).message).toMatch(/Invalid #BPM/);
    expect(errorOf(`#BPM:0\n: 0 4 0 a\nE\n`).message).toMatch(/Invalid #BPM/);
    expect(errorOf(`#BPM:-5\n: 0 4 0 a\nE\n`).message).toMatch(/Invalid #BPM/);
  });

  it('rejects an empty or whitespace-only file', () => {
    expect(() => parseUltraStar('')).toThrow(UltraStarParseError);
    expect(() => parseUltraStar('   \n  \r\n')).toThrow(/Empty/);
  });

  it('rejects out-of-order notes, naming the offending line', () => {
    const e = errorOf(`#BPM:120\n: 10 4 0 a\n: 0 4 0 b\nE\n`);
    expect(e.line).toBe(3);
    expect(e.message).toMatch(/chronological/);
  });

  it('rejects an invalid tempo change', () => {
    expect(errorOf(`#BPM:120\n: 0 4 0 a\nB 8 0\nE\n`).line).toBe(3);
  });
});

describe('numbers are range-checked: a valid Song or a clear error, never Infinity', () => {
  /** A 400-digit number: parseInt and parseFloat both turn it into Infinity. */
  const nines = '9'.repeat(400);
  const chart = (...body: string[]): string => ['#BPM:120', ...body, 'E', ''].join('\n');
  const accepts = (text: string): Song => {
    const { song } = parseUltraStar(text);
    expectValidSong(song);
    return song;
  };

  it('rejects a note start, length or pitch that is not a finite number, naming the line', () => {
    const start = errorOf(chart(`: ${nines} 4 0 a`));
    expect(start.line).toBe(2);
    expect(start.message).toMatch(/Note start is out of range/);
    const length = errorOf(chart(': 0 4 0 a', `: 8 ${nines} 0 b`));
    expect(length.line).toBe(3);
    expect(length.message).toMatch(/Note length is out of range/);
    const pitch = errorOf(chart(': 0 4 0 a', ': 8 4 0 b', `: 16 4 ${nines} c`));
    expect(pitch.line).toBe(4);
    expect(pitch.message).toMatch(/Note pitch is out of range/);
    // the same numbers negated
    expect(errorOf(chart(`: -${nines} 4 0 a`)).line).toBe(2);
    expect(errorOf(chart(`: 0 -${nines} 0 a`)).line).toBe(2);
    expect(errorOf(chart(`: 0 4 -${nines} a`)).line).toBe(2);
  });

  it('keeps the message short however long the number is', () => {
    expect(errorOf(chart(`: ${nines} 4 0 a`)).message.length).toBeLessThan(120);
  });

  it('accepts the limits (|beat| and length 10 million, |pitch| 200) and rejects one past them', () => {
    expect(accepts(chart(': 10000000 4 0 a')).notes[0].start).toBeCloseTo(10_000_000 * SPB, 6);
    expect(errorOf(chart(': 10000001 4 0 a')).line).toBe(2);
    expect(accepts(chart(': 0 10000000 0 a')).notes[0].duration).toBeCloseTo(10_000_000 * SPB, 6);
    expect(errorOf(chart(': 0 10000001 0 a')).line).toBe(2);
    expect(accepts(chart(': 0 4 200 a', ': 4 4 -200 b')).notes.map((n) => n.midi)).toEqual([260, -140]);
    expect(errorOf(chart(': 0 4 201 a')).line).toBe(2);
    expect(errorOf(chart(': 0 4 -201 a')).line).toBe(2);
  });

  it('reads a negative zero as plain zero (a -0 would not survive a JSON round trip unchanged)', () => {
    const song = accepts(chart(': -0 4 -0 a', ': 4 -0 0 b'));
    expect(Object.is(song.notes[0].start, 0)).toBe(true);
    expect(Object.is(song.notes[0].midi, 60)).toBe(true);
    expect(Object.is(song.notes[1].duration, 0)).toBe(true);
  });

  it('rejects absurd numbers on a line break, and still takes a sane far-off one', () => {
    expect(errorOf(chart(': 0 4 0 a', `- ${nines}`, ': 8 4 0 b')).line).toBe(3);
    expect(errorOf(chart(': 0 4 0 a', `- 4 ${nines}`, ': 8 4 0 b')).line).toBe(3);
    expect(errorOf(chart(': 0 4 0 a', '- 10000001', ': 8 4 0 b')).line).toBe(3);
    expect(accepts(chart(': 0 4 0 a', '- 10000000', ': 8 4 0 b')).notes).toHaveLength(2);
    const relative = ['#BPM:120', '#RELATIVE:YES', ': 0 4 0 a', `- 4 ${nines}`, ': 0 4 0 b', 'E', ''].join('\n');
    expect(errorOf(relative).line).toBe(4);
  });

  it('checks the start again after #RELATIVE offsets are added', () => {
    // "- 4 9000000" moves every later note on by nine million beats; two of them push a note past the limit
    const text = (...body: string[]): string => ['#BPM:120', '#RELATIVE:YES', ...body, 'E', ''].join('\n');
    expect(accepts(text(': 0 4 0 a', '- 4 9000000', ': 0 4 0 b')).notes[1].start).toBeCloseTo(9_000_000 * SPB, 6);
    const e = errorOf(text(': 0 4 0 a', '- 4 9000000', ': 0 4 0 b', '- 4 9000000', ': 0 4 0 c'));
    expect(e.line).toBe(7);
    expect(e.message).toMatch(/Note start is out of range/);
  });

  it('rejects an absurd tempo change: a bad beat, or a tempo of zero, below 1 or beyond any real chart', () => {
    const bad = (line: string): UltraStarParseError => errorOf(chart(': 0 4 0 a', line, ': 8 4 0 b'));
    for (const line of [`B ${nines} 240`, 'B 10000001 240', `B 8 ${nines}`, 'B 8 0', 'B 8 0.5', 'B 8 1000001']) expect(bad(line).line).toBe(3);
    // a change before beat 0 used to put the first notes at a NEGATIVE time
    expect(bad('B -5 240').line).toBe(3);
    expect(accepts(chart(': 0 4 0 a', 'B 8 1', ': 8 4 0 b', 'B 10000000 1000000')).notes).toHaveLength(2);
  });

  it('rejects an #BPM below 1 or beyond any real chart, and accepts both limits', () => {
    for (const bpm of ['1e-300', '0.5', '0.99', '1e999', '1000001', '99999999999', nines]) {
      const e = errorOf(`#BPM:${bpm}\n: 0 4 0 a\nE\n`);
      expect(e.line).toBe(0);
      expect(e.message).toMatch(/Invalid #BPM/);
      expect(e.message.length).toBeLessThan(120);
    }
    for (const bpm of ['1', '1000000', '1,5']) expectValidSong(parseUltraStar(`#BPM:${bpm}\n: 0 4 0 a\nE\n`).song);
  });

  it('a tiny #BPM no longer yields a note that lasts 10^301 seconds', () => {
    expect(() => parseUltraStar('#BPM:1e-300\n: 0 4 0 a\nE\n')).toThrow(UltraStarParseError);
    const slowest = accepts('#BPM:1\n: 0 4 0 a\nE\n');
    expect(slowest.notes[0].duration).toBeCloseTo(60, 9); // 4 beats of 15 s
  });
});

describe('ids and licence', () => {
  it('derives a stable 64-bit content id; different content gets a different id', () => {
    const a = parseUltraStar(BASIC).song.id;
    expect(a).toMatch(/^us-[0-9a-f]{16}$/);
    expect(parseUltraStar(BASIC).song.id).toBe(a);
    expect(parseUltraStar(BASIC.replace('Test Song', 'Other Song')).song.id).not.toBe(a);
  });

  it('accepts an explicit id and source for bundled charts and takes the licence from #COMMENT', () => {
    const { song } = parseUltraStar(BASIC.replace('#GAP:500', '#GAP:0\n#COMMENT:Public domain. Chart by us.'), { id: 'my-song', source: 'bundled' });
    expect(song.id).toBe('my-song');
    expect(song.source).toBe('bundled');
    expect(song.licence).toBe('Public domain. Chart by us.');
  });

  it('prefers #LICENCE / #LICENSE over #COMMENT, and ignores comments on imported songs', () => {
    const text = BASIC.replace('#GAP:500', '#COMMENT:chatty\n#LICENCE:CC0');
    expect(parseUltraStar(text, { source: 'bundled' }).song.licence).toBe('CC0');
    expect(parseUltraStar(text).song.licence).toBeUndefined();
  });
});

describe('decodeUltraStarBytes', () => {
  it('decodes UTF-8 with and without a BOM', () => {
    const bytes = new TextEncoder().encode('#TITLE:Café');
    expect(decodeUltraStarBytes(bytes)).toBe('#TITLE:Café');
    const withBom = Uint8Array.from([0xef, 0xbb, 0xbf, ...bytes]);
    expect(decodeUltraStarBytes(withBom)).toBe('#TITLE:Café');
    expect(decodeUltraStarBytes(bytes.buffer.slice(0) as ArrayBuffer)).toBe('#TITLE:Café');
  });

  it('falls back to windows-1252 for legacy files (a lone 0xE9 or 0x92 is invalid UTF-8)', () => {
    const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
    const legacy = Uint8Array.from([...ascii('#TITLE:Don'), 0x92, ...ascii('t Caf'), 0xe9]);
    expect(decodeUltraStarBytes(legacy)).toBe('#TITLE:Don’t Café'); // 0x92 is the curly apostrophe in cp1252
  });

  it('decodes UTF-16 with a BOM', () => {
    const le = Uint8Array.from([0xff, 0xfe, ...[...'#BPM:1'].flatMap((c) => [c.charCodeAt(0), 0])]);
    expect(decodeUltraStarBytes(le)).toBe('#BPM:1');
    const be = Uint8Array.from([0xfe, 0xff, ...[...'#BPM:1'].flatMap((c) => [0, c.charCodeAt(0)])]);
    expect(decodeUltraStarBytes(be)).toBe('#BPM:1');
  });
});

describe('serializeUltraStar', () => {
  it('writes the canonical text for a parsed song', () => {
    const { song } = parseUltraStar(BASIC);
    expect(serializeUltraStar(song)).toBe(
      ['#VERSION:1.1.0', '#TITLE:Test Song', '#ARTIST:Test Artist', '#BPM:120', '#GAP:500', ': 0 4 0 Hel', ': 4 4 2 lo', '- 10', ': 10 8 4  World', 'E', ''].join('\n'),
    );
  });

  it('round-trips notes, timing, lyrics, types and phrase windows', () => {
    const text = `#BPM:187.5\n#GAP:1234.5\n#TITLE:Round\n#ARTIST:Trip\n: 0 4 0 Hel\n: 4 4 2 lo \n- 10 12\n: 14 3 -5  wor\n* 17 2 7 ~\nF 20 4 0 la\nR 24 4 3 la\n- 40\n: 44 6 12  end\nE\n`;
    const a = parseUltraStar(text).song;
    const b = parseUltraStar(serializeUltraStar(a)).song;
    expectSameSong(a, b);
    // and it is a fixed point
    expect(serializeUltraStar(b)).toBe(serializeUltraStar(a));
  });

  it('round-trips tempo changes through the seconds the notes already carry', () => {
    const a = parseUltraStar(`#BPM:120\n: 0 4 0 a\n: 8 4 0 b\nB 8 240\n: 12 4 0 c\nE\n`).song;
    const b = parseUltraStar(serializeUltraStar(a, { grid: 'auto' })).song;
    a.notes.forEach((n, i) => {
      expect(b.notes[i].start).toBeCloseTo(n.start, 2);
      expect(b.notes[i].duration).toBeCloseTo(n.duration, 2);
    });
  });

  it('keeps zero-length freestyle notes and never turns a short pitched note into one', () => {
    const song: Song = {
      ...parseUltraStar(`#BPM:120\n: 0 4 0 a\nE\n`).song,
      notes: [
        { start: 0, duration: 0, midi: 60, lyric: 'x', type: 'freestyle' },
        { start: 0.01, duration: 0.001, midi: 61, lyric: 'y', type: 'normal' }, // far under one beat
        { start: 1, duration: 0.5, midi: 62, lyric: 'z', type: 'normal' },
      ],
      phrases: [{ start: 0, end: 1.5, from: 0, to: 3 }],
    };
    const back = parseUltraStar(serializeUltraStar(song, { grid: 1 })).song;
    expect(back.notes[0].type).toBe('freestyle');
    expect(back.notes[1].type).toBe('normal');
    expect(back.notes[1].duration).toBeGreaterThan(0);
  });

  it('writes empty lyrics as "~" and keeps spaces', () => {
    const { song } = parseUltraStar(`#BPM:120\n: 0 4 0 a\n: 4 4 0 ~\n: 8 4 0  b \nE\n`);
    const text = serializeUltraStar(song);
    expect(text).toContain(': 4 4 0 ~');
    expect(text).toContain(': 8 4 0  b ');
  });

  it('keeps a title with a line break on one line, and passes extra headers and the audio name through', () => {
    const { song, headers } = parseUltraStar(BASIC);
    const text = serializeUltraStar({ ...song, title: 'Two\nLines' }, { headers: { ...headers, GENRE: 'Folk' }, audioFile: 'a.mp3' });
    expect(text).toContain('#TITLE:Two Lines');
    expect(text).toContain('#AUDIO:a.mp3');
    expect(text).toContain('#GENRE:Folk');
    expect(text).not.toContain('#MP3');
    expect(parseUltraStar(text).audioFile).toBe('a.mp3');
  });

  it('refuses to write extra headers whose names are not plain tags (no line injection)', () => {
    const { song } = parseUltraStar(BASIC);
    const text = serializeUltraStar(song, { headers: { 'EVIL\n: 0 4 0 x': 'y', 'A:B': 'z', GOOD_1: 'ok' } });
    expect(text).toContain('#GOOD_1:ok');
    expect(text).not.toContain('EVIL');
    expect(text).not.toContain('A:B');
    expect(parseUltraStar(text).song.notes).toHaveLength(3);
  });

  it('writes the licence as #COMMENT', () => {
    const { song } = parseUltraStar(BASIC, { source: 'bundled', id: 'x' });
    const withLicence: Song = { ...song, licence: 'Public domain' };
    expect(serializeUltraStar(withLicence)).toContain('#COMMENT:Public domain');
  });

  it('refines the beat grid for off-grid (MIDI-like) songs and says so in #BPM', () => {
    // Triplet eighths at 120 bpm: 1/6 s each, nowhere near the 0.125 s sixteenth grid.
    const third = 0.5 / 3;
    const base = parseUltraStar(`#BPM:120\n: 0 4 0 a\nE\n`).song;
    const song: Song = {
      ...base,
      notes: [0, 1, 2, 3].map((i) => ({ start: i * third, duration: third, midi: 60 + i, lyric: 'la', type: 'normal' as const })),
      phrases: [{ start: 0, end: 4 * third, from: 0, to: 4 }],
    };
    const text = serializeUltraStar(song);
    expect(text).toContain('#BPM:360'); // 120 * k with k = 3
    const back = parseUltraStar(text).song;
    back.notes.forEach((n, i) => {
      expect(n.start).toBeCloseTo(song.notes[i].start, 3);
      expect(n.duration).toBeCloseTo(song.notes[i].duration, 3);
    });
    // forcing grid 1 quantises instead of refining
    expect(serializeUltraStar(song, { grid: 1 })).toContain('#BPM:120');
  });

  it('refuses a song without a usable bpm or an invalid grid', () => {
    const { song } = parseUltraStar(BASIC);
    expect(() => serializeUltraStar({ ...song, bpm: undefined })).toThrow(/bpm/);
    expect(() => serializeUltraStar({ ...song, bpm: 0 })).toThrow(/bpm/);
    expect(() => serializeUltraStar(song, { grid: 0 })).toThrow(/grid/);
  });
});

describe('robustness: corrupted input never crashes', () => {
  /** Every feature in one small file: all note types, both break forms, a duet voice, a gap and an end marker. */
  const FEATURES = `#VERSION:1.1.0\n#TITLE:T\n#ARTIST:A\n#BPM:120\n#GAP:500\n: 0 4 0 Hel\n: 4 4 2 lo\n- 10\n: 10 8 4  World\n* 20 4 5 x\nF 24 4 0 y\nR 28 4 0 z\n- 40 44\nP2\n: 0 4 0 q\nE\n`;
  const LEGACY = `#BPM:199,96\n#RELATIVE:YES\n: 0 4 1 a\n: 6 4 2 b\n- 12 12\n: 3 4 1 c\nB 8 220\n- 9 9\n: 3 4 1 d\nE\n`;
  const CHARS = [':', '*', '-', '#', 'E', 'P', 'B', ' ', '\n', '\r', '9', '0', '-', '\t', 'x', '~', 'F', 'R', 'G', '1', '2', '.', ','];

  function mutate(text: string, rnd: () => number): string {
    let s = text;
    const edits = 1 + Math.floor(rnd() * 6);
    for (let e = 0; e < edits; e++) {
      const pos = Math.floor(rnd() * s.length);
      const kind = rnd();
      if (kind < 0.4) s = s.slice(0, pos) + s.slice(pos + 1 + Math.floor(rnd() * 3)); // delete 1-3 characters
      else if (kind < 0.8) s = s.slice(0, pos) + CHARS[Math.floor(rnd() * CHARS.length)] + s.slice(pos); // insert one
      else s = s.slice(0, pos) + CHARS[Math.floor(rnd() * CHARS.length)] + s.slice(pos + 1); // replace one
    }
    return s;
  }

  for (const [name, base, seed] of [['a feature-complete chart', FEATURES, 1], ['a legacy #RELATIVE chart', LEGACY, 2]] as const) {
    it(`parses ${name} to a valid song or throws UltraStarParseError, never anything else (1500 seeded corruptions)`, () => {
      const rnd = seededRandom(seed);
      let parsed = 0;
      let rejected = 0;
      for (let i = 0; i < 1500; i++) {
        const text = mutate(base, rnd);
        try {
          const { song } = parseUltraStar(text);
          expectValidSong(song);
          // whatever parsed can be written back and read again with the same notes
          const again = parseUltraStar(serializeUltraStar(song)).song;
          expect(again.notes).toHaveLength(song.notes.length);
          parsed++;
        } catch (e) {
          if (!(e instanceof UltraStarParseError)) throw e;
          rejected++;
        }
      }
      // the fuzz must exercise both outcomes, or it proves nothing
      expect(parsed).toBeGreaterThan(50);
      expect(rejected).toBeGreaterThan(50);
    });
  }

  it('survives huge numbers spliced into every numeric field (seeded): a valid song or UltraStarParseError, never Infinity', () => {
    const rnd = seededRandom(3);
    let parsed = 0;
    let rejected = 0;
    for (let i = 0; i < 1500; i++) {
      const base = rnd() < 0.5 ? FEATURES : LEGACY;
      const numbers = [...base.matchAll(/\d+/g)]; // every number in the file, headers included
      const target = numbers[Math.floor(rnd() * numbers.length)];
      const run = Array.from({ length: 1 + Math.floor(rnd() * 400) }, () => String(Math.floor(rnd() * 10))).join('');
      const text = base.slice(0, target.index) + run + base.slice((target.index as number) + target[0].length);
      try {
        expectValidSong(parseUltraStar(text).song); // finite numbers and a JSON round trip that changes nothing
        parsed++;
      } catch (e) {
        if (!(e instanceof UltraStarParseError)) throw e;
        rejected++;
      }
    }
    expect(parsed).toBeGreaterThan(50);
    expect(rejected).toBeGreaterThan(50);
  });

  it('survives pathological text: very long lines, huge numbers, binary junk, and a megabyte of notes', () => {
    expect(() => parseUltraStar('#BPM:120\n: 0 4 0 ' + 'x'.repeat(200000) + '\nE\n')).not.toThrow();
    // 1e20 beats is no real chart (hours of music at any real tempo is under 1e7): a clear error, not a 1e19 s note
    expect(() => parseUltraStar('#BPM:120\n: 99999999999999999999 4 0 a\nE\n')).toThrow(UltraStarParseError);
    for (const junk of ['\u0000\u0001\u0002', String.fromCharCode(0xfffd).repeat(50), '#BPM:120\n\u0000\n']) {
      try {
        parseUltraStar(junk);
      } catch (e) {
        expect(e).toBeInstanceOf(UltraStarParseError);
      }
    }
    const big = '#BPM:120\n' + Array.from({ length: 20000 }, (_, i) => `: ${i * 2} 2 ${i % 24} la`).join('\n') + '\nE\n';
    const t0 = performance.now();
    const { song } = parseUltraStar(big);
    expect(song.notes).toHaveLength(20000);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
