/**
 * One-time migration from Phase 1. Phase 1 kept everything in the KV db `pitch-lab`
 * (storage/kv.ts): one implicit profile's settings at `profile:default:settings`,
 * plus device-wide settings at `device:settings` (state/settings-types.ts convention).
 * Phase 3 introduces real profiles (schema.ts), so this creates the first one
 * (name "Me", voice type unknown), makes it the active profile, and re-keys its
 * settings to `profile:<uuid>:settings`. `device:settings` stays exactly where it is:
 * it was already device-scoped, so there is nothing to re-key.
 *
 * Idempotent and crash-safe (iOS can kill the app between any two steps). A `meta`
 * marker holds the new profile's id BEFORE the profile exists, so a retry after a crash
 * reuses that id instead of creating a second "Me"; the marker flips to `done` only
 * after the settings have moved. Moving settings is copy-then-delete and never
 * overwrites settings the new profile already has.
 *
 * It only ever runs against DURABLE layers. A data db that fell back to memory would create a throwaway
 * profile and move the settings under an id that vanishes with the page; a settings store in memory
 * cannot see the real legacy key at all and would let the marker flip to `done` without moving it. In both
 * cases the migration waits (the legacy key is left exactly where it is) and the next launch with durable
 * layers does it, reusing the same profile id.
 */
import { META_KEYS, type PitchLabDb } from './db';
import { isConstraintError } from './idb';
import { newId } from './ids';
import { LEGACY_DEFAULT_SETTINGS_KEY, profileSettingsKey } from './keys';
import type { KVStore } from './kv-types';
import { createProfile, getActiveProfileId, getProfile, listProfiles, setActiveProfileId } from './profiles-repo';
import type { ProfileRecord } from './schema';

interface MigrationMarker {
  state: 'started' | 'done';
  profileId: string;
  at: string;
}

export interface MigrationReport {
  /** False when migration had already completed (a no-op). */
  ran: boolean;
  /** The profile the migration created or adopted; null when it did not run. */
  profile: ProfileRecord | null;
  settingsMigrated: boolean;
  /** Set when the settings step failed or the settings store is not durable. The marker stays `started`, so the next launch retries. */
  error?: string;
}

/**
 * Runs the Phase 1 -> Phase 3 migration if it has not completed. Pass the Phase 1 KV store
 * to move its settings; without one only the profile is created. Does nothing (`ran: false`) on a
 * data db that is not durable.
 */
export async function migrateFromV1(db: PitchLabDb, kv?: KVStore): Promise<MigrationReport> {
  // A throwaway in-memory db must never touch the durable settings store (openStorage's
  // ensureActiveProfile still gives the session a profile to work with).
  if (!db.persistent) return { ran: false, profile: null, settingsMigrated: false };

  const meta = db.store<MigrationMarker>('meta');
  const marker = await meta.get(META_KEYS.migrationV1);
  if (marker?.state === 'done') return { ran: false, profile: null, settingsMigrated: false };

  const existing = await listProfiles(db, { includeDeleted: true });
  let profile: ProfileRecord | undefined;
  let profileId: string;
  if (marker?.state === 'started') {
    // Resuming a run that was interrupted: same id, whether or not the profile got created.
    profileId = marker.profileId;
    profile = existing.find((p) => p.id === profileId);
  } else if (existing.length > 0) {
    // Profiles exist but this migration never ran (for example a backup was restored first):
    // do not add a "Me"; adopt the oldest live profile as the owner of any Phase 1 settings.
    profile = existing.find((p) => p.deletedAt === null) ?? existing[0];
    profileId = profile.id;
  } else {
    // Claim the id atomically: if two launches race (a home-screen app and a browser tab opened
    // together on first run), both end up creating the SAME profile, not two.
    const claimed = await meta.update(META_KEYS.migrationV1, (current) => current ?? { state: 'started', profileId: newId(), at: db.nowIso() });
    const winner = claimed ?? (await meta.get(META_KEYS.migrationV1));
    if (winner?.state === 'done') return { ran: false, profile: null, settingsMigrated: false };
    profileId = winner?.profileId ?? newId();
  }

  let created = false;
  if (!profile) {
    try {
      profile = await createProfile(db, { id: profileId, name: 'Me', voiceType: 'unknown' });
      created = true;
    } catch (err) {
      if (!isConstraintError(err)) throw err;
      profile = await getProfile(db, profileId, { includeDeleted: true }); // the racing launch created it first
      if (!profile) throw err;
    }
  }

  // Make it the active profile, unless the singer already has a live one selected.
  const activeId = await getActiveProfileId(db);
  const activeIsLive = activeId !== undefined && existing.some((p) => p.id === activeId && p.deletedAt === null);
  if (profile.deletedAt === null && (created || !activeIsLive)) await setActiveProfileId(db, profile.id);

  let settingsMigrated = false;
  let error: string | undefined;
  if (kv && !kv.persistent) {
    // Treated like a failing settings store: the marker stays `started`, so the next launch retries.
    error = 'settings store is not persistent';
  } else if (kv) {
    try {
      const legacy = await kv.get<unknown>(LEGACY_DEFAULT_SETTINGS_KEY);
      if (legacy !== undefined) {
        const target = profileSettingsKey(profile.id);
        if ((await kv.get<unknown>(target)) === undefined) {
          await kv.set(target, legacy);
          settingsMigrated = true;
        }
        await kv.delete(LEGACY_DEFAULT_SETTINGS_KEY);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  if (!error) await meta.put({ state: 'done', profileId: profile.id, at: db.nowIso() }, META_KEYS.migrationV1);
  return error === undefined ? { ran: true, profile, settingsMigrated } : { ran: true, profile, settingsMigrated, error };
}
