/**
 * The session on real storage code over fake-indexeddb: boot (and a failed boot), the guard it installs, attempts and
 * the recomputed snapshot, profile operations (switch, create, rename, delete), settings per profile, a non-durable
 * launch, Phase 1 settings migration, and the reload after Delete all data. Each test gets a fresh IndexedDB and a
 * fresh module graph (resetModules + dynamic imports), because the session, the router and the settings are module
 * state.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttemptFields } from '../progress/attempt';
import { installNoOpfs } from '../storage/test-helpers';

const songs = vi.hoisted(() => ({ loadSongs: vi.fn(async () => undefined) }));

// The song index is the song builder's; the session only asks it to (re)load.
vi.mock('./songs', async () => {
  const { signal } = await import('@preact/signals');
  return {
    songIndex: signal(new Map()),
    songsLoaded: signal(true),
    songLoadErrors: signal([]),
    loadSongs: songs.loadSongs,
    getSong: async () => undefined,
  };
});

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
  installNoOpfs();
  songs.loadSongs.mockClear();
});

afterEach(() => {
  vi.doUnmock('../storage');
  vi.unstubAllGlobals();
});

async function modules() {
  const session = await import('./session');
  const router = await import('../router');
  const settings = await import('./settings');
  const runner = await import('../runtime/runner');
  const workout = await import('../runtime/workout');
  const storageKeys = await import('../storage/keys');
  return { session, router, settings, runner, workout, keys: storageKeys };
}

async function booted() {
  const m = await modules();
  await m.session.bootSession();
  return m;
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A passed Range finder take for `profileId` (what the runner writes for it). */
function rangeFinderPass(profileId: string, passed = true): AttemptFields {
  return {
    profileId,
    exerciseId: 'foundations.range-finder.1',
    levelId: 'foundations.01',
    kind: 'practice',
    score: passed ? 0.95 : 0.2,
    passed,
    mastery: passed ? 3 : 0,
    metrics: { 'range.spanSemitones': passed ? 24 : 4 },
    durationSec: 30,
    tonicMidi: 57,
    tempoBpm: 60,
    takeId: null,
  };
}

