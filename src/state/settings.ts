/**
 * Settings (per profile) and DeviceSettings (per device) as signals the screens read.
 *
 * The session (src/state/session.ts) owns loading: it calls `loadSettings()` once storage is open and again after
 * every profile switch, which reloads these signals IN PLACE from the active profile's key (`profile:<id>:settings`)
 * and the device key, through the storage layer's one KV store (AppStorage.kv). Stored values are validated on READ
 * (`{ ...DEFAULT_SETTINGS, ...sanitizeSettings(stored) }`), so a value written by an older or newer build can never
 * crash a screen or an analyzer. Every signal starts at its default, so screens render at once; code that must not
 * act on defaults (the first-run sheet) awaits `settingsReady`.
 *
 * Writes are debounced per key, and the key is bound when the change is made: a write pending for one profile can
 * never land under another's key, a load first flushes what is pending, and nothing is written while a load is in
 * flight. On a launch whose data db fell back to memory the active profile id is a throwaway, so profile settings are
 * then never written (device settings still are). Difficulty is never a setting: it comes from the level.
 *
 * No import of the session (it imports this module).
 */
import { effect, signal } from '@preact/signals';
import type { OutputRoute } from '../core/types';
import type { LatencyCalibration } from '../audio/latency-types';
import { DEVICE_SETTINGS_KEY, profileSettingsKey, sanitizeSettings } from '../storage';
import type { KVStore } from '../storage/kv-types';
import { DEFAULT_DEVICE_SETTINGS, DEFAULT_SETTINGS, type DeviceSettings, type Settings } from './settings-types';

/** iOS can kill a home-screen app under memory pressure: persist promptly, not lazily. */
export const SAVE_DEBOUNCE_MS = 400;

export const settings = signal<Settings>(DEFAULT_SETTINGS);
export const deviceSettings = signal<DeviceSettings>(DEFAULT_DEVICE_SETTINGS);

/** Mirrors the session's `storageDurable` (AppStorage.persistent): false means nothing will survive a reload. */
export const storagePersistent = signal(true);

/** True once the active profile's settings have been loaded (defaults merged over). */
export const settingsLoaded = signal(false);

let resolveReady: () => void = () => undefined;

/** Resolves once the settings are known: loaded for the active profile, or the defaults when storage could not open. */
export const settingsReady: Promise<void> = new Promise<void>((resolve) => {
  resolveReady = resolve;
});

/** Where the session loads settings from. */
export interface SettingsSource {
  /** AppStorage.kv: the one settings store of the page. */
  kv: KVStore;
  /** The active profile. */
  profileId: string;
  /**
   * AppStorage.db.persistent. False: the active profile id is a throwaway that vanishes with the page (and the
   * migration left Phase 1's settings where they were), so profile settings are not written under it.
   */
  profileDurable: boolean;
  /** AppStorage.persistent (every layer durable), mirrored in `storagePersistent`. */
  persistent: boolean;
}

interface PendingWrite {
  kv: KVStore;
  value: unknown;
  timer: ReturnType<typeof setTimeout>;
}

/** Null before the first load, while a load is in flight, and when storage failed or could not be read: nothing is written then. */
let source: SettingsSource | null = null;
/** True while a load assigns the signals, so the writers below do not echo it back. */
let applying = false;
let loadToken = 0;
const pending = new Map<string, PendingWrite>();

async function write(key: string): Promise<void> {
  const p = pending.get(key);
  if (!p) return;
  pending.delete(key);
  clearTimeout(p.timer);
  try {
    await p.kv.set(key, p.value);
  } catch {
    // The in-memory value stays in force; the next change writes it again.
  }
}

function schedule(kv: KVStore, key: string, value: unknown): void {
  const previous = pending.get(key);
  if (previous) clearTimeout(previous.timer);
  pending.set(key, { kv, value, timer: setTimeout(() => void write(key), SAVE_DEBOUNCE_MS) });
}

// Every change after a load is saved (Phase 1 screens and Wave 2 builders write through updateSettings, but a direct
// assignment to the signal is saved too). The key is resolved now, not when the timer fires.
effect(() => {
  const value = settings.value;
  if (applying || !source || !source.profileDurable) return;
  schedule(source.kv, profileSettingsKey(source.profileId), value);
});

effect(() => {
  const value = deviceSettings.value;
  if (applying || !source) return;
  schedule(source.kv, DEVICE_SETTINGS_KEY, value);
});

/** Write every pending change now, each under the key it was made for. */
export async function flushSettings(): Promise<void> {
  await Promise.all([...pending.keys()].map((key) => write(key)));
}

