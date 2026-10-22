/**
 * Phrase segmentation and lyric spacing for imported MIDI songs (midi.ts).
 *
 * A MIDI file marks phrases only with rests and, in karaoke files, "/" and "\" line marks. Score-sequenced
 * files (hymns, LilyPond exports) are LEGATO: the breaths are not notated as rests, so those two signals alone
 * would import a whole hymn as ONE phrase, and "loop any phrase", the phrase-by-phrase breakdown and the
 * weakest-phrase coaching (SPEC §10, §12) would degrade to the whole song for exactly the files a choir
 * singer imports. So the notes are cut, in this order:
 *
 *  1. At a rest of at least CONFIG.song.phraseGapMs, and at a karaoke line mark (`forcedBreakBefore`).
 *  2. At the end of a lyric clause: a syllable ending in , ; : . ! ? (a closing quote or bracket may follow).
 *     The cut is made before the NEXT syllable-bearing note, so a held "~" tail stays with its word and every
 *     such phrase starts on a syllable (the bundled charts' invariant, and what a lyric line needs). A clause
 *     break is skipped when either side would be a runt (under minPhraseNotes notes or minPhraseSec seconds).
 *  3. A length cap, the FALLBACK for what is still long (a legato, lyric-less tune): a piece longer than
 *     maxPhraseSec is split at its strongest boundary near the middle, again and again, so no phrase is
 *     longer than a breath. See findSplit.
 *
 * Phrases tile the notes exactly (each starts where the last ended) and span first note start to last note end.
 *
 * Spacing. Some exporters (LilyPond's hymn MIDIs) write one lyric event per syllable with NO whitespace at all
 * ("A", "maz", "ing", "grace!"), which would concatenate to "Amazinggrace!". `isBareLyrics` spots such a file and
 * `spacedSyllable` gives each syllable the word-start convention of the bundled charts (a LEADING space).
 */
import { CONFIG } from '../config';
import type { SongNote, SongPhrase } from './types';

/**
 * Phrase knobs: a view of CONFIG.song (the numbers live there, with their notes; all PROVISIONAL, tune on real hymn and
 * karaoke files). maxPhraseSec: a piece longer than this is split by the fallback. minPhraseNotes / minPhraseSec: a
 * lyric-clause break needs at least this many notes and seconds on each side. minSplitSideSec: the length-cap split leaves at
 * least this much on each side of its cut. splitWindowShare: it looks for the strongest boundary within this share of the
 * piece's length either side of its middle.
 */
export const PHRASE_RULES = {
  maxPhraseSec: CONFIG.song.maxPhraseSec,
  minPhraseNotes: CONFIG.song.minPhraseNotes,
  minPhraseSec: CONFIG.song.minPhraseSec,
  minSplitSideSec: CONFIG.song.minSplitSideSec,
  splitWindowShare: CONFIG.song.splitWindowShare,
} as const;

/**
 * A syllable that ends a clause: , ; : . ! ? (also an ellipsis and the full-width forms used in CJK karaoke),
 * optionally followed by closing quotes or brackets. Tested on the text with its trailing spaces cut off, because
 * karaoke and hymn files put the word-break space AFTER the syllable ("a, ").
 */
const CLAUSE_END_RE = /[,;:.!?\u{2026}\u{3001}\u{3002}\u{ff0c}\u{ff01}\u{ff1a}\u{ff1b}\u{ff1f}][)\]}"'\u{2019}\u{201d}\u{bb}]*$/u;

/** True when the note's lyric ends a clause (trailing spaces ignored). */
export function endsClause(lyric: string): boolean {
  return CLAUSE_END_RE.test(lyric.trimEnd());
}

/** The note carries a syllable (as opposed to continuing the previous one). Same test as difficulty.ts's melisma groups. */
const hasSyllable = (note: SongNote): boolean => note.lyric.trim() !== '';

/**
 * The index in (a, b) where the piece [a, b) is best cut in two, or -1 when no cut leaves minSplitSideSec on both sides.
 *
 * Candidates are note boundaries. In order of preference a candidate (1) starts on a syllable, when any candidate does
 * (a lyric line must start on a word; otherwise any note will do), (2) lies within splitWindowShare of the piece's length
 * either side of its middle, (3) inside that window, follows the longest onset gap (the previous note's length plus any rest
 * after it: the held note that ends a line), and (4) is nearest the middle, the earlier one on a tie.
 */
function findSplit(notes: readonly SongNote[], a: number, b: number): number {
  const R = PHRASE_RULES;
  const t0 = notes[a].start;
  const t1 = notes[b - 1].start + notes[b - 1].duration;
  const mid = (t0 + t1) / 2;
  const window = R.splitWindowShare * (t1 - t0);
  let best = -1;
  let bestSyllable = false;
  let bestInWindow = false;
  let bestStrength = 0;
  let bestDist = Infinity;
  for (let k = a + 1; k < b; k++) {
    if (notes[k - 1].start + notes[k - 1].duration - t0 < R.minSplitSideSec || t1 - notes[k].start < R.minSplitSideSec) continue;
    const syllable = hasSyllable(notes[k]);
    const dist = Math.abs(notes[k].start - mid);
    const inWindow = dist <= window;
    const strength = Math.round((notes[k].start - notes[k - 1].start) * 1000); // whole ms: float noise must not break ties
    let better: boolean;
    if (best < 0) better = true;
    else if (syllable !== bestSyllable) better = syllable;
    else if (inWindow !== bestInWindow) better = inWindow;
    else if (inWindow && strength !== bestStrength) better = strength > bestStrength;
    else better = dist < bestDist;
    if (better) {
      best = k;
      bestSyllable = syllable;
      bestInWindow = inWindow;
      bestStrength = strength;
      bestDist = dist;
    }
  }
  return best;
}

