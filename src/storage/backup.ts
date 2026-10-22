/**
 * Profile + attempt backup/restore (schema.ts BackupFile): a versioned JSON file to restore a
 * profile or move it to a new device. No audio ever leaves the device: takes and songs, and
 * their binaries, are excluded on purpose, and every record is projected through the
 * SYNCABLE allowlist (schema.ts) so nothing audio-derived can slip in - an attempt's
 * `takeId`, a reference to local audio, is always exported as null.
 *
 * Export includes soft-deleted profiles as TOMBSTONES (so a deletion propagates when the file
 * is merged elsewhere) but not their attempts, unless the profile is asked for by id.
 *
 * Import validates every row, merges by HLC (hlc.ts) and never throws on bad input - problems
 * are counted and described in the returned report, and everything readable is still merged:
 *  - profiles: last write wins on `updatedAt`. A tombstone is just another field on the
 *    record, so a newer delete beats an older live copy and a newer live copy beats an older
 *    delete, with no special cases;
 *  - attempts: append-only and immutable, so deduped by id. An id already present locally is
 *    left untouched, never compared or overwritten;
 *  - every imported timestamp is folded into this device's clock, so its own later writes
 *    keep sorting after whatever history it just absorbed - but a timestamp implausibly far in
 *    the future is rejected rather than merged (hlc.ts HLC_MAX_REMOTE_SKEW_MS);
 *  - restored settings are validated key by key (`sanitizeSettings`): a value this build does not
 *    understand is dropped and the default used, never stored for the app to trip over.
 */
import type { Timbre } from '../audio/synth-types';
import { CONFIG } from '../config';
import { clamp01 } from '../core/math';
import type { Notation } from '../core/music';
import type { VibratoStyle } from '../core/types';
import type { DetectorKind } from '../dsp/detector-types';
import type { Settings } from '../state/settings-types';
import { listAttemptsByProfile, normalizeAttemptFields } from './attempts-repo';
import type { PitchLabDb } from './db';
import { compareHlc, isHlc } from './hlc';
import { profileSettingsKey } from './keys';
import type { KVStore } from './kv-types';
import {
  cleanProfileName,
  deleteProfile,
  getActiveProfileId,
  getProfile,
  isValidVocalRange,
  isVoiceType,
  listProfiles,
  setActiveProfileId,
} from './profiles-repo';
import { SYNCABLE, type AttemptRecord, type BackupFile, type ProfileRecord } from './schema';

export const BACKUP_FORMAT = 'pitch-lab-backup' as const;
export const BACKUP_VERSION = 1 as const;

/** Attempts are inserted in transactions of this many rows: fast, yet never one giant transaction. */
const IMPORT_CHUNK = 500;
/** The report carries at most this many error messages (the counts stay exact). */
const MAX_REPORTED_ERRORS = 50;
/** Ids from a file are used as database keys: keep them short, plain and unable to be `__proto__`. */
const RECORD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** What `BackupFile.settings` holds (the contract types it `unknown`): per-profile settings only - latency calibration belongs to a device, not a singer. */
export interface BackupSettings {
  schemaVersion: 1;
  profiles: Record<string, unknown>;
}

// ---------------------------------------------------------------- export

