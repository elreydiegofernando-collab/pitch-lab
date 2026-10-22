/**
 * Profile records (schema.ts ProfileRecord). A profile scopes itself
 * (`profileId === id`). Delete is soft - a tombstone, never a removed row - per
 * the sync-ready model, and a tombstoned profile behaves as absent everywhere
 * (get, list, rename, select) unless a caller opts in with `includeDeleted`.
 * The "active profile" (which singer is selected on this device) is persisted in
 * the data db's `meta` store so it survives a relaunch.
 *
 * Updates are atomic read-modify-writes (`RawStore.update`), so two quick edits
 * (say a rename and a range save) never overwrite each other.
 */
import { META_KEYS, type PitchLabDb } from './db';
import { newId } from './ids';
import type { ProfileRecord, VocalRange } from './schema';

const STORE = 'profiles';

export const MAX_PROFILE_NAME_LENGTH = 60;

export type VoiceType = ProfileRecord['voiceType'];
const VOICE_TYPES: readonly VoiceType[] = ['tenor', 'baritone', 'other', 'unknown'];

export function isVoiceType(value: unknown): value is VoiceType {
  return typeof value === 'string' && (VOICE_TYPES as readonly string[]).includes(value);
}

/** Collapses whitespace and trims; rejects an empty result, truncates an over-long one. */
export function cleanProfileName(name: unknown): string {
  const cleaned = (typeof name === 'string' ? name : '').replace(/\s+/g, ' ').trim().slice(0, MAX_PROFILE_NAME_LENGTH).trim();
  if (!cleaned) throw new TypeError('profiles-repo: a profile needs a name');
  return cleaned;
}

function isBand(value: unknown): value is { low: number; high: number } {
  const b = value as { low?: unknown; high?: unknown } | null | undefined;
  return !!b && typeof b.low === 'number' && typeof b.high === 'number' && Number.isFinite(b.low) && Number.isFinite(b.high) && b.low <= b.high;
}

/** Structural check: finite MIDI bands with low <= high, and a `measuredAt` string. */
export function isValidVocalRange(value: unknown): value is VocalRange {
  const r = value as { comfortable?: unknown; extended?: unknown; measuredAt?: unknown } | null | undefined;
  return !!r && isBand(r.comfortable) && isBand(r.extended) && typeof r.measuredAt === 'string';
}

function cleanRange(range: unknown): VocalRange | null {
  if (range === null || range === undefined) return null;
  if (!isValidVocalRange(range)) throw new TypeError('profiles-repo: invalid vocal range');
  return {
    comfortable: { low: range.comfortable.low, high: range.comfortable.high },
    extended: { low: range.extended.low, high: range.extended.high },
    measuredAt: range.measuredAt,
  };
}

function cleanVoiceType(value: unknown): VoiceType {
  if (value === undefined) return 'unknown';
  if (!isVoiceType(value)) throw new TypeError(`profiles-repo: unknown voice type: ${String(value)}`);
  return value;
}

export interface CreateProfileInput {
  /** Only the first-run migration sets this (a stable id across a crash and retry). Omit it everywhere else. */
  id?: string;
  name: string;
  voiceType?: VoiceType;
  range?: VocalRange | null;
}

export async function createProfile(db: PitchLabDb, input: CreateProfileInput): Promise<ProfileRecord> {
  const id = input.id ?? newId();
  const record: ProfileRecord = {
    id,
    profileId: id,
    createdAt: db.nowIso(),
    updatedAt: db.nextTimestamp(),
    deletedAt: null,
    name: cleanProfileName(input.name),
    voiceType: cleanVoiceType(input.voiceType),
    range: cleanRange(input.range),
  };
  await db.store<ProfileRecord>(STORE).add(record, id);
  return record;
}

export interface ProfilePatch {
  name?: string;
  voiceType?: VoiceType;
  range?: VocalRange | null;
}

/** Applies a patch atomically. Rejects for a profile that does not exist or is deleted. */
export async function updateProfile(db: PitchLabDb, id: string, patch: ProfilePatch): Promise<ProfileRecord> {
  const changes: ProfilePatch = {};
  if (patch.name !== undefined) changes.name = cleanProfileName(patch.name);
  if (patch.voiceType !== undefined) changes.voiceType = cleanVoiceType(patch.voiceType);
  if (patch.range !== undefined) changes.range = cleanRange(patch.range); // null clears; undefined means "not provided"

  const updated = await db.store<ProfileRecord>(STORE).update(id, (existing) => {
    if (!existing || existing.deletedAt !== null) throw new Error(`profiles-repo: no such profile ${id}`);
    return { ...existing, ...changes, updatedAt: db.nextTimestamp() };
  });
  if (!updated) throw new Error(`profiles-repo: no such profile ${id}`); // unreachable: the callback always writes or throws
  return updated;
}

