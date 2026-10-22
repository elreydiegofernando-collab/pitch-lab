import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLICK_SHARE_OF_REFERENCE,
  SOFT_LIMIT_CEILING,
  SOFT_LIMIT_KNEE,
  beatsInWindow,
  createSynth,
  musicalClickGain,
  nextBeatAtOrAfter,
  softLimit,
} from './synth';
import { midiToHz } from '../core/music';
import type { Timbre } from './synth-types';

// ---------------------------------------------------------------------------
// A minimal fake Web Audio graph: records every node created and every
// AudioParam automation call, instead of actually producing sound. Lets us
// assert the *scheduling* synth.ts does without a real AudioContext (jsdom/
// happy-dom don't implement Web Audio, and we don't want a browser for unit
// tests anyway).

interface AutomationEvent {
  method: 'setValueAtTime' | 'linearRampToValueAtTime' | 'exponentialRampToValueAtTime' | 'setTargetAtTime' | 'cancelScheduledValues';
  value?: number;
  time: number;
  timeConstant?: number;
}

class FakeAudioParam {
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
    this.events.push({ method: 'exponentialRampToValueAtTime', value, time });
    this.value = value;
    return this;
  }
  setTargetAtTime(target: number, time: number, timeConstant: number): this {
    this.events.push({ method: 'setTargetAtTime', value: target, time, timeConstant });
    this.value = target;
    return this;
  }
  cancelScheduledValues(time: number): this {
    this.events.push({ method: 'cancelScheduledValues', time });
    return this;
  }
}

class FakeAudioNode {
  connections: unknown[] = [];
  connect(dest: unknown): unknown {
    this.connections.push(dest);
    return dest;
  }
  disconnect(): void {
    this.connections = [];
  }
}

class FakeOscillatorNode extends FakeAudioNode {
  type = 'sine';
  frequency = new FakeAudioParam();
  detune = new FakeAudioParam();
  periodicWave: unknown = null;
  startTimes: number[] = [];
  stopTimes: number[] = [];
  private endedListeners: Array<() => void> = [];
  setPeriodicWave(wave: unknown): void {
    this.periodicWave = wave;
  }
  start(when = 0): void {
    this.startTimes.push(when);
  }
  stop(when = 0): void {
    this.stopTimes.push(when);
  }
  addEventListener(type: string, cb: () => void): void {
    if (type === 'ended') this.endedListeners.push(cb);
  }
  removeEventListener(type: string, cb: () => void): void {
    if (type === 'ended') this.endedListeners = this.endedListeners.filter((l) => l !== cb);
  }
  /** Test helper: simulate the node actually finishing playback. */
  fireEnded(): void {
    for (const cb of this.endedListeners) cb();
  }
}

class FakeGainNode extends FakeAudioNode {
  gain = new FakeAudioParam();
}

class FakeAudioContext {
  currentTime = 0;
  baseLatency = 0;
  createdOscillators: FakeOscillatorNode[] = [];
  createdGains: FakeGainNode[] = [];
  createOscillator(): FakeOscillatorNode {
    const node = new FakeOscillatorNode();
    this.createdOscillators.push(node);
    return node;
  }
  createGain(): FakeGainNode {
    const node = new FakeGainNode();
    this.createdGains.push(node);
    return node;
  }
  createPeriodicWave(real: Float32Array, imag: Float32Array): { real: Float32Array; imag: Float32Array } {
    return { real, imag };
  }
}

function makeCtx(): FakeAudioContext {
  return new FakeAudioContext();
}

// ---------------------------------------------------------------------------

