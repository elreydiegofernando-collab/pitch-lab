/**
 * Acoustic round trip for the Listen demos. The unit tests in demos.test.ts
 * check WHICH synth calls and automation events a demo makes; this file checks
 * what they SOUND like, which is what the singer hears. Node has no Web Audio,
 * so a small evaluator below renders the graph the demo builds (oscillators,
 * gains, PeriodicWaves, LFOs into `detune`, and AudioParam set / linear / exp
 * automation, per the Web Audio spec) to samples. Those go through the
 * PRODUCTION framer and MPM detector, and the numbers are then read by the
 * project's own analyzers: a Listen demo is a model performance, so it must
 * score as one under the exercise's own analysis.
 *
 * The real synth (src/audio/synth.ts) is used for everything it handles, so
 * this also proves the VibratoSpec / GlideSpec the demos hand it do what they
 * claim (e.g. delaySec + fadeInSec really bloom a vibrato).
 */
import { describe, expect, it, vi } from 'vitest';
import { analyzeDynamics } from '../analysis/dynamics';
import { analyzeGlide } from '../analysis/glide';
import { analyzePulse } from '../analysis/pulse';
import { analyzeSwitch } from '../analysis/switch';
import { analyzeVibrato } from '../analysis/vibrato';
import type { AnalyzeContext } from '../analysis/types';
import { CONFIG, hopSizeFor } from '../config';
import type { PitchFrame, TargetNote } from '../core/types';
import { createDetector } from '../dsp/detector';
import { CUE } from '../exercises/cues';
import type { ExerciseDef } from '../exercises/types';
import {
  BLOOM_FADE_IN_SEC,
  FALL_END_GAIN,
  PULSE_DEMO_EXTENT_CENTS,
  SWELL_SOFT_GAIN,
  buildDemo,
  styleZoneVibrato,
  type DemoRealized,
} from './demos';
import { Framer } from './framer';
import { createSynth } from './synth';

// Rendering seconds of audio sample by sample is CPU-heavy; give it room when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 60_000 });

// ---------------------------------------------------------------- a small Web Audio evaluator

const SR = 48000;
const TWO_PI = 2 * Math.PI;

interface Ev {
  k: 'set' | 'lin' | 'exp';
  v: number;
  t: number;
  o: number;
}

/** AudioParam: intrinsic value + automation timeline + audio-rate modulators connected into it. Evaluated in increasing time. */
class RParam {
  value: number;
  private ev: Ev[] = [];
  private mods: RNode[] = [];
  private order = 0;
  private ready = false;
  private idx = 0;
  private t0 = -Infinity;
  private v0 = 0;
  constructor(value: number) {
    this.value = value;
  }
  setValueAtTime(v: number, t: number): this {
    this.ev.push({ k: 'set', v, t, o: this.order++ });
    this.ready = false;
    return this;
  }
  linearRampToValueAtTime(v: number, t: number): this {
    this.ev.push({ k: 'lin', v, t, o: this.order++ });
    this.ready = false;
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number): this {
    if (!(v > 0)) throw new RangeError('exponentialRampToValueAtTime: target must be > 0');
    this.ev.push({ k: 'exp', v, t, o: this.order++ });
    this.ready = false;
    return this;
  }
  setTargetAtTime(v: number, t: number): this {
    return this.setValueAtTime(v, t); // only used by synth.setVolume, which the demos never call
  }
  cancelScheduledValues(): this {
    return this;
  }
  addModulator(n: RNode): void {
    this.mods.push(n);
  }
  private base(t: number): number {
    if (!this.ready) {
      this.ev.sort((a, b) => a.t - b.t || a.o - b.o);
      this.idx = 0;
      this.t0 = -Infinity;
      this.v0 = this.value;
      this.ready = true;
    }
    while (this.idx < this.ev.length && this.ev[this.idx].t <= t) {
      const e = this.ev[this.idx++];
      this.t0 = e.t;
      this.v0 = e.v;
    }
    const next = this.ev[this.idx];
    if (!next || next.k === 'set' || this.t0 === -Infinity) return this.v0;
    const u = (t - this.t0) / (next.t - this.t0);
    if (next.k === 'lin') return this.v0 + (next.v - this.v0) * u;
    return this.v0 > 0 ? this.v0 * Math.pow(next.v / this.v0, u) : this.v0;
  }
  out(n: number, t: number): number {
    let v = this.base(t);
    for (const m of this.mods) v += m.out(n, t);
    return v;
  }
}

