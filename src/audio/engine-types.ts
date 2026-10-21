import type { PitchFrame } from '../core/types';
import type { DetectorKind } from '../dsp/detector-types';

export type EngineState =
  | 'idle' //        never started, or stopped
  | 'starting' //    inside start()
  | 'running' //     mic open, frames flowing
  | 'suspended' //   context suspended (e.g. page hidden); resume() from a gesture
  | 'interrupted' // iOS interrupted the session (call, Siri, other app); resume() from a gesture
  | 'error'; //      start failed (permission denied, no mic, insecure context, ...)

export type EngineErrorCode =
  // state 'error' (start failed)
  | 'insecure-context'
  | 'no-mediadevices'
  | 'permission-denied'
  | 'no-microphone'
  | 'mic-in-use'
  | 'worklet-unsupported'
  | 'unknown'
  // state 'interrupted' (reason; the UI says "tap to reconnect")
  | 'session-interrupted' // AudioContext 'interrupted'/'suspended' and resume() didn't stick (call, Siri, lock)
  | 'mic-ended' //          mic track ended/muted (e.g. ~30 s in background on iOS)
  | 'route-changed'; //     devicechange: headphones plugged/unplugged, Bluetooth connected -> recalibrate

export interface EngineError {
  code: EngineErrorCode;
  message: string;
}

/** Everything the Diagnostics screen shows about the audio path. */
export interface EngineInfo {
  state: EngineState;
  sampleRate: number | null;
  /** AudioContext.baseLatency / outputLatency in seconds, when the browser reports them. */
  baseLatency: number | null;
  outputLatency: number | null;
  windowSize: number;
  hopSize: number | null;
  detector: DetectorKind;
  /**
   * Median cost of one detect() call in ms, measured by a short main-thread
   * micro-benchmark at start (the worklet scope has no reliable clock).
   */
  detectorCostMs: number | null;
  /** What the browser actually applied (echoCancellation/noiseSuppression/autoGainControl/sampleRate/latency/...). */
  trackSettings: MediaTrackSettings | null;
  /** navigator.audioSession.type after setup, or null when unsupported. */
  audioSessionType: string | null;
  inputDeviceLabel: string | null;
  isIOS: boolean;
  isStandalone: boolean;
  userAgent: string;
}

export interface EngineStats {
  framesPerSec: number;
  /** Lost render quanta since start (currentFrame discontinuities). */
  droppedQuanta: number;
  /** Largest render quantum seen (128 expected; WebKit has shipped others). */
  maxQuantum: number;
}

export interface Recording {
  samples: Float32Array;
  sampleRate: number;
  /** AudioContext time of samples[0] (input timeline). */
  startTime: number;
}

export type Unsubscribe = () => void;

/**
 * The single audio engine (see getEngine() in engine.ts).
 *
 * iOS rule: start() and resume() MUST be called synchronously from a user
 * gesture handler (click / pointerup / touchend). They create and resume the
 * AudioContext *before* their first `await`, so the gesture is still active.
 */
export interface AudioEngine {
  readonly state: EngineState;
  readonly error: EngineError | null;
  /** Null until the first ensureContext()/start(). Kept alive across stop() so reference audio can still play. */
  readonly context: AudioContext | null;
  /** Master output GainNode -> destination, where reference audio (synth, backing tracks) connects. Null until the first ensureContext()/start(). Replaced by reset(): re-read it after a reset. */
  readonly output: AudioNode | null;

  /**
   * Create (if needed) and resume the AudioContext WITHOUT opening the mic,
   * e.g. when the user taps Listen before Sing. Synchronous so it can run
   * inside a gesture handler; returns the context.
   */
  ensureContext(): AudioContext;
  start(): Promise<void>;
  /** Stop the mic (stop tracks, disconnect graph). The context stays alive. */
  stop(): Promise<void>;
  /** Resume after 'suspended' / 'interrupted'. Call from a gesture. */
  resume(): Promise<void>;
  /**
   * "Reset audio" escape hatch: tear down mic, worklet AND AudioContext, then
   * start fresh (new context, new getUserMedia). Fixes iOS output stuck on the
   * earpiece/speaker (open WebKit bugs). Call from a gesture.
   */
  reset(): Promise<void>;

  onFrame(listener: (frame: PitchFrame) => void): Unsubscribe;
  onState(listener: (state: EngineState, error: EngineError | null) => void): Unsubscribe;
  onStats(listener: (stats: EngineStats) => void): Unsubscribe;
  onTransient(listener: (t: number, peakDb: number) => void): Unsubscribe;

  info(): EngineInfo;
  /** Audio inputs (labels are only populated after mic permission was granted). */
  listInputs(): Promise<MediaDeviceInfo[]>;
  /**
   * Preferred mic deviceId (null = browser default). Applied on the next
   * start()/reset(): a Bluetooth headset mic (HFP, 8-16 kHz) badly degrades
   * pitch detection, so Setup lets the user pick the phone/laptop mic.
   */
  setPreferredInput(deviceId: string | null): void;
  setDetector(kind: DetectorKind): void;
  setGating(opts: { minConfidence?: number; minRmsDb?: number }): void;
  setTransientDetection(opts: { enabled: boolean; thresholdDb: number; refractorySec: number }): void;

  startRecording(): void;
  stopRecording(): Promise<Recording>;
}
