import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../config';
import { midiToHz } from '../core/music';
import type { TargetNote } from '../core/types';
import { CUE } from '../exercises/cues';
import type { ExerciseDef, ExerciseKind } from '../exercises/types';
import {
  BLOOM_FADE_IN_SEC,
  DEFAULT_DEMO_GAIN,
  FALL_END_GAIN,
  MIN_PULSE_STEPS,
  PASS_GAP_SEC,
  PULSE_DEMO_EXTENT_CENTS,
  SLOW_DEMO_FACTOR,
  STEP_RAMP_SEC,
  SWELL_SOFT_GAIN,
  SWITCH_FADE_SEC,
  buildDemo,
  demoLayout,
  firstPassSec,
  levelOfCue,
  parseSwellShape,
  planDemoVoices,
  resolveDemoVibrato,
  styleZoneVibrato,
  type DemoLayout,
  type DemoOptions,
  type DemoRealized,
} from './demos';
import { musicalClickGain } from './synth';
import type { GlideSpec, MetronomeHandle, NoteSpec, ReferenceSynth, ScheduledHandle, SequenceNote, Timbre } from './synth-types';

// ---------------------------------------------------------------- fake Web Audio graph

interface AutomationEvent {
  method: 'setValueAtTime' | 'linearRampToValueAtTime' | 'exponentialRampToValueAtTime' | 'cancelScheduledValues';
  value?: number;
  time: number;
}

class FakeParam {
  value = 0;
  events: AutomationEvent[] = [];
  setValueAtTime(value: number, time: number): this {
    this.events.push({ method: 'setValueAtTime', value, time });
    this.value = value;
    return this;
  }
  linearRampToValueAtTime(value: number, time: number): this {
    this.events.push({ method: 'linearRampToValueAtTime', value, time });
    this.value = value;
    return this;
  }
  exponentialRampToValueAtTime(value: number, time: number): this {
    // The real thing throws on a non-positive target; the fake should too, so a bad schedule fails here.
    if (!(value > 0)) throw new RangeError('exponentialRampToValueAtTime: target must be > 0');
    this.events.push({ method: 'exponentialRampToValueAtTime', value, time });
    this.value = value;
    return this;
  }
  cancelScheduledValues(time: number): this {
    this.events.push({ method: 'cancelScheduledValues', time });
    return this;
  }
}

class FakeNode {
  connections: unknown[] = [];
  connect(dest: unknown): unknown {
    this.connections.push(dest);
    return dest;
  }
}

