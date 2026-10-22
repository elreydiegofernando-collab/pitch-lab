/** Song mode contract (Phase 6). Times are seconds from song time 0 (after GAP/offset). */
import type { WorldId } from '../exercises/types';

export type SongNoteType = 'normal' | 'golden' | 'freestyle' | 'rap';

export interface SongNote {
  start: number;
  duration: number;
  midi: number;
  lyric: string; //            syllable (may be '' for MIDI)
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
  bpm?: number;
  notes: SongNote[];
  phrases: SongPhrase[];
  /** Optional backing track stored locally (OPFS ref), never uploaded. */
  backingRef?: string | null;
  /** Backing-track offset relative to note time 0, ms (user-adjustable). */
  offsetMs: number;
  difficulty: SongDifficulty;
}
