/**
 * Song mode contract (Phase 6). Note and phrase times are seconds on the song's own clock, song time 0 = the first
 * beat of the chart WITHOUT any #GAP (the gap is `offsetMs`, below). Song time is take time when a song starts at
 * the downbeat, which is how analysis/phrases.ts reads them.
 */
import type { WorldId } from '../exercises/types';

/** UltraStar golden-rap notes ('G') are imported as 'rap' (the golden bonus is lost). */
export type SongNoteType = 'normal' | 'golden' | 'freestyle' | 'rap';

export interface SongNote {
  start: number;
  duration: number;
  midi: number;
  /**
   * The syllable, kept verbatim from the file. '' = the note continues the previous syllable (UltraStar "~"; MIDI
   * notes without lyrics are '' too). Bundled charts start each word with a LEADING space (" grace"), so
   * concatenating a phrase's syllables gives its text; imported charts keep their own spacing, with one exception: a MIDI
   * file whose syllables hold no whitespace at all (LilyPond hymn exports) gets a leading space per syllable, except after
   * a syllable ending in '-', and the first syllable of each phrase has none (files in scripts not spaced per syllable,
   * such as Chinese, Japanese and Korean, are left verbatim; song/midi-phrases.ts). Never trim it.
   */
  lyric: string;
  type: SongNoteType;
}

export interface SongPhrase {
  start: number;
  end: number;
  /** [from, to) indices into Song.notes. */
  from: number;
  to: number;
}

export interface SongDifficulty {
  /** Absolute pitches: shift a song only with song/transpose.ts transposeSong, which keeps these in step. */
  lowestMidi: number;
  highestMidi: number;
  rangeSemitones: number;
  maxLeapSemitones: number;
  notesPerSec: number; //      peak over any 2 s window
  melismaRate: number; //      share of syllables carrying 3+ notes
  longNoteRatio: number; //    share of notes >= 1 s (vibrato-worthy)
  /** The world that must be passed (Boss Recital) before this song unlocks (SPEC §11.2). */
  requiredWorld: WorldId;
}

export interface Song {
  id: string; //                stable: hash of content for imports, slug for bundled
  title: string;
  artist: string;
  source: 'bundled' | 'ultrastar' | 'midi';
  /** Licence note for bundled songs (public domain melodies, our own charts). */
  licence?: string;
  /** The chart's #BPM: its GRID tempo (the opening tempo for MIDI). Not a tempo marking to show a singer. */
  bpm?: number;
  notes: SongNote[];
  phrases: SongPhrase[];
  /** Optional backing track stored locally (OPFS ref), never uploaded. */
  backingRef?: string | null;
  /**
   * Where in the BACKING AUDIO song time 0 falls, ms (UltraStar #GAP; for MIDI, the intro that was trimmed):
   * backing position = song time + offsetMs. Raise it if the backing sounds late. User-adjustable. Use
   * song/timing.ts (backingTimeAt, songTimeAtBacking) rather than re-deriving the sign.
   */
  offsetMs: number;
  difficulty: SongDifficulty;
}