abstract class RNode {
  inputs: RNode[] = [];
  private memoN = -1;
  private memoV = 0;
  connect<T extends RNode | RParam>(dest: T): T {
    if (dest instanceof RParam) dest.addModulator(this);
    else (dest as RNode).inputs.push(this);
    return dest;
  }
  out(n: number, t: number): number {
    if (n !== this.memoN) {
      this.memoV = this.compute(n, t);
      this.memoN = n;
    }
    return this.memoV;
  }
  protected abstract compute(n: number, t: number): number;
  protected sum(n: number, t: number): number {
    let s = 0;
    for (const i of this.inputs) s += i.out(n, t);
    return s;
  }
}

class RGainNode extends RNode {
  gain = new RParam(1);
  protected compute(n: number, t: number): number {
    return this.gain.out(n, t) * this.sum(n, t);
  }
}

class RDestination extends RNode {
  protected compute(n: number, t: number): number {
    return this.sum(n, t);
  }
}

interface RWave {
  real: Float32Array;
  imag: Float32Array;
  norm: number;
}

class ROsc extends RNode {
  type: 'sine' | 'square' = 'sine';
  frequency = new RParam(440);
  detune = new RParam(0);
  private wave: RWave | null = null;
  private startT = Infinity;
  private stopT = Infinity;
  private phase = 0;
  setPeriodicWave(w: RWave): void {
    this.wave = w;
  }
  start(when = 0): void {
    this.startT = when;
  }
  stop(when = 0): void {
    this.stopT = Math.min(this.stopT, when);
  }
  addEventListener(): void {}
  protected compute(n: number, t: number): number {
    if (t < this.startT || t >= this.stopT) return 0;
    const f = this.frequency.out(n, t) * Math.pow(2, this.detune.out(n, t) / 1200);
    const p = this.phase;
    this.phase += f / SR;
    this.phase -= Math.floor(this.phase);
    if (this.wave) {
      let s = 0;
      for (let k = 1; k < this.wave.real.length; k++) s += this.wave.real[k] * Math.cos(TWO_PI * k * p) + this.wave.imag[k] * Math.sin(TWO_PI * k * p);
      return s * this.wave.norm;
    }
    return this.type === 'square' ? (p < 0.5 ? 1 : -1) : Math.sin(TWO_PI * p);
  }
}

class RCtx {
  currentTime = 0;
  sampleRate = SR;
  destination = new RDestination();
  createOscillator(): ROsc {
    return new ROsc();
  }
  createGain(): RGainNode {
    return new RGainNode();
  }
  createPeriodicWave(real: Float32Array, imag: Float32Array): RWave {
    // Browsers normalise a PeriodicWave to a peak of 1.
    let peak = 0;
    for (let i = 0; i < 1024; i++) {
      let s = 0;
      for (let k = 1; k < real.length; k++) s += real[k] * Math.cos((TWO_PI * k * i) / 1024) + imag[k] * Math.sin((TWO_PI * k * i) / 1024);
      peak = Math.max(peak, Math.abs(s));
    }
    return { real, imag, norm: peak > 0 ? 1 / peak : 1 };
  }
}

function render(ctx: RCtx, seconds: number): Float32Array {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = ctx.destination.out(i, i / SR);
  return out;
}

/** The production framer + MPM detector over rendered audio, in 128-sample blocks like the worklet. */
function frames(samples: Float32Array): PitchFrame[] {
  const { windowSize, minHz, maxHz, mpmK, yinThreshold, minConfidence, minRmsDb, rmsFloorDb } = CONFIG.audio;
  const detector = createDetector('mpm', { sampleRate: SR, windowSize, minHz, maxHz, mpmK, yinThreshold });
  const framer = new Framer({ sampleRate: SR, windowSize, hopSize: hopSizeFor(SR), minHz, maxHz, minConfidence, minRmsDb, rmsFloorDb, detector });
  const out: PitchFrame[] = [];
  for (let i = 0; i < samples.length; i += 128) framer.push(samples.subarray(i, Math.min(samples.length, i + 128)), i, (f) => out.push(f));
  return out;
}

// ---------------------------------------------------------------- scenario helpers

const START = 0.1;

function def(over: Partial<ExerciseDef> & Pick<ExerciseDef, 'kind'>): ExerciseDef {
  return {
    id: `render.${over.kind}`,
    worldId: 'foundations',
    title: over.kind,
    goal: 'test',
    pattern: [],
    tempoBpm: 60,
    tonicPlacement: 'mid',
    countInBeats: 0,
    metronome: false,
    demo: { timbre: 'soft', vibrato: null },
    analyzers: [],
    scoring: [],
    pass: { score: 0.6 },
    tolerance: 'default',
    tiers: { solid: 0.7, studio: 0.85 },
    ...over,
  };
}

