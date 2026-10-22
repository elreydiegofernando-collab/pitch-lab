import { describe, expect, it } from 'vitest';
import { detectCracks } from './cracks';
import { FRAME_RATE, makeTrack, sustained } from './fixtures';
import { cleanOctaveSpikes } from './track';
import { trackFromAudio } from './core-test-helpers';
import { CONFIG } from '../config';
import { midiToHz } from '../core/music';
import { synthesize, vibratoContour } from '../dsp/test-signals';

/** One value per frame (NaN = unvoiced), at the real frame rate. */
function frames(values: readonly number[], jitterCents = 0) {
  return makeTrack({
    duration: values.length / FRAME_RATE + 1e-4,
    midi: (t) => values[Math.round(t * FRAME_RATE)] ?? NaN,
    jitterCents,
  });
}

const ramp = (n: number, from: number, perFrame: number): number[] => Array.from({ length: n }, (_, i) => from + i * perFrame);

describe('detectCracks: jumps', () => {
  it('detects a 300c jump in 15ms, and reports its size and speed', () => {
    const midi = (t: number): number => (t < 0.5 ? 60 : t < 0.515 ? 60 + 3 * ((t - 0.5) / 0.015) : 63);
    const events = detectCracks(makeTrack({ duration: 1, midi }));
    expect(events).toHaveLength(1);
    const [e] = events;
    expect(e.kind).toBe('jump');
    expect(e.cents).toBeGreaterThan(270);
    expect(e.cents).toBeLessThan(330);
    expect(e.durationMs).toBeLessThan(CONFIG.transitions.crackWithinMs);
    expect(e.t).toBeGreaterThan(0.48);
    expect(e.t).toBeLessThan(0.52);
  });

  it('detects a jump down as well as up, and an instantaneous one', () => {
    expect(detectCracks(makeTrack({ duration: 1, midi: (t) => (t < 0.5 ? 64 : 60) }))).toHaveLength(1);
    expect(detectCracks(makeTrack({ duration: 1, midi: (t) => (t < 0.5 ? 60 : 64.5) }))[0].cents).toBeGreaterThan(400);
  });

  it('does not flag a smooth siren, however fast', () => {
    const slow = makeTrack({ duration: 1.5, midi: (t) => 48 + 24 * (t / 1.5), jitterCents: 8 }); // two octaves in 1.5 s
    expect(detectCracks(slow)).toEqual([]);
    const fast = makeTrack({ duration: 1, midi: (t) => 48 + 36 * t, jitterCents: 8 }); // three octaves in one second
    expect(detectCracks(fast)).toEqual([]);
  });

  it('does not flag vibrato, even a wide fast one', () => {
    const wide = makeTrack({ duration: 2, midi: (t) => 60 + 1.0 * Math.sin(2 * Math.PI * 7 * t), jitterCents: 8 }); // +/-100 c at 7 Hz
    expect(detectCracks(wide)).toEqual([]);
  });

  it('flags a leap between notes: crack detection is for sirens and glides, not for note-to-note exercises', () => {
    const leap = makeTrack({ duration: 1, midi: (t) => (t < 0.5 ? sustained(60, 0, 1).midi : 67) });
    expect(detectCracks(leap)).toHaveLength(1);
  });

  it('reports two cracks half a second apart as two events, in time order', () => {
    const track = makeTrack({ duration: 2, midi: (t) => (t < 0.6 ? 60 : t < 1.2 ? 64 : 59) });
    const events = detectCracks(track);
    expect(events).toHaveLength(2);
    expect(events[0].t).toBeLessThan(events[1].t);
  });

  it('a squeak that flips up and straight back is one crack, not two', () => {
    const vals = [...ramp(30, 60, 0), 64.2, 64.2, 64.2, ...ramp(30, 60, 0)]; // 3 frames up 420 c, then back
    const events = detectCracks(frames(vals));
    expect(events).toHaveLength(1);
    expect(events[0].cents).toBeGreaterThan(300);
  });

  it('counts a jump that straddles a single unvoiced frame once, as a jump', () => {
    const vals = [...ramp(30, 60, 0), NaN, ...ramp(30, 63.5, 0)];
    const events = detectCracks(frames(vals));
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('jump');
    expect(events[0].cents).toBeGreaterThan(340);
  });
});

