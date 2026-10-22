/**
 * src/state/settings.ts against an in-memory KV (no IndexedDB). The session is the loader (loadSettings at boot and
 * on every profile switch); these tests play the session. Each test imports a fresh module (resetModules + dynamic
 * import): settingsReady and the pending writes are module state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_SETTINGS_KEY, profileSettingsKey } from '../storage';
import { MemoryKV } from '../storage/test-helpers';
import { DEFAULT_DEVICE_SETTINGS, DEFAULT_SETTINGS, type DeviceSettings, type Settings } from './settings-types';

type SettingsModule = typeof import('./settings');

const A = 'profile-a';
const B = 'profile-b';

async function fresh(): Promise<SettingsModule> {
  return import('./settings');
}

function source(kv: MemoryKV, profileId = A, extra: { profileDurable?: boolean; persistent?: boolean } = {}) {
  return { kv, profileId, profileDurable: extra.profileDurable ?? true, persistent: extra.persistent ?? true };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('state/settings: load', () => {
  it('starts at the defaults and resolves settingsReady only once the session has loaded them', async () => {
    const mod = await fresh();
    let ready = false;
    void mod.settingsReady.then(() => {
      ready = true;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(ready).toBe(false);
    expect(mod.settings.value).toEqual(DEFAULT_SETTINGS);

    await mod.loadSettings(source(new MemoryKV()));
    await mod.settingsReady;
    expect(ready).toBe(true);
    expect(mod.settings.value).toEqual(DEFAULT_SETTINGS);
    expect(mod.deviceSettings.value).toEqual(DEFAULT_DEVICE_SETTINGS);
    expect(mod.settingsLoaded.value).toBe(true);
    expect(mod.storagePersistent.value).toBe(true);
  });

  it("merges the active profile's stored values and the device values over the defaults", async () => {
    const kv = new MemoryKV();
    await kv.set(profileSettingsKey(A), { schemaVersion: 1, theme: 'light', workoutMinutes: 20 });
    await kv.set(DEVICE_SETTINGS_KEY, { schemaVersion: 1, route: 'bluetooth' });
    const mod = await fresh();
    await mod.loadSettings(source(kv));
    expect(mod.settings.value).toEqual({ ...DEFAULT_SETTINGS, theme: 'light', workoutMinutes: 20 });
    expect(mod.deviceSettings.value).toEqual({ ...DEFAULT_DEVICE_SETTINGS, route: 'bluetooth' });
  });

  it('validates on read: values this build does not understand fall back to the defaults', async () => {
    const kv = new MemoryKV();
    await kv.set(profileSettingsKey(A), { vibratoStyle: 'operatic', referenceVolume: 7, showNoteNames: 'yes', theme: 'dark', constructor: 'x' });
    await kv.set(DEVICE_SETTINGS_KEY, {
      route: 'telepathy',
      inputDeviceId: 42,
      headphoneGuideSeen: true,
      latency: { wired: { roundTripMs: 38, jitterMs: 2, matched: 9, method: 'loopback', date: '2026-10-01' }, bluetooth: { roundTripMs: 'slow' } },
    });
    const mod = await fresh();
    await mod.loadSettings(source(kv));
    expect(mod.settings.value).toEqual({ ...DEFAULT_SETTINGS, referenceVolume: 1, theme: 'dark' });
    expect(mod.deviceSettings.value).toEqual({
      ...DEFAULT_DEVICE_SETTINGS,
      headphoneGuideSeen: true,
      latency: { wired: { route: 'wired', method: 'loopback', roundTripMs: 38, jitterMs: 2, matched: 9, date: '2026-10-01' } },
    });
  });

  it('mirrors a non-persistent storage', async () => {
    const mod = await fresh();
    await mod.loadSettings(source(new MemoryKV(), A, { persistent: false }));
    expect(mod.storagePersistent.value).toBe(false);
  });

  it('when storage could not open: settingsReady still resolves, the defaults stay, nothing is written', async () => {
    const kv = new MemoryKV();
    const mod = await fresh();
    mod.settingsUnavailable();
    await mod.settingsReady;
    expect(mod.settings.value).toEqual(DEFAULT_SETTINGS);
    expect(mod.settingsLoaded.value).toBe(false);
    expect(mod.storagePersistent.value).toBe(false);
    mod.updateSettings({ theme: 'dark' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(kv.map.size).toBe(0);
  });

  it('settings that could not be read are never overwritten with defaults', async () => {
    const kv = new MemoryKV();
    await kv.set(profileSettingsKey(A), { schemaVersion: 1, theme: 'light' });
    kv.failing.add('get');
    const mod = await fresh();
    await mod.loadSettings(source(kv));
    expect(mod.settings.value).toEqual(DEFAULT_SETTINGS);
    mod.updateSettings({ notation: 'flats' });
    await vi.advanceTimersByTimeAsync(1000);
    kv.failing.clear();
    expect(await kv.get(profileSettingsKey(A))).toEqual({ schemaVersion: 1, theme: 'light' });
  });
});

describe('state/settings: save', () => {
  it('does not write the loaded values back', async () => {
    const kv = new MemoryKV();
    const mod = await fresh();
    await mod.loadSettings(source(kv));
    await vi.advanceTimersByTimeAsync(1000);
    expect(kv.map.size).toBe(0);
  });

  it("saves changes under the active profile's key, debounced and coalesced", async () => {
    const kv = new MemoryKV();
    const setSpy = vi.spyOn(kv, 'set');
    const mod = await fresh();
    await mod.loadSettings(source(kv));

    mod.updateSettings({ theme: 'dark' });
    mod.updateSettings({ showNoteNames: false });
    mod.updateSettings({ notation: 'flats' });
    expect(kv.map.has(profileSettingsKey(A))).toBe(false); // not yet: debounced
    await vi.advanceTimersByTimeAsync(mod.SAVE_DEBOUNCE_MS + 10);

    const writes = setSpy.mock.calls.filter(([key]) => key === profileSettingsKey(A));
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark', showNoteNames: false, notation: 'flats' });
  });

  it('saves a direct assignment to the signal too', async () => {
    const kv = new MemoryKV();
    const mod = await fresh();
    await mod.loadSettings(source(kv));
    mod.settings.value = { ...mod.settings.value, keepTakeAudio: false };
    await vi.advanceTimersByTimeAsync(1000);
    expect((await kv.get<Settings>(profileSettingsKey(A)))?.keepTakeAudio).toBe(false);
  });

  it('stores a latency calibration keyed by route under the device key', async () => {
    const kv = new MemoryKV();
    const mod = await fresh();
    await mod.loadSettings(source(kv));
    mod.setLatencyCalibration('wired', { route: 'wired', method: 'loopback', roundTripMs: 42, jitterMs: 3, matched: 10, date: '2026-01-01' });
    expect(mod.deviceSettings.value.latency.wired?.roundTripMs).toBe(42);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await kv.get<DeviceSettings>(DEVICE_SETTINGS_KEY))?.latency.wired?.roundTripMs).toBe(42);
  });

  it('a throwaway profile (the data db fell back to memory) never gets settings written; device settings still are', async () => {
    const kv = new MemoryKV();
    const mod = await fresh();
    await mod.loadSettings(source(kv, 'ghost', { profileDurable: false, persistent: false }));
    mod.updateSettings({ theme: 'light' });
    mod.updateDeviceSettings({ headphoneGuideSeen: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await kv.keys('profile:')).toEqual([]);
    expect((await kv.get<DeviceSettings>(DEVICE_SETTINGS_KEY))?.headphoneGuideSeen).toBe(true);
    expect(mod.settings.value.theme).toBe('light'); // still in force for this visit
  });

  it('flushSettings writes what is pending at once', async () => {
    const kv = new MemoryKV();
    const mod = await fresh();
    await mod.loadSettings(source(kv));
    mod.updateSettings({ theme: 'dark' });
    await mod.flushSettings();
    expect((await kv.get<Settings>(profileSettingsKey(A)))?.theme).toBe('dark');
  });

  it('discardPendingSettings drops pending profile settings', async () => {
    const kv = new MemoryKV();
    const mod = await fresh();
    await mod.loadSettings(source(kv));
    mod.updateSettings({ theme: 'dark' });
    mod.discardPendingSettings();
    await vi.advanceTimersByTimeAsync(1000);
    expect(kv.map.size).toBe(0);
  });

  it('discardPendingSettings keeps a pending device change: an import or Delete all data keeps the device settings', async () => {
    const kv = new MemoryKV();
    const mod = await fresh();
    await mod.loadSettings(source(kv));
    mod.updateDeviceSettings({ headphoneGuideSeen: true });
    mod.updateSettings({ theme: 'dark' });
    mod.discardPendingSettings();
    // The session reloads right away: the device change is written before it is read back.
    await mod.loadSettings(source(kv));
    expect(mod.deviceSettings.value.headphoneGuideSeen).toBe(true);
    expect(await kv.get(profileSettingsKey(A))).toBeUndefined();
  });
});

describe('state/settings: profile switch', () => {
  it("writes a pending change under the profile it was made for, then loads the next profile's own settings", async () => {
    const kv = new MemoryKV();
    await kv.set(profileSettingsKey(B), { schemaVersion: 1, workoutMinutes: 5 });
    const mod = await fresh();
    await mod.loadSettings(source(kv, A));
    mod.updateSettings({ theme: 'light' }); // pending for A when the switch starts

    await mod.loadSettings(source(kv, B));
    expect((await kv.get<Settings>(profileSettingsKey(A)))?.theme).toBe('light');
    expect(await kv.get(profileSettingsKey(B))).toEqual({ schemaVersion: 1, workoutMinutes: 5 });
    expect(mod.settings.value).toEqual({ ...DEFAULT_SETTINGS, workoutMinutes: 5 });

    mod.updateSettings({ notation: 'flats' });
    await vi.advanceTimersByTimeAsync(1000);
    expect((await kv.get<Settings>(profileSettingsKey(B)))?.notation).toBe('flats');
    expect((await kv.get<Settings>(profileSettingsKey(A)))?.notation).toBe('sharps');
  });

  it('writes nothing for a change made while the next profile is still loading', async () => {
    const kv = new MemoryKV();
    const mod = await fresh();
    await mod.loadSettings(source(kv, A));
    const loading = mod.loadSettings(source(kv, B));
    mod.updateSettings({ theme: 'dark' }); // A's values, changed mid-switch: must not land under B (or A)
    await loading;
    await vi.advanceTimersByTimeAsync(1000);
    expect(kv.map.size).toBe(0);
    expect(mod.settings.value).toEqual(DEFAULT_SETTINGS);
  });

  it('the newest load wins when two overlap', async () => {
    const kv = new MemoryKV();
    await kv.set(profileSettingsKey(A), { theme: 'light' });
    await kv.set(profileSettingsKey(B), { theme: 'dark' });
    const mod = await fresh();
    await Promise.all([mod.loadSettings(source(kv, A)), mod.loadSettings(source(kv, B))]);
    expect(mod.settings.value.theme).toBe('dark');
    mod.updateSettings({ notation: 'flats' });
    await mod.flushSettings();
    expect((await kv.get<Settings>(profileSettingsKey(B)))?.notation).toBe('flats');
    expect(await kv.get(profileSettingsKey(A))).toEqual({ theme: 'light' });
  });
});
