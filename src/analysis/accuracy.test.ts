import { describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import { analyzeAccuracy } from './accuracy';
import { makeTrack, notesMidi, sustained, withVibrato } from './fixtures';
import type { AnalyzeContext } from './types';

const ctx: AnalyzeContext = { toleranceCents: 25, vibratoStyle: 'pop' };
const FR = 48000 / 512;

describe('analyzeAccuracy', () => {
  it('a dead-centre sustain scores ~0 bias, ~0 sd, 100% in tolerance', () => {
    const note = sustained(60, 0, 2);
    const track = makeTrack({ duration: 2, midi: () => 60 });
    const r = analyzeAccuracy(track, note, ctx);
    expect(r.biasCents).toBeCloseTo(0, 3);
    expect(r.medianAbsCents).toBeCloseTo(0, 3);
    expect(r.sdCents).toBeCloseTo(0, 3);
    expect(r.inTolerancePct).toBe(100);
    expect(r.voicedSec).toBeGreaterThan(1.5);
  });

  it('recovers a known sharp bias within a cent, and a known flat one', () => {
    const note = sustained(60, 0, 2);
    const sharp = analyzeAccuracy(makeTrack({ duration: 2, midi: () => 60.3 }), note, ctx); // +30 cents
    expect(sharp.biasCents).toBeCloseTo(30, 0);
    expect(sharp.inTolerancePct).toBe(0); // outside +/-25c tolerance
    const flat = analyzeAccuracy(makeTrack({ duration: 2, midi: () => 59.8 }), note, ctx); // -20 cents
    expect(flat.biasCents).toBeCloseTo(-20, 0);
    expect(flat.inTolerancePct).toBe(100);
  });

  it('tolerance comes from the context, not a global: the same take passes at +/-50 and fails at +/-10', () => {
    const note = sustained(60, 0, 2);
    const track = makeTrack({ duration: 2, midi: () => 60.2 }); // +20 c
    expect(analyzeAccuracy(track, note, { ...ctx, toleranceCents: 50 }).inTolerancePct).toBe(100);
    expect(analyzeAccuracy(track, note, { ...ctx, toleranceCents: 10 }).inTolerancePct).toBe(0);
  });

  it('skips holdStartSkipMs of a scooped onset before measuring', () => {
    const note = sustained(60, 0, 2);
    // starts 80 cents flat, arrives at pitch by 100ms (inside the skip window) and stays dead on pitch after.
    const track = makeTrack({
      duration: 2,
      midi: (t) => (t < 0.1 ? 59.2 : 60),
    });
    const r = analyzeAccuracy(track, note, ctx);
    expect(r.inTolerancePct).toBe(100); // the flat approach is entirely inside holdStartSkipMs
  });

  it('measures a known linear drift (cents/sec) over the held portion', () => {
    const note = sustained(60, 0, 3);
    const driftCentsPerSec = 10;
    const track = makeTrack({ duration: 3, midi: (t) => 60 + (driftCentsPerSec * t) / 100 });
    const r = analyzeAccuracy(track, note, ctx);
    expect(r.driftCentsPerSec).not.toBeNull();
    expect(r.driftCentsPerSec!).toBeCloseTo(driftCentsPerSec, 0);
  });

  it('reports a sagging note as negative drift', () => {
    const note = sustained(60, 0, 4);
    const track = makeTrack({ duration: 4, midi: (t) => 60 - (8 * t) / 100 });
    expect(analyzeAccuracy(track, note, ctx).driftCentsPerSec!).toBeCloseTo(-8, 0);
  });

  it('driftCentsPerSec is null when the held portion is shorter than driftMinHoldSec', () => {
    const note = sustained(60, 0, CONFIG.accuracy.holdStartSkipMs / 1000 + 0.3);
    const track = makeTrack({ duration: note.end, midi: () => 60 });
    const r = analyzeAccuracy(track, note, ctx);
    expect(r.driftCentsPerSec).toBeNull();
  });

  it('a note that is never voiced returns zeros/NaNs, not a throw', () => {
    const note = sustained(60, 0, 1);
    const track = makeTrack({ duration: 1, midi: () => NaN });
    const r = analyzeAccuracy(track, note, ctx);
    expect(r.voicedSec).toBe(0);
    expect(r.inTolerancePct).toBe(0);
    expect(r.biasCents).toBeNaN();
    expect(r.coverage).toBe(0);
    expect(r.driftCentsPerSec).toBeNull();
  });

  it('empty and one-frame tracks do not throw', () => {
    const note = sustained(60, 0, 1);
    expect(() => analyzeAccuracy([], note, ctx)).not.toThrow();
    const one = makeTrack({ duration: 1, midi: () => 60 }).slice(0, 1);
    expect(() => analyzeAccuracy(one, note, ctx)).not.toThrow();
  });

  it('only frames inside the note window count: the next note\'s pitch does not leak in', () => {
    const notes = [sustained(60, 0, 2), sustained(67, 2, 4)];
    const track = makeTrack({ duration: 4, midi: notesMidi(notes) });
    expect(Math.abs(analyzeAccuracy(track, notes[0], ctx).biasCents)).toBeLessThan(0.1);
    expect(Math.abs(analyzeAccuracy(track, notes[1], ctx).biasCents)).toBeLessThan(0.1);
  });

  it('measures a glide against the moving target (toMidi), not against its start pitch', () => {
    const glide = { midi: 60, toMidi: 67, start: 0, end: 3 };
    const onIt = analyzeAccuracy(makeTrack({ duration: 3, midi: notesMidi([glide]) }), glide, ctx);
    expect(Math.abs(onIt.biasCents)).toBeLessThan(0.5);
    expect(onIt.inTolerancePct).toBe(100);
    // a singer who just holds the start pitch is wrong by up to 700 c against that same glide
    const holding = analyzeAccuracy(makeTrack({ duration: 3, midi: () => 60 }), glide, ctx);
    expect(holding.inTolerancePct).toBeLessThan(30);
  });

  it('standard deviation tracks frame jitter and a vibrato\'s own swing', () => {
    const note = sustained(60, 0, 4);
    const jittery = analyzeAccuracy(makeTrack({ duration: 4, midi: () => 60, jitterCents: 6, seed: 3 }), note, ctx);
    expect(jittery.sdCents).toBeGreaterThan(4.5);
    expect(jittery.sdCents).toBeLessThan(7.5);
    expect(Math.abs(jittery.biasCents)).toBeLessThan(1.5);
    // +/-40 c sinusoidal vibrato: sd = 40 / sqrt(2) = 28.3 c, still centred
    const vib = analyzeAccuracy(makeTrack({ duration: 4, midi: withVibrato(() => 60, 5.8, 40) }), note, ctx);
    expect(vib.sdCents).toBeGreaterThan(26);
    expect(vib.sdCents).toBeLessThan(30);
    expect(Math.abs(vib.biasCents)).toBeLessThan(3);
  });

  describe('detector glitches', () => {
    it('isolated octave/large spikes do not blow up sd, bias or tolerance', () => {
      const note = sustained(60, 0, 4);
      const clean = analyzeAccuracy(makeTrack({ duration: 4, midi: () => 60.05 }), note, ctx);
      const spiky = analyzeAccuracy(
        makeTrack({ duration: 4, midi: (t) => { const i = Math.round(t * FR); return i === 100 || i === 200 || i === 201 ? 72.05 : i === 250 ? 63.5 : 60.05; } }),
        note,
        ctx,
      );
      expect(spiky.sdCents).toBeLessThan(1);
      expect(spiky.sdCents).toBeCloseTo(clean.sdCents, 0);
      expect(spiky.inTolerancePct).toBe(100);
      expect(spiky.biasCents).toBeCloseTo(5, 0);
    });

    it('a one-frame dropout does not disturb the result', () => {
      const note = sustained(60, 0, 3);
      const tr = makeTrack({ duration: 3, midi: () => 60 }).map((f, i) => (i === 100 ? { ...f, voiced: false } : f));
      const r = analyzeAccuracy(tr, note, ctx);
      expect(r.inTolerancePct).toBe(100);
      expect(r.coverage).toBeGreaterThan(0.98);
    });
  });

  describe('coverage (sang it all, or sang a little perfectly)', () => {
    it('a full-length hold has coverage ~1', () => {
      const note = sustained(60, 0, 4);
      const r = analyzeAccuracy(makeTrack({ duration: 4, midi: () => 60 }), note, ctx);
      expect(r.coverage).toBeGreaterThan(0.97);
      expect(r.heldWindowSec).toBeGreaterThan(3.7);
    });

    it('stopping after one second of a four-second note gives low coverage even though every sung frame is in tune', () => {
      const note = sustained(60, 0, 4);
      const r = analyzeAccuracy(makeTrack({ duration: 4, midi: (t) => (t < 1 ? 60 : NaN) }), note, ctx);
      expect(r.inTolerancePct).toBe(100); // analyzer contract: % of the held VOICED time
      expect(r.coverage).toBeGreaterThan(0.2);
      expect(r.coverage).toBeLessThan(0.3);
    });

    it('a start within the 0.6 s allowance does not reduce coverage (a reaction time to the cue, not a fault)', () => {
      const note = sustained(60, 0, 4);
      for (const lateStart of [0.2, 0.5, 0.6]) {
        const r = analyzeAccuracy(makeTrack({ duration: 4, midi: (t) => (t >= lateStart ? 60 : NaN) }), note, ctx);
        expect(r.coverage, `${lateStart} s late`).toBeGreaterThan(0.97);
      }
    });

    it('a start later than the allowance costs the part beyond it: 1.5 s into a 4 s note is about (4 - 1.5 - 0.15) / (4 - 0.6 - 0.15)', () => {
      const note = sustained(60, 0, 4);
      const r = analyzeAccuracy(makeTrack({ duration: 4, midi: (t) => (t >= 1.5 ? 60 : NaN) }), note, ctx);
      expect(r.inTolerancePct).toBe(100); // every sung frame is on pitch ...
      expect(r.coverage).toBeGreaterThan(0.68); // ... but a quarter of what was asked is missing
      expect(r.coverage).toBeLessThan(0.76);
      expect(r.heldWindowSec).toBeCloseTo(4 - 0.6 - CONFIG.accuracy.holdStartSkipMs / 1000, 5); // the window starts at the allowance, not at the late onset
    });

    it('singing only the end of a long hold, perfectly in tune, is not full coverage: the last second of 4 s, the last 1.5 s of 6 s', () => {
      const four = analyzeAccuracy(makeTrack({ duration: 4, midi: (t) => (t >= 3 ? 60 : NaN) }), sustained(60, 0, 4), ctx);
      expect(four.inTolerancePct).toBe(100);
      expect(four.coverage).toBeLessThan(0.35);
      const six = analyzeAccuracy(makeTrack({ duration: 6, midi: (t) => (t >= 4.5 ? 60 : NaN) }), sustained(60, 0, 6), ctx);
      expect(six.inTolerancePct).toBe(100);
      expect(six.coverage).toBeLessThan(0.35);
      expect(six.coverage).toBeGreaterThan(0.15);
      const lastSecondOfSix = analyzeAccuracy(makeTrack({ duration: 6, midi: (t) => (t >= 5 ? 60 : NaN) }), sustained(60, 0, 6), ctx);
      expect(lastSecondOfSix.coverage).toBeLessThan(0.25);
      const twoSecondsLate = analyzeAccuracy(makeTrack({ duration: 4, midi: (t) => (t >= 2 ? 60 : NaN) }), sustained(60, 0, 4), ctx);
      expect(twoSecondsLate.coverage).toBeGreaterThan(0.5); // half the note was sung, a little less than half of what was asked after the allowance
      expect(twoSecondsLate.coverage).toBeLessThan(0.62);
    });

    it('coverage never rises as the start gets later, falls steadily past the allowance, and is never negative or above 1', () => {
      const note = sustained(60, 0, 4);
      let previous = Infinity;
      for (let lateStart = 0; lateStart <= 3.8; lateStart += 0.2) {
        const r = analyzeAccuracy(makeTrack({ duration: 4, midi: (t) => (t >= lateStart ? 60 : NaN) }), note, ctx);
        expect(r.coverage).toBeLessThanOrEqual(previous + 1e-9);
        expect(r.coverage).toBeGreaterThanOrEqual(0);
        expect(r.coverage).toBeLessThanOrEqual(1);
        previous = r.coverage;
      }
      expect(previous).toBeLessThan(0.1);
    });

    it('a short note is not penalised for starting late inside it: the allowance never reaches past the end of the note', () => {
      const note = sustained(60, 0, 0.5);
      const r = analyzeAccuracy(makeTrack({ duration: 0.5, midi: (t) => (t >= 0.1 ? 60 : NaN) }), note, ctx);
      expect(r.coverage).toBeGreaterThan(0.9);
      expect(r.coverage).toBeLessThanOrEqual(1);
    });

    it('a mid-note break costs coverage in proportion', () => {
      const note = sustained(60, 0, 4);
      const r = analyzeAccuracy(makeTrack({ duration: 4, midi: (t) => (t >= 1.5 && t < 2.5 ? NaN : 60) }), note, ctx);
      expect(r.coverage).toBeGreaterThan(0.68);
      expect(r.coverage).toBeLessThan(0.78);
    });
  });
});

/**
 * SPEC 8.1 names three tolerance tiers: "Default +/-25 c, easy +/-50 c, studio +/-10 c". The tier is set by the
 * LEVEL (CONFIG.tolerance[def.tolerance]) and the analyzers take it from the context. These numbers are the
 * owner's, so they are pinned here as literals: if tuning ever moves one, change it here on purpose.
 */
describe('SPEC 8.1 tolerance tiers', () => {
  it('are +/-50 c (easy), +/-25 c (default) and +/-10 c (studio)', () => {
    expect(CONFIG.tolerance).toEqual({ easy: 50, default: 25, studio: 10 });
  });

  it('a take just inside a tier is in tolerance and a take just outside it is not, at that tier', () => {
    const note = sustained(60, 0, 2);
    const cases = [
      { tier: 'easy' as const, inside: 48, outside: 52 },
      { tier: 'default' as const, inside: 24, outside: 26 },
      { tier: 'studio' as const, inside: 9, outside: 11 },
    ];
    for (const { tier, inside, outside } of cases) {
      const toleranceCents = CONFIG.tolerance[tier];
      const sharp = (cents: number) => makeTrack({ duration: 2, midi: () => 60 + cents / 100 });
      expect(analyzeAccuracy(sharp(inside), note, { ...ctx, toleranceCents }).inTolerancePct, `${tier} at +${inside} c`).toBe(100);
      expect(analyzeAccuracy(sharp(outside), note, { ...ctx, toleranceCents }).inTolerancePct, `${tier} at +${outside} c`).toBe(0);
      expect(analyzeAccuracy(sharp(-inside), note, { ...ctx, toleranceCents }).inTolerancePct, `${tier} at -${inside} c`).toBe(100);
      expect(analyzeAccuracy(sharp(-outside), note, { ...ctx, toleranceCents }).inTolerancePct, `${tier} at -${outside} c`).toBe(0);
    }
  });
});
