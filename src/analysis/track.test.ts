import { describe, expect, it } from 'vitest';
import type { PitchFrame } from '../core/types';
import { makeTrack, notesMidi, sustained } from './fixtures';
import {
  centsVsTarget,
  cleanOctaveSpikes,
  cleanSpikes,
  correlation,
  estimateFrameDt,
  frameRange,
  framesInWindow,
  heldPortion,
  linearFit,
  lowerBound,
  lowerBoundTimes,
  mad,
  median,
  medianRange,
  medianSpacing,
  percentile,
  runningMean,
  runningMedian,
  standardDeviation,
  targetMidiAt,
  theilSenSlope,
  toTakeRelative,
  trimmedMean,
  voicedRuns,
} from './track';

const FR = 48000 / 512;

/** A steady 60 track whose frame `i` is replaced by `override(i)` (a midi value, or null to leave it). */
function steadyWith(duration: number, override: (i: number) => number | null): PitchFrame[] {
  return makeTrack({
    duration,
    midi: (t) => {
      const v = override(Math.round(t * FR));
      return v === null ? 60 : v;
    },
  });
}

describe('voicedRuns', () => {
  it('finds contiguous voiced runs and ignores gaps', () => {
    const track = makeTrack({ duration: 1, midi: (t) => (t >= 0.2 && t < 0.5 ? 60 : t >= 0.6 ? 62 : NaN) });
    const runs = voicedRuns(track);
    expect(runs.length).toBe(2);
    expect(runs[0].startT).toBeCloseTo(0.2, 1);
    expect(runs[0].endT).toBeLessThan(0.5);
    expect(runs[1].startT).toBeGreaterThanOrEqual(0.6);
  });

  it('returns [] for an all-unvoiced track', () => {
    const track = makeTrack({ duration: 0.5, midi: () => NaN });
    expect(voicedRuns(track)).toEqual([]);
  });

  it('bridges gaps up to maxGapSec and no further, covering the gap frames in the merged run', () => {
    // voiced, 3 frames missing, voiced, then a 12-frame hole, voiced
    const track = makeTrack({ duration: 1, midi: (t) => { const i = Math.round(t * FR); return (i >= 10 && i < 13) || (i >= 30 && i < 42) ? NaN : 60; } });
    const strict = voicedRuns(track);
    expect(strict.length).toBe(3);
    const bridged = voicedRuns(track, 0.045); // 3 missing frames = a 4-frame spacing = 42.7 ms
    expect(bridged.length).toBe(2);
    expect(bridged[0].startIndex).toBe(0);
    expect(bridged[0].endIndex).toBe(30); // exclusive: frames 0..29, so the merged run contains the 3 unvoiced frames 10..12
    expect(track.slice(bridged[0].startIndex, bridged[0].endIndex).filter((f) => !f.voiced).length).toBe(3);
    expect(bridged[0].startT).toBe(strict[0].startT);
    expect(bridged[0].endT).toBe(strict[1].endT);
    expect(voicedRuns(track, 0.2).length).toBe(1); // a 12-frame hole is 0.128 s: bridged by a wide tolerance
  });
});

