/**
 * Settings + DeviceSettings signals, loaded from KV and saved back on
 * change. Difficulty/tolerance is never stored here (docs/DESIGN.md,
 * settings-types.ts): it comes from the level, not a setting.
 *
 * Loading is async (IndexedDB); every signal here starts at its default so
 * screens can render immediately, then updates in place once the store
 * resolves. Code that must not show stale defaults even briefly (e.g. the
 * first-run sheet) should await `settingsReady` first.
 */
import { effect, signal } from '@preact/signals';
import { openKV } from '../storage/kv';
import type { KVStore } from '../storage/kv-types';
import type { OutputRoute } from '../core/types';
import type { LatencyCalibration } from '../audio/latency-types';
import {
  DEFAULT_DEVICE_SETTINGS,
  DEFAULT_SETTINGS,
  type DeviceSettings,
  type Settings,
} from './settings-types';

const SETTINGS_KEY = 'profile:default:settings';
const DEVICE_KEY = 'device:settings';

/** iOS can kill a home-screen app under memory pressure: persist promptly, not lazily. */
const SAVE_DEBOUNCE_MS = 400;

export const settings = signal<Settings>(DEFAULT_SETTINGS);
export const deviceSettings = signal<DeviceSettings>(DEFAULT_DEVICE_SETTINGS);

/** False once the store resolves `persistent: false` (e.g. private browsing without IndexedDB). */
export const storagePersistent = signal(true);

/** True once the initial load from KV has completed (defaults merged over). */
export const settingsLoaded = signal(false);

let kv: KVStore | null = null;
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function mergeDefaults<T>(defaults: T, stored: Partial<T> | undefined): T {
  return stored ? { ...defaults, ...stored } : defaults;
}

function scheduleSave(key: string, value: unknown): void {
  const pending = saveTimers.get(key);
  if (pending !== undefined) clearTimeout(pending);
  saveTimers.set(
    key,
    setTimeout(() => {
      saveTimers.delete(key);
      void kv?.set(key, value);
    }, SAVE_DEBOUNCE_MS)
  );
}

/** Save on every change after the first (loaded) value, debounced per key. */
function watchAndSave<T>(sig: { readonly value: T }, key: string): void {
  let first = true;
  effect(() => {
    const value = sig.value;
    if (first) {
      first = false;
      return;
    }
    scheduleSave(key, value);
  });
}

async function load(): Promise<void> {
  kv = await openKV();
  storagePersistent.value = kv.persistent;
  const [storedSettings, storedDevice] = await Promise.all([
    kv.get<Settings>(SETTINGS_KEY),
    kv.get<DeviceSettings>(DEVICE_KEY),
  ]);
  settings.value = mergeDefaults(DEFAULT_SETTINGS, storedSettings);
  deviceSettings.value = mergeDefaults(DEFAULT_DEVICE_SETTINGS, storedDevice);
  watchAndSave(settings, SETTINGS_KEY);
  watchAndSave(deviceSettings, DEVICE_KEY);
  settingsLoaded.value = true;
}

/** Resolves once the initial KV load (and default merge) has completed. */
export const settingsReady: Promise<void> = load();

export function updateSettings(patch: Partial<Settings>): void {
  settings.value = { ...settings.value, ...patch };
}

export function updateDeviceSettings(patch: Partial<DeviceSettings>): void {
  deviceSettings.value = { ...deviceSettings.value, ...patch };
}

export function setLatencyCalibration(route: OutputRoute, calibration: LatencyCalibration): void {
  updateDeviceSettings({ latency: { ...deviceSettings.value.latency, [route]: calibration } });
}
