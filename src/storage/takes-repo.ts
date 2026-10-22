/**
 * Take records (schema.ts TakeRecord): the recorded pitch track plus, optionally,
 * the take's own audio in the binary store (storage/opfs.ts). Takes are local-only
 * (schema.ts keeps them out of BackupFile and SYNCABLE on purpose), so unlike
 * profiles/attempts they are hard-deleted - binary included - and carry no tombstone.
 *
 * Order matters for crash safety: the binary is written BEFORE the record, so a crash
 * in between leaves at worst an orphan file (swept by maintenance.ts `reconcileBinaries`),
 * never a record pointing at audio that does not exist.
 *
 * Audio is optional by design: if the device is out of space the oldest audio is evicted
 * and the write retried, and if that still fails the take is saved WITHOUT audio
 * (`audioRef: null`). The pitch track and the attempt that references the take matter
 * more than the recording, and must never be lost to it.
 *
 * Deleting audio is a promise to the singer, so it is verified (opfs.ts `deleteConfirmed`): a
 * file that refuses to go keeps its record, the delete rejects, and a retry can finish the job.
 *
 * `updatedAt` of a take is its SAVE order (an HLC stamp from when it was saved) and is
 * never bumped afterwards - not even when its audio is evicted - because retention
 * evicts oldest-first by it. Takes are never merged between devices, so there is no
 * last-write-wins meaning to preserve.
 *
 * CONTRACT ISSUE: src/config.ts has no storage/retention knob. Until one exists (e.g.
 * `CONFIG.storage.takeRetention`), DEFAULT_TAKE_RETENTION below is a clearly named local default.
 */
import type { PitchLabDb } from './db';
import { isQuotaError } from './idb';
import { newId } from './ids';
import { deleteConfirmed, type BinaryData, type OpfsStore } from './opfs';
import type { TakeRecord } from './schema';
import { isStoredTrack } from './track-codec';

const STORE = 'takes';

export interface TakeRetention {
  /** Takes kept per profile. Older ones are deleted outright (record and audio). Infinity = no cap. */
  maxTakesPerProfile: number;
  /** Audio bytes kept across all profiles. Older takes lose their AUDIO (their pitch track stays) until under budget. Infinity = no cap. */
  maxAudioBytes: number;
}

export const DEFAULT_TAKE_RETENTION: Readonly<TakeRetention> = Object.freeze({
  maxTakesPerProfile: 20,
  maxAudioBytes: 200 * 1024 * 1024,
});

/**
 * Write attempts per save when the device reports it is out of space. Each failed attempt but the last
 * first evicts the oldest recording to make room, so at most MAX - 1 recordings are ever sacrificed.
 */
const MAX_AUDIO_WRITE_ATTEMPTS = 4;

/**
 * Pre-allocated ids of saves in flight, as `<device id>:<take id>` so two databases never collide. The
 * audio path derives from the id, so two overlapping saves of one id (a double tap, a retry while the
 * first is running) would share one file, and whichever failed would delete the other's audio.
 */
const savingIds = new Set<string>();

/** A caller-chosen take id becomes part of a file name, so it must be plain (a UUID always is). */
const TAKE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function limit(value: unknown, fallback: number, integer: boolean): number {
  if (value === Infinity) return Infinity;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return integer ? Math.max(1, Math.floor(value)) : value;
}

/** Fills in defaults; non-positive or non-numeric limits fall back to them, Infinity disables a limit. */
export function resolveTakeRetention(partial: Partial<TakeRetention> = {}): TakeRetention {
  return {
    maxTakesPerProfile: limit(partial.maxTakesPerProfile, DEFAULT_TAKE_RETENTION.maxTakesPerProfile, true),
    maxAudioBytes: limit(partial.maxAudioBytes, DEFAULT_TAKE_RETENTION.maxAudioBytes, false),
  };
}

export function takeAudioPath(takeId: string): string {
  return `takes/${takeId}.wav`;
}

export interface SaveTakeInput {
  /**
   * Optional pre-allocated id (`newId()` from ids.ts). Lets a caller write the ATTEMPT that
   * references this take first - it is durable the moment it resolves - and save the (slower,
   * larger) take afterwards. Rejects if a take with this id already exists, or is being saved at
   * this moment (a double tap): the first save owns the id, the second never touches its audio.
   */
  id?: string;
  profileId: string;
  exerciseId: string;
  /** Encoded with track-codec.ts `encodeTrack`. */
  track: TakeRecord['track'];
  /** Omit or pass null to keep the pitch track only (no audio). */
  audio?: BinaryData | null;
  sampleRate: number | null;
  latencyMs: number;
}

export interface SaveTakeOptions {
  retention?: Partial<TakeRetention>;
}

function byteLength(data: BinaryData): number {
  return data instanceof Blob ? data.size : data.byteLength;
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`takes-repo: ${field} must be a non-empty string`);
  return value;
}

