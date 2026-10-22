/**
 * Every exercise in the real catalog, realized for a real range, demoed
 * through the REAL reference synth (on a fake audio graph). This is the
 * integration check that `buildDemo` handles every kind of material the
 * exercise data actually produces, including Boss Recitals and auditions, and
 * that the cue vocabulary in src/exercises/cues.ts still means what the demos
 * think it means.
 */
import { describe, expect, it } from 'vitest';
import { CATALOG, getExercise } from '../exercises/catalog';
import { realize } from '../exercises/transpose';
import {
  BLOOM_FADE_IN_SEC,
  FALL_END_GAIN,
  SWELL_SOFT_GAIN,
  buildDemo,
  demoLayout,
  firstPassSec,
  planDemoVoices,
  styleZoneVibrato,
} from './demos';
import { createSynth } from './synth';

// A minimal Web Audio fake: enough for synth.ts and demos.ts, recording every scheduled start and stop.
class Param {
  value = 0;
  setValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  exponentialRampToValueAtTime(v: number): this {
    if (!(v > 0)) throw new RangeError('exponential ramp target must be > 0');
    this.value = v;
    return this;
  }
  setTargetAtTime(v: number): this {
    this.value = v;
    return this;
  }
  cancelScheduledValues(): this {
    return this;
  }
}
class Node {
  connect(d: unknown): unknown {
    return d;
  }
}
class Osc extends Node {
  type = 'sine';
  frequency = new Param();
  detune = new Param();
  starts: number[] = [];
  stops: number[] = [];
  setPeriodicWave(): void {}
  start(t = 0): void {
    this.starts.push(t);
  }
  stop(t = 0): void {
    this.stops.push(t);
  }
  addEventListener(): void {}
}
class Gain extends Node {
  gain = new Param();
}
class Ctx {
  currentTime = 50;
  oscs: Osc[] = [];
  createOscillator(): Osc {
    const o = new Osc();
    this.oscs.push(o);
    return o;
  }
  createGain(): Gain {
    return new Gain();
  }
  createPeriodicWave(): object {
    return {};
  }
}

const RANGES = [
  { name: 'beginner (default range)', range: null, voice: 'unknown' as const },
  {
    name: 'tenor with a saved range',
    range: { comfortable: { low: 48, high: 69 }, extended: { low: 43, high: 74 }, measuredAt: '2026-10-21T00:00:00.000Z' },
    voice: 'tenor' as const,
  },
];

describe('the whole catalog can be demoed', () => {
  for (const { name, range, voice } of RANGES) {
    describe(name, () => {
      for (const def of CATALOG.exercises) {
        it(def.id, () => {
          const realized = realize(def, range, voice);
          const ctx = new Ctx();
          const dest = new Node();
          const synth = createSynth(ctx as unknown as BaseAudioContext, dest as unknown as AudioNode);
          const startAt = 60;
          const handle = buildDemo(def, realized, synth, ctx as unknown as BaseAudioContext, dest as unknown as AudioNode, { startAt, vibratoStyle: 'pop' });

          // Something sounds (the real synth and/or a custom voice), it begins where asked and ends in finite time.
          expect(ctx.oscs.length).toBeGreaterThan(0);
          expect(handle.startAt).toBeGreaterThanOrEqual(startAt - 1e-9);
          expect(handle.startAt).toBeLessThan(startAt + realized.countInSec + 1);
          expect(Number.isFinite(handle.endAt)).toBe(true);
          // Not absurdly long: the pattern plus a slow pass (<= 4x) and release tails.
          const patternSec = realized.countInSec + realized.totalSec;
          expect(handle.endAt - startAt).toBeLessThan(patternSec * 4 + 20);
          // Every oscillator that starts also stops, no earlier than it starts.
          for (const o of ctx.oscs) {
            expect(o.starts).toHaveLength(1);
            expect(o.stops.length).toBeGreaterThan(0);
            expect(o.stops[0]).toBeGreaterThanOrEqual(o.starts[0]);
            expect(Number.isFinite(o.frequency.value)).toBe(true);
          }
          // The one-repetition demo is no longer than the full one.
          const once = buildDemo(def, realized, synth, ctx as unknown as BaseAudioContext, dest as unknown as AudioNode, {
            startAt,
            maxSec: firstPassSec(def, realized.bpm),
          });
          expect(once.endAt).toBeLessThanOrEqual(handle.endAt + 1e-9);
          handle.stop();
          once.stop();
        });
      }
    });
  }
});

// ---------------------------------------------------------------- what the real exercise data turns into

type Voice = ReturnType<typeof planDemoVoices>[number];

function voicesOf(id: string, style: 'pop' | 'classical' = 'pop'): Voice[] {
  const def = getExercise(id);
  if (!def) throw new Error(`no exercise ${id}`);
  return planDemoVoices(def, demoLayout(def, realize(def, null, 'unknown')), style);
}