/** Appends the phrase starts of [a, b) to `out`, ascending, splitting the piece (and its halves) while longer than the cap. */
function capInto(notes: readonly SongNote[], a: number, b: number, out: number[]): void {
  // Iterative, so a pathological file cannot overflow the call stack: pairs [lo, hi) on a stack, the left half on top.
  const stack: number[] = [a, b];
  while (stack.length > 0) {
    const hi = stack.pop() as number;
    const lo = stack.pop() as number;
    const long = notes[hi - 1].start + notes[hi - 1].duration - notes[lo].start > PHRASE_RULES.maxPhraseSec;
    const cut = long ? findSplit(notes, lo, hi) : -1;
    if (cut < 0) {
      out.push(lo);
    } else {
      stack.push(cut, hi, lo, cut);
    }
  }
}

/**
 * Notes -> phrases (see the file header): rests >= CONFIG.song.phraseGapMs and karaoke line marks, then lyric clause ends,
 * then the length cap. `forcedBreakBefore` holds the note indices a karaoke line mark precedes. Pure; exported for tests.
 */
export function buildPhrases(notes: readonly SongNote[], forcedBreakBefore: ReadonlySet<number>): SongPhrase[] {
  const n = notes.length;
  if (n === 0) return [];
  const R = PHRASE_RULES;
  const gapSec = CONFIG.song.phraseGapMs / 1000;
  const endOf = (i: number): number => notes[i].start + notes[i].duration;

  // 1. Rests and karaoke line marks. segments = [start0, start1, ..., n].
  const segments: number[] = [0];
  for (let i = 1; i < n; i++) {
    if (forcedBreakBefore.has(i) || notes[i].start - endOf(i - 1) >= gapSec) segments.push(i);
  }
  segments.push(n);

  const starts: number[] = [];
  for (let s = 0; s + 1 < segments.length; s++) {
    const a = segments[s];
    const b = segments[s + 1];

    // 2. Clause ends inside the segment. A pending break waits for the next syllable-bearing note.
    const pieces: number[] = [a];
    let from = a;
    let pending = false;
    for (let i = a; i < b; i++) {
      if (!hasSyllable(notes[i])) continue;
      if (
        pending &&
        i - from >= R.minPhraseNotes &&
        endOf(i - 1) - notes[from].start >= R.minPhraseSec &&
        b - i >= R.minPhraseNotes &&
        endOf(b - 1) - notes[i].start >= R.minPhraseSec
      ) {
        pieces.push(i);
        from = i;
      }
      pending = endsClause(notes[i].lyric);
    }
    pieces.push(b);

    // 3. The length cap, for what is still long.
    for (let p = 0; p + 1 < pieces.length; p++) capInto(notes, pieces[p], pieces[p + 1], starts);
  }

  const phrases: SongPhrase[] = [];
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : n;
    phrases.push({ start: notes[from].start, end: endOf(to - 1), from, to });
  }
  return phrases;
}

/**
 * Scripts whose syllables are not set apart by a space after each one (Chinese, Japanese, Korean, Thai, Lao, Khmer, Burmese).
 * A file in one of them is already written as it should be, so adding spaces would only break it.
 */
const UNSPACED_SCRIPT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/**
 * True when the file's lyric syllables carry no whitespace at all (hyphens allowed): there is no word spacing to keep and it
 * has to be added. A file in a script that is not spaced per syllable (UNSPACED_SCRIPT_RE) is never bare.
 */
export function isBareLyrics(syllables: ReadonlyArray<{ readonly text: string }>): boolean {
  return syllables.length > 0 && syllables.every((s) => !/\s/.test(s.text) && !UNSPACED_SCRIPT_RE.test(s.text));
}

/**
 * The text a syllable of a bare file adds to its note: one LEADING space, the word-start convention of the
 * bundled and UltraStar charts, unless the previous syllable ends with a hyphen (then this one finishes that word).
 */
export function spacedSyllable(text: string, previous: string | undefined): string {
  return previous !== undefined && previous.endsWith('-') ? text : ` ${text}`;
}

/**
 * Removes the leading space `spacedSyllable` added from the first syllable of every phrase, so a phrase's text starts
 * without one (as the bundled charts' do). Only for bare files, whose own syllables hold no whitespace. Mutates `notes`.
 */
export function stripPhraseLeadingSpace(notes: SongNote[], phrases: readonly SongPhrase[]): void {
  for (const p of phrases) {
    for (let i = p.from; i < p.to; i++) {
      if (notes[i].lyric === '') continue;
      if (notes[i].lyric.startsWith(' ')) notes[i].lyric = notes[i].lyric.slice(1);
      break;
    }
  }
}
