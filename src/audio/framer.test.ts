import { describe, expect, it } from 'vitest';
import { centsFromNearest, hzToMidi, midiToHz } from '../core/music';
import type { PitchFrame } from '../core/types';
import type { DetectResult, DetectorKind, PitchDetector } from '../dsp/detector-types';
import { Framer } from './framer';

const SAMPLE_RATE = 48000;
const WINDOW_SIZE = 2048;
const HOP_SIZE = 512;
const RMS_FLOOR_DB = -100;

/** Controllable stand-in for a real detector: just writes whatever `f0Hz`/`confidence` the test set. */
class FakeDetector implements PitchDetector {
  readonly kind: DetectorKind = 'mpm';
  readonly windowSize: number;
  readonly sampleRate: number;
  f0Hz = 220;
  confidence = 1;
  calls = 0;

  constructor(windowSize = WINDOW_SIZE, sampleRate = SAMPLE_RATE) {
    this.windowSize = windowSize;
    this.sampleRate = sampleRate;
  }

  detect(_window: Float32Array, out: DetectResult): void {
    this.calls++;
    out.f0Hz = this.f0Hz;
    out.confidence = this.confidence;
  }
}

function makeFramer(overrides: Partial<{ minHz: number; maxHz: number; minConfidence: number; minRmsDb: number; detector: PitchDetector }> = {}) {
  const detector = overrides.detector ?? new FakeDetector();
  return new Framer({
    sampleRate: SAMPLE_RATE,
    windowSize: WINDOW_SIZE,
    hopSize: HOP_SIZE,
    minHz: overrides.minHz ?? 70,
    maxHz: overrides.maxHz ?? 1100,
    minConfidence: overrides.minConfidence ?? 0.5,
    minRmsDb: overrides.minRmsDb ?? -80,
    rmsFloorDb: RMS_FLOOR_DB,
    detector,
  });
}

/** `value` repeated into a block of `length` samples (a non-zero constant is a cheap deterministic "loud" signal). */
function constantBlock(length: number, value: number): Float32Array {
  return new Float32Array(length).fill(value);
}

/**
 * Feeds `signal` through `framer` chunked by `sizes` (cycled, or called if a
 * function). `startFrame0` is the absolute sample index of `signal[0]` --
 * pass the running total of samples already fed to continue a stream across
 * multiple `feed()` calls on the same Framer without tripping its gap
 * detection (which treats each call's `pos` as relative to this signal).
 */
function feed(framer: Framer, signal: Float32Array, sizes: number[] | (() => number), startFrame0 = 0): PitchFrame[] {
  const frames: PitchFrame[] = [];
  let pos = 0;
  let i = 0;
  while (pos < signal.length) {
    const want = Array.isArray(sizes) ? sizes[i % sizes.length] : sizes();
    const take = Math.min(want, signal.length - pos);
    framer.push(signal.subarray(pos, pos + take), startFrame0 + pos, (f) => frames.push(f));
    pos += take;
    i++;
  }
  return frames;
}

