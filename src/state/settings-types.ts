import type { OutputRoute, VibratoStyle } from '../core/types';
import type { Notation } from '../core/music';
import type { DetectorKind } from '../dsp/detector-types';
import type { LatencyCalibration } from '../audio/latency-types';
import type { Timbre } from '../audio/synth-types';

/**
 * Per-profile preferences. Stored at `profile:<id>:settings` (Phase 1 uses id
 * "default"; Phase 3 adds a profile switcher). Difficulty/tolerance is NOT a
 * setting - it comes from the level the singer has reached.
 */
export interface Settings {
  schemaVersion: 1;
  vibratoStyle: VibratoStyle;
  detector: DetectorKind;
  referenceTimbre: Timbre;
  /** 0..1 */
  referenceVolume: number;
  notation: Notation;
  theme: 'system' | 'dark' | 'light';
  reducedMotion: 'system' | 'on' | 'off';
  showNoteNames: boolean;
}

/**
 * Per-device facts, shared by all profiles. Stored at `device:settings`.
 * Latency depends on the phone + output route, not on who is singing.
 */
export interface DeviceSettings {
  schemaVersion: 1;
  route: OutputRoute;
  /** Preferred mic deviceId (null = default). Device ids are per-origin and can change; fall back silently. */
  inputDeviceId: string | null;
  latency: Partial<Record<OutputRoute, LatencyCalibration>>;
  headphoneGuideSeen: boolean;
  /** Result of the manual "did audio go to the earpiece / duck?" check. */
  sessionCheck: {
    date: string;
    route: OutputRoute;
    earpiece: boolean;
    ducked: boolean;
    userAgent: string;
  } | null;
}

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1,
  vibratoStyle: 'pop',
  detector: 'mpm',
  referenceTimbre: 'piano',
  referenceVolume: 0.7,
  notation: 'sharps',
  theme: 'system',
  reducedMotion: 'system',
  showNoteNames: true,
};

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = {
  schemaVersion: 1,
  route: 'unknown',
  inputDeviceId: null,
  latency: {},
  headphoneGuideSeen: false,
  sessionCheck: null,
};
