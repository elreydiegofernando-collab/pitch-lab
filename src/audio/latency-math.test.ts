import { describe, expect, it } from 'vitest';
import { estimateOffset } from './latency-math';

const BASE_OPTS = { matchWindowMs: [0, 600] as [number, number], minMatches: 5, maxJitterMs: 5 };

describe('estimateOffset: the clean case', () => {
  it('recovers an exact known offset with zero jitter', () => {
    const scheduled = [0, 1, 2, 3, 4];
    const detected = scheduled.map((t) => t + 0.05); // true offset: 50ms
    const result = estimateOffset(scheduled, detected, BASE_OPTS);
    expect(result.offsetMs).toBeCloseTo(50, 9);
    expect(result.jitterMs).toBeCloseTo(0, 9);
    expect(result.matched).toBe(5);
    expect(result.rejected).toBe(0);
    expect(result.ok).toBe(true);
  });

  it('recovers a known offset in the presence of small, honest jitter', () => {
    const scheduled = [0, 1, 2, 3, 4];
    const jitterMs = [-2, -1, 0, 1, 2];
    const detected = scheduled.map((t, i) => t + (50 + jitterMs[i]) / 1000);
    const result = estimateOffset(scheduled, detected, BASE_OPTS);
    expect(result.offsetMs).toBeCloseTo(50, 6);
    expect(result.jitterMs).toBeCloseTo(1.4826, 4); // 1.4826 * MAD(1) = 1.4826
    expect(result.matched).toBe(5);
    expect(result.rejected).toBe(0);
    expect(result.ok).toBe(true); // jitterMs (~1.48) <= maxJitterMs (5)
  });
});

describe('estimateOffset: outlier rejection', () => {
  it('rejects a single grossly-wrong match and recomputes from the rest', () => {
    const scheduled = Array.from({ length: 10 }, (_, i) => i);
    const offsetsMs = scheduled.map((_, i) => (i === 5 ? 250 : 50)); // one wild outlier
    const detected = scheduled.map((t, i) => t + offsetsMs[i] / 1000);

    const result = estimateOffset(scheduled, detected, { ...BASE_OPTS, minMatches: 5 });
    expect(result.offsetMs).toBeCloseTo(50, 9);
    expect(result.jitterMs).toBeCloseTo(0, 9); // the 9 remaining matches are all exactly 50ms
    expect(result.matched).toBe(9);
    expect(result.rejected).toBe(1);
    expect(result.ok).toBe(true);
    // With nine identical 50ms offsets, MAD is 0, so 3*spread is 0: it's the 2ms FLOOR
    // (max(3*0, 2) = 2) that actually rejects the 250ms outlier here, not the spread term.
  });
});

describe('estimateOffset: missed clicks and spurious detections', () => {
  it('skips a scheduled click with no detection in its window, and still estimates from the rest', () => {
    const scheduled = [0, 1, 2, 3, 4];
    // No detection for scheduled[2] (a missed click).
    const detected = [0.05, 1.05, 3.05, 4.05];
    const result = estimateOffset(scheduled, detected, { ...BASE_OPTS, minMatches: 4 });
    expect(result.offsetMs).toBeCloseTo(50, 9);
    expect(result.matched).toBe(4);
    expect(result.rejected).toBe(0);
    expect(result.ok).toBe(true);
  });

  it('counts extra, unrelated detections (outside any match window) as rejected, not matched', () => {
    const scheduled = [0, 1, 2];
    const detected = [0.05, 1.05, 2.05, 50, 60]; // two spurious events far outside any click's window
    const result = estimateOffset(scheduled, detected, { ...BASE_OPTS, minMatches: 3 });
    expect(result.matched).toBe(3);
    expect(result.rejected).toBe(2);
    expect(result.ok).toBe(true);
  });
});

describe('estimateOffset: matching rules', () => {
  it('matches the EARLIEST detected event in the window, not the first one listed', () => {
    const result = estimateOffset([0], [0.3, 0.1, 0.2], { ...BASE_OPTS, minMatches: 1 });
    expect(result.offsetMs).toBeCloseTo(100, 9);
    expect(result.matched).toBe(1);
  });

  it('uses each detected event at most once, even if it falls in two overlapping windows', () => {
    // click windows: [0, 0.1] and [0.02, 0.12]; the single detection at 0.05 falls in both.
    const result = estimateOffset([0, 0.02], [0.05], {
      matchWindowMs: [0, 100],
      minMatches: 1,
      maxJitterMs: 100,
    });
    expect(result.matched).toBe(1); // the second click gets nothing: its only candidate was already claimed
    expect(result.offsetMs).toBeCloseTo(50, 9); // claimed by the first (earlier) click
  });

  it('only matches within [t + min, t + max]; events just outside the window are ignored', () => {
    const result = estimateOffset([0], [0.601], { matchWindowMs: [0, 600], minMatches: 1, maxJitterMs: 100 });
    expect(result.matched).toBe(0);
    expect(result.rejected).toBe(1);
    expect(Number.isNaN(result.offsetMs)).toBe(true);
    expect(result.ok).toBe(false);
  });
});

describe('estimateOffset: not-ok cases', () => {
  it('is not ok when fewer than minMatches succeed, even with perfect timing on those', () => {
    const scheduled = Array.from({ length: 10 }, (_, i) => i);
    const detected = [0.05, 1.05]; // only 2 of 10 clicks were ever heard
    const result = estimateOffset(scheduled, detected, { ...BASE_OPTS, minMatches: 5 });
    expect(result.matched).toBe(2);
    expect(result.offsetMs).toBeCloseTo(50, 9);
    expect(result.ok).toBe(false);
  });

  it('is not ok when the (post-rejection) jitter exceeds maxJitterMs, even with plenty of matches', () => {
    const scheduled = Array.from({ length: 8 }, (_, i) => i);
    const devMs = [-30, -20, -10, 0, 10, 20, 30, 40]; // a real, wide spread - no single outlier to reject
    const detected = scheduled.map((t, i) => t + (50 + devMs[i]) / 1000);
    const result = estimateOffset(scheduled, detected, { matchWindowMs: [0, 600], minMatches: 5, maxJitterMs: 10 });
    expect(result.matched).toBe(8); // nothing was rejected as an outlier
    expect(result.jitterMs).toBeGreaterThan(10);
    expect(result.ok).toBe(false);
  });
});

describe('estimateOffset: degenerate input', () => {
  it('handles no detections at all (e.g. complete silence)', () => {
    const result = estimateOffset([0, 1, 2], [], BASE_OPTS);
    expect(result.matched).toBe(0);
    expect(result.rejected).toBe(0);
    expect(Number.isNaN(result.offsetMs)).toBe(true);
    expect(Number.isNaN(result.jitterMs)).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('handles nothing scheduled but some detections (all spurious)', () => {
    const result = estimateOffset([], [5, 6, 7], BASE_OPTS);
    expect(result.matched).toBe(0);
    expect(result.rejected).toBe(3);
    expect(result.ok).toBe(false);
  });

  it('handles no scheduled and no detected', () => {
    const result = estimateOffset([], [], BASE_OPTS);
    expect(result.matched).toBe(0);
    expect(result.rejected).toBe(0);
    expect(result.ok).toBe(false);
  });
});
