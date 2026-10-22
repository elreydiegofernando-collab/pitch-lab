import { describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import { analyzeOnset } from './onset';
import { makeTrack, sustained, withVibrato } from './fixtures';
import type { AnalyzeContext } from './types';

const ctx: AnalyzeContext = { toleranceCents: 25, vibratoStyle: 'pop' };
const FRAME_MS = 1000 / (48000 / 512);
const FR = 48000 / 512;

function frameMs(frames = 1): number {
  return frames * FRAME_MS;
}

/**
 * An RMS envelope that's linear in AMPLITUDE (not dB) from `floorDb` to
 * `steadyDb` over `rampSec` starting at `onsetAt`, so its 10%-90% rise time
 * is exactly `0.8 * rampSec` -- lets a test assert riseMs against a known
 * value instead of reverse-engineering a dB ramp's amplitude-domain timing.
 */
function linearAmpRamp(onsetAt: number, rampSec: number, floorDb = -80, steadyDb = -20) {
  const floorLin = Math.pow(10, floorDb / 20);
  const steadyLin = Math.pow(10, steadyDb / 20);
  return (t: number) => {
    if (t < onsetAt) return floorDb;
    const u = Math.min(1, (t - onsetAt) / rampSec);
    const amp = floorLin + (steadyLin - floorLin) * u;
    return 20 * Math.log10(amp);
  };
}

describe('analyzeOnset from silence', () => {
  it('a dead-on onset with a balanced (moderate) rise settles immediately with no scoop/overshoot and is crisp', () => {
    const note = sustained(60, 0.5, 2);
    // 0.8 * 125ms = 100ms rise: between hardMaxRiseMs (60) and breathyMinRiseMs (160) -> 'balanced'.
    const track = makeTrack({ duration: 2, midi: (t) => (t < 0.5 ? NaN : 60), rmsDb: linearAmpRamp(0.5, 0.125) });
    const r = analyzeOnset(track, note, ctx);
    expect(r.onsetT).toBeCloseTo(0.5, 1);
    expect(r.settleMs).not.toBeNull();
    expect(r.settleMs!).toBeLessThan(30);
    expect(r.scoopCents).toBe(0);
    expect(r.overshootCents).toBe(0);
    expect(r.riseMs).not.toBeNull();
    // the reported rise is deconvolved from the tracker's ~34 ms window blur, so a fixture's exact 100 ms reads a few ms under
    expect(Math.abs(r.riseMs! - 100)).toBeLessThanOrEqual(frameMs(2) + 1);
    expect(r.onsetType).toBe('balanced');
    expect(r.crisp).toBe(true);
  });

  it('classifies a hard onset from a near-instant RMS rise; the onset type is reported either way', () => {
    const note = sustained(60, 0.5, 2);
    const track = makeTrack({ duration: 2, midi: (t) => (t < 0.5 ? NaN : 60), rmsDb: linearAmpRamp(0.5, 0.01) }); // 8ms rise
    const r = analyzeOnset(track, note, ctx);
    expect(r.onsetType).toBe('hard');
    expect(r.riseMs!).toBeLessThan(CONFIG.onset.hardMaxRiseMs);
  });

  it('crisp: a hard onset is crisp by default (only a breathy one vetoes) and is NOT with the literal spec reading requireBalancedOnset', () => {
    const note = sustained(60, 0.5, 2);
    const track = makeTrack({ duration: 2, midi: (t) => (t < 0.5 ? NaN : 60), rmsDb: linearAmpRamp(0.5, 0.01) });
    expect(analyzeOnset(track, note, ctx).crisp).toBe(true);
    expect(analyzeOnset(track, note, ctx, { requireBalancedOnset: true }).crisp).toBe(false);
    // a balanced onset is crisp both ways
    const balanced = makeTrack({ duration: 2, midi: (t) => (t < 0.5 ? NaN : 60), rmsDb: linearAmpRamp(0.5, 0.125) });
    expect(analyzeOnset(balanced, note, ctx, { requireBalancedOnset: true }).crisp).toBe(true);
  });

  it('settle time is known to within one frame for a fixed-delay arrival', () => {
    const note = sustained(60, 0.5, 2);
    const arriveAt = 0.5 + 0.2; // arrives on pitch 200ms after onset, then holds
    const track = makeTrack({
      duration: 2,
      midi: (t) => (t < 0.5 ? NaN : t < arriveAt ? 59.3 : 60), // flat, then on pitch
    });
    const r = analyzeOnset(track, note, ctx);
    expect(r.settleMs).not.toBeNull();
    expect(Math.abs(r.settleMs! - 200)).toBeLessThanOrEqual(FRAME_MS + 1);
  });

  it('a slow settle (400 ms) is not crisp at the default tier, and a pitch that never settles reports settleMs null', () => {
    const note = sustained(60, 0.5, 2);
    const slow = makeTrack({ duration: 2, midi: (t) => (t < 0.5 ? NaN : t < 0.9 ? 59.3 : 60), rmsDb: linearAmpRamp(0.5, 0.125) });
    const rs = analyzeOnset(slow, note, ctx);
    expect(rs.settleMs!).toBeGreaterThan(CONFIG.onset.settleTargetMs.default);
    expect(rs.crisp).toBe(false);
    const never = makeTrack({ duration: 2, midi: (t) => (t < 0.5 ? NaN : 60.5), rmsDb: linearAmpRamp(0.5, 0.125) }); // +50 c forever
    const rn = analyzeOnset(never, note, ctx);
    expect(rn.settleMs).toBeNull();
    expect(rn.crisp).toBe(false);
  });

  it('measures a known scoop size in the first scoopWindowMs', () => {
    const note = sustained(60, 0.5, 2);
    const scoopCents = 40;
    const track = makeTrack({
      duration: 2,
      midi: (t) => {
        if (t < 0.5) return NaN;
        const dt = t - 0.5;
        if (dt < 0.05) return 60 - scoopCents / 100; // dip below target first
        return 60; // then arrive and hold
      },
    });
    const r = analyzeOnset(track, note, ctx);
    expect(r.scoopCents).toBeGreaterThanOrEqual(scoopCents - 2);
    expect(r.scoopCents).toBeLessThanOrEqual(scoopCents + 5);
    expect(r.crisp).toBe(false); // > crispMaxScoopCents
  });

  it('a scoop shallower than crispMaxScoopCents does not stop a landing being crisp', () => {
    const note = sustained(60, 0.5, 2);
    const track = makeTrack({ duration: 2, midi: (t) => (t < 0.5 ? NaN : t < 0.55 ? 59.8 : 60), rmsDb: linearAmpRamp(0.5, 0.125) });
    const r = analyzeOnset(track, note, ctx);
    expect(r.scoopCents).toBeGreaterThan(15);
    expect(r.scoopCents).toBeLessThan(CONFIG.onset.crispMaxScoopCents);
    expect(r.crisp).toBe(true);
  });

  it('measures overshoot past the target before settling, in the approach direction', () => {
    const note = sustained(60, 0.5, 2);
    const overshootCents = 35;
    const track = makeTrack({
      duration: 2,
      midi: (t) => {
        if (t < 0.5) return NaN;
        const dt = t - 0.5;
        if (dt < 0.03) return 59.3; // starts flat
        if (dt < 0.06) return 60 + overshootCents / 100; // swings sharp past target
        return 60; // settles
      },
    });
    const r = analyzeOnset(track, note, ctx);
    expect(r.overshootCents).toBeGreaterThanOrEqual(overshootCents - 2);
    expect(r.overshootCents).toBeLessThanOrEqual(overshootCents + 5);
    expect(r.crisp).toBe(false);
  });

  it('overshoot works the other way too: starting sharp and swinging flat', () => {
    const note = sustained(60, 0.5, 2);
    const track = makeTrack({ duration: 2, midi: (t) => (t < 0.5 ? NaN : t < 0.53 ? 60.7 : t < 0.6 ? 59.65 : 60) });
    const r = analyzeOnset(track, note, ctx);
    expect(r.overshootCents).toBeGreaterThan(30);
    expect(r.scoopCents).toBeGreaterThan(30); // landing flat also dips below the target, which is the scoop's definition
  });

  it('classifies a breathy onset from a slow RMS rise, known to a few ms', () => {
    const note = sustained(60, 0.5, 2);
    const track = makeTrack({ duration: 2, midi: (t) => (t < 0.5 ? NaN : 60), rmsDb: linearAmpRamp(0.5, 0.3) }); // 240ms rise
    const r = analyzeOnset(track, note, ctx);
    expect(r.riseMs).not.toBeNull();
    expect(Math.abs(r.riseMs! - 240)).toBeLessThanOrEqual(frameMs(2) + 1);
    expect(r.riseMs!).toBeGreaterThan(CONFIG.onset.breathyMinRiseMs);
    expect(r.onsetType).toBe('breathy');
    expect(r.crisp).toBe(false);
  });

  it('a note that is never voiced returns a null-onset result', () => {
    const note = sustained(60, 0, 1);
    const track = makeTrack({ duration: 1, midi: () => NaN });
    const r = analyzeOnset(track, note, ctx);
    expect(r.onsetT).toBeNull();
    expect(r.settleMs).toBeNull();
    expect(r.onsetType).toBe('unknown');
    expect(r.crisp).toBe(false);
  });

  it('empty and one-frame tracks do not throw', () => {
    const note = sustained(60, 0, 1);
    expect(analyzeOnset([], note, ctx).onsetT).toBeNull();
    expect(() => analyzeOnset(makeTrack({ duration: 1, midi: () => 60 }).slice(0, 1), note, ctx)).not.toThrow();
  });

  it('tolerance comes from the level: a 200 ms settle is crisp at +/-25 c but the studio tier (+/-10 c, 150 ms target) is stricter', () => {
    const note = sustained(60, 0.5, 2);
    // flat by 30 c until 0.7 s: out of the +/-10 c studio band for 200 ms, but inside +/-25... no: 30 > 25 too. Use 15 c flat: inside +/-25, outside +/-10.
    const track = makeTrack({ duration: 2, midi: (t) => (t < 0.5 ? NaN : t < 0.7 ? 59.85 : 60), rmsDb: linearAmpRamp(0.5, 0.125) });
    const wide = analyzeOnset(track, note, { toleranceCents: 25, vibratoStyle: 'pop' });
    const studio = analyzeOnset(track, note, { toleranceCents: 10, vibratoStyle: 'pop' });
    expect(wide.settleMs!).toBeLessThan(30);
    expect(wide.crisp).toBe(true);
    expect(studio.settleMs!).toBeGreaterThan(150);
    expect(studio.crisp).toBe(false);
  });

  it('a lateness is not an onset fault: singing 300 ms after the cue still measures onset from when the voice came in', () => {
    const note = sustained(60, 0.5, 2);
    const track = makeTrack({ duration: 2, midi: (t) => (t < 0.8 ? NaN : 60), rmsDb: linearAmpRamp(0.8, 0.125) });
    const r = analyzeOnset(track, note, ctx);
    expect(r.onsetT).toBeCloseTo(0.8, 1);
    expect(r.settleMs!).toBeLessThan(30);
    expect(r.crisp).toBe(true);
  });

  it('a singer who comes in a little EARLY (80 ms before the cue) is measured from their own onset', () => {
    const note = sustained(60, 0.5, 2);
    const track = makeTrack({ duration: 2, midi: (t) => (t < 0.42 ? NaN : 60), rmsDb: linearAmpRamp(0.42, 0.125) });
    const r = analyzeOnset(track, note, ctx);
    expect(r.onsetT).toBeCloseTo(0.42, 1);
    expect(r.settleMs!).toBeLessThan(30);
  });

  it('the previous note\'s tail inside the lookback is not mistaken for this note\'s onset', () => {
    // previous note 57 sung until 0.85 s, a 0.15 s gap, then the target note at 60 from 1.0 s
    const track = makeTrack({ duration: 2, midi: (t) => (t < 0.2 ? NaN : t < 0.85 ? 57 : t < 1.0 ? NaN : 60), rmsDb: (t) => (t >= 1.0 ? linearAmpRamp(1.0, 0.1)(t) : -20) });
    const r = analyzeOnset(track, sustained(60, 1.0, 1.8), ctx);
    expect(r.onsetT).toBeCloseTo(1.0, 1);
    expect(r.scoopCents).toBe(0); // 57 -> 60 is NOT a scoop: the previous note is another note
    expect(r.settleMs!).toBeLessThan(30);
  });

  it('an octave glitch on the very first voiced frame does not become a huge scoop', () => {
    const note = sustained(60, 0.5, 2);
    const track = makeTrack({ duration: 2, midi: (t) => (t < 0.5 ? NaN : Math.abs(t - 0.5) < 0.005 ? 48 : 60) });
    const r = analyzeOnset(track, note, ctx);
    expect(r.scoopCents).toBeLessThan(5);
    expect(r.settleMs!).toBeLessThan(30);
  });

  it('a multi-frame octave error at the onset (a detector fault, not singing) is not a 1200 c scoop or a huge overshoot', () => {
    const note = sustained(60, 0.5, 2);
    const onsetFrame = Math.round(0.5 * FR);
    for (const wrongOctave of [48, 72]) {
      const track = makeTrack({ duration: 2, midi: (t) => { const i = Math.round(t * FR); return i < onsetFrame ? NaN : i < onsetFrame + 4 ? wrongOctave : 60; } });
      const r = analyzeOnset(track, note, ctx);
      expect(r.scoopCents, `octave ${wrongOctave}`).toBeLessThan(5);
      expect(r.overshootCents, `octave ${wrongOctave}`).toBeLessThan(5);
      // the bad frames still delay the settle, honestly, by about their own length
      expect(r.settleMs!, `octave ${wrongOctave}`).toBeGreaterThan(30);
      expect(r.settleMs!, `octave ${wrongOctave}`).toBeLessThan(80);
    }
  });

  it('a real slide-in from a fifth below (650 c, over 300 ms) still counts as the scoop it is', () => {
    const note = sustained(60, 0.5, 2);
    const track = makeTrack({ duration: 2, midi: (t) => (t < 0.5 ? NaN : 60 - 6.5 * Math.max(0, 1 - (t - 0.5) / 0.3)) });
    expect(analyzeOnset(track, note, ctx).scoopCents).toBeGreaterThan(300);
  });

  it('a slide so fast (>5000 c/s) that it is a leap in flight is not scored as a scoop', () => {
    const note = sustained(60, 0.5, 2);
    const track = makeTrack({ duration: 2, midi: (t) => (t < 0.5 ? NaN : 60 - 6.5 * Math.max(0, 1 - (t - 0.5) / 0.1)) });
    expect(analyzeOnset(track, note, ctx).scoopCents).toBeLessThan(30);
  });

  it('a one-frame detector dropout inside the 100 ms settle hold does not restart the hold', () => {
    const note = sustained(60, 0.5, 2);
    const base = makeTrack({ duration: 2, midi: (t) => (t < 0.5 ? NaN : t < 0.6 ? 59.4 : 60) });
    const dropped = base.map((f) => (Math.abs(f.t - 0.66) < 0.006 ? { ...f, voiced: false } : f));
    const a = analyzeOnset(base, note, ctx);
    const b = analyzeOnset(dropped, note, ctx);
    expect(b.settleMs).not.toBeNull();
    expect(Math.abs(b.settleMs! - a.settleMs!)).toBeLessThan(FRAME_MS * 1.5);
  });

  it('works on the short notes of a staccato exercise (a 0.375 s note)', () => {
    const note = sustained(60, 1.0, 1.375);
    const track = makeTrack({ duration: 2, midi: (t) => (t >= 1.0 && t < 1.3 ? 60 : NaN), rmsDb: linearAmpRamp(1.0, 0.1) });
    const r = analyzeOnset(track, note, ctx);
    expect(r.onsetT).toBeCloseTo(1.0, 1);
    expect(r.settleMs!).toBeLessThan(30);
    expect(r.crisp).toBe(true);
  });
});

describe('analyzeOnset: landing a leap with no silence before it (legato)', () => {
  /** previous note `from` until `leapAt`, then a move to `to` taking `moveSec`; the target note starts at `cue`. */
  function leap(from: number, to: number, leapAt: number, moveSec: number, extra: (t: number) => number = () => 0) {
    return makeTrack({
      duration: 3,
      midi: (t) => {
        if (t < 0.2) return NaN;
        if (t < leapAt) return from + extra(t);
        const u = Math.min(1, (t - leapAt) / Math.max(1e-9, moveSec));
        return from + (to - from) * u + extra(t);
      },
    });
  }

  it('a clean jump up a major third lands with ~0 settle, no scoop and no overshoot', () => {
    const r = analyzeOnset(leap(56, 60, 1.0, 0.0), { midi: 60, start: 1.0, end: 2.4 }, ctx);
    expect(r.onsetT).not.toBeNull();
    expect(r.onsetT!).toBeGreaterThan(0.95);
    expect(r.onsetT!).toBeLessThan(1.05);
    expect(r.settleMs!).toBeLessThan(30);
    expect(r.scoopCents).toBe(0);
    expect(r.overshootCents).toBe(0);
    expect(r.crisp).toBe(true);
  });

  it('waiting at the old pitch before leaping late is not a scoop: onset is when the voice leaves the old note', () => {
    const r = analyzeOnset(leap(56, 60, 1.25, 0.0), { midi: 60, start: 1.0, end: 2.4 }, ctx);
    expect(r.onsetT!).toBeGreaterThan(1.2);
    expect(r.onsetT!).toBeLessThan(1.3);
    expect(r.scoopCents).toBe(0);
    expect(r.settleMs!).toBeLessThan(30);
  });

  it('a leap that slides in over 120 ms IS a scoop, and reports its depth', () => {
    const r = analyzeOnset(leap(56, 60, 1.0, 0.12), { midi: 60, start: 1.0, end: 2.4 }, ctx);
    expect(r.scoopCents).toBeGreaterThan(250);
    expect(r.settleMs!).toBeGreaterThan(80);
    expect(r.crisp).toBe(false);
  });

  it('the frames a fast leap spends in flight (a few frames mid-jump) are not a scoop or an overshoot', () => {
    // 400 c in ~3 frames: ~130 c/frame, far above the in-flight speed. The intermediate frames must not count.
    const track = makeTrack({
      duration: 3,
      midi: (t) => {
        const i = Math.round(t * FR);
        if (t < 0.2) return NaN;
        const jumpFrame = Math.round(1.0 * FR);
        if (i < jumpFrame) return 56;
        if (i === jumpFrame) return 57.3;
        if (i === jumpFrame + 1) return 58.7;
        if (i === jumpFrame + 2) return 59.4;
        return 60;
      },
    });
    const r = analyzeOnset(track, { midi: 60, start: 1.0, end: 2.4 }, ctx);
    expect(r.scoopCents).toBeLessThan(CONFIG.onset.crispMaxScoopCents);
    expect(r.overshootCents).toBeLessThan(CONFIG.onset.crispMaxOvershootCents);
  });

  it('leaping down and landing flat-then-correcting is an overshoot, and a clean downward jump is not a scoop', () => {
    const clean = analyzeOnset(leap(64, 60, 1.0, 0), { midi: 60, start: 1.0, end: 2.4 }, ctx);
    expect(clean.scoopCents).toBe(0);
    expect(clean.settleMs!).toBeLessThan(30);
    const over = analyzeOnset(
      makeTrack({ duration: 3, midi: (t) => (t < 0.2 ? NaN : t < 1.0 ? 64 : t < 1.05 ? 59.5 : t < 1.12 ? 59.4 : 60) }),
      { midi: 60, start: 1.0, end: 2.4 },
      ctx,
    );
    expect(over.overshootCents).toBeGreaterThan(30);
  });

  it('an octave leap lands like any other', () => {
    const r = analyzeOnset(leap(48, 60, 1.0, 0.0), { midi: 60, start: 1.0, end: 2.4 }, ctx);
    expect(r.scoopCents).toBe(0);
    expect(r.settleMs!).toBeLessThan(30);
    expect(r.crisp).toBe(true);
  });

  it('repeating the same pitch legato settles at once (nothing to leave, nothing to scoop)', () => {
    const track = makeTrack({ duration: 3, midi: (t) => (t < 0.2 ? NaN : 60) });
    const r = analyzeOnset(track, { midi: 60, start: 1.0, end: 2.4 }, ctx);
    expect(r.settleMs!).toBeLessThan(30);
    expect(r.scoopCents).toBe(0);
  });

  it('a landing that never reaches the target (still on the old pitch) never settles', () => {
    const track = makeTrack({ duration: 3, midi: (t) => (t < 0.2 ? NaN : 56) });
    const r = analyzeOnset(track, { midi: 60, start: 1.0, end: 2.4 }, ctx);
    expect(r.settleMs).toBeNull();
    expect(r.crisp).toBe(false);
  });

  it('a continuous landing has no pre-onset silence to time an attack from: onset type unknown, riseMs null', () => {
    const r = analyzeOnset(leap(56, 60, 1.0, 0), { midi: 60, start: 1.0, end: 2.4 }, ctx);
    expect(r.onsetType).toBe('unknown');
    expect(r.riseMs).toBeNull();
  });
});

describe('analyzeOnset: overshoot is what happens BEFORE the note settles', () => {
  /** Lands from 28 c below with a 40 ms time constant (just outside +/-25 c, so it takes a couple of frames to settle), then 35 c vibrato from 0.3 s later. */
  const landsThenVibrato = (jitterCents: number, seed: number) =>
    makeTrack({
      duration: 3,
      midi: withVibrato((t) => (t < 0.5 ? NaN : 60 - 0.28 * Math.exp(-(t - 0.5) / 0.04)), 5.8, 35, 0.8),
      rmsDb: linearAmpRamp(0.5, 0.125),
      jitterCents,
      seed,
    });

  it('a vibrato sung after a crisp landing is not an overshoot: 0 c, settled in a few ms, still crisp', () => {
    const r = analyzeOnset(landsThenVibrato(0, 1), sustained(60, 0.5, 2), ctx);
    expect(r.settleMs).not.toBeNull();
    expect(r.settleMs!).toBeGreaterThan(5); // not settled in the very first frame: there is a window before settling to be wrong about
    expect(r.settleMs!).toBeLessThan(25);
    expect(r.scoopCents).toBeGreaterThan(20); // the real approach from below ...
    expect(r.scoopCents).toBeLessThan(CONFIG.onset.crispMaxScoopCents); // ... which is shallow enough
    expect(r.overshootCents).toBe(0); // the +35 c crests of the vibrato come long after the note settled
    expect(r.crisp).toBe(true);
  });

  it('with detector jitter on top, nothing after settling is ever an overshoot, at any seed', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const r = analyzeOnset(landsThenVibrato(3, seed), sustained(60, 0.5, 2), ctx);
      expect(r.settleMs, `seed ${seed}`).not.toBeNull();
      expect(r.settleMs!, `seed ${seed}`).toBeLessThan(40);
      expect(r.overshootCents, `seed ${seed}`).toBe(0);
    }
  });

  it('whereas a real swing past the target on the way in still is one', () => {
    const track = makeTrack({ duration: 2, midi: (t) => (t < 0.5 ? NaN : t < 0.53 ? 59.72 : t < 0.58 ? 60.35 : 60) });
    const r = analyzeOnset(track, sustained(60, 0.5, 2), ctx);
    expect(r.overshootCents).toBeGreaterThan(30);
  });
});