describe('createSynth: timbres and envelopes', () => {
  let ctx: FakeAudioContext;
  let destination: FakeAudioNode;

  beforeEach(() => {
    ctx = makeCtx();
    destination = new FakeAudioNode();
  });

  it('shares one PeriodicWave per timbre across voices, and uses the plain oscillator type for sine', () => {
    const synth = createSynth(ctx as unknown as BaseAudioContext, destination as unknown as AudioNode);
    synth.playNote({ midi: 60, duration: 0.2, timbre: 'piano' });
    synth.playNote({ midi: 62, duration: 0.2, timbre: 'piano' });
    synth.playNote({ midi: 64, duration: 0.2, timbre: 'soft' });
    synth.playNote({ midi: 65, duration: 0.2, timbre: 'sine' });

    const [piano1, piano2, soft, sine] = ctx.createdOscillators;
    expect(piano1.periodicWave).not.toBeNull();
    expect(piano1.periodicWave).toBe(piano2.periodicWave); // same wave object reused
    expect(soft.periodicWave).not.toBeNull();
    expect(soft.periodicWave).not.toBe(piano1.periodicWave);
    expect(sine.periodicWave).toBeNull();
    expect(sine.type).toBe('sine');
  });

  it.each<Timbre>(['piano', 'soft', 'sine'])(
    'never starts the %s amplitude envelope at a discontinuity, and settles exactly at 0 by the end',
    (timbre) => {
      ctx.currentTime = 5;
      const synth = createSynth(ctx as unknown as BaseAudioContext, destination as unknown as AudioNode);
      const startAt = 10;
      const duration = 0.5;
      const handle = synth.playNote({ midi: 69, startAt, duration, timbre, gain: 0.8 });

      const osc = ctx.createdOscillators[0];
      const gain = ctx.createdGains[1].gain; // [0] is the synth's master gain, created by createSynth() above
      expect(osc).toBeDefined();
      expect(gain.events[0]).toEqual({ method: 'setValueAtTime', value: 0, time: startAt });

      // Times are non-decreasing (no automation scheduled "backwards" relative to a previous event).
      for (let i = 1; i < gain.events.length; i++) {
        expect(gain.events[i].time).toBeGreaterThanOrEqual(gain.events[i - 1].time);
      }
      // The envelope reaches peak gain before settling toward 0 at the very end.
      const peakSeen = gain.events.some((e) => Math.abs((e.value ?? 0) - 0.8) < 1e-9);
      expect(peakSeen).toBe(true);
      const last = gain.events[gain.events.length - 1];
      expect(last.method).toBe('linearRampToValueAtTime');
      expect(last.value).toBe(0);
      expect(handle.startAt).toBe(startAt);
      expect(last.time).toBeCloseTo(handle.endAt, 9);
    },
  );

  it('defaults startAt to ctx.currentTime + 0.03', () => {
    ctx.currentTime = 2;
    const synth = createSynth(ctx as unknown as BaseAudioContext, destination as unknown as AudioNode);
    const handle = synth.playNote({ midi: 60, duration: 0.3 });
    expect(handle.startAt).toBeCloseTo(2.03, 9);
    expect(ctx.createdGains[1].gain.events[0]).toEqual({ method: 'setValueAtTime', value: 0, time: handle.startAt });
  });

  it("piano decays from its attack peak toward a LOW sustain (not a steady one)", () => {
    const synth = createSynth(ctx as unknown as BaseAudioContext, destination as unknown as AudioNode);
    synth.playNote({ midi: 60, startAt: 0, duration: 2, timbre: 'piano', gain: 1 });
    const events = ctx.createdGains[1].gain.events;
    const decay = events.find((e) => e.method === 'exponentialRampToValueAtTime');
    expect(decay).toBeDefined();
    expect(decay!.value).toBeLessThan(0.5); // sustain well below the peak of 1
    expect(decay!.value).toBeGreaterThan(0);
  });

  it("soft and sine hold a STEADY sustain (no decay stage)", () => {
    for (const timbre of ['soft', 'sine'] as const) {
      const c = makeCtx();
      const synth = createSynth(c as unknown as BaseAudioContext, destination as unknown as AudioNode);
      synth.playNote({ midi: 60, startAt: 0, duration: 2, timbre, gain: 1 });
      const events = c.createdGains[1].gain.events;
      expect(events.some((e) => e.method === 'exponentialRampToValueAtTime')).toBe(false);
    }
  });

  it('clips the attack to the note duration for very short notes, without throwing or going non-monotonic', () => {
    const synth = createSynth(ctx as unknown as BaseAudioContext, destination as unknown as AudioNode);
    expect(() => synth.playNote({ midi: 60, startAt: 0, duration: 0.001, timbre: 'piano' })).not.toThrow();
    const events = ctx.createdGains[1].gain.events;
    for (let i = 1; i < events.length; i++) expect(events[i].time).toBeGreaterThanOrEqual(events[i - 1].time);
  });
});

