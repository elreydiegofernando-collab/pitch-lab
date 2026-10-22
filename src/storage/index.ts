/**
 * Storage facade: the ONE entry point the app uses for Phase 3+ data.
 *
 *   const storage = await getStorage();            // opened once, shared
 *   const me = await storage.profiles.active();    // never undefined: a default profile always exists
 *   await storage.attempts.add({ profileId: me.id, ... });   // committed to disk before it resolves
 *
 * `openStorage()` opens the data db (db.ts), the binary store (opfs.ts) and the Phase 1
 * settings KV (kv.ts) - each falling back to memory by itself, so it does not reject - runs
 * the Phase 1 -> Phase 3 migration (migrate.ts, idempotent), and guarantees an active
 * profile. Everything under `storage.<repo>` is the repo module bound to those handles; the
 * modules themselves (profiles-repo.ts, attempts-repo.ts, ...) stay importable for tests and
 * pure code.
 *
 * Check `storage.persistent` and warn the singer when it is false: some layer fell back to
 * memory (private browsing, blocked storage) and nothing will survive a reload.
 *
 * Call `storage.reconcile()` once per launch, off the critical path (never awaited before the first
 * screen): it repairs records and files after a crash or an eviction. It deliberately does nothing,
 * and says why in `report.skipped`, when this launch cannot see the real data (a layer fell back to
 * memory, or the binary backend changed), so a degraded launch can never delete anything.
 */
import { withBackendMarker } from './backend-marker';
import { backupFileName, exportBackup, exportBackupJson, importBackup, type ImportOptions, type ImportReport } from './backup';
import {
  addAttempt,
  getAttempt,
  listAttemptsByExercise,
  listAttemptsByProfile,
  type AttemptQueryOptions,
  type NewAttempt,
} from './attempts-repo';
import { openDb, type PitchLabDb } from './db';
import { openKV } from './kv';
import type { KVStore } from './kv-types';
import { reconcileBinaries, wipeAllData, type ReconcileReport, type ReconcileSkipReason } from './maintenance';
import { migrateFromV1, type MigrationReport } from './migrate';
import { openOpfs, type BinaryData, type OpfsBackend, type OpfsStore } from './opfs';
import {
  createProfile,
  deleteProfile,
  getActiveProfile,
  getActiveProfileId,
  getProfile,
  listProfiles,
  restoreProfile,
  setActiveProfileId,
  updateProfile,
  type CreateProfileInput,
  type ProfilePatch,
  type VoiceType,
} from './profiles-repo';
import type { AttemptRecord, BackupFile, ProfileRecord, SongRecord, TakeRecord, VocalRange } from './schema';
import {
  deleteSong,
  deleteSongsByProfile,
  findSongByContentId,
  getSong,
  importSong,
  listSongsByProfile,
  setSongBacking,
  updateSongOffset,
} from './songs-repo';
import {
  DEFAULT_TAKE_RETENTION,
  deleteTake,
  deleteTakesByProfile,
  getTake,
  getTakeAudio,
  listTakesByProfile,
  resolveTakeRetention,
  saveTake,
  type SaveTakeInput,
  type TakeRetention,
} from './takes-repo';
import type { Song } from '../song/types';

// One import path for everything a screen needs: `import { getStorage, encodeTrack, ... } from '../storage'`.
export type {
  AttemptQueryOptions,
  BinaryData,
  CreateProfileInput,
  ImportOptions,
  ImportReport,
  MigrationReport,
  NewAttempt,
  OpfsBackend,
  ProfilePatch,
  ReconcileReport,
  ReconcileSkipReason,
  SaveTakeInput,
  TakeRetention,
  VoiceType,
};
export { DEFAULT_TAKE_RETENTION };
export { encodeTrack, decodeTrack } from './track-codec';
export { DEVICE_SETTINGS_KEY, profileSettingsKey } from './keys';
/** Validates a stored settings object key by key (see backup.ts): use it when READING `profile:<id>:settings` too. */
export { sanitizeSettings } from './backup';
export { isQuotaError } from './idb';
/** A fresh record id, for pre-allocating a take id (SaveTakeInput.id) before its attempt is written. */
export { newId } from './ids';