describe('targetMidiAt / centsVsTarget', () => {
  it('holds the note pitch for a plain sustain', () => {
    const note = sustained(60, 0, 1);
    expect(targetMidiAt(note, 0)).toBe(60);
    expect(targetMidiAt(note, 0.5)).toBe(60);
    expect(targetMidiAt(note, 2)).toBe(60); // extrapolates past the end
  });

  it('interpolates linearly across a glide, and extrapolates by holding an endpoint', () => {
    const note = { midi: 60, start: 0, end: 1, toMidi: 64 };
    expect(targetMidiAt(note, 0)).toBeCloseTo(60, 6);
    expect(targetMidiAt(note, 0.5)).toBeCloseTo(62, 6);
    expect(targetMidiAt(note, 1)).toBeCloseTo(64, 6);
    expect(targetMidiAt(note, -1)).toBeCloseTo(60, 6);
    expect(targetMidiAt(note, 5)).toBeCloseTo(64, 6);
  });

  it('centsVsTarget is signed (+ = sharp) and NaN when unvoiced', () => {
    const note = sustained(60, 0, 1);
    const track = makeTrack({ duration: 1, midi: () => 60.1 }); // +10 cents
    expect(centsVsTarget(track[10], note)).toBeCloseTo(10, 0);

    const silent = makeTrack({ duration: 0.2, midi: () => NaN });
    expect(centsVsTarget(silent[0], note)).toBeNaN();
  });

  it('centsVsTarget follows a glide target: a singer exactly on the glide has ~0 error all along', () => {
    const note = { midi: 60, start: 0, end: 1, toMidi: 66 };
    const track = makeTrack({ duration: 1, midi: notesMidi([note]) });
    for (const f of track.slice(5, -5)) expect(Math.abs(centsVsTarget(f, note))).toBeLessThan(1e-6);
  });

  it('centsVsTarget never trusts midi on an unvoiced frame (the Framer fills midi even when unvoiced)', () => {
    const f: PitchFrame = { t: 0, f0Hz: 261.6, midi: 60, centsFromNearest: 0, confidence: 0.2, rmsDb: -60, voiced: false };
    expect(centsVsTarget(f, sustained(60, 0, 1))).toBeNaN();
  });
});

describe('lowerBound / framesInWindow / heldPortion', () => {
  it('lowerBound is the first index with t >= time (length when none)', () => {
    const track = makeTrack({ duration: 1, midi: () => 60 });
    expect(lowerBound(track, -1)).toBe(0);
    expect(lowerBound(track, 0)).toBe(0);
    expect(lowerBound(track, track[10].t)).toBe(10);
    expect(lowerBound(track, track[10].t + 1e-6)).toBe(11);
    expect(lowerBound(track, 99)).toBe(track.length);
    expect(lowerBound([], 1)).toBe(0);
  });

  it('lowerBoundTimes is the same search over a plain ascending time array', () => {
    const track = makeTrack({ duration: 1, midi: () => 60 });
    const ts = Float64Array.from(track, (f) => f.t);
    for (const time of [-1, 0, ts[10], ts[10] + 1e-6, 0.5, 99]) expect(lowerBoundTimes(ts, time)).toBe(lowerBound(track, time));
    expect(lowerBoundTimes([], 1)).toBe(0);
  });

  it('frameRange is [start, end) as indices, never inverted, and agrees with framesInWindow', () => {
    const track = makeTrack({ duration: 1, midi: () => 60 });
    const r = frameRange(track, 0.2, 0.4);
    expect(track[r.lo].t).toBeGreaterThanOrEqual(0.2);
    expect(track[r.hi - 1].t).toBeLessThan(0.4);
    expect(track.slice(r.lo, r.hi)).toEqual(framesInWindow(track, 0.2, 0.4));
    expect(frameRange(track, 0.4, 0.2).hi).toBe(frameRange(track, 0.4, 0.2).lo);
    expect(frameRange([], 0, 1)).toEqual({ lo: 0, hi: 0 });
  });

  it('framesInWindow is a half-open [start, end) slice', () => {
    const track = makeTrack({ duration: 1, midi: () => 60 });
    const win = framesInWindow(track, 0.3, 0.6);
    expect(win.every((f) => f.t >= 0.3 && f.t < 0.6)).toBe(true);
    expect(win.length).toBeGreaterThan(0);
  });

  it('framesInWindow (binary search) equals a linear filter for arbitrary windows, including empty and inverted ones', () => {
    const track = makeTrack({ duration: 3, midi: () => 60 });
    const windows: Array<[number, number]> = [[0, 3], [-5, 0.01], [2.9, 9], [0.5, 0.5], [1, 0.5], [1.234, 2.345], [10, 11]];
    for (const [a, b] of windows) {
      expect(framesInWindow(track, a, b)).toEqual(track.filter((f) => f.t >= a && f.t < b));
    }
  });

  it('heldPortion skips holdStartSkipMs from the note onset and drops unvoiced frames', () => {
    const note = sustained(60, 0.5, 1.5);
    // silent until 0.5, then voiced for the rest of the note
    const track = makeTrack({ duration: 2, midi: (t) => (t >= 0.5 && t < 1.5 ? 60 : NaN) });
    const held = heldPortion(track, note, 150);
    expect(held.every((f) => f.voiced)).toBe(true);
    expect(held[0].t).toBeGreaterThanOrEqual(0.5 + 0.15 - 1e-6);
    expect(held[held.length - 1].t).toBeLessThan(1.5);
  });

  it('heldPortion measures the skip from the note\'s own onset, not from note.start, when the singer comes in late', () => {
    const note = sustained(60, 0.5, 2);
    const track = makeTrack({ duration: 3, midi: (t) => (t >= 1.0 ? 60 : NaN) }); // 0.5 s late
    const held = heldPortion(track, note, 150);
    expect(held[0].t).toBeGreaterThanOrEqual(1.0 + 0.15 - 1e-6);
  });

  it('heldPortion is [] when the note is never voiced', () => {
    const note = sustained(60, 0, 1);
    const track = makeTrack({ duration: 1, midi: () => NaN });
    expect(heldPortion(track, note, 150)).toEqual([]);
  });
});