describe('createSynth: vibrato', () => {
  it("drives detune through an LFO whose depth gain reaches exactly extentCents (detune's own unit)", () => {
    const ctx = makeCtx();
    const destination = new FakeAudioNode();
    const synth = createSynth(ctx as unknown as BaseAudioContext, destination as unknown as AudioNode);

    const startAt = 1;
    synth.playNote({
      midi: 69,
      startAt,
      duration: 3,
      timbre: 'soft',
      vibrato: { rateHz: 6, extentCents: 45, delaySec: 0.4, fadeInSec: 0.2 },
    });

    const [voiceOsc, lfoOsc] = ctx.createdOscillators;
    const [, , depthGain] = ctx.createdGains; // [0] is the synth's master gain, [1] is the voice's own amplitude gain

    expect(lfoOsc.type).toBe('sine');
    expect(lfoOsc.frequency.value).toBe(6);
    // LFO -> depth -> detune, wired exactly as the architecture requires.
    expect(lfoOsc.connections).toContain(depthGain);
    expect(depthGain.connections).toContain(voiceOsc.detune);

    // Depth starts at 0, holds through the delay, then ramps up to exactly extentCents.
    expect(depthGain.gain.events[0]).toEqual({ method: 'setValueAtTime', value: 0, time: startAt });
    const rampUp = depthGain.gain.events.find((e) => e.method === 'linearRampToValueAtTime');
    expect(rampUp).toBeDefined();
    expect(rampUp!.value).toBe(45);
    expect(rampUp!.time).toBeCloseTo(startAt + 0.4 + 0.2, 9);
    expect(lfoOsc.startTimes[0]).toBe(startAt);
  });

  it('with no delay/fade-in, jumps straight to full depth (no ramp)', () => {
    const ctx = makeCtx();
    const destination = new FakeAudioNode();
    const synth = createSynth(ctx as unknown as BaseAudioContext, destination as unknown as AudioNode);
    synth.playNote({ midi: 69, startAt: 0, duration: 1, vibrato: { rateHz: 5, extentCents: 30 } });
    const [, , depthGain] = ctx.createdGains;
    expect(depthGain.gain.events.some((e) => e.method === 'linearRampToValueAtTime')).toBe(false);
    expect(depthGain.gain.events.some((e) => e.method === 'setValueAtTime' && e.value === 30)).toBe(true);
  });

  it('a note with no vibrato spec creates no LFO', () => {
    const ctx = makeCtx();
    const destination = new FakeAudioNode();
    const synth = createSynth(ctx as unknown as BaseAudioContext, destination as unknown as AudioNode);
    synth.playNote({ midi: 69, startAt: 0, duration: 1 });
    expect(ctx.createdOscillators).toHaveLength(1);
    expect(ctx.createdGains).toHaveLength(2); // the synth's master gain, plus the note's own amplitude gain
  });
});

