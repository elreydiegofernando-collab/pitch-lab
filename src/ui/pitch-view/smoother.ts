/**
 * Display-only smoothing for the live trace. Analyzers always see the raw
 * `PitchFrame` track; this runs on a parallel copy that only the canvas
 * reads. Two stages, both allocation-free per sample:
 *
 *  1. Median-of-3 on the raw semitone value, to kill single-frame spikes
 *     (octave glitches) without adding delay.
 *  2. A One Euro filter (Casiez, Pavard & Roussel 2012) on the median output:
 *     the cutoff frequency rises with the rate of change, so slow drift is
 *     smoothed hard while fast, deliberate movement (vibrato, onsets) passes
 *     through close to raw.
 *
 * State resets across an unvoiced gap (silence/breath) so the next voiced
 * frame starts fresh instead of lerping in from stale history.
 */
/**
 * Shaped like `CONFIG.display.smoothing`, but declared independently rather
 * than aliased from `Config` - that type's `as const` makes `median3` the
 * literal `true`, which would make the `!== false` check below pointless.
 */
export interface SmootherOptions {
  median3?: boolean;
  minCutoffHz: number;
  beta: number;
  derivativeCutoffHz: number;
}

export interface Smoother {
  /**
   * Feed one raw display-midi sample (fractional MIDI, NaN when unvoiced).
   * Returns the smoothed value, or NaN while unvoiced/resetting.
   */
  update(midi: number, t: number, voiced: boolean): number;
  reset(): void;
}

function oneEuroAlpha(cutoffHz: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dt);
}

/** Median of three numbers (no sort, no allocation). */
function median3(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

export function createSmoother(opts: SmootherOptions): Smoother {
  const useMedian = opts.median3 !== false;

  // Median-of-3 history (oldest..newest); NaN = not yet filled.
  let m0 = NaN;
  let m1 = NaN;
  let m2 = NaN;
  let mFilled = 0;

  // One Euro filter state (Casiez et al. 2012 naming: the derivative is taken
  // between successive RAW (post-median) samples, not successive filtered
  // outputs; the position lowpass is a separate exponential filter on `y_prev`).
  let yPrev = NaN; // previous filtered position
  let xRawPrev = NaN; // previous raw (post-median) sample, for the derivative
  let dxFilt = 0; // previous filtered derivative
  let tPrev = NaN;

  function reset(): void {
    m0 = m1 = m2 = NaN;
    mFilled = 0;
    yPrev = NaN;
    xRawPrev = NaN;
    dxFilt = 0;
    tPrev = NaN;
  }

  function update(midi: number, t: number, voiced: boolean): number {
    if (!voiced || !Number.isFinite(midi)) {
      reset();
      return NaN;
    }

    let x = midi;
    if (useMedian) {
      m0 = m1;
      m1 = m2;
      m2 = midi;
      if (mFilled < 3) mFilled++;
      if (mFilled === 3) x = median3(m0, m1, m2);
    }

    if (!Number.isFinite(yPrev) || !Number.isFinite(tPrev)) {
      yPrev = x;
      xRawPrev = x;
      dxFilt = 0;
      tPrev = t;
      return x;
    }

    let dt = t - tPrev;
    if (!(dt > 0)) dt = 1 / 94; // guard against non-increasing timestamps
    tPrev = t;

    const dx = (x - xRawPrev) / dt;
    xRawPrev = x;
    const aD = oneEuroAlpha(opts.derivativeCutoffHz, dt);
    dxFilt = aD * dx + (1 - aD) * dxFilt;

    const cutoff = opts.minCutoffHz + opts.beta * Math.abs(dxFilt);
    const a = oneEuroAlpha(cutoff, dt);
    yPrev = a * x + (1 - a) * yPrev;

    return yPrev;
  }

  return { update, reset };
}
