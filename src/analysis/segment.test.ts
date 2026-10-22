import { describe, expect, it } from 'vitest';
import { fitSlopeCentsPerSec, segmentPlateaus, voicedContour } from './segment';
import { FRAME_RATE, makeTrack, notesMidi, sustained } from './fixtures';
import { makeSung, runNotes } from './advanced-test-helpers';

const DT = 1 / FRAME_RATE;

// lowerBound / frameRange / medianRange / medianSpacing live in track.ts and are tested in track.test.ts.

describe('fitSlopeCentsPerSec', () => {
  it('is the least-squares slope in cents per second', () => {
    const t = [0, 0.1, 0.2, 0.3, 0.4];
    const midi = t.map((x) => 60 + 5 * x); // 5 semitones/s = 500 c/s
    expect(fitSlopeCentsPerSec(t, midi, 0, 5)).toBeCloseTo(500, 6);
    expect(fitSlopeCentsPerSec(t, midi, 0, 2)).toBe(0); // < 3 points
  });

  it('fits only the requested range and is 0 for a zero-variance time axis', () => {
    const t = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
    const midi = [90, 60, 61, 62, 63, 20]; // 10 semitones/s through the middle four, junk at both ends
    expect(fitSlopeCentsPerSec(t, midi, 1, 5)).toBeCloseTo(1000, 6);
    expect(fitSlopeCentsPerSec([1, 1, 1], [60, 61, 62], 0, 3)).toBe(0);
  });
});

describe('voicedContour', () => {
  it('keeps only voiced frames, in order, with their source indices', () => {
    const track = makeTrack({ duration: 1, midi: (t) => (t >= 0.2 && t < 0.6 ? 60 : NaN) });
    const c = voicedContour(track);
    expect(c.length).toBeGreaterThan(30);
    for (let k = 0; k < c.length; k++) {
      expect(track[c.index[k]].voiced).toBe(true);
      expect(c.t[k]).toBe(track[c.index[k]].t);
    }
    expect(c.t[0]).toBeGreaterThanOrEqual(0.2 - DT);
    expect(c.t[c.length - 1]).toBeLessThan(0.6);
  });

  it('median-of-3 removes a one-frame glitch but keeps a real step sharp', () => {
    const glitch = makeTrack({ duration: 0.5, midi: (t) => (Math.abs(t - 0.25) < 0.005 ? 72 : 60) });
    const cg = voicedContour(glitch);
    expect(Math.max(...cg.smooth)).toBeCloseTo(60, 6);
    expect(Math.max(...cg.midi)).toBeCloseTo(72, 6); // raw is untouched

    const step = makeTrack({ duration: 0.5, midi: (t) => (t < 0.25 ? 60 : 64) });
    const cs = voicedContour(step);
    const k = cs.t.findIndex((t) => t >= 0.25);
    expect(cs.smooth[k - 2]).toBeCloseTo(60, 6);
    expect(cs.smooth[k + 1]).toBeCloseTo(64, 6);
  });

  it('does not smooth across a real gap', () => {
    // two voiced stretches with 0.2 s of silence: the edge frames keep their own values
    const track = makeTrack({ duration: 1, midi: (t) => (t < 0.3 ? 60 : t < 0.5 ? NaN : 67) });
    const c = voicedContour(track);
    const k = c.t.findIndex((t) => t >= 0.5);
    expect(c.smooth[k]).toBeCloseTo(67, 6);
    expect(c.smooth[k - 1]).toBeCloseTo(60, 6);
  });

  it('respects a [lo, hi) window and an empty one', () => {
    const track = makeTrack({ duration: 1, midi: () => 60 });
    expect(voicedContour(track, 10, 20).length).toBe(10);
    expect(voicedContour(track, 20, 10).length).toBe(0);
    expect(voicedContour([]).length).toBe(0);
  });
});