describe('createSynth: glide', () => {
  it('holds fromMidi, then exponentialRamps to exactly toMidi in Hz over glideDuration', () => {
    const ctx = makeCtx();
    const destination = new FakeAudioNode();
    const synth = createSynth(ctx as unknown as BaseAudioContext, destination as unknown as AudioNode);

    const startAt = 2;
    const holdBefore = 0.3;
    const glideDuration = 0.8;
    const holdAfter = 0.5;
    const fromHz = midiToHz(60);
    const toHz = midiToHz(67);

    const handle = synth.playGlide({ fromMidi: 60, toMidi: 67, startAt, holdBefore, glideDuration, holdAfter, timbre: 'soft' });

    const osc = ctx.createdOscillators[0];
    const anchor = osc.frequency.events.find((e) => e.method === 'setValueAtTime');
    const ramp = osc.frequency.events.find((e) => e.method === 'exponentialRampToValueAtTime');

    expect(anchor).toBeDefined();
    expect(anchor!.value).toBeCloseTo(fromHz, 6);
    expect(anchor!.time).toBeCloseTo(startAt + holdBefore, 9);

    expect(ramp).toBeDefined();
    expect(ramp!.value).toBeCloseTo(toHz, 6);
    expect(ramp!.time).toBeCloseTo(startAt + holdBefore + glideDuration, 9);

    // Amplitude envelope spans the whole hold+glide+hold and never starts at a discontinuity.
    const gain = ctx.createdGains[1].gain; // [0] is the synth's master gain
    expect(gain.events[0]).toEqual({ method: 'setValueAtTime', value: 0, time: startAt });
    expect(handle.endAt).toBeGreaterThan(startAt + holdBefore + glideDuration + holdAfter);
  });

  it('exponential-in-Hz glide direction is correct for a descending glide too', () => {
    const ctx = makeCtx();
    const destination = new FakeAudioNode();
    const synth = createSynth(ctx as unknown as BaseAudioContext, destination as unknown as AudioNode);
    synth.playGlide({ fromMidi: 72, toMidi: 60, startAt: 0, holdBefore: 0, glideDuration: 0.4, holdAfter: 0 });
    const osc = ctx.createdOscillators[0];
    const ramp = osc.frequency.events.find((e) => e.method === 'exponentialRampToValueAtTime');
    expect(ramp!.value).toBeCloseTo(midiToHz(60), 6);
    expect(ramp!.value).toBeLessThan(midiToHz(72));
  });
});

describe('createSynth: playSequence', () => {
  it('schedules every note relative to the sequence start and aggregates start/end', () => {
    const ctx = makeCtx();
    const destination = new FakeAudioNode();
    const synth = createSynth(ctx as unknown as BaseAudioContext, destination as unknown as AudioNode);

    const seqStart = 5;
    const handle = synth.playSequence(
      [
        { midi: 60, start: 0, duration: 0.5 },
        { midi: 64, start: 0.5, duration: 0.5 },
        { midi: 67, start: 1.0, duration: 1.0 },
      ],
      { startAt: seqStart, timbre: 'sine' },
    );

    expect(ctx.createdOscillators).toHaveLength(3);
    expect(ctx.createdOscillators.every((o) => o.type === 'sine')).toBe(true);
    expect(ctx.createdOscillators[2].startTimes[0]).toBeCloseTo(seqStart + 1.0, 9);
    expect(handle.startAt).toBe(seqStart);
    expect(handle.endAt).toBeGreaterThanOrEqual(seqStart + 1.0 + 1.0);
  });

  it('stop() stops every underlying voice', () => {
    const ctx = makeCtx();
    const destination = new FakeAudioNode();
    const synth = createSynth(ctx as unknown as BaseAudioContext, destination as unknown as AudioNode);
    const handle = synth.playSequence([
      { midi: 60, start: 0, duration: 5 },
      { midi: 64, start: 1, duration: 5 },
    ]);
    handle.stop();
    for (const g of ctx.createdGains.slice(1)) {
      // [0] is the synth's master gain, which playSequence/stop() never touches.
      expect(g.gain.events.some((e) => e.method === 'cancelScheduledValues')).toBe(true);
    }
  });
});

