import { describe, expect, it } from 'vitest';
import type { RunResult } from '../../analysis/types';
import { makeTrack } from '../../analysis/fixtures';
import type { TargetNote } from '../../core/types';
import {
  fitPitchWindow,
  minRunGapSec,
  noteExtent,
  pickLabelMidis,
  replayLayout,
  runGlyphs,
  traceSegments,
  verdictCounts,
} from './replay-geometry';

const note = (midi: number, start: number, end: number, toMidi?: number): TargetNote => (toMidi === undefined ? { midi, start, end } : { midi, start, end, toMidi });

describe('fitPitchWindow', () => {
  it('holds the material with a note and a half to spare', () => {
    const w = fitPitchWindow([note(55, 0, 1), note(70, 1, 2)]);
    expect(w.low).toBeCloseTo(52.5, 6);
    expect(w.high).toBeCloseTo(72.5, 6);
  });

  it('is at least an octave tall, centred on the material', () => {
    const w = fitPitchWindow([note(60, 0, 1), note(64, 1, 2)]);
    expect(w.high - w.low).toBeCloseTo(12, 6);
    expect((w.low + w.high) / 2).toBeCloseTo(62, 6);
  });

  it('counts the far end of a glide', () => {
    expect(noteExtent([note(48, 0, 1, 60)])).toEqual({ lo: 48, hi: 60 });
    const w = fitPitchWindow([note(48, 0, 1, 72)]);
    expect(w.low).toBeCloseTo(45.5, 6);
    expect(w.high).toBeCloseTo(74.5, 6);
  });

  it('widens to hold what was sung, but only so far past the material', () => {
    const notes = [note(60, 0, 2)];
    const high = makeTrack({ duration: 2, midi: () => 66 });
    const wide = fitPitchWindow(notes, high);
    expect(wide.high).toBeGreaterThan(66);
    const wild = makeTrack({ duration: 2, midi: () => 90 }); // thirty semitones up: an octave error
    const w = fitPitchWindow(notes, wild);
    expect(w.high).toBeLessThanOrEqual(60 + 9 + 2.5 + 1e-9);
  });

  it('ignores a take with almost nothing voiced, and falls back when there is nothing to fit', () => {
    const blip = makeTrack({ duration: 0.05, midi: () => 90 });
    expect(fitPitchWindow([note(60, 0, 1)], blip).high).toBeCloseTo(fitPitchWindow([note(60, 0, 1)]).high, 6);
    const empty = fitPitchWindow([]);
    expect(Number.isFinite(empty.low) && Number.isFinite(empty.high)).toBe(true);
    expect(empty.high - empty.low).toBeGreaterThanOrEqual(12);
  });
});

describe('pickLabelMidis', () => {
  const win = { low: 55, high: 70 };

  it('names the target pitches and the octave Cs, highest first', () => {
    const labels = pickLabelMidis([note(60, 0, 1), note(64, 1, 2)], win, 300, 14);
    expect(labels).toEqual([64, 60]);
  });

  it('adds a C when it has room', () => {
    const labels = pickLabelMidis([note(66, 0, 1)], win, 300, 14);
    expect(labels).toEqual([66, 60]);
  });

  it('skips a name that would sit on top of one already placed', () => {
    const chromatic = [note(64, 0, 1), note(63, 1, 2), note(62, 2, 3)];
    const labels = pickLabelMidis(chromatic, win, 160, 14);
    // 15 semitones in 160 px: a lane is about 10.7 px, so adjacent names would collide and one of them goes.
    expect(labels).not.toContain(63);
    expect(labels).toContain(64);
    expect(labels).toContain(62);
    for (let i = 1; i < labels.length; i++) {
      const gapPx = ((labels[i - 1] - labels[i]) * 160) / (win.high - win.low);
      expect(gapPx).toBeGreaterThanOrEqual(14);
    }
  });

  it('never names a pitch outside the window', () => {
    expect(pickLabelMidis([note(90, 0, 1)], win, 300, 14)).not.toContain(90);
  });
});

describe('replayLayout', () => {
  it('fits the take into the box when nothing is packed', () => {
    const l = replayLayout({ spanSec: 10, hostWidth: 340, padLeft: 8, padRight: 12, minGapSec: null });
    expect(l.scrolls).toBe(false);
    expect(l.width).toBeCloseTo(340, 6);
    expect(l.pxPerSec).toBeCloseTo(32, 6);
  });

  it('widens the canvas until run notes have room for their glyphs, and scrolls', () => {
    const l = replayLayout({ spanSec: 12, hostWidth: 340, padLeft: 8, padRight: 12, minGapSec: 1 / 9 });
    expect(l.pxPerSec).toBeCloseTo(12 * 9, 6); // 12 px at 9 notes a second
    expect(l.scrolls).toBe(true);
    expect(l.width).toBeCloseTo(8 + 12 + 12 * 108, 6);
  });

  it('caps the width, keeping the backing store inside what iOS allows', () => {
    const l = replayLayout({ spanSec: 60, hostWidth: 340, padLeft: 8, padRight: 12, minGapSec: 1 / 12 });
    expect(l.width).toBeLessThanOrEqual(3200 + 1e-6);
  });

  it('does not shrink below the box when the cap is tiny', () => {
    const l = replayLayout({ spanSec: 10, hostWidth: 340, padLeft: 8, padRight: 12, minGapSec: 1, maxWidth: 100 });
    expect(l.width).toBeGreaterThanOrEqual(340 - 1e-6);
  });
});

