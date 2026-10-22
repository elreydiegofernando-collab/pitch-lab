import { describe, expect, it } from 'vitest';
import type { TargetNote } from '../core/types';
import { analyzePulse } from './pulse';
import { makeTrack, sustained } from './fixtures';

const FR = 48000 / 512;

/** A pitch "bump" train: each pulse is a half-sine rise of `swing` semitones above the held note (a "ha-ha-ha"). */
const bumps = (rateHz: number, swing = 0.8) => (t: number) => 60 + swing * Math.max(0, Math.sin(2 * Math.PI * rateHz * t));

/** Notes of an alternation drill: `count` notes of `noteDur`, alternating between 60 and 60 + `semis`. */
function alternation(count: number, noteDur: number, semis: number): TargetNote[] {
  return Array.from({ length: count }, (_, i) => ({ midi: 60 + (i % 2) * semis, start: i * noteDur, end: (i + 1) * noteDur }));
}

describe('analyzePulse: rate and error', () => {
  it('measures a 4 Hz "ha-ha-ha" pulse rate to well under 0.1 Hz (not just frame-quantized)', () => {
    const note = sustained(60, 0, 2);
    const track = makeTrack({ duration: 2, midi: bumps(4) });
    const r = analyzePulse(track, note, 4);
    expect(r.measuredRateHz).not.toBeNull();
    expect(Math.abs(r.measuredRateHz! - 4)).toBeLessThan(0.05);
    expect(Math.abs(r.rateErrorHz!)).toBeLessThan(0.05);
    expect(r.pulseCount).toBeGreaterThanOrEqual(6);
  });

  it('reports a signed rateErrorHz vs the asked-for target', () => {
    const note = sustained(60, 0, 2);
    const fast = analyzePulse(makeTrack({ duration: 2, midi: bumps(5) }), note, 3.5); // sung faster than the 3.5 Hz target
    expect(fast.rateErrorHz!).toBeGreaterThan(1.4);
    expect(fast.rateErrorHz!).toBeLessThan(1.6);
    expect(fast.targetRateHz).toBe(3.5);
    const slow = analyzePulse(makeTrack({ duration: 3, midi: bumps(3) }), sustained(60, 0, 3), 4.5);
    expect(slow.rateErrorHz!).toBeLessThan(-1.4);
    expect(slow.rateErrorHz!).toBeGreaterThan(-1.6);
  });

  it('holds across the whole pulse-builder ladder (3.5, 4.5, 5.5 Hz) with 8 c RMS jitter, for bump and sinusoidal pulses', () => {
    for (const rate of [3.5, 4.5, 5.5]) {
      const note = sustained(60, 0, 3);
      const b = analyzePulse(makeTrack({ duration: 3, midi: bumps(rate, 0.5), jitterCents: 8, seed: 9 }), note, rate);
      expect(Math.abs(b.rateErrorHz!), `bump ${rate}`).toBeLessThan(0.05);
      const s = analyzePulse(makeTrack({ duration: 3, midi: (t) => 60 + 0.3 * Math.sin(2 * Math.PI * rate * t), jitterCents: 8, seed: 9 }), note, rate);
      expect(Math.abs(s.rateErrorHz!), `sine ${rate}`).toBeLessThan(0.05);
    }
  });

  it('is within the pulse-builder\'s pass gate (|error| <= 0.6 Hz) when the singer is a little off, and outside it when they are far off', () => {
    const note = sustained(60, 0, 3);
    const near = analyzePulse(makeTrack({ duration: 3, midi: bumps(4.3) }), note, 4.5); // 0.2 Hz slow
    expect(Math.abs(near.rateErrorHz!)).toBeLessThan(0.6);
    const far = analyzePulse(makeTrack({ duration: 3, midi: bumps(3.4) }), note, 4.5);
    expect(Math.abs(far.rateErrorHz!)).toBeGreaterThan(0.6);
  });
});