/**
 * SPEC 8.2 states the settle hold and the scoop window as numbers: "stays within tolerance for 100 ms" and "the
 * lowest deviation below the target in the first 150 ms". They are pinned here as boundary behaviours. The
 * contours are built frame by frame so each boundary is hit exactly (frames are 10.67 ms apart).
 */
describe('analyzeOnset: the SPEC 8.2 numbers (pinned on purpose: update them if the owner retunes)', () => {
  const onsetFrame = Math.round(0.5 * FR);
  const frameAt = (t: number) => Math.round(t * FR);

  it('settle needs the pitch to stay inside tolerance for 100 ms: 96 ms (10 frames) is not settled, 107 ms (11 frames) is', () => {
    const track = (inTolFrames: number) =>
      makeTrack({ duration: 2, midi: (t) => { const i = frameAt(t); return i < onsetFrame ? NaN : i < onsetFrame + inTolFrames ? 60 : 60.4; } }); // then +40 c for good
    expect(analyzeOnset(track(10), sustained(60, 0.5, 2), ctx).settleMs).toBeNull();
    const eleven = analyzeOnset(track(11), sustained(60, 0.5, 2), ctx);
    expect(eleven.settleMs).not.toBeNull();
    expect(eleven.settleMs!).toBeLessThan(1); // it was in tolerance from the first frame
  });

  it('the scoop is read over the first 150 ms: a dip 149 ms after the onset counts, one 171 ms after does not', () => {
    const dipAt = (framesAfterOnset: number) =>
      makeTrack({ duration: 2, midi: (t) => { const i = frameAt(t); return i < onsetFrame ? NaN : i === onsetFrame + framesAfterOnset ? 59.6 : 60; } });
    const inside = analyzeOnset(dipAt(14), sustained(60, 0.5, 2), ctx); // 14 frames = 149 ms
    expect(inside.scoopCents).toBeGreaterThan(35);
    const outside = analyzeOnset(dipAt(16), sustained(60, 0.5, 2), ctx); // 16 frames = 171 ms
    expect(outside.scoopCents).toBe(0);
  });

  it('crisp uses the tier of the tolerance it is given: the same 200 ms settle is crisp at easy (+/-50 c, 400 ms) and not at studio (+/-10 c, 150 ms)', () => {
    const track = makeTrack({ duration: 2, midi: (t) => (t < 0.5 ? NaN : t < 0.7 ? 59.7 : 60), rmsDb: linearAmpRamp(0.5, 0.125) });
    const at = (toleranceCents: number) => analyzeOnset(track, sustained(60, 0.5, 2), { toleranceCents, vibratoStyle: 'pop' });
    expect(at(CONFIG.tolerance.easy).crisp).toBe(true); // inside +/-50 c from the first frame
    expect(at(CONFIG.tolerance.studio).crisp).toBe(false); // 30 c flat for 200 ms: outside +/-10 c until then
    expect(at(CONFIG.tolerance.studio).settleMs!).toBeGreaterThan(150);
  });
});