function project(record: object, allowed: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    const value = (record as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function toSyncableProfile(profile: ProfileRecord): ProfileRecord {
  return project(profile, SYNCABLE.profiles) as unknown as ProfileRecord;
}

function toSyncableAttempt(attempt: AttemptRecord): AttemptRecord {
  // takeId is not in SYNCABLE (it points at local audio); the type needs the field, so it is null.
  return { ...project(attempt, SYNCABLE.attempts), takeId: null } as unknown as AttemptRecord;
}

/**
 * Exports a JSON-serialisable backup. Default: every profile (soft-deleted ones as tombstones)
 * and the attempts of the live ones. With `profileIds`: exactly those profiles and their attempts.
 * With `kv`, each exported live profile's settings are included.
 */
export async function exportBackup(db: PitchLabDb, profileIds?: readonly string[], kv?: KVStore): Promise<BackupFile> {
  let profiles: ProfileRecord[];
  let withAttempts: ProfileRecord[];
  if (profileIds) {
    const found = await Promise.all([...new Set(profileIds)].map((id) => getProfile(db, id, { includeDeleted: true })));
    profiles = found.filter((p): p is ProfileRecord => p !== undefined);
    withAttempts = profiles;
  } else {
    profiles = await listProfiles(db, { includeDeleted: true });
    withAttempts = profiles.filter((p) => p.deletedAt === null);
  }

  const attempts: AttemptRecord[] = [];
  for (const profile of withAttempts) {
    for (const attempt of await listAttemptsByProfile(db, profile.id, { includeDeleted: true })) attempts.push(toSyncableAttempt(attempt));
  }

  const settings: BackupSettings = { schemaVersion: 1, profiles: {} };
  if (kv) {
    for (const profile of profiles) {
      if (profile.deletedAt !== null) continue;
      const stored = await kv.get<unknown>(profileSettingsKey(profile.id));
      if (stored !== undefined) settings.profiles[profile.id] = stored;
    }
  }

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: db.nowIso(),
    profiles: profiles.map(toSyncableProfile),
    attempts,
    settings,
  };
}

/** `exportBackup` as the JSON text to offer for download. */
export async function exportBackupJson(db: PitchLabDb, profileIds?: readonly string[], kv?: KVStore): Promise<string> {
  return JSON.stringify(await exportBackup(db, profileIds, kv));
}

/** A download file name for a backup, e.g. `pitch-lab-backup-2026-10-21.json` (UTC date). */
export function backupFileName(when: Date = new Date()): string {
  return `pitch-lab-backup-${when.toISOString().slice(0, 10)}.json`;
}

// ---------------------------------------------------------------- import

export interface ImportOptions {
  /** With it, the settings of profiles ADDED by this import are restored (never over existing settings). */
  kv?: KVStore;
  /**
   * Restoring onto a fresh device leaves the empty default "Me" next to the restored profiles.
   * With this on, when the import added at least one live profile and the only profile that was
   * already here is that untouched, attempt-less default, it is soft-deleted and a restored profile
   * becomes the active one.
   */
  retireEmptyDefaultProfile?: boolean;
  /**
   * The singer chose this file to restore from (the Data screen's Import): a profile deleted on this device that the
   * file holds ALIVE comes back, even though the local deletion is newer (plain last-write-wins would keep the
   * tombstone, and the backup made just before deleting it could never bring it back). The profile keeps its details as
   * they were when it was deleted (its settings key was kept), and its attempts, which a deletion never removes,
   * reappear. Counted in `profilesUpdated` and `profilesRestored`. Leave it off for a sync-style merge.
   */
  restoreDeleted?: boolean;
}

export interface ImportReport {
  /** The envelope was a recognised, supported backup. Individual rows may still have been rejected. */
  ok: boolean;
  /** Live profiles this device did not have. */
  profilesAdded: number;
  /** Profiles whose local copy was replaced by a newer one (see also `profilesDeleted` / `profilesRestored`). */
  profilesUpdated: number;
  /** Of the updated: live profiles the backup DELETED (a newer tombstone won). Worth telling the singer about. */
  profilesDeleted: number;
  /** Of the updated: deleted profiles the backup brought back (a newer live copy won). */
  profilesRestored: number;
  /**
   * Valid rows that changed nothing visible: not newer than the local copy, or a tombstone for a
   * profile this device never had (that one is still stored, hidden, so an older live copy can
   * never resurrect it later).
   */
  profilesSkipped: number;
  /** Malformed or implausible: not imported. */
  profilesRejected: number;
  attemptsAdded: number;
  /** Already present locally (same id). */
  attemptsSkipped: number;
  attemptsRejected: number;
  settingsRestored: number;
  /** The empty default profile that `retireEmptyDefaultProfile` removed, if any. */
  retiredDefaultProfileId: string | null;
  /** Human-readable problems (capped; the counts above stay exact). */
  errors: string[];
}

class ErrorLog {
  readonly messages: string[] = [];
  private omitted = 0;

  add(message: string): void {
    if (this.messages.length < MAX_REPORTED_ERRORS) this.messages.push(message);
    else this.omitted += 1;
  }

  finish(): string[] {
    return this.omitted > 0 ? [...this.messages, `...and ${this.omitted} more`] : this.messages;
  }
}

function emptyReport(): ImportReport {
  return {
    ok: false,
    profilesAdded: 0,
    profilesUpdated: 0,
    profilesDeleted: 0,
    profilesRestored: 0,
    profilesSkipped: 0,
    profilesRejected: 0,
    attemptsAdded: 0,
    attemptsSkipped: 0,
    attemptsRejected: 0,
    settingsRestored: 0,
    retiredDefaultProfileId: null,
    errors: [],
  };
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeId(value: unknown): string {
  return isRecord(value) && typeof value.id === 'string' ? value.id.slice(0, 40) : '?';
}

/** Canonical ISO string for a parseable date, else null. */
function normalizeIso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

type Parsed<T> = { record: T } | { error: string };

/** The shared envelope of every record: id, createdAt, updatedAt (a plausible HLC), deletedAt. */
function parseBase(db: PitchLabDb, raw: Json): Parsed<{ id: string; createdAt: string; updatedAt: string; deletedAt: string | null }> {
  if (typeof raw.id !== 'string' || !RECORD_ID_RE.test(raw.id)) return { error: 'missing or malformed id' };
  if (!isHlc(raw.updatedAt)) return { error: 'malformed updatedAt' };
  if (!db.isPlausibleTimestamp(raw.updatedAt)) return { error: 'updatedAt is implausibly far in the future' };
  const createdAt = normalizeIso(raw.createdAt);
  if (!createdAt) return { error: 'malformed createdAt' };
  let deletedAt: string | null = null;
  if (raw.deletedAt !== null && raw.deletedAt !== undefined) {
    deletedAt = normalizeIso(raw.deletedAt);
    if (!deletedAt) return { error: 'malformed deletedAt' };
  }
  return { record: { id: raw.id, createdAt, updatedAt: raw.updatedAt, deletedAt } };
}

function parseProfile(db: PitchLabDb, raw: unknown): Parsed<ProfileRecord> {
  if (!isRecord(raw)) return { error: 'not an object' };
  const base = parseBase(db, raw);
  if ('error' in base) return base;
  let name: string;
  try {
    name = cleanProfileName(raw.name);
  } catch {
    return { error: 'missing name' };
  }
  const range = isValidVocalRange(raw.range)
    ? {
        comfortable: { low: raw.range.comfortable.low, high: raw.range.comfortable.high },
        extended: { low: raw.range.extended.low, high: raw.range.extended.high },
        measuredAt: raw.range.measuredAt,
      }
    : null;
  return {
    record: {
      ...base.record,
      profileId: base.record.id, // a profile scopes itself, whatever the file says
      name,
      voiceType: isVoiceType(raw.voiceType) ? raw.voiceType : 'unknown',
      range,
    },
  };
}

function parseAttempt(db: PitchLabDb, raw: unknown): Parsed<AttemptRecord> {
  if (!isRecord(raw)) return { error: 'not an object' };
  const base = parseBase(db, raw);
  if ('error' in base) return base;
  try {
    // takeId is forced to null: takes are local-only, so a reference to one is meaningless here.
    const fields = normalizeAttemptFields({ ...raw, takeId: null });
    return { record: { ...fields, ...base.record } };
  } catch (err) {
    return { error: message(err) };
  }
}

/** A cleaner for a string setting: the value if it is an OWN key of `allowed` (never an inherited one such as `constructor`), else undefined. */
function oneOf<T extends string>(allowed: Readonly<Record<T, unknown>>): (value: unknown) => T | undefined {
  return (value) => (typeof value === 'string' && Object.hasOwn(allowed, value) ? (value as T) : undefined);
}

/**
 * How each stored setting is validated: the cleaned value, or undefined to drop it (the defaults then fill
 * it in). Typed per key and exhaustive over `Settings`, and every allowed set is a `Record` over the
 * union (or the config table the code indexes), so adding a style, timbre or detector fails to compile
 * here until it is allowed - the sets cannot drift from the types.
 */
const SETTING_CLEANERS: { [K in Exclude<keyof Settings, 'schemaVersion'>]: (value: unknown) => Settings[K] | undefined } = {
  vibratoStyle: oneOf<VibratoStyle>(CONFIG.vibrato.styles),
  detector: oneOf<DetectorKind>({ mpm: true, yin: true }),
  referenceTimbre: oneOf<Timbre>({ piano: true, sine: true, soft: true }),
  referenceVolume: (value) => (typeof value === 'number' && Number.isFinite(value) ? clamp01(value) : undefined),
  notation: oneOf<Notation>({ sharps: true, flats: true }),
  theme: oneOf<Settings['theme']>({ system: true, dark: true, light: true }),
  reducedMotion: oneOf<Settings['reducedMotion']>({ system: true, on: true, off: true }),
  showNoteNames: (value) => (typeof value === 'boolean' ? value : undefined),
  workoutMinutes: (value) => (value === 5 || value === 10 || value === 20 ? value : undefined),
  keepTakeAudio: (value) => (typeof value === 'boolean' ? value : undefined),
  voiceCareSeen: (value) => (typeof value === 'boolean' ? value : undefined),
};

/**
 * Keeps only the settings this build understands. Each key is checked against ITS OWN rules (a member of
 * its allowed set, a boolean, a finite number clamped to 0..1), not just its primitive type: the app
 * indexes tables with these values (`CONFIG.vibrato.styles[vibratoStyle]`), so a string that is not a
 * known style - from a corrupt file, or a backup made by a newer build that added one - would crash the
 * Settings screen and the vibrato analysis on every run. A bad key is dropped alone; unknown keys are
 * dropped; `schemaVersion` is always written as 1. Null when nothing usable is left.
 *
 * Exported because the same rules apply when settings are READ back from storage (a value written by
 * an older or newer build): `{ ...DEFAULT_SETTINGS, ...sanitizeSettings(stored) }`.
 */
export function sanitizeSettings(raw: unknown): Partial<Settings> | null {
  if (!isRecord(raw)) return null;
  const out: Json = {};
  for (const key of Object.keys(SETTING_CLEANERS) as Array<keyof typeof SETTING_CLEANERS>) {
    const clean = SETTING_CLEANERS[key](raw[key]);
    if (clean !== undefined) out[key] = clean;
  }
  return Object.keys(out).length > 0 ? ({ schemaVersion: 1, ...out } as Partial<Settings>) : null;
}

function isPristineDefault(profile: ProfileRecord): boolean {
  return profile.name === 'Me' && profile.voiceType === 'unknown' && profile.range === null;
}

/**
 * Validates and merges a backup (an object, or its JSON text). Always resolves with a report;
 * never rejects.
 */
export async function importBackup(db: PitchLabDb, input: unknown, opts: ImportOptions = {}): Promise<ImportReport> {
  const report = emptyReport();
  const log = new ErrorLog();
  try {
    await runImport(db, input, opts, report, log);
  } catch (err) {
    report.ok = false;
    log.add(`import stopped early: ${message(err)}`);
  }
  report.errors = log.finish();
  return report;
}

async function runImport(db: PitchLabDb, input: unknown, opts: ImportOptions, report: ImportReport, log: ErrorLog): Promise<void> {
  let file = input;
  if (typeof file === 'string') {
    try {
      file = JSON.parse(file);
    } catch {
      log.add('the file is not valid JSON');
      return;
    }
  }
  if (!isRecord(file) || file.format !== BACKUP_FORMAT) {
    log.add('not a recognised pitch-lab-backup file');
    return;
  }
  if (typeof file.version !== 'number' || !Number.isInteger(file.version) || file.version < 1) {
    log.add(`unsupported backup version: ${String(file.version)}`);
    return;
  }
  if (file.version > BACKUP_VERSION) {
    log.add(`this backup was made by a newer version of Pitch Lab (backup version ${file.version}); update the app to import it`);
    return;
  }
  if (!Array.isArray(file.profiles) || !Array.isArray(file.attempts)) {
    log.add('the backup is missing its profiles or attempts list');
    return;
  }
  report.ok = true;

  // ---- profiles: last write wins on the HLC
  const profiles = db.store<ProfileRecord>('profiles');
  const addedLive: ProfileRecord[] = [];
  for (const raw of file.profiles as unknown[]) {
    const parsed = parseProfile(db, raw);
    if ('error' in parsed) {
      report.profilesRejected += 1;
      log.add(`profile ${safeId(raw)}: ${parsed.error}`);
      continue;
    }
    const incoming = parsed.record;
    try {
      db.receiveTimestamp(incoming.updatedAt);
      const result: { outcome: 'added' | 'updated' | 'restored' | 'skipped'; wasDeleted: boolean } = { outcome: 'skipped', wasDeleted: false };
      await profiles.update(incoming.id, (existing) => {
        if (!existing) {
          result.outcome = 'added';
          return incoming;
        }
        if (compareHlc(incoming.updatedAt, existing.updatedAt) > 0) {
          result.outcome = 'updated';
          result.wasDeleted = existing.deletedAt !== null;
          return incoming;
        }
        if (opts.restoreDeleted && existing.deletedAt !== null && incoming.deletedAt === null) {
          // An explicit restore: undelete the local record (its details as of the deletion) with a fresh clock.
          result.outcome = 'restored';
          return { ...existing, deletedAt: null, updatedAt: db.nextTimestamp() };
        }
        result.outcome = 'skipped';
        return undefined;
      });
      if (result.outcome === 'added' && incoming.deletedAt === null) {
        report.profilesAdded += 1;
        addedLive.push(incoming);
      } else if (result.outcome === 'restored') {
        report.profilesUpdated += 1;
        report.profilesRestored += 1;
      } else if (result.outcome === 'updated') {
        report.profilesUpdated += 1;
        const isDeleted = incoming.deletedAt !== null;
        if (isDeleted && !result.wasDeleted) report.profilesDeleted += 1;
        else if (!isDeleted && result.wasDeleted) report.profilesRestored += 1;
      } else {
        report.profilesSkipped += 1; // not newer, or a hidden tombstone for a profile this device never had
      }
    } catch (err) {
      report.profilesRejected += 1;
      log.add(`profile ${incoming.id}: ${message(err)}`);
    }
  }

  // ---- attempts: dedupe by id, never overwrite
  const knownProfiles = new Set((await listProfiles(db, { includeDeleted: true })).map((p) => p.id));
  const entries: Array<[string, AttemptRecord]> = [];
  for (const raw of file.attempts as unknown[]) {
    const parsed = parseAttempt(db, raw);
    if ('error' in parsed) {
      report.attemptsRejected += 1;
      log.add(`attempt ${safeId(raw)}: ${parsed.error}`);
      continue;
    }
    const incoming = parsed.record;
    if (!knownProfiles.has(incoming.profileId)) {
      report.attemptsRejected += 1;
      log.add(`attempt ${incoming.id}: belongs to an unknown profile`);
      continue;
    }
    db.receiveTimestamp(incoming.updatedAt);
    entries.push([incoming.id, incoming]);
  }
  const attempts = db.store<AttemptRecord>('attempts');
  for (let i = 0; i < entries.length; i += IMPORT_CHUNK) {
    const chunk = entries.slice(i, i + IMPORT_CHUNK);
    try {
      const { added, existing } = await attempts.addMissing(chunk);
      report.attemptsAdded += added.length;
      report.attemptsSkipped += existing.length;
    } catch (err) {
      report.attemptsRejected += chunk.length;
      log.add(`a batch of ${chunk.length} attempts could not be stored: ${message(err)}`);
    }
  }

  // ---- settings of the profiles this import added
  if (opts.kv && isRecord(file.settings) && isRecord(file.settings.profiles)) {
    const stored = file.settings.profiles;
    for (const profile of addedLive) {
      if (!Object.prototype.hasOwnProperty.call(stored, profile.id)) continue;
      const clean = sanitizeSettings(stored[profile.id]);
      if (!clean) continue;
      try {
        const key = profileSettingsKey(profile.id);
        if ((await opts.kv.get<unknown>(key)) === undefined) {
          await opts.kv.set(key, clean);
          report.settingsRestored += 1;
        }
      } catch (err) {
        log.add(`settings of profile ${profile.id} could not be stored: ${message(err)}`);
      }
    }
  }

  // ---- retire the empty default profile left over from a fresh install
  if (opts.retireEmptyDefaultProfile && addedLive.length > 0) {
    const addedIds = new Set(addedLive.map((p) => p.id));
    const preexisting = (await listProfiles(db)).filter((p) => !addedIds.has(p.id));
    const only = preexisting.length === 1 ? preexisting[0] : undefined;
    if (only && isPristineDefault(only) && (await listAttemptsByProfile(db, only.id)).length === 0) {
      await deleteProfile(db, only.id);
      report.retiredDefaultProfileId = only.id;
      if ((await getActiveProfileId(db)) === undefined) await setActiveProfileId(db, addedLive[0].id);
    }
  }
}