export function renameProfile(db: PitchLabDb, id: string, name: string): Promise<ProfileRecord> {
  return updateProfile(db, id, { name });
}

export function setVocalRange(db: PitchLabDb, id: string, range: VocalRange | null): Promise<ProfileRecord> {
  return updateProfile(db, id, { range });
}

export function setVoiceType(db: PitchLabDb, id: string, voiceType: VoiceType): Promise<ProfileRecord> {
  return updateProfile(db, id, { voiceType });
}

/**
 * Soft delete: tombstones the profile (schema.ts RecordBase.deletedAt). The row stays, hidden,
 * so a later merge never resurrects it by accident and `restoreProfile` can undo it. Its
 * attempts stay too (they are the singer's history). If it was the active profile, the
 * selection is cleared. Deleting a missing or already-deleted profile is a no-op.
 */
export async function deleteProfile(db: PitchLabDb, id: string): Promise<void> {
  const deletedAt = db.nowIso();
  await db.store<ProfileRecord>(STORE).update(id, (existing) => {
    if (!existing || existing.deletedAt !== null) return undefined;
    return { ...existing, deletedAt, updatedAt: db.nextTimestamp() };
  });
  if ((await getActiveProfileId(db)) === id) await db.store<string>('meta').delete(META_KEYS.activeProfileId);
}

/** Undoes a soft delete. Returns the (live) profile; rejects if it never existed. */
export async function restoreProfile(db: PitchLabDb, id: string): Promise<ProfileRecord> {
  const restored = await db.store<ProfileRecord>(STORE).update(id, (existing) => {
    if (!existing) throw new Error(`profiles-repo: no such profile ${id}`);
    if (existing.deletedAt === null) return undefined;
    return { ...existing, deletedAt: null, updatedAt: db.nextTimestamp() };
  });
  const profile = restored ?? (await getProfile(db, id));
  if (!profile) throw new Error(`profiles-repo: no such profile ${id}`);
  return profile;
}

/** One profile, or undefined when it does not exist (or is soft-deleted, unless `includeDeleted`). */
export async function getProfile(db: PitchLabDb, id: string, opts: { includeDeleted?: boolean } = {}): Promise<ProfileRecord | undefined> {
  const profile = await db.store<ProfileRecord>(STORE).get(id);
  if (!profile) return undefined;
  return profile.deletedAt !== null && !opts.includeDeleted ? undefined : profile;
}

/**
 * Lists profiles in creation order (oldest first) so a profile picker never reshuffles after
 * a rename or a range save. Soft-deleted ones are hidden unless `includeDeleted`. Profiles
 * created within the same millisecond fall back to their HLC stamp (their order of creation,
 * for any that has not been edited since), then to the id, so the order is always stable.
 */
export async function listProfiles(db: PitchLabDb, opts: { includeDeleted?: boolean } = {}): Promise<ProfileRecord[]> {
  const all = await db.store<ProfileRecord>(STORE).getAll();
  const visible = opts.includeDeleted ? all : all.filter((p) => p.deletedAt === null);
  return visible.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** The device's remembered current profile id, or undefined before one is ever chosen. */
export async function getActiveProfileId(db: PitchLabDb): Promise<string | undefined> {
  const id = await db.store<string>('meta').get(META_KEYS.activeProfileId);
  return typeof id === 'string' ? id : undefined;
}

/** Remembers the current profile. Rejects for a profile that does not exist or is deleted. */
export async function setActiveProfileId(db: PitchLabDb, id: string): Promise<void> {
  const profile = await getProfile(db, id);
  if (!profile) throw new Error(`profiles-repo: no such profile ${id}`);
  await db.store<string>('meta').put(id, META_KEYS.activeProfileId);
}

/**
 * The current profile record. If the remembered one is missing or deleted, falls back to the
 * first live profile (and remembers it). Undefined only when no live profile exists at all.
 */
export async function getActiveProfile(db: PitchLabDb): Promise<ProfileRecord | undefined> {
  const id = await getActiveProfileId(db);
  if (id) {
    const profile = await getProfile(db, id);
    if (profile) return profile;
  }
  const first = (await listProfiles(db))[0];
  if (first) await setActiveProfileId(db, first.id);
  return first;
}
