/**
 * The song index: bundled public-domain charts plus the active profile's imported songs, as signals.
 *
 * WAVE 2 CONTRACT STUB. Owned by the song builder, who replaces the bodies and keeps the exported names and
 * signatures (the session calls loadSongs() at boot and after a profile switch; the route guard reads songIndex).
 */
import { signal } from '@preact/signals';
import type { Song, SongDifficulty } from '../song/types';

export interface SongEntry {
  /** Song.id: the bundled slug, or the imported song's content id. */
  id: string;
  title: string;
  artist: string;
  source: Song['source'];
  bundled: boolean;
  /** Licence note of a bundled chart ("Public domain melody; chart by Pitch Lab"); null for imports. */
  licence: string | null;
  /** Absolute pitches and the required world (SPEC §11.2: the song opens once that world's Boss Recital is passed). */
  difficulty: SongDifficulty;
  /** The storage.songs record id of an imported song; null for bundled. */
  recordId: string | null;
}

export const songIndex = signal<ReadonlyMap<string, SongEntry>>(new Map());
/** False until the first loadSongs() finished (bundled charts parsed, imports listed). */
export const songsLoaded = signal(false);
/** Charts that failed to load (the rest still load). */
export const songLoadErrors = signal<ReadonlyArray<{ id: string; message: string }>>([]);

/** (Re)load the bundled library and the ACTIVE profile's imports. Never rejects. */
export function loadSongs(): Promise<void> {
  songsLoaded.value = true;
  return Promise.resolve();
}

/** The full song (notes, phrases) for an id in the index; undefined when unknown. */
export function getSong(id: string): Promise<Song | undefined> {
  void id;
  return Promise.resolve(undefined);
}