describe('createSynth: click', () => {
  it('accent is louder and higher-pitched than a plain click, and both are a short, harmonic-rich burst', () => {
    const ctx = makeCtx();
    const destination = new FakeAudioNode();
    const synth = createSynth(ctx as unknown as BaseAudioContext, destination as unknown as AudioNode);

    synth.click(1, false);
    synth.click(2, true);
    const [plain, accent] = ctx.createdOscillators;
    const [, plainGain, accentGain] = ctx.createdGains; // [0] is the synth's master gain

    expect(plain.type).toBe('square');
    expect(accent.type).toBe('square');
    expect(accent.frequency.value).toBeGreaterThan(plain.frequency.value);

    const plainPeak = Math.max(...plainGain.gain.events.map((e) => e.value ?? 0));
    const accentPeak = Math.max(...accentGain.gain.events.map((e) => e.value ?? 0));
    expect(accentPeak).toBeGreaterThan(plainPeak);

    // Sharp onset, short burst: starts at 0, ends at (near) 0 within ~10ms of `at`.
    const events = plainGain.gain.events;
    expect(events[0]).toEqual({ method: 'setValueAtTime', value: 0, time: 1 });
    expect(events[events.length - 1].value).toBe(0);
    expect(events[events.length - 1].time - 1).toBeLessThanOrEqual(0.015);
  });

  const peakOf = (g: FakeGainNode): number => Math.max(...g.gain.events.map((e) => e.value ?? 0));

  it('without a level it is the full calibration click (latency calibration listens for it); with one, a musical click at that level', () => {
    const ctx = makeCtx();
    const synth = createSynth(ctx as unknown as BaseAudioContext, new FakeAudioNode() as unknown as AudioNode);
    synth.click(1, true);
    synth.click(2, false);
    synth.click(3, true, 0.28);
    synth.click(4, false, 0.28);
    synth.click(5, true, 0);
    const [, cal, calPlain, music, musicPlain] = ctx.createdGains;
    expect(peakOf(cal)).toBe(0.9);
    expect(peakOf(calPlain)).toBe(0.6);
    expect(peakOf(music)).toBeCloseTo(0.28, 9);
    expect(peakOf(musicPlain)).toBeCloseTo((0.28 * 2) / 3, 9);
    expect(ctx.createdOscillators).toHaveLength(4); // a muted click schedules nothing
  });

  it('a musical click follows the reference volume, well under the notes it plays against', () => {
    expect(musicalClickGain(0.7)).toBeCloseTo(0.7 * CLICK_SHARE_OF_REFERENCE, 9);
    expect(musicalClickGain(5)).toBe(CLICK_SHARE_OF_REFERENCE);
    expect(musicalClickGain(0)).toBe(0);
    // A click on a note's downbeat plus the note itself stays under full scale at any volume.
    for (const v of [0.3, 0.7, 1]) expect(v + musicalClickGain(v)).toBeLessThan(1.5);
    expect(0.7 + musicalClickGain(0.7)).toBeLessThan(1);
  });
});