export interface ProfilesApi {
  /** Live profiles in creation order (`includeDeleted` adds tombstones). */
  list(opts?: { includeDeleted?: boolean }): Promise<ProfileRecord[]>;
  get(id: string, opts?: { includeDeleted?: boolean }): Promise<ProfileRecord | undefined>;
  /** Creates a profile; it becomes the active one if none is. */
  create(input: CreateProfileInput): Promise<ProfileRecord>;
  update(id: string, patch: ProfilePatch): Promise<ProfileRecord>;
  rename(id: string, name: string): Promise<ProfileRecord>;
  setRange(id: string, range: VocalRange | null): Promise<ProfileRecord>;
  setVoiceType(id: string, voiceType: VoiceType): Promise<ProfileRecord>;
  /**
   * Soft delete (undoable with `restore`). Attempts are kept. With `removeRecordings`, the
   * profile's takes and their audio, and the songs it imported with their backing tracks, are deleted for good
   * (rejects, keeping the profile, if a file would not delete). Without it they are kept, so a restored profile gets
   * them back. If it was the active profile, another live one is selected, or a fresh default is created when it was
   * the last.
   */
  delete(id: string, opts?: { removeRecordings?: boolean }): Promise<void>;
  restore(id: string): Promise<ProfileRecord>;
  /** The current profile. Always defined: a default exists whenever none is live. */
  active(): Promise<ProfileRecord>;
  activeId(): Promise<string | undefined>;
  setActive(id: string): Promise<void>;
}

export interface AttemptsApi {
  /** Appends one attempt and resolves only once it is committed to disk. There is no update or delete: the log is append-only. */
  add(input: NewAttempt): Promise<AttemptRecord>;
  get(id: string, opts?: AttemptQueryOptions): Promise<AttemptRecord | undefined>;
  /** A profile's whole log, oldest first. */
  listByProfile(profileId: string, opts?: AttemptQueryOptions): Promise<AttemptRecord[]>;
  listByExercise(profileId: string, exerciseId: string, opts?: AttemptQueryOptions): Promise<AttemptRecord[]>;
}

export interface TakesApi {
  /** Mutable: Settings may change it; it applies from the next save. */
  readonly retention: TakeRetention;
  /**
   * Saves the pitch track and (optionally) audio, then enforces retention. Check `audioRef` to see whether the audio
   * was kept. With a pre-allocated `id`, a second save of the same id while the first is running rejects ("already being saved").
   */
  save(input: SaveTakeInput): Promise<TakeRecord>;
  get(id: string): Promise<TakeRecord | undefined>;
  audio(take: Pick<TakeRecord, 'audioRef'>): Promise<Blob | undefined>;
  /** Oldest first. */
  listByProfile(profileId: string): Promise<TakeRecord[]>;
  /** Deletes the audio, then the record. Rejects, keeping the record, if the audio file would not go: tell the singer; a retry finishes. */
  delete(id: string): Promise<void>;
  /** Like `delete` for every take of a profile: all are tried, and the first failure is rethrown afterwards. */
  deleteByProfile(profileId: string): Promise<number>;
}

export interface SongsApi {
  /** Imports or re-imports (upsert by the song's content id), optionally with a backing track. */
  import(profileId: string, song: Song, backingTrack?: BinaryData | null): Promise<SongRecord>;
  get(id: string): Promise<SongRecord | undefined>;
  findByContentId(profileId: string, songId: string): Promise<SongRecord | undefined>;
  listByProfile(profileId: string): Promise<SongRecord[]>;
  setOffset(id: string, offsetMs: number): Promise<SongRecord>;
  setBacking(id: string, backing: BinaryData | null): Promise<SongRecord>;
  /** Deletes the backing track, then the record. Rejects, keeping the record, if the file would not go. */
  delete(id: string): Promise<void>;
}

export interface BackupApi {
  export(profileIds?: readonly string[]): Promise<BackupFile>;
  /** The backup as JSON text, ready to download. */
  exportJson(profileIds?: readonly string[]): Promise<string>;
  /** `pitch-lab-backup-YYYY-MM-DD.json` */
  fileName(when?: Date): string;
  /**
   * Merges a backup (object or JSON text). Never rejects: read the report. Restores settings of
   * the profiles it adds, and retires the empty default profile of a fresh install (see
   * ImportOptions) unless told not to.
   */
  import(file: unknown, opts?: Partial<ImportOptions>): Promise<ImportReport>;
}