/**
 * Saves a take durably and enforces retention. Resolves with the stored record; check
 * `audioRef` to learn whether the audio was kept. Rejects, storing nothing, only for invalid
 * input or when the record itself cannot be written.
 */
export async function saveTake(db: PitchLabDb, opfs: OpfsStore, input: SaveTakeInput, opts: SaveTakeOptions = {}): Promise<TakeRecord> {
  const profileId = requireId(input.profileId, 'profileId');
  const exerciseId = requireId(input.exerciseId, 'exerciseId');
  if (!isStoredTrack(input.track)) throw new TypeError('takes-repo: invalid track');
  if (typeof input.latencyMs !== 'number' || !Number.isFinite(input.latencyMs)) throw new TypeError('takes-repo: latencyMs must be a finite number');
  const sampleRate = typeof input.sampleRate === 'number' && Number.isFinite(input.sampleRate) ? input.sampleRate : null;

  if (input.id === undefined) return persistTake(db, opfs, newId(), { ...input, profileId, exerciseId, sampleRate }, opts);

  if (typeof input.id !== 'string' || !TAKE_ID_RE.test(input.id)) throw new TypeError('takes-repo: id must be 1-128 letters, digits, dashes or underscores');
  const id = input.id;
  // Claimed before the first await, so the second of two overlapping saves stops here, before it can touch the shared audio path.
  const claim = `${db.deviceId}:${id}`;
  if (savingIds.has(claim)) throw new Error(`takes-repo: a take with id ${id} is already being saved`);
  savingIds.add(claim);
  try {
    // Checked BEFORE any audio is written: the audio path is derived from the id, so writing first
    // would overwrite the existing take's recording.
    if (await db.store<TakeRecord>(STORE).get(id)) throw new Error(`takes-repo: a take with id ${id} already exists`);
    return await persistTake(db, opfs, id, { ...input, profileId, exerciseId, sampleRate }, opts);
  } finally {
    savingIds.delete(claim);
  }
}

/** The write half of `saveTake`: `input` is already validated and normalised, and `id` is settled. */
async function persistTake(db: PitchLabDb, opfs: OpfsStore, id: string, input: SaveTakeInput, opts: SaveTakeOptions): Promise<TakeRecord> {
  const audioRef = input.audio && byteLength(input.audio) > 0 ? await writeAudio(db, opfs, id, input.audio) : null;

  const record: TakeRecord = {
    id,
    profileId: input.profileId,
    createdAt: db.nowIso(),
    updatedAt: db.nextTimestamp(),
    deletedAt: null,
    exerciseId: input.exerciseId,
    track: input.track,
    audioRef,
    sampleRate: input.sampleRate,
    latencyMs: input.latencyMs,
  };
  try {
    await db.store<TakeRecord>(STORE).add(record, id);
  } catch (err) {
    if (audioRef && !(await recordOwnsAudio(db, id, audioRef))) await opfs.delete(audioRef).catch(() => {});
    throw err;
  }

  // Housekeeping must never fail a save that already succeeded.
  try {
    await enforceRetention(db, opfs, input.profileId, resolveTakeRetention(opts.retention), id);
  } catch {
    // retried on the next save
  }
  return record;
}

/**
 * Whether a stored take already points at `audioRef`. After a failed `add`, the file is only ours to
 * remove when nobody else's record owns it (a ConstraintError means another save won the id, and its
 * audio sits at this very path). If that cannot be told, the file is kept: an orphan is swept later by
 * reconcile, a wrongly deleted recording is gone for good.
 */
async function recordOwnsAudio(db: PitchLabDb, id: string, audioRef: string): Promise<boolean> {
  try {
    return (await db.store<TakeRecord>(STORE).get(id))?.audioRef === audioRef;
  } catch {
    return true;
  }
}

async function writeAudio(db: PitchLabDb, opfs: OpfsStore, takeId: string, audio: BinaryData): Promise<string | null> {
  const path = takeAudioPath(takeId);
  for (let attempt = 0; attempt < MAX_AUDIO_WRITE_ATTEMPTS; attempt++) {
    try {
      await opfs.write(path, audio);
      return path;
    } catch (err) {
      if (!isQuotaError(err)) return null; // degrade: keep the take, lose only its audio
      if (attempt === MAX_AUDIO_WRITE_ATTEMPTS - 1) return null; // out of attempts: do not sacrifice a recording for a write that will not happen
      if (!(await evictOldestAudio(db, opfs, takeId))) return null;
    }
  }
  return null;
}

/** A take, or undefined if it does not exist. */
export async function getTake(db: PitchLabDb, id: string): Promise<TakeRecord | undefined> {
  const take = await db.store<TakeRecord>(STORE).get(id);
  return take && take.deletedAt === null ? take : undefined;
}

