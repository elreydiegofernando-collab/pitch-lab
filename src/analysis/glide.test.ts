import { describe, expect, it } from 'vitest';
import type { TargetNote } from '../core/types';
import { analyzeGlide, measureGlide } from './glide';
import { makeTrack } from './fixtures';
import { trackFromAudio } from './core-test-helpers';
import { midiToHz } from '../core/music';
import { synthesize } from '../dsp/test-signals';
import type { AnalyzeContext } from './types';

const CTX: AnalyzeContext = { toleranceCents: 25, vibratoStyle: 'pop' };

/** A glide target 60 -> 67 over [0.3, 1.3]. */
const G: TargetNote = { midi: 60, toMidi: 67, start: 0.3, end: 1.3 };

/** Linear ramp from G.midi to G.toMidi over [start, end], holding either side. */
function ramp(g: TargetNote, shiftSec = 0): (t: number) => number {
  const to = g.toMidi as number;
  return (t) => {
    const u = (t - g.start - shiftSec) / (g.end - g.start);
    return g.midi + (to - g.midi) * Math.min(1, Math.max(0, u));
  };
}

function track(midi: (t: number) => number, opts: { duration?: number; jitter?: number; seed?: number } = {}) {
  return makeTrack({ duration: opts.duration ?? 1.8, midi, jitterCents: opts.jitter ?? 8, seed: opts.seed ?? 1 });
}

describe('analyzeGlide: smooth glides', () => {
  it('scores a smooth glide as smooth, monotonic, with no stair steps, and times it', () => {
    const r = analyzeGlide(track(ramp(G)), G, CTX);
    expect(r.monotonic).toBe(true);
    expect(r.stairSteps).toBe(0);
    expect(r.smoothness).toBeGreaterThan(0.95);
    expect(r.cracks).toEqual([]);
    expect(r.durationMs).toBeGreaterThan(920);
    expect(r.durationMs).toBeLessThan(1080);
    expect(Math.abs(r.startErrorCents as number)).toBeLessThan(20);
    expect(Math.abs(r.endErrorCents as number)).toBeLessThan(20);
  });

  it('reports when it left and arrived (measureGlide)', () => {
    const m = measureGlide(track(ramp(G)), G);
    expect(m.departT as number).toBeGreaterThan(0.25);
    expect(m.departT as number).toBeLessThan(0.35);
    expect(m.arriveT as number).toBeGreaterThan(1.25);
    expect(m.arriveT as number).toBeLessThan(1.35);
    expect(m.maxProgress).toBeGreaterThan(0.97);
  });

  it('works downwards', () => {
    const down: TargetNote = { midi: 67, toMidi: 60, start: 0.3, end: 1.3 };
    const r = analyzeGlide(track(ramp(down)), down, CTX);
    expect(r.smoothness).toBeGreaterThan(0.95);
    expect(r.stairSteps).toBe(0);
    expect(r.durationMs).toBeGreaterThan(920);
    expect(r.durationMs).toBeLessThan(1080);
  });

  it('treats an S-curve (a natural portamento: slow start, slow finish) as smooth, not stepped', () => {
    const s = (t: number): number => {
      const u = Math.min(1, Math.max(0, (t - G.start) / (G.end - G.start)));
      return 60 + 7 * ((1 - Math.cos(Math.PI * u)) / 2);
    };
    const r = analyzeGlide(track(s), G, CTX);
    expect(r.stairSteps).toBe(0);
    expect(r.smoothness).toBeGreaterThan(0.9);
    // The 10%-90% span of an S-curve is shorter than its full length, so the linear-equivalent duration reads short.
    expect(r.durationMs).toBeGreaterThan(650);
    expect(r.durationMs).toBeLessThan(950);
  });

  it('does not mistake vibrato on a siren for stair steps', () => {
    const vib = (t: number): number => ramp(G)(t) + 0.3 * Math.sin(2 * Math.PI * 5.5 * t); // +/-30 c at 5.5 Hz
    const r = analyzeGlide(track(vib, { jitter: 6 }), G, CTX);
    expect(r.stairSteps).toBe(0);
    expect(r.smoothness).toBeGreaterThan(0.9);
    expect(r.monotonic).toBe(true);
  });

  it('handles a slow two-octave siren', () => {
    const g: TargetNote = { midi: 48, toMidi: 72, start: 0.5, end: 3.5 };
    const r = analyzeGlide(track(ramp(g), { duration: 4 }), g, CTX);
    expect(r.stairSteps).toBe(0);
    expect(r.smoothness).toBeGreaterThan(0.95);
    expect(r.durationMs).toBeGreaterThan(2800);
    expect(r.durationMs).toBeLessThan(3200);
  });

  it('is not fooled by jitter: no false stair steps over 30 noise seeds at 8 c', () => {
    let falseStairs = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const r = analyzeGlide(track(ramp(G), { seed, jitter: 8 }), G, CTX);
      if (r.stairSteps > 0 || r.smoothness < 0.9) falseStairs++;
    }
    expect(falseStairs).toBe(0);
  });
});