describe('analyzePulse: regularity', () => {
  it('a perfectly even pulse train scores high regularity; an uneven one scores much lower', () => {
    const note = sustained(60, 0, 3);
    const even = analyzePulse(makeTrack({ duration: 3, midi: bumps(4) }), note, 4);
    expect(even.regularity!).toBeGreaterThan(0.9);

    // irregularly-spaced pulse centres (gaps of 0.08-0.4 s, not a constant period)
    const centers = [0.1, 0.25, 0.65, 0.75, 1.15, 1.3, 1.7, 1.78, 2.2, 2.5];
    const halfWidth = 0.06;
    const uneven = makeTrack({
      duration: 3,
      midi: (t) => {
        let bump = 0;
        for (const c of centers) {
          const d = Math.abs(t - c);
          if (d < halfWidth) bump = Math.max(bump, 1 - d / halfWidth);
        }
        return 60 + 0.8 * bump;
      },
    });
    const rUneven = analyzePulse(uneven, note, 4);
    expect(rUneven.regularity).not.toBeNull();
    expect(rUneven.regularity!).toBeLessThan(0.4);
    expect(rUneven.regularity!).toBeLessThan(even.regularity!);
  });

  it('a human-grade wobble in timing (+/-6% jitter on each pulse) costs a little regularity, not all of it', () => {
    const note = sustained(60, 0, 4);
    const period = 1 / 4.5;
    // pulse k centred at k*period with a deterministic timing error of up to +/-6% of a period
    const centres = Array.from({ length: 24 }, (_, k) => k * period + period * 0.06 * Math.sin(k * 2.7));
    const track = makeTrack({
      duration: 4,
      midi: (t) => {
        let v = 0;
        for (const c of centres) v = Math.max(v, Math.max(0, 1 - Math.abs(t - c) / (period * 0.45)));
        return 60 + 0.5 * v;
      },
      jitterCents: 4,
      seed: 2,
    });
    const r = analyzePulse(track, note, 4.5);
    expect(r.regularity!).toBeGreaterThan(0.6);
    expect(r.regularity!).toBeLessThan(0.99);
  });

  it('regularity is null with fewer than three cycles to compare, and pulses are counted', () => {
    const note = sustained(60, 0, 0.6);
    const r = analyzePulse(makeTrack({ duration: 0.6, midi: bumps(4) }), note, 4);
    expect(r.pulseCount).toBeLessThan(3);
    expect(r.regularity).toBeNull();
  });
});

describe('analyzePulse: what is not a pulse', () => {
  it('too few pulses to measure returns nulls, not a throw', () => {
    const note = sustained(60, 0, 0.3);
    const track = makeTrack({ duration: 0.3, midi: () => 60 });
    const r = analyzePulse(track, note, 4);
    expect(r.measuredRateHz).toBeNull();
    expect(r.rateErrorHz).toBeNull();
    expect(r.swingCents).toBeNull();
  });

  it('a straight tone, even a noisy one, has no pulses', () => {
    for (const jitter of [0, 4, 8]) {
      const r = analyzePulse(makeTrack({ duration: 3, midi: () => 60, jitterCents: jitter, seed: 9 }), sustained(60, 0, 3), 4);
      expect(r.measuredRateHz, `jitter ${jitter}`).toBeNull();
      expect(r.rateErrorHz, `jitter ${jitter}`).toBeNull();
      expect(r.regularity, `jitter ${jitter}`).toBeNull();
    }
  });

  it('a pitch wobble smaller than the straight-tone threshold (+/-6 c) is not a pulse: pulses must actually move the pitch', () => {
    const r = analyzePulse(makeTrack({ duration: 3, midi: (t) => 60 + 0.06 * Math.sin(2 * Math.PI * 4 * t) }), sustained(60, 0, 3), 4);
    expect(r.measuredRateHz).toBeNull();
    const ok = analyzePulse(makeTrack({ duration: 3, midi: (t) => 60 + 0.14 * Math.sin(2 * Math.PI * 4 * t) }), sustained(60, 0, 3), 4);
    expect(ok.measuredRateHz).not.toBeNull();
  });

  it('reports the swing (full peak-to-trough) of the pulses', () => {
    const r = analyzePulse(makeTrack({ duration: 3, midi: (t) => 60 + 0.3 * Math.sin(2 * Math.PI * 4 * t) }), sustained(60, 0, 3), 4);
    expect(Math.abs(r.swingCents! - 60)).toBeLessThan(5);
  });

  it('an invalid target rate or no notes returns nulls', () => {
    const track = makeTrack({ duration: 2, midi: bumps(4) });
    expect(analyzePulse(track, sustained(60, 0, 2), 0).measuredRateHz).toBeNull();
    expect(analyzePulse(track, [], 4).measuredRateHz).toBeNull();
  });

  it('empty, all-unvoiced and one-frame tracks do not throw', () => {
    const note = sustained(60, 0, 2);
    expect(analyzePulse([], note, 4).measuredRateHz).toBeNull();
    expect(analyzePulse(makeTrack({ duration: 2, midi: () => NaN }), note, 4).measuredRateHz).toBeNull();
    expect(() => analyzePulse(makeTrack({ duration: 2, midi: bumps(4) }).slice(0, 1), note, 4)).not.toThrow();
  });
});