export interface StorageUsage {
  /** Data db, binary store and settings all survive a reload. False: warn the singer that nothing will be saved. */
  persistent: boolean;
  /** Why the data db is in memory (Diagnostics), or null. */
  dbFallbackReason: string | null;
  binaryBackend: OpfsBackend;
  attemptCount: number;
  takeCount: number;
  /** Bytes of take audio and backing tracks. */
  binaryBytes: number;
  /** `navigator.storage.estimate()` for the whole origin, where the browser reports it. */
  origin: { usage: number | null; quota: number | null };
}

/** The opened storage layer (named AppStorage so it never shadows the DOM's Web Storage `Storage` type). */
export interface AppStorage {
  readonly db: PitchLabDb;
  readonly opfs: OpfsStore;
  readonly kv: KVStore;
  /** Every layer is durable. False means some layer fell back to memory: warn the singer. */
  readonly persistent: boolean;
  /** What the first-run migration did on this launch. */
  readonly migration: MigrationReport;
  readonly profiles: ProfilesApi;
  readonly attempts: AttemptsApi;
  readonly takes: TakesApi;
  readonly songs: SongsApi;
  readonly backup: BackupApi;
  /**
   * Makes records and binaries agree (see maintenance.ts). Cheap; run it once per launch, off the
   * critical path. Does nothing when this launch cannot see the real data: read `report.skipped`.
   */
  reconcile(): Promise<ReconcileReport>;
  usage(): Promise<StorageUsage>;
  /**
   * Deletes everything the app stores about its singers (recordings first) and recreates the default
   * profile. Device calibration is kept. REJECTS if any recording could not be deleted: show the error,
   * never "all deleted".
   */
  deleteAllData(): Promise<void>;
  /** Releases the connections. For tests and teardown; the app never needs it. */
  close(): void;
}