/**
 * The data underneath was replaced (a backup import, Delete all data): pending PROFILE settings are dropped unwritten,
 * since their profile may be gone or replaced. A pending device change (a calibration, the route, the headphone note)
 * still goes in: both keep `device:settings`, and the next load flushes it before it reads.
 */
export function discardPendingSettings(): void {
  for (const [key, p] of [...pending]) {
    if (key === DEVICE_SETTINGS_KEY) continue;
    clearTimeout(p.timer);
    pending.delete(key);
  }
}

const ROUTES: readonly OutputRoute[] = ['wired', 'bluetooth', 'speaker', 'unknown'];
const METHODS: readonly LatencyCalibration['method'][] = ['loopback', 'sing', 'tap'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readCalibration(route: OutputRoute, raw: unknown): LatencyCalibration | undefined {
  if (!isRecord(raw) || !finite(raw.roundTripMs)) return undefined;
  return {
    route,
    method: METHODS.includes(raw.method as LatencyCalibration['method']) ? (raw.method as LatencyCalibration['method']) : 'tap',
    roundTripMs: raw.roundTripMs,
    jitterMs: finite(raw.jitterMs) ? raw.jitterMs : 0,
    matched: finite(raw.matched) ? raw.matched : 0,
    date: typeof raw.date === 'string' ? raw.date : '',
  };
}

/** Stored device settings, checked field by field (a route indexes the latency table; a corrupt one falls back). */
function readDeviceSettings(raw: unknown): DeviceSettings {
  if (!isRecord(raw)) return DEFAULT_DEVICE_SETTINGS;
  const latency: DeviceSettings['latency'] = {};
  if (isRecord(raw.latency)) {
    for (const route of ROUTES) {
      const calibration = readCalibration(route, raw.latency[route]);
      if (calibration) latency[route] = calibration;
    }
  }
  const check = raw.sessionCheck;
  return {
    schemaVersion: 1,
    route: ROUTES.includes(raw.route as OutputRoute) ? (raw.route as OutputRoute) : DEFAULT_DEVICE_SETTINGS.route,
    inputDeviceId: typeof raw.inputDeviceId === 'string' ? raw.inputDeviceId : null,
    latency,
    headphoneGuideSeen: raw.headphoneGuideSeen === true,
    sessionCheck:
      isRecord(check) && typeof check.date === 'string' && ROUTES.includes(check.route as OutputRoute)
        ? {
            date: check.date,
            route: check.route as OutputRoute,
            earpiece: check.earpiece === true,
            ducked: check.ducked === true,
            userAgent: typeof check.userAgent === 'string' ? check.userAgent : '',
          }
        : null,
  };
}

/**
 * Load the active profile's settings and the device settings into the signals, in place. Called by the session at
 * boot and after every profile switch: pending writes are flushed first (each to its own key), and a newer load
 * supersedes an older one still reading.
 */
export async function loadSettings(next: SettingsSource): Promise<void> {
  const token = ++loadToken;
  source = null;
  await flushSettings();
  let stored: unknown;
  let device: unknown;
  let readable = true;
  try {
    [stored, device] = await Promise.all([next.kv.get<unknown>(profileSettingsKey(next.profileId)), next.kv.get<unknown>(DEVICE_SETTINGS_KEY)]);
  } catch {
    readable = false;
  }
  if (token !== loadToken) return;
  applying = true;
  try {
    settings.value = { ...DEFAULT_SETTINGS, ...sanitizeSettings(stored) };
    deviceSettings.value = readDeviceSettings(device);
  } finally {
    applying = false;
  }
  // Settings that could not be read are never overwritten with defaults: changes then last for this visit only.
  source = readable ? next : null;
  storagePersistent.value = next.persistent;
  settingsLoaded.value = true;
  resolveReady();
}

/** Storage could not be opened: keep the defaults, write nothing, and let `settingsReady` waiters go on. */
export function settingsUnavailable(): void {
  loadToken++;
  source = null;
  discardPendingSettings();
  storagePersistent.value = false;
  resolveReady();
}

export function updateSettings(patch: Partial<Settings>): void {
  settings.value = { ...settings.value, ...patch };
}

export function updateDeviceSettings(patch: Partial<DeviceSettings>): void {
  deviceSettings.value = { ...deviceSettings.value, ...patch };
}

export function setLatencyCalibration(route: OutputRoute, calibration: LatencyCalibration): void {
  updateDeviceSettings({ latency: { ...deviceSettings.value.latency, [route]: calibration } });
}