describe('createSynth: the soft limiter at its output', () => {
  it('passes everything up to the knee unchanged (the calibration click included) and never reaches past the ceiling', () => {
    for (const x of [0, 0.1, -0.5, 0.6, 0.9, -0.9]) expect(softLimit(x)).toBe(x);
    expect(SOFT_LIMIT_KNEE).toBeGreaterThanOrEqual(0.9);
    let prev = softLimit(SOFT_LIMIT_KNEE);
    for (let x = SOFT_LIMIT_KNEE + 0.01; x <= 3; x += 0.01) {
      const y = softLimit(x);
      expect(y).toBeGreaterThanOrEqual(prev); // monotonic: louder in, never quieter out (no fold-over)
      expect(y).toBeLessThanOrEqual(SOFT_LIMIT_CEILING);
      expect(softLimit(-x)).toBe(-y);
      prev = y;
    }
    // Smooth at the knee: no kink in level.
    expect(softLimit(SOFT_LIMIT_KNEE + 1e-4) - SOFT_LIMIT_KNEE).toBeCloseTo(1e-4, 6);
  });

  it('routes the master through a WaveShaper with that curve (no oversampling, so no added latency) when the context has one', () => {
    class ShaperCtx extends FakeAudioContext {
      shapers: Array<FakeAudioNode & { curve: Float32Array | null; oversample: string }> = [];
      createWaveShaper(): FakeAudioNode & { curve: Float32Array | null; oversample: string } {
        const s = Object.assign(new FakeAudioNode(), { curve: null as Float32Array | null, oversample: 'none' });
        this.shapers.push(s);
        return s;
      }
    }
    const ctx = new ShaperCtx();
    const destination = new FakeAudioNode();
    createSynth(ctx as unknown as BaseAudioContext, destination as unknown as AudioNode);
    const [master, scale] = ctx.createdGains;
    const [shaper] = ctx.shapers;
    expect(master.connections).toEqual([scale]);
    expect(scale.connections).toEqual([shaper]);
    expect(shaper.connections).toEqual([destination]);
    expect(shaper.oversample).toBe('none');
    // The curve maps the scaled input [-1, 1] back through softLimit: identity below the knee.
    const curve = shaper.curve!;
    const range = 1 / scale.gain.value;
    const at = (input: number): number => curve[Math.round(((input / range + 1) / 2) * (curve.length - 1))];
    expect(at(0)).toBeCloseTo(0, 6);
    expect(at(0.5)).toBeCloseTo(0.5, 3);
    expect(at(0.9)).toBeCloseTo(0.9, 3);
    expect(at(1.6)).toBeLessThan(SOFT_LIMIT_CEILING);
    expect(Math.max(...curve)).toBeLessThan(1);
  });

  it('connects straight through where the context has no WaveShaper', () => {
    const ctx = makeCtx();
    const destination = new FakeAudioNode();
    const synth = createSynth(ctx as unknown as BaseAudioContext, destination as unknown as AudioNode);
    expect(ctx.createdGains[0].connections).toEqual([destination]);
    expect(synth.input).toBe(ctx.createdGains[0]); // its own voices' mix, for callers with voices of their own
  });
});

describe('createSynth: stopAll', () => {
  it('releases an active note (cancels future automation, ramps to 0, stops the oscillator)', () => {
    const ctx = makeCtx();
    const destination = new FakeAudioNode();
    const synth = createSynth(ctx as unknown as BaseAudioContext, destination as unknown as AudioNode);

    ctx.currentTime = 0;
    synth.playNote({ midi: 60, startAt: 0, duration: 10, timbre: 'soft' });
    ctx.currentTime = 2; // mid-note
    synth.stopAll();

    const gain = ctx.createdGains[1].gain; // [0] is the synth's master gain
    const osc = ctx.createdOscillators[0];
    expect(gain.events.some((e) => e.method === 'cancelScheduledValues' && e.time === 2)).toBe(true);
    const finalRamp = gain.events[gain.events.length - 1];
    expect(finalRamp.method).toBe('linearRampToValueAtTime');
    expect(finalRamp.value).toBe(0);
    expect(finalRamp.time).toBeCloseTo(2.06, 9); // 2s + 60ms release
    // The oscillator's stop time was pulled in well before the original 10s note end.
    expect(osc.stopTimes[osc.stopTimes.length - 1]).toBeLessThan(10);
  });

  it('calling stop() twice on the same handle is a no-op the second time', () => {
    const ctx = makeCtx();
    const destination = new FakeAudioNode();
    const synth = createSynth(ctx as unknown as BaseAudioContext, destination as unknown as AudioNode);
    const handle = synth.playNote({ midi: 60, startAt: 0, duration: 5 });
    handle.stop();
    const countAfterFirst = ctx.createdGains[1].gain.events.length; // [0] is the synth's master gain
    handle.stop();
    expect(ctx.createdGains[1].gain.events.length).toBe(countAfterFirst);
  });
});