const note = (midi: number, start: number, end: number, toMidi?: number): TargetNote =>
  toMidi === undefined ? { midi, start, end } : { midi, start, end, toMidi };
const cue = (t: number, text: string) => ({ t, text });

/** Build the demo with the real synth on the evaluator, render it, and return the detector frames re-based so t = 0 is the downbeat. */
function sound(d: ExerciseDef, r: Pick<DemoRealized, 'notes' | 'cues'> & Partial<DemoRealized>, seconds: number, opts: { vibratoStyle?: 'pop' | 'classical' } = {}) {
  const ctx = new RCtx();
  const synth = createSynth(ctx as unknown as BaseAudioContext, ctx.destination as unknown as AudioNode);
  buildDemo(d, { tonicMidi: 60, bpm: 60, ...r }, synth, ctx as unknown as BaseAudioContext, ctx.destination as unknown as AudioNode, {
    startAt: START,
    gain: 0.5,
    ...opts,
  });
  const samples = render(ctx, START + seconds);
  const f = frames(samples).map((x) => ({ ...x, t: x.t - START }));
  return { samples, frames: f };
}

const centsOf = (f: PitchFrame, midi: number): number => (f.midi - midi) * 100;
const within = (fs: PitchFrame[], a: number, b: number): PitchFrame[] => fs.filter((f) => f.t >= a && f.t < b);
const voiced = (fs: PitchFrame[]): PitchFrame[] => fs.filter((f) => f.voiced);
const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
const sd = (xs: number[]): number => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};
const ctxFor = (style: 'pop' | 'classical'): AnalyzeContext => ({ toleranceCents: CONFIG.tolerance.default, vibratoStyle: style });

// ---------------------------------------------------------------- the evaluator itself

describe('the offline evaluator (so the checks below mean something)', () => {
  it('renders a plain synth note at the right pitch with the synth envelope', () => {
    const { samples, frames: fs } = sound(def({ kind: 'sustain', demo: { timbre: 'sine', vibrato: null } }), { notes: [note(69, 0, 2)], cues: [] }, 3);
    const v = voiced(within(fs, 0.3, 1.8));
    expect(v.length).toBeGreaterThan(100);
    for (const f of v) expect(Math.abs(centsOf(f, 69))).toBeLessThan(2); // A4 = 440 Hz
    // Silent before the start, then at the requested level (gain 0.5 sine = rms 0.354), silent after the release.
    const rms = (a: number, b: number) => Math.sqrt(mean(Array.from(samples.subarray(Math.round(a * SR), Math.round(b * SR)), (x) => x * x)));
    expect(rms(0, 0.05)).toBe(0);
    expect(rms(0.6, 1.6)).toBeCloseTo(0.5 / Math.SQRT2, 2);
    expect(rms(2.5, 3)).toBe(0);
  });

  it('renders vibrato through the real synth: detune LFO at the set rate and depth', () => {
    const { frames: fs } = sound(def({ kind: 'vibrato-meter', demo: { timbre: 'soft', vibrato: { rateHz: 5, extentCents: 50 } } }), { notes: [note(60, 0, 4)], cues: [] }, 5);
    const cents = voiced(within(fs, 0.5, 3.8)).map((f) => centsOf(f, 60));
    expect(Math.max(...cents) - Math.min(...cents)).toBeGreaterThan(80); // +/-50 c swing, minus a little detector smoothing
    expect(Math.abs(mean(cents))).toBeLessThan(6);
  });
});

// ---------------------------------------------------------------- vibrato

