import type { OutputRoute, VibratoStyle } from '../core/types';
import type { Notation } from '../core/music';
import type { DetectorKind } from '../dsp/detector-types';
import type { LatencyCalibration } from '../audio/latency-types';
import type { Timbre } from '../audio/synth-types';

/**
 * Per-profile preferences. Stored at `profile:<id>:settings` (storage/keys.ts
 * profileSettingsKey) for the active profile and validated on read with the
 * storage `sanitizeSettings` (a new field needs a cleaner there too).
 * Difficulty/tolerance is NOT a setting - it comes from the level the singer
 * has reached.
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
  /** Daily-workout length last chosen (SPEC §12: 5, 10 or 20 minutes). */
  workoutMinutes: 5 | 10 | 20;
  /** Keep each take's audio on this device for playback, slow-down and WAV export. Audio never leaves the device unless exported. */
  keepTakeAudio: boolean;
  /** This singer has seen the voice-care note (first run, SPEC §12). */
  voiceCareSeen: boolean;
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
  workoutMinutes: 10,
  keepTakeAudio: true,
  voiceCareSeen: false,
};

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = {
  schemaVersion: 1,
  route: 'unknown',
  inputDeviceId: null,
  latency: {},
  headphoneGuideSeen: false,
  sessionCheck: null,
};