describe('analyzeGlide: stair-stepped glides', () => {
  it('detects four plateaus of 250 ms as stair steps', () => {
    const g: TargetNote = { midi: 60, toMidi: 67, start: 0.3, end: 1.0 };
    const midi = (t: number): number => (t < 0.3 ? 60 : t < 0.55 ? 62 : t < 0.8 ? 65 : 67);
    const r = analyzeGlide(track(midi, { duration: 1.4 }), g, CTX);
    expect(r.stairSteps).toBeGreaterThanOrEqual(2);
    expect(r.smoothness).toBeLessThan(0.5);
  });

  it('detects a realistic staircase: seven 100-cent steps of 100 ms', () => {
    const midi = (t: number): number => {
      if (t < G.start) return 60;
      if (t > G.end) return 67;
      const k = Math.floor(((t - G.start) / (G.end - G.start)) * 7);
      return 60 + Math.min(7, k + 0.5);
    };
    const r = analyzeGlide(track(midi), G, CTX);
    expect(r.stairSteps).toBeGreaterThanOrEqual(4);
    expect(r.smoothness).toBeLessThan(0.35);
    expect(r.cracks).toEqual([]); // 100 c steps are not breaks
  });

  it('scores a smooth glide higher than the same glide with a stall in the middle', () => {
    const stallStart = 0.8;
    const stall = (t: number): number => (t < stallStart ? ramp(G)(t) : t < stallStart + 0.15 ? ramp(G)(stallStart) : ramp(G)(t - 0.15));
    const g: TargetNote = { ...G, end: G.end + 0.15 };
    const stalled = analyzeGlide(track(stall), g, CTX);
    const smooth = analyzeGlide(track(ramp(G)), G, CTX);
    expect(stalled.stairSteps).toBe(1);
    expect(stalled.smoothness).toBeLessThan(smooth.smoothness - 0.2);
    expect(stalled.smoothness).toBeGreaterThan(0.3);
  });

  it('detects a 120 ms stall in a 700 c/s glide in most noise seeds', () => {
    let found = 0;
    const N = 20;
    for (let seed = 1; seed <= N; seed++) {
      const stall = (t: number): number => (t < 0.8 ? ramp(G)(t) : t < 0.92 ? ramp(G)(0.8) : ramp(G)(t - 0.12));
      const r = analyzeGlide(track(stall, { seed }), { ...G, end: G.end + 0.12 }, CTX);
      if (r.stairSteps >= 1) found++;
    }
    expect(found / N).toBeGreaterThanOrEqual(0.85);
  });
});

describe('analyzeGlide: monotonicity', () => {
  it('flags a glide that rises, slides back and rises again', () => {
    const wobble = (t: number): number => {
      const u = Math.min(1, Math.max(0, (t - G.start) / (G.end - G.start)));
      return 60 + 7 * u - (u > 0.45 && u < 0.7 ? 7 * 0.35 * Math.sin(((u - 0.45) / 0.25) * Math.PI) : 0); // dips ~245 c mid-glide
    };
    const r = analyzeGlide(track(wobble), G, CTX);
    expect(r.monotonic).toBe(false);
    expect(r.smoothness).toBeLessThan(0.85);
  });

  it('does not call ordinary scatter a reversal', () => {
    expect(analyzeGlide(track(ramp(G), { jitter: 15 }), G, CTX).monotonic).toBe(true);
  });
});

