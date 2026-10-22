import { describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import { seededRandom } from '../dsp/test-signals';
import { analyzeVibrato, findVibratoEpisodes } from './vibrato';
import { makeTrack, sustained, withVibrato } from './fixtures';
import type { AnalyzeContext } from './types';

const ctx: AnalyzeContext = { toleranceCents: 25, vibratoStyle: 'pop' };
const FR = 48000 / 512;

/** A vibrato whose amplitude is random per cycle (ampLo..ampHi cents) and whose rate wanders by +/- rateWobble. */
function erratic(seed: number, ampLo: number, ampHi: number, rateWobble: number): (t: number) => number {
  const rnd = seededRandom(seed);
  const amps = Array.from({ length: 64 }, () => ampLo + (ampHi - ampLo) * rnd());
  return (t) => {
    const phase = 5.8 * t + (rateWobble * 5.8 * (1 - Math.cos(2 * Math.PI * 0.8 * t))) / (2 * Math.PI * 0.8);
    return 60 + (amps[Math.floor(phase) % 64] / 100) * Math.sin(2 * Math.PI * phase);
  };
}

describe('analyzeVibrato: recovery', () => {
  it('recovers 5.8 Hz +/-45c vibrato within +/-0.3 Hz / +/-6 cents', () => {
    const note = sustained(60, 0, 3);
    const contour = withVibrato(() => 60, 5.8, 45);
    const track = makeTrack({ duration: 3, midi: contour });
    const r = analyzeVibrato(track, note, ctx);

    expect(r.present).toBe(true);
    expect(r.rateHz).not.toBeNull();
    expect(Math.abs(r.rateHz! - 5.8)).toBeLessThanOrEqual(0.3);
    expect(r.extentCents).not.toBeNull();
    expect(Math.abs(r.extentCents! - 45)).toBeLessThanOrEqual(6);
    expect(r.centeringCents).not.toBeNull();
    expect(Math.abs(r.centeringCents!)).toBeLessThan(5);
    expect(r.inZone).toBe(true); // pop zone: 5-7 Hz, 20-60c
    expect(r.flags).not.toContain('wobble');
    expect(r.flags).not.toContain('bleat');
    expect(r.flags).not.toContain('straight');
    expect(r.flags).not.toContain('irregular');
  });

  it('is much tighter than the +/-0.3 Hz / +/-6 c budget on a clean contour (rate 0.05 Hz, extent 2 cents)', () => {
    const track = makeTrack({ duration: 3, midi: withVibrato(() => 60, 5.8, 45) });
    const r = analyzeVibrato(track, sustained(60, 0, 3), ctx);
    expect(Math.abs(r.rateHz! - 5.8)).toBeLessThan(0.05);
    expect(Math.abs(r.extentCents! - 45)).toBeLessThan(2);
    expect(r.regularity!).toBeGreaterThan(0.95);
  });

  it('holds across rates 3-9 Hz and extents 15-120 c, with 6 c RMS frame jitter, on 1.5 s and 3 s notes', () => {
    const cases: Array<[number, number]> = [[3, 120], [4, 45], [4.5, 30], [5.8, 45], [6.5, 30], [7.5, 60], [5, 100], [9, 35], [5.5, 15]];
    for (const [rate, ext] of cases) {
      for (const dur of [1.5, 3]) {
        const note = sustained(60, 0, dur);
        const track = makeTrack({ duration: dur, midi: withVibrato(() => 60, rate, ext), jitterCents: 6, seed: 7 });
        const r = analyzeVibrato(track, note, ctx);
        const label = `${rate} Hz +/-${ext} c, ${dur}s`;
        expect(r.present, label).toBe(true);
        expect(Math.abs(r.rateHz! - rate), label).toBeLessThan(0.25);
        expect(Math.abs(r.extentCents! - ext), label).toBeLessThan(Math.max(5, 0.1 * ext));
        expect(Math.abs(r.centeringCents!), label).toBeLessThan(5);
      }
    }
  });

  it('survives heavy (10 c RMS) jitter: still present, still accurate to a few percent', () => {
    const note = sustained(60, 0, 3);
    const track = makeTrack({ duration: 3, midi: withVibrato(() => 60, 5.8, 45), jitterCents: 10, seed: 3 });
    const r = analyzeVibrato(track, note, ctx);
    expect(r.present).toBe(true);
    expect(Math.abs(r.rateHz! - 5.8)).toBeLessThan(0.15);
    expect(Math.abs(r.extentCents! - 45)).toBeLessThan(6);
    expect(r.regularity!).toBeGreaterThan(0.6);
  });

  it('works on a short 0.5 s snippet (about three cycles)', () => {
    const track = makeTrack({ duration: 0.5, midi: withVibrato(() => 60, 5.8, 45), jitterCents: 4, seed: 3 });
    const r = analyzeVibrato(track, sustained(60, 0, 0.5), ctx);
    expect(r.present).toBe(true);
    expect(Math.abs(r.rateHz! - 5.8)).toBeLessThan(0.3);
  });

  it('too little signal is not vibrato: 0.25 s (under minDurationSec) and a single swing', () => {
    const short = makeTrack({ duration: 0.25, midi: withVibrato(() => 60, 5.8, 45) });
    expect(analyzeVibrato(short, sustained(60, 0, 0.25), ctx).present).toBe(false);
    // one lone half-second oscillation inside a straight note: fewer than minCycles cycles
    const one = makeTrack({ duration: 2, midi: (t) => (t > 0.8 && t < 0.97 ? 60 + 0.45 * Math.sin(2 * Math.PI * 5.8 * (t - 0.8)) : 60) });
    expect(analyzeVibrato(one, sustained(60, 0, 2), ctx).present).toBe(false);
  });
});

describe('analyzeVibrato: straight tone (a neutral result, never an error)', () => {
  it('a straight tone (no oscillation) is flagged "straight" and not "present"', () => {
    const note = sustained(60, 0, 2);
    const track = makeTrack({ duration: 2, midi: () => 60 });
    const r = analyzeVibrato(track, note, ctx);
    expect(r.present).toBe(false);
    expect(r.flags).toContain('straight');
    expect(r.flags).not.toContain('wobble');
    expect(r.flags).not.toContain('irregular');
    expect(r.rateHz).toBeNull();
    expect(r.regularity).toBeNull();
    expect(r.inZone).toBe(false);
  });

  it('frame jitter up to 5 c is still a straight tone: never a false vibrato, rate and regularity not invented', () => {
    for (const jitter of [3, 5]) {
      const note = sustained(60, 0, 3);
      const track = makeTrack({ duration: 3, midi: () => 60, jitterCents: jitter, seed: 9 });
      const r = analyzeVibrato(track, note, ctx);
      expect(r.present, `jitter ${jitter}`).toBe(false);
      expect(r.flags, `jitter ${jitter}`).toContain('straight');
      expect(r.rateHz, `jitter ${jitter}`).toBeNull();
      expect(r.regularity, `jitter ${jitter}`).toBeNull();
    }
  });

  it('no false positives over 40 noise seeds at 6, 8 and 10 c RMS jitter, on 1 s and 3 s straight tones', () => {
    let falsePositives = 0;
    for (const jitter of [6, 8, 10]) {
      for (const dur of [1, 3]) {
        for (let seed = 1; seed <= 40; seed++) {
          const track = makeTrack({ duration: dur, midi: () => 60, jitterCents: jitter, seed });
          if (analyzeVibrato(track, sustained(60, 0, dur), ctx, { windows: false }).present) falsePositives++;
        }
      }
    }
    expect(falsePositives).toBe(0);
  });

  it('a vibrato below the straight threshold (+/-6 c) is reported as straight, and one just above (+/-14 c) is present', () => {
    const small = makeTrack({ duration: 3, midi: withVibrato(() => 60, 5.8, 6) });
    const rs = analyzeVibrato(small, sustained(60, 0, 3), ctx);
    expect(rs.present).toBe(false);
    expect(rs.flags).toContain('straight');
    const bigger = makeTrack({ duration: 3, midi: withVibrato(() => 60, 5.8, 14) });
    const rb = analyzeVibrato(bigger, sustained(60, 0, 3), ctx);
    expect(rb.present).toBe(true);
    expect(rb.flags).not.toContain('straight');
  });
});

describe('analyzeVibrato: flags and zones', () => {
  it('flags a slow, wide wobble (below wobbleBelowHz, above wobbleAboveExtentCents)', () => {
    const note = sustained(60, 0, 3);
    const contour = withVibrato(() => 60, 3, 150); // slow AND wide
    const track = makeTrack({ duration: 3, midi: contour });
    const r = analyzeVibrato(track, note, ctx);
    expect(r.present).toBe(true);
    expect(r.rateHz!).toBeLessThan(CONFIG.vibrato.wobbleBelowHz);
    expect(r.extentCents!).toBeGreaterThan(CONFIG.vibrato.wobbleAboveExtentCents);
    expect(r.flags).toContain('wobble');
  });

  it('flags a wobble that is slow only, and one that is wide only', () => {
    const slow = analyzeVibrato(makeTrack({ duration: 3, midi: withVibrato(() => 60, 3.6, 50) }), sustained(60, 0, 3), ctx);
    expect(slow.flags).toContain('wobble');
    const wide = analyzeVibrato(makeTrack({ duration: 3, midi: withVibrato(() => 60, 5.8, 140) }), sustained(60, 0, 3), ctx);
    expect(wide.flags).toContain('wobble');
    const fine = analyzeVibrato(makeTrack({ duration: 3, midi: withVibrato(() => 60, 5.8, 60) }), sustained(60, 0, 3), ctx);
    expect(fine.flags).not.toContain('wobble');
  });

  it('flags a fast bleat/tremolo (above bleatAboveHz)', () => {
    const note = sustained(60, 0, 2);
    const contour = withVibrato(() => 60, 9, 35);
    const track = makeTrack({ duration: 2, midi: contour });
    const r = analyzeVibrato(track, note, ctx);
    expect(r.present).toBe(true);
    expect(r.rateHz!).toBeGreaterThan(CONFIG.vibrato.bleatAboveHz);
    expect(r.flags).toContain('bleat');
  });

  it('flags sagging-flat when the oscillation centres clearly below the target', () => {
    const note = sustained(60, 0, 3);
    const contour = withVibrato(() => 59.6, 5.8, 45); // centred 40c flat
    const track = makeTrack({ duration: 3, midi: contour });
    const r = analyzeVibrato(track, note, ctx);
    expect(r.centeringCents!).toBeLessThan(-ctx.toleranceCents);
    expect(r.centeringCents!).toBeGreaterThan(-45);
    expect(r.flags).toContain('sagging-flat');
    expect(r.flags).not.toContain('sharp-centred');
  });

  it('flags sharp-centred when the oscillation centres clearly above the target', () => {
    const note = sustained(60, 0, 3);
    const contour = withVibrato(() => 60.4, 5.8, 45); // centred 40c sharp
    const track = makeTrack({ duration: 3, midi: contour });
    const r = analyzeVibrato(track, note, ctx);
    expect(r.centeringCents!).toBeGreaterThan(ctx.toleranceCents);
    expect(r.flags).toContain('sharp-centred');
  });

  it('centring is the centre of the oscillation: a vibrato centred 8 c flat reads -8 c, not skewed by the scoop at its start', () => {
    const track = makeTrack({ duration: 3, midi: (t) => 59.92 - 0.6 * Math.exp(-t / 0.1) + 0.45 * Math.sin(2 * Math.PI * 5.8 * t) });
    const r = analyzeVibrato(track, sustained(60, 0, 3), ctx);
    expect(Math.abs(r.centeringCents! - -8)).toBeLessThan(5);
  });

  it('does not report sagging/sharp for a straight tone (that is the accuracy analyzer\'s job)', () => {
    const r = analyzeVibrato(makeTrack({ duration: 2, midi: () => 60.4 }), sustained(60, 0, 2), ctx);
    expect(r.flags).toEqual(['straight']);
    expect(r.centeringCents!).toBeGreaterThan(30);
  });

  it('is in the classical zone but not the pop zone for a wider extent at the same rate', () => {
    const note = sustained(60, 0, 3);
    const track = makeTrack({ duration: 3, midi: withVibrato(() => 60, 6, 70) }); // pop: 20-60c, classical: 40-100c
    const pop = analyzeVibrato(track, note, { toleranceCents: 25, vibratoStyle: 'pop' });
    const classical = analyzeVibrato(track, note, { toleranceCents: 25, vibratoStyle: 'classical' });
    expect(pop.inZone).toBe(false);
    expect(classical.inZone).toBe(true);
  });

  it('is out of zone when the rate is out of the 5-7 Hz band even with a good extent', () => {
    const r = analyzeVibrato(makeTrack({ duration: 3, midi: withVibrato(() => 60, 4.2, 40) }), sustained(60, 0, 3), ctx);
    expect(r.present).toBe(true);
    expect(r.inZone).toBe(false);
  });
});

/**
 * SPEC 8.3 states the zones and flags as numbers: pop 5-7 Hz at +/-20-60 c, classical 5-7 Hz at +/-40-100 c, wobble
 * below 4.5 Hz or above +/-120 c, bleat above 8 Hz, straight below about +/-10 c. They are pinned here as boundary
 * behaviours on clean contours (the measurement is good to ~0.05 Hz and ~1 c there, so each probe sits a safe
 * distance either side of its edge). If the owner retunes one, change it here on purpose.
 */
describe('analyzeVibrato: the SPEC 8.3 numbers (pinned on purpose)', () => {
  const sing = (rateHz: number, extentCents: number, opts: { style?: 'pop' | 'classical'; centre?: number; toleranceCents?: number } = {}) =>
    analyzeVibrato(makeTrack({ duration: 3, midi: withVibrato(() => opts.centre ?? 60, rateHz, extentCents) }), sustained(60, 0, 3), {
      toleranceCents: opts.toleranceCents ?? 25,
      vibratoStyle: opts.style ?? 'pop',
    });

  it('both styles want 5-7 Hz: 4.8 and 7.2 Hz are out of the zone, 5.2 and 6.8 Hz are in it', () => {
    for (const style of ['pop', 'classical'] as const) {
      expect(sing(4.8, 50, { style }).inZone, `${style} 4.8 Hz`).toBe(false);
      expect(sing(5.2, 50, { style }).inZone, `${style} 5.2 Hz`).toBe(true);
      expect(sing(6.8, 50, { style }).inZone, `${style} 6.8 Hz`).toBe(true);
      expect(sing(7.2, 50, { style }).inZone, `${style} 7.2 Hz`).toBe(false);
    }
  });

  it('the pop zone is +/-20-60 c: 17 and 63 c are out, 23 and 57 c are in', () => {
    expect([17, 23, 57, 63].map((e) => sing(5.8, e).inZone)).toEqual([false, true, true, false]);
  });

  it('the classical zone is +/-40-100 c: 37 and 103 c are out, 43 and 97 c are in', () => {
    expect([37, 43, 97, 103].map((e) => sing(5.8, e, { style: 'classical' }).inZone)).toEqual([false, true, true, false]);
  });

  it('wobble is a rate below 4.5 Hz or an extent above +/-120 c: 4.4 Hz and 125 c are flagged, 4.6 Hz and 115 c are not', () => {
    expect(sing(4.4, 40).flags).toContain('wobble');
    expect(sing(4.6, 40).flags).not.toContain('wobble');
    expect(sing(5.8, 125).flags).toContain('wobble');
    expect(sing(5.8, 115).flags).not.toContain('wobble');
  });

  it('bleat is a rate above 8 Hz: 8.2 Hz is flagged, 7.8 Hz is not', () => {
    expect(sing(8.2, 40).flags).toContain('bleat');
    expect(sing(7.8, 40).flags).not.toContain('bleat');
  });

  it('straight tone is an extent below about +/-10 c: 8 c is straight (not vibrato, flagged neutrally), 12 c is vibrato', () => {
    const straight = sing(5.8, 8);
    expect(straight.present).toBe(false);
    expect(straight.flags).toContain('straight');
    const small = sing(5.8, 12);
    expect(small.present).toBe(true);
    expect(small.flags).not.toContain('straight');
  });

  it('centring is judged against the LEVEL\'s tolerance: a vibrato 18 c flat or sharp is a fault at +/-10 c (studio) and not at +/-25 c or +/-50 c', () => {
    const flags = (centre: number, toleranceCents: number) => sing(5.8, 45, { centre, toleranceCents }).flags;
    expect(flags(59.82, CONFIG.tolerance.studio)).toContain('sagging-flat');
    expect(flags(59.82, CONFIG.tolerance.default)).not.toContain('sagging-flat');
    expect(flags(59.82, CONFIG.tolerance.easy)).not.toContain('sagging-flat');
    expect(flags(60.18, CONFIG.tolerance.studio)).toContain('sharp-centred');
    expect(flags(60.18, CONFIG.tolerance.default)).not.toContain('sharp-centred');
    expect(flags(60.18, CONFIG.tolerance.easy)).not.toContain('sharp-centred');
  });
});

describe('analyzeVibrato: regularity', () => {
  it('a regular, constant-rate/extent vibrato scores high regularity; an erratic one scores lower and is flagged', () => {
    const note = sustained(60, 0, 3);
    const regular = makeTrack({ duration: 3, midi: withVibrato(() => 60, 5.8, 45), jitterCents: 3, seed: 4 });
    const rRegular = analyzeVibrato(regular, note, ctx);
    expect(rRegular.regularity).not.toBeNull();
    expect(rRegular.regularity!).toBeGreaterThan(0.85);
    expect(rRegular.flags).not.toContain('irregular');

    for (const seed of [1, 2, 3]) {
      const track = makeTrack({ duration: 3, midi: erratic(seed, 25, 70, 0.2), jitterCents: 3, seed });
      const r = analyzeVibrato(track, note, ctx);
      expect(r.present, `seed ${seed}`).toBe(true);
      expect(r.regularity!, `seed ${seed}`).toBeLessThan(0.5);
      expect(r.regularity!, `seed ${seed}`).toBeLessThan(rRegular.regularity!);
      expect(r.flags, `seed ${seed}`).toContain('irregular');
    }
  });

  it('extent that alternates wide/narrow every cycle is less regular than a steady one', () => {
    const note = sustained(60, 0, 3);
    const steady = analyzeVibrato(makeTrack({ duration: 3, midi: withVibrato(() => 60, 5.8, 45) }), note, ctx);
    const alternating = analyzeVibrato(
      makeTrack({ duration: 3, midi: (t) => 60 + ((Math.floor(t * 5.8) % 2 === 0 ? 20 : 100) / 100) * Math.sin(2 * Math.PI * 5.8 * t) }),
      note,
      ctx,
    );
    expect(alternating.regularity === null || alternating.regularity < steady.regularity!).toBe(true);
  });

  it('respects the natural ~15% rate ramp as regular, not irregular', () => {
    const note = sustained(60, 0, 3);
    // rate ramps 5.4 -> 6.2 Hz across the take (~15% rise), constant extent.
    const track = makeTrack({ duration: 3, midi: (t) => 60 + 0.45 * Math.sin(2 * Math.PI * (5.4 * t + (0.8 * t * t) / 6)), jitterCents: 3, seed: 3 });
    const r = analyzeVibrato(track, note, ctx);
    expect(r.present).toBe(true);
    expect(r.flags).not.toContain('irregular');
    expect(r.regularity!).toBeGreaterThan(0.85);
  });

  it('a strong speed-up (4 -> 7 Hz in 3 s) is NOT the natural ramp: it reads as irregular', () => {
    const track = makeTrack({ duration: 3, midi: (t) => 60 + 0.45 * Math.sin(2 * Math.PI * (4 * t + (3 * t * t) / 6)), jitterCents: 3, seed: 3 });
    const r = analyzeVibrato(track, sustained(60, 0, 3), ctx);
    expect(r.present).toBe(true);
    expect(r.regularity!).toBeLessThan(0.5);
    expect(r.flags).toContain('irregular');
  });

  it('rate and extent spreads are reported (small for a steady vibrato)', () => {
    const r = analyzeVibrato(makeTrack({ duration: 3, midi: withVibrato(() => 60, 5.8, 45), jitterCents: 3, seed: 5 }), sustained(60, 0, 3), ctx);
    expect(r.rateSdHz!).toBeLessThan(0.3);
    expect(r.extentSdCents!).toBeLessThan(4);
  });
});

describe('analyzeVibrato: real-world messiness', () => {
  const note = sustained(60, 0, 3);

  it('a slow pitch drift under the vibrato (the detrend\'s whole job) does not disturb rate or extent', () => {
    for (const drift of [-40, 20, 80]) {
      const track = makeTrack({ duration: 3, midi: (t) => 60 + (drift * t) / 100 + 0.45 * Math.sin(2 * Math.PI * 5.8 * t), jitterCents: 4, seed: 3 });
      const r = analyzeVibrato(track, note, ctx);
      expect(r.present, `drift ${drift}`).toBe(true);
      expect(Math.abs(r.rateHz! - 5.8), `drift ${drift}`).toBeLessThan(0.15);
      expect(Math.abs(r.extentCents! - 45), `drift ${drift}`).toBeLessThan(5);
    }
  });

  it('a scoop at the start followed by vibrato does not corrupt the vibrato measurement', () => {
    const track = makeTrack({ duration: 3, midi: (t) => 60 - 0.8 * Math.exp(-t / 0.12) + 0.45 * Math.sin(2 * Math.PI * 5.8 * t), jitterCents: 4, seed: 3 });
    const r = analyzeVibrato(track, note, ctx);
    expect(r.present).toBe(true);
    expect(Math.abs(r.rateHz! - 5.8)).toBeLessThan(0.2);
    expect(Math.abs(r.extentCents! - 45)).toBeLessThan(5);
  });

  it('1-3 frame detector dropouts every ~0.4 s do not split the vibrato or change the answer', () => {
    const track = makeTrack({ duration: 3, midi: withVibrato(() => 60, 5.8, 45), jitterCents: 4, seed: 3 }).map((f, i) => (i % 37 < 3 ? { ...f, voiced: false } : f));
    const r = analyzeVibrato(track, note, ctx);
    expect(r.present).toBe(true);
    expect(Math.abs(r.rateHz! - 5.8)).toBeLessThan(0.15);
    expect(Math.abs(r.extentCents! - 45)).toBeLessThan(5);
  });

  it('isolated octave and 300 c spike frames (sparse detector glitches) are ignored', () => {
    const track = makeTrack({ duration: 3, midi: withVibrato(() => 60, 5.8, 45), jitterCents: 4, seed: 3 }).map((f, i) =>
      i % 50 === 25 ? { ...f, midi: f.midi + (i % 100 === 25 ? 12 : 3) } : f,
    );
    const r = analyzeVibrato(track, note, ctx);
    expect(r.present).toBe(true);
    expect(Math.abs(r.rateHz! - 5.8)).toBeLessThan(0.15);
    expect(Math.abs(r.extentCents! - 45)).toBeLessThan(5);
    expect(r.regularity!).toBeGreaterThan(0.8);
  });

  it('a skewed (sawtooth-ish) vibrato waveform still gets the right rate and a sensible extent', () => {
    const track = makeTrack({
      duration: 3,
      midi: (t) => {
        const ph = (t * 5.8) % 1;
        return 60 + 0.45 * (ph < 0.7 ? -1 + (2 * ph) / 0.7 : 1 - (2 * (ph - 0.7)) / 0.3);
      },
      jitterCents: 4,
      seed: 3,
    });
    const r = analyzeVibrato(track, note, ctx);
    expect(r.present).toBe(true);
    expect(Math.abs(r.rateHz! - 5.8)).toBeLessThan(0.2);
    expect(Math.abs(r.extentCents! - 45)).toBeLessThan(8);
  });

  it('frames the Framer marked unvoiced but left carrying a wild midi do not influence anything', () => {
    const base = makeTrack({ duration: 3, midi: withVibrato(() => 60, 5.8, 45), jitterCents: 3, seed: 5 });
    const polluted = base.map((f, i) => (i % 9 === 4 ? { ...f, voiced: false, midi: 80, f0Hz: 830 } : f));
    const clean = base.map((f, i) => (i % 9 === 4 ? { ...f, voiced: false } : f));
    const a = analyzeVibrato(polluted, note, ctx);
    const b = analyzeVibrato(clean, note, ctx);
    expect(a.rateHz).toBe(b.rateHz);
    expect(a.extentCents).toBe(b.extentCents);
    expect(a.centeringCents).toBe(b.centeringCents);
  });

  it('an all-unvoiced track, an empty track and a one-frame track return a safe not-present result, not a throw', () => {
    const silent = makeTrack({ duration: 1, midi: () => NaN });
    for (const track of [silent, [], silent.slice(0, 1)]) {
      const r = analyzeVibrato(track, sustained(60, 0, 1), ctx);
      expect(r.present).toBe(false);
      expect(r.rateHz).toBeNull();
      expect(r.extentCents).toBeNull();
      expect(r.regularity).toBeNull();
      expect(r.flags.every((f) => f === 'straight')).toBe(true);
    }
    expect(analyzeVibrato([], null, ctx).windows).toEqual([]);
  });

  it('only frames inside the note count: vibrato on the NEXT note is not credited to this one', () => {
    const track = makeTrack({ duration: 6, midi: (t) => (t < 3 ? 60 : 64 + 0.45 * Math.sin(2 * Math.PI * 5.8 * t)) });
    expect(analyzeVibrato(track, sustained(60, 0, 3), ctx).present).toBe(false);
    expect(analyzeVibrato(track, sustained(64, 3, 6), ctx).present).toBe(true);
  });

  it('is deterministic and does not mutate its input', () => {
    const track = makeTrack({ duration: 2, midi: withVibrato(() => 60, 5.8, 45), jitterCents: 5, seed: 2 });
    const copy = track.map((f) => ({ ...f }));
    const a = analyzeVibrato(track, sustained(60, 0, 2), ctx);
    const b = analyzeVibrato(track, sustained(60, 0, 2), ctx);
    expect(a).toEqual(b);
    expect(track).toEqual(copy);
  });
});

describe('analyzeVibrato: whole-track mode and live windows', () => {
  it('note = null analyzes a whole free-singing track and omits centering', () => {
    const track = makeTrack({ duration: 2, midi: withVibrato(() => 67, 5.8, 45) });
    const r = analyzeVibrato(track, null, ctx);
    expect(r.present).toBe(true);
    expect(r.centeringCents).toBeNull();
    expect(Math.abs(r.rateHz! - 5.8)).toBeLessThanOrEqual(0.3);
  });

  it('with and without a note give the same rate and extent', () => {
    const track = makeTrack({ duration: 2, midi: withVibrato(() => 63, 5.5, 50), jitterCents: 4, seed: 6 });
    const withNote = analyzeVibrato(track, sustained(63, 0, 2), ctx);
    const free = analyzeVibrato(track, null, ctx);
    expect(free.rateHz).toBeCloseTo(withNote.rateHz!, 6);
    expect(free.extentCents).toBeCloseTo(withNote.extentCents!, 6);
  });

  it('analyzes the longest oscillation of a multi-note take, ignoring an unvoiced gap between notes', () => {
    const track = makeTrack({
      duration: 6,
      midi: (t) => (t < 1.5 ? 60 + 0.2 * Math.sin(2 * Math.PI * 5.8 * t) : t < 2.5 ? NaN : 64 + 0.45 * Math.sin(2 * Math.PI * 6.2 * t)),
      jitterCents: 3,
      seed: 1,
    });
    const r = analyzeVibrato(track, null, ctx, { windows: false });
    expect(r.present).toBe(true);
    expect(Math.abs(r.rateHz! - 6.2)).toBeLessThan(0.2); // the longer, bigger episode
  });

  it('produces per-window live-meter estimates that track a vibrato starting partway through', () => {
    const note = sustained(60, 0, 3);
    const track = makeTrack({ duration: 3, midi: withVibrato(() => 60, 5.8, 45, 1.5) }); // straight for 1.5s, then vibrato
    const r = analyzeVibrato(track, note, ctx);
    expect(r.windows.length).toBeGreaterThan(5);
    const early = r.windows.filter((w) => w.end <= 1.5);
    const late = r.windows.filter((w) => w.start >= 1.5 && w.end - w.start >= 0.79);
    expect(early.some((w) => w.present)).toBe(false);
    expect(late.length).toBeGreaterThan(0);
    expect(late.every((w) => w.present)).toBe(true);
    for (const w of late) {
      expect(Math.abs(w.rateHz! - 5.8)).toBeLessThan(0.4);
      expect(Math.abs(w.extentCents! - 45)).toBeLessThan(8);
    }
    for (const w of early) expect(w.rateHz).toBeNull();
  });

  it('window times are ordered, cover the track and never exceed it', () => {
    const track = makeTrack({ duration: 3, midi: withVibrato(() => 60, 5.8, 45) });
    const r = analyzeVibrato(track, sustained(60, 0, 3), ctx);
    for (let i = 1; i < r.windows.length; i++) expect(r.windows[i].start).toBeGreaterThan(r.windows[i - 1].start);
    expect(r.windows[0].start).toBeCloseTo(track[0].t, 6);
    expect(r.windows[r.windows.length - 1].end).toBeLessThanOrEqual(track[track.length - 1].t + 1e-9);
  });

  it('{ windows: false } skips the window estimates but returns the same headline numbers', () => {
    const track = makeTrack({ duration: 2, midi: withVibrato(() => 60, 5.8, 45), jitterCents: 3, seed: 2 });
    const a = analyzeVibrato(track, null, ctx);
    const b = analyzeVibrato(track, null, ctx, { windows: false });
    expect(b.windows).toEqual([]);
    expect(b.rateHz).toBe(a.rateHz);
    expect(b.extentCents).toBe(a.extentCents);
  });

  it('a window over silence, or with too little voice in it, is never "present" and reads no rate or extent (a meter chip must not light up on a breath)', () => {
    // vibrato 0-1 s, 2.4 s of silence, vibrato 3.4-5 s
    const track = makeTrack({ duration: 5, midi: (t) => (t >= 1 && t < 3.4 ? NaN : 60 + 0.45 * Math.sin(2 * Math.PI * 5.8 * t)), jitterCents: 3, seed: 2 });
    const r = analyzeVibrato(track, null, ctx);
    const voicedIn = (w: { start: number; end: number }) => track.filter((f) => f.voiced && f.t >= w.start && f.t < w.end).length;

    const inSilence = r.windows.filter((w) => w.start >= 1.05 && w.end <= 3.35);
    expect(inSilence.length).toBeGreaterThanOrEqual(6);
    for (const w of inSilence) {
      expect(voicedIn(w)).toBe(0);
      expect(w.present, `window ${w.start.toFixed(2)}`).toBe(false);
      expect(w.rateHz).toBeNull();
      expect(w.extentCents).toBeNull();
    }
    // the same for every window that holds fewer voiced frames than an estimate needs, including the short ones that run off the end of the take
    const thin = r.windows.filter((w) => voicedIn(w) < 8);
    expect(thin.length).toBeGreaterThan(inSilence.length - 1);
    for (const w of thin) {
      expect(w.present).toBe(false);
      expect(w.rateHz).toBeNull();
      expect(w.extentCents).toBeNull();
    }
    // and the windows over the vibrato on either side are present, so the test is not vacuous
    expect(r.windows.some((w) => w.present && w.end <= 1.05)).toBe(true);
    expect(r.windows.some((w) => w.present && w.start >= 3.35)).toBe(true);
  });

  it('a live-meter-sized trailing window (0.8 s) is already enough to read a 5.8 Hz vibrato', () => {
    const track = makeTrack({ duration: 0.8, midi: withVibrato(() => 60, 5.8, 45), jitterCents: 4, seed: 3 });
    const r = analyzeVibrato(track, null, ctx, { windows: false });
    expect(r.present).toBe(true);
    expect(Math.abs(r.rateHz! - 5.8)).toBeLessThan(0.3);
    expect(Math.abs(r.extentCents! - 45)).toBeLessThan(7);
  });
});

describe('findVibratoEpisodes', () => {
  it('finds the onset and offset of a vibrato burst to within a lobe, not a detection window later', () => {
    // straight 0-1.5 s, vibrato 1.5-3.5 s, straight 3.5-5 s
    const track = makeTrack({ duration: 5, midi: (t) => 60 + (t >= 1.5 && t < 3.5 ? 0.45 * Math.sin(2 * Math.PI * 5.8 * (t - 1.5)) : 0), jitterCents: 4, seed: 2 });
    const eps = findVibratoEpisodes(track);
    expect(eps.length).toBe(1);
    expect(Math.abs(eps[0].startT - 1.5)).toBeLessThan(0.1);
    expect(Math.abs(eps[0].endT - 3.5)).toBeLessThan(0.15);
    expect(Math.abs(eps[0].rateHz - 5.8)).toBeLessThan(0.2);
    expect(Math.abs(eps[0].extentCents - 45)).toBeLessThan(6);
  });

  it('separates two bursts with a straight stretch between them, and merges across a one-lobe hiccup', () => {
    const two = makeTrack({
      duration: 7,
      midi: (t) => 60 + (t < 2 || (t >= 4 && t < 6) ? 0.45 * Math.sin(2 * Math.PI * 5.8 * t) : 0),
      jitterCents: 3,
      seed: 4,
    });
    expect(findVibratoEpisodes(two).length).toBe(2);
    // a 0.15 s dropout in the middle of one burst: still one episode
    const hiccup = makeTrack({ duration: 4, midi: (t) => 60 + 0.45 * Math.sin(2 * Math.PI * 5.8 * t), jitterCents: 3, seed: 4 }).map((f) =>
      f.t > 1.9 && f.t < 2.05 ? { ...f, voiced: false } : f,
    );
    expect(findVibratoEpisodes(hiccup).length).toBe(1);
  });

  it('finds none in a straight tone, even a noisy one', () => {
    expect(findVibratoEpisodes(makeTrack({ duration: 4, midi: () => 60, jitterCents: 6, seed: 5 })).length).toBe(0);
    expect(findVibratoEpisodes([]).length).toBe(0);
  });

  it('frame-rate independent: a 100 fps track gives the same episode', () => {
    const track = makeTrack({ duration: 3, midi: withVibrato(() => 60, 5.8, 45, 1), jitterCents: 3, seed: 1, frameRate: 100 });
    const eps = findVibratoEpisodes(track);
    expect(eps.length).toBe(1);
    expect(Math.abs(eps[0].startT - 1)).toBeLessThan(0.12);
    expect(FR).toBeGreaterThan(90);
  });
});
