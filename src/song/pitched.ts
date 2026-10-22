/**
 * Pitched-note view of a song.
 *
 * UltraStar marks some notes as freestyle ('F': spoken, never scored) or rap ('R'/'G':
 * rhythm only, pitch ignored); their pitch field is meaningless. analysis/phrases.ts's
 * scoreSongPhrases looks only at SongNote.midi/start/duration and ignores SongNote.type,
 * so a song-mode runner must score `pitchedView(song)` rather than the raw song, or a
 * freestyle syllable would be marked as a missed note.
 *
 * Phrase indices (SongPhrase.from/to) point into Song.notes, so dropping notes means
 * re-indexing them; this module does that, and drops phrases left with no pitched note.
 */
import type { Song, SongNote, SongPhrase } from './types';

/** True for notes whose pitch is sung and scored ('normal' and 'golden'). */
export function isPitchedNote(note: SongNote): boolean {
  return note.type === 'normal' || note.type === 'golden';
}

export interface PitchedView {
  /** Only the pitched notes, in their original order. */
  notes: SongNote[];
  /** Phrases re-indexed into `notes`; phrases without a pitched note are dropped. */
  phrases: SongPhrase[];
  /** For each entry of `notes`, its index in the original Song.notes. */
  sourceIndex: number[];
}

/** The song as the scorer should see it: pitched notes only, phrases re-indexed. Pure. */
export function pitchedView(song: Song): PitchedView {
  const notes: SongNote[] = [];
  const sourceIndex: number[] = [];
  // newIndexAt[i] = how many pitched notes come before original index i (so it maps a boundary).
  const newIndexAt = new Array<number>(song.notes.length + 1);
  for (let i = 0; i < song.notes.length; i++) {
    newIndexAt[i] = notes.length;
    if (isPitchedNote(song.notes[i])) {
      notes.push(song.notes[i]);
      sourceIndex.push(i);
    }
  }
  newIndexAt[song.notes.length] = notes.length;

  const phrases: SongPhrase[] = [];
  for (const p of song.phrases) {
    const from = newIndexAt[Math.max(0, Math.min(p.from, song.notes.length))];
    const to = newIndexAt[Math.max(0, Math.min(p.to, song.notes.length))];
    if (to > from) phrases.push({ start: p.start, end: p.end, from, to });
  }
  return { notes, phrases, sourceIndex };
}