describe('cleanOctaveSpikes', () => {
  it('marks an isolated 1-frame octave-up glitch unvoiced, without touching its neighbours', () => {
    const spikeAt = 20;
    const track = steadyWith(1, (i) => (i === spikeAt ? 72 : null));
    const cleaned = cleanOctaveSpikes(track);
    expect(cleaned[spikeAt].voiced).toBe(false);
    // the raw midi value is left alone -- "never smooth"
    expect(cleaned[spikeAt].midi).toBeCloseTo(72, 3);
    expect(cleaned[spikeAt - 1].voiced).toBe(true);
    expect(cleaned[spikeAt - 1].midi).toBeCloseTo(60, 3);
    expect(cleaned[spikeAt + 1].voiced).toBe(true);
    expect(cleaned[spikeAt + 1].midi).toBeCloseTo(60, 3);
  });

  it('marks an octave-DOWN glitch too', () => {
    const track = steadyWith(1, (i) => (i === 30 ? 48 : null));
    expect(cleanOctaveSpikes(track)[30].voiced).toBe(false);
  });

  it('marks an isolated 2-frame glitch unvoiced and leaves a genuine octave jump that does NOT return alone', () => {
    const track = steadyWith(1, (i) => (i === 20 || i === 21 ? 72 : null)); // 2-frame spike that returns
    const cleaned = cleanOctaveSpikes(track);
    expect(cleaned[20].voiced).toBe(false);
    expect(cleaned[21].voiced).toBe(false);
    expect(cleaned[22].voiced).toBe(true);

    // a genuine, sustained octave jump (never returns) must survive untouched
    const jumpTrack = makeTrack({ duration: 1, midi: (t) => (t < 0.5 ? 60 : 72) });
    const cleanedJump = cleanOctaveSpikes(jumpTrack);
    expect(cleanedJump.filter((f) => !f.voiced).length).toBe(0);
  });

  it('does NOT clean a 3-frame excursion (that long it could be a real, very short note)', () => {
    const track = steadyWith(1, (i) => (i >= 20 && i < 23 ? 72 : null));
    expect(cleanOctaveSpikes(track).filter((f) => !f.voiced).length).toBe(0);
  });

  it('catches an octave glitch on the FIRST frame of a voiced stretch after silence (nothing before it to compare with)', () => {
    const track = makeTrack({ duration: 1, midi: (t) => { const i = Math.round(t * FR); return i < 10 ? NaN : i === 10 ? 72 : 60; } });
    const cleaned = cleanOctaveSpikes(track);
    expect(cleaned[10].voiced).toBe(false);
    expect(cleaned[11].voiced).toBe(true);
  });

  it('catches an octave glitch on the LAST frame of a voiced stretch before silence', () => {
    const track = makeTrack({ duration: 1, midi: (t) => { const i = Math.round(t * FR); return i > 40 ? NaN : i === 40 ? 72 : 60; } });
    const cleaned = cleanOctaveSpikes(track);
    expect(cleaned[40].voiced).toBe(false);
    expect(cleaned[39].voiced).toBe(true);
  });

  it('does not mistake a legitimate octave leap after a rest for a head glitch', () => {
    // C4 for 0.4 s, rest, then C5 sustained: the first C5 frames are an octave from the previous pitch but stay there
    const track = makeTrack({ duration: 2, midi: (t) => (t < 0.4 ? 60 : t < 0.8 ? NaN : 72) });
    expect(cleanOctaveSpikes(track).filter((f) => !f.voiced && Number.isFinite(f.midi)).length).toBe(0);
  });

  it('leaves a 7-semitone isolated spike alone (octave-specific), which cleanSpikes does remove', () => {
    const track = steadyWith(1, (i) => (i === 30 ? 67 : null));
    expect(cleanOctaveSpikes(track)[30].voiced).toBe(true);
    expect(cleanSpikes(track)[30].voiced).toBe(false);
  });

  it('does not mutate the input track', () => {
    const track = makeTrack({ duration: 0.2, midi: () => 60 });
    const copy = track.map((f) => ({ ...f }));
    cleanOctaveSpikes(track);
    cleanSpikes(track);
    expect(track).toEqual(copy);
  });
});

