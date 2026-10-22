/**
 * Song difficulty rating (SPEC §11.2): decides which world's Boss Recital must be passed
 * before a song unlocks (progress/unlocks.ts isSongUnlocked checks that boss).
 *
 * Conservative by design ("never under-rate"): an under-rated song would let a singer
 * attempt technique they have not earned (SPEC §11.1), while an over-rated one is only
 * a delay. So each threshold sits where the curriculum's own drills begin, several
 * independent triggers can fire, and the LATEST world among them wins. The one known blind
 * spot: melisma is read from the lyrics (both the melisma-heavy share and the single long
 * melisma need to know which notes continue a syllable), so a song with no lyric text
 * (most MIDI files; fewer than RATING_RULES.minLyricCoverage of its notes starting a
 * syllable) only shows it through fast notes; a SLOW melisma, such as one long scale run
 * on a single vowel at ordinary eighth-note speed, goes unseen there.
 *
 * The rules are anchored to what each world actually trains (exercises/catalog):
 *  - Foundations trains straight holds of 4-8 s, legato scale lines (one note per beat at
 *    60-84 bpm, about 1 note/s), and interval jumps up to an OCTAVE. So long notes and
 *    leaps up to 12 semitones never lift a song out of Foundations on their own.
 *  - Vibrato: a song built mostly from held notes invites vibrato (SPEC: "many long
 *    held notes where vibrato matters").
 *  - Inflections trains slides, turns, ornaments and register flips. So leaps WIDER than
 *    an octave, a span that forces a register change, and quick narrow turn/ornament
 *    figures land here.
 *  - Runs & Riffs trains 3/5/7-note patterns up the CONFIG.runs.tempoLadderNps ladder.
 *    Its first level passes at the ladder's SECOND rung (4.5 notes/s), so "fast" means
 *    at or above that: any chain of 3+ notes that quick, or 4.5 notes/s sustained over a
 *    2 s window, or a melisma-heavy line, needs the Runs world. A single LONG melisma
 *    needs it too: 6 or more notes in a row on ONE syllable at the ladder's FIRST rung
 *    (3 notes/s, where the world begins) is a Gloria-style run, which is Runs technique
 *    even though it is nowhere near "fast" and is only one syllable of many.
 *  - Dynamics: a chart carries no loudness markings, so this world is never required
 *    here (the brief says to ignore it).
 *
 * Only PITCHED notes (normal, golden) take part: freestyle and rap pitches are
 * meaningless and unscored. When the world rules disagree the LATEST world wins,
 * which is both the conservative and the structurally correct choice (passing a later
 * world's boss implies the earlier bosses are passed: the worlds unlock in order).
 *
 * Time is absolute seconds, so slowing a song down in the app never changes its rating,
 * and the rating is invariant under transposition.
 */
import type { Song, SongDifficulty, SongNote } from './types';
import type { WorldId } from '../exercises/types';
import { CONFIG } from '../config';
import { isPitchedNote } from './pitched';

/**
 * Song-rating knobs. CONFIG has no `song.difficulty` section (reported in contractIssues),
 * so they live here, named and documented. All PROVISIONAL: there is no multi-song corpus
 * to calibrate against yet; derived values come from CONFIG so retuning the Runs ladder
 * retunes the rating consistently.
 */
