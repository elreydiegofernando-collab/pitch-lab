import { describe, expect, it } from 'vitest';
import { TransientDetector } from './transients';

const SAMPLE_RATE = 48000;

function silence(length: number): Float32Array {
  return new Float32Array(length);
}

/** A block of `length` zeros with `amp` written at local index `at`. */
function withImpulse(length: number, at: number, amp: number): Float32Array {
  const block = new Float32Array(length);
  block[at] = amp;
  return block;
}

function makeDetector(opts: Partial<{ thresholdDb: number; refractorySec: number; sampleRate: number; enabled: boolean }> = {}) {
  const d = new TransientDetector();
  d.configure({
    enabled: opts.enabled ?? true,
    thresholdDb: opts.thresholdDb ?? -20, // amplitude threshold 0.1
    refractorySec: opts.refractorySec ?? 0.25,
    sampleRate: opts.sampleRate ?? SAMPLE_RATE,
  });
  return d;
}

/** Feeds a list of (frame0, block) pairs and collects every (t, peakDb) emitted. */
function run(d: TransientDetector, blocks: { frame0: number; block: Float32Array }[]): { t: number; peakDb: number }[] {
  const out: { t: number; peakDb: number }[] = [];
  for (const { frame0, block } of blocks) d.process(block, frame0, (t, peakDb) => out.push({ t, peakDb }));
  return out;
}

describe('onset detection', () => {
  it('reports the exact sample of a click after silence', () => {
    const d = makeDetector();
    const events = run(d, [
      { frame0: 0, block: silence(1000) },
      { frame0: 1000, block: withImpulse(2000, 500, 0.5) }, // onset at absolute sample 1500
    ]);
    expect(events.length).toBe(1);
    expect(events[0].t).toBeCloseTo(1500 / SAMPLE_RATE, 12);
    expect(events[0].peakDb).toBeCloseTo(20 * Math.log10(0.5), 6);
  });

  it('ignores a sample clearly below the threshold', () => {
    const d = makeDetector({ thresholdDb: -20 }); // amplitude threshold 0.1
    const events = run(d, [{ frame0: 0, block: withImpulse(1000, 200, 0.05) }]);
    expect(events.length).toBe(0);
  });

  it('fires for a sample just above the threshold', () => {
    const d = makeDetector({ thresholdDb: -20 });
    const events = run(d, [{ frame0: 0, block: withImpulse(1000, 200, 0.1 + 1e-6) }]);
    expect(events.length).toBe(1);
    expect(events[0].t).toBeCloseTo(200 / SAMPLE_RATE, 12);
  });

  it('never detects while disabled', () => {
    const d = makeDetector({ enabled: false });
    const events = run(d, [{ frame0: 0, block: withImpulse(1000, 200, 0.9) }]);
    expect(events.length).toBe(0);
  });
});

describe('refractory period', () => {
  it('suppresses a second click inside the refractory window', () => {
    const d = makeDetector({ refractorySec: 0.25 });
    // Onset at absolute sample 50; refractory boundary is 50 + 12000 = 12050. A second
    // impulse at absolute sample 205 (frame0=200, local index 5) is well inside that window.
    const events = run(d, [
      { frame0: 0, block: withImpulse(200, 50, 0.9) },
      { frame0: 200, block: withImpulse(200, 5, 0.9) },
    ]);
    expect(events.length).toBe(1);
  });

  it('allows a new detection once the refractory period has fully elapsed', () => {
    const d = makeDetector({ refractorySec: 0.25 });
    const refractorySamples = Math.round(0.25 * SAMPLE_RATE); // 12000 @ 48kHz
    // Each block is long enough (> the ~5ms/240-sample peak window) for its own detection
    // to fully close before the next block starts, so the jump between blocks (simulating
    // elapsed time) can't be mistaken for part of either peak-window measurement.
    // First onset at absolute sample 50. Second block starts exactly at the refractory
    // boundary (frame0 = 50 + refractorySamples) with its impulse 10 samples in, so the
    // second onset's absolute index clears the boundary by exactly 10 samples.
    const events = run(d, [
      { frame0: 0, block: withImpulse(300, 50, 0.9) },
      { frame0: 50 + refractorySamples, block: withImpulse(300, 10, 0.9) },
    ]);
    expect(events.length).toBe(2);
    expect(events[1].t).toBeCloseTo((50 + refractorySamples + 10) / SAMPLE_RATE, 9);
  });
});

describe('peak measurement across block boundaries', () => {
  it('measures the peak over ~5ms even when it is split across process() calls', () => {
    const d = makeDetector({ thresholdDb: -20 });
    // Onset amp 0.2 at local index 10 of block starting at frame0=0; a LOUDER sample (0.7) arrives
    // in the next block, still within 5ms (240 samples @ 48kHz) of the onset.
    const first = withImpulse(50, 10, 0.2); // onset here
    const second = withImpulse(400, 50, 0.7); // well within the 5ms window, louder
    const events = run(d, [
      { frame0: 0, block: first },
      { frame0: 50, block: second },
    ]);
    expect(events.length).toBe(1);
    expect(events[0].t).toBeCloseTo(10 / SAMPLE_RATE, 12);
    expect(events[0].peakDb).toBeCloseTo(20 * Math.log10(0.7), 6);
  });

  it('does not let a later louder sample, past the peak window, start a second detection inside refractory', () => {
    const d = makeDetector({ thresholdDb: -20, refractorySec: 0.25 });
    const first = withImpulse(50, 10, 0.2); // onset at absolute 10
    // 1000 samples later (still << refractorySamples ~12000 @ 48kHz) comes a louder hit; must be swallowed by refractory, not a new onset.
    const second = withImpulse(2000, 1000, 0.9);
    const events = run(d, [
      { frame0: 0, block: first },
      { frame0: 50, block: second },
    ]);
    expect(events.length).toBe(1);
    expect(events[0].peakDb).toBeCloseTo(20 * Math.log10(0.2), 6); // the 5ms window closed long before the second hit
  });
});
