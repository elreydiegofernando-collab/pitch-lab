import type { OutputRoute } from '../core/types';
import type { AudioEngine, Unsubscribe } from './engine-types';
import type { ReferenceSynth } from './synth-types';

/**
 * Round-trip latency: how much later a sound the user hears (and reacts to)
 * shows up on the input timeline, relative to when it was scheduled on the
 * AudioContext clock. Sing-along scoring subtracts this from frame times.
 *
 *  - loopback: speaker -> mic, sample-accurate transient detection (wired / built-in speaker)
 *  - sing:     user sings a short "ta" on each click; onset detection (works with Bluetooth too)
 *  - tap:      user taps on each click; measures output + touch latency only (fallback)
 */
export type CalibrationMethod = 'loopback' | 'sing' | 'tap';

export interface LatencyCalibration {
  route: OutputRoute;
  method: CalibrationMethod;
  /** Median offset, milliseconds (positive = input arrives later than scheduled). */
  roundTripMs: number;
  /** Robust spread (1.4826 * MAD), milliseconds. */
  jitterMs: number;
  /** Matched click/onset pairs used. */
  matched: number;
  /** ISO date of the calibration. */
  date: string;
}

export interface OffsetEstimate {
  offsetMs: number;
  jitterMs: number;
  matched: number;
  /** Detected events that matched no scheduled event (or were rejected as outliers). */
  rejected: number;
  /** True when matched >= minMatches and jitter <= maxJitterMs. */
  ok: boolean;
}

export interface CalibrationProgress {
  clicksPlayed: number;
  clicksTotal: number;
  eventsDetected: number;
}

/** A running calibration (see startCalibration() in latency.ts). */
export interface CalibrationSession {
  readonly method: CalibrationMethod;
  /** 'tap' method only: call from the pointerdown handler with event.timeStamp. */
  tap(eventTimeStamp: number): void;
  onProgress(cb: (p: CalibrationProgress) => void): Unsubscribe;
  /** Resolves when the click train finishes (or rejects on cancel/engine error). */
  readonly result: Promise<OffsetEstimate>;
  cancel(): void;
}

export interface CalibrationDeps {
  engine: AudioEngine;
  synth: ReferenceSynth;
}
