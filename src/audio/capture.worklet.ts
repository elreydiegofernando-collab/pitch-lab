/**
 * AudioWorkletProcessor registered under WORKLET_PROCESSOR_NAME. Captures
 * the mic, runs pitch + transient detection in-process on a preallocated
 * Framer/TransientDetector, and streams frames/stats/transients/recording
 * chunks back to the main thread. See src/audio/protocol.ts for the message
 * contract and docs/ARCHITECTURE.md ("Threads & data flow") for why
 * detection runs here instead of a separate Worker.
 *
 * Bundled by Vite (`?worker&url`) into one self-contained script, so this
 * module must not touch DOM/window/performance at module scope. The worklet
 * globals below are not covered by the DOM lib (and we deliberately don't
 * add the "webworker" lib / a global .d.ts), so they're declared locally.
 */
declare const sampleRate: number;
declare const currentFrame: number;
declare const currentTime: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

import type { FrameMessage, MainToWorklet, WorkletInit, WorkletToMain } from './protocol';
import { WORKLET_PROCESSOR_NAME } from './protocol';
import { Framer } from './framer';
import { TransientDetector, type TransientConfig } from './transients';
import { createDetector } from '../dsp/detector';
import type { PitchFrame } from '../core/types';

/** Recording chunk size, in samples (mono). */
const RECORD_CHUNK_SIZE = 4096;
/** Minimum spacing between posted 'error' messages, so a repeating failure can't flood the port. */
const ERROR_RATE_LIMIT_SEC = 1;