export interface OpenStorageOptions {
  /** Inject any layer (tests); omitted ones are opened for real. */
  db?: PitchLabDb;
  opfs?: OpfsStore;
  kv?: KVStore;
  /** Database names (tests use fresh ones each; the app uses the defaults). */
  dbName?: string;
  binaryDbName?: string;
  kvDbName?: string;
  takeRetention?: Partial<TakeRetention>;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The active profile, creating the default "Me" when none is live (the app never has zero profiles). */
async function ensureActiveProfile(db: PitchLabDb): Promise<ProfileRecord> {
  const active = await getActiveProfile(db);
  if (active) return active;
  const fresh = await createProfile(db, { name: 'Me', voiceType: 'unknown' });
  await setActiveProfileId(db, fresh.id);
  return fresh;
}

async function originEstimate(): Promise<{ usage: number | null; quota: number | null }> {
  try {
    const estimate = await (globalThis as { navigator?: Navigator }).navigator?.storage?.estimate?.();
    return { usage: estimate?.usage ?? null, quota: estimate?.quota ?? null };
  } catch {
    return { usage: null, quota: null };
  }
}

export async function openStorage(options: OpenStorageOptions = {}): Promise<AppStorage> {
  const [db, binaries, kv] = await Promise.all([
    options.db ?? openDb(options.dbName),
    options.opfs ?? openOpfs({ fallbackDbName: options.binaryDbName }),
    options.kv ?? openKV(options.kvDbName),
  ]);
  // The one place the data db learns which binary backend its files went to (see backend-marker.ts).
  const opfs = withBackendMarker(db, binaries);
  const persistent = db.persistent && opfs.persistent && kv.persistent;

  let migration: MigrationReport;
  try {
    migration = await migrateFromV1(db, kv);
  } catch (err) {
    migration = { ran: false, profile: null, settingsMigrated: false, error: errorText(err) };
  }
  await ensureActiveProfile(db);

  const retention: TakeRetention = resolveTakeRetention(options.takeRetention);

  const profiles: ProfilesApi = {
    list: (opts) => listProfiles(db, opts),
    get: (id, opts) => getProfile(db, id, opts),
    create: async (input) => {
      const profile = await createProfile(db, input);
      if (!(await getActiveProfileId(db))) await setActiveProfileId(db, profile.id);
      return profile;
    },
    update: (id, patch) => updateProfile(db, id, patch),
    rename: (id, name) => updateProfile(db, id, { name }),
    setRange: (id, range) => updateProfile(db, id, { range }),
    setVoiceType: (id, voiceType) => updateProfile(db, id, { voiceType }),
    delete: async (id, opts = {}) => {
      if (opts.removeRecordings) {
        // The takes and the imported songs (backing tracks included): after the delete nothing can reach them, so they
        // would sit on the device unseen. Both are tried; the first failure rejects, keeping the profile.
        let failure: { err: unknown } | null = null;
        for (const remove of [deleteTakesByProfile, deleteSongsByProfile]) {
          try {
            await remove(db, opfs, id);
          } catch (err) {
            failure ??= { err };
          }
        }
        if (failure) throw failure.err;
      }
      await deleteProfile(db, id);
      await ensureActiveProfile(db);
    },
    restore: (id) => restoreProfile(db, id),
    active: () => ensureActiveProfile(db),
    activeId: () => getActiveProfileId(db),
    setActive: (id) => setActiveProfileId(db, id),
  };

  const attempts: AttemptsApi = {
    add: (input) => addAttempt(db, input),
    get: (id, opts) => getAttempt(db, id, opts),
    listByProfile: (profileId, opts) => listAttemptsByProfile(db, profileId, opts),
    listByExercise: (profileId, exerciseId, opts) => listAttemptsByExercise(db, profileId, exerciseId, opts),
  };

  const takes: TakesApi = {
    retention,
    save: (input) => saveTake(db, opfs, input, { retention }),
    get: (id) => getTake(db, id),
    audio: (take) => getTakeAudio(opfs, take),
    listByProfile: (profileId) => listTakesByProfile(db, profileId),
    delete: (id) => deleteTake(db, opfs, id),
    deleteByProfile: (profileId) => deleteTakesByProfile(db, opfs, profileId),
  };

  const songs: SongsApi = {
    import: (profileId, song, backingTrack) => importSong(db, opfs, profileId, song, backingTrack),
    get: (id) => getSong(db, id),
    findByContentId: (profileId, songId) => findSongByContentId(db, profileId, songId),
    listByProfile: (profileId) => listSongsByProfile(db, profileId),
    setOffset: (id, offsetMs) => updateSongOffset(db, id, offsetMs),
    setBacking: (id, backing) => setSongBacking(db, opfs, id, backing),
    delete: (id) => deleteSong(db, opfs, id),
  };

  const backup: BackupApi = {
    export: (profileIds) => exportBackup(db, profileIds, kv),
    exportJson: (profileIds) => exportBackupJson(db, profileIds, kv),
    fileName: (when) => backupFileName(when),
    import: async (file, opts = {}) => {
      const report = await importBackup(db, file, { kv, retireEmptyDefaultProfile: true, ...opts });
      await ensureActiveProfile(db);
      return report;
    },
  };

  return {
    db,
    opfs,
    kv,
    persistent,
    migration,
    profiles,
    attempts,
    takes,
    songs,
    backup,
    reconcile: () => reconcileBinaries(db, opfs),
    usage: async () => ({
      persistent,
      dbFallbackReason: db.fallbackReason,
      binaryBackend: opfs.backend,
      attemptCount: await db.store('attempts').count(),
      takeCount: await db.store('takes').count(),
      binaryBytes: await opfs.totalBytes(),
      origin: await originEstimate(),
    }),
    deleteAllData: async () => {
      let wiped = true;
      let failure: unknown;
      try {
        await wipeAllData(db, opfs, kv);
      } catch (err) {
        wiped = false;
        failure = err;
      }
      // Whatever the wipe managed, the app must not be left without a profile.
      try {
        await migrateFromV1(db, kv);
        await ensureActiveProfile(db);
      } catch (err) {
        if (wiped) throw err;
      }
      if (!wiped) throw failure;
    },
    close: () => {
      db.close();
      opfs.close();
    },
  };
}

let shared: Promise<AppStorage> | null = null;

/** The app-wide storage, opened on first use. Call it from anywhere; every caller gets the same instance. */
export function getStorage(): Promise<AppStorage> {
  if (!shared) {
    shared = openStorage().catch((err) => {
      shared = null; // let a later call try again
      throw err;
    });
  }
  return shared;
}

/** Forgets the shared instance (tests only). */
export function resetStorageForTests(): void {
  shared = null;
}
