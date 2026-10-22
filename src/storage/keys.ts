/**
 * Key conventions for the Phase 1 key-value store (storage/kv.ts, db `pitch-lab`).
 * One definition, shared by the migration, backup/restore and the settings code.
 */

/** Per-profile preferences (state/settings-types.ts `Settings`). */
export function profileSettingsKey(profileId: string): string {
  return `profile:${profileId}:settings`;
}

/** Every per-profile KV key starts with this. */
export const PROFILE_KEY_PREFIX = 'profile:';

/** Per-device facts shared by all profiles: route, latency calibration (state/settings-types.ts `DeviceSettings`). */
export const DEVICE_SETTINGS_KEY = 'device:settings';

/** Where Phase 1 kept its single implicit profile's settings, before real profiles existed. */
export const LEGACY_DEFAULT_SETTINGS_KEY = 'profile:default:settings';
