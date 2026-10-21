/**
 * Message protocol between the main thread and the capture/analysis worklet:
 *
 *   mic -> MediaStreamSource -> [AudioWorklet "pitchlab-capture"] -> silent gain -> destination
 *                                        |  node.port
 *                                        v
 *                                   main thread (frames, stats, transients, recording chunks)
 *
 * The worklet runs the pitch detector itself (MPM on a 2048-sample window is
 * well under 1 ms per hop) against a preallocated ring buffer that accepts
 * ANY render-quantum size (WebKit has shipped non-128 quanta before). Nothing
 * on the steady-state path allocates except the posted message objects.
 * DSP code lives in pure modules (src/audio/framer.ts, src/dsp/*) so a future
 * ML detector can run the same framer inside a Worker instead.
 *
 * No SharedArrayBuffer: GitHub Pages cannot send COOP/COEP headers.
 */
import type { PitchFrame } from '../core/types';
import type { DetectorKind } from '../dsp/detector-types';

export const WORKLET_PROCESSOR_NAME = 'pitchlab-capture';

/** Everything the worklet needs; sent once right after the node is created. */
export interface WorkletInit {
  type: 'init';
  /** Hop in samples (= round(sampleRate * CONFIG.audio.hopSeconds)). sampleRate itself is a worklet global. */
  hopSize: number;
  windowSize: number;
  detector: DetectorKind;
  minHz: number;
  maxHz: number;
  minConfidence: number;
  minRmsDb: number;
  rmsFloorDb: number;
  mpmK: number;
  yinThreshold: number;
  /** Stats message interval, seconds. */
  statsIntervalSec: number;
}

// ---------------------------------------------------------------- main -> worklet (node.port)

export type MainToWorklet =
  | WorkletInit
  | { type: 'set-detector'; detector: DetectorKind }
  | { type: 'set-gating'; minConfidence?: number; minRmsDb?: number }
  /** Drop buffered audio/state (e.g. after an interruption or route change). */
  | { type: 'reset' }
  /** Start streaming raw mono audio back to the main thread (take playback / mic check). */
  | { type: 'record-start' }
  /** Flush the last partial chunk and send 'record-end'. */
  | { type: 'record-stop' }
  /** Sample-accurate transient detection for loopback latency calibration. */
  | { type: 'transients'; enabled: boolean; thresholdDb: number; refractorySec: number };

// ---------------------------------------------------------------- worklet -> main

export interface FrameMessage {
  type: 'frame';
  frame: PitchFrame;
}

export interface StatsMessage {
  type: 'stats';
  /** Frames emitted during the last interval, per second. */
  framesPerSec: number;
  /** Discontinuities seen in currentFrame (lost render quanta). */
  droppedQuanta: number;
  /** Largest render-quantum size observed (128 expected). */
  maxQuantum: number;
}

export interface RecordChunkMessage {
  type: 'record-chunk';
  /** AudioContext sample-frame index of samples[0]. */
  frame0: number;
  /** Transferred. */
  samples: Float32Array;
}

export interface RecordEndMessage {
  type: 'record-end';
}

export interface TransientMessage {
  type: 'transient';
  /** AudioContext time (input timeline) of the first sample over threshold. */
  t: number;
  peakDb: number;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type WorkletToMain =
  | FrameMessage
  | StatsMessage
  | RecordChunkMessage
  | RecordEndMessage
  | TransientMessage
  | ErrorMessage;
