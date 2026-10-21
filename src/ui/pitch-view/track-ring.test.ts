import { describe, expect, it } from 'vitest';
import { createTrackRing, defaultTrackRingCapacity } from './track-ring';

describe('TrackRing', () => {
  it('starts empty', () => {
    const ring = createTrackRing(4);
    expect(ring.length).toBe(0);
    expect(ring.latest).toBe(-1);
  });

  it('reads back pushed samples in order', () => {
    const ring = createTrackRing(8);
    for (let i = 0; i < 5; i++) ring.push(i * 0.1, 60 + i, i % 2 === 0);
    expect(ring.length).toBe(5);
    expect(ring.latest).toBe(4);
    for (let i = 0; i < 5; i++) {
      expect(ring.tAt(i)).toBeCloseTo(i * 0.1, 9);
      expect(ring.midiAt(i)).toBeCloseTo(60 + i, 5);
      expect(ring.voicedAt(i)).toBe(i % 2 === 0);
    }
  });

  it('wraps around once capacity is exceeded, dropping the oldest samples', () => {
    const cap = 4;
    const ring = createTrackRing(cap);
    for (let i = 0; i < cap + 3; i++) ring.push(i, 60 + i, true);
    expect(ring.length).toBe(cap);
    expect(ring.latest).toBe(cap - 1);
    // Oldest surviving sample is index (cap+3 - cap) = 3.
    for (let i = 0; i <= ring.latest; i++) {
      expect(ring.tAt(i)).toBe(3 + i);
      expect(ring.midiAt(i)).toBe(60 + 3 + i);
    }
  });

  it('clear() empties the buffer and the next push starts fresh', () => {
    const ring = createTrackRing(4);
    ring.push(0, 60, true);
    ring.push(1, 61, true);
    ring.clear();
    expect(ring.length).toBe(0);
    expect(ring.latest).toBe(-1);
    ring.push(5, 70, true);
    expect(ring.length).toBe(1);
    expect(ring.tAt(0)).toBe(5);
  });

  it('lowerBound finds the first sample at or after a time, within a wrapped window', () => {
    const cap = 6;
    const ring = createTrackRing(cap);
    // Push t = 0..9 (wraps twice over a capacity-6 ring); surviving logical window is t = 4..9.
    for (let i = 0; i < 10; i++) ring.push(i, 60, true);
    expect(ring.lowerBound(-100)).toBe(0); // everything qualifies
    expect(ring.lowerBound(4)).toBe(0); // oldest surviving sample is t=4
    expect(ring.tAt(ring.lowerBound(6.5))).toBe(7); // first sample with t >= 6.5
    expect(ring.lowerBound(100)).toBe(ring.length); // nothing qualifies
  });

  it('defaultTrackRingCapacity sizes for pastSeconds + 2s headroom at 120 fps', () => {
    expect(defaultTrackRingCapacity(4.5)).toBe(Math.ceil(6.5 * 120));
  });
});