const ofKind = <K extends Voice['kind']>(voices: Voice[], kind: K) => voices.filter((v): v is Extract<Voice, { kind: K }> => v.kind === kind);

describe('real exercises: the voices their demos are built from', () => {
  it('straight to bloom: every held note is one tone that blooms on the cue (delay, then a slow fade-in)', () => {
    const v = voicesOf('vibrato.bloom.1');
    expect(ofKind(v, 'shaped')).toHaveLength(0);
    const notes = ofKind(v, 'note');
    expect(notes.length).toBeGreaterThanOrEqual(3);
    for (const n of notes) {
      expect(n.vibrato).toMatchObject({ ...styleZoneVibrato('pop'), fadeInSec: BLOOM_FADE_IN_SEC });
      expect(n.vibrato!.delaySec).toBeGreaterThan(0);
      expect(n.vibrato!.delaySec).toBeLessThan(n.duration);
    }
  });

  it('on/off switching and its audition: ONE tone per held note with the vibrato depth switched on the cues', () => {
    for (const id of ['vibrato.switch.1', 'vibrato.audition.4']) {
      const shaped = ofKind(voicesOf(id), 'shaped');
      expect(shaped.length, id).toBeGreaterThanOrEqual(1);
      for (const s of shaped) {
        expect(s.vibrato!.rateHz).toBe(styleZoneVibrato('pop').rateHz);
        const fracs = s.vibrato!.depth.map((d) => d.frac);
        expect(Math.min(...fracs)).toBe(0);
        expect(Math.max(...fracs)).toBe(1);
        expect(s.pitch).toHaveLength(1); // one pitch the whole time
      }
    }
  });

  it('the vibrato Boss Recital blooms, switches, then blooms again', () => {
    const v = voicesOf('vibrato.boss-recital');
    expect(ofKind(v, 'note').filter((n) => n.vibrato?.delaySec !== undefined)).toHaveLength(2);
    expect(ofKind(v, 'shaped')).toHaveLength(1);
  });

  it('free vibrato (meter, audition) puts the style-zone vibrato on every held note', () => {
    for (const id of ['vibrato.meter.1', 'vibrato.audition.2']) {
      const notes = ofKind(voicesOf(id), 'note');
      expect(notes.length, id).toBeGreaterThanOrEqual(2);
      for (const n of notes) expect(n.vibrato).toEqual(styleZoneVibrato('pop'));
    }
    const classical = ofKind(voicesOf('vibrato.meter.1', 'classical'), 'note');
    expect(classical[0].vibrato).toEqual(styleZoneVibrato('classical'));
  });

  it('pulse builders: a tone per pitch, wobbling at 3.5, 4.5 and 5.5 Hz', () => {
    const rates = ['vibrato.pulse.1', 'vibrato.pulse.2', 'vibrato.pulse.3'].map((id) => {
      const notes = ofKind(voicesOf(id), 'note');
      expect(notes.length, id).toBeGreaterThanOrEqual(2);
      const r = notes[0].vibrato!.rateHz;
      for (const n of notes) expect(n.vibrato!.rateHz).toBeCloseTo(r, 6);
      return r;
    });
    expect(rates[0]).toBeCloseTo(3.5, 6);
    expect(rates[1]).toBeCloseTo(4.5, 6);
    expect(rates[2]).toBeCloseTo(5.5, 6);
  });

  it('oscillation drills are discrete alternating notes, not a wobble', () => {
    for (const id of ['vibrato.oscillation.1', 'vibrato.oscillation.2']) {
      const v = voicesOf(id);
      expect(ofKind(v, 'note'), id).toHaveLength(0);
      expect(ofKind(v, 'shaped'), id).toHaveLength(0);
    }
  });

  it('scoops glide up into the note and hold it; slides are hold-glide-hold; falls fade as they drop', () => {
    for (const g of ofKind(voicesOf('inflections.scoop.1'), 'glide')) {
      expect(g.toMidi).toBeGreaterThan(g.fromMidi);
      expect(g.holdBefore).toBe(0);
      expect(g.holdAfter).toBeGreaterThan(0);
    }
    for (const id of ['inflections.slide.1', 'inflections.slide.2']) {
      const glides = ofKind(voicesOf(id), 'glide');
      expect(glides.length, id).toBeGreaterThanOrEqual(3);
      for (const g of glides) {
        expect(g.holdBefore).toBeGreaterThan(0);
        expect(g.holdAfter).toBeGreaterThan(0);
      }
    }
    const falls = ofKind(voicesOf('inflections.fall.1'), 'shaped');
    expect(falls.length).toBeGreaterThanOrEqual(3);
    for (const f of falls) {
      expect(f.pitch[f.pitch.length - 1].midi).toBeLessThan(f.pitch[0].midi);
      expect(f.level[f.level.length - 1]).toMatchObject({ gain: FALL_END_GAIN, curve: 'exp' });
    }
    expect(ofKind(voicesOf('inflections.fall.1'), 'glide')).toHaveLength(0);
  });

  it('a capstone that mixes inflections demos each part its own way (turn and flip as notes, slide as a glide)', () => {
    const v = voicesOf('inflections.boss-recital');
    expect(ofKind(v, 'glide')).toHaveLength(1);
    expect(ofKind(v, 'sequence')[0].notes.length).toBeGreaterThanOrEqual(6);
    const audition = voicesOf('inflections.audition.1'); // scoop then fall
    expect(ofKind(audition, 'glide')).toHaveLength(1);
    expect(ofKind(audition, 'shaped')).toHaveLength(1);
  });

  it('sirens are continuous voices over the whole up-and-down path', () => {
    for (const id of ['foundations.siren.1', 'foundations.audition.2']) {
      const shaped = ofKind(voicesOf(id), 'shaped');
      expect(shaped.length, id).toBeGreaterThanOrEqual(1);
      for (const s of shaped) {
        const ps = s.pitch.map((p) => p.midi);
        expect(Math.max(...ps)).toBeGreaterThan(ps[0]); //  goes up...
        expect(ps[ps.length - 1]).toBe(ps[0]); //           ...and comes back
        expect(s.level).toHaveLength(0); //                 at a steady level
      }
    }
    expect(ofKind(voicesOf('foundations.range-finder.1'), 'glide')).toHaveLength(2);
  });

  it('crescendo grows, decrescendo fades, messa di voce swells and fades; every note of the drill is shaped', () => {
    const shapedOf = (id: string) => {
      const s = ofKind(voicesOf(id), 'shaped');
      expect(s.length, id).toBeGreaterThanOrEqual(1);
      return s;
    };
    for (const s of shapedOf('dynamics.swell.1')) {
      expect(s.initialGain).toBe(SWELL_SOFT_GAIN);
      expect(s.level[s.level.length - 1]).toMatchObject({ gain: 1, t: s.duration });
    }
    for (const s of shapedOf('dynamics.swell.2')) {
      expect(s.initialGain).toBe(1);
      expect(s.level[s.level.length - 1]).toMatchObject({ gain: SWELL_SOFT_GAIN, t: s.duration });
    }
    for (const id of ['dynamics.swell.3', 'dynamics.swell.5', 'dynamics.swell.6', 'dynamics.audition.3']) {
      for (const s of shapedOf(id)) {
        expect(s.initialGain).toBe(SWELL_SOFT_GAIN);
        expect(s.level[0]).toMatchObject({ gain: 1, t: s.duration / 2 }); // peak in the middle
        expect(s.level[1]).toMatchObject({ gain: SWELL_SOFT_GAIN, t: s.duration });
      }
    }
  });

  it('dynamic steps are ONE tone per held note: soft, loud, soft (and loud, soft, loud)', () => {
    const s = ofKind(voicesOf('dynamics.swell.4'), 'shaped');
    expect(s).toHaveLength(2);
    expect(s[0].initialGain).toBe(SWELL_SOFT_GAIN);
    expect(s[1].initialGain).toBe(1);
    for (const v of s) expect(v.level.filter((l) => l.curve === 'linear')).toHaveLength(2); // two level changes each
  });

  it('the dynamics Boss Recital chains a swell, soft/loud steps and a decrescendo', () => {
    const s = ofKind(voicesOf('dynamics.boss-recital'), 'shaped');
    expect(s).toHaveLength(3);
    expect(s[0].level).toHaveLength(2); //                                       swell: up, down
    expect(s[1].level.filter((l) => l.curve === 'linear')).toHaveLength(3); //   steps: four levels, three changes
    expect(s[2].initialGain).toBe(1); //                                         decrescendo starts loud
  });

  it('runs, legato, intervals, staccato, pitch match, sustain, turns and flips are plain notes only', () => {
    const plainIds = CATALOG.exercises
      .filter((d) => ['run', 'legato', 'intervals', 'staccato', 'pitch-match', 'sustain', 'turn', 'flip'].includes(d.kind))
      .map((d) => d.id);
    expect(plainIds.length).toBeGreaterThan(10);
    for (const id of plainIds) {
      const v = voicesOf(id);
      expect(
        v.every((x) => x.kind === 'sequence'),
        id,
      ).toBe(true);
    }
  });

  it('exercises that ask for a slow first pass get a second metronome run, the others one', () => {
    for (const def of CATALOG.exercises.filter((d) => d.metronome)) {
      const ctx = new Ctx();
      const dest = new Node();
      const synth = createSynth(ctx as unknown as BaseAudioContext, dest as unknown as AudioNode);
      let metronomes = 0;
      const real = synth.startMetronome.bind(synth);
      synth.startMetronome = (bpm, opts) => {
        metronomes++;
        return real(bpm, opts);
      };
      const h = buildDemo(def, realize(def, null, 'unknown'), synth, ctx as unknown as BaseAudioContext, dest as unknown as AudioNode, { startAt: 60 });
      expect(metronomes, def.id).toBe(def.demo.slowFirst ? 2 : 1);
      h.stop();
    }
  });
});