describe('session: boot', () => {
  it('opens storage, loads the default profile and its progress, installs the guard and loads the songs', async () => {
    const { session, router, settings } = await booted();
    expect(session.bootPhase.value).toBe('ready');
    expect(session.bootError.value).toBeNull();
    expect(session.storageDurable.value).toBe(true);
    expect(settings.storagePersistent.value).toBe(true);
    const me = session.activeProfile.value!;
    expect(me.name).toBe('Me');
    expect(session.profiles.value.map((p) => p.id)).toEqual([me.id]);
    expect(session.attemptLog.value).toEqual([]);
    expect(session.snapshot.value.profileId).toBe(me.id);
    expect(session.snapshot.value.levels['foundations.01'].status).toBe('current');
    expect(session.isUnlocked('live.basic')).toBe(true);
    expect(session.isUnlocked('dashboard')).toBe(false);
    await settings.settingsReady;
    expect(settings.settingsLoaded.value).toBe(true);
    expect(songs.loadSongs).toHaveBeenCalledTimes(1);

    // The guard is in: a locked level is refused with its requirement, the current one opens.
    expect(router.navigate('level', { levelId: 'foundations.02' })).toBe(false);
    expect(router.route.value).toEqual(router.routeOf('map', { worldId: 'foundations' }));
    expect(router.refusal.value?.hint).toBe('Pass Range finder to unlock.');
    expect(router.navigate('level', { levelId: 'foundations.01' })).toBe(true);

    // Reconcile ran once, after boot, off the critical path.
    await until(() => session.reconcileReport.value !== null);
    expect(session.reconcileReport.value).toMatchObject({ orphanFilesRemoved: 0, danglingTakes: 0, danglingSongs: 0 });
  });

  it('loads the song index before it opens a waiting deep link, so a #/song link is judged against it', async () => {
    let release: () => void = () => {};
    songs.loadSongs.mockImplementationOnce(() => new Promise<undefined>((resolve) => (release = () => resolve(undefined))));
    const { session, router } = await modules();
    router.resetRouterForTests([router.routeOf('home')], router.routeOf('song', { songId: 'amazing-grace' }));
    const boot = session.bootSession();
    await until(() => songs.loadSongs.mock.calls.length === 1);
    expect(session.bootPhase.value).toBe('booting');
    expect(router.refusal.value).toBeNull(); // the link still waits
    release();
    await boot;
    expect(session.bootPhase.value).toBe('ready');
    // Judged now: Song Stage is still locked for a brand-new singer.
    expect(router.refusal.value?.hint).toBe('Pass the Foundations Boss Recital to open Song Stage.');
    expect(router.route.value.name).toBe('home');
  });

  it('is idempotent: one boot, one storage', async () => {
    const { session } = await modules();
    const a = session.bootSession();
    const b = session.bootSession();
    expect(b).toBe(a);
    await a;
    const storage = session.appStorage.value;
    await session.bootSession();
    await session.whenSessionReady();
    expect(session.appStorage.value).toBe(storage);
    expect(songs.loadSongs).toHaveBeenCalledTimes(1);
  });

  it('a failed boot says why in plain words, never throws, lets settings waiters go on, and refuses writes', async () => {
    vi.doMock('../storage', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../storage')>()),
      getStorage: () => Promise.reject(new Error('the disk is on fire')),
    }));
    const { session, settings, router } = await modules();
    await expect(session.bootSession()).resolves.toBeUndefined();
    expect(session.bootPhase.value).toBe('failed');
    expect(session.bootError.value).toContain('Reload');
    expect(session.bootError.value).toContain('the disk is on fire');
    expect(session.storageDurable.value).toBe(false);
    await settings.settingsReady;
    await expect(session.recordAttempt(rangeFinderPass('x'))).rejects.toThrow(/Reload/);
    // No guard: only utilities open.
    expect(router.navigate('level', { levelId: 'foundations.01' })).toBe(false);
    expect(router.navigate('settings')).toBe(true);
  });
});

describe('session: attempts', () => {
  it('appends, reloads the log, recomputes the snapshot and returns before and after', async () => {
    const { session } = await booted();
    const me = session.activeProfile.value!;
    const { attempt, before, after } = await session.recordAttempt(rangeFinderPass(me.id));
    expect(attempt).toMatchObject({ profileId: me.id, levelId: 'foundations.01', passed: true });
    expect(before.levels['foundations.01'].status).toBe('current');
    expect(after.levels['foundations.01'].status).toBe('passed');
    expect(after.levels['foundations.02'].status).toBe('current');
    expect(after.computedAt).toBe(before.computedAt); // the same moment: they differ only by this attempt
    expect(session.attemptLog.value.map((a) => a.id)).toEqual([attempt.id]);
    expect(session.snapshot.value).toEqual(after);
    expect(session.isUnlocked('dashboard')).toBe(true);
    // It is durable: the stored log has it.
    expect((await session.appStorage.value!.attempts.listByProfile(me.id)).map((a) => a.id)).toEqual([attempt.id]);
  });

  it("refuses another profile's attempt and writes nothing", async () => {
    const { session } = await booted();
    await expect(session.recordAttempt(rangeFinderPass('someone-else'))).rejects.toThrow(/no longer active/);
    expect(session.attemptLog.value).toEqual([]);
  });

  it('saves the range on the active profile', async () => {
    const { session } = await booted();
    const range = { comfortable: { low: 47, high: 69 }, extended: { low: 45, high: 72 }, measuredAt: '2026-10-22T09:00:00.000Z' };
    await session.saveProfileRange(range);
    expect(session.activeProfile.value?.range).toEqual(range);
    expect(session.profiles.value[0].range).toEqual(range);
    expect((await session.appStorage.value!.profiles.get(session.activeProfile.value!.id))?.range).toEqual(range);
  });
});

