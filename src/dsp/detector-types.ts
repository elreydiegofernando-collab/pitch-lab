/**
 * Pitch-detector contract. The analysis worker owns exactly one detector and
 * calls it once per hop with the most recent `windowSize` samples.
 */

export type DetectorKind = 'mpm' | 'yin';

/** Reused output object - detectors write into it instead of allocating. */
export interface DetectResult {
  /** Fundamental in Hz, or NaN when no pitch was found. */
  f0Hz: number;
  /** 0..1. MPM: clarity (NSDF peak height). YIN: 1 - aperiodicity (d' at the chosen lag). */
  confidence: number;
}

export interface DetectorOptions {
  sampleRate: number;
  /** Samples per analysis window (power of two; default CONFIG.audio.windowSize). */
  windowSize: number;
  /** Lowest/highest fundamental to search, Hz. Bounds the lag search. */
  minHz: number;
  maxHz: number;
  /** MPM key-maximum threshold constant k (McLeod & Wyvill 2005). */
  mpmK?: number;
  /** YIN absolute threshold on the cumulative-mean-normalised difference. */
  yinThreshold?: number;
}

/** Synchronous detector used in v1. Must not allocate inside detect(). */
export interface PitchDetector {
  readonly kind: DetectorKind;
  readonly windowSize: number;
  readonly sampleRate: number;
  /** Analyse exactly `windowSize` samples (oldest first) and write into `out`. */
  detect(window: Float32Array, out: DetectResult): void;
}

/**
 * Hook for a future ML ("CREPE-style") detector. Such models typically run at
 * 16 kHz on ~1024-sample frames, infer asynchronously (onnxruntime-web / TF.js
 * inside the analysis worker), and add latency. Nothing implements this in v1;
 * see docs/ML-HOOK.md for the integration plan.
 */
export interface AsyncPitchDetector {
  readonly kind: 'ml';
  /** The rate the model expects; the worker resamples to it. */
  readonly modelSampleRate: number;
  /** Samples per inference frame at modelSampleRate. */
  readonly windowSize: number;
  /** Extra latency (resampling + batching + inference), seconds. */
  readonly latencySec: number;
  init(): Promise<void>;
  /** Analyse a batch of frames; results are written to `out` in the same order. */
  detectBatch(windows: readonly Float32Array[], out: DetectResult[]): Promise<void>;
  dispose(): void;
}