describe('what the vibrato demos sound like', () => {
  it.each(['pop', 'classical'] as const)('vibrato meter (%s): a vibrato the vibrato analyzer scores in the zone', (style) => {
    const d = def({ kind: 'vibrato-meter', demo: { timbre: 'soft', vibrato: 'style' }, analyzers: ['vibrato'] });
    const { frames: fs } = sound(d, { notes: [note(60, 0, 5)], cues: [] }, 6, { vibratoStyle: style });
    const target = note(60, 0.2, 5);
    const r = analyzeVibrato(within(fs, 0, 5.2), target, ctxFor(style));
    const zone = styleZoneVibrato(style);
    expect(r.present).toBe(true);
    expect(r.rateHz).toBeGreaterThan(zone.rateHz - 0.5);
    expect(r.rateHz).toBeLessThan(zone.rateHz + 0.5);
    expect(r.extentCents).toBeGreaterThan(zone.extentCents * 0.8); // the detector's 43 ms window smooths the peaks a little
    expect(r.extentCents).toBeLessThan(zone.extentCents * 1.1);
    expect(r.inZone).toBe(true);
    expect(r.flags).not.toContain('wobble');
    expect(r.flags).not.toContain('bleat');
    expect(r.flags).not.toContain('straight');
  });

  it('classical vibrato is audibly wider than pop at the same rate', () => {
    const d = def({ kind: 'vibrato-meter', demo: { timbre: 'soft', vibrato: 'style' } });
    const wide = (style: 'pop' | 'classical') => {
      const { frames: fs } = sound(d, { notes: [note(60, 0, 5)], cues: [] }, 6, { vibratoStyle: style });
      return analyzeVibrato(within(fs, 0, 5.2), note(60, 0.2, 5), ctxFor(style)).extentCents as number;
    };
    expect(wide('classical')).toBeGreaterThan(1.4 * wide('pop'));
  });

  it('straight to bloom: dead straight for the delay, then vibrato in the zone on the cue', () => {
    const d = def({ kind: 'straight-to-bloom', demo: { timbre: 'soft', vibrato: 'style' }, analyzers: ['vibrato', 'switch'] });
    const { frames: fs } = sound(d, { notes: [note(60, 0, 3), note(60, 3, 7)], cues: [cue(0, CUE.straight), cue(3, CUE.bloom)] }, 8);
    const straight = voiced(within(fs, 0.4, 2.8)).map((f) => centsOf(f, 60));
    expect(straight.length).toBeGreaterThan(150);
    expect(sd(straight)).toBeLessThan(4); //          straight tone
    expect(Math.max(...straight.map(Math.abs))).toBeLessThan(10);
    const bloomed = analyzeVibrato(within(fs, 3.6, 7), note(60, 3.6, 7), ctxFor('pop'));
    expect(bloomed.present).toBe(true);
    expect(bloomed.inZone).toBe(true);
    // The singer-side analyzer reads the demo as a bloom on the cue.
    const sw = analyzeSwitch(fs, [{ start: 0, end: 3, vibrato: false }, { start: 3, end: 7, vibrato: true }]);
    expect(sw.windows.map((w) => w.actual)).toEqual(['straight', 'vibrato']);
    expect(sw.bloomOnCueScore).not.toBeNull();
    expect(sw.bloomOnCueScore as number).toBeGreaterThan(0.6);
    expect(sw.bloomOnCueLatencyMs as number).toBeLessThan(1000 * (BLOOM_FADE_IN_SEC + 0.6)); // it arrives within the fade-in plus detection time
  });

  it('on/off switching: one tone that goes straight, vibrato, straight, vibrato, straight cleanly', () => {
    const d = def({ kind: 'vibrato-switch', demo: { timbre: 'soft', vibrato: 'style' }, analyzers: ['vibrato', 'switch'] });
    const states = [false, true, false, true, false];
    const notes = states.map((_, i) => note(60, i * 2.5, (i + 1) * 2.5));
    const cues = states.map((on, i) => cue(i * 2.5, on ? CUE.vibrato : CUE.straight));
    const { frames: fs } = sound(d, { notes, cues }, 13.5);
    states.forEach((on, i) => {
      const cents = voiced(within(fs, i * 2.5 + 0.7, (i + 1) * 2.5 - 0.2)).map((f) => centsOf(f, 60));
      expect(cents.length, `window ${i}`).toBeGreaterThan(60);
      if (on) expect(sd(cents), `window ${i}`).toBeGreaterThan(18); // +/-40 c sine: rms ~28 c
      else expect(sd(cents), `window ${i}`).toBeLessThan(4);
    });
    // No re-attack: the voice never drops out across the switches.
    expect(within(fs, 0.4, 12.2).filter((f) => !f.voiced)).toHaveLength(0);
    const plan = states.map((on, i) => ({ start: i * 2.5, end: (i + 1) * 2.5, vibrato: on }));
    const sw = analyzeSwitch(fs, plan);
    expect(sw.windows.map((w) => w.actual)).toEqual(['straight', 'vibrato', 'straight', 'vibrato', 'straight']);
    expect(sw.switchCleanRate).toBe(1);
  });

  it('a pulse train wobbles at the target rate and the pulse analyzer agrees', () => {
    const d = def({ kind: 'pulse-builder', analyzers: ['pulse', 'accuracy'], tempoBpm: 105, demo: { timbre: 'soft', vibrato: null } });
    const step = 60 / 105 / 2; // eighth notes: 3.5 pulses a second
    const notes = Array.from({ length: 12 }, (_, i) => note(60, i * step, (i + 1) * step));
    const { frames: fs } = sound(d, { bpm: 105, notes, cues: [] }, 6);
    const r = analyzePulse(within(fs, 0, 12 * step + 0.1), notes, 3.5);
    expect(r.measuredRateHz).not.toBeNull();
    expect(Math.abs(r.rateErrorHz as number)).toBeLessThan(0.2);
    expect(r.regularity as number).toBeGreaterThan(0.85);
    expect(r.swingCents as number).toBeGreaterThan(PULSE_DEMO_EXTENT_CENTS); // peak-to-trough is ~2 x the extent, less detector smoothing
  });
});