class FakeOsc extends FakeNode {
  type = 'sine';
  frequency = new FakeParam();
  detune = new FakeParam();
  periodicWave: unknown = null;
  startTimes: number[] = [];
  stopTimes: number[] = [];
  private ended: Array<() => void> = [];
  setPeriodicWave(w: unknown): void {
    this.periodicWave = w;
  }
  start(when = 0): void {
    this.startTimes.push(when);
  }
  stop(when = 0): void {
    this.stopTimes.push(when);
  }
  addEventListener(type: string, cb: () => void): void {
    if (type === 'ended') this.ended.push(cb);
  }
  fireEnded(): void {
    for (const cb of this.ended) cb();
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeCtx {
  currentTime = 0;
  oscs: FakeOsc[] = [];
  gains: FakeGain[] = [];
  waves: Array<{ real: Float32Array; imag: Float32Array }> = [];
  createOscillator(): FakeOsc {
    const o = new FakeOsc();
    this.oscs.push(o);
    return o;
  }
  createGain(): FakeGain {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createPeriodicWave(real: Float32Array, imag: Float32Array): { real: Float32Array; imag: Float32Array } {
    const w = { real, imag };
    this.waves.push(w);
    return w;
  }
}

/** The value of an AudioParam timeline at time `t`, per the Web Audio automation rules (events at one time keep insertion order). */
function valueAt(events: AutomationEvent[], t: number): number {
  const evs = events
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.method !== 'cancelScheduledValues')
    .sort((a, b) => a.e.time - b.e.time || a.i - b.i)
    .map(({ e }) => e);
  let prevT = -Infinity;
  let prevV = 0;
  for (const e of evs) {
    const v = e.value as number;
    if (e.method === 'setValueAtTime') {
      if (t < e.time) return prevV;
    } else if (t < e.time) {
      const u = (t - prevT) / (e.time - prevT);
      return e.method === 'linearRampToValueAtTime' ? prevV + (v - prevV) * u : prevV * Math.pow(v / prevV, u);
    }
    prevT = e.time;
    prevV = v;
  }
  return prevV;
}

// ---------------------------------------------------------------- fake synth

interface SynthCall {
  method: 'playNote' | 'playGlide' | 'playSequence' | 'startMetronome';
  spec?: NoteSpec | GlideSpec;
  notes?: readonly SequenceNote[];
  opts?: { startAt?: number; timbre?: Timbre; gain?: number; beatsPerBar?: number; countInBeats?: number };
  bpm?: number;
}

class FakeSynth implements ReferenceSynth {
  calls: SynthCall[] = [];
  handles: Array<ScheduledHandle & { stopped: boolean }> = [];
  metronomes: Array<MetronomeHandle & { stopped: boolean }> = [];

  private handle(startAt: number, endAt: number): ScheduledHandle {
    const h = {
      startAt,
      endAt,
      stopped: false,
      stop(): void {
        h.stopped = true;
      },
    };
    this.handles.push(h);
    return h;
  }
  setVolume(): void {}
  playNote(spec: NoteSpec): ScheduledHandle {
    this.calls.push({ method: 'playNote', spec });
    const s = spec.startAt as number;
    return this.handle(s, s + spec.duration + 0.06);
  }
  playGlide(spec: GlideSpec): ScheduledHandle {
    this.calls.push({ method: 'playGlide', spec });
    const s = spec.startAt as number;
    return this.handle(s, s + spec.holdBefore + spec.glideDuration + spec.holdAfter + 0.06);
  }
  playSequence(notes: readonly SequenceNote[], opts?: { startAt?: number; timbre?: Timbre; gain?: number }): ScheduledHandle {
    this.calls.push({ method: 'playSequence', notes, opts });
    const s = opts?.startAt as number;
    return this.handle(s, s + Math.max(...notes.map((n) => n.start + n.duration)) + 0.06);
  }
  click(): void {}
  startMetronome(bpm: number, opts?: { beatsPerBar?: number; startAt?: number; countInBeats?: number }): MetronomeHandle {
    this.calls.push({ method: 'startMetronome', bpm, opts });
    const m = {
      startAt: opts?.startAt ?? 0,
      endAt: Infinity,
      bpm,
      beat0: opts?.startAt ?? 0,
      stopped: false,
      setBpm(): void {},
      stop(): void {
        m.stopped = true;
      },
    };
    this.metronomes.push(m);
    return m;
  }
  stopAll(): void {}

  of(method: SynthCall['method']): SynthCall[] {
    return this.calls.filter((c) => c.method === method);
  }
}

// ---------------------------------------------------------------- builders

function makeDef(over: Partial<ExerciseDef> & Pick<ExerciseDef, 'kind'>): ExerciseDef {
  return {
    id: `test.${over.kind}`,
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

function realized(over: Partial<DemoRealized> & Pick<DemoRealized, 'notes'>): DemoRealized {
  return { tonicMidi: 60, cues: [], bpm: 60, ...over };
}

const START = 100;
const PEAK = DEFAULT_DEMO_GAIN;

let ctx: FakeCtx;
let dest: FakeNode;
let synth: FakeSynth;
let made: ScheduledHandle[] = [];

function demo(def: ExerciseDef, r: DemoRealized, opts: DemoOptions = {}): ScheduledHandle {
  const h = buildDemo(def, r, synth, ctx as unknown as BaseAudioContext, dest as unknown as AudioNode, { startAt: START, ...opts });
  made.push(h);
  return h;
}

beforeEach(() => {
  ctx = new FakeCtx();
  ctx.currentTime = START - 0.05;
  dest = new FakeNode();
  synth = new FakeSynth();
  made = [];
});

afterEach(() => {
  for (const h of made) h.stop(); // clears any metronome timer the test left pending
  vi.useRealTimers();
});

// ---------------------------------------------------------------- vibrato resolution

describe('resolveDemoVibrato', () => {
  it("'style' is the midpoint of the style's rate and extent zone", () => {
    for (const style of ['pop', 'classical'] as const) {
      const z = CONFIG.vibrato.styles[style];
      const v = resolveDemoVibrato('style', style);
      expect(v).toEqual({ rateHz: (z.rateHz[0] + z.rateHz[1]) / 2, extentCents: (z.extentCents[0] + z.extentCents[1]) / 2 });
      expect(styleZoneVibrato(style)).toEqual(v);
    }
    // The two styles share a rate and differ in extent (RESEARCH §6): the demo must let the singer hear that.
    expect(resolveDemoVibrato('style', 'classical')!.extentCents).toBeGreaterThan(resolveDemoVibrato('style', 'pop')!.extentCents);
  });

  it('copies an explicit spec and returns null for none', () => {
    const spec = { rateHz: 4, extentCents: 25 };
    const out = resolveDemoVibrato(spec, 'pop');
    expect(out).toEqual(spec);
    expect(out).not.toBe(spec);
    expect(resolveDemoVibrato(null, 'pop')).toBeNull();
    expect(resolveDemoVibrato(undefined, 'pop')).toBeNull();
  });
});

// ---------------------------------------------------------------- dynamics cues

describe('levelOfCue', () => {
  it('reads a step cue that names one level', () => {
    expect(levelOfCue('Soft')).toBe('soft');
    expect(levelOfCue('Loud')).toBe('loud');
    expect(levelOfCue('whisper')).toBe('soft');
    expect(levelOfCue('Full voice')).toBe('loud');
  });

  it('is null for mixed levels, shapes, and cues that are not about loudness', () => {
    for (const c of ['Soft, loud', 'Start soft, grow to full', 'Fade to soft', CUE.bloom, CUE.crescendo, 'Hold it steady', '', undefined]) {
      expect(levelOfCue(c)).toBeNull();
    }
  });
});

describe('parseSwellShape (free-text dynamics cues)', () => {
  it('reads stops and the verbs between them', () => {
    expect(parseSwellShape('Start soft, grow to full')).toEqual({ points: ['soft', 'loud'], smooth: true });
    expect(parseSwellShape('Start full, fade to soft')).toEqual({ points: ['loud', 'soft'], smooth: true });
    expect(parseSwellShape('Soft, grow, then fade: pitch still')).toEqual({ points: ['soft', 'loud', 'soft'], smooth: true });
    expect(parseSwellShape('Fade to a whisper, pitch steady')).toEqual({ points: ['loud', 'soft'], smooth: true });
    expect(parseSwellShape('Soft, loud, soft: change on the clicks')).toEqual({ points: ['soft', 'loud', 'soft'], smooth: false });
  });

  it('says nothing for cues that are not about loudness, or name a single level', () => {
    for (const c of ['Let the vibrato spin freely', 'Hold it steady and straight', 'Sing', CUE.listen, CUE.bloom, '', undefined, 'Soft']) {
      expect(parseSwellShape(c)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------- plain material, count-in, reference

describe('buildDemo: plain notes, count-in and reference audio', () => {
  const def = makeDef({ kind: 'sustain', metronome: true, countInBeats: 2, tempoBpm: 60, demo: { timbre: 'soft', vibrato: null } });
  const r = realized({
    notes: [note(60, 0, 4), note(64, 5, 7)],
    reference: [note(60, -2, 0)], // the starting pitch during the count-in
    countInSec: 2,
    totalSec: 8,
  });

  it('clicks the count-in then keeps time; the downbeat falls a count-in after startAt', () => {
    const h = demo(def, r);
    const m = synth.of('startMetronome');
    expect(m).toHaveLength(1);
    expect(m[0].bpm).toBe(60);
    expect(m[0].opts).toEqual({ startAt: START + 2, countInBeats: 2, gain: musicalClickGain(PEAK) }); // beat 0 = the downbeat
    expect(h.startAt).toBe(START);
    // Nothing sounds past the end of the pattern (downbeat + totalSec), and the clicks run to it.
    expect(h.endAt).toBeCloseTo(START + 2 + 8, 9);
  });

  it('plays reference tones and sung notes as one sequence on the demo timbre and gain', () => {
    demo(def, r);
    const seq = synth.of('playSequence');
    expect(seq).toHaveLength(1);
    expect(seq[0].opts).toEqual({ startAt: START, timbre: 'soft', gain: PEAK });
    // Relative to the sequence start (the count-in tone at downbeat - 2). The count-in tone ends a release (60 ms)
    // before the downbeat, so it has faded out when the first note, on the same pitch, begins.
    expect(seq[0].notes).toHaveLength(3);
    expect(seq[0].notes![0]).toMatchObject({ midi: 60, start: 0 });
    expect(seq[0].notes![0].duration).toBeCloseTo(2 - 0.06, 9);
    expect(seq[0].notes!.slice(1)).toEqual([
      { midi: 60, start: 2, duration: 4 },
      { midi: 64, start: 7, duration: 2 },
    ]);
    expect(synth.of('playNote')).toHaveLength(0);
    expect(ctx.oscs).toHaveLength(0); // no custom voices for plain material
  });

  it('never lets a reference tone sound under the note it leads into (the Range finder count-in), but keeps a tone with a rest after it whole', () => {
    demo(def, realized({ notes: [note(60, 0, 2), note(64, 4, 6)], reference: [note(60, -2, 0), note(64, 2.5, 3.98)], countInSec: 2, totalSec: 6 }));
    const notes = synth.of('playSequence')[0].notes!;
    const ends = notes.map((n) => START + n.start + n.duration);
    // The count-in tone (sequence start = START) releases before the downbeat at START + 2.
    expect(ends[0] + 0.06).toBeLessThanOrEqual(START + 2 + 1e-9);
    // The tone at 2.5 (sequence offset 4.5) that would still be releasing when the note at 4 starts ends a release before it.
    const second = notes.find((n) => n.midi === 64 && Math.abs(n.start - 4.5) < 1e-9)!;
    expect(second.duration).toBeLessThan(3.98 - 2.5);
    expect(START + second.start + second.duration + 0.06).toBeLessThanOrEqual(START + 2 + 4 + 1e-9);
    // A Listen tone with a rest after it (Pitch match) is untouched.
    synth = new FakeSynth();
    demo(makeDef({ kind: 'pitch-match' }), realized({ reference: [note(60, 0, 2)], notes: [note(60, 3, 6)] }));
    expect(synth.of('playSequence')[0].notes![0].duration).toBe(2);
  });

  it('connects its own shaped voices to the synth\'s mix (ahead of its limiter) when the synth offers one', () => {
    const swell = makeDef({ kind: 'swell', analyzers: ['dynamics'] });
    const r2 = realized({ notes: [note(60, 0, 4)], cues: [cue(0, CUE.swell)] });
    const bus = new FakeNode();
    Object.assign(synth, { input: bus });
    demo(swell, r2);
    expect(ctx.oscs.length).toBeGreaterThan(0);
    expect(ctx.gains.some((g) => g.connections.includes(bus))).toBe(true);
    expect(ctx.gains.some((g) => g.connections.includes(dest))).toBe(false);
  });

  it('a pattern without a metronome starts no metronome, and an exercise with nothing before the downbeat starts at startAt', () => {
    const plain = makeDef({ kind: 'legato', demo: { timbre: 'piano', vibrato: null } });
    const h = demo(plain, realized({ notes: [note(60, 0, 1), note(62, 1, 2), note(64, 2, 3)] }));
    expect(synth.of('startMetronome')).toHaveLength(0);
    const seq = synth.of('playSequence');
    expect(seq).toHaveLength(1);
    expect(seq[0].opts).toEqual({ startAt: START, timbre: 'piano', gain: PEAK });
    expect(h.startAt).toBe(START);
    expect(h.endAt).toBeCloseTo(START + 3 + 0.06, 9);
  });

  it('keeps contiguous same-pitch notes as separate re-articulated notes', () => {
    const d = makeDef({ kind: 'staccato', demo: { timbre: 'piano', vibrato: null } });
    demo(d, realized({ notes: [note(60, 0, 0.5), note(60, 0.5, 1), note(60, 1, 1.5)] }));
    expect(synth.of('playSequence')[0].notes).toHaveLength(3);
    expect(synth.of('playNote')).toHaveLength(0);
  });

  it('defaults startAt to just after now', () => {
    ctx.currentTime = 12;
    const d = makeDef({ kind: 'sustain' });
    const h = buildDemo(d, realized({ notes: [note(60, 0, 2)] }), synth, ctx as unknown as BaseAudioContext, dest as unknown as AudioNode);
    made.push(h);
    expect(h.startAt).toBeGreaterThan(12);
    expect(h.startAt).toBeLessThan(12.2);
  });

  it('pitch match: the Listen tone and the sung target both sound, in time order', () => {
    const d = makeDef({ kind: 'pitch-match', demo: { timbre: 'piano', vibrato: null } });
    demo(
      d,
      realized({
        reference: [note(60, 0, 2), note(64, 7, 9)],
        notes: [note(60, 3, 6), note(64, 10, 13)],
        cues: [cue(0, CUE.listen), cue(3, CUE.sing), cue(7, CUE.listen), cue(10, CUE.sing)],
      }),
    );
    expect(synth.of('playSequence')[0].notes!.map((n) => [n.midi, n.start])).toEqual([[60, 0], [60, 3], [64, 7], [64, 10]]);
  });

  it('applies and clamps opts.gain', () => {
    const d = makeDef({ kind: 'sustain' });
    demo(d, realized({ notes: [note(60, 0, 2)] }), { gain: 0.25 });
    expect(synth.of('playSequence')[0].opts!.gain).toBe(0.25);
    synth = new FakeSynth();
    demo(d, realized({ notes: [note(60, 0, 2)] }), { gain: 7 });
    expect(synth.of('playSequence')[0].opts!.gain).toBe(1);
  });
});

describe('buildDemo: handle', () => {
  const def = makeDef({ kind: 'sustain', metronome: true, countInBeats: 2 });
  const r = realized({ notes: [note(60, 0, 4)], reference: [note(60, -2, 0)], countInSec: 2, totalSec: 5 });

  it('stops the metronome when the pattern ends (not before)', () => {
    vi.useFakeTimers();
    demo(def, r);
    const m = synth.metronomes[0];
    const waitMs = (START + 2 + 5 - ctx.currentTime) * 1000;
    vi.advanceTimersByTime(waitMs - 5);
    expect(m.stopped).toBe(false);
    vi.advanceTimersByTime(10);
    expect(m.stopped).toBe(true);
  });

  it('stop() releases every voice and the metronome, cancels the timer, and is idempotent', () => {
    vi.useFakeTimers();
    const shapedDef = makeDef({ kind: 'swell', metronome: true, countInBeats: 2 });
    const h = demo(shapedDef, realized({ notes: [note(60, 0, 4), note(62, 6, 8)], cues: [cue(0, CUE.swell), cue(6, CUE.swell)], countInSec: 2, totalSec: 8 }));
    expect(ctx.oscs.length).toBeGreaterThan(0);
    ctx.currentTime = START + 3;
    h.stop();
    h.stop();
    expect(synth.metronomes[0].stopped).toBe(true);
    // A custom voice was cut short: schedule cancelled, ramp to 0, oscillator stopped shortly after.
    const g = ctx.gains[0].gain;
    expect(g.events.some((e) => e.method === 'cancelScheduledValues' && e.time === START + 3)).toBe(true);
    const last = g.events[g.events.length - 1];
    expect(last.method).toBe('linearRampToValueAtTime');
    expect(last.value).toBe(0);
    expect(ctx.oscs[0].stopTimes[ctx.oscs[0].stopTimes.length - 1]).toBeGreaterThan(START + 3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a custom voice that already ended is not stopped again', () => {
    const d = makeDef({ kind: 'swell' });
    const h = demo(d, realized({ notes: [note(60, 0, 2)], cues: [cue(0, CUE.crescendo)] }));
    ctx.oscs[0].fireEnded();
    const stops = ctx.oscs[0].stopTimes.length;
    h.stop();
    expect(ctx.oscs[0].stopTimes).toHaveLength(stops);
  });

  it('stops synth voices too', () => {
    const h = demo(makeDef({ kind: 'sustain' }), realized({ notes: [note(60, 0, 2)] }));
    expect(synth.handles.every((x) => !x.stopped)).toBe(true);
    h.stop();
    expect(synth.handles.every((x) => x.stopped)).toBe(true);
  });

  it('an empty exercise schedules nothing and does not throw', () => {
    const h = demo(makeDef({ kind: 'sustain' }), realized({ notes: [] }));
    expect(synth.calls).toHaveLength(0);
    expect(h.endAt).toBeGreaterThanOrEqual(h.startAt);
    h.stop();
  });
});

// ---------------------------------------------------------------- vibrato

describe('buildDemo: vibrato demos use the style zone', () => {
  const meter = makeDef({ kind: 'vibrato-meter', demo: { timbre: 'soft', vibrato: 'style' } });
  const r = realized({ notes: [note(60, 0, 5), note(64, 6, 11), note(67, 12, 17)] });

  it('pop: each long note is one tone with the pop-zone midpoint vibrato', () => {
    demo(meter, r, { vibratoStyle: 'pop' });
    const notes = synth.of('playNote').map((c) => c.spec as NoteSpec);
    expect(notes).toHaveLength(3);
    const z = CONFIG.vibrato.styles.pop;
    for (const n of notes) {
      expect(n.vibrato).toEqual({ rateHz: (z.rateHz[0] + z.rateHz[1]) / 2, extentCents: (z.extentCents[0] + z.extentCents[1]) / 2 });
      expect(n.timbre).toBe('soft');
      expect(n.gain).toBe(PEAK);
    }
    expect(notes.map((n) => [n.midi, n.startAt, n.duration])).toEqual([[60, START, 5], [64, START + 6, 5], [67, START + 12, 5]]);
  });

  it('classical: same rate, wider extent', () => {
    demo(meter, r, { vibratoStyle: 'classical' });
    const popExtent = styleZoneVibrato('pop').extentCents;
    for (const c of synth.of('playNote')) {
      const v = (c.spec as NoteSpec).vibrato!;
      expect(v.rateHz).toBe(styleZoneVibrato('classical').rateHz);
      expect(v.extentCents).toBe(styleZoneVibrato('classical').extentCents);
      expect(v.extentCents).toBeGreaterThan(popExtent);
    }
  });

  it('defaults to the pop zone', () => {
    demo(meter, r);
    expect((synth.of('playNote')[0].spec as NoteSpec).vibrato).toEqual(styleZoneVibrato('pop'));
  });

  it('passes an explicit vibrato spec through unchanged', () => {
    const d = makeDef({ kind: 'vibrato-meter', demo: { timbre: 'soft', vibrato: { rateHz: 4.2, extentCents: 25 } } });
    demo(d, r);
    expect((synth.of('playNote')[0].spec as NoteSpec).vibrato).toEqual({ rateHz: 4.2, extentCents: 25 });
  });

  it('notes too short to hold a vibrato stay straight', () => {
    demo(meter, realized({ notes: [note(60, 0, 0.4), note(62, 1, 4)] }));
    const seq = synth.of('playSequence');
    expect(seq).toHaveLength(1);
    expect(seq[0].notes).toEqual([{ midi: 60, start: 0, duration: 0.4 }]);
    expect(synth.of('playNote')).toHaveLength(1);
  });

  it('no vibrato spec means straight tones', () => {
    demo(makeDef({ kind: 'sustain', demo: { timbre: 'soft', vibrato: null } }), r);
    expect(synth.of('playNote')).toHaveLength(0);
    expect(synth.of('playSequence')).toHaveLength(1);
  });
});

describe('buildDemo: straight to bloom', () => {
  const def = makeDef({ kind: 'straight-to-bloom', metronome: false, demo: { timbre: 'soft', vibrato: 'style' } });

  it('is ONE tone per pitch: straight for the delay, then vibrato fades in (delaySec + fadeInSec)', () => {
    demo(
      def,
      realized({
        notes: [note(60, 0, 3), note(60, 3, 6), note(62, 8, 10), note(62, 10, 14)],
        cues: [cue(0, CUE.straight), cue(3, CUE.bloom), cue(8, CUE.straight), cue(10, CUE.bloom)],
      }),
      { vibratoStyle: 'pop' },
    );
    const notes = synth.of('playNote').map((c) => c.spec as NoteSpec);
    expect(notes).toHaveLength(2);
    expect(synth.of('playSequence')).toHaveLength(0);
    const zone = styleZoneVibrato('pop');
    expect(notes[0]).toMatchObject({ midi: 60, startAt: START, duration: 6, vibrato: { ...zone, delaySec: 3, fadeInSec: BLOOM_FADE_IN_SEC } });
    expect(notes[1]).toMatchObject({ midi: 62, startAt: START + 8, duration: 6, vibrato: { ...zone, delaySec: 2, fadeInSec: BLOOM_FADE_IN_SEC } });
  });

  it('an uncued step keeps the state of the cue before it, within the held note', () => {
    demo(def, realized({ notes: [note(60, 0, 2), note(60, 2, 4), note(60, 4, 6)], cues: [cue(0, CUE.straight), cue(4, CUE.bloom)] }));
    expect((synth.of('playNote')[0].spec as NoteSpec).vibrato).toMatchObject({ delaySec: 4, fadeInSec: BLOOM_FADE_IN_SEC });
  });

  it('a bloom segment shorter than the fade shortens the fade', () => {
    demo(def, realized({ notes: [note(60, 0, 2), note(60, 2, 2.2)], cues: [cue(0, CUE.straight), cue(2, CUE.bloom)] }));
    expect((synth.of('playNote')[0].spec as NoteSpec).vibrato!.fadeInSec).toBeCloseTo(0.2, 9);
  });

  it('"Vibrato on" switches in faster than a bloom', () => {
    demo(def, realized({ notes: [note(60, 0, 2), note(60, 2, 4)], cues: [cue(0, CUE.straight), cue(2, CUE.vibrato)] }));
    expect((synth.of('playNote')[0].spec as NoteSpec).vibrato).toMatchObject({ delaySec: 2, fadeInSec: SWITCH_FADE_SEC });
    expect(SWITCH_FADE_SEC).toBeLessThan(BLOOM_FADE_IN_SEC);
  });

  it('with no explicit demo vibrato the bloom still uses the style zone (a bloom demo with no vibrato would be useless)', () => {
    const d = makeDef({ kind: 'straight-to-bloom', demo: { timbre: 'soft', vibrato: null } });
    demo(d, realized({ notes: [note(60, 0, 2), note(60, 2, 4)], cues: [cue(0, CUE.straight), cue(2, CUE.bloom)] }), { vibratoStyle: 'classical' });
    expect((synth.of('playNote')[0].spec as NoteSpec).vibrato).toMatchObject(styleZoneVibrato('classical'));
  });

  it('a window that never turns vibrato on is a plain straight tone', () => {
    demo(def, realized({ notes: [note(60, 0, 2), note(60, 2, 4)], cues: [cue(0, CUE.straight)] }));
    expect(synth.of('playNote')).toHaveLength(0);
    expect(synth.of('playSequence')[0].notes).toEqual([{ midi: 60, start: 0, duration: 4 }]);
  });

  it('a vibrato cue does not leak into the next held note', () => {
    const d = makeDef({ kind: 'straight-to-bloom', demo: { timbre: 'soft', vibrato: null } });
    demo(d, realized({ notes: [note(60, 0, 2), note(62, 4, 6)], cues: [cue(0, CUE.bloom)] }));
    expect(synth.of('playNote')).toHaveLength(1); // only the cued note has vibrato
    const seq = synth.of('playSequence')[0];
    expect(seq.notes).toEqual([{ midi: 62, start: 0, duration: 2 }]); // a sequence is relative to its own first note...
    expect(seq.opts!.startAt).toBe(START + 4); //                        ...which sounds at the downbeat + 4
  });
});

describe('buildDemo: on/off vibrato switching', () => {
  const def = makeDef({ kind: 'vibrato-switch', demo: { timbre: 'soft', vibrato: 'style' } });
  const zone = styleZoneVibrato('pop');

  /** One held note cut into 2 s steps, each cued straight (false) or vibrato on (true). */
  function switching(states: boolean[], on: string = CUE.vibrato, segSec = 2): DemoRealized {
    return realized({
      notes: states.map((_, i) => note(60, i * segSec, (i + 1) * segSec)),
      cues: states.map((v, i) => cue(i * segSec, v ? on : CUE.straight)),
    });
  }

  it('is one tone whose vibrato depth follows the cues: off, on, off, on, off', () => {
    demo(def, switching([false, true, false, true, false]), { vibratoStyle: 'pop' });
    expect(synth.calls).toHaveLength(0); // the synth cannot switch vibrato off: a custom voice does
    expect(ctx.oscs).toHaveLength(2); //   the tone and its LFO
    const [tone, lfo] = ctx.oscs;
    expect(lfo.frequency.value).toBe(zone.rateHz);
    // One tone: the pitch never moves.
    for (const e of tone.frequency.events) expect(e.value).toBeCloseTo(midiToHz(60), 9);
    const depth = ctx.gains[1].gain.events; // gains[0] is the level envelope, gains[1] the LFO depth
    const at = (t: number) => valueAt(depth, START + t);
    expect(at(1)).toBe(0);
    expect(at(3)).toBeCloseTo(zone.extentCents, 9);
    expect(at(5)).toBe(0);
    expect(at(7)).toBeCloseTo(zone.extentCents, 9);
    expect(at(9)).toBe(0);
    // A switch takes SWITCH_FADE_SEC, starting on the cue.
    expect(at(2)).toBe(0);
    expect(at(2 + SWITCH_FADE_SEC / 2)).toBeCloseTo(zone.extentCents / 2, 6);
    expect(at(2 + SWITCH_FADE_SEC)).toBeCloseTo(zone.extentCents, 9);
    expect(at(4)).toBeCloseTo(zone.extentCents, 9);
    expect(at(4 + SWITCH_FADE_SEC / 2)).toBeCloseTo(zone.extentCents / 2, 6);
    // The LFO is wired into the tone's detune, the tone into dest.
    expect(lfo.connections).toHaveLength(1);
    expect((lfo.connections[0] as FakeGain).connections).toEqual([tone.detune]);
    expect((ctx.gains[0] as FakeGain).connections).toEqual([dest]);
  });

  it('a bloom cue fades vibrato in slowly even inside a switching tone', () => {
    demo(def, switching([false, true, false], CUE.bloom));
    const depth = ctx.gains[1].gain.events;
    expect(valueAt(depth, START + 2 + BLOOM_FADE_IN_SEC / 2)).toBeCloseTo(zone.extentCents / 2, 6);
    expect(valueAt(depth, START + 2 + BLOOM_FADE_IN_SEC)).toBeCloseTo(zone.extentCents, 9);
    // ... but switching back off is always quick.
    expect(valueAt(depth, START + 4 + SWITCH_FADE_SEC / 2)).toBeCloseTo(zone.extentCents / 2, 6);
  });

  it('starting on: full vibrato from the first sample, then off, then on', () => {
    demo(def, switching([true, false, true]));
    const depth = ctx.gains[1].gain.events;
    expect(valueAt(depth, START + 1)).toBeCloseTo(zone.extentCents, 9);
    expect(valueAt(depth, START + 3)).toBe(0);
    expect(valueAt(depth, START + 5)).toBeCloseTo(zone.extentCents, 9);
  });

  it('uses the classical zone when asked', () => {
    demo(def, switching([false, true, false]), { vibratoStyle: 'classical' });
    expect(ctx.oscs[1].frequency.value).toBe(styleZoneVibrato('classical').rateHz);
    expect(valueAt(ctx.gains[1].gain.events, START + 3)).toBeCloseTo(styleZoneVibrato('classical').extentCents, 9);
  });

  it('schedules automation in time order and ends the voice with a release to 0', () => {
    demo(def, switching([true, false, true, false]));
    for (const param of [ctx.oscs[0].frequency, ctx.gains[0].gain, ctx.gains[1].gain]) {
      for (let i = 1; i < param.events.length; i++) expect(param.events[i].time).toBeGreaterThanOrEqual(param.events[i - 1].time);
    }
    const g = ctx.gains[0].gain.events;
    expect(g[0]).toEqual({ method: 'setValueAtTime', value: 0, time: START });
    expect(g[g.length - 1]).toMatchObject({ method: 'linearRampToValueAtTime', value: 0 });
    expect(valueAt(g, START + 3)).toBeCloseTo(PEAK, 9);
    expect(valueAt(g, START + 8 + 0.5)).toBe(0);
  });

  it('a boss-style take chains bloom, switching and a final bloom on different pitches', () => {
    const boss = makeDef({ kind: 'boss-recital', demo: { timbre: 'soft', vibrato: 'style' } });
    demo(
      boss,
      realized({
        notes: [note(60, 0, 3), note(60, 3, 6), note(64, 6, 8), note(64, 8, 10), note(64, 10, 12), note(67, 12, 14), note(67, 14, 18)],
        cues: [cue(0, CUE.straight), cue(3, CUE.bloom), cue(6, CUE.vibrato), cue(8, CUE.straight), cue(10, CUE.vibrato), cue(12, CUE.straight), cue(14, CUE.bloom)],
      }),
    );
    const notes = synth.of('playNote').map((c) => c.spec as NoteSpec);
    expect(notes.map((n) => [n.midi, n.vibrato!.delaySec])).toEqual([[60, 3], [67, 2]]); // two blooms through the synth
    expect(ctx.oscs).toHaveLength(2); //                                                      one switching tone (+ LFO)
  });
});

// ---------------------------------------------------------------- pulses

describe('buildDemo: pitch pulses', () => {
  const def = makeDef({ kind: 'pulse-builder', analyzers: ['pulse', 'accuracy'], tempoBpm: 105, metronome: true, countInBeats: 4, demo: { timbre: 'soft', vibrato: null } });
  const spb = 60 / 105 / 2; // eighth notes: 3.5 pulses a second

  it('one sustained tone per same-pitch chain, wobbling at the pulse rate', () => {
    const pulses = (midi: number, from: number) => Array.from({ length: 12 }, (_, i) => note(midi, from + i * spb, from + (i + 1) * spb));
    demo(def, realized({ bpm: 105, countInSec: 0, notes: [...pulses(60, 0), ...pulses(62, 12 * spb + 1.5)] }));
    const notes = synth.of('playNote').map((c) => c.spec as NoteSpec);
    expect(notes).toHaveLength(2);
    expect(notes[0].midi).toBe(60);
    expect(notes[0].duration).toBeCloseTo(12 * spb, 9);
    expect(notes[0].vibrato!.rateHz).toBeCloseTo(3.5, 9);
    expect(notes[0].vibrato!.extentCents).toBe(PULSE_DEMO_EXTENT_CENTS);
    expect(notes[1].midi).toBe(62);
    expect(synth.of('playSequence')).toHaveLength(0);
    // The metronome keeps the pulse tempo.
    expect(synth.of('startMetronome')[0].bpm).toBe(105);
  });

  it('derives the rate from the note length: triplets at 90 bpm are 4.5 Hz', () => {
    const d = makeDef({ kind: 'pulse-builder', analyzers: ['pulse'], tempoBpm: 90 });
    const third = 60 / 90 / 3;
    demo(d, realized({ bpm: 90, notes: Array.from({ length: 18 }, (_, i) => note(60, i * third, (i + 1) * third)) }));
    expect((synth.of('playNote')[0].spec as NoteSpec).vibrato!.rateHz).toBeCloseTo(4.5, 9);
  });

  it('a pulse train is at least MIN_PULSE_STEPS long; fewer repeats are just notes', () => {
    const d = makeDef({ kind: 'pulse-builder', analyzers: ['pulse'] });
    const few = Array.from({ length: MIN_PULSE_STEPS - 1 }, (_, i) => note(60, i * 0.3, (i + 1) * 0.3));
    demo(d, realized({ notes: few }));
    expect(synth.of('playNote')).toHaveLength(0);
    expect(synth.of('playSequence')[0].notes).toHaveLength(MIN_PULSE_STEPS - 1);
  });

  it('works for any exercise that scores pulses (an audition), and not for one that does not', () => {
    const three = (k: ExerciseKind, analyzers: ExerciseDef['analyzers']) =>
      makeDef({ kind: k, analyzers, demo: { timbre: 'soft', vibrato: null } });
    const notes = Array.from({ length: 6 }, (_, i) => note(60, i * 0.3, (i + 1) * 0.3));
    demo(three('audition', ['pulse', 'accuracy']), realized({ notes }));
    expect(synth.of('playNote')).toHaveLength(1);
    synth = new FakeSynth();
    demo(three('audition', ['accuracy']), realized({ notes }));
    expect(synth.of('playNote')).toHaveLength(0);
    expect(synth.of('playSequence')[0].notes).toHaveLength(6);
  });

  it('an oscillation drill alternates two pitches as discrete notes (it is not a wobble)', () => {
    const d = makeDef({ kind: 'oscillation', analyzers: ['run', 'pulse'], tempoBpm: 80 });
    const eighth = 60 / 80 / 2;
    demo(d, realized({ bpm: 80, notes: Array.from({ length: 8 }, (_, i) => note(i % 2 === 0 ? 60 : 62, i * eighth, (i + 1) * eighth)) }));
    expect(synth.of('playNote')).toHaveLength(0);
    expect(synth.of('playSequence')[0].notes!.map((n) => n.midi)).toEqual([60, 62, 60, 62, 60, 62, 60, 62]);
  });
});

// ---------------------------------------------------------------- glides

describe('buildDemo: glides, slides, scoops, sirens, falls', () => {
  it('a slide is one voice: hold, timed glide, hold (playGlide with holdBefore and holdAfter)', () => {
    const def = makeDef({ kind: 'slide', demo: { timbre: 'sine', vibrato: null } });
    demo(def, realized({ notes: [note(60, 0, 1), note(60, 1, 2, 64), note(64, 2, 4), note(64, 6, 7), note(64, 7, 8, 60), note(60, 8, 10)] }));
    const glides = synth.of('playGlide').map((c) => c.spec as GlideSpec);
    expect(glides).toEqual([
      { fromMidi: 60, toMidi: 64, startAt: START, holdBefore: 1, glideDuration: 1, holdAfter: 2, gain: PEAK, timbre: 'sine' },
      { fromMidi: 64, toMidi: 60, startAt: START + 6, holdBefore: 1, glideDuration: 1, holdAfter: 2, gain: PEAK, timbre: 'sine' },
    ]);
    expect(synth.of('playSequence')).toHaveLength(0);
    expect(synth.of('playNote')).toHaveLength(0);
  });

  it('a scoop is a glide up into the note with the hold after it, no hold before', () => {
    const def = makeDef({ kind: 'scoop', demo: { timbre: 'sine', vibrato: null } });
    demo(def, realized({ notes: [note(58, 0, 0.5, 60), note(60, 0.5, 3)], cues: [cue(0, CUE.scoop)] }));
    const g = synth.of('playGlide')[0].spec as GlideSpec;
    expect(g).toMatchObject({ fromMidi: 58, toMidi: 60, startAt: START, holdBefore: 0, glideDuration: 0.5, holdAfter: 2.5 });
  });

  it('a glide chain does not swallow a following hold that is asked to carry vibrato', () => {
    const def = makeDef({ kind: 'slide', demo: { timbre: 'soft', vibrato: 'style' } });
    demo(def, realized({ notes: [note(60, 0, 1, 64), note(64, 1, 4)], cues: [cue(1, CUE.vibrato)] }));
    expect(synth.of('playGlide')).toHaveLength(1);
    expect((synth.of('playGlide')[0].spec as GlideSpec).holdAfter).toBe(0);
    expect((synth.of('playNote')[0].spec as NoteSpec).vibrato).toBeDefined();
  });

  it('an up-and-down siren is ONE continuous voice following the whole pitch path', () => {
    const def = makeDef({ kind: 'siren', demo: { timbre: 'sine', vibrato: null } });
    demo(def, realized({ notes: [note(60, 0, 1), note(60, 1, 3, 67), note(67, 3, 5, 60)] }));
    expect(synth.calls).toHaveLength(0);
    expect(ctx.oscs).toHaveLength(1);
    const f = ctx.oscs[0].frequency.events;
    expect(f).toEqual([
      { method: 'setValueAtTime', value: midiToHz(60), time: START },
      { method: 'exponentialRampToValueAtTime', value: midiToHz(60), time: START + 1 },
      { method: 'exponentialRampToValueAtTime', value: midiToHz(67), time: START + 3 },
      { method: 'exponentialRampToValueAtTime', value: midiToHz(60), time: START + 5 },
    ]);
    // Linear in pitch: halfway through the first glide is exactly 63.5 semitones.
    expect(12 * Math.log2(valueAt(f, START + 2) / 440) + 69).toBeCloseTo(63.5, 9);
    // The level never dips at the turn-around.
    const g = ctx.gains[0].gain.events;
    for (const t of [0.5, 1, 2, 2.9, 3, 3.1, 4, 4.9]) expect(valueAt(g, START + t)).toBeCloseTo(PEAK, 9);
    expect(ctx.oscs[0].type).toBe('sine');
  });

  it('plays a lesson’s Listen slide as one slide, as it is to be sung: hold, glide, hold, never its ends as two notes (review R9)', () => {
    const def = makeDef({ kind: 'siren', demo: { timbre: 'sine', vibrato: null } });
    demo(
      def,
      realized({
        reference: [note(55, 0, 1), note(55, 1, 3, 57), note(57, 3, 4)],
        notes: [note(55, 5, 6), note(55, 6, 8, 57), note(57, 8, 9)],
        cues: [cue(0, CUE.listen), cue(5, CUE.sing)],
      }),
    );
    const glides = synth.of('playGlide').map((c) => c.spec as GlideSpec);
    expect(glides[0]).toMatchObject({ fromMidi: 55, toMidi: 57, startAt: START, holdBefore: 1, glideDuration: 2, holdAfter: 1 });
    expect(glides[1]).toMatchObject({ fromMidi: 55, toMidi: 57, startAt: START + 5 });
    const plainNotes = synth.of('playSequence').flatMap((c) => c.notes ?? []);
    expect(plainNotes.filter((n) => n.start < 4)).toEqual([]);
  });

  it('plays a Listen siren, up and back down, as one voice following its path (review R9)', () => {
    const def = makeDef({ kind: 'siren', demo: { timbre: 'sine', vibrato: null } });
    demo(def, realized({ reference: [note(51, 0, 1), note(51, 1, 3, 58), note(58, 3, 5, 51)], notes: [note(51, 6, 7)], cues: [cue(0, CUE.listen), cue(6, CUE.sing)] }));
    expect(synth.of('playGlide')).toHaveLength(0);
    expect(ctx.oscs).toHaveLength(1);
    const f = ctx.oscs[0].frequency.events;
    expect(valueAt(f, START + 0.5)).toBeCloseTo(midiToHz(51), 9);
    expect(valueAt(f, START + 3)).toBeCloseTo(midiToHz(58), 9);
    expect(valueAt(f, START + 5)).toBeCloseTo(midiToHz(51), 9);
  });

  it('a glide, a hold and another glide on the same pitch path are one voice too (octave siren with a held top)', () => {
    const def = makeDef({ kind: 'siren', demo: { timbre: 'sine', vibrato: null } });
    demo(def, realized({ notes: [note(60, 0, 3, 72), note(72, 3, 4), note(72, 4, 7, 60)] }));
    expect(ctx.oscs).toHaveLength(1);
    const f = ctx.oscs[0].frequency.events;
    expect(valueAt(f, START + 3.5)).toBeCloseTo(midiToHz(72), 9);
    expect(valueAt(f, START + 7)).toBeCloseTo(midiToHz(60), 9);
  });

  it('range-finder style: hold, glide down, hold are one playGlide', () => {
    const def = makeDef({ kind: 'range-finder', demo: { timbre: 'sine', vibrato: null } });
    demo(def, realized({ notes: [note(60, 0, 2), note(60, 2, 6, 53), note(53, 6, 8), note(60, 10, 12), note(60, 12, 16, 69), note(69, 16, 18)] }));
    const g = synth.of('playGlide').map((c) => c.spec as GlideSpec);
    expect(g).toHaveLength(2);
    expect(g[0]).toMatchObject({ fromMidi: 60, toMidi: 53, holdBefore: 2, glideDuration: 4, holdAfter: 2 });
    expect(g[1]).toMatchObject({ fromMidi: 60, toMidi: 69, startAt: START + 10, holdBefore: 2, glideDuration: 4, holdAfter: 2 });
  });

  describe('falls fade as they drop', () => {
    const fallNotes = [note(60, 0, 2), note(60, 2, 3, 55)];

    it('kind fall: hold, then a downward glide with the level falling to FALL_END_GAIN at the bottom', () => {
      const def = makeDef({ kind: 'fall', demo: { timbre: 'sine', vibrato: null } });
      demo(def, realized({ notes: fallNotes, cues: [cue(0, CUE.fall)] }));
      expect(synth.of('playGlide')).toHaveLength(0);
      expect(ctx.oscs).toHaveLength(1);
      const f = ctx.oscs[0].frequency.events;
      expect(valueAt(f, START + 1.5)).toBeCloseTo(midiToHz(60), 9); // still held
      expect(valueAt(f, START + 3)).toBeCloseTo(midiToHz(55), 9); //   arrived
      const g = ctx.gains[0].gain.events;
      expect(valueAt(g, START + 1.9)).toBeCloseTo(PEAK, 9); //                   full while held
      expect(valueAt(g, START + 3)).toBeCloseTo(PEAK * FALL_END_GAIN, 9); //      faded by the bottom
      let prev = Infinity;
      for (let t = 2; t <= 3; t += 0.05) {
        const v = valueAt(g, START + t);
        expect(v).toBeLessThanOrEqual(prev + 1e-12); // monotonically fading through the fall
        prev = v;
      }
    });

    it('in a capstone the Fall cue makes it a fade; without the cue it is a plain glide', () => {
      const audition = makeDef({ kind: 'audition', demo: { timbre: 'sine', vibrato: null } });
      demo(audition, realized({ notes: fallNotes, cues: [cue(0, CUE.fall)] }));
      expect(ctx.oscs).toHaveLength(1);
      expect(synth.of('playGlide')).toHaveLength(0);
      synth = new FakeSynth();
      ctx = new FakeCtx();
      demo(audition, realized({ notes: fallNotes, cues: [cue(0, 'Hold it steady')] }));
      expect(ctx.oscs).toHaveLength(0);
      expect(synth.of('playGlide')).toHaveLength(1);
    });

    it('a slide that happens to descend is not faded', () => {
      const def = makeDef({ kind: 'slide', demo: { timbre: 'sine', vibrato: null } });
      demo(def, realized({ notes: [note(64, 0, 1), note(64, 1, 2, 60), note(60, 2, 4)], cues: [cue(0, CUE.slide)] }));
      expect(synth.of('playGlide')).toHaveLength(1);
      expect(ctx.oscs).toHaveLength(0);
    });

    it('an upward glide in a fall exercise is not faded', () => {
      const def = makeDef({ kind: 'fall', demo: { timbre: 'sine', vibrato: null } });
      demo(def, realized({ notes: [note(55, 0, 1, 60), note(60, 1, 3)] }));
      expect(synth.of('playGlide')).toHaveLength(1);
      expect(ctx.oscs).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------- note shapes: turns, flips, intervals, runs

describe('buildDemo: turns, flips, intervals and runs are plain notes', () => {
  it('a turn plays its five notes, in order, as one sequence', () => {
    const def = makeDef({ kind: 'turn', demo: { timbre: 'piano', vibrato: null } });
    demo(def, realized({ notes: [note(60, 0, 1), note(62, 1, 1.5), note(60, 1.5, 2), note(59, 2, 2.5), note(60, 2.5, 4)], cues: [cue(0, CUE.turn)] }));
    expect(synth.of('playSequence')[0].notes!.map((n) => n.midi)).toEqual([60, 62, 60, 59, 60]);
  });

  it('a flip is two notes a leap apart, not a glide', () => {
    const def = makeDef({ kind: 'flip', demo: { timbre: 'soft', vibrato: null } });
    demo(def, realized({ notes: [note(62, 0, 2), note(69, 2, 4)], cues: [cue(0, CUE.flip)] }));
    expect(synth.of('playGlide')).toHaveLength(0);
    expect(synth.of('playSequence')[0].notes).toEqual([{ midi: 62, start: 0, duration: 2 }, { midi: 69, start: 2, duration: 2 }]);
  });

  it('a fast run goes out as one playSequence at its true timing', () => {
    const def = makeDef({ kind: 'run', tempoBpm: 180, demo: { timbre: 'piano', vibrato: null } });
    const sixteenth = 60 / 180 / 4;
    const midis = [72, 70, 67, 65, 63, 60, 60];
    demo(def, realized({ bpm: 180, notes: midis.map((m, i) => note(m, i * sixteenth, (i + 1) * sixteenth)) }));
    const seq = synth.of('playSequence');
    expect(seq).toHaveLength(1);
    expect(seq[0].notes!.map((n) => n.midi)).toEqual(midis);
    expect(seq[0].notes![3].start).toBeCloseTo(3 * sixteenth, 9);
    expect(seq[0].notes![3].duration).toBeCloseTo(sixteenth, 9);
    expect(seq[0].opts).toEqual({ startAt: START, timbre: 'piano', gain: PEAK });
  });
});

// ---------------------------------------------------------------- slow first

describe('buildDemo: slow pass first', () => {
  const sixteenth = (bpm: number) => 60 / bpm / 4;
  const midis = [64, 62, 60, 59];
  const def = makeDef({ kind: 'run', tempoBpm: 120, tempoLadder: [60, 90, 120], metronome: true, countInBeats: 2, demo: { timbre: 'piano', vibrato: null, slowFirst: true } });
  const r = realized({
    bpm: 120,
    countInSec: 1,
    notes: midis.map((m, i) => note(m, i * sixteenth(120), (i + 1) * sixteenth(120))),
    reference: [note(64, -1, 0)],
    totalSec: 2,
  });

  it('plays a slow pass at the bottom of the ladder, then the pass at tempo, each with its own count-in', () => {
    const h = demo(def, r);
    const seq = synth.of('playSequence');
    expect(seq).toHaveLength(2);
    // Pass 1: every time doubled (120 -> 60 bpm). The count-in tone is 2 s long, the downbeat at START + 2.
    expect(seq[0].opts!.startAt).toBe(START);
    expect(seq[0].notes![1]).toMatchObject({ midi: 64, start: 2 });
    expect(seq[0].notes![2].start).toBeCloseTo(2 + sixteenth(60), 9);
    expect(seq[0].notes![2].duration).toBeCloseTo(sixteenth(60), 9);
    const metros = synth.of('startMetronome');
    expect(metros.map((m) => m.bpm)).toEqual([60, 120]);
    expect(metros[0].opts).toEqual({ startAt: START + 2, countInBeats: 2, gain: musicalClickGain(PEAK) });
    // Pass 2 begins after pass 1's pattern end (2 * 2 s) plus the gap, then its own 1 s count-in.
    const downbeat2 = START + 2 + 4 + PASS_GAP_SEC + 1;
    expect(metros[1].opts).toEqual({ startAt: downbeat2, countInBeats: 2, gain: musicalClickGain(PEAK) });
    expect(seq[1].opts!.startAt).toBeCloseTo(downbeat2 - 1, 9);
    expect(seq[1].notes![1]).toMatchObject({ midi: 64, start: 1 });
    expect(seq[1].notes![2].start).toBeCloseTo(1 + sixteenth(120), 9);
    expect(h.startAt).toBe(START);
    expect(h.endAt).toBeCloseTo(downbeat2 + 2, 9);
  });

  it('can be switched off, or on for an exercise that does not ask for it', () => {
    demo(def, r, { slowFirst: false });
    expect(synth.of('playSequence')).toHaveLength(1);
    synth = new FakeSynth();
    const noSlow = makeDef({ kind: 'run', tempoBpm: 120, tempoLadder: [60, 120], demo: { timbre: 'piano', vibrato: null } });
    demo(noSlow, r);
    expect(synth.of('playSequence')).toHaveLength(1);
    synth = new FakeSynth();
    demo(noSlow, r, { slowFirst: true, slowBpm: 40 });
    const seq = synth.of('playSequence');
    expect(seq).toHaveLength(2);
    expect(seq[0].notes!.find((n) => n.midi === 62)!.start).toBeCloseTo(sixteenth(40) + 1 * 3, 9); // tripled
  });

  it('without a ladder the slow pass runs at a fixed share of the tempo; never "slow" when already at or below it', () => {
    const noLadder = makeDef({ kind: 'run', tempoBpm: 100, demo: { timbre: 'piano', vibrato: null, slowFirst: true }, metronome: true });
    demo(noLadder, realized({ bpm: 100, notes: [note(60, 0, 0.5)], totalSec: 1 }));
    expect(synth.of('startMetronome').map((m) => m.bpm)).toEqual([Math.round(100 * SLOW_DEMO_FACTOR), 100]);
    synth = new FakeSynth();
    demo(noLadder, realized({ bpm: 100, notes: [note(60, 0, 0.5)], totalSec: 1 }), { slowBpm: 100 });
    expect(synth.of('playSequence')).toHaveLength(1);
    synth = new FakeSynth();
    const atBottom = makeDef({ kind: 'run', tempoBpm: 100, tempoLadder: [60, 100], demo: { timbre: 'piano', vibrato: null, slowFirst: true } });
    demo(atBottom, realized({ bpm: 60, notes: [note(60, 0, 0.5)] })); // realized at the ladder bottom already
    expect(synth.of('playSequence')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- dynamics: crescendo, decrescendo, messa di voce, steps

describe('buildDemo: dynamics', () => {
  const def = makeDef({ kind: 'swell', demo: { timbre: 'soft', vibrato: null }, analyzers: ['dynamics', 'accuracy'] });
  const SOFT = PEAK * SWELL_SOFT_GAIN;
  const level = (t: number, voice = 0) => valueAt(ctx.gains[voice].gain.events, START + t);

  function sample(from: number, to: number, n = 40, voice = 0): number[] {
    return Array.from({ length: n + 1 }, (_, i) => level(from + ((to - from) * i) / n, voice));
  }

  describe('smooth shapes (CUE.crescendo, CUE.decrescendo, CUE.swell)', () => {
    it('a crescendo grows from soft to full on one steady pitch', () => {
      demo(def, realized({ notes: [note(60, 0, 4)], cues: [cue(0, CUE.crescendo)] }));
      expect(synth.calls).toHaveLength(0);
      expect(ctx.oscs).toHaveLength(1);
      for (const e of ctx.oscs[0].frequency.events) expect(e.value).toBeCloseTo(midiToHz(60), 9);
      const s = sample(0.1, 4);
      for (let i = 1; i < s.length; i++) expect(s[i]).toBeGreaterThanOrEqual(s[i - 1] - 1e-12);
      expect(level(0.1)).toBeLessThan(2 * SOFT);
      expect(level(4)).toBeCloseTo(PEAK, 9);
      // Even in dB: halfway in time is (about) halfway in level, i.e. the geometric mean. The exponential ramp starts
      // when the 30 ms attack ends, hence the small allowance.
      expect(level(2)).toBeCloseTo(Math.sqrt(SOFT * PEAK), 1);
      expect(level(2) / level(1)).toBeCloseTo(level(3) / level(2), 1); // constant dB per second
    });

    it('a decrescendo fades from full to soft', () => {
      demo(def, realized({ notes: [note(60, 0, 4)], cues: [cue(0, CUE.decrescendo)] }));
      const s = sample(0.1, 4);
      for (let i = 1; i < s.length; i++) expect(s[i]).toBeLessThanOrEqual(s[i - 1] + 1e-12);
      expect(level(0.1)).toBeCloseTo(PEAK, 1);
      expect(level(4)).toBeCloseTo(SOFT, 9);
    });

    it('messa di voce (CUE.swell): gain up, then down, peaking at the middle of the note', () => {
      demo(def, realized({ notes: [note(60, 0, 6)], cues: [cue(0, CUE.swell)] }));
      const up = sample(0.1, 3);
      const down = sample(3, 6);
      for (let i = 1; i < up.length; i++) expect(up[i]).toBeGreaterThanOrEqual(up[i - 1] - 1e-12);
      for (let i = 1; i < down.length; i++) expect(down[i]).toBeLessThanOrEqual(down[i - 1] + 1e-12);
      expect(level(3)).toBeCloseTo(PEAK, 9);
      expect(level(0.1)).toBeLessThan(2 * SOFT);
      expect(level(6)).toBeCloseTo(SOFT, 9);
      // A real swell: at least the range the dynamics analyzer requires of the singer.
      expect(20 * Math.log10(level(3) / level(0.1))).toBeGreaterThanOrEqual(CONFIG.dynamics.minRangeDb);
      // After the note the voice releases to silence.
      expect(level(6 + 0.07)).toBe(0);
    });

    it('every note carries its own cue, so each note of the drill is shaped', () => {
      demo(def, realized({ notes: [note(60, 0, 4), note(62, 6, 10), note(64, 12, 16)], cues: [cue(0, CUE.crescendo), cue(6, CUE.crescendo), cue(12, CUE.crescendo)] }));
      expect(ctx.oscs).toHaveLength(3);
      for (let i = 0; i < 3; i++) {
        expect(level(6 * i + 0.1, i)).toBeLessThan(2 * SOFT); // each starts soft...
        expect(level(6 * i + 4, i)).toBeCloseTo(PEAK, 9); //     ...and ends full
      }
    });

    it('a swell exercise note with no dynamics cue is a plain tone (nothing is guessed)', () => {
      demo(def, realized({ notes: [note(60, 0, 8)], cues: [cue(0, 'Hold it steady')] }));
      expect(ctx.oscs).toHaveLength(0);
      expect(synth.of('playSequence')).toHaveLength(1);
    });

    it('a shape cue part-way into a held note shapes from there on (what came before is plain)', () => {
      demo(def, realized({ notes: [note(60, 0, 2), note(60, 2, 6)], cues: [cue(2, CUE.crescendo)] }));
      expect(synth.of('playSequence')[0].notes).toEqual([{ midi: 60, start: 0, duration: 2 }]);
      expect(ctx.oscs).toHaveLength(1);
      expect(ctx.oscs[0].startTimes).toEqual([START + 2]);
      expect(level(6, 0)).toBeCloseTo(PEAK, 9);
    });

    it('free-text cues that spell out a shape still work (exercise packs that do not use the constants)', () => {
      demo(def, realized({ notes: [note(60, 0, 6)], cues: [cue(0, 'Soft, grow, then fade: pitch still')] }));
      expect(level(3)).toBeCloseTo(PEAK, 9);
      expect(level(6)).toBeCloseTo(SOFT, 9);
    });
  });

  describe('dynamic steps: ONE tone, abrupt level changes on the steps', () => {
    /** Three 2 s steps on one pitch, cued Soft, Loud, Soft: ONE held note, as plan.ts reads it. */
    const stepsOf = (levels: Array<string | undefined>, midi = 60): DemoRealized =>
      realized({
        notes: levels.map((_, i) => note(midi, i * 2, (i + 1) * 2)),
        cues: levels.flatMap((l, i) => (l === undefined ? [] : [cue(i * 2, l)])),
      });

    it('soft, loud, soft: a single oscillator, soft/loud/soft, quick transitions centred on the step boundaries', () => {
      demo(def, stepsOf(['Soft', 'Loud', 'Soft']));
      expect(synth.calls).toHaveLength(0);
      expect(ctx.oscs).toHaveLength(1); // not three re-attacked notes
      expect(level(1)).toBeCloseTo(SOFT, 9);
      expect(level(3)).toBeCloseTo(PEAK, 9);
      expect(level(5)).toBeCloseTo(SOFT, 9);
      expect(level(2 - STEP_RAMP_SEC)).toBeCloseTo(SOFT, 9);
      expect(level(2 + STEP_RAMP_SEC)).toBeCloseTo(PEAK, 9);
      expect(level(2)).toBeGreaterThan(SOFT);
      expect(level(2)).toBeLessThan(PEAK); // mid-transition at the boundary
      for (const e of ctx.oscs[0].frequency.events) expect(e.value).toBeCloseTo(midiToHz(60), 9);
    });

    it('loud, soft, loud', () => {
      demo(def, stepsOf(['Loud', 'Soft', 'Loud'], 62));
      expect(level(1)).toBeCloseTo(PEAK, 9);
      expect(level(3)).toBeCloseTo(SOFT, 9);
      expect(level(5)).toBeCloseTo(PEAK, 9);
    });

    it('a step with no cue keeps the level before it', () => {
      demo(def, stepsOf(['Soft', undefined, 'Loud']));
      expect(level(1)).toBeCloseTo(SOFT, 9);
      expect(level(3)).toBeCloseTo(SOFT, 9);
      expect(level(5)).toBeCloseTo(PEAK, 9);
    });

    it('the soft/loud difference is at least the dynamic range the analyzer asks for', () => {
      demo(def, stepsOf(['Soft', 'Loud', 'Soft']));
      expect(20 * Math.log10(level(3) / level(1))).toBeGreaterThanOrEqual(CONFIG.dynamics.minRangeDb);
    });

    it('two step drills on different pitches are two tones', () => {
      demo(def, realized({
        notes: [note(60, 0, 2), note(60, 2, 4), note(62, 6, 8), note(62, 8, 10)],
        cues: [cue(0, 'Soft'), cue(2, 'Loud'), cue(6, 'Loud'), cue(8, 'Soft')],
      }));
      expect(ctx.oscs).toHaveLength(2);
      expect(level(1, 0)).toBeCloseTo(SOFT, 9);
      expect(level(3, 0)).toBeCloseTo(PEAK, 9);
      expect(level(7, 1)).toBeCloseTo(PEAK, 9);
      expect(level(9, 1)).toBeCloseTo(SOFT, 9);
    });
  });

  describe('capstones and other exercises', () => {
    it('a dynamics Boss Recital shapes each part its own way: swell, soft/loud steps, decrescendo', () => {
      const boss = makeDef({ kind: 'boss-recital', demo: { timbre: 'soft', vibrato: null }, analyzers: ['dynamics', 'accuracy'] });
      demo(
        boss,
        realized({
          notes: [note(60, 0, 8), note(62, 9, 11), note(62, 11, 13), note(62, 13, 15), note(60, 16, 22)],
          cues: [cue(0, CUE.swell), cue(9, 'Soft'), cue(11, 'Loud'), cue(13, 'Soft'), cue(16, CUE.decrescendo)],
        }),
      );
      expect(ctx.oscs).toHaveLength(3);
      expect(level(4, 0)).toBeCloseTo(PEAK, 9); //                 messa peaks mid-note
      expect(level(10, 1)).toBeCloseTo(SOFT, 9); //                steps: soft...
      expect(level(12, 1)).toBeCloseTo(PEAK, 9); //                ...loud...
      expect(level(14, 1)).toBeCloseTo(SOFT, 9); //                ...soft
      expect(level(16.2, 2)).toBeGreaterThan(0.8 * PEAK); //       decrescendo starts loud...
      expect(level(22, 2)).toBeCloseTo(SOFT, 9); //                ...and ends soft
    });

    it('a capstone with a dynamics analyzer but no dynamics cue plays plain notes', () => {
      const boss = makeDef({ kind: 'boss-recital', demo: { timbre: 'soft', vibrato: null }, analyzers: ['dynamics'] });
      demo(boss, realized({ notes: [note(60, 0, 4)], cues: [cue(0, 'Hold it steady and straight')] }));
      expect(ctx.oscs).toHaveLength(0);
      expect(synth.of('playSequence')).toHaveLength(1);
    });

    it('a non-dynamics exercise is never reshaped, whatever its cue says', () => {
      const d = makeDef({ kind: 'sustain', analyzers: ['accuracy'] });
      demo(d, realized({ notes: [note(60, 0, 4)], cues: [cue(0, CUE.swell)] }));
      expect(ctx.oscs).toHaveLength(0);
      demo(d, realized({ notes: [note(60, 0, 2), note(60, 2, 4)], cues: [cue(0, 'Soft'), cue(2, 'Loud')] }));
      expect(ctx.oscs).toHaveLength(0);
    });
  });

  describe('the custom voice itself', () => {
    it('builds the envelope like the synth: anchored at 0, an attack, time-ordered, ending at 0', () => {
      demo(def, realized({ notes: [note(60, 0, 6)], cues: [cue(0, CUE.swell)] }));
      const g = ctx.gains[0].gain.events;
      expect(g[0]).toEqual({ method: 'setValueAtTime', value: 0, time: START });
      for (let i = 1; i < g.length; i++) expect(g[i].time).toBeGreaterThanOrEqual(g[i - 1].time);
      expect(g[g.length - 1]).toMatchObject({ method: 'linearRampToValueAtTime', value: 0 });
      expect(g[g.length - 1].time).toBeCloseTo(START + 6 + 0.06, 9);
      expect(ctx.oscs[0].startTimes).toEqual([START]);
      expect(ctx.oscs[0].stopTimes[0]).toBeGreaterThan(START + 6.06);
      expect(ctx.gains[0].connections).toEqual([dest]);
      expect(g.filter((e) => e.method === 'exponentialRampToValueAtTime').length).toBeGreaterThan(0);
    });

    it('survives a zero reference volume (exponential ramps cannot target 0)', () => {
      expect(() => demo(def, realized({ notes: [note(60, 0, 6)], cues: [cue(0, CUE.swell)] }), { gain: 0 })).not.toThrow();
    });

    it('uses the demo timbre: a PeriodicWave for soft and piano, the plain oscillator for sine', () => {
      demo(def, realized({ notes: [note(60, 0, 4)], cues: [cue(0, CUE.crescendo)] }));
      expect(ctx.oscs[0].periodicWave).not.toBeNull();
      expect(ctx.waves).toHaveLength(1);
      ctx = new FakeCtx();
      demo({ ...def, demo: { timbre: 'sine', vibrato: null } }, realized({ notes: [note(60, 0, 4)], cues: [cue(0, CUE.crescendo)] }));
      expect(ctx.oscs[0].periodicWave).toBeNull();
      expect(ctx.oscs[0].type).toBe('sine');
    });

    it('shares one PeriodicWave per context and timbre across voices', () => {
      demo(def, realized({ notes: [note(60, 0, 4), note(62, 6, 10)], cues: [cue(0, CUE.crescendo), cue(6, CUE.crescendo)] }));
      expect(ctx.waves).toHaveLength(1);
      expect(ctx.oscs[0].periodicWave).toBe(ctx.oscs[1].periodicWave);
    });
  });
});

// ---------------------------------------------------------------- truncation

describe('buildDemo: maxSec and firstPassSec', () => {
  const def = makeDef({ kind: 'legato', demo: { timbre: 'piano', vibrato: null } });

  it('plays only what starts before maxSec, shortening the note that straddles it', () => {
    demo(def, realized({ notes: [note(60, 0, 1), note(62, 1, 2), note(64, 2, 3), note(65, 3, 4)], totalSec: 4 }), { maxSec: 2.5 });
    expect(synth.of('playSequence')[0].notes).toEqual([
      { midi: 60, start: 0, duration: 1 },
      { midi: 62, start: 1, duration: 1 },
      { midi: 64, start: 2, duration: 0.5 },
    ]);
  });

  it('cuts a glide partway and stops at the pitch it has reached', () => {
    const d = makeDef({ kind: 'slide', demo: { timbre: 'sine', vibrato: null } });
    demo(d, realized({ notes: [note(60, 0, 1), note(60, 1, 3, 64), note(64, 3, 5)] }), { maxSec: 2 });
    const g = synth.of('playGlide')[0].spec as GlideSpec;
    expect(g).toMatchObject({ fromMidi: 60, holdBefore: 1, glideDuration: 1, holdAfter: 0 });
    expect(g.toMidi).toBeCloseTo(62, 9); // halfway up the glide
  });

  it('maxSec 0 plays nothing', () => {
    demo(def, realized({ notes: [note(60, 0, 1)] }), { maxSec: 0 });
    expect(synth.calls).toHaveLength(0);
  });

  it('firstPassSec is one repetition of the pattern at a tempo', () => {
    expect(firstPassSec({ pattern: [{ semis: 0, beats: 2 }, { beats: 1 }, { semis: 4, beats: 0.5 }] }, 60)).toBeCloseTo(3.5, 12);
    expect(firstPassSec({ pattern: [{ semis: 0, beats: 4 }] }, 120)).toBeCloseTo(2, 12);
    expect(firstPassSec({ pattern: [] }, 60)).toBe(0);
  });
});

// ---------------------------------------------------------------- planning (pure)

describe('planDemoVoices', () => {
  const layout = (over: Partial<DemoLayout>): DemoLayout => ({ notes: [], reference: [], cues: [], totalSec: 10, countInSec: 0, ...over });

  it('is a pure function of its input (calling it twice gives equal plans, and it does not mutate the layout)', () => {
    const def = makeDef({ kind: 'slide' });
    const l = layout({ notes: [note(60, 0, 1), note(60, 1, 2, 64), note(64, 2, 4)] });
    const copy = JSON.parse(JSON.stringify(l));
    expect(planDemoVoices(def, l, 'pop')).toEqual(planDemoVoices(def, l, 'pop'));
    expect(l).toEqual(copy);
  });

  it('merges a hold-glide-hold chain into a single glide voice', () => {
    const v = planDemoVoices(makeDef({ kind: 'slide' }), layout({ notes: [note(60, 0, 1), note(60, 1, 2, 64), note(64, 2, 4)] }), 'pop');
    expect(v).toEqual([{ kind: 'glide', fromMidi: 60, toMidi: 64, start: 0, holdBefore: 1, glideDuration: 1, holdAfter: 2 }]);
  });

  it('keeps a gap as a gap: separated slides are separate voices', () => {
    const v = planDemoVoices(makeDef({ kind: 'slide' }), layout({ notes: [note(60, 0, 1, 64), note(64, 1.5, 3, 60)] }), 'pop');
    expect(v.map((x) => x.kind)).toEqual(['glide', 'glide']);
  });

  it('does not merge a note into a glide when the pitches are not continuous', () => {
    const v = planDemoVoices(makeDef({ kind: 'slide' }), layout({ notes: [note(60, 0, 1, 64), note(65, 1, 2)] }), 'pop');
    expect(v.map((x) => x.kind)).toEqual(['sequence', 'glide']);
  });

  it('a hold carries the cue of its first step only: later steps are not cue lookups at other times', () => {
    // A cue at 0.5 matches no note start, so it must not colour the note that starts at 0.
    const v = planDemoVoices(makeDef({ kind: 'sustain', analyzers: ['dynamics'] }), layout({ notes: [note(60, 0, 4)], cues: [cue(0.5, CUE.swell)] }), 'pop');
    expect(v.map((x) => x.kind)).toEqual(['sequence']);
  });

  it('demoLayout fills in the optional realized fields', () => {
    const def = makeDef({ kind: 'sustain', countInBeats: 2, tempoBpm: 120 });
    const l = demoLayout(def, { tonicMidi: 60, notes: [note(60, 0, 3)], cues: [], reference: [note(60, 3, 4)] });
    expect(l.countInSec).toBeCloseTo(1, 12); // 2 beats at 120 bpm
    expect(l.totalSec).toBe(4); //              end of the last sound
    expect(l.reference).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- fuzz

describe('buildDemo on arbitrary material', () => {
  /** mulberry32 (public domain): a seeded generator so a failure reproduces. */
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const KINDS: ExerciseKind[] = [
    'range-finder', 'pitch-match', 'sustain', 'siren', 'staccato', 'intervals', 'legato', 'vibrato-meter', 'pulse-builder', 'oscillation',
    'straight-to-bloom', 'vibrato-switch', 'scoop', 'fall', 'slide', 'turn', 'flip', 'run', 'swell', 'boss-recital', 'audition',
  ];
  const CUES = [CUE.straight, CUE.bloom, CUE.vibrato, CUE.fall, CUE.scoop, CUE.slide, CUE.crescendo, CUE.decrescendo, CUE.swell, CUE.listen, 'Soft', 'Loud', 'Hold it steady', 'Soft, grow, then fade'];

  it('never throws, and every scheduled time and value is finite and sane (300 random exercises)', () => {
    const rand = rng(20261021);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
    for (let trial = 0; trial < 300; trial++) {
      // Random contiguous material: notes, glides, holds on a pitch, rests, with random cues.
      const notes: TargetNote[] = [];
      const cues: Array<{ t: number; text: string }> = [];
      let t = 0;
      let midi = 55 + Math.floor(rand() * 12);
      const n = 1 + Math.floor(rand() * 14);
      for (let i = 0; i < n; i++) {
        const dur = 0.05 + rand() * 3;
        const r = rand();
        if (r < 0.15) {
          t += dur; // rest
          continue;
        }
        if (rand() < 0.3) midi += Math.floor(rand() * 9) - 4;
        const glide = r > 0.75;
        const to = glide ? midi + Math.floor(rand() * 13) - 6 : undefined;
        notes.push(note(midi, t, t + dur, to));
        if (rand() < 0.5) cues.push(cue(t, pick(CUES)));
        t += dur;
        if (to !== undefined) midi = to;
      }
      const kind = pick(KINDS);
      const def = makeDef({
        kind,
        metronome: rand() < 0.5,
        countInBeats: Math.floor(rand() * 5),
        tempoBpm: 50 + Math.floor(rand() * 130),
        demo: { timbre: pick(['piano', 'soft', 'sine'] as const), vibrato: pick([null, 'style', { rateHz: 3 + rand() * 5, extentCents: 10 + rand() * 80 }] as const), slowFirst: rand() < 0.3 },
        analyzers: rand() < 0.5 ? ['pulse', 'dynamics'] : rand() < 0.5 ? ['dynamics'] : ['accuracy'],
      });
      const c = new FakeCtx();
      const s = new FakeSynth();
      const start = 10 + rand() * 50;
      const h = buildDemo(
        def,
        realized({
          notes,
          cues,
          bpm: def.tempoBpm,
          reference: rand() < 0.5 ? [note(60, -1.5, 0)] : undefined,
          totalSec: t + rand(),
        }),
        s,
        c as unknown as BaseAudioContext,
        dest as unknown as AudioNode,
        { startAt: start, vibratoStyle: pick(['pop', 'classical'] as const), gain: rand(), maxSec: rand() < 0.2 ? rand() * t : undefined },
      );
      made.push(h);
      expect(Number.isFinite(h.startAt) && Number.isFinite(h.endAt), `trial ${trial} ${kind}`).toBe(true);
      expect(h.startAt).toBeGreaterThanOrEqual(start - 1e-9);
      expect(h.endAt).toBeGreaterThanOrEqual(h.startAt);
      for (const o of c.oscs) {
        for (const p of [o.frequency, o.detune]) {
          for (const e of p.events) {
            expect(Number.isFinite(e.time), `trial ${trial}`).toBe(true);
            expect(e.time).toBeGreaterThanOrEqual(start - 1e-9);
            if (e.value !== undefined) expect(Number.isFinite(e.value)).toBe(true);
          }
        }
        expect(o.startTimes[0]).toBeGreaterThanOrEqual(start - 1e-9);
        expect(o.stopTimes[0]).toBeGreaterThanOrEqual(o.startTimes[0]);
      }
      for (const g of c.gains) {
        let prev = -Infinity;
        for (const e of g.gain.events) {
          expect(Number.isFinite(e.time), `trial ${trial}`).toBe(true);
          expect(e.time, `trial ${trial} ${kind}: automation out of time order`).toBeGreaterThanOrEqual(prev - 1e-9);
          prev = e.time;
          if (e.value !== undefined) {
            expect(Number.isFinite(e.value)).toBe(true);
            expect(e.value).toBeGreaterThanOrEqual(0);
          }
        }
      }
      for (const call of s.calls) {
        if (call.method === 'playNote' || call.method === 'playGlide') {
          const spec = call.spec as NoteSpec | GlideSpec;
          expect(Number.isFinite(spec.startAt as number)).toBe(true);
          expect(spec.startAt as number).toBeGreaterThanOrEqual(start - 1e-9);
        }
        if (call.method === 'playNote') expect((call.spec as NoteSpec).duration).toBeGreaterThan(0);
        if (call.method === 'playSequence') {
          for (const q of call.notes!) {
            expect(Number.isFinite(q.midi) && q.start >= -1e-9 && q.duration > 0, `trial ${trial} ${kind}`).toBe(true);
          }
        }
      }
      h.stop();
    }
  });
});

// ---------------------------------------------------------------- every kind

describe('every ExerciseKind has a demo', () => {
  // A Record, not an array: adding a kind to the contract breaks compilation here until it is listed.
  const KINDS: Record<ExerciseKind, true> = {
    'range-finder': true, 'pitch-match': true, sustain: true, siren: true, staccato: true, intervals: true, legato: true,
    'vibrato-meter': true, 'pulse-builder': true, oscillation: true, 'straight-to-bloom': true, 'vibrato-switch': true,
    scoop: true, fall: true, slide: true, turn: true, flip: true, run: true, swell: true, 'boss-recital': true, audition: true,
  };

  it.each(Object.keys(KINDS) as ExerciseKind[])('%s builds, schedules sound and ends after it starts', (kind) => {
    const c = new FakeCtx();
    const s = new FakeSynth();
    const def = makeDef({ kind, metronome: true, countInBeats: 2, demo: { timbre: 'soft', vibrato: 'style', slowFirst: kind === 'run' }, analyzers: ['pulse', 'dynamics'] });
    const r = realized({
      notes: [note(60, 0, 2), note(60, 2, 3, 64), note(64, 3, 5), note(64, 5, 5.5), note(64, 5.5, 6), note(67, 7, 9, 60), note(62, 10, 11)],
      reference: [note(60, -2, 0)],
      cues: [cue(0, CUE.crescendo), cue(5, CUE.bloom), cue(10, CUE.swell)],
      countInSec: 2,
      totalSec: 12,
    });
    const h = buildDemo(def, r, s, c as unknown as BaseAudioContext, dest as unknown as AudioNode, { startAt: START });
    made.push(h);
    expect(s.calls.length + c.oscs.length).toBeGreaterThan(0);
    expect(h.endAt).toBeGreaterThan(h.startAt);
    expect(Number.isFinite(h.endAt)).toBe(true);
    h.stop();
  });
});
