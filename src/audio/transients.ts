/**
 * Sample-accurate onset ("transient") detector used for loopback latency
 * calibration (speaker/earbud click -> mic) and the mic record/playback
 * check. Pure, allocation-free in process(). See src/audio/latency-types.ts
 * and CONFIG.latency for how callers choose thresholdDb/refractorySec.
 */

/** Seconds of signal after a detected onset over which the peak amplitude is measured. */
const PEAK_WINDOW_SEC = 0.005;

export interface TransientConfig {
  enabled: boolean;
  /** dBFS amplitude threshold; a sample must exceed this (strictly) to start a detection. */
  thresholdDb: number;
  /** Minimum time since the last detection before a new one may start. */
  refractorySec: number;
  sampleRate: number;
}

/**
 * Reports the FIRST sample whose |x| exceeds `thresholdDb` after at least
 * `refractorySec` has elapsed since the previous detection. `peakDb` is the
 * max |x| over the following ~5 ms (PEAK_WINDOW_SEC), which may span
 * several `process()` calls/blocks -- the detector stays "pending" across
 * calls until that window closes, then emits once.
 */
export class TransientDetector {
  private enabled = false;
  private thresholdAmp = 1;
  private refractorySamples = 0;
  private sampleRate = 48000;
  private peakWindowSamples = 1;

  /** Absolute sample index of the last detection (its onset sample), or -Infinity before the first one. */
  private lastOnsetIndex = -Infinity;
  private pending = false;
  private pendingOnsetIndex = 0;
  /** Exclusive: the peak window covers [pendingOnsetIndex, pendingEndIndex). */
  private pendingEndIndex = 0;
  private pendingMaxAbs = 0;

  /**
   * (Re)configure. Also clears any in-flight pending detection and the
   * refractory clock, since a reconfigure (route/threshold change) means
   * the previous measurement's assumptions no longer hold.
   */
  configure(o: TransientConfig): void {
    this.enabled = o.enabled;
    this.thresholdAmp = dbToAmplitude(o.thresholdDb);
    this.sampleRate = o.sampleRate;
    this.refractorySamples = o.refractorySec * o.sampleRate;
    this.peakWindowSamples = Math.max(1, Math.round(o.sampleRate * PEAK_WINDOW_SEC));
    this.lastOnsetIndex = -Infinity;
    this.pending = false;
  }

  /**
   * Scan one block. `frame0` is the absolute (AudioContext) sample index of
   * `block[0]`. Calls `emit(t, peakDb)` once per completed detection.
   */
  process(block: Float32Array, frame0: number, emit: (t: number, peakDb: number) => void): void {
    if (!this.enabled) return;
    const n = block.length;
    for (let i = 0; i < n; i++) {
      const amp = block[i] < 0 ? -block[i] : block[i];
      const absIndex = frame0 + i;

      if (this.pending) {
        if (amp > this.pendingMaxAbs) this.pendingMaxAbs = amp;
        if (absIndex + 1 >= this.pendingEndIndex) {
          this.pending = false;
          emit(this.pendingOnsetIndex / this.sampleRate, amplitudeToDb(this.pendingMaxAbs));
        }
        continue;
      }

      if (amp > this.thresholdAmp && absIndex - this.lastOnsetIndex >= this.refractorySamples) {
        this.lastOnsetIndex = absIndex;
        this.pendingOnsetIndex = absIndex;
        this.pendingEndIndex = absIndex + this.peakWindowSamples;
        this.pendingMaxAbs = amp;
        if (this.pendingEndIndex <= absIndex + 1) {
          // Degenerate (sub-sample) peak window: close immediately.
          emit(this.pendingOnsetIndex / this.sampleRate, amplitudeToDb(this.pendingMaxAbs));
        } else {
          this.pending = true;
        }
      }
    }
  }
}

function dbToAmplitude(db: number): number {
  return Math.pow(10, db / 20);
}

function amplitudeToDb(amp: number): number {
  // pendingMaxAbs is always >= the onset's amplitude (> thresholdAmp > 0), so this is never log10(0);
  // the floor below is only a defensive guard against a misconfigured zero/negative threshold.
  return 20 * Math.log10(amp > 1e-12 ? amp : 1e-12);
}