/** mulberry32: deterministic PRNG so "random block sizes" tests are stable across runs. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('block-size invariance', () => {
  it('produces identical frame sequences regardless of how the stream is chunked', () => {
    const totalSamples = WINDOW_SIZE + 20 * HOP_SIZE + 37; // not a multiple of any block size
    const signal = constantBlock(totalSamples, 0.3);

    const rand = seededRandom(1234);
    const sizers: (number[] | (() => number))[] = [[128], [960], [1], [4096], () => 1 + Math.floor(rand() * 500)];

    const reference = feed(makeFramer(), signal, sizers[0]);
    expect(reference.length).toBeGreaterThan(10);

    for (let k = 1; k < sizers.length; k++) {
      const frames = feed(makeFramer(), signal, sizers[k]);
      expect(frames.map((f) => f.t)).toEqual(reference.map((f) => f.t));
      expect(frames.length).toBe(reference.length);
    }
  });
});

describe('hop timing / frame rate', () => {
  it('first frame only after windowSize samples, exactly at the window centre', () => {
    const framer = makeFramer();
    const frames = feed(framer, constantBlock(WINDOW_SIZE - 1, 0.2), [128]);
    expect(frames.length).toBe(0);

    const second = feed(framer, constantBlock(1, 0.2), [1], WINDOW_SIZE - 1);
    expect(second.length).toBe(1);
    expect(second[0].t).toBeCloseTo(WINDOW_SIZE / 2 / SAMPLE_RATE, 12);
  });

  it('hops stay sample-exact, each hopSize samples apart', () => {
    const framer = makeFramer();
    const frames = feed(framer, constantBlock(WINDOW_SIZE + 5 * HOP_SIZE, 0.2), [333]);
    expect(frames.length).toBe(6);
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i].t - frames[i - 1].t).toBeCloseTo(HOP_SIZE / SAMPLE_RATE, 12);
    }
  });

  it('48 kHz @ hop 512 gives ~93.75 frames/s', () => {
    const framer = makeFramer();
    const seconds = 10;
    const n = SAMPLE_RATE * seconds;
    const frames = feed(framer, constantBlock(n, 0.2), [128]);
    // Exact: the startup offset (windowSize - hopSize samples before the first frame) is deterministic.
    expect(frames.length).toBe(Math.floor((n - WINDOW_SIZE) / HOP_SIZE) + 1);
    // Loose sanity check matching the asymptotic rate sampleRate/hopSize (exact only as duration -> infinity).
    expect(frames.length / seconds).toBeCloseTo(93.75, 0);
  });

  it('44.1 kHz @ hop 470 gives ~93.83 frames/s', () => {
    const sampleRate = 44100;
    const hopSize = 470;
    const framer = new Framer({
      sampleRate,
      windowSize: WINDOW_SIZE,
      hopSize,
      minHz: 70,
      maxHz: 1100,
      minConfidence: 0.5,
      minRmsDb: -80,
      rmsFloorDb: RMS_FLOOR_DB,
      detector: new FakeDetector(WINDOW_SIZE, sampleRate),
    });
    const seconds = 10;
    const n = sampleRate * seconds;
    const frames = feed(framer, constantBlock(n, 0.2), [128]);
    expect(frames.length).toBe(Math.floor((n - WINDOW_SIZE) / hopSize) + 1);
    expect(frames.length / seconds).toBeCloseTo(93.829, 0);
  });
});

describe('gap handling', () => {
  it('counts a discontinuous frame0 as a dropped block and restarts the fill', () => {
    const framer = makeFramer();
    // Partial fill, well short of a frame.
    framer.push(constantBlock(1000, 0.2), 0, () => {
      throw new Error('should not emit yet');
    });
    expect(framer.droppedBlocks).toBe(0);

    // Gap: next block's frame0 should have been 1000, but jumps to 50000.
    const frames: PitchFrame[] = [];
    framer.push(constantBlock(WINDOW_SIZE, 0.2), 50000, (f) => frames.push(f));
    expect(framer.droppedBlocks).toBe(1);
    // Exactly one frame, windowSize samples after the NEW baseline (the old partial fill was discarded).
    expect(frames.length).toBe(1);
    expect(frames[0].t).toBeCloseTo((50000 + WINDOW_SIZE / 2) / SAMPLE_RATE, 9);
  });

  it('also detects a gap in steady state (after frames have already been emitted)', () => {
    const framer = makeFramer();
    feed(framer, constantBlock(WINDOW_SIZE + 3 * HOP_SIZE, 0.2), [500]);
    expect(framer.droppedBlocks).toBe(0);

    framer.push(constantBlock(10, 0.2), 999999, () => undefined);
    expect(framer.droppedBlocks).toBe(1);
  });

  it('reset() forgets the baseline so the next push is not counted as a drop', () => {
    const framer = makeFramer();
    feed(framer, constantBlock(WINDOW_SIZE, 0.2), [500]);
    framer.reset();
    framer.push(constantBlock(10, 0.2), 123456, () => undefined);
    expect(framer.droppedBlocks).toBe(0);
  });

  it('reset() clears buffered fill progress (no spurious frame from a stale partial window)', () => {
    const framer = makeFramer();
    framer.push(constantBlock(WINDOW_SIZE - 10, 0.2), 0, () => undefined);
    framer.reset();
    const frames = feed(framer, constantBlock(9, 0.2), [9]);
    expect(frames.length).toBe(0); // only 9 of windowSize samples seen since reset
  });
});

describe('gating', () => {
  it('voices a frame when every gate passes', () => {
    const detector = new FakeDetector();
    detector.f0Hz = 220;
    detector.confidence = 0.9;
    const framer = makeFramer({ detector, minHz: 70, maxHz: 1100, minConfidence: 0.5, minRmsDb: -80 });
    const [frame] = feed(framer, constantBlock(WINDOW_SIZE, 0.3), [128]);
    expect(frame.voiced).toBe(true);
    expect(frame.f0Hz).toBe(220);
  });

  it('gates on confidence below minConfidence, but still reports f0Hz', () => {
    const detector = new FakeDetector();
    detector.f0Hz = 220;
    detector.confidence = 0.4;
    const framer = makeFramer({ detector, minConfidence: 0.5 });
    const [frame] = feed(framer, constantBlock(WINDOW_SIZE, 0.3), [128]);
    expect(frame.voiced).toBe(false);
    expect(frame.f0Hz).toBe(220);
  });

  it('confidence exactly at minConfidence passes (>=)', () => {
    const detector = new FakeDetector();
    detector.f0Hz = 220;
    detector.confidence = 0.5;
    const framer = makeFramer({ detector, minConfidence: 0.5 });
    const [frame] = feed(framer, constantBlock(WINDOW_SIZE, 0.3), [128]);
    expect(frame.voiced).toBe(true);
  });

  it('gates on f0 below minHz', () => {
    const detector = new FakeDetector();
    detector.f0Hz = 50;
    const framer = makeFramer({ detector, minHz: 70, maxHz: 1100 });
    const [frame] = feed(framer, constantBlock(WINDOW_SIZE, 0.3), [128]);
    expect(frame.voiced).toBe(false);
    expect(frame.f0Hz).toBe(50);
  });

  it('gates on f0 above maxHz', () => {
    const detector = new FakeDetector();
    detector.f0Hz = 2000;
    const framer = makeFramer({ detector, minHz: 70, maxHz: 1100 });
    const [frame] = feed(framer, constantBlock(WINDOW_SIZE, 0.3), [128]);
    expect(frame.voiced).toBe(false);
  });

  it('boundary f0 at exactly minHz/maxHz passes (inclusive)', () => {
    const detector = new FakeDetector();
    detector.f0Hz = 70;
    const framer = makeFramer({ detector, minHz: 70, maxHz: 1100 });
    const [frame] = feed(framer, constantBlock(WINDOW_SIZE, 0.3), [128]);
    expect(frame.voiced).toBe(true);
  });

  it('gates on NaN f0 (no pitch found) and reports f0Hz as NaN', () => {
    const detector = new FakeDetector();
    detector.f0Hz = NaN;
    const framer = makeFramer({ detector });
    const [frame] = feed(framer, constantBlock(WINDOW_SIZE, 0.3), [128]);
    expect(frame.voiced).toBe(false);
    expect(frame.f0Hz).toBeNaN();
    expect(frame.midi).toBeNaN();
    expect(frame.centsFromNearest).toBeNaN();
  });

  it('gates on rmsDb below minRmsDb, using the frame\'s own measured level as ground truth', () => {
    const probe = feed(makeFramer({ minRmsDb: -1000 }), constantBlock(WINDOW_SIZE, 0.3), [128]);
    const measuredRmsDb = probe[0].rmsDb;

    const tooStrict = feed(makeFramer({ minRmsDb: measuredRmsDb + 1 }), constantBlock(WINDOW_SIZE, 0.3), [128]);
    expect(tooStrict[0].voiced).toBe(false);

    const lenient = feed(makeFramer({ minRmsDb: measuredRmsDb - 1 }), constantBlock(WINDOW_SIZE, 0.3), [128]);
    expect(lenient[0].voiced).toBe(true);
  });

  it('digital silence reports a very low (floored) rmsDb and is gated unvoiced', () => {
    const frames = feed(makeFramer({ minRmsDb: -80 }), constantBlock(WINDOW_SIZE, 0), [128]);
    expect(frames[0].rmsDb).toBeLessThanOrEqual(-80);
    expect(frames[0].voiced).toBe(false);
  });

  it('setGating only updates the fields given, leaving the other untouched', () => {
    const detector = new FakeDetector();
    detector.f0Hz = 220;
    detector.confidence = 0.6;
    const framer = makeFramer({ detector, minConfidence: 0.9, minRmsDb: -80 });

    const before = feed(framer, constantBlock(WINDOW_SIZE, 0.3), [128]);
    expect(before[0].voiced).toBe(false); // confidence 0.6 < 0.9

    framer.setGating({ minConfidence: 0.5 }); // minRmsDb untouched
    const after = feed(framer, constantBlock(HOP_SIZE, 0.3), [128], WINDOW_SIZE);
    expect(after[0].voiced).toBe(true);
  });
});

describe('midi / cents', () => {
  it('matches core/music for an in-tune pitch', () => {
    const detector = new FakeDetector();
    detector.f0Hz = 220; // A3
    const framer = makeFramer({ detector });
    const [frame] = feed(framer, constantBlock(WINDOW_SIZE, 0.3), [128]);
    expect(frame.midi).toBeCloseTo(hzToMidi(220), 9);
    expect(frame.centsFromNearest).toBeCloseTo(centsFromNearest(hzToMidi(220)), 6);
    expect(frame.centsFromNearest).toBeCloseTo(0, 6);
  });

  it('matches core/music for a pitch 25 cents sharp of A3', () => {
    const detector = new FakeDetector();
    detector.f0Hz = midiToHz(57.25);
    const framer = makeFramer({ detector });
    const [frame] = feed(framer, constantBlock(WINDOW_SIZE, 0.3), [128]);
    expect(frame.midi).toBeCloseTo(57.25, 6);
    expect(frame.centsFromNearest).toBeCloseTo(25, 4);
  });
});

describe('setDetector', () => {
  it('swaps the detector used for subsequent emissions', () => {
    const first = new FakeDetector();
    first.f0Hz = 220;
    const framer = makeFramer({ detector: first });

    const before = feed(framer, constantBlock(WINDOW_SIZE, 0.3), [128]);
    expect(before[0].f0Hz).toBe(220);

    const second = new FakeDetector();
    second.f0Hz = 440;
    framer.setDetector(second);
    const after = feed(framer, constantBlock(HOP_SIZE, 0.3), [128], WINDOW_SIZE);
    expect(after[0].f0Hz).toBe(440);
    expect(second.calls).toBeGreaterThan(0);
  });
});
