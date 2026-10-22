import { describe, expect, it } from 'vitest';
import { makeTrack, withVibrato } from '../../analysis/fixtures';
import { MIN_VOICED_FRAMES, nearestNote, readOnset, readVibrato, sameOnset, sameVibrato, voicedCount, type OnsetReading, type VibratoReading } from './live-readings';

const CTX = { toleranceCents: 25, vibratoStyle: 'pop' as const };

describe('readVibrato', () => {
  it('measures rate, extent and centring of a vibrato in the zone', () => {
    const w = makeTrack({ duration: 2.5, t0: 10, midi: withVibrato(() => 60, 5.8, 40, 10), jitterCents: 2, seed: 4 });
    const r = readVibrato(w, CTX);
    expect(r).not.toBeNull();
    expect(r!.present).toBe(true);
    expect(r!.rateHz!).toBeGreaterThan(5.4);
    expect(r!.rateHz!).toBeLessThan(6.2);
    expect(r!.extentCents!).toBeGreaterThan(30);
    expect(r!.extentCents!).toBeLessThan(50);
    expect(Math.abs(r!.centeringCents!)).toBeLessThan(10);
    expect(r!.inZone).toBe(true);
    expect(r!.flags).not.toContain('straight');
  });

  it('calls a steady tone straight (a neutral flag), and still says how far it sits from the note', () => {
    const w = makeTrack({ duration: 2.5, t0: 0, midi: () => 60.3, jitterCents: 2, seed: 4 });
    const r = readVibrato(w, CTX)!;
    expect(r.present).toBe(false);
    expect(r.rateHz).toBeNull();
    expect(r.flags).toContain('straight');
    expect(r.inZone).toBe(false);
    expect(r.centeringCents!).toBeGreaterThan(20);
    expect(r.centeringCents!).toBeLessThan(40);
  });

  it('flags a slow, wide wobble and a fast bleat', () => {
    const wobble = readVibrato(makeTrack({ duration: 2.5, t0: 0, midi: withVibrato(() => 60, 3.6, 140), seed: 2 }), CTX)!;
    expect(wobble.flags).toContain('wobble');
    const bleat = readVibrato(makeTrack({ duration: 2.5, t0: 0, midi: withVibrato(() => 60, 9, 40), seed: 2 }), CTX)!;
    expect(bleat.flags).toContain('bleat');
  });

  it('follows the style: classical wants a wider extent than pop', () => {
    const w = makeTrack({ duration: 2.5, t0: 0, midi: withVibrato(() => 60, 5.8, 30), seed: 3 });
    expect(readVibrato(w, { ...CTX, vibratoStyle: 'pop' })!.inZone).toBe(true);
    expect(readVibrato(w, { ...CTX, vibratoStyle: 'classical' })!.inZone).toBe(false);
  });

  it('says nothing for a window with too little singing', () => {
    expect(readVibrato([], CTX)).toBeNull();
    const short = makeTrack({ duration: (MIN_VOICED_FRAMES - 5) / 93.75, t0: 0, midi: () => 60 });
    expect(voicedCount(short)).toBeLessThan(MIN_VOICED_FRAMES);
    expect(readVibrato(short, CTX)).toBeNull();
  });
});

describe('nearestNote', () => {
  it('rounds the middle of what was sung in the slice', () => {
    const w = makeTrack({ duration: 2, t0: 0, midi: () => 60.4 });
    expect(nearestNote(w, 0, 2)).toBe(60);
    expect(nearestNote(makeTrack({ duration: 2, t0: 0, midi: () => 60.6 }), 0, 2)).toBe(61);
  });

  it('needs a few voiced frames', () => {
    expect(nearestNote(makeTrack({ duration: 0.05, t0: 0, midi: () => 60 }), 0, 1)).toBeNull();
    expect(nearestNote([], 0, 1)).toBeNull();
  });
});

describe('readOnset', () => {
  /** Silence, then a note that scoops up into 60 from `scoop` cents below. */
  const scooped = (scoop: number, tauSec = 0.08) =>
    makeTrack({ duration: 2.2, t0: 0, midi: (t) => (t < 0.5 ? NaN : 60 - (scoop / 100) * Math.exp(-(t - 0.5) / tauSec)), jitterCents: 1, seed: 8 });

  it('is still settling while the note is young', () => {
    const young = scooped(60).filter((f) => f.t < 1.0);
    const r = readOnset(young, 0.5, null, CTX, false)!;
    expect(r.state).toBe('settling');
    expect(r.settleMs).toBeNull();
  });

  it('reads the settle time and the scoop once the note has landed', () => {
    const r = readOnset(scooped(60), 0.5, null, CTX, false)!;
    expect(r.state).toBe('settled');
    expect(r.scoopCents).toBeGreaterThan(30);
    expect(r.settleMs).not.toBeNull();
    expect(r.settleMs!).toBeGreaterThan(50);
    expect(r.settleMs!).toBeLessThan(500);
    expect(r.onsetT).toBeCloseTo(0.5, 1);
  });

  it('reads a clean attack as no scoop', () => {
    const r = readOnset(scooped(0), 0.5, null, CTX, false)!;
    expect(r.state).toBe('settled');
    expect(r.scoopCents).toBeLessThan(10);
  });

  it('judges against the note the singer picked, when they did', () => {
    // Sung on 60 but aiming at 61: it never lands in the band.
    const r = readOnset(scooped(0), 0.5, 61, CTX, false)!;
    expect(r.state).toBe('settled');
    expect(r.settleMs).toBeNull();
  });

  it('reads a note that ended early, and gives up on one too short to read', () => {
    const half = scooped(20).filter((f) => f.t < 1.1);
    expect(readOnset(half, 0.5, null, CTX, true)?.state).toBe('settled');
    const blip = scooped(0).filter((f) => f.t < 0.6);
    expect(readOnset(blip, 0.5, null, CTX, true)).toBeNull();
  });
});

describe('same readings', () => {
  const v = (over: Partial<VibratoReading> = {}): VibratoReading => ({
    present: true, rateHz: 5.8, extentCents: 38, centeringCents: 3, inZone: true, flags: [], ...over,
  });
  const o = (over: Partial<OnsetReading> = {}): OnsetReading => ({ state: 'settled', settleMs: 120, scoopCents: 12, onsetT: 1, ...over });

  it('treats changes below the shown precision as the same', () => {
    expect(sameVibrato(v(), v({ rateHz: 5.83, extentCents: 38.4 }))).toBe(true);
    expect(sameVibrato(v(), v({ rateHz: 5.9 }))).toBe(false);
    expect(sameVibrato(v(), v({ flags: ['wobble'] }))).toBe(false);
    expect(sameVibrato(null, null)).toBe(true);
    expect(sameVibrato(v(), null)).toBe(false);
    expect(sameOnset(o(), o({ scoopCents: 12.3 }))).toBe(true);
    expect(sameOnset(o(), o({ settleMs: 140 }))).toBe(false);
    expect(sameOnset(null, o())).toBe(false);
  });
});