/** Reads a take's audio back from the binary store; undefined if it never kept any (or it was evicted). */
export async function getTakeAudio(opfs: OpfsStore, take: Pick<TakeRecord, 'audioRef'>): Promise<Blob | undefined> {
  return take.audioRef ? opfs.read(take.audioRef) : undefined;
}

/** A profile's kept takes, oldest first (see the module doc on why `updatedAt` is the save order). */
export async function listTakesByProfile(db: PitchLabDb, profileId: string): Promise<TakeRecord[]> {
  const rows = await db.store<TakeRecord>(STORE).getAllByIndex('profileId', profileId);
  return sortBySaveOrder(rows.filter((t) => t.deletedAt === null));
}

async function allTakesOldestFirst(db: PitchLabDb): Promise<TakeRecord[]> {
  return sortBySaveOrder((await db.store<TakeRecord>(STORE).getAll()).filter((t) => t.deletedAt === null));
}

/**
 * Removes a take's binary (if any) and then its record. Deleting a missing take is a no-op. The binary
 * must really be gone first (see `deleteConfirmed`): if it is not, this rejects and the record stays, so
 * the singer is told and a retry can finish.
 */
export async function deleteTake(db: PitchLabDb, opfs: OpfsStore, id: string): Promise<void> {
  const existing = await db.store<TakeRecord>(STORE).get(id);
  // Binary first: the audio is the sensitive part, so it must be gone even if the record delete fails.
  if (existing?.audioRef) await deleteConfirmed(opfs, existing.audioRef);
  await db.store<TakeRecord>(STORE).delete(id);
}

/**
 * Deletes every take (record and audio) a profile has. Returns how many were removed. A take that
 * cannot be deleted does not stop the others; the first failure is rethrown once all were tried.
 */
export async function deleteTakesByProfile(db: PitchLabDb, opfs: OpfsStore, profileId: string): Promise<number> {
  const takes = await db.store<TakeRecord>(STORE).getAllByIndex('profileId', profileId);
  let failed = false;
  let failure: unknown;
  for (const take of takes) {
    try {
      await deleteTake(db, opfs, take.id);
    } catch (err) {
      if (!failed) failure = err;
      failed = true;
    }
  }
  if (failed) throw failure;
  return takes.length;
}

/** Drops a take's audio but keeps its record and pitch track. Rejects (record untouched) if the file will not go. */
async function stripAudio(db: PitchLabDb, opfs: OpfsStore, take: TakeRecord): Promise<void> {
  if (!take.audioRef) return;
  await deleteConfirmed(opfs, take.audioRef);
  await db.store<TakeRecord>(STORE).update(take.id, (t) => (t && t.audioRef ? { ...t, audioRef: null } : undefined));
}

/**
 * Frees the audio of the oldest take that still has some (never `exceptId`). False if there is none to
 * free, or if freeing it failed: a delete that fails just ends the eviction, and the new take is saved without audio.
 */
async function evictOldestAudio(db: PitchLabDb, opfs: OpfsStore, exceptId: string): Promise<boolean> {
  const victim = (await allTakesOldestFirst(db)).find((t) => t.audioRef && t.id !== exceptId);
  if (!victim) return false;
  try {
    await stripAudio(db, opfs, victim);
  } catch {
    return false;
  }
  return true;
}

async function enforceRetention(db: PitchLabDb, opfs: OpfsStore, profileId: string, retention: TakeRetention, keepId: string): Promise<void> {
  // 1. Per-profile count cap: delete the oldest takes outright. One that will not delete is skipped (it is
  //    retried by the next save) so it cannot keep the rest from being trimmed.
  if (Number.isFinite(retention.maxTakesPerProfile)) {
    const mine = await listTakesByProfile(db, profileId); // oldest first
    const overflow = mine.length - retention.maxTakesPerProfile;
    for (let i = 0; i < overflow; i++) {
      if (mine[i].id === keepId) continue;
      try {
        await deleteTake(db, opfs, mine[i].id);
      } catch {
        // retried on the next save
      }
    }
  }

  // 2. Global audio budget: strip the audio (not the track) of the oldest takes until under it.
  if (Number.isFinite(retention.maxAudioBytes)) {
    const withAudio = (await allTakesOldestFirst(db)).filter((t) => t.audioRef);
    const sizes = await Promise.all(withAudio.map(async (t) => (await opfs.stat(t.audioRef as string))?.size ?? 0));
    let total = sizes.reduce((sum, s) => sum + s, 0);
    for (let i = 0; i < withAudio.length && total > retention.maxAudioBytes; i++) {
      if (withAudio[i].id === keepId) continue; // never evict the take that was just saved
      try {
        await stripAudio(db, opfs, withAudio[i]);
        total -= sizes[i];
      } catch {
        // stuck file: leave this take as it is and try the next oldest
      }
    }
  }
}

function sortBySaveOrder(rows: TakeRecord[]): TakeRecord[] {
  return rows.sort((a, b) => (a.updatedAt !== b.updatedAt ? (a.updatedAt < b.updatedAt ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
