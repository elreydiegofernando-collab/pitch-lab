/**
 * Shared data types. This file is a contract between modules: change it only
 * deliberately, and update docs/ARCHITECTURE.md when you do.
 */

/** One analysis frame from the pitch tracker (~94 per second). */
export interface PitchFrame {
  /**
   * Time of the analysis window's centre, in AudioContext seconds on the
   * *input* timeline (sample index of the window centre / sampleRate).
   * Not latency-compensated; see LatencyCalibration for the offset.
   */
  t: number;
  /** Fundamental frequency in Hz; NaN when no pitch was found. */
  f0Hz: number;
  /** Fractional MIDI note number (69 = A4 = 440 Hz); NaN when unpitched. */
  midi: number;
  /** Cents from the nearest equal-tempered note, in [-50, 50); NaN when unpitched. */
  centsFromNearest: number;
  /** Detector confidence 0..1 (for MPM: the interpolated NSDF peak height, "clarity"). */
  confidence: number;
  /** RMS level of the analysis window in dBFS (<= 0, clamped at CONFIG.audio.rmsFloorDb). Always present, even when unpitched. */
  rmsDb: number;
  /**
   * True when confidence >= minConfidence, rmsDb >= minRmsDb and f0 lies in
   * [minHz, maxHz]. Analyzers ignore unvoiced frames (silence, breaths).
   */
  voiced: boolean;
}

/**
 * A recorded pitch track: frames sorted by ascending `t`. Analyzers are pure
 * functions over a PitchTrack plus a Target. Take-relative tracks have `t`
 * re-based so that t = 0 is the exercise downbeat, after latency compensation.
 */
export type PitchTrack = readonly PitchFrame[];

/** One target note (or glide) the singer should produce. Times are take-relative seconds. */
export interface TargetNote {
  /** MIDI note number of the (start) pitch. Usually integer. */
  midi: number;
  /** Start time, seconds (t = 0 is the exercise downbeat). */
  start: number;
  /** End time, seconds. */
  end: number;
  /** For glides/slides: the pitch the glide must arrive at by `end`. */
  toMidi?: number;
  /** Optional lyric/syllable (song mode). */
  lyric?: string;
}

export interface Target {
  notes: TargetNote[];
  /** Tempo, when the exercise is metronomic. */
  bpm?: number;
}

/** Tolerance presets, in +/- cents. Values live in CONFIG.tolerance. */
export type ToleranceLevel = 'easy' | 'default' | 'studio';

/** Vibrato target-zone presets. Values live in CONFIG.vibrato.styles. */
export type VibratoStyle = 'pop' | 'classical';

/** Which headphone/speaker route the user is on (self-declared; browsers cannot reliably detect it). */
export type OutputRoute = 'wired' | 'bluetooth' | 'speaker' | 'unknown';
