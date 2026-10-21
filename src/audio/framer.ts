/**
 * Turns an arbitrary stream of audio blocks into a sample-exact sequence of
 * PitchFrames. Pure: no worklet/DOM globals, no steady-state allocation
 * except the PitchFrame objects it emits (one per hop). See
 * docs/ARCHITECTURE.md ("Performance rules") and src/audio/protocol.ts.
 */
import type { PitchFrame } from '../core/types';
import type { DetectResult, PitchDetector } from '../dsp/detector-types';
import { centsFromNearest, hzToMidi } from '../core/music';
import { rmsDb } from '../dsp/rms';

export interface FramerOptions {
  sampleRate: number;
  /** Samples per analysis window. Must match `detector.windowSize`. */
  windowSize: number;
  /** Samples between successive emissions. Fixed for the instance's lifetime. */
  hopSize: number;
  minHz: number;
  maxHz: number;
  minConfidence: number;
  minRmsDb: number;
  rmsFloorDb: number;
  detector: PitchDetector;
}

export interface GatingOptions {
  minConfidence?: number;
  minRmsDb?: number;
}

/**
 * Ring-buffers incoming audio and emits one PitchFrame every `hopSize`
 * samples once `windowSize` samples have been seen since the last reset or
 * gap. Accepts blocks of any length (WebKit has shipped non-128 render
 * quanta); a hop boundary may land in the middle of a block, and a single
 * large block may cross several hop boundaries.
 *
 * Continuity: blocks must arrive as a contiguous sample stream (`frame0` of
 * block N+1 equal to `frame0 + length` of block N). A discontinuity
 * increments `droppedBlocks` and restarts the fill from the new block --
 * audio is never stitched across a gap, and the window/hop schedule starts
 * counting from zero again at the new baseline.
 */
export class Framer {
  private readonly sampleRate: number;
  private readonly windowSize: number;
  private readonly hopSize: number;
  private minHz: number;
  private maxHz: number;
  private minConfidence: number;
  private minRmsDb: number;
  private readonly rmsFloorDb: number;
  private detector: PitchDetector;

  /** Circular buffer, capacity == windowSize. `writeCursor` holds the OLDEST sample (about to be overwritten next). */
  private readonly ring: Float32Array;
  /** Scratch, oldest-first copy of the ring handed to the detector/rmsDb. Reused every emission. */
  private readonly windowBuf: Float32Array;
  /** Reused detector output (contract: detectors write into it instead of allocating). */
  private readonly detectOut: DetectResult = { f0Hz: NaN, confidence: 0 };

  private writeCursor = 0;
  /** Absolute (AudioContext) sample index of the first sample of the current contiguous run. */
  private baseFrame0 = 0;
  /** Samples written since `baseFrame0`. */
  private samplesSinceBase = 0;
  /** Samples still needed before the next emission (starts at windowSize, then hopSize). */
  private samplesUntilNextEmit: number;
  /** Absolute sample index expected to start the next pushed block; null until the first block (or after reset()). */
  private expectedFrame0: number | null = null;

  private _droppedBlocks = 0;
  /** Discontinuities seen in pushed `frame0`s since construction (never cleared by reset()). */
  get droppedBlocks(): number {
    return this._droppedBlocks;
  }

  constructor(opts: FramerOptions) {
    this.sampleRate = opts.sampleRate;
    this.windowSize = opts.windowSize;
    this.hopSize = opts.hopSize;
    this.minHz = opts.minHz;
    this.maxHz = opts.maxHz;
    this.minConfidence = opts.minConfidence;
    this.minRmsDb = opts.minRmsDb;
    this.rmsFloorDb = opts.rmsFloorDb;
    this.detector = opts.detector;
    this.ring = new Float32Array(this.windowSize);
    this.windowBuf = new Float32Array(this.windowSize);
    this.samplesUntilNextEmit = this.windowSize;
  }

  /** Swap the detector (e.g. MPM <-> YIN). Must have the same `windowSize`; does not affect the fill/hop schedule. */
  setDetector(d: PitchDetector): void {
    this.detector = d;
  }

  /** Partial update: omitted fields keep their current value. */
  setGating(g: GatingOptions): void {
    if (g.minConfidence !== undefined) this.minConfidence = g.minConfidence;
    if (g.minRmsDb !== undefined) this.minRmsDb = g.minRmsDb;
  }