describe('analyzePulse: trains and drills', () => {
  it('a pulse train given as the realized notes (many short same-pitch notes) is analyzed over their whole span', () => {
    // 18 pulses at 4.5 Hz, each its own 0.222 s note: what realize() hands over for the pulse-builder levels
    const dur = 1 / 4.5;
    const notes = Array.from({ length: 18 }, (_, i) => ({ midi: 60, start: i * dur, end: (i + 1) * dur }));
    const track = makeTrack({ duration: 18 * dur, midi: bumps(4.5, 0.5), jitterCents: 5, seed: 3 });
    const r = analyzePulse(track, notes, 4.5);
    expect(Math.abs(r.rateErrorHz!)).toBeLessThan(0.05);
    expect(r.pulseCount).toBeGreaterThanOrEqual(15);
  });

  it('frames outside the notes\' span (the count-in, the next exercise) are ignored', () => {
    const track = makeTrack({ duration: 8, midi: (t) => (t >= 2 && t < 5 ? bumps(4)(t) : 60 + 0.5 * Math.max(0, Math.sin(2 * Math.PI * 7 * t))) });
    const r = analyzePulse(track, sustained(60, 2, 5), 4);
    expect(Math.abs(r.rateErrorHz!)).toBeLessThan(0.08);
  });

  it('measures the whole-tone oscillation drill (alternating notes, 8ths at 80 bpm = 1.333 cycles/s) exactly', () => {
    const noteDur = 0.375;
    const notes = alternation(16, noteDur, 2);
    const track = makeTrack({ duration: 16 * noteDur, midi: (t) => 60 + (Math.floor(t / noteDur) % 2) * 2, jitterCents: 5, seed: 9 });
    const target = 1 / (2 * noteDur);
    const r = analyzePulse(track, notes, target);
    expect(Math.abs(r.rateErrorHz!)).toBeLessThan(0.03);
    expect(r.regularity!).toBeGreaterThan(0.9);
    expect(Math.abs(r.swingCents! - 200)).toBeLessThan(30);
  });

  it('measures the semitone drill (16ths at 70 bpm = 2.333 cycles/s) exactly', () => {
    const noteDur = 0.2143;
    const notes = alternation(24, noteDur, 1);
    const track = makeTrack({ duration: 24 * noteDur, midi: (t) => 60 + (Math.floor(t / noteDur) % 2), jitterCents: 5, seed: 9 });
    const target = 1 / (2 * noteDur);
    const r = analyzePulse(track, notes, target);
    expect(Math.abs(r.rateErrorHz!)).toBeLessThan(0.03);
    expect(Math.abs(r.swingCents! - 100)).toBeLessThan(20);
  });

  it('an alternation sung at the wrong speed shows up as a rate error', () => {
    const noteDur = 0.3; // sung 0.375 s notes asked for; here 0.3 s
    const track = makeTrack({ duration: 4.8, midi: (t) => 60 + (Math.floor(t / noteDur) % 2) * 2 });
    const r = analyzePulse(track, alternation(13, 0.375, 2), 1 / (2 * 0.375));
    expect(r.rateErrorHz!).toBeGreaterThan(0.2);
  });

  it('a slow pitch drift under the pulses does not disturb the rate', () => {
    const r = analyzePulse(makeTrack({ duration: 3, midi: (t) => bumps(4.5, 0.5)(t) + (60 * t) / 100 / 3 }), sustained(60, 0, 3), 4.5);
    expect(Math.abs(r.rateErrorHz!)).toBeLessThan(0.06);
  });

  it('1-3 frame dropouts and sparse glitch spikes inside the train do not change the answer', () => {
    const base = makeTrack({ duration: 3, midi: bumps(4.5, 0.5), jitterCents: 4, seed: 6 });
    const messy = base.map((f, i) => (i % 41 < 2 ? { ...f, voiced: false } : i % 60 === 30 ? { ...f, midi: f.midi + 7 } : f));
    const r = analyzePulse(messy, sustained(60, 0, 3), 4.5);
    expect(Math.abs(r.rateErrorHz!)).toBeLessThan(0.08);
  });

  it('when the singer breaks the sound mid-train, the longest unbroken run is measured', () => {
    const track = makeTrack({ duration: 5, midi: (t) => (t >= 1.5 && t < 1.9 ? NaN : bumps(4)(t)) });
    const r = analyzePulse(track, sustained(60, 0, 5), 4);
    expect(Math.abs(r.rateErrorHz!)).toBeLessThan(0.08);
    expect(r.pulseCount).toBeGreaterThanOrEqual(8);
  });

  it('is deterministic and does not mutate the track', () => {
    const track = makeTrack({ duration: 2, midi: bumps(4), jitterCents: 4, seed: 4 });
    const copy = track.map((f) => ({ ...f }));
    expect(analyzePulse(track, sustained(60, 0, 2), 4)).toEqual(analyzePulse(track, sustained(60, 0, 2), 4));
    expect(track).toEqual(copy);
    expect(FR).toBeGreaterThan(90);
  });
});