describe('segmentPlateaus', () => {
  it('splits a fast scale (9 notes/s) into one plateau per note', () => {
    const notes = [60, 62, 64, 65, 67, 69].map((midi, i) => sustained(midi, i / 9, (i + 1) / 9));
    const track = makeTrack({ duration: 6 / 9, midi: notesMidi(notes) });
    const plateaus = segmentPlateaus(track);
    expect(plateaus).toHaveLength(notes.length);
    plateaus.forEach((p, i) => expect(Math.round(p.medianMidi)).toBe(notes[i].midi));
  });

  it('handles 12 notes/s (83 ms notes) with realistic jitter and finite-length moves', () => {
    const pattern = [60, 63, 65, 67, 70, 67, 65, 63];
    const notes = runNotes(pattern, 12, 0.1);
    const plateaus = segmentPlateaus(makeSung(notes, { transitionMs: 25, jitterCents: 8 }));
    expect(plateaus).toHaveLength(pattern.length);
    plateaus.forEach((p, i) => expect(Math.round(p.medianMidi)).toBe(pattern[i]));
  });

  it('splits a one-semitone step even with jitter', () => {
    const notes = runNotes([60, 61, 60, 61, 62], 6, 0.1);
    const plateaus = segmentPlateaus(makeSung(notes, { transitionMs: 25, jitterCents: 8 }));
    expect(plateaus).toHaveLength(5);
  });

  it('does not fragment a sustained note under realistic pitch jitter', () => {
    const track = makeTrack({ duration: 1, midi: () => 60, jitterCents: 10 });
    const plateaus = segmentPlateaus(track);
    expect(plateaus).toHaveLength(1);
    expect(Math.round(plateaus[0].medianMidi)).toBe(60);
    expect(plateaus[0].spreadCents).toBeLessThan(20);
    expect(Math.abs(plateaus[0].slopeCentsPerSec)).toBeLessThan(60);
  });

  it('treats a single noisy frame as jitter, not a new plateau', () => {
    const track = makeTrack({ duration: 0.5, midi: (t) => (Math.abs(t - 0.25) < 0.011 ? 61.4 : 60) });
    expect(segmentPlateaus(track)).toHaveLength(1);
  });

  it('treats silence as a boundary even when the pitch does not change', () => {
    const track = makeTrack({ duration: 1, midi: (t) => (t >= 0.45 && t < 0.6 ? NaN : 60) });
    expect(segmentPlateaus(track)).toHaveLength(2);
  });

  it('bridges a one-frame detector flicker instead of splitting the note', () => {
    const track = makeTrack({ duration: 1, midi: (t) => (t >= 0.5 && t < 0.508 ? NaN : 60) });
    expect(segmentPlateaus(track)).toHaveLength(1);
  });

  it('trims the transitional frames so a segment is the plateau itself', () => {
    const notes = [sustained(60, 0, 0.4), sustained(67, 0.4, 0.8)];
    const track = makeSung(notes, { transitionMs: 80, jitterCents: 4 });
    const [a, b] = segmentPlateaus(track);
    expect(a.endT).toBeLessThan(0.4); // stops before the move
    expect(b.startT).toBeGreaterThan(0.4); // starts after it
    expect(b.startT - a.endT).toBeGreaterThan(0.02);
  });

  it('reports a glide as a high-slope segment rather than a plateau', () => {
    const track = makeTrack({ duration: 0.6, midi: (t) => 60 + 0.2 * 12 * t * 5 }); // 12 semitones/s
    const segs = segmentPlateaus(track, { splitSemitones: 6 });
    expect(segs.length).toBeGreaterThanOrEqual(1);
    for (const s of segs) expect(s.slopeCentsPerSec).toBeGreaterThan(900);
  });

  it('returns startIdx/endIdx that index back into the track', () => {
    const notes = [sustained(60, 0.1, 0.5), sustained(65, 0.5, 0.9)];
    const track = makeSung(notes, { transitionMs: 25, jitterCents: 4 });
    for (const s of segmentPlateaus(track)) {
      expect(track[s.startIdx].t).toBe(s.startT);
      expect(track[s.endIdx - 1].t).toBe(s.endT);
      expect(s.frames).toBeGreaterThan(5);
    }
  });

  it('returns nothing for silence or an empty track, and honours options', () => {
    expect(segmentPlateaus(makeTrack({ duration: 0.5, midi: () => NaN }))).toEqual([]);
    expect(segmentPlateaus([])).toEqual([]);
    const notes = [sustained(60, 0, 0.4), sustained(61, 0.4, 0.8)];
    const track = makeTrack({ duration: 0.8, midi: notesMidi(notes) });
    expect(segmentPlateaus(track, { splitSemitones: 1 })).toHaveLength(2);
    expect(segmentPlateaus(track, { splitSemitones: 2 })).toHaveLength(1);
    expect(segmentPlateaus(track, { minSegmentMs: 600 })).toHaveLength(0);
  });
});
