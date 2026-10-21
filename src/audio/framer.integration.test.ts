/**
 * Integration test: the real MPM detector (src/dsp/detector.ts) driving the
 * real Framer on a synthesized harmonic tone, fed in realistic 128-sample
 * (render-quantum-sized) blocks, as the worklet would. Unlike framer.test.ts
 * this does not use a fake detector, so it depends on the dsp module.
 */
import { describe, expect, it } from 'vitest';
import { hzToMidi } from '../core/music';
import { createDetector } from '../dsp/detector';
import { harmonicTone } from '../dsp/test-signals';
import { CONFIG, hopSizeFor } from '../config';
import { Framer } from './framer';
import type { PitchFrame } from '../core/types';

describe('Framer + real MPM detector', () => {
  it('tracks a 220 Hz harmonic tone to within 0.03 semitone', () => {
    const sampleRate = 48000;
    const hopSize = hopSizeFor(sampleRate);
    const detector = createDetector('mpm', {
      sampleRate,
      windowSize: CONFIG.audio.windowSize,
      minHz: CONFIG.audio.minHz,
      maxHz: CONFIG.audio.maxHz,
      mpmK: CONFIG.audio.mpmK,
    });
    const framer = new Framer({
      sampleRate,
      windowSize: CONFIG.audio.windowSize,
      hopSize,
      minHz: CONFIG.audio.minHz,
      maxHz: CONFIG.audio.maxHz,
      minConfidence: CONFIG.audio.minConfidence,
      minRmsDb: CONFIG.audio.minRmsDb,
      rmsFloorDb: CONFIG.audio.rmsFloorDb,
      detector,
    });

    const tone = harmonicTone(sampleRate, 1.5, 220);
    const frames: PitchFrame[] = [];
    const blockSize = 128; // a typical (if not guaranteed) render quantum
    for (let pos = 0; pos < tone.length; pos += blockSize) {
      const block = tone.subarray(pos, Math.min(pos + blockSize, tone.length));
      framer.push(block, pos, (f) => frames.push(f));
    }

    const voiced = frames.filter((f) => f.voiced);
    // Onset settling + the first windowSize samples contribute no frames; expect a solid run of voiced frames after that.
    expect(voiced.length).toBeGreaterThan(20);

    const expectedMidi = hzToMidi(220); // 57, exactly A3
    for (const f of voiced.slice(-10)) {
      expect(Math.abs(f.midi - expectedMidi)).toBeLessThan(0.03);
    }
  });
});