describe('analyzeGlide: arrival, shortfall and timing', () => {
  it('shows an arrival 200 ms late in the end error and in departT/arriveT', () => {
    const late = ramp(G, 0.2);
    const m = measureGlide(track(late), G);
    expect(m.durationMs as number).toBeGreaterThan(920);
    expect(m.durationMs as number).toBeLessThan(1080);
    expect(m.departT as number).toBeGreaterThan(0.45);
    expect(m.arriveT as number).toBeGreaterThan(1.45);
    expect(m.endErrorCents as number).toBeLessThan(-100); // still on its way at the requested end
  });

  it('an undershooting siren is still a siren: it has a duration and a shape, and its shortfall shows in the end error', () => {
    const under = (t: number): number => (t < G.start ? 60 : t > G.end ? 65.5 : 60 + 5.5 * ((t - G.start) / (G.end - G.start)));
    const r = analyzeGlide(track(under), G, CTX);
    expect(r.durationMs).not.toBeNull();
    expect(r.endErrorCents as number).toBeLessThan(-100);
    expect(r.endErrorCents as number).toBeGreaterThan(-200);
    expect(r.stairSteps).toBe(0); // the hold after it is not part of the glide
    expect(r.smoothness).toBeGreaterThan(0.9);
    expect(measureGlide(track(under), G).maxProgress).toBeGreaterThan(0.75);
  });

  it('a note that never glided scores no smoothness and has no duration', () => {
    const r = analyzeGlide(track(() => 60), G, CTX);
    expect(r.durationMs).toBeNull();
    expect(r.smoothness).toBe(0);
    expect(Math.abs(r.startErrorCents as number)).toBeLessThan(20);
    expect(r.endErrorCents as number).toBeLessThan(-600);
  });

  it('a "siren" sung as one big step is not smooth: it jumped, and the jump is a crack', () => {
    const jump = (t: number): number => (t < 0.8 ? 60 : 67);
    const r = analyzeGlide(track(jump), G, CTX);
    expect(r.smoothness).toBe(0);
    expect(r.cracks.length).toBeGreaterThanOrEqual(1);
  });

  it('a note held at the DESTINATION pitch the whole time is not a glide either', () => {
    const r = analyzeGlide(track(() => 67), G, CTX);
    expect(r.durationMs).toBeNull();
    expect(r.smoothness).toBe(0);
    expect(measureGlide(track(() => 67), G).travel).toBeLessThan(0.1);
    expect(Math.abs(r.endErrorCents as number)).toBeLessThan(20); // it did land on the end pitch; it just never travelled there
  });

  it('returns nulls for a window with no voiced audio', () => {
    const r = analyzeGlide(track(() => NaN, { duration: 0.5 }), G, CTX);
    expect(r.durationMs).toBeNull();
    expect(r.startErrorCents).toBeNull();
    expect(r.endErrorCents).toBeNull();
    expect(r.smoothness).toBe(0);
    expect(r.cracks).toEqual([]);
  });

  it('starts late: voicing begins part-way through the glide', () => {
    const voicedLate = (t: number): number => (t < G.start + 0.2 ? NaN : ramp(G)(t));
    const r = analyzeGlide(track(voicedLate), G, CTX);
    expect(r.durationMs).not.toBeNull();
    expect(r.durationMs as number).toBeGreaterThan(850);
    expect(r.durationMs as number).toBeLessThan(1150);
  });

  it('treats a very short move as a clean step, not a slide', () => {
    const g: TargetNote = { midi: 60, toMidi: 62, start: 0.2, end: 0.21 };
    const r = analyzeGlide(track((t) => (t < 0.205 ? 60 : 62), { duration: 0.5, jitter: 3 }), g, CTX);
    expect(r.monotonic).toBe(true);
    expect(r.stairSteps).toBe(0);
    expect(r.smoothness).toBe(1);
  });

  it('a target with no interval (a plain hold) has nothing to be stepped about', () => {
    const hold: TargetNote = { midi: 60, start: 0.2, end: 1 };
    const r = analyzeGlide(track(() => 60), hold, CTX);
    expect(r.smoothness).toBe(1);
    expect(r.stairSteps).toBe(0);
    expect(r.durationMs).toBeNull();
  });
});