describe('session: profiles', () => {
  it('creates, renames and sets the voice type without switching', async () => {
    const { session } = await booted();
    const me = session.activeProfile.value!;
    const beginner = await session.createProfile({ name: 'Beginner', voiceType: 'other' });
    expect(session.profiles.value.map((p) => p.name)).toEqual(['Me', 'Beginner']);
    expect(session.activeProfile.value?.id).toBe(me.id);
    await session.renameProfile(me.id, 'Daniel');
    await session.setProfileVoiceType(me.id, 'tenor');
    expect(session.activeProfile.value).toMatchObject({ name: 'Daniel', voiceType: 'tenor' });
    await session.renameProfile(beginner.id, 'Ana');
    expect(session.profiles.value.map((p) => p.name)).toEqual(['Daniel', 'Ana']);
    expect(session.activeProfile.value?.name).toBe('Daniel');
    await expect(session.createProfile({ name: '   ' })).rejects.toThrow('Give the profile a name.');
    await expect(session.renameProfile(me.id, '')).rejects.toThrow('Give the profile a name.');
    expect(session.profiles.value.map((p) => p.name)).toEqual(['Daniel', 'Ana']);
  });

  it("switching reloads the other singer's settings, log and progress, clears the take state and resets to Home", async () => {
    const { session, settings, runner, workout, router, keys } = await booted();
    const a = session.activeProfile.value!;
    await session.recordAttempt(rangeFinderPass(a.id));
    settings.updateSettings({ theme: 'light' }); // still pending when the switch starts
    workout.startWorkout(5);
    runner.lastOutcome.value = { id: 'x' } as never;
    router.navigate('dashboard');
    const b = await session.createProfile({ name: 'Beginner' });

    await session.switchProfile(b.id);
    expect(session.activeProfile.value?.id).toBe(b.id);
    expect(session.attemptLog.value).toEqual([]);
    expect(session.snapshot.value.profileId).toBe(b.id);
    expect(session.snapshot.value.levels['foundations.01'].status).toBe('current');
    expect(settings.settings.value.theme).toBe('system');
    expect(runner.lastOutcome.value).toBeNull();
    expect(workout.activeWorkout.value).toBeNull();
    expect(router.route.value.name).toBe('home');
    expect(router.canGoBack.value).toBe(false);
    expect(songs.loadSongs).toHaveBeenCalledTimes(2);
    // A's pending change went under A's key, never B's.
    const kv = session.appStorage.value!.kv;
    expect((await kv.get<{ theme: string }>(keys.profileSettingsKey(a.id)))?.theme).toBe('light');
    expect(await kv.get(keys.profileSettingsKey(b.id))).toBeUndefined();
    // The guard now judges B: the dashboard A had earned is shut.
    expect(router.navigate('dashboard')).toBe(false);

    await session.switchProfile(a.id);
    expect(settings.settings.value.theme).toBe('light');
    expect(session.attemptLog.value).toHaveLength(1);
    expect(session.isUnlocked('dashboard')).toBe(true);
    // Relaunch: the active profile is remembered.
    expect(await session.appStorage.value!.profiles.activeId()).toBe(a.id);
  });

  it('a take written while a switch is requested lands in the log it was made for', async () => {
    const { session } = await booted();
    const a = session.activeProfile.value!;
    const b = await session.createProfile({ name: 'Beginner' });
    await Promise.all([session.recordAttempt(rangeFinderPass(a.id)), session.switchProfile(b.id)]);
    expect(session.activeProfile.value?.id).toBe(b.id);
    expect(session.attemptLog.value).toEqual([]);
    expect(await session.appStorage.value!.attempts.listByProfile(a.id)).toHaveLength(1);
  });

  it('switching to a profile that does not exist rejects and changes nothing', async () => {
    const { session } = await booted();
    const me = session.activeProfile.value!;
    await expect(session.switchProfile('nobody')).rejects.toThrow('That profile no longer exists.');
    expect(session.activeProfile.value?.id).toBe(me.id);
  });

  it('deletes another profile in place, and the active one by moving to another (a fresh default after the last)', async () => {
    const { session, router } = await booted();
    const a = session.activeProfile.value!;
    const b = await session.createProfile({ name: 'B' });
    const c = await session.createProfile({ name: 'C' });
    await session.deleteProfile(c.id, { removeRecordings: true });
    expect(session.profiles.value.map((p) => p.id)).toEqual([a.id, b.id]);
    expect(session.activeProfile.value?.id).toBe(a.id);

    router.navigate('settings');
    await session.deleteProfile(a.id, { removeRecordings: false });
    expect(session.activeProfile.value?.id).toBe(b.id);
    expect(session.profiles.value.map((p) => p.id)).toEqual([b.id]);
    expect(router.route.value.name).toBe('home');

    await session.deleteProfile(b.id, { removeRecordings: true });
    expect(session.profiles.value).toHaveLength(1);
    expect(session.activeProfile.value?.name).toBe('Me');
    expect(session.activeProfile.value?.id).not.toBe(b.id);
  });

  it('a delete that fails surfaces its error unchanged and keeps the profile', async () => {
    const { session } = await booted();
    const b = await session.createProfile({ name: 'B' });
    const failure = new Error('a recording would not delete');
    vi.spyOn(session.appStorage.value!.profiles, 'delete').mockRejectedValueOnce(failure);
    await expect(session.deleteProfile(b.id, { removeRecordings: true })).rejects.toBe(failure);
    expect(session.profiles.value.map((p) => p.name)).toEqual(['Me', 'B']);
  });
});

