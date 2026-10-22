/**
 * The song index: the bundled public-domain charts plus the ACTIVE profile's imported songs, as signals.
 *
 * The session calls loadSongs() at boot and after a profile switch; the route guard reads songIndex (a song's
 * required world) and songsLoaded; the Song Stage screens read the rest. Bundled charts come from
 * song/library.ts (fetched once, memoised); imports come from storage.songs for the active profile. Full songs
 * stay in memory for getSong, except that an import is re-read from storage so a changed offset or backing track
 * is never stale.
 *
 * Fail closed: when the active profile changes, the previous singer's imports leave the index at once (before the
 * reload finishes), so a guard check in between can never open another singer's song.
 */
import { batch, signal } from '@preact/signals';
import { analyzeSong } from '../song/difficulty';
import { getBundledLibrary } from '../song/library';
import { songDurationSec } from '../song/timing';
import type { Song, SongDifficulty } from '../song/types';
import type { SongRecord } from '../storage/schema';
import { activeProfile, appStorage } from './session';

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
  /** Song time at which the last note ends (the library's "1:40"). Always set by loadSongs. */
  durationSec?: number;
  /**
   * The strongest difficulty finding (song/difficulty.ts analyzeSong, `reasons[0].detail`), e.g. "a 16-note melisma
   * near 0:05"; null when nothing lifts the song out of Foundations. Always set by loadSongs.
   */
  caption?: string | null;
}

export const songIndex = signal<ReadonlyMap<string, SongEntry>>(new Map());
/** False until the first loadSongs() finished (bundled charts parsed, imports listed). */
export const songsLoaded = signal(false);
/** Charts that failed to load (the rest still load). */
export const songLoadErrors = signal<ReadonlyArray<{ id: string; message: string }>>([]);

/** Full songs by id, for getSong. Replaced (never mutated) by each finished load. */
let fullSongs: ReadonlyMap<string, Song> = new Map();
/** Each load takes a number; only the latest one may publish its result. */
let generation = 0;
/** The profile whose imports the index holds; undefined before the first load. */
let indexedProfile: string | null | undefined;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function entryFor(song: Song, recordId: string | null): SongEntry {
  const reasons = analyzeSong(song).reasons;
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    source: song.source,
    bundled: recordId === null,
    licence: recordId === null ? (song.licence ?? null) : null,
    difficulty: song.difficulty,
    recordId,
    durationSec: songDurationSec(song),
    caption: reasons.length > 0 ? reasons[0].detail : null,
  };
}

/** Drop every imported entry at once (the bundled ones stay valid for any profile). */
function dropImports(): void {
  const kept = new Map<string, SongEntry>();
  for (const [id, entry] of songIndex.value) if (entry.bundled) kept.set(id, entry);
  const songs = new Map<string, Song>();
  for (const [id, song] of fullSongs) if (kept.has(id)) songs.set(id, song);
  fullSongs = songs;
  songIndex.value = kept;
}

async function load(gen: number, profileId: string | null): Promise<void> {
  const errors: Array<{ id: string; message: string }> = [];
  let bundled: Song[] = [];
  try {
    const library = await getBundledLibrary();
    bundled = library.songs;
    errors.push(...library.errors);
  } catch (err) {
    errors.push({ id: 'songs/index.json', message: messageOf(err) });
  }

  let imported: SongRecord[] = [];
  const storage = appStorage.value;
  if (storage && profileId !== null) {
    try {
      imported = await storage.songs.listByProfile(profileId);
    } catch (err) {
      errors.push({ id: 'imported songs', message: messageOf(err) });
    }
  }
  if (gen !== generation) return; // a newer load (another profile, or a retry) owns the index now

  const index = new Map<string, SongEntry>();
  const songs = new Map<string, Song>();
  const add = (song: Song, recordId: string | null): void => {
    try {
      if (index.has(song.id)) throw new Error('Another song in the library has the same id; this one was skipped.');
      index.set(song.id, entryFor(song, recordId));
      songs.set(song.id, song);
    } catch (err) {
      errors.push({ id: song.title || song.id, message: messageOf(err) });
    }
  };
  for (const song of bundled) add(song, null);
  for (const record of imported) add(record.song, record.id);

  fullSongs = songs;
  indexedProfile = profileId;
  batch(() => {
    songIndex.value = index;
    songLoadErrors.value = errors;
    songsLoaded.value = true;
  });
}

/** (Re)load the bundled library and the ACTIVE profile's imports. Never rejects; every call reloads. */
export function loadSongs(): Promise<void> {
  const profileId = activeProfile.value?.id ?? null;
  const gen = ++generation;
  if (indexedProfile !== undefined && indexedProfile !== profileId) dropImports();
  return load(gen, profileId).catch((err: unknown) => {
    if (gen !== generation) return;
    batch(() => {
      songLoadErrors.value = [{ id: 'library', message: messageOf(err) }];
      songsLoaded.value = true;
    });
  });
}

/** The full song (notes, phrases) for an id in the index; undefined when unknown. */
export async function getSong(id: string): Promise<Song | undefined> {
  const entry = songIndex.value.get(id);
  if (!entry) return undefined;
  const storage = appStorage.value;
  if (entry.recordId !== null && storage) {
    // An import is read fresh: its offset and backing track can change after the index was built, and a deleted
    // one is gone.
    try {
      return (await storage.songs.get(entry.recordId))?.song;
    } catch {
      // Storage could not answer: fall back to the copy the index was built from.
    }
  }
  return fullSongs.get(id);
}