describe('analyzeGlide: cracks inside the glide', () => {
  it('reports a break in the middle of a glide', () => {
    const cracked = (t: number): number => (t < 0.8 ? ramp(G)(t) : ramp(G)(t) + 3.5);
    const r = analyzeGlide(track(cracked), G, CTX);
    expect(r.cracks.length).toBeGreaterThanOrEqual(1);
    expect(r.cracks[0].t).toBeGreaterThan(0.7);
    expect(r.cracks[0].t).toBeLessThan(0.9);
  });

  it('reports a dropout in the middle of a glide', () => {
    const dropout = (t: number): number => (t > 0.8 && t < 0.85 ? NaN : ramp(G)(t));
    const r = analyzeGlide(track(dropout), G, CTX);
    expect(r.cracks.some((c) => c.kind === 'dropout')).toBe(true);
  });

  it('does not report the silence before and after the glide', () => {
    const r = analyzeGlide(track((t) => (t >= 0.2 && t <= 1.4 ? ramp(G)(t) : NaN)), G, CTX);
    expect(r.cracks).toEqual([]);
  });
});

describe('analyzeGlide: adjacent glides (a siren up then down)', () => {
  const up: TargetNote = { midi: 60, toMidi: 72, start: 0.5, end: 2.5 };
  const down: TargetNote = { midi: 72, toMidi: 60, start: 2.5, end: 4.5 };
  const siren = (t: number): number => (t < 2.5 ? ramp(up)(t) : ramp(down)(t));

  it('measures each glide on its own', () => {
    const tk = track(siren, { duration: 5 });
    for (const g of [up, down]) {
      const r = analyzeGlide(tk, g, CTX);
      expect(r.smoothness).toBeGreaterThan(0.9);
      expect(r.stairSteps).toBe(0);
      expect(r.durationMs as number).toBeGreaterThan(1800);
      expect(r.durationMs as number).toBeLessThan(2200);
      expect(Math.abs(r.endErrorCents as number)).toBeLessThan(45); // a cusp at the turning point
    }
  });
});

describe('analyzeGlide: through the real detector (synthesized audio -> Framer -> MPM)', () => {
  const SR = 48000;
  const g: TargetNote = { midi: 52, toMidi: 64, start: 0.5, end: 3.0 };

  it('scores a smooth siren as smooth with the right shape and end', () => {
    const audio = synthesize({ sampleRate: SR, duration: 3.6, f0: (t) => midiToHz(ramp(g)(t)) });
    const r = analyzeGlide(trackFromAudio(audio, SR), g, CTX);
    expect(r.smoothness).toBeGreaterThan(0.9);
    expect(r.stairSteps).toBe(0);
    expect(r.cracks).toEqual([]);
    expect(Math.abs(r.endErrorCents as number)).toBeLessThan(30);
    expect(r.durationMs as number).toBeGreaterThan(2200);
    expect(r.durationMs as number).toBeLessThan(2800);
  });

  it('scores a staircase siren (a 100-cent step every 200 ms) as stepped', () => {
    const steps = (t: number): number => {
      if (t < g.start) return 52;
      if (t > g.end) return 64;
      return 52 + Math.min(12, Math.floor((t - g.start) / 0.2));
    };
    const audio = synthesize({ sampleRate: SR, duration: 3.6, f0: (t) => midiToHz(steps(t)) });
    const r = analyzeGlide(trackFromAudio(audio, SR), g, CTX);
    expect(r.stairSteps).toBeGreaterThanOrEqual(3);
    expect(r.smoothness).toBeLessThan(0.5);
  });
});
