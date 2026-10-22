/**
 * Housekeeping across the data db and the binary store: reconcile the two after a crash or
 * a browser eviction, and wipe everything on request ("delete all my data").
 */
import { markerIsCovered } from './backend-marker';
import { META_KEYS, type PitchLabDb } from './db';
import { PROFILE_KEY_PREFIX } from './keys';
import type { KVStore } from './kv-types';
import type { OpfsStore } from './opfs';
import type { SongRecord, TakeRecord } from './schema';

/** A binary younger than this might belong to a save still in flight (binary first, record second), so it is never an orphan yet. */
export const ORPHAN_MIN_AGE_MS = 60 * 1000;

/** Why a reconcile deliberately did nothing (see `ReconcileReport.skipped`). */
export type ReconcileSkipReason = 'db-not-durable' | 'binaries-not-durable' | 'backend-changed';

export interface ReconcileReport {
  /** Files with no record pointing at them (debris of a crash between the binary write and the record write), now deleted. */
  orphanFilesRemoved: number;
  /** Takes whose audio file is gone (browser eviction, manual clearing): `audioRef` reset to null. */
  danglingTakes: number;
  /** Songs whose backing-track file is gone: `backingRef` reset to null. */
  danglingSongs: number;
  /**
   * Present only when reconcile did NOTHING because it could not trust what it saw (the counts are then all
   * zero). `db-not-durable`: the data db fell back to memory, so the records are not the real ones.
   * `binaries-not-durable`: the binary store is memory, so the files are not the real ones.
   * `backend-changed`: files were written to a backend this launch cannot read (see backend-marker.ts).
   * Diagnostics can say why; the next launch that sees the real data reconciles normally.
   */
  skipped?: ReconcileSkipReason;
}

function skipped(reason: ReconcileSkipReason): ReconcileReport {
  return { orphanFilesRemoved: 0, danglingTakes: 0, danglingSongs: 0, skipped: reason };
}

/**
 * Makes records and binaries agree. Safe to run at any time: it only deletes files no record
 * references AND that are older than `minAgeMs`, and only clears a reference when a full listing
 * of the binary store proves the file is not there. If the listing itself fails, nothing changes.
 *
 * It judges the files by what it can SEE, so it first makes sure that is the real picture, and does
 * nothing (reporting why in `skipped`) when it is not: a data db that fell back to memory has none of
 * the real records, a memory binary store none of the real files, and a launch that cannot read a
 * backend the files were written to would otherwise delete every real recording as an "orphan" or
 * null every reference as "dangling". Run it once per launch, off the critical path.
 */
export async function reconcileBinaries(
  db: PitchLabDb,
  opfs: OpfsStore,
  opts: { minAgeMs?: number; now?: number } = {},
): Promise<ReconcileReport> {
  if (!db.persistent) return skipped('db-not-durable');
  if (!opfs.persistent) return skipped('binaries-not-durable');
  if (!(await markerIsCovered(db, opfs))) return skipped('backend-changed');

  const minAgeMs = opts.minAgeMs ?? ORPHAN_MIN_AGE_MS;
  const now = opts.now ?? Date.now();
  const takesStore = db.store<TakeRecord>('takes');
  const songsStore = db.store<SongRecord>('songs');

  // Records first, files second. A take saved in between then shows up as a young unreferenced file
  // (protected by minAgeMs), never as a record whose file seems to be missing.
  const takes = await takesStore.getAll();
  const songs = await songsStore.getAll();
  const present = new Set(await opfs.list()); // throws -> reconcile aborts with no change

  const referenced = new Set<string>();
  for (const t of takes) if (t.audioRef) referenced.add(t.audioRef);
  for (const s of songs) if (s.song.backingRef) referenced.add(s.song.backingRef);

  let orphanFilesRemoved = 0;
  for (const path of present) {
    if (referenced.has(path)) continue;
    try {
      const before = await opfs.stat(path);
      if (before && now - before.modifiedAt < minAgeMs) continue;
      await opfs.delete(path);
      // delete() is best-effort: count the file only if it is really gone, and never let one
      // stubborn file stop the rest of the pass (it is retried on the next launch).
      if (before && !(await opfs.stat(path))) orphanFilesRemoved += 1;
    } catch {
      // retried on the next launch
    }
  }

  let danglingTakes = 0;
  for (const t of takes) {
    if (!t.audioRef || present.has(t.audioRef)) continue;
    // Only if the record is still as we read it (it may have been evicted or re-saved since).
    const cleared = await takesStore.update(t.id, (current) => (current && current.audioRef === t.audioRef ? { ...current, audioRef: null } : undefined));
    if (cleared) danglingTakes += 1;
  }

  let danglingSongs = 0;
  for (const s of songs) {
    const ref = s.song.backingRef;
    if (!ref || present.has(ref)) continue;
    const cleared = await songsStore.update(s.id, (current) =>
      current && current.song.backingRef === ref ? { ...current, song: { ...current.song, backingRef: null } } : undefined,
    );
    if (cleared) danglingSongs += 1;
  }

  return { orphanFilesRemoved, danglingTakes, danglingSongs };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Deletes every profile, attempt, take, song and binary, plus every per-profile KV entry
 * (settings). Keeps what describes the DEVICE rather than the singers: this device's id and
 * clock (so later writes still sort after everything ever written), the schema version, and
 * `device:settings` (latency calibration, route). The next launch's migration creates a
 * fresh default profile, as on a first run.
 *
 * Binaries go FIRST: the audio is the sensitive part, so a kill midway leaves records without audio,
 * never audio without records. The records and keys are cleared regardless of how that went, then the
 * binary store is listed again and the call REJECTS if any file (or any step) survived, so "delete all
 * my data" never reports success with a recording still on the device. What was cleared stays cleared;
 * a leftover file has no record pointing at it, and the next reconcile removes it.
 */
export async function wipeAllData(db: PitchLabDb, opfs: OpfsStore, kv?: KVStore): Promise<void> {
  const problems: string[] = [];
  let first: unknown;
  const note = (what: string, err: unknown): void => {
    problems.push(`${what}: ${errorText(err)}`);
    first ??= err;
  };

  try {
    for (const path of await opfs.list()) {
      try {
        await opfs.delete(path);
      } catch {
        // the re-listing below reports whatever is left
      }
    }
  } catch (err) {
    note('could not list the recordings', err);
  }

  try {
    for (const name of ['profiles', 'attempts', 'takes', 'songs'] as const) await db.store(name).clear();
    const meta = db.store('meta');
    await meta.delete(META_KEYS.activeProfileId);
    await meta.delete(META_KEYS.migrationV1);
    await meta.delete(META_KEYS.binaryBackend); // no record points at a file any more
  } catch (err) {
    note('could not clear the database', err);
  }

  if (kv) {
    try {
      for (const key of await kv.keys(PROFILE_KEY_PREFIX)) await kv.delete(key);
    } catch (err) {
      note('could not clear the settings', err);
    }
  }

  try {
    const left = await opfs.list();
    if (left.length > 0) note(`${left.length} recording file(s) could not be deleted`, new Error(`first: ${left[0]}`));
  } catch (err) {
    note('could not confirm that the recordings are gone', err);
  }

  if (problems.length > 0) throw new Error(`wipeAllData incomplete - ${problems.join('; ')}`, { cause: first });
}