// ---------------------------------------------------------------- glides

describe('what the glide demos sound like', () => {
  const sineDef = (kind: ExerciseDef['kind']) => def({ kind, demo: { timbre: 'sine', vibrato: null } });

  it('a slide: holds, glides linearly in pitch over the given time, lands and holds (real synth playGlide)', () => {
    const { frames: fs } = sound(sineDef('slide'), { notes: [note(60, 0, 1), note(60, 1, 2, 67), note(67, 2, 4)], cues: [cue(0, CUE.slide)] }, 5);
    const at = (t: number) => mean(voiced(within(fs, t - 0.03, t + 0.03)).map((f) => f.midi));
    expect(at(0.5)).toBeCloseTo(60, 1);
    expect(at(1.5)).toBeCloseTo(63.5, 1); // halfway through the glide = halfway in pitch
    expect(at(1.25)).toBeCloseTo(61.75, 1);
    expect(at(3)).toBeCloseTo(67, 1);
    const g = analyzeGlide(within(fs, 0.6, 3.5), note(60, 1, 2, 67), ctxFor('pop'));
    expect(g.cracks).toHaveLength(0);
    expect(g.monotonic).toBe(true);
    expect(Math.abs(g.endErrorCents as number)).toBeLessThan(15);
  });

  it('a scoop glides up into the note and settles on it', () => {
    const { frames: fs } = sound(sineDef('scoop'), { notes: [note(58, 0, 0.5, 60), note(60, 0.5, 3)], cues: [cue(0, CUE.scoop)] }, 4);
    const late = voiced(within(fs, 1.0, 2.8)).map((f) => centsOf(f, 60));
    expect(Math.abs(mean(late))).toBeLessThan(3);
    expect(sd(late)).toBeLessThan(3);
    const early = voiced(within(fs, 0.0, 0.3));
    expect(Math.min(...early.map((f) => f.midi))).toBeLessThan(59.7); // it really does start below the note
  });

  it('an up-and-down siren is one unbroken voice that follows the path, with no dropout at the top', () => {
    const d = sineDef('siren');
    const { frames: fs } = sound(d, { notes: [note(60, 0, 1), note(60, 1, 3, 72), note(72, 3, 5, 60)], cues: [] }, 6.5);
    const expected = (t: number) => (t < 1 ? 60 : t < 3 ? 60 + 6 * (t - 1) : 72 - 6 * (t - 3));
    const body = within(fs, 0.3, 4.9);
    expect(body.filter((f) => !f.voiced)).toHaveLength(0); // no dip where the up-glide turns into the down-glide
    for (const f of body) expect(Math.abs(centsOf(f, expected(f.t)))).toBeLessThan(20);
  });

  it('a fall holds the pitch, then drops while fading out', () => {
    const d = def({ kind: 'fall', demo: { timbre: 'sine', vibrato: null } });
    const { frames: fs } = sound(d, { notes: [note(62, 0, 2), note(62, 2, 3.5, 55)], cues: [cue(0, CUE.fall)] }, 5);
    const held = voiced(within(fs, 0.3, 1.8)).map((f) => centsOf(f, 62));
    expect(Math.abs(mean(held))).toBeLessThan(3);
    const rmsDb = (a: number, b: number) => mean(within(fs, a, b).map((f) => f.rmsDb));
    expect(rmsDb(1.0, 1.8) - rmsDb(3.1, 3.4)).toBeGreaterThan(8); // clearly quieter by the bottom of the fall
    const mid = voiced(within(fs, 2.7, 2.9));
    expect(mean(mid.map((f) => f.midi))).toBeLessThan(60); // pitch has fallen well below 62 by the middle of the drop
    expect(FALL_END_GAIN).toBeLessThan(0.3);
  });
});