describe('createSynth: setVolume', () => {
  it('smoothly approaches the clamped target via setTargetAtTime on the master gain', () => {
    const ctx = makeCtx();
    const destination = new FakeAudioNode();
    const synth = createSynth(ctx as unknown as BaseAudioContext, destination as unknown as AudioNode);
    const master = ctx.createdGains[0]; // created inside createSynth, before any notes

    ctx.currentTime = 1;
    synth.setVolume(0.5);
    synth.setVolume(5); // clamps to 1
    synth.setVolume(-3); // clamps to 0

    expect(master.gain.events).toEqual([
      { method: 'setTargetAtTime', value: 0.5, time: 1, timeConstant: 0.01 },
      { method: 'setTargetAtTime', value: 1, time: 1, timeConstant: 0.01 },
      { method: 'setTargetAtTime', value: 0, time: 1, timeConstant: 0.01 },
    ]);
  });
});

// ---------------------------------------------------------------------------

describe('beatsInWindow / nextBeatAtOrAfter (metronome maths)', () => {
  it('nextBeatAtOrAfter finds the next grid point at or after t, including when t sits exactly on a beat', () => {
    expect(nextBeatAtOrAfter(1.0, 120, 1.0)).toEqual({ index: 0, time: 1.0 });
    expect(nextBeatAtOrAfter(1.0, 120, 1.26)).toEqual({ index: 1, time: 1.5 });
    expect(nextBeatAtOrAfter(1.0, 120, 0.9)).toEqual({ index: 0, time: 1.0 });
  });

  it('nextBeatAtOrAfter handles times before beat0 (negative indices)', () => {
    expect(nextBeatAtOrAfter(1.0, 120, -0.5)).toEqual({ index: -3, time: -0.5 });
    expect(nextBeatAtOrAfter(1.0, 120, -0.4)).toEqual({ index: -2, time: 0.0 });
  });

  it('beatsInWindow returns every grid point in [from, to), half-open', () => {
    const beats = beatsInWindow(1.0, 120, 1.0, 3.0); // spb = 0.5
    expect(beats).toEqual([
      { index: 0, time: 1.0 },
      { index: 1, time: 1.5 },
      { index: 2, time: 2.0 },
      { index: 3, time: 2.5 },
    ]);
  });

  it('beatsInWindow excludes `to` itself and includes `from` itself', () => {
    expect(beatsInWindow(0, 60, 1.0, 2.0)).toEqual([{ index: 1, time: 1.0 }]); // spb = 1 at 60bpm
    expect(beatsInWindow(0, 60, 1.0, 1.0)).toEqual([]); // empty window
  });

  it('beatsInWindow covers beats before beat0 when the window starts earlier', () => {
    const beats = beatsInWindow(1.0, 120, -0.5, 1.0);
    expect(beats).toEqual([
      { index: -3, time: -0.5 },
      { index: -2, time: 0.0 },
      { index: -1, time: 0.5 },
    ]);
  });

  it('consecutive, non-overlapping windows tile the timeline with no gaps or duplicates', () => {
    const beat0 = 0.37;
    const bpm = 144;
    const a = beatsInWindow(beat0, bpm, 0, 1);
    const b = beatsInWindow(beat0, bpm, 1, 2);
    const whole = beatsInWindow(beat0, bpm, 0, 2);
    expect([...a, ...b]).toEqual(whole);
  });
});

