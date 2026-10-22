import { describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import { analyzeDynamics } from './dynamics';
import { makeTrack, sustained } from './fixtures';
import type { AnalyzeContext } from './types';

const ctx: AnalyzeContext = { toleranceCents: 25, vibratoStyle: 'pop' };

/** A swell over [0, dur]: rises 0 -> `peakDb` above `floorDb` and back, as a half sine (a messa di voce). */
const swell = (dur: number, floorDb = -40, peakDb = 20) => (t: number) => floorDb + peakDb * Math.sin((Math.PI * t) / dur);

describe('analyzeDynamics: verdicts', () => {
  it('a steady swell with rock-solid pitch verdicts "steady"', () => {
    const note = sustained(60, 0, 3);
    const track = makeTrack({ duration: 3, midi: () => 60, rmsDb: swell(3) });
    const r = analyzeDynamics(track, note, ctx);
    expect(r.rangeDb).toBeGreaterThan(CONFIG.dynamics.minRangeDb);
    expect(r.verdict).toBe('steady');
    expect(Math.abs(r.slopeCentsPerDb ?? 0)).toBeLessThanOrEqual(CONFIG.dynamics.maxDriftCentsPerDb);
  });

  it('detects a sharp-when-loud swell: pitch rises cleanly with loudness', () => {
    const note = sustained(60, 0, 3);
    const track = makeTrack({
      duration: 3,
      midi: (t) => 60 + (30 * Math.sin((Math.PI * t) / 3)) / 100, // up to +30c sharp at peak loudness
      rmsDb: swell(3),
    });
    const r = analyzeDynamics(track, note, ctx);
    expect(r.slopeCentsPerDb).not.toBeNull();
    expect(r.slopeCentsPerDb!).toBeGreaterThan(0);
    expect(r.correlation).not.toBeNull();
    expect(r.correlation!).toBeGreaterThan(0.8);
    expect(r.verdict).toBe('sharp-when-loud');
  });

  it('detects a flat-when-soft swell: pitch falls as loudness falls', () => {
    const note = sustained(60, 0, 3);
    const track = makeTrack({
      duration: 3,
      midi: (t) => 60 - (30 * (1 - Math.sin((Math.PI * t) / 3))) / 100, // flattest when quietest (at the ends)
      rmsDb: swell(3),
    });
    const r = analyzeDynamics(track, note, ctx);
    expect(r.slopeCentsPerDb).not.toBeNull();
    expect(r.slopeCentsPerDb!).toBeGreaterThan(0); // quieter (lower relative dB) -> flatter (lower cents): still a positive slope
    expect(r.verdict).toBe('flat-when-soft');
  });

  it('pitch FALLING as the voice gets louder is neither named shape: it is plain drift (never "flat when soft")', () => {
    const note = sustained(60, 0, 3);
    const track = makeTrack({ duration: 3, midi: (t) => 60 - (30 * Math.sin((Math.PI * t) / 3)) / 100, rmsDb: swell(3) }); // flattest when loudest
    const r = analyzeDynamics(track, note, ctx);
    expect(r.slopeCentsPerDb!).toBeLessThan(-CONFIG.dynamics.maxDriftCentsPerDb);
    expect(r.verdict).toBe('drifts');
  });

  it('pitch that wanders independently of the loudness is drift, not a loudness effect', () => {
    const note = sustained(60, 0, 4);
    // a steady upward creep (+35 c over the note) while the level goes up and down: weak correlation with dB
    const track = makeTrack({ duration: 4, midi: (t) => 60 + (35 * t) / 4 / 100, rmsDb: (t) => -40 + 12 * Math.abs(Math.sin(2 * Math.PI * 0.9 * t)) + 8 * Math.sin((Math.PI * t) / 4) });
    const r = analyzeDynamics(track, note, ctx);
    expect(Math.abs(r.correlation ?? 1)).toBeLessThan(0.6);
    // time drift is the accuracy analyzer's business; what matters here is that it is not blamed on loudness
    expect(r.verdict).not.toBe('sharp-when-loud');
    expect(r.verdict).not.toBe('flat-when-soft');
  });

  it('measures the slope accurately: 0.5 c/dB is within the allowance (steady), 2 c/dB is not', () => {
    const note = sustained(60, 0, 3);
    const levelAt = swell(3);
    const slopeTrack = (centsPerDb: number) =>
      makeTrack({ duration: 3, midi: (t) => 60 + (centsPerDb * (levelAt(t) + 40)) / 100, rmsDb: levelAt });
    const small = analyzeDynamics(slopeTrack(0.5), note, ctx);
    expect(small.slopeCentsPerDb!).toBeCloseTo(0.5, 1);
    expect(small.verdict).toBe('steady');
    const big = analyzeDynamics(slopeTrack(2), note, ctx);
    expect(big.slopeCentsPerDb!).toBeCloseTo(2, 1);
    expect(big.verdict).toBe('sharp-when-loud');
  });

  it('a pitch scoop in the soft first 100 ms (the onset) is not "flat when soft"', () => {
    const note = sustained(60, 0, 4);
    const track = makeTrack({ duration: 4, midi: (t) => 60 - 0.7 * Math.max(0, 1 - t / 0.1), rmsDb: swell(4) });
    expect(analyzeDynamics(track, note, ctx).verdict).toBe('steady');
  });

  it('a vibrato riding the pitch of a swell averages out instead of reading as drift', () => {
    const note = sustained(60, 0, 6);
    const track = makeTrack({ duration: 6, midi: (t) => 60 + 0.3 * Math.sin(2 * Math.PI * 5.8 * t), rmsDb: swell(6), jitterCents: 4, seed: 2 });
    const r = analyzeDynamics(track, note, ctx);
    expect(r.verdict).toBe('steady');
    expect(Math.abs(r.slopeCentsPerDb!)).toBeLessThan(0.5);
  });

  it('dynamic steps (soft, loud, soft in sudden steps) with steady pitch: a big range, steady', () => {
    const note = sustained(60, 0, 6);
    const track = makeTrack({ duration: 6, midi: () => 60, rmsDb: (t) => (t < 2 || t >= 4 ? -45 : -25) });
    const r = analyzeDynamics(track, note, ctx);
    expect(r.rangeDb).toBeGreaterThan(15);
    expect(r.verdict).toBe('steady');
  });
});

describe('analyzeDynamics: range', () => {
  it('too little dynamic range verdicts "insufficient-range"', () => {
    const note = sustained(60, 0, 2);
    const track = makeTrack({ duration: 2, midi: () => 60, rmsDb: () => -20 });
    const r = analyzeDynamics(track, note, ctx);
    expect(r.verdict).toBe('insufficient-range');
    expect(r.slopeCentsPerDb).toBeNull();
    expect(r.symmetry).toBeNull();
    expect(r.peakPosition).toBeNull();
  });

  it('a note\'s own attack (loud steady note, quiet first few frames) is NOT dynamic range', () => {
    const note = sustained(60, 0.2, 4.2);
    const track = makeTrack({ duration: 4.5, midi: (t) => (t < 0.2 ? NaN : 60), rmsDb: (t) => (t < 0.2 ? -80 : -20 - 25 * Math.max(0, 1 - (t - 0.2) / 0.08)) });
    const r = analyzeDynamics(track, note, ctx);
    expect(r.rangeDb).toBeLessThan(2);
    expect(r.verdict).toBe('insufficient-range');
  });

  it('a one-frame pop or glitch in the RMS does not set the ceiling', () => {
    const note = sustained(60, 0, 3);
    const track = makeTrack({ duration: 3, midi: () => 60, rmsDb: (t) => (Math.abs(t - 1.5) < 0.004 ? 0 : -30) });
    const r = analyzeDynamics(track, note, ctx);
    expect(r.rangeDb).toBeLessThan(2);
    expect(r.verdict).toBe('insufficient-range');
  });

  it('never compares to an absolute dB target -- rangeDb is relative to this take\'s own floor', () => {
    const note = sustained(60, 0, 2);
    const quiet = makeTrack({ duration: 2, midi: () => 60, rmsDb: (t) => -90 + 15 * Math.sin((Math.PI * t) / 2) });
    const loud = makeTrack({ duration: 2, midi: () => 60, rmsDb: (t) => -30 + 15 * Math.sin((Math.PI * t) / 2) });
    const rQuiet = analyzeDynamics(quiet, note, ctx);
    const rLoud = analyzeDynamics(loud, note, ctx);
    expect(rQuiet.rangeDb).toBeCloseTo(rLoud.rangeDb, 3); // same relative swing regardless of absolute level
  });

  it('measures the range of a known swell to within a dB or two (median-filtered, onset excluded)', () => {
    const note = sustained(60, 0, 6);
    const r = analyzeDynamics(makeTrack({ duration: 6, midi: () => 60, rmsDb: swell(6, -40, 20) }), note, ctx);
    expect(r.rangeDb).toBeGreaterThan(17.5);
    expect(r.rangeDb).toBeLessThan(20.5);
  });
});

describe('analyzeDynamics: swell shape', () => {
  it('messa di voce symmetry and peak position: a centred, symmetric swell scores high symmetry near 0.5', () => {
    const note = sustained(60, 0, 4);
    const track = makeTrack({ duration: 4, midi: () => 60, rmsDb: swell(4) }); // peak exactly at the midpoint
    const r = analyzeDynamics(track, note, ctx);
    expect(r.peakPosition).not.toBeNull();
    expect(r.peakPosition!).toBeGreaterThan(0.4);
    expect(r.peakPosition!).toBeLessThan(0.6);
    expect(r.symmetry).not.toBeNull();
    expect(r.symmetry!).toBeGreaterThan(0.8);
  });

  it('a sharp rise and a long fade (peak a quarter in) reads as asymmetric, with the peak position to match', () => {
    const note = sustained(60, 0, 8);
    const asym = (t: number) => { const u = t / 8; return -40 + 24 * (u < 0.25 ? u / 0.25 : 1 - (u - 0.25) / 0.75); };
    const r = analyzeDynamics(makeTrack({ duration: 8, midi: () => 60, rmsDb: asym }), note, ctx);
    const sym = analyzeDynamics(makeTrack({ duration: 8, midi: () => 60, rmsDb: swell(8, -40, 24) }), note, ctx);
    expect(r.peakPosition!).toBeGreaterThan(0.15);
    expect(r.peakPosition!).toBeLessThan(0.35);
    expect(r.symmetry!).toBeLessThan(sym.symmetry! - 0.1);
  });

  it('a one-way crescendo peaks at the end and is far from a symmetric swell', () => {
    const note = sustained(60, 0, 4);
    const r = analyzeDynamics(makeTrack({ duration: 4, midi: () => 60, rmsDb: (t) => -40 + (22 * t) / 4 }), note, ctx);
    expect(r.peakPosition!).toBeGreaterThan(0.85);
    expect(r.symmetry!).toBeLessThan(0.65);
  });

  it('a flat-topped swell (grow, hold at full, fade) puts the peak at the middle of the plateau', () => {
    const note = sustained(60, 0, 8);
    const plateau = (t: number) => (t < 2 ? -40 + 10 * t : t < 6 ? -20 : -20 - 10 * (t - 6));
    const r = analyzeDynamics(makeTrack({ duration: 8, midi: () => 60, rmsDb: plateau, jitterCents: 2, seed: 1 }), note, ctx);
    expect(r.peakPosition!).toBeGreaterThan(0.42);
    expect(r.peakPosition!).toBeLessThan(0.58);
  });
});

/**
 * A swell has a direction. Soft-loud-soft and its mirror image loud-soft-loud are exactly as symmetric as each
 * other, so a symmetry measure on its own cannot tell a messa di voce from the opposite of one: the analyzer used
 * to give both 0.95. `symmetry` now exists only for a swell (the loudest stretch away from both ends, both ends
 * well below it), and `shape` says what the envelope was when it was not.
 */
describe('analyzeDynamics: the direction of the swell', () => {
  const D = 6;
  const run = (rmsDb: (t: number) => number, duration = D) => analyzeDynamics(makeTrack({ duration, midi: () => 60, rmsDb }), sustained(60, 0, duration), ctx);
  /** Linear in dB: `lo` at both ends, `hi` at fraction `at` of the note. */
  const triangle = (lo: number, hi: number, at = 0.5, duration = D) => (t: number) => {
    const u = t / duration;
    return lo + (hi - lo) * (u < at ? u / at : (1 - u) / (1 - at));
  };
  /** The mirror image: `hi` at both ends, `lo` at fraction `at`. */
  const inverted = (lo: number, hi: number, at = 0.5, duration = D) => (t: number) => lo + hi - triangle(lo, hi, at, duration)(t);

  it('soft-loud-soft is a swell: the peak is mid-note, symmetry is high', () => {
    const r = run(triangle(-40, -15));
    expect(r.shape).toBe('swell');
    expect(r.peakPosition!).toBeGreaterThan(0.4);
    expect(r.peakPosition!).toBeLessThan(0.6);
    expect(r.symmetry!).toBeGreaterThan(0.9);
  });

  it('loud-soft-loud is NOT a swell although it is exactly as symmetric: symmetry 0, shape "inverted", and the peak is at an end rather than mid-note', () => {
    const swell = run(triangle(-40, -15));
    const upsideDown = run(inverted(-40, -15));
    expect(upsideDown.rangeDb).toBeCloseTo(swell.rangeDb, 0); // the same loudness range ...
    expect(upsideDown.shape).toBe('inverted');
    expect(upsideDown.symmetry).toBe(0); // ... and none of the swell
    const p = upsideDown.peakPosition!;
    expect(p < 0.2 || p > 0.8).toBe(true); // the loudest part is at the start or the end, never the 0.48/0.74 of "both ends tie for the maximum"
    expect(swell.symmetry! - upsideDown.symmetry!).toBeGreaterThan(0.9);
  });

  it('one-way ramps are not swells: a crescendo peaks at the end, a decrescendo at the start, both symmetry 0', () => {
    const up = run((t) => -40 + (25 * t) / D);
    expect(up.shape).toBe('crescendo');
    expect(up.peakPosition!).toBeGreaterThan(0.9);
    expect(up.symmetry).toBe(0);
    const down = run((t) => -15 - (25 * t) / D);
    expect(down.shape).toBe('decrescendo');
    expect(down.peakPosition!).toBeLessThan(0.1);
    expect(down.symmetry).toBe(0);
  });

  it('real messa di voce is often lopsided: a swell peaking at 0.3 or 0.7 of the note is still a swell, less symmetric than a centred one', () => {
    const centred = run(triangle(-40, -15));
    for (const at of [0.3, 0.7]) {
      const r = run(triangle(-40, -15, at));
      expect(r.shape, `peak at ${at}`).toBe('swell');
      expect(Math.abs(r.peakPosition! - at), `peak at ${at}`).toBeLessThan(0.06);
      expect(r.symmetry!, `peak at ${at}`).toBeGreaterThan(0.5);
      expect(r.symmetry!, `peak at ${at}`).toBeLessThan(centred.symmetry! - 0.15);
    }
  });

  it('the further the peak is from the middle the lower the symmetry, smoothly, with no cliff where a swell turns into a one-way shape', () => {
    const peaks = [0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9];
    const sym = peaks.map((at) => run(triangle(-40, -15, at)).symmetry!);
    const middle = peaks.indexOf(0.5);
    for (let i = 0; i < middle; i++) expect(sym[i], `peak ${peaks[i]} vs ${peaks[i + 1]}`).toBeLessThanOrEqual(sym[i + 1] + 1e-9);
    for (let i = middle; i < peaks.length - 1; i++) expect(sym[i], `peak ${peaks[i]} vs ${peaks[i + 1]}`).toBeGreaterThanOrEqual(sym[i + 1] - 1e-9);
    for (let i = 0; i < sym.length - 1; i++) expect(Math.abs(sym[i] - sym[i + 1]), `peak ${peaks[i]} vs ${peaks[i + 1]}`).toBeLessThan(0.2);
    expect(sym[middle]).toBeGreaterThan(0.9);
    expect(run(triangle(-40, -15, 0.15)).shape).toBe('swell'); // lopsided, still a swell
    expect(run(triangle(-40, -15, 0.85)).shape).toBe('swell');
  });

  it('the mirror image is "inverted" wherever its valley is (0.3 or 0.7), not only when centred', () => {
    for (const at of [0.3, 0.5, 0.7]) {
      const r = run(inverted(-40, -15, at));
      expect(r.shape, `valley at ${at}`).toBe('inverted');
      expect(r.symmetry, `valley at ${at}`).toBe(0);
    }
  });

  it('a swell must come back down at both ends: credit grows with how far the fade goes, from none (it never fades) to full', () => {
    const fade = (fraction: number) => (t: number) => {
      const u = t / D;
      return u < 0.5 ? -40 + 25 * (u / 0.5) : -15 - 25 * fraction * ((u - 0.5) / 0.5);
    };
    const fractions = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1];
    const sym = fractions.map((f) => run(fade(f)).symmetry!);
    expect(sym[0]).toBe(0); // grows to full and stays there: a crescendo
    for (let i = 0; i < sym.length - 1; i++) expect(sym[i], `fade ${fractions[i]}`).toBeLessThanOrEqual(sym[i + 1] + 1e-9);
    expect(sym[2]).toBeLessThan(0.25); // a fade of a fifth of the range is mostly a crescendo
    expect(run(fade(0.2)).shape).not.toBe('swell');
    expect(sym[sym.length - 1]).toBeGreaterThan(0.9);
    expect(run(fade(0.8)).shape).toBe('swell');
    expect(run(fade(0.8)).symmetry!).toBeGreaterThan(0.6);
  });

  it('a crescendo that is cut off in its last instant is still a crescendo, not a swell (the ends are read over a tenth of the note, not a single point)', () => {
    const cutOff = (t: number) => (t < D - 0.15 ? -40 + (25 * t) / D : -15 - 130 * (t - (D - 0.15)));
    const r = run(cutOff);
    expect(r.shape).toBe('crescendo');
    expect(r.symmetry).toBe(0);
  });

  it('a steady note with a short burst of loudness has no slow shape to name ("uneven") and earns little as a swell, where it used to earn a perfect 1', () => {
    const burst = run((t) => (t >= 2.9 && t < 2.96 ? -10 : -30)); // 60 ms, +20 dB: survives the median filter, not the smoothing
    expect(burst.rangeDb).toBeGreaterThanOrEqual(CONFIG.dynamics.minRangeDb);
    expect(burst.shape).toBe('uneven');
    expect(burst.symmetry!).toBeLessThan(0.5);
  });

  it('sudden steps follow the same rule: soft-loud-soft is a flat-topped swell, loud-soft-loud is inverted', () => {
    expect(run((t) => (t < 2 || t >= 4 ? -45 : -25)).shape).toBe('swell');
    const r = run((t) => (t < 2 || t >= 4 ? -25 : -45));
    expect(r.shape).toBe('inverted');
    expect(r.symmetry).toBe(0);
  });

  it('a loudness ripple from vibrato (+/-3 dB at 5.8 Hz) does not change what shape it is, and does not make the swell any less of one', () => {
    const ripple = (f: (t: number) => number) => (t: number) => f(t) + 3 * Math.sin(2 * Math.PI * 5.8 * t);
    expect(run(ripple(triangle(-40, -15))).shape).toBe('swell');
    expect(run(ripple(triangle(-40, -15))).symmetry!).toBeGreaterThan(0.9);
    expect(run(ripple(inverted(-40, -15))).shape).toBe('inverted');
    expect(run(ripple((t) => -40 + (25 * t) / D)).shape).toBe('crescendo');
    expect(run(ripple(triangle(-40, -15, 0.3))).shape).toBe('swell');
  });

  it('a note with too little range has no shape at all (null), not a made-up one', () => {
    const r = run(() => -20);
    expect(r.verdict).toBe('insufficient-range');
    expect(r.shape).toBeNull();
    expect(r.symmetry).toBeNull();
  });

  it('a flat-topped swell keeps its peak mid-note and its symmetry under a vibrato-sized loudness ripple (the envelope is smoothed before its shape is read)', () => {
    const plateau = (t: number) => (t < 2 ? -40 + 10 * t : t < 6 ? -20 : -20 - 10 * (t - 6));
    for (const amplitude of [2, 4]) {
      for (const phase of [1, 2, 3]) {
        const r = run((t) => plateau(t) + amplitude * Math.sin(2 * Math.PI * 5.8 * t + phase), 8);
        const label = `+/-${amplitude} dB, phase ${phase}`;
        expect(r.shape, label).toBe('swell');
        expect(r.peakPosition!, label).toBeGreaterThan(0.45);
        expect(r.peakPosition!, label).toBeLessThan(0.55);
        expect(r.symmetry!, label).toBeGreaterThan(0.9);
      }
    }
  });

  it('frames with an unusable level (NaN or infinite rmsDb), even a run of them, are ignored rather than wrecking the measurements', () => {
    const base = makeTrack({ duration: D, midi: () => 60, rmsDb: triangle(-40, -15), jitterCents: 2, seed: 4 });
    const bad = (i: number) => (i >= 100 && i < 107) || i % 50 === 20 || i % 50 === 21;
    const r = analyzeDynamics(base.map((f, i) => (bad(i) ? { ...f, rmsDb: i % 2 ? NaN : -Infinity } : f)), sustained(60, 0, D), ctx);
    expect(r.shape).toBe('swell');
    for (const v of [r.rangeDb, r.slopeCentsPerDb, r.correlation, r.symmetry, r.peakPosition]) expect(Number.isFinite(v)).toBe(true);
    expect(r.symmetry!).toBeGreaterThan(0.85);
  });
});