// ---------------------------------------------------------------- dynamics

describe('what the dynamics demos sound like', () => {
  const d = def({ kind: 'swell', demo: { timbre: 'soft', vibrato: null }, analyzers: ['dynamics', 'accuracy'] });
  const rmsOf = (fs: PitchFrame[], a: number, b: number) => mean(within(fs, a, b).map((f) => f.rmsDb));

  it('messa di voce: soft, grow to full, fade to soft on a pitch that does not move; the dynamics analyzer agrees', () => {
    const { frames: fs } = sound(d, { notes: [note(60, 0, 8)], cues: [cue(0, CUE.swell)] }, 9);
    const peak = rmsOf(fs, 3.6, 4.4);
    expect(peak - rmsOf(fs, 0.3, 0.9)).toBeGreaterThan(10); // starts well below the peak...
    expect(peak - rmsOf(fs, 7.2, 7.7)).toBeGreaterThan(10); //  ...and ends well below it
    const v = voiced(within(fs, 0.6, 7.6)).map((f) => centsOf(f, 60));
    expect(Math.abs(mean(v))).toBeLessThan(3);
    expect(sd(v)).toBeLessThan(4);
    const r = analyzeDynamics(within(fs, 0, 8), note(60, 0, 8), ctxFor('pop'));
    expect(r.rangeDb).toBeGreaterThanOrEqual(CONFIG.dynamics.minRangeDb);
    expect(Math.abs(r.slopeCentsPerDb as number)).toBeLessThan(CONFIG.dynamics.maxDriftCentsPerDb);
    expect(r.verdict).toBe('steady');
    expect(r.symmetry as number).toBeGreaterThan(0.75); // a messa di voce is as long to fade as to grow
    expect(r.peakPosition as number).toBeGreaterThan(0.4);
    expect(r.peakPosition as number).toBeLessThan(0.6);
  });

  it('crescendo rises and decrescendo falls, in level', () => {
    const up = sound(d, { notes: [note(60, 0, 5)], cues: [cue(0, CUE.crescendo)] }, 6).frames;
    expect(rmsOf(up, 4.0, 4.8)).toBeGreaterThan(rmsOf(up, 2.0, 2.8) + 3);
    expect(rmsOf(up, 2.0, 2.8)).toBeGreaterThan(rmsOf(up, 0.3, 0.9) + 3);
    const down = sound(d, { notes: [note(60, 0, 5)], cues: [cue(0, CUE.decrescendo)] }, 6).frames;
    expect(rmsOf(down, 0.3, 0.9)).toBeGreaterThan(rmsOf(down, 2.0, 2.8) + 3);
    expect(rmsOf(down, 2.0, 2.8)).toBeGreaterThan(rmsOf(down, 4.0, 4.8) + 3);
    expect(analyzeDynamics(within(up, 0, 5), note(60, 0, 5), ctxFor('pop')).rangeDb).toBeGreaterThanOrEqual(CONFIG.dynamics.minRangeDb);
  });

  it('dynamic steps: soft, loud, soft in one unbroken tone, at least the required range apart', () => {
    const notes = [note(60, 0, 2), note(60, 2, 4), note(60, 4, 6)];
    const { frames: fs } = sound(d, { notes, cues: [cue(0, 'Soft'), cue(2, 'Loud'), cue(4, 'Soft')] }, 7);
    const soft1 = rmsOf(fs, 0.5, 1.8);
    const loud = rmsOf(fs, 2.4, 3.8);
    const soft2 = rmsOf(fs, 4.4, 5.8);
    expect(loud - soft1).toBeGreaterThanOrEqual(CONFIG.dynamics.minRangeDb);
    expect(loud - soft2).toBeGreaterThanOrEqual(CONFIG.dynamics.minRangeDb);
    expect(Math.abs(soft1 - soft2)).toBeLessThan(2);
    expect(within(fs, 0.4, 5.9).filter((f) => !f.voiced)).toHaveLength(0); // one tone: no re-attack between the steps
    const pitch = voiced(within(fs, 0.4, 5.9)).map((f) => centsOf(f, 60));
    expect(sd(pitch)).toBeLessThan(3);
    expect(SWELL_SOFT_GAIN).toBeLessThan(0.2);
  });
});