describe('session: reload and degraded launches', () => {
  it('after Delete all data: a fresh default profile, an empty log, pending settings dropped, the router revalidated', async () => {
    const { session, settings, router, runner, keys } = await booted();
    const before = session.activeProfile.value!;
    await session.recordAttempt(rangeFinderPass(before.id));
    expect(router.navigate('level', { levelId: 'foundations.02' })).toBe(true);
    runner.lastOutcome.value = { id: 'x' } as never;
    settings.updateSettings({ theme: 'dark' });

    await session.appStorage.value!.deleteAllData();
    await session.reloadSession();
    expect(session.activeProfile.value?.id).not.toBe(before.id);
    expect(session.attemptLog.value).toEqual([]);
    expect(session.snapshot.value.levels['foundations.02'].status).toBe('locked');
    expect(runner.lastOutcome.value).toBeNull();
    expect(router.route.value.name).toBe('home'); // the level it was on is shut again
    expect(settings.settings.value.theme).toBe('system');
    await new Promise((r) => setTimeout(r, settings.SAVE_DEBOUNCE_MS + 50));
    expect(await session.appStorage.value!.kv.get(keys.profileSettingsKey(before.id))).toBeUndefined();
  });

  it('when IndexedDB is missing: the warning shows, and settings of the throwaway profile are never written', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const { session, settings, keys } = await booted();
    expect(session.bootPhase.value).toBe('ready');
    expect(session.storageDurable.value).toBe(false);
    expect(settings.storagePersistent.value).toBe(false);
    settings.updateSettings({ theme: 'light' });
    settings.updateDeviceSettings({ headphoneGuideSeen: true });
    await settings.flushSettings();
    const kv = session.appStorage.value!.kv;
    expect(await kv.get(keys.profileSettingsKey(session.activeProfile.value!.id))).toBeUndefined();
    expect(await kv.get(keys.DEVICE_SETTINGS_KEY)).toMatchObject({ headphoneGuideSeen: true });
  });

  it("brings Phase 1's settings across to the first profile, validated on read", async () => {
    const { openKV } = await import('../storage/kv');
    const legacy = await openKV();
    await legacy.set('profile:default:settings', { schemaVersion: 1, theme: 'light', vibratoStyle: 'operatic', notation: 'flats' });
    const { session, settings, keys } = await booted();
    expect(settings.settings.value).toMatchObject({ theme: 'light', notation: 'flats', vibratoStyle: 'pop' });
    const kv = session.appStorage.value!.kv;
    expect(await kv.get(keys.LEGACY_DEFAULT_SETTINGS_KEY)).toBeUndefined();
    expect(await kv.get(keys.profileSettingsKey(session.activeProfile.value!.id))).toMatchObject({ theme: 'light' });
  });
});
