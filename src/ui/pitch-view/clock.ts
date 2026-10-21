/**
 * Estimates the current input-timeline time between frame arrivals, so the
 * trace scrolls at a constant visual speed instead of stepping once per
 * ~10 ms frame. The anchor (`latestFrame.t`, `performance.now()` at arrival)
 * updates on every frame; between frames, `now()` extrapolates from
 * `performance.now()` alone, which is smooth every rAF.
 *
 * The mapping from the performance clock to the input-timeline clock
 * (`offsetSec`) is corrected slowly (an exponential blend) rather than
 * snapped on every frame, so small jitter in frame arrival doesn't show up
 * as jitter in scroll speed. A large jump (engine restart, a seek) snaps
 * instead of slow-correcting. Extrapolation is clamped to `maxHopsAhead`
 * hops past the latest frame so a stalled engine doesn't scroll forever.
 */

export interface ClockOptions {
  /** Expected seconds between frames (CONFIG.audio.hopSeconds). */
  hopSeconds: number;
  /** Clamp extrapolation to at most this many hops ahead of the latest frame. Default 2. */
  maxHopsAhead?: number;
  /** Per-frame blend factor (0..1) for the slow drift correction. Default 0.15. */
  driftSmoothing?: number;
}

export interface ScrollClock {
  /** Feed one incoming PitchFrame's timestamp, with performance.now() (ms) at arrival. */
  onFrame(frameT: number, perfNowMs: number): void;
  /** Estimate the current input-timeline time at `perfNowMs` (performance.now(), ms). NaN before the first frame. */
  now(perfNowMs: number): number;
  reset(): void;
}

export function createScrollClock(opts: ClockOptions): ScrollClock {
  const maxAheadSec = (opts.maxHopsAhead ?? 2) * opts.hopSeconds;
  const driftSmoothing = opts.driftSmoothing ?? 0.15;
  // A jump larger than this many seconds is treated as a discontinuity (snap), not drift (blend).
  const snapThresholdSec = Math.max(maxAheadSec * 4, 0.25);

  let offsetSec = NaN; // input-time minus perf-time(seconds)
  let latestFrameT = NaN;

  function onFrame(frameT: number, perfNowMs: number): void {
    const perfSec = perfNowMs / 1000;
    const instantOffset = frameT - perfSec;
    if (!Number.isFinite(offsetSec) || Math.abs(instantOffset - offsetSec) > snapThresholdSec) {
      offsetSec = instantOffset;
    } else {
      offsetSec += (instantOffset - offsetSec) * driftSmoothing;
    }
    latestFrameT = frameT;
  }

  function now(perfNowMs: number): number {
    if (!Number.isFinite(latestFrameT)) return NaN;
    const estimate = perfNowMs / 1000 + offsetSec;
    const maxT = latestFrameT + maxAheadSec;
    return estimate > maxT ? maxT : estimate;
  }

  function reset(): void {
    offsetSec = NaN;
    latestFrameT = NaN;
  }

  return { onFrame, now, reset };
}