  /**
   * Drop all buffered audio and forget the continuity baseline: the next
   * push(), whatever its frame0, starts a fresh fill (not counted as a
   * drop) and the next emission is again `windowSize` samples away.
   * `droppedBlocks` is a lifetime counter and is not cleared here.
   */
  reset(): void {
    this.writeCursor = 0;
    this.samplesSinceBase = 0;
    this.samplesUntilNextEmit = this.windowSize;
    this.baseFrame0 = 0;
    this.expectedFrame0 = null;
  }

  /**
   * Feed one block of audio. `frame0` is the absolute (AudioContext) sample
   * index of `block[0]`. Calls `emit` zero or more times, sample-exact
   * regardless of how the stream happens to be chunked into blocks.
   */
  push(block: Float32Array, frame0: number, emit: (f: PitchFrame) => void): void {
    const n = block.length;

    if (this.expectedFrame0 === null) {
      // First block ever, or the first one after reset(): establish a fresh baseline, not a drop.
      this.writeCursor = 0;
      this.samplesSinceBase = 0;
      this.samplesUntilNextEmit = this.windowSize;
      this.baseFrame0 = frame0;
    } else if (frame0 !== this.expectedFrame0) {
      this._droppedBlocks++;
      this.writeCursor = 0;
      this.samplesSinceBase = 0;
      this.samplesUntilNextEmit = this.windowSize;
      this.baseFrame0 = frame0;
    }
    this.expectedFrame0 = frame0 + n;

    let offset = 0;
    while (offset < n) {
      const take = Math.min(n - offset, this.samplesUntilNextEmit);
      this.writeIntoRing(block, offset, take);
      this.samplesSinceBase += take;
      this.samplesUntilNextEmit -= take;
      offset += take;
      if (this.samplesUntilNextEmit === 0) {
        this.emitFrame(emit);
        this.samplesUntilNextEmit = this.hopSize;
      }
    }
  }

  /** Copy `take` samples from `block[srcOffset..)` into the ring at the write cursor, wrapping as needed. No allocation. */
  private writeIntoRing(block: Float32Array, srcOffset: number, take: number): void {
    const ring = this.ring;
    const windowSize = this.windowSize;
    let cursor = this.writeCursor;
    let srcPos = srcOffset;
    let remaining = take;
    while (remaining > 0) {
      const space = windowSize - cursor;
      const chunk = remaining < space ? remaining : space;
      for (let i = 0; i < chunk; i++) ring[cursor + i] = block[srcPos + i];
      cursor += chunk;
      if (cursor === windowSize) cursor = 0;
      srcPos += chunk;
      remaining -= chunk;
    }
    this.writeCursor = cursor;
  }

  /** Build the oldest-first window, run the detector + rmsDb, and emit one PitchFrame. The only steady-state allocation. */
  private emitFrame(emit: (f: PitchFrame) => void): void {
    const ring = this.ring;
    const windowSize = this.windowSize;
    const windowBuf = this.windowBuf;
    const cursor = this.writeCursor;
    const firstLen = windowSize - cursor;
    for (let i = 0; i < firstLen; i++) windowBuf[i] = ring[cursor + i];
    for (let i = 0; i < cursor; i++) windowBuf[firstLen + i] = ring[i];

    this.detector.detect(windowBuf, this.detectOut);
    const f0Hz = this.detectOut.f0Hz;
    const confidence = this.detectOut.confidence;
    const midi = hzToMidi(f0Hz);
    const rms = rmsDb(windowBuf, this.rmsFloorDb);
    const voiced =
      Number.isFinite(f0Hz) &&
      f0Hz >= this.minHz &&
      f0Hz <= this.maxHz &&
      confidence >= this.minConfidence &&
      rms >= this.minRmsDb;

    const lastSampleIndex = this.baseFrame0 + this.samplesSinceBase - 1;
    const t = (lastSampleIndex + 1 - windowSize / 2) / this.sampleRate;

    emit({
      t,
      f0Hz,
      midi,
      centsFromNearest: centsFromNearest(midi),
      confidence,
      rmsDb: rms,
      voiced,
    });
  }
}