describe('cleanSpikes', () => {
  it('removes isolated large spikes of any size 3+ semitones that return, including negative ones', () => {
    const track = steadyWith(2, (i) => (i === 20 ? 63.5 : i === 60 ? 55 : i === 100 || i === 101 ? 66 : null));
    const cleaned = cleanSpikes(track);
    for (const i of [20, 60, 100, 101]) expect(cleaned[i].voiced).toBe(false);
    expect(cleaned.filter((f) => !f.voiced).length).toBe(4);
  });

  it('leaves fast but real motion alone: vibrato, a 100 ms scoop, a semitone step, a sustained leap', () => {
    const vib = makeTrack({ duration: 2, midi: (t) => 60 + 1.2 * Math.sin(2 * Math.PI * 5 * t) }); // +/-120 c at 5 Hz: steep, but physical
    expect(cleanSpikes(vib).every((f) => f.voiced)).toBe(true);
    const scoop = makeTrack({ duration: 1, midi: (t) => 60 - 0.8 * Math.max(0, 1 - t / 0.1) });
    expect(cleanSpikes(scoop).every((f) => f.voiced)).toBe(true);
    const step = makeTrack({ duration: 1, midi: (t) => (t < 0.5 ? 60 : 61) });
    expect(cleanSpikes(step).every((f) => f.voiced)).toBe(true);
    const leap = makeTrack({ duration: 1, midi: (t) => (t < 0.5 ? 60 : 67) });
    expect(cleanSpikes(leap).every((f) => f.voiced)).toBe(true);
  });

  it('does not touch an unvoiced frame that happens to carry a wild midi (the Framer fills midi on every frame)', () => {
    const track = makeTrack({ duration: 1, midi: () => 60 }).map((f, i) => (i === 20 ? { ...f, voiced: false, midi: 80 } : f));
    const cleaned = cleanSpikes(track);
    expect(cleaned[20].voiced).toBe(false);
    expect(cleaned.filter((f) => !f.voiced).length).toBe(1);
  });

  it('does not decide anything across a long silence: a lone voiced frame with no neighbours is left alone', () => {
    const track = makeTrack({ duration: 2, midi: (t) => (Math.round(t * FR) === 100 ? 72 : NaN) });
    expect(cleanSpikes(track)[100].voiced).toBe(true);
  });
});