export const RATING_RULES = {
  /** SongDifficulty.longNoteRatio counts notes at least this long ("vibrato-worthy" holds). */
  longNoteSec: 1,
  /** Peak notes-per-second window, half-open (the SongDifficulty.notesPerSec contract: "over any 2 s window"). */
  peakWindowSec: 2,
  /** "Fast": the pass tempo of the easiest Runs level (second ladder rung), notes per second. */
  fastNps: CONFIG.runs.tempoLadderNps[1],
  /** A fast chain needs at least this many notes (two consecutive quick gaps). */
  fastChainMinNotes: 3,
  /** A fast chain is an ORNAMENT (turn, mordent, short trill) when it is this short and narrow; otherwise it is a RUN. */
  ornamentMaxNotes: 5,
  ornamentMaxSpanSemitones: 3,
  /** Share of syllables carrying 3+ notes at which the song is melisma-heavy (lyrics needed). */
  melismaHeavyShare: 0.25,
  /**
   * One LONG melisma (lyrics needed): this many notes in a row on a single syllable, every onset at most 1 / longMelismaNps
   * after the one before. The speed is the FIRST rung of the Runs ladder (3 notes/s, the slowest tempo Runs & Riffs
   * drills), well below `fastNps`: a 16-note scale on "Glo-" at eighth notes of 100 bpm is only 3.3 notes/s, so no fast
   * chain, dense window or melisma share sees it, yet it is the world's own technique. Foundations drills one note per
   * beat at 60-84 bpm, so 3 notes/s is already 2-3 times what that world asks for.
   */
  longMelismaNps: CONFIG.runs.tempoLadderNps[0],
  longMelismaNotes: 6,
  /** Lyrics count as present when at least this share of notes starts a syllable. */
  minLyricCoverage: 0.25,
  /** The widest interval Foundations drills (Interval jumps II: octaves). Wider leaps need flips. */
  maxFoundationsLeap: 12,
  /**
   * A span this wide exceeds an untrained male voice's comfortable range (about C3-E4 = 16
   * semitones, docs/RESEARCH.md §6), so the tune cannot be sung without the extended range and
   * the register break: that is what the Inflections world's flips train.
   */
  wideRangeSemitones: 17,
  /** Share of notes held >= longNoteSec at which the song is sustained-style: about a third (vibrato matters). */
  sustainedLongNoteShare: 1 / 3,
} as const;

/** Worlds in the order they unlock (SPEC §11); song-stage has no boss and is never required. */
const WORLD_ORDER: readonly WorldId[] = ['foundations', 'vibrato', 'inflections', 'runs', 'dynamics'];
const rankOf = (w: WorldId): number => WORLD_ORDER.indexOf(w);

export type DifficultyReasonCode =
  | 'fast-run'
  | 'ornament'
  | 'dense-passage'
  | 'melisma-heavy'
  | 'long-melisma'
  | 'wide-leap'
  | 'wide-range'
  | 'sustained-style';

export interface DifficultyReason {
  /** The world this finding requires. */
  world: WorldId;
  code: DifficultyReasonCode;
  /** One short sentence for a locked-song caption, e.g. "6 notes in 0.7 s near 1:01". */
  detail: string;
  /** Song time (seconds) of the passage behind the finding (the first occurrence, or the strongest one), when it is local to a passage. */
  atSec?: number;
}

export interface SongRating {
  difficulty: SongDifficulty;
  /** Every finding, strongest world first; `difficulty.requiredWorld` is `reasons[0].world`. */
  reasons: DifficultyReason[];
  /** False when too few notes carry lyric text to measure melisma density. */
  lyricsAvailable: boolean;
}

const ZERO_DIFFICULTY: SongDifficulty = {
  lowestMidi: 0,
  highestMidi: 0,
  rangeSemitones: 0,
  maxLeapSemitones: 0,
  notesPerSec: 0,
  melismaRate: 0,
  longNoteRatio: 0,
  requiredWorld: 'foundations',
};

/** m:ss for captions. */
function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "a 16-note melisma near 0:05" / "an 8-note melisma ...": the article follows the sound of the number (eight, eleven, eighteen, eighty...). */
function melismaCaption(count: number, atSec: number): string {
  const an = /^(8\d*|11|18)$/.test(String(count));
  return `${an ? 'an' : 'a'} ${count}-note melisma near ${clock(atSec)}`;
}

/**
 * Peak notes/second over any HALF-OPEN window [t, t + windowSec) (note onsets counted; O(n)
 * two-pointer). Half-open matters: with a closed window a steady 4 notes/s would count 9
 * onsets in 2 s and read as 4.5, which is the "fast" line, so ordinary eighth notes at
 * 120 bpm would be rated as runs.
 */
function peakNotesPerSecond(notes: readonly SongNote[], windowSec: number): { nps: number; atSec: number } {
  let left = 0;
  let best = 0;
  let bestAt = 0;
  for (let right = 0; right < notes.length; right++) {
    while (notes[right].start - notes[left].start >= windowSec) left++;
    const count = right - left + 1;
    if (count > best) {
      best = count;
      bestAt = notes[left].start;
    }
  }
  return { nps: best / windowSec, atSec: bestAt };
}