describe('startMetronome (integration, simulated clock)', () => {
  let ctx: FakeAudioContext;
  let destination: FakeAudioNode;

  beforeEach(() => {
    vi.useFakeTimers();
    ctx = makeCtx();
    destination = new FakeAudioNode();
  });

  /** Advance both the fake JS timers and the simulated AudioContext clock together. */
  function tick(ms: number): void {
    ctx.currentTime += ms / 1000;
    vi.advanceTimersByTime(ms);
  }

  it('fires accented downbeats and plain off-beats on schedule, honouring beatsPerBar', () => {
    const synth = createSynth(ctx as unknown as BaseAudioContext, destination as unknown as AudioNode);
    const handle = synth.startMetronome(120, { beatsPerBar: 4, startAt: 1.0 }); // spb = 0.5
    expect(handle.beat0).toBe(1.0);
    expect(handle.bpm).toBe(120);

    tick(2500); // covers beats at 1.0, 1.5, 2.0, 2.5 (currentTime reaches 2.5 + lookahead)

    const clicks = ctx.createdOscillators.filter((o) => o.type === 'square');
    expect(clicks.length).toBeGreaterThanOrEqual(4);
    const [b0, b1, b2, b3] = clicks;
    expect(b0.startTimes[0]).toBeCloseTo(1.0, 9);
    expect(b1.startTimes[0]).toBeCloseTo(1.5, 9);
    expect(b2.startTimes[0]).toBeCloseTo(2.0, 9);
    expect(b3.startTimes[0]).toBeCloseTo(2.5, 9);
    // The downbeat (index 0) is accented (higher pitch); the other beats in the bar are not,
    // and share the same (non-accent) pitch as each other.
    expect(b0.frequency.value).toBeGreaterThan(b1.frequency.value);
    expect(b1.frequency.value).toBe(b2.frequency.value);
    expect(b2.frequency.value).toBe(b3.frequency.value);

    handle.stop();
    const countAtStop = ctx.createdOscillators.length;
    tick(2000);
    expect(ctx.createdOscillators.length).toBe(countAtStop); // nothing scheduled after stop()
  });

  it('countInBeats pushes the real downbeat out and still accents it correctly', () => {
    const synth = createSynth(ctx as unknown as BaseAudioContext, destination as unknown as AudioNode);
    // bpm 120 (spb 0.5), 2-beat count-in: first click at ~0.03s, downbeat at ~1.03s.
    const handle = synth.startMetronome(120, { beatsPerBar: 4, countInBeats: 2 });
    tick(1200);
    const clicks = ctx.createdOscillators.filter((o) => o.type === 'square');
    expect(clicks.length).toBeGreaterThanOrEqual(3);
    expect(clicks[0].startTimes[0]).toBeCloseTo(handle.beat0 - 1.0, 6); // count-in beat -2
    expect(clicks[1].startTimes[0]).toBeCloseTo(handle.beat0 - 0.5, 6); // count-in beat -1
    expect(clicks[2].startTimes[0]).toBeCloseTo(handle.beat0, 6); // the real downbeat
    expect(clicks[2].frequency.value).toBeGreaterThan(clicks[1].frequency.value); // accented
  });

  it('setBpm re-anchors at the next beat and keeps the bar position (accent pattern) continuous', () => {
    const synth = createSynth(ctx as unknown as BaseAudioContext, destination as unknown as AudioNode);
    const handle = synth.startMetronome(120, { beatsPerBar: 4, startAt: 0 }); // spb 0.5: beats 0,.5,1,1.5,2,2.5,...
    tick(1100); // beats 0 (accent), .5, 1.0 fired; currentTime ~1.1
    handle.setBpm(60); // spb becomes 1.0, re-anchored at the next beat (1.5)

    tick(3000); // run well past several more beats at the new tempo

    const clicks = ctx.createdOscillators.filter((o) => o.type === 'square');
    const times = clicks.map((c) => c.startTimes[0]);
    // Beats before the change stay on the old grid; the re-anchor beat (index 3, an off-beat -> not accented)
    // lands exactly at 1.5 and the tempo from there is 1 full second per beat.
    expect(times).toEqual(expect.arrayContaining([0, 0.5, 1.0, 1.5, 2.5, 3.5]));
    const beatAt1_5 = clicks[times.indexOf(1.5)];
    expect(beatAt1_5.frequency.value).toBe(clicks[1].frequency.value); // same (off-beat) accent class as beat index 1
  });
});