describe('traceSegments', () => {
  const notes = [note(60, 1, 2), note(62, 2, 3)];

  it('colours the sung line by the band: inside, outside, and plain where nothing is asked', () => {
    const track = makeTrack({
      duration: 3.5,
      t0: 0,
      midi: (t) => (t < 0.5 ? NaN : t < 1.5 ? 60.1 : t < 2.5 ? 62.6 : 62),
    });
    const segs = traceSegments(track, notes, 25);
    const colours = segs.map((s) => s.color);
    expect(colours[0]).toBe(0); // 0.5-1 s: sung before the first target
    expect(colours).toContain(1);
    expect(colours).toContain(2);
    // Every voiced frame lands in exactly one segment, except the carried-over join points.
    const voiced = track.filter((f) => f.voiced).length;
    const total = segs.reduce((n, s) => n + s.t.length, 0);
    expect(total).toBeGreaterThanOrEqual(voiced);
    expect(total).toBeLessThanOrEqual(voiced + segs.length);
  });

  it('keeps the line whole where the colour changes: the next run starts on the last point', () => {
    const track = makeTrack({ duration: 1.2, t0: 0.9, midi: (t) => (t < 1.5 ? 60 : 61) });
    const segs = traceSegments(track, [note(60, 0.9, 2.2)], 25);
    expect(segs.length).toBe(2);
    expect(segs[1].t[0]).toBe(segs[0].t[segs[0].t.length - 1]);
    expect(segs[1].midi[0]).toBe(segs[0].midi[segs[0].midi.length - 1]);
  });

  it('breaks the line at unvoiced frames and long gaps', () => {
    const track = makeTrack({ duration: 2, t0: 1, midi: (t) => (t > 1.4 && t < 1.7 ? NaN : 60) });
    const segs = traceSegments(track, [note(60, 1, 3)], 25);
    expect(segs.length).toBe(2);
    expect(segs.every((s) => s.color === 1)).toBe(true);
  });

  it('follows a glide target', () => {
    const glide = [note(60, 0, 2, 64)];
    const onGlide = makeTrack({ duration: 2, t0: 0, midi: (t) => 60 + 2 * t });
    expect(traceSegments(onGlide, glide, 25).every((s) => s.color === 1)).toBe(true);
    const flat = makeTrack({ duration: 2, t0: 0, midi: () => 60 });
    expect(traceSegments(flat, glide, 25).some((s) => s.color === 2)).toBe(true);
  });

  it('returns nothing for a silent take', () => {
    expect(traceSegments(makeTrack({ duration: 1, midi: () => NaN }), notes, 25)).toEqual([]);
  });
});

describe('run glyphs', () => {
  const runNotes = [note(60, 0, 0.1), note(62, 0.1, 0.2), note(64, 0.2, 0.3)];
  const result: RunResult = {
    score: 0.7,
    components: { reached: 1, accuracy: 1, definition: 1, timing: 1 },
    notes: [
      { index: 0, targetMidi: 60, reached: true, reachedMs: 80, medianErrorCents: 3, definition: 0.9, timingErrorMs: 0, verdict: 'defined' },
      { index: 1, targetMidi: 62, reached: true, reachedMs: 50, medianErrorCents: 20, definition: 0.4, timingErrorMs: 10, verdict: 'smeared' },
      { index: 2, targetMidi: 64, reached: false, reachedMs: 0, medianErrorCents: null, definition: 0, timingErrorMs: null, verdict: 'missed' },
    ],
  };

  it('puts one glyph at the centre of each scored note', () => {
    const glyphs = runGlyphs([{ notes: runNotes, result }]);
    expect(glyphs).toEqual([
      { t: 0.05, midi: 60, verdict: 'defined' },
      { t: expect.closeTo(0.15, 6) as unknown as number, midi: 62, verdict: 'smeared' },
      { t: expect.closeTo(0.25, 6) as unknown as number, midi: 64, verdict: 'missed' },
    ]);
    expect(verdictCounts(glyphs)).toEqual({ defined: 1, smeared: 1, missed: 1 });
  });

  it('skips a result entry with no note behind it', () => {
    const glyphs = runGlyphs([{ notes: runNotes.slice(0, 1), result }]);
    expect(glyphs).toHaveLength(1);
  });

  it('measures the tightest gap between notes of one run, never across runs', () => {
    expect(minRunGapSec([{ notes: runNotes }])).toBeCloseTo(0.1, 6);
    expect(minRunGapSec([{ notes: [note(60, 0, 1)] }, { notes: [note(60, 5, 6)] }])).toBeNull();
    expect(minRunGapSec([])).toBeNull();
  });
});