/**
 * Share of "syllable groups" that carry 3+ notes (melisma). A group starts at note 0 and at
 * every note with lyric text; a note with EMPTY text continues the previous group (the
 * importers normalise UltraStar's "~" and MIDI continuation notes to ''). Meaningless when
 * the song has no lyrics, so callers gate it on lyric coverage.
 */
function melismaShare(notes: readonly SongNote[]): number {
  let groups = 0;
  let melismatic = 0;
  let size = 0;
  for (let i = 0; i < notes.length; i++) {
    if (i === 0 || notes[i].lyric.trim() !== '') {
      if (size >= 3) melismatic++;
      if (size > 0) groups++;
      size = 1;
    } else {
      size++;
    }
  }
  if (size >= 3) melismatic++;
  if (size > 0) groups++;
  return groups === 0 ? 0 : melismatic / groups;
}

/**
 * The longest melisma CHAIN: within ONE syllable group (grouped as in melismaShare), the longest run
 * of consecutive notes whose onset gaps are all <= maxGap. A chain, not the group's mean rate: a held
 * "~" tail or a breath inside the group would dilute a mean (8 quick notes, a rest, then 8 more on the
 * same vowel are two 8-note chains). A new syllable always starts a new run, so six quick SYLLABLES in
 * a row are never a melisma (the fast-chain rules judge those). Ties go to the earlier run. Meaningless
 * when the song has no lyrics (every note would continue note 0's syllable): callers gate on lyric coverage.
 */
function longestMelismaChain(notes: readonly SongNote[], maxGap: number): { count: number; from: number } {
  let bestCount = 0;
  let bestFrom = 0;
  let runFrom = 0;
  let runCount = 0;
  for (let i = 0; i < notes.length; i++) {
    const continues = i > 0 && notes[i].lyric.trim() === '' && notes[i].start - notes[i - 1].start <= maxGap + 1e-9;
    if (continues) {
      runCount++;
    } else {
      runFrom = i;
      runCount = 1;
    }
    if (runCount > bestCount) {
      bestCount = runCount;
      bestFrom = runFrom;
    }
  }
  return { count: bestCount, from: bestFrom };
}

interface Chain {
  from: number;
  to: number; // inclusive
}

/** Maximal runs of consecutive notes whose onset gaps are all <= maxGap, with at least minNotes notes. */
function fastChains(notes: readonly SongNote[], maxGap: number, minNotes: number): Chain[] {
  const out: Chain[] = [];
  const n = notes.length;
  let i = 0;
  while (i < n - 1) {
    if (notes[i + 1].start - notes[i].start <= maxGap + 1e-9) {
      let j = i + 1;
      while (j < n - 1 && notes[j + 1].start - notes[j].start <= maxGap + 1e-9) j++;
      if (j - i + 1 >= minNotes) out.push({ from: i, to: j });
      i = j;
    } else {
      i++;
    }
  }
  return out;
}