/** Placeholder only; immediately overwritten before every post (see `frameMsg` below). */
const EMPTY_FRAME: PitchFrame = {
  t: 0,
  f0Hz: NaN,
  midi: NaN,
  centsFromNearest: NaN,
  confidence: 0,
  rmsDb: -Infinity,
  voiced: false,
};

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class CaptureProcessor extends AudioWorkletProcessor {
  private framer: Framer | null = null;
  private readonly transientDetector = new TransientDetector();
  private transientConfig: TransientConfig | null = null;
  /** The most recent 'init' (or 'set-detector'-updated) message; cached so set-detector can rebuild a detector. */
  private current: WorkletInit | null = null;

  // --- stats (posted every `statsIntervalSec` of currentTime) ---
  private statsIntervalSec = 1;
  private statsWindowStart = 0;
  private framesSinceStatsTick = 0;
  private droppedBlocksAtLastTick = 0;
  private maxQuantumSeen = 0;

  // --- recording ---
  private recording = false;
  private recordChunk: Float32Array | null = null;
  private recordChunkFill = 0;
  private recordChunkFrame0 = 0;

  private lastErrorPostTime = -Infinity;

  /** Reused across every 'frame' post. MessagePort.postMessage structured-clones synchronously
   *  before returning, so mutating `.frame` right after the call is safe -- this keeps the ~94
   *  frames/sec steady-state path from allocating a wrapper object (only the PitchFrame itself,
   *  built fresh by the Framer, is allowed to allocate). */
  private readonly frameMsg: FrameMessage = { type: 'frame', frame: EMPTY_FRAME };

  private readonly onFrameEmitted = (frame: PitchFrame): void => {
    this.framesSinceStatsTick++;
    this.frameMsg.frame = frame;
    this.postMessage(this.frameMsg);
  };

  private readonly onTransientEmitted = (t: number, peakDb: number): void => {
    this.postMessage({ type: 'transient', t, peakDb });
  };

  constructor() {
    super();
    // Avoids maybeEmitStats() firing immediately on a process() call that lands before
    // 'init' is delivered (the port message isn't synchronous with node construction).
    this.statsWindowStart = currentTime;
    this.port.onmessage = (ev: MessageEvent<MainToWorklet>): void => {
      try {
        this.handleMessage(ev.data);
      } catch (err) {
        this.postError(describeError(err));
      }
    };
  }

  private handleMessage(msg: MainToWorklet): void {
    switch (msg.type) {
      case 'init': {
        this.current = msg;
        const detector = createDetector(msg.detector, {
          sampleRate,
          windowSize: msg.windowSize,
          minHz: msg.minHz,
          maxHz: msg.maxHz,
          mpmK: msg.mpmK,
          yinThreshold: msg.yinThreshold,
        });
        this.framer = new Framer({
          sampleRate,
          windowSize: msg.windowSize,
          hopSize: msg.hopSize,
          minHz: msg.minHz,
          maxHz: msg.maxHz,
          minConfidence: msg.minConfidence,
          minRmsDb: msg.minRmsDb,
          rmsFloorDb: msg.rmsFloorDb,
          detector,
        });
        this.statsIntervalSec = msg.statsIntervalSec;
        this.statsWindowStart = currentTime;
        this.framesSinceStatsTick = 0;
        this.maxQuantumSeen = 0;
        this.droppedBlocksAtLastTick = 0;
        break;
      }
      case 'set-detector': {
        if (!this.framer || !this.current) break;
        const detector = createDetector(msg.detector, {
          sampleRate,
          windowSize: this.current.windowSize,
          minHz: this.current.minHz,
          maxHz: this.current.maxHz,
          mpmK: this.current.mpmK,
          yinThreshold: this.current.yinThreshold,
        });
        this.framer.setDetector(detector);
        this.current = { ...this.current, detector: msg.detector };
        break;
      }
      case 'set-gating': {
        this.framer?.setGating({ minConfidence: msg.minConfidence, minRmsDb: msg.minRmsDb });
        break;
      }
      case 'reset': {
        this.framer?.reset();
        if (this.transientConfig) this.transientDetector.configure({ ...this.transientConfig, sampleRate });
        break;
      }
      case 'record-start': {
        this.recording = true;
        this.allocateRecordChunk();
        break;
      }
      case 'record-stop': {
        this.flushRecordChunk();
        this.recording = false;
        this.postMessage({ type: 'record-end' });
        break;
      }
      case 'transients': {
        this.transientConfig = { enabled: msg.enabled, thresholdDb: msg.thresholdDb, refractorySec: msg.refractorySec, sampleRate };
        this.transientDetector.configure(this.transientConfig);
        break;
      }
    }
  }

  process(inputs: Float32Array[][], _outputs: Float32Array[][], _parameters: Record<string, Float32Array>): boolean {
    try {
      const channel = inputs[0]?.[0];
      if (channel && channel.length > 0) {
        const frame0 = currentFrame;
        if (channel.length > this.maxQuantumSeen) this.maxQuantumSeen = channel.length;
        if (this.framer) this.framer.push(channel, frame0, this.onFrameEmitted);
        if (this.transientConfig?.enabled) this.transientDetector.process(channel, frame0, this.onTransientEmitted);
        if (this.recording) this.feedRecording(channel, frame0);
      }
      this.maybeEmitStats();
    } catch (err) {
      this.postError(describeError(err));
    }
    // Outputs are left untouched (silent): this node only taps the mic for analysis.
    return true;
  }

  private maybeEmitStats(): void {
    const elapsed = currentTime - this.statsWindowStart;
    if (elapsed < this.statsIntervalSec) return;
    const dropped = this.framer ? this.framer.droppedBlocks : 0;
    this.postMessage({
      type: 'stats',
      framesPerSec: elapsed > 0 ? this.framesSinceStatsTick / elapsed : 0,
      droppedQuanta: dropped - this.droppedBlocksAtLastTick,
      maxQuantum: this.maxQuantumSeen,
    });
    this.droppedBlocksAtLastTick = dropped;
    this.framesSinceStatsTick = 0;
    this.maxQuantumSeen = 0;
    this.statsWindowStart = currentTime;
  }

  private allocateRecordChunk(): void {
    this.recordChunk = new Float32Array(RECORD_CHUNK_SIZE);
    this.recordChunkFill = 0;
  }

  private feedRecording(channel: Float32Array, frame0: number): void {
    if (!this.recordChunk) return; // invariant: allocated by 'record-start'; defensive no-op otherwise
    let buf = this.recordChunk;
    let srcPos = 0;
    let remaining = channel.length;
    while (remaining > 0) {
      if (this.recordChunkFill === 0) this.recordChunkFrame0 = frame0 + srcPos;
      const space = RECORD_CHUNK_SIZE - this.recordChunkFill;
      const take = remaining < space ? remaining : space;
      for (let i = 0; i < take; i++) buf[this.recordChunkFill + i] = channel[srcPos + i];
      this.recordChunkFill += take;
      srcPos += take;
      remaining -= take;
      if (this.recordChunkFill === RECORD_CHUNK_SIZE) {
        this.postMessage({ type: 'record-chunk', frame0: this.recordChunkFrame0, samples: buf }, [buf.buffer]);
        this.allocateRecordChunk();
        buf = this.recordChunk!; // allocateRecordChunk() always sets a fresh non-null chunk
      }
    }
  }

  private flushRecordChunk(): void {
    if (this.recordChunk && this.recordChunkFill > 0) {
      const samples = this.recordChunkFill === RECORD_CHUNK_SIZE ? this.recordChunk : this.recordChunk.slice(0, this.recordChunkFill);
      this.postMessage({ type: 'record-chunk', frame0: this.recordChunkFrame0, samples }, [samples.buffer]);
    }
    this.recordChunk = null;
    this.recordChunkFill = 0;
  }

  private postError(message: string): void {
    if (currentTime - this.lastErrorPostTime < ERROR_RATE_LIMIT_SEC) return;
    this.lastErrorPostTime = currentTime;
    this.postMessage({ type: 'error', message });
  }

  private postMessage(msg: WorkletToMain, transfer?: Transferable[]): void {
    if (transfer) this.port.postMessage(msg, transfer);
    else this.port.postMessage(msg);
  }
}

registerProcessor(WORKLET_PROCESSOR_NAME, CaptureProcessor);
