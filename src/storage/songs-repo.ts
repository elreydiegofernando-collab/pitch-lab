/**
 * Song records (schema.ts SongRecord): a song the singer imported (UltraStar or MIDI)
 * plus its optional backing-track binary (storage/opfs.ts, never uploaded). Bundled
 * songs are not stored here - they ship in the app. Like takes, songs are local-only
 * (user-imported content, kept out of SYNCABLE), so deleting one really deletes it,
 * backing track included.
 *
 * Importing is an upsert on (profileId, `Song.id`): `Song.id` is a content hash for
 * imports, so importing the same file twice refreshes the one record instead of
 * duplicating it, and keeps the backing-track offset the singer calibrated.
 *
 * As with takes, the binary is written before the record, so a crash never leaves a
 * record pointing at a file that is not there. A backing track that cannot be stored
 * (out of space) rejects the import: the singer asked for it explicitly and should hear why.
 */
import type { Song } from '../song/types';
import type { PitchLabDb } from './db';
import { newId } from './ids';
import { deleteConfirmed, type BinaryData, type OpfsStore } from './opfs';
import type { SongRecord } from './schema';

const STORE = 'songs';

export function songBackingPath(recordId: string): string {
  return `songs/${recordId}.backing`;
}

function byteLength(data: BinaryData): number {
  return data instanceof Blob ? data.size : data.byteLength;
}

/** Runs imports one at a time so a double tap cannot create two records for one song. */
let importQueue: Promise<unknown> = Promise.resolve();
function serially<T>(task: () => Promise<T>): Promise<T> {
  const run = importQueue.then(task, task);
  importQueue = run.catch(() => {});
  return run;
}

function requireSong(song: unknown): Song {
  const s = song as Partial<Song> | null | undefined;
  if (!s || typeof s !== 'object' || typeof s.id !== 'string' || s.id.length === 0 || typeof s.title !== 'string' || !Array.isArray(s.notes)) {
    throw new TypeError('songs-repo: not a song (needs id, title and notes)');
  }
  return s as Song;
}

/**
 * Imports (or re-imports) a song for a profile. `backingTrack`, if given, is stored and
 * `song.backingRef` is set to point at it. A `backingRef` on the input is ignored: the repo
 * owns that path, and a caller-supplied one could dangle.
 */
export function importSong(
  db: PitchLabDb,
  opfs: OpfsStore,
  profileId: string,
  song: Song,
  backingTrack?: BinaryData | null,
): Promise<SongRecord> {
  return serially(async () => {
    if (typeof profileId !== 'string' || profileId.length === 0) throw new TypeError('songs-repo: profileId must be a non-empty string');
    const incoming = requireSong(song);
    const existing = await findSongByContentId(db, profileId, incoming.id);
    const id = existing?.id ?? newId();

    let backingRef: string | null = existing?.song.backingRef ?? null;
    if (backingTrack && byteLength(backingTrack) > 0) {
      const path = songBackingPath(id);
      await opfs.write(path, backingTrack);
      backingRef = path;
    }

    const record: SongRecord = {
      id,
      profileId,
      createdAt: existing?.createdAt ?? db.nowIso(),
      updatedAt: db.nextTimestamp(),
      deletedAt: null,
      song: { ...incoming, backingRef, offsetMs: existing ? existing.song.offsetMs : incoming.offsetMs },
    };
    await db.store<SongRecord>(STORE).put(record, id);
    return record;
  });
}

export async function getSong(db: PitchLabDb, id: string): Promise<SongRecord | undefined> {
  const record = await db.store<SongRecord>(STORE).get(id);
  return record && record.deletedAt === null ? record : undefined;
}

/** The profile's record for a song, looked up by the song's own (content-hash) id. */
export async function findSongByContentId(db: PitchLabDb, profileId: string, songId: string): Promise<SongRecord | undefined> {
  const rows = await db.store<SongRecord>(STORE).getAllByIndex('profileId', profileId);
  return rows.find((r) => r.deletedAt === null && r.song.id === songId);
}

/** A profile's imported songs, alphabetical by title (case-insensitive). */
export async function listSongsByProfile(db: PitchLabDb, profileId: string): Promise<SongRecord[]> {
  const rows = (await db.store<SongRecord>(STORE).getAllByIndex('profileId', profileId)).filter((r) => r.deletedAt === null);
  return rows.sort((a, b) => {
    const ta = a.song.title.toLowerCase();
    const tb = b.song.title.toLowerCase();
    return ta !== tb ? (ta < tb ? -1 : 1) : a.id < b.id ? -1 : 1;
  });
}

/** Updates the backing-track offset the singer calibrated for this song. Rejects for a missing song. */
export async function updateSongOffset(db: PitchLabDb, id: string, offsetMs: number): Promise<SongRecord> {
  if (typeof offsetMs !== 'number' || !Number.isFinite(offsetMs)) throw new TypeError('songs-repo: offsetMs must be a finite number');
  const updated = await db.store<SongRecord>(STORE).update(id, (existing) => {
    if (!existing || existing.deletedAt !== null) throw new Error(`songs-repo: no such song ${id}`);
    return { ...existing, song: { ...existing.song, offsetMs }, updatedAt: db.nextTimestamp() };
  });
  if (!updated) throw new Error(`songs-repo: no such song ${id}`); // unreachable: the callback always writes or throws
  return updated;
}

/** Adds, replaces (a Blob/buffer) or removes (null) a song's backing track. Rejects for a missing song. */
export async function setSongBacking(db: PitchLabDb, opfs: OpfsStore, id: string, backing: BinaryData | null): Promise<SongRecord> {
  const existing = await getSong(db, id);
  if (!existing) throw new Error(`songs-repo: no such song ${id}`);

  let backingRef: string | null = null;
  if (backing && byteLength(backing) > 0) {
    backingRef = songBackingPath(id);
    await opfs.write(backingRef, backing);
  } else if (existing.song.backingRef) {
    await deleteConfirmed(opfs, existing.song.backingRef); // still there: reject with the reference intact, not a silent orphan
  }
  const updated = await db.store<SongRecord>(STORE).update(id, (current) => {
    if (!current || current.deletedAt !== null) throw new Error(`songs-repo: no such song ${id}`);
    return { ...current, song: { ...current.song, backingRef }, updatedAt: db.nextTimestamp() };
  });
  if (!updated) throw new Error(`songs-repo: no such song ${id}`);
  return updated;
}

/**
 * Removes a song's backing-track binary (if any) and then its record. Deleting a missing song is a
 * no-op. If the binary will not go (see `deleteConfirmed`) this rejects and the record stays, so a retry can finish.
 */
export async function deleteSong(db: PitchLabDb, opfs: OpfsStore, id: string): Promise<void> {
  const existing = await db.store<SongRecord>(STORE).get(id);
  if (existing?.song.backingRef) await deleteConfirmed(opfs, existing.song.backingRef);
  await db.store<SongRecord>(STORE).delete(id);
}
