import { describe, expect, it } from 'vitest';
import { computeLanes, decideAutoRange, midiToY, tToX, updateLanes, xToT, yToMidi, type Lane } from './geometry';

describe('midi <-> y', () => {
  it('higher pitch is nearer the top (smaller y)', () => {
    const yLow = midiToY(50, 48, 72, 240);
    const yHigh = midiToY(70, 48, 72, 240);
    expect(yHigh).toBeLessThan(yLow);
  });
  it('maps the range edges to the canvas edges', () => {
    expect(midiToY(72, 48, 72, 240)).toBeCloseTo(0, 9);
    expect(midiToY(48, 48, 72, 240)).toBeCloseTo(240, 9);
  });
  it('round-trips', () => {
    for (let midi = 48; midi <= 72; midi += 0.73) {
      const y = midiToY(midi, 48, 72, 240);
      expect(yToMidi(y, 48, 72, 240)).toBeCloseTo(midi, 9);
    }
  });
  it('falls back to the midpoint for a degenerate range', () => {
    expect(midiToY(60, 60, 60, 240)).toBeCloseTo(120, 9);
  });
});

describe('t <-> x', () => {
  const axis = { width: 1000, pastSeconds: 4.5, futureSeconds: 1.75, nowLineFraction: 0.72 };

  it('puts "now" at the now-line fraction', () => {
    expect(tToX(10, 10, axis)).toBeCloseTo(720, 9);
  });
  it('puts the oldest visible past sample at the left edge', () => {
    expect(tToX(10 - 4.5, 10, axis)).toBeCloseTo(0, 9);
  });
  it('puts the furthest visible future sample at the right edge', () => {
    expect(tToX(10 + 1.75, 10, axis)).toBeCloseTo(1000, 9);
  });
  it('round-trips on both sides of the now-line', () => {
    for (const dt of [-4.5, -3, -1, -0.001, 0, 0.001, 1, 1.75]) {
      const x = tToX(10 + dt, 10, axis);
      expect(xToT(x, 10, axis)).toBeCloseTo(10 + dt, 9);
    }
  });
});

describe('computeLanes', () => {
  it('covers the visible range with one lane per semitone, high to low', () => {
    const lanes = computeLanes(60, 63, 300, 'sharps');
    const midis = lanes.map((l) => l.midi);
    expect(midis).toEqual([...midis].sort((a, b) => b - a));
    expect(midis).toContain(60);
    expect(midis).toContain(63);
    // Consecutive, no gaps.
    for (let i = 1; i < midis.length; i++) expect(midis[i - 1] - midis[i]).toBe(1);
  });
  it('flags accidentals and C (octave) lanes correctly', () => {
    const lanes = computeLanes(60, 61, 300, 'sharps');
    const c4 = lanes.find((l) => l.midi === 60)!;
    const cs4 = lanes.find((l) => l.midi === 61)!;
    expect(c4.accidental).toBe(false);
    expect(c4.isC).toBe(true);
    expect(cs4.accidental).toBe(true);
    expect(cs4.isC).toBe(false);
    expect(c4.label).toBe('C4');
    expect(cs4.label).toBe('C♯4');
  });
  it('gives every lane equal, non-overlapping, ascending-on-screen height', () => {
    const lanes = computeLanes(60, 66, 700, 'sharps');
    for (const lane of lanes) expect(lane.yBottom).toBeGreaterThan(lane.yTop);
    const sorted = [...lanes].sort((a, b) => a.yTop - b.yTop);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].yTop).toBeCloseTo(sorted[i - 1].yBottom, 9);
    }
  });
});

describe('updateLanes', () => {
  // Regression test for [autorange-static-layer-allocates-every-frame]: pitch-view.ts's
  // drawStatic() used to call computeLanes() (a fresh Lane[] plus a fresh noteName() string per
  // lane) on every dirty repaint, including every rAF frame of an auto-range tween. updateLanes()
  // must give the same lanes while reusing a caller-owned buffer in place.

  it('matches computeLanes for a fresh buffer', () => {
    const buf: Lane[] = [];
    const count = updateLanes(buf, 60, 66, 400, 'sharps');
    expect(buf.slice(0, count)).toEqual(computeLanes(60, 66, 400, 'sharps'));
  });

  it('reuses the same lane objects across repeated calls at a stable lane count (no allocation)', () => {
    const buf: Lane[] = [];
    updateLanes(buf, 60, 74, 300, 'sharps'); // warm up to the steady-state count
    const refs = buf.slice();
    // Simulate consecutive auto-range tween frames: the centre drifts slightly each frame but
    // the span - and so the lane count - stays constant, exactly like pitch-view.ts's
    // RANGE_TWEEN_SEC lerp of range.low/range.high toward rangeTarget.
    for (let i = 0; i < 30; i++) {
      const count = updateLanes(buf, 60 + i * 0.01, 74 + i * 0.01, 300, 'sharps');
      expect(count).toBe(refs.length);
      for (let j = 0; j < count; j++) expect(buf[j]).toBe(refs[j]); // same object identity: mutated, not reallocated
    }
  });

  it('keeps spare slots on shrink and reuses them on the next grow, instead of reallocating', () => {
    const buf: Lane[] = [];
    const bigCount = updateLanes(buf, 60, 84, 300, 'sharps');
    const bigRefs = buf.slice(0, bigCount);
    const smallCount = updateLanes(buf, 60, 63, 300, 'sharps');
    expect(smallCount).toBeLessThan(bigCount);
    for (let j = 0; j < smallCount; j++) expect(buf[j]).toBe(bigRefs[j]);
    const backCount = updateLanes(buf, 60, 84, 300, 'sharps');
    expect(backCount).toBe(bigCount);
    for (let j = 0; j < backCount; j++) expect(buf[j]).toBe(bigRefs[j]); // reused the spare slots, not new objects
  });

  it('refreshes every derived field (label included) when notation changes without the lane count changing', () => {
    const buf: Lane[] = [];
    const count1 = updateLanes(buf, 60, 61, 300, 'sharps');
    expect(buf.slice(0, count1).find((l) => l.midi === 61)!.label).toBe('C♯4');
    const count2 = updateLanes(buf, 60, 61, 300, 'flats');
    expect(count2).toBe(count1);
    expect(buf.slice(0, count2).find((l) => l.midi === 61)!.label).toBe('D♭4');
  });
});

describe('decideAutoRange', () => {
  const cfg = { span: 14, margin: 2 };

  it('does nothing while the reference stays within the margin of centre', () => {
    expect(decideAutoRange({ low: 53, high: 67 }, 60, cfg)).toBeNull(); // centre 60, ref 60
    expect(decideAutoRange({ low: 53, high: 67 }, 61.9, cfg)).toBeNull(); // just inside margin
  });
  it('re-centres once the reference leaves the margin', () => {
    const result = decideAutoRange({ low: 53, high: 67 }, 65, cfg); // centre 60, |65-60|=5 > 2
    expect(result).not.toBeNull();
    expect(result!.high - result!.low).toBeCloseTo(14, 9);
    expect((result!.low + result!.high) / 2).toBeCloseTo(65, 9);
  });
  it('ignores a non-finite reference', () => {
    expect(decideAutoRange({ low: 53, high: 67 }, NaN, cfg)).toBeNull();
  });
});
