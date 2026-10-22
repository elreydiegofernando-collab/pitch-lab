/**
 * Where the song is, for the lyrics strip and the phrase scrubber: the phrase sounding (or, in a rest, the one coming
 * next: song/timing.ts phraseIndexAt) and the syllable sung last. Pure; the canvas loop computes it once per
 * animation frame and publishes it only when it changes.
 */
import type { PhraseRow } from '../../runtime/song-session';
import { phraseIndexAt } from '../../song/timing';
import type { Song } from '../../song/types';

export interface LyricCursor {
  /** Index into Song.phrases. */
  phrase: number;
  /** Song.notes index of the syllable begun last in that phrase; null before its first syllable. */
  note: number | null;
}

export function lyricCursor(rows: readonly PhraseRow[], song: Song, t: number): LyricCursor | null {
  const phrase = phraseIndexAt(song, t);
  const row = rows[phrase];
  if (!row) return null;
  let note: number | null = null;
  for (const s of row.syllables) {
    if (song.notes[s.note].start > t) break;
    note = s.note;
  }
  return { phrase, note };
}

export function sameCursor(a: LyricCursor | null, b: LyricCursor | null): boolean {
  return a === b || (a !== null && b !== null && a.phrase === b.phrase && a.note === b.note);
}