describe('detectCracks: the owner\'s boundary (SPEC 8.4: more than 200 c in under 30 ms)', () => {
  /** A step of `cents` between two frames `gapMs` apart (frame 20 to 21), steady either side of it. */
  const step = (cents: number, gapMs: number) => {
    const fps = 1000 / gapMs;
    return makeTrack({ duration: 42 / fps, frameRate: fps, midi: (t) => (Math.round(t * fps) < 21 ? 60 : 60 + cents / 100) });
  };

  it('a 190 c step 25 ms apart is not a crack, a 210 c step is, and it reports the size', () => {
    expect(CONFIG.transitions.crackJumpCents).toBe(200);
    expect(detectCracks(step(190, 25))).toEqual([]);
    const events = detectCracks(step(210, 25));
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('jump');
    expect(events[0].cents).toBeCloseTo(210, 6);
  });

  it('the same 210 c change spread over 35 ms is a slide, not a crack: the jump has to be inside 30 ms', () => {
    expect(CONFIG.transitions.crackWithinMs).toBe(30);
    expect(detectCracks(step(210, 35))).toEqual([]);
    expect(detectCracks(step(210, 29))).toHaveLength(1);
    expect(detectCracks(step(210, 31))).toEqual([]);
  });

  it('at the real 94 frames a second a 190 c step is not a crack and a 210 c step is, up or down', () => {
    const at = (cents: number) => makeTrack({ duration: 1, midi: (t) => (t < 0.5 ? 60 : 60 + cents / 100) });
    expect(detectCracks(at(190))).toEqual([]);
    expect(detectCracks(at(-190))).toEqual([]);
    expect(detectCracks(at(210))).toHaveLength(1);
    expect(detectCracks(at(-210))).toHaveLength(1);
  });
});

describe('detectCracks: detector glitches are not cracks', () => {
  it('ignores a one-frame and a two-frame octave spike', () => {
    expect(detectCracks(frames([...ramp(30, 60, 0), 72, ...ramp(30, 60, 0)]))).toEqual([]);
    expect(detectCracks(frames([...ramp(30, 60, 0), 72, 72, ...ramp(30, 60, 0)]))).toEqual([]);
    expect(detectCracks(frames([...ramp(30, 60, 0), 48, 48, ...ramp(30, 60, 0)]))).toEqual([]);
  });

  it('ignores a one-frame twelfth (1902 c) glitch', () => {
    expect(detectCracks(frames([...ramp(30, 60, 0), 79, ...ramp(30, 60, 0)]))).toEqual([]);
  });

  it('a glitch is not mistaken for a dropout either (it counts as voiced)', () => {
    const vals = [...ramp(30, 60, 0), 72, 72, ...ramp(30, 60, 0)];
    expect(detectCracks(frames(vals)).filter((e) => e.kind === 'dropout')).toEqual([]);
  });

  it('still catches a real crack that follows a glitch', () => {
    const vals = [...ramp(20, 60, 0), 72, ...ramp(20, 60, 0), ...ramp(30, 64, 0)];
    const events = detectCracks(frames(vals));
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('jump');
  });

  it('bridges frames that cleanOctaveSpikes cleared (voiced=false, but a real pitch and a passing confidence)', () => {
    const raw = frames([...ramp(30, 60, 0.02), 73, 73, ...ramp(30, 60.6, 0.02)]);
    const cleaned = cleanOctaveSpikes(raw);
    expect(cleaned.some((f, i) => !f.voiced && raw[i].voiced)).toBe(true); // the helper really did clear them
    expect(detectCracks(cleaned)).toEqual([]);
  });
});

