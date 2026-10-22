import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { META_KEYS, openDb } from './db';
import { LEGACY_DEFAULT_SETTINGS_KEY, profileSettingsKey } from './keys';
import { openKV } from './kv';
import { migrateFromV1 } from './migrate';
import { createProfile, deleteProfile, getActiveProfileId, listProfiles, setActiveProfileId } from './profiles-repo';
import { MemoryKV, freshName, openMemoryDb } from './test-helpers';

afterEach(() => {
  vi.unstubAllGlobals();
});

async function fresh() {
  let t = 1_800_000_000_000; // a clock that ticks per reading, so "oldest" is never a same-millisecond tie
  return { db: await openDb(freshName('mig'), { now: () => ++t }), kv: new MemoryKV() };
}

const LEGACY = { schemaVersion: 1, theme: 'dark', vibratoStyle: 'classical' };

describe('migrateFromV1', () => {
  it('creates a default "Me" profile and makes it active when there is nothing to migrate', async () => {
    const { db, kv } = await fresh();
    const report = await migrateFromV1(db, kv);
    expect(report.ran).toBe(true);
    expect(report.profile?.name).toBe('Me');
    expect(report.profile?.voiceType).toBe('unknown');
    expect(report.profile?.profileId).toBe(report.profile?.id);
    expect(report.settingsMigrated).toBe(false);
    expect(report.error).toBeUndefined();
    await expect(getActiveProfileId(db)).resolves.toBe(report.profile!.id);
    await expect(db.store('meta').get(META_KEYS.migrationV1)).resolves.toMatchObject({ state: 'done', profileId: report.profile!.id });
  });

  it('re-keys profile:default:settings to profile:<newId>:settings and removes the old key', async () => {
    const { db, kv } = await fresh();
    await kv.set(LEGACY_DEFAULT_SETTINGS_KEY, LEGACY);

    const report = await migrateFromV1(db, kv);
    expect(report.settingsMigrated).toBe(true);
    expect(await kv.get(LEGACY_DEFAULT_SETTINGS_KEY)).toBeUndefined();
    expect(await kv.get(profileSettingsKey(report.profile!.id))).toEqual(LEGACY);
    expect(await kv.keys('profile:')).toEqual([profileSettingsKey(report.profile!.id)]);
  });

  it('leaves device:settings untouched - it was never profile-scoped', async () => {
    const { db, kv } = await fresh();
    const device = { schemaVersion: 1, route: 'wired', latency: { wired: { offsetMs: 41 } } };
    await kv.set('device:settings', device);
    await migrateFromV1(db, kv);
    expect(await kv.get('device:settings')).toEqual(device);
  });

  it('works against the real Phase 1 KV store too', async () => {
    const db = await openDb(freshName('mig'));
    const kv = await openKV(freshName('mig-kv'));
    await kv.set(LEGACY_DEFAULT_SETTINGS_KEY, LEGACY);
    await kv.set('device:settings', { schemaVersion: 1 });
    const report = await migrateFromV1(db, kv);
    expect((await kv.keys()).sort()).toEqual(['device:settings', profileSettingsKey(report.profile!.id)].sort());
  });

  describe('idempotence', () => {
    it('calling it twice never creates a second profile or moves settings twice', async () => {
      const { db, kv } = await fresh();
      await kv.set(LEGACY_DEFAULT_SETTINGS_KEY, LEGACY);
      const first = await migrateFromV1(db, kv);
      expect(first.ran).toBe(true);

      // The singer changes the migrated profile's settings afterwards...
      await kv.set(profileSettingsKey(first.profile!.id), { ...LEGACY, theme: 'light' });
      const second = await migrateFromV1(db, kv);
      expect(second).toEqual({ ran: false, profile: null, settingsMigrated: false });
      // ...and a re-run does not clobber them.
      expect(await kv.get(profileSettingsKey(first.profile!.id))).toMatchObject({ theme: 'light' });

      const all = await listProfiles(db, { includeDeleted: true });
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe(first.profile!.id);
    });

    it('is idempotent even if the migrated profile was later soft-deleted', async () => {
      const { db, kv } = await fresh();
      const first = await migrateFromV1(db, kv);
      await deleteProfile(db, first.profile!.id);
      const second = await migrateFromV1(db, kv);
      expect(second.ran).toBe(false);
      expect(await listProfiles(db, { includeDeleted: true })).toHaveLength(1); // not a second "Me"
    });

    it('does not run again after the singer has added more profiles', async () => {
      const { db, kv } = await fresh();
      await migrateFromV1(db, kv);
      await createProfile(db, { name: 'Beginner' });
      expect((await migrateFromV1(db, kv)).ran).toBe(false);
      expect(await listProfiles(db)).toHaveLength(2);
    });

    it('two launches racing on a first run still end up with ONE profile', async () => {
      const { db, kv } = await fresh();
      const reports = await Promise.all([migrateFromV1(db, kv), migrateFromV1(db, kv), migrateFromV1(db, kv)]);
      const profiles = await listProfiles(db, { includeDeleted: true });
      expect(profiles).toHaveLength(1);
      expect(await getActiveProfileId(db)).toBe(profiles[0].id);
      for (const r of reports.filter((x) => x.ran)) expect(r.profile?.id).toBe(profiles[0].id);
    });
  });

  describe('crash safety (iOS can kill the app between any two steps)', () => {
    it('dies after the marker, before the profile exists: the retry reuses the marked id', async () => {
      const { db, kv } = await fresh();
      await kv.set(LEGACY_DEFAULT_SETTINGS_KEY, LEGACY);
      await db.store('meta').put({ state: 'started', profileId: 'claimed-id', at: 'x' }, META_KEYS.migrationV1);

      const report = await migrateFromV1(db, kv);
      expect(report.ran).toBe(true);
      expect(report.profile?.id).toBe('claimed-id');
      expect(await kv.get(profileSettingsKey('claimed-id'))).toEqual(LEGACY);
      expect(await listProfiles(db, { includeDeleted: true })).toHaveLength(1);
    });

    it('dies after creating the profile, before moving settings: the retry moves them and creates nothing', async () => {
      const { db, kv } = await fresh();
      await kv.set(LEGACY_DEFAULT_SETTINGS_KEY, LEGACY);
      await db.store('meta').put({ state: 'started', profileId: 'claimed-id', at: 'x' }, META_KEYS.migrationV1);
      await createProfile(db, { id: 'claimed-id', name: 'Me' });
      await setActiveProfileId(db, 'claimed-id');

      const report = await migrateFromV1(db, kv);
      expect(report.ran).toBe(true);
      expect(report.settingsMigrated).toBe(true);
      expect(await listProfiles(db, { includeDeleted: true })).toHaveLength(1);
      expect(await kv.get(LEGACY_DEFAULT_SETTINGS_KEY)).toBeUndefined();
      expect(await kv.get(profileSettingsKey('claimed-id'))).toEqual(LEGACY);
      await expect(db.store('meta').get(META_KEYS.migrationV1)).resolves.toMatchObject({ state: 'done' });
    });

    it('dies after copying settings, before deleting the old key: the retry deletes it without overwriting the copy', async () => {
      const { db, kv } = await fresh();
      await db.store('meta').put({ state: 'started', profileId: 'claimed-id', at: 'x' }, META_KEYS.migrationV1);
      await createProfile(db, { id: 'claimed-id', name: 'Me' });
      await kv.set(LEGACY_DEFAULT_SETTINGS_KEY, { ...LEGACY, theme: 'dark' });
      await kv.set(profileSettingsKey('claimed-id'), { ...LEGACY, theme: 'light' }); // changed since the copy

      const report = await migrateFromV1(db, kv);
      expect(report.settingsMigrated).toBe(false); // nothing was copied this time
      expect(await kv.get(LEGACY_DEFAULT_SETTINGS_KEY)).toBeUndefined();
      expect(await kv.get(profileSettingsKey('claimed-id'))).toMatchObject({ theme: 'light' });
    });

    it('a failing settings store is reported, leaves the migration unfinished, and a later launch completes it', async () => {
      const { db, kv } = await fresh();
      await kv.set(LEGACY_DEFAULT_SETTINGS_KEY, LEGACY);
      kv.failing.add('get');

      const first = await migrateFromV1(db, kv);
      expect(first.ran).toBe(true);
      expect(first.error).toMatch(/kv get failed/);
      expect(first.profile).not.toBeNull();
      await expect(db.store('meta').get(META_KEYS.migrationV1)).resolves.toMatchObject({ state: 'started' });

      kv.failing.clear();
      const second = await migrateFromV1(db, kv);
      expect(second.ran).toBe(true);
      expect(second.error).toBeUndefined();
      expect(second.settingsMigrated).toBe(true);
      expect(second.profile?.id).toBe(first.profile?.id);
      expect(await listProfiles(db, { includeDeleted: true })).toHaveLength(1);
      expect(await kv.get(profileSettingsKey(first.profile!.id))).toEqual(LEGACY);
      await expect(db.store('meta').get(META_KEYS.migrationV1)).resolves.toMatchObject({ state: 'done' });
    });
  });

  it('without a KV store, only the profile is created', async () => {
    const { db } = await fresh();
    const report = await migrateFromV1(db);
    expect(report.ran).toBe(true);
    expect(report.settingsMigrated).toBe(false);
    expect(await listProfiles(db)).toHaveLength(1);
  });

  describe('when profiles already exist but the migration never ran (e.g. a backup was restored first)', () => {
    it('adds no "Me"; the oldest live profile adopts the Phase 1 settings and becomes active', async () => {
      const { db, kv } = await fresh();
      const gone = await createProfile(db, { name: 'Deleted' });
      await deleteProfile(db, gone.id);
      const first = await createProfile(db, { name: 'Restored A' });
      await createProfile(db, { name: 'Restored B' });
      await kv.set(LEGACY_DEFAULT_SETTINGS_KEY, LEGACY);

      const report = await migrateFromV1(db, kv);
      expect(report.ran).toBe(true);
      expect(report.profile?.id).toBe(first.id);
      expect(await listProfiles(db, { includeDeleted: true })).toHaveLength(3);
      expect(await kv.get(profileSettingsKey(first.id))).toEqual(LEGACY);
      expect(await getActiveProfileId(db)).toBe(first.id);
      expect((await migrateFromV1(db, kv)).ran).toBe(false);
    });

    it('keeps an active profile the singer already chose', async () => {
      const { db, kv } = await fresh();
      await createProfile(db, { name: 'A' });
      const b = await createProfile(db, { name: 'B' });
      await setActiveProfileId(db, b.id);
      await migrateFromV1(db, kv);
      expect(await getActiveProfileId(db)).toBe(b.id);
    });
  });

  describe('it waits for durable layers, so a degraded launch cannot strand the Phase 1 settings', () => {
    it('a data db in memory touches nothing: no profile, no marker, the legacy settings stay where they are', async () => {
      const kv = new MemoryKV();
      await kv.set(LEGACY_DEFAULT_SETTINGS_KEY, LEGACY);
      const memory = await openMemoryDb();
      expect(memory.persistent).toBe(false);

      await expect(migrateFromV1(memory, kv)).resolves.toEqual({ ran: false, profile: null, settingsMigrated: false });
      expect(await kv.get(LEGACY_DEFAULT_SETTINGS_KEY)).toEqual(LEGACY);
      expect(await kv.keys('profile:')).toEqual([LEGACY_DEFAULT_SETTINGS_KEY]); // no copy under a throwaway id
      expect(await listProfiles(memory, { includeDeleted: true })).toEqual([]);
      await expect(memory.store('meta').get(META_KEYS.migrationV1)).resolves.toBeUndefined();
    });

    it('...and the next launch with a durable db moves the settings under its real profile', async () => {
      const kv = new MemoryKV();
      await kv.set(LEGACY_DEFAULT_SETTINGS_KEY, LEGACY);
      await migrateFromV1(await openMemoryDb(), kv); // the degraded launch

      const { db } = await fresh(); // a healthy one
      const report = await migrateFromV1(db, kv);
      expect(report).toMatchObject({ ran: true, settingsMigrated: true });
      expect(await kv.get(profileSettingsKey(report.profile!.id))).toEqual(LEGACY);
      expect(await kv.get(LEGACY_DEFAULT_SETTINGS_KEY)).toBeUndefined();
      expect(await getActiveProfileId(db)).toBe(report.profile!.id);
      expect(await kv.keys('profile:')).toEqual([profileSettingsKey(report.profile!.id)]); // no stray ghost key
    });

    it('a settings store in memory is treated like a failing one: nothing is read, written or deleted, and the migration stays unfinished', async () => {
      const { db } = await fresh();
      const volatile = new MemoryKV();
      volatile.persistent = false; // what a launch sees when the settings database would not open
      for (const op of ['get', 'set', 'delete', 'keys'] as const) volatile.failing.add(op); // any touch would throw "kv ... failed"

      const report = await migrateFromV1(db, volatile);
      expect(report.ran).toBe(true);
      expect(report.error).toBe('settings store is not persistent');
      expect(report.settingsMigrated).toBe(false);
      expect(report.profile?.name).toBe('Me');
      await expect(db.store('meta').get(META_KEYS.migrationV1)).resolves.toMatchObject({ state: 'started', profileId: report.profile!.id });
      expect(await getActiveProfileId(db)).toBe(report.profile!.id);
    });

    it('...and the next launch with a durable settings store retries with the SAME profile and moves the settings', async () => {
      const { db, kv } = await fresh();
      await kv.set(LEGACY_DEFAULT_SETTINGS_KEY, LEGACY);
      const volatile = new MemoryKV();
      volatile.persistent = false;
      const first = await migrateFromV1(db, volatile);

      const second = await migrateFromV1(db, kv);
      expect(second.ran).toBe(true);
      expect(second.error).toBeUndefined();
      expect(second.settingsMigrated).toBe(true);
      expect(second.profile?.id).toBe(first.profile?.id);
      expect(await listProfiles(db, { includeDeleted: true })).toHaveLength(1);
      expect(await kv.get(profileSettingsKey(first.profile!.id))).toEqual(LEGACY);
      expect(await kv.get(LEGACY_DEFAULT_SETTINGS_KEY)).toBeUndefined();
      await expect(db.store('meta').get(META_KEYS.migrationV1)).resolves.toMatchObject({ state: 'done' });
    });

    it('a persistent settings store still completes in one go (the usual first run)', async () => {
      const { db, kv } = await fresh();
      expect(kv.persistent).toBe(true);
      await kv.set(LEGACY_DEFAULT_SETTINGS_KEY, LEGACY);
      const report = await migrateFromV1(db, kv);
      expect(report).toMatchObject({ ran: true, settingsMigrated: true });
      expect(report.error).toBeUndefined();
    });
  });
});