/** Full rating with the reasons behind it. Pure; never mutates `song`. */
export function analyzeSong(song: Song): SongRating {
  let notes = song.notes.filter(isPitchedNote);
  if (notes.length === 0) notes = song.notes.slice(); // all-freestyle chart: judge it on its timing
  if (notes.length === 0) return { difficulty: { ...ZERO_DIFFICULTY }, reasons: [], lyricsAvailable: false };

  let sorted = true;
  for (let i = 1; i < notes.length; i++) {
    if (notes[i].start < notes[i - 1].start) {
      sorted = false;
      break;
    }
  }
  if (!sorted) notes = notes.slice().sort((a, b) => a.start - b.start);

  const R = RATING_RULES;
  let lowestMidi = Infinity;
  let highestMidi = -Infinity;
  let maxLeap = 0;
  let maxLeapAt = 0;
  let longCount = 0;
  let withLyric = 0;
  for (let i = 0; i < notes.length; i++) {
    const m = notes[i].midi;
    if (m < lowestMidi) lowestMidi = m;
    if (m > highestMidi) highestMidi = m;
    if (i > 0) {
      const leap = Math.abs(m - notes[i - 1].midi);
      if (leap > maxLeap) {
        maxLeap = leap;
        maxLeapAt = notes[i].start;
      }
    }
    if (notes[i].duration >= R.longNoteSec) longCount++;
    if (notes[i].lyric.trim() !== '') withLyric++;
  }

  const rangeSemitones = highestMidi - lowestMidi;
  const peak = peakNotesPerSecond(notes, R.peakWindowSec);
  const longNoteRatio = longCount / notes.length;
  const lyricsAvailable = withLyric / notes.length >= R.minLyricCoverage;
  const melismaRate = lyricsAvailable ? melismaShare(notes) : 0;

  const reasons: DifficultyReason[] = [];
  const maxGap = 1 / R.fastNps;

  // Fast figures: runs (wide or long) or ornaments (short and narrow).
  let firstRun: DifficultyReason | null = null;
  let firstOrnament: DifficultyReason | null = null;
  for (const chain of fastChains(notes, maxGap, R.fastChainMinNotes)) {
    const count = chain.to - chain.from + 1;
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = chain.from; k <= chain.to; k++) {
      lo = Math.min(lo, notes[k].midi);
      hi = Math.max(hi, notes[k].midi);
    }
    const at = notes[chain.from].start;
    const span = notes[chain.to].start - at;
    const nps = span > 0 ? (count - 1) / span : Infinity;
    const isOrnament = count <= R.ornamentMaxNotes && hi - lo <= R.ornamentMaxSpanSemitones;
    if (isOrnament) {
      firstOrnament ??= { world: 'inflections', code: 'ornament', atSec: at, detail: `a quick ${count}-note turn or ornament near ${clock(at)}` };
    } else {
      firstRun ??= {
        world: 'runs',
        code: 'fast-run',
        atSec: at,
        detail: `${count} notes in ${span.toFixed(1)} s (${Number.isFinite(nps) ? nps.toFixed(1) : '9+'} notes/s) near ${clock(at)}`,
      };
    }
  }
  if (firstRun) reasons.push(firstRun);
  if (peak.nps >= R.fastNps) {
    reasons.push({ world: 'runs', code: 'dense-passage', atSec: peak.atSec, detail: `${peak.nps.toFixed(1)} notes per second over ${R.peakWindowSec} s near ${clock(peak.atSec)}` });
  }
  if (lyricsAvailable && melismaRate >= R.melismaHeavyShare) {
    reasons.push({ world: 'runs', code: 'melisma-heavy', detail: `${Math.round(melismaRate * 100)}% of syllables are sung across 3 or more notes` });
  }
  if (lyricsAvailable) {
    // One long melisma is Runs technique even when it is a single syllable of many (the share above is blind to it).
    const melisma = longestMelismaChain(notes, 1 / R.longMelismaNps);
    if (melisma.count >= R.longMelismaNotes) {
      const at = notes[melisma.from].start;
      reasons.push({ world: 'runs', code: 'long-melisma', atSec: at, detail: melismaCaption(melisma.count, at) });
    }
  }
  if (firstOrnament) reasons.push(firstOrnament);
  if (maxLeap > R.maxFoundationsLeap) {
    reasons.push({ world: 'inflections', code: 'wide-leap', atSec: maxLeapAt, detail: `a leap of ${maxLeap} semitones near ${clock(maxLeapAt)}` });
  }
  if (rangeSemitones >= R.wideRangeSemitones) {
    reasons.push({ world: 'inflections', code: 'wide-range', detail: `a range of ${rangeSemitones} semitones, which crosses the register break` });
  }
  if (longNoteRatio >= R.sustainedLongNoteShare) {
    reasons.push({ world: 'vibrato', code: 'sustained-style', detail: `${Math.round(longNoteRatio * 100)}% of the notes are held ${R.longNoteSec} s or longer` });
  }

  reasons.sort((a, b) => rankOf(b.world) - rankOf(a.world));
  const requiredWorld: WorldId = reasons.length > 0 ? reasons[0].world : 'foundations';

  return {
    difficulty: {
      lowestMidi,
      highestMidi,
      rangeSemitones,
      maxLeapSemitones: maxLeap,
      notesPerSec: peak.nps,
      melismaRate,
      longNoteRatio,
      requiredWorld,
    },
    reasons,
    lyricsAvailable,
  };
}

/** Rates a Song's difficulty and the world required to unlock it. Pure; never mutates `song`. */
export function rateSong(song: Song): SongDifficulty {
  return analyzeSong(song).difficulty;
}