describe('detectCracks: dropouts', () => {
  const { dropoutMinMs } = CONFIG.transitions;

  it('flags an interior confidence dropout at least dropoutMinMs long', () => {
    const gapSec = (dropoutMinMs + 20) / 1000;
    const track = makeTrack({ duration: 0.8, midi: (t) => (t >= 0.2 && t < 0.2 + gapSec ? NaN : 60) });
    const events = detectCracks(track);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('dropout');
    expect(events[0].durationMs).toBeGreaterThanOrEqual(dropoutMinMs);
    expect(events[0].cents).toBeUndefined(); // same pitch either side: it faltered, it did not break
  });

  it('flags a dropout that returns at a different pitch and carries the discontinuity', () => {
    const events = detectCracks(frames([...ramp(30, 60, 0), NaN, NaN, ...ramp(30, 63, 0)]));
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('dropout');
    expect(events[0].cents).toBeGreaterThan(250);
  });

  it('does not flag leading or trailing silence', () => {
    const track = makeTrack({ duration: 0.8, midi: (t) => (t >= 0.1 && t < 0.5 ? 60 : NaN) });
    expect(detectCracks(track)).toEqual([]);
  });

  it('does not flag a one-frame flicker, but does flag two frames', () => {
    expect(detectCracks(frames([...ramp(30, 60, 0), NaN, ...ramp(30, 60, 0)]))).toEqual([]);
    expect(detectCracks(frames([...ramp(30, 60, 0), NaN, NaN, ...ramp(30, 60, 0)]))).toHaveLength(1);
  });

  it('reads a long silence as a pause (a breath between glides), not a crack', () => {
    const track = makeTrack({ duration: 2, midi: (t) => (t >= 0.5 && t < 1.2 ? NaN : 60) });
    expect(detectCracks(track)).toEqual([]);
  });

  it('counts each separate dropout in a siren', () => {
    const track = makeTrack({ duration: 3, midi: (t) => (Math.abs(t - 1) < 0.03 || Math.abs(t - 2) < 0.03 ? NaN : 48 + 6 * t) });
    expect(detectCracks(track)).toHaveLength(2);
  });
});

describe('detectCracks: housekeeping', () => {
  it('handles empty, single-frame and silent tracks', () => {
    expect(detectCracks([])).toEqual([]);
    expect(detectCracks(makeTrack({ duration: 0.01, midi: () => 60 }))).toEqual([]);
    expect(detectCracks(makeTrack({ duration: 1, midi: () => NaN }))).toEqual([]);
  });

  it('does not mutate its input', () => {
    const track = frames([...ramp(30, 60, 0), 72, ...ramp(30, 60, 0), ...ramp(30, 64, 0)]);
    const copy = track.map((f) => ({ ...f }));
    detectCracks(track);
    expect(track).toEqual(copy);
  });

  it('is cheap enough to run on a live ring buffer: 60 s of siren in a few ms', () => {
    const track = makeTrack({ duration: 60, midi: (t) => 48 + 24 * ((t % 10) / 10), jitterCents: 8 });
    detectCracks(track); // warm
    const t0 = performance.now();
    const events = detectCracks(track);
    const ms = performance.now() - t0;
    // 10-second sirens wrap: each wrap is a 2-octave downward jump, so 5 genuine cracks.
    expect(events).toHaveLength(5);
    expect(ms).toBeLessThan(80); // ~2 ms measured; this only has to catch an O(n^2) slip, even on a loaded machine
  });
});

describe('detectCracks: through the real detector (synthesized audio -> Framer -> MPM)', () => {
  const SR = 48000;

  it('does not flag a smooth siren, nor a siren with vibrato', () => {
    const siren = trackFromAudio(synthesize({ sampleRate: SR, duration: 3, f0: (t) => midiToHz(52 + 12 * (t / 3)) }), SR);
    expect(siren.filter((f) => f.voiced).length).toBeGreaterThan(250);
    expect(detectCracks(siren)).toEqual([]);

    const vib = vibratoContour(220, 5.5, 40);
    const vibSiren = trackFromAudio(synthesize({ sampleRate: SR, duration: 3, f0: (t) => vib(t) * Math.pow(2, (7 * (t / 3)) / 12) }), SR);
    expect(detectCracks(vibSiren)).toEqual([]);
  });

  it('finds a 300c break at 1.5 s, whether the detector shows it as a jump or as a short dropout', () => {
    const audio = synthesize({
      sampleRate: SR,
      duration: 3,
      f0: (t) => {
        const base = 52 + 6 * (t / 3);
        return midiToHz(t < 1.5 ? base : t < 1.515 ? base + 3 * ((t - 1.5) / 0.015) : base + 3);
      },
    });
    const events = detectCracks(trackFromAudio(audio, SR));
    expect(events).toHaveLength(1);
    expect(events[0].t).toBeGreaterThan(1.45);
    expect(events[0].t).toBeLessThan(1.56);
    expect(events[0].cents ?? 300).toBeGreaterThan(200);
  });
});