describe('analyzeDynamics: robustness', () => {
  it('only frames inside the note count', () => {
    const track = makeTrack({ duration: 8, midi: () => 60, rmsDb: (t) => (t < 4 ? -20 : swell(4)(t - 4)) });
    expect(analyzeDynamics(track, sustained(60, 0, 4), ctx).verdict).toBe('insufficient-range');
    expect(analyzeDynamics(track, sustained(60, 4, 8), ctx).rangeDb).toBeGreaterThan(CONFIG.dynamics.minRangeDb);
  });

  it('empty, all-unvoiced and tiny tracks give insufficient-range, not a throw', () => {
    const note = sustained(60, 0, 2);
    expect(analyzeDynamics([], note, ctx).verdict).toBe('insufficient-range');
    expect(analyzeDynamics(makeTrack({ duration: 2, midi: () => NaN }), note, ctx).verdict).toBe('insufficient-range');
    expect(analyzeDynamics(makeTrack({ duration: 2, midi: () => 60 }).slice(0, 3), note, ctx).verdict).toBe('insufficient-range');
  });

  it('unvoiced frames (which still carry an RMS level) do not enter the envelope', () => {
    const note = sustained(60, 0, 4);
    // a loud breath (unvoiced, -5 dB) in the middle of a flat note must not look like a swell
    const track = makeTrack({ duration: 4, midi: (t) => (t > 1.9 && t < 2.1 ? NaN : 60), rmsDb: (t) => (t > 1.9 && t < 2.1 ? -5 : -30) });
    expect(analyzeDynamics(track, note, ctx).verdict).toBe('insufficient-range');
  });

  it('is deterministic and does not mutate the track', () => {
    const track = makeTrack({ duration: 3, midi: () => 60, rmsDb: swell(3), jitterCents: 3, seed: 6 });
    const copy = track.map((f) => ({ ...f }));
    expect(analyzeDynamics(track, sustained(60, 0, 3), ctx)).toEqual(analyzeDynamics(track, sustained(60, 0, 3), ctx));
    expect(track).toEqual(copy);
  });
});