describe('median / mad / percentile / trimmedMean / standardDeviation', () => {
  it('median of odd/even-length arrays', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNaN();
  });

  it('median never mutates its input and accepts typed arrays', () => {
    const xs = [5, 1, 4];
    median(xs);
    expect(xs).toEqual([5, 1, 4]);
    expect(median(Float64Array.from([9, 1, 5]))).toBe(5);
  });

  it('medianRange takes the median of a slice without touching the source', () => {
    const a = [9, 1, 5, 3, 7];
    expect(medianRange(a, 0, 5)).toBe(5);
    expect(medianRange(a, 1, 3)).toBe(3);
    expect(a).toEqual([9, 1, 5, 3, 7]);
    expect(medianRange(a, 2, 2)).toBeNaN();
    expect(medianRange(a, 3, 1)).toBeNaN();
    expect(medianRange(Float64Array.from(a), 0, 5)).toBe(median(a));
  });

  it('mad is the median absolute deviation from the median', () => {
    expect(mad([1, 1, 1, 1])).toBe(0);
    expect(mad([1, 2, 3, 4, 5])).toBe(1); // median 3, deviations [2,1,0,1,2] -> median 1
    expect(mad([])).toBeNaN();
  });

  it('percentile interpolates between ranks and clamps p', () => {
    const xs = [10, 20, 30, 40, 50];
    expect(percentile(xs, 0)).toBe(10);
    expect(percentile(xs, 1)).toBe(50);
    expect(percentile(xs, 0.5)).toBe(30);
    expect(percentile(xs, 0.25)).toBe(20);
    expect(percentile(xs, 0.9)).toBeCloseTo(46, 9);
    expect(percentile(xs, -1)).toBe(10);
    expect(percentile(xs, 2)).toBe(50);
    expect(percentile([], 0.5)).toBeNaN();
  });

  it('trimmedMean shrugs off outliers that wreck the plain mean', () => {
    const xs = [10, 10, 10, 10, 10, 10, 10, 10, 10, 1000];
    expect(trimmedMean(xs, 0.1)).toBeCloseTo(10, 9);
    expect(xs.reduce((a, b) => a + b, 0) / xs.length).toBeGreaterThan(100);
    expect(trimmedMean([1, 2, 3], 0.5)).toBe(2); // never trims everything away
    expect(trimmedMean([])).toBeNaN();
  });

  it('standardDeviation of a constant series is 0', () => {
    expect(standardDeviation([5, 5, 5])).toBe(0);
    expect(standardDeviation([1, 2, 3])).toBeCloseTo(0.8165, 3);
  });
});

