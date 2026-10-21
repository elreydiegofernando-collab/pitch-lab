/**
 * src/state/settings.ts against a fake KVStore (no IndexedDB needed). Each
 * test mocks ../storage/kv fresh via vi.doMock + resetModules, since the
 * load() call that reads from KV fires once, at module-evaluation time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KVStore } from '../storage/kv-types';
import { DEFAULT_DEVICE_SETTINGS, DEFAULT_SETTINGS, type DeviceSettings, type Settings } from './settings-types';

function createFakeKV(
  initial: Readonly<Record<string, unknown>> = {},
  persistent = true
): { kv: KVStore; data: Map<string, unknown> } {
  const data = new Map<string, unknown>(Object.entries(initial));
  const kv: KVStore = {
    persistent,
    async get<T>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined;
    },
    async set<T>(key: string, value: T): Promise<void> {
      data.set(key, value);
    },
    async delete(key: string): Promise<void> {
      data.delete(key);
    },
    async keys(prefix?: string): Promise<string[]> {
      return [...data.keys()].filter((k) => !prefix || k.startsWith(prefix));
    },
  };
  return { kv, data };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('state/settings: load', () => {
  it('starts from the documented defaults once the store resolves', async () => {
    const { kv } = createFakeKV();
    vi.doMock('../storage/kv', () => ({ openKV: async () => kv }));

    const mod = await import('./settings');
    await mod.settingsReady;

    expect(mod.settings.value).toEqual(DEFAULT_SETTINGS);
    expect(mod.deviceSettings.value).toEqual(DEFAULT_DEVICE_SETTINGS);
    expect(mod.storagePersistent.value).toBe(true);
    expect(mod.settingsLoaded.value).toBe(true);
  });

  it('merges partial stored values over the defaults, not replacing them', async () => {
    const storedSettings: Partial<Settings> = { schemaVersion: 1, theme: 'light' };
    const storedDevice: Partial<DeviceSettings> = { schemaVersion: 1, route: 'bluetooth' };
    const { kv } = createFakeKV({
      'profile:default:settings': storedSettings,
      'device:settings': storedDevice,
    });
    vi.doMock('../storage/kv', () => ({ openKV: async () => kv }));

    const mod = await import('./settings');
    await mod.settingsReady;

    expect(mod.settings.value).toEqual({ ...DEFAULT_SETTINGS, theme: 'light' });
    expect(mod.deviceSettings.value).toEqual({ ...DEFAULT_DEVICE_SETTINGS, route: 'bluetooth' });
  });

  it('surfaces a non-persistent store', async () => {
    const { kv } = createFakeKV({}, false);
    vi.doMock('../storage/kv', () => ({ openKV: async () => kv }));

    const mod = await import('./settings');
    await mod.settingsReady;

    expect(mod.storagePersistent.value).toBe(false);
  });
});

describe('state/settings: save', () => {
  it('does not write the initial (merged) load back to the store', async () => {
    const { kv, data } = createFakeKV();
    vi.doMock('../storage/kv', () => ({ openKV: async () => kv }));

    const mod = await import('./settings');
    await mod.settingsReady;
    await vi.advanceTimersByTimeAsync(1000);

    expect(data.has('profile:default:settings')).toBe(false);
    expect(data.has('device:settings')).toBe(false);
  });

  it('saves changes back to the store, debounced', async () => {
    const { kv, data } = createFakeKV();
    vi.doMock('../storage/kv', () => ({ openKV: async () => kv }));

    const mod = await import('./settings');
    await mod.settingsReady;

    mod.updateSettings({ theme: 'dark' });

    // Not yet written: the save is debounced.
    expect(data.has('profile:default:settings')).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);

    expect((data.get('profile:default:settings') as Settings).theme).toBe('dark');
  });

  it('coalesces rapid changes into a single debounced save', async () => {
    const { kv } = createFakeKV();
    vi.doMock('../storage/kv', () => ({ openKV: async () => kv }));
    const setSpy = vi.spyOn(kv, 'set');

    const mod = await import('./settings');
    await mod.settingsReady;

    mod.updateSettings({ theme: 'dark' });
    mod.updateSettings({ showNoteNames: false });
    mod.updateSettings({ notation: 'flats' });
    await vi.advanceTimersByTimeAsync(1000);

    const settingsWrites = setSpy.mock.calls.filter(([key]) => key === 'profile:default:settings');
    expect(settingsWrites).toHaveLength(1);
    expect((settingsWrites[0][1] as Settings).notation).toBe('flats');
  });

  it('stores a latency calibration keyed by route via setLatencyCalibration()', async () => {
    const { kv, data } = createFakeKV();
    vi.doMock('../storage/kv', () => ({ openKV: async () => kv }));

    const mod = await import('./settings');
    await mod.settingsReady;

    mod.setLatencyCalibration('wired', {
      route: 'wired',
      method: 'loopback',
      roundTripMs: 42,
      jitterMs: 3,
      matched: 10,
      date: '2026-01-01',
    });
    expect(mod.deviceSettings.value.latency.wired?.roundTripMs).toBe(42);

    await vi.advanceTimersByTimeAsync(1000);
    expect((data.get('device:settings') as DeviceSettings).latency.wired?.roundTripMs).toBe(42);
  });
});
