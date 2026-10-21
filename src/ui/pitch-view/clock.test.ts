import { describe, expect, it } from 'vitest';
import { createScrollClock } from './clock';

const HOP = 512 / 48000; // ~0.01067s, matches CONFIG.audio.hopSeconds

describe('ScrollClock', () => {
  it('is NaN before the first frame', () => {
    const clock = createScrollClock({ hopSeconds: HOP });
    expect(Number.isNaN(clock.now(1000))).toBe(true);
  });

  it('tracks perf time smoothly between frames once steady state is reached', () => {
    const clock = createScrollClock({ hopSeconds: HOP });
    let perfMs = 0;
    let frameT = 0;
    // Feed many regular hops so the offset estimate settles.
    for (let i = 0; i < 200; i++) {
      clock.onFrame(frameT, perfMs);
      perfMs += HOP * 1000;
      frameT += HOP;
    }
    // Halfway to the next frame, the estimate should sit about halfway between the last two frames.
    const halfwayPerf = perfMs - (HOP * 1000) / 2;
    const estimate = clock.now(halfwayPerf);
    expect(estimate).toBeCloseTo(frameT - HOP / 2, 2);
  });

  it('extrapolates linearly with performance.now() between frames', () => {
    const clock = createScrollClock({ hopSeconds: HOP });
    clock.onFrame(10, 1000);
    const a = clock.now(1000);
    const b = clock.now(1005); // +5ms of perf time, well inside the clamp
    expect(b - a).toBeCloseTo(0.005, 6);
  });

  it('clamps extrapolation to maxHopsAhead past the latest frame once frames stop arriving', () => {
    const clock = createScrollClock({ hopSeconds: HOP, maxHopsAhead: 2 });
    clock.onFrame(10, 1000);
    // Frames stop; a long time passes.
    const far = clock.now(1000 + 5000);
    expect(far).toBeCloseTo(10 + 2 * HOP, 9);
  });

  it('snaps (does not slowly drift) across a large discontinuity, e.g. an engine restart', () => {
    const clock = createScrollClock({ hopSeconds: HOP });
    let perfMs = 0;
    let frameT = 0;
    for (let i = 0; i < 50; i++) {
      clock.onFrame(frameT, perfMs);
      perfMs += HOP * 1000;
      frameT += HOP;
    }
    // A fresh engine restarts the input timeline near 0 while perf time keeps climbing.
    clock.onFrame(0.001, perfMs);
    expect(clock.now(perfMs)).toBeCloseTo(0.001, 6);
  });

  it('reset() clears state back to "before the first frame"', () => {
    const clock = createScrollClock({ hopSeconds: HOP });
    clock.onFrame(10, 1000);
    clock.reset();
    expect(Number.isNaN(clock.now(1000))).toBe(true);
  });
});