describe('runningMedian / runningMean', () => {
  /** The definition, the slow way: the median / mean of the samples within `half` of i, clipped to the array. */
  const brute = (xs: readonly number[], width: number, f: (w: number[]) => number): number[] => {
    const half = width >= 3 ? Math.floor(width / 2) : 0;
    return xs.map((_, i) => f(xs.slice(Math.max(0, i - half), Math.min(xs.length, i + half + 1))));
  };
  const mean = (w: number[]) => w.reduce((a, b) => a + b, 0) / w.length;
  /** A deterministic pseudo-random series with repeated values (ties exercise the sorted-window removal). */
  const series = (n: number, seed: number) => Array.from({ length: n }, (_, i) => Math.round((((i * 7919 + seed * 104729) % 1009) - 500) / 7) / 4);

  it('runningMedian matches the definition for every width, odd or even, and every length including tiny ones', () => {
    for (const n of [0, 1, 2, 3, 6, 40, 200]) {
      for (const width of [0, 1, 2, 3, 4, 5, 9, 29, 30, 301]) {
        const xs = series(n, n + width);
        const got = Array.from(runningMedian(xs, width));
        const want = brute(xs, width, median);
        expect(got.length).toBe(n);
        for (let i = 0; i < n; i++) expect(got[i], `n ${n} width ${width} i ${i}`).toBeCloseTo(want[i], 9);
      }
    }
  });

  it('runningMean matches the definition for every width and length', () => {
    for (const n of [0, 1, 2, 3, 6, 40, 200]) {
      for (const width of [0, 1, 2, 3, 4, 5, 9, 29, 30, 301]) {
        const xs = series(n, n * 3 + width);
        const got = Array.from(runningMean(xs, width));
        const want = brute(xs, width, mean);
        expect(got.length).toBe(n);
        for (let i = 0; i < n; i++) expect(got[i], `n ${n} width ${width} i ${i}`).toBeCloseTo(want[i], 9);
      }
    }
  });

  it('a window under 3 (or not a number) returns a copy; neither filter mutates its input; typed arrays work', () => {
    const xs = [5, 1, 4, 2];
    expect(Array.from(runningMedian(xs, 1))).toEqual(xs);
    expect(Array.from(runningMean(xs, 2))).toEqual(xs);
    expect(Array.from(runningMedian(xs, NaN))).toEqual(xs);
    runningMedian(xs, 3);
    runningMean(xs, 3);
    expect(xs).toEqual([5, 1, 4, 2]);
    expect(Array.from(runningMedian(Float64Array.from([9, 1, 5]), 3))).toEqual([5, 5, 3]);
  });

  it('a median shrugs off a glitch shorter than half its window, and follows a real step exactly where it happens', () => {
    const base = Array.from({ length: 80 }, (_, i) => (i < 40 ? 60 : 61));
    const glitched = base.map((v, i) => (i >= 20 && i < 26 ? v + 7 : v)); // 6 frames of +7 semitones, window 15 (half 7)
    const m = Array.from(runningMedian(glitched, 15));
    for (let i = 0; i < 80; i++) expect(m[i], `i ${i}`).toBe(base[i]); // the centre line is the clean one, step and all
  });

  it('a mean over exactly whole cycles of an oscillation cancels it; a median over 1.8 cycles leaves ripple but far less than the swing', () => {
    const fs = 100;
    const f = 5;
    const wave = Array.from({ length: 400 }, (_, i) => 100 * Math.sin((2 * Math.PI * f * i) / fs + 0.7)); // +/-100, 20 samples per cycle
    const whole = Array.from(runningMean(wave, 41)).slice(40, 360); // 41 samples: 2 cycles + 1 sample
    expect(Math.max(...whole.map(Math.abs))).toBeLessThan(5);
    const med = Array.from(runningMedian(wave, 31)).slice(40, 360); // 1.55 cycles
    const ripple = Math.max(...med.map(Math.abs));
    expect(ripple).toBeLessThan(60);
    expect(ripple).toBeGreaterThan(20); // a median alone does leave some (~38 here), which is why a centre line takes a mean of it
    const both = Array.from(runningMean(runningMedian(wave, 31), 31)).slice(40, 360);
    expect(Math.max(...both.map(Math.abs))).toBeLessThan(ripple / 3);
  });

  it('is linear-ish in the length of the take: a 10-minute track at a 0.3 s window takes a fraction of a second', () => {
    const xs = series(60000, 3);
    const t0 = performance.now();
    runningMedian(xs, 29);
    runningMean(xs, 29);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe('linearFit / theilSenSlope / correlation', () => {
  it('linearFit recovers an exact line', () => {
    const xs = [0, 1, 2, 3, 4];
    const ys = xs.map((x) => 2 * x + 5);
    const fit = linearFit(xs, ys);
    expect(fit?.slope).toBeCloseTo(2, 6);
    expect(fit?.intercept).toBeCloseTo(5, 6);
  });

  it('linearFit is null for < 2 points or zero-variance x', () => {
    expect(linearFit([1], [1])).toBeNull();
    expect(linearFit([1, 1, 1], [1, 2, 3])).toBeNull();
  });

  it('linearFit can fit just a range of the points', () => {
    const xs = [0, 1, 2, 3, 4, 5];
    const ys = [100, 100, 1, 3, 5, -50]; // a line of slope 2 through the middle four, junk at both ends
    const fit = linearFit(xs, ys, 2, 5);
    expect(fit?.slope).toBeCloseTo(2, 9);
    expect(fit?.intercept).toBeCloseTo(-3, 9);
    expect(linearFit(xs, ys, 2, 3)).toBeNull(); // one point
    expect(linearFit(xs, ys, 3, 3)).toBeNull();
  });

  it('theilSenSlope recovers an exact line and resists a single outlier that OLS would not', () => {
    const xs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const ys = xs.map((x) => -3 * x + 1);
    expect(theilSenSlope(xs, ys)).toBeCloseTo(-3, 6);

    const ysWithOutlier = ys.slice();
    ysWithOutlier[9] = 1000; // one wild point
    const robust = theilSenSlope(xs, ysWithOutlier)!;
    const ols = linearFit(xs, ysWithOutlier)!.slope;
    expect(Math.abs(robust - -3)).toBeLessThan(Math.abs(ols - -3));
  });

  it('theilSenSlope thins very long inputs (O(n^2) otherwise) and stays accurate and fast', () => {
    const n = 6000;
    const xs = Array.from({ length: n }, (_, i) => i / 100);
    const ys = xs.map((x, i) => 2.5 * x + ((i * 7919) % 13) - 6); // line plus bounded pseudo-noise
    const t0 = performance.now();
    const slope = theilSenSlope(xs, ys)!;
    const ms = performance.now() - t0;
    expect(slope).toBeCloseTo(2.5, 1);
    expect(ms).toBeLessThan(500);
  });

  it('theilSenSlope is null for < 2 points or all-vertical pairs', () => {
    expect(theilSenSlope([1], [2])).toBeNull();
    expect(theilSenSlope([1, 1, 1], [1, 2, 3])).toBeNull();
  });

  it('correlation is +1 for a perfect positive line, null for zero-variance input', () => {
    const xs = [0, 1, 2, 3];
    expect(correlation(xs, xs.map((x) => 2 * x))).toBeCloseTo(1, 6);
    expect(correlation(xs, xs.map((x) => -x))).toBeCloseTo(-1, 6);
    expect(correlation(xs, [5, 5, 5, 5])).toBeNull();
  });
});

describe('estimateFrameDt / toTakeRelative', () => {
  it('estimateFrameDt recovers the fixture frame rate', () => {
    const track = makeTrack({ duration: 1, midi: () => 60 });
    const dt = estimateFrameDt(track);
    expect(dt).toBeCloseTo(512 / 48000, 6);
  });

  it('estimateFrameDt is robust to a dropped block and is NaN for < 2 frames', () => {
    const track = makeTrack({ duration: 1, midi: () => 60 }).filter((_, i) => i !== 30 && i !== 31);
    expect(estimateFrameDt(track)).toBeCloseTo(512 / 48000, 6);
    expect(estimateFrameDt([])).toBeNaN();
    expect(estimateFrameDt(track.slice(0, 1))).toBeNaN();
  });

  it('medianSpacing is the same estimate over a plain time array (a voiced contour\'s times)', () => {
    const track = makeTrack({ duration: 1, midi: () => 60 });
    expect(medianSpacing(track.map((f) => f.t))).toBeCloseTo(512 / 48000, 6);
    expect(medianSpacing(Float64Array.from(track, (f) => f.t))).toBe(estimateFrameDt(track));
    const withHoles = track.filter((_, i) => i % 7 !== 3).map((f) => f.t); // a few missing frames do not move the median
    expect(medianSpacing(withHoles)).toBeCloseTo(512 / 48000, 6);
    expect(medianSpacing([1])).toBeNaN();
    expect(medianSpacing([])).toBeNaN();
  });

  it('toTakeRelative subtracts downbeat and latency, and does not mutate the input', () => {
    const notes = [sustained(60, 0, 1)];
    const track = makeTrack({ duration: 1, midi: notesMidi(notes), t0: 2 });
    const original = track.map((f) => f.t);
    const rebased = toTakeRelative(track, 1.5, 20); // downbeat at raw t=1.5, 20ms latency
    for (let i = 0; i < track.length; i++) {
      expect(rebased[i].t).toBeCloseTo(track[i].t - 1.5 - 0.02, 9);
      expect(rebased[i].midi).toBe(track[i].midi);
      expect(rebased[i].voiced).toBe(track[i].voiced);
    }
    expect(track.map((f) => f.t)).toEqual(original);
  });
});
