/**
 * Pure round-trip-latency estimation: match each scheduled click to the
 * detected event (mic transient, or a mapped UI tap) that followed it, then
 * take a robust estimate of the offset between them. No Web Audio or DOM
 * dependency, so it is fully testable headless.
 */
import type { OffsetEstimate } from './latency-types';

export interface EstimateOffsetOptions {
  /** [min, max] milliseconds after a scheduled time a detected event may be matched to it. */
  matchWindowMs: readonly [number, number];
  minMatches: number;
  maxJitterMs: number;
}

/** 1.4826 * MAD is a robust (outlier-resistant) estimator of standard deviation, exact for normal data. */
const MAD_TO_SIGMA = 1.4826;

function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Median and the 1.4826*MAD robust spread of `xs`, both NaN for an empty input. */
function robustStats(xs: readonly number[]): { median: number; sigma: number } {
  const m = median(xs);
  const sigma = MAD_TO_SIGMA * median(xs.map((x) => Math.abs(x - m)));
  return { median: m, sigma };
}

/**
 * Match each scheduled time (in order) to the earliest not-yet-used detected
 * time inside `[t + minMs, t + maxMs]`. Each detected event is consumed by at
 * most one scheduled time. Returns the matched offsets in milliseconds
 * (detected − scheduled); the count of leftover (unmatched) detected events
 * is `detected.length − result.length`.
 */
function matchOffsetsMs(
  scheduled: readonly number[],
  detected: readonly number[],
  minMs: number,
  maxMs: number,
): number[] {
  const used = new Array<boolean>(detected.length).fill(false);
  const offsets: number[] = [];
  for (const t of scheduled) {
    const lo = t + minMs / 1000;
    const hi = t + maxMs / 1000;
    let bestIdx = -1;
    let bestTime = Infinity;
    for (let i = 0; i < detected.length; i++) {
      if (used[i]) continue;
      const d = detected[i];
      if (d >= lo && d <= hi && d < bestTime) {
        bestTime = d;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      used[bestIdx] = true;
      offsets.push((detected[bestIdx] - t) * 1000);
    }
  }
  return offsets;
}

/**
 * Estimate the round-trip offset between `scheduled` click times and
 * `detected` event times (both AudioContext seconds). Rejects outliers
 * beyond `max(3 * spread, 2 ms)` from the median and recomputes the estimate
 * from what remains, so a handful of spurious detections or missed clicks
 * don't skew the result.
 */
export function estimateOffset(
  scheduled: readonly number[],
  detected: readonly number[],
  opts: EstimateOffsetOptions,
): OffsetEstimate {
  const [minMs, maxMs] = opts.matchWindowMs;
  const raw = matchOffsetsMs(scheduled, detected, minMs, maxMs);
  const unmatchedDetected = detected.length - raw.length;

  if (raw.length === 0) {
    return { offsetMs: NaN, jitterMs: NaN, matched: 0, rejected: unmatchedDetected, ok: false };
  }

  const pass1 = robustStats(raw);
  const threshold = Math.max(3 * pass1.sigma, 2);
  let filtered = raw.filter((x) => Math.abs(x - pass1.median) <= threshold);
  if (filtered.length === 0) filtered = raw; // defensive: the median itself is always within any positive threshold

  const pass2 = robustStats(filtered);
  const outliersRemoved = raw.length - filtered.length;

  return {
    offsetMs: pass2.median,
    jitterMs: pass2.sigma,
    matched: filtered.length,
    rejected: unmatchedDetected + outliersRemoved,
    ok: filtered.length >= opts.minMatches && pass2.sigma <= opts.maxJitterMs,
  };
}
