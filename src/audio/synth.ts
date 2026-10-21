/**
 * Reference synth: plain Web Audio (no Tone.js — its ~77 KB gzip buys nothing
 * we don't already get from a handful of oscillators and gain envelopes).
 * Everything is scheduled on the given AudioContext/OfflineAudioContext clock
 * so demos, the metronome and exercise targets all line up on one timeline.
 *
 * Timbres are PeriodicWaves (one oscillator per voice, cheap): 'piano' is a
 * bright additive tone with a fast pluck and a decay toward a low sustain
 * (good for short note cues); 'soft' is a warm, steady tone (drones, long
 * holds, vibrato demos); 'sine' is the bare oscillator type.
 *
 * Note scheduling allocates nodes per call (unavoidable: a Web Audio source
 * node is one-shot), which is fine — this is a human-interaction-rate API,
 * not a per-audio-frame hot path.
 */
import type {
  GlideSpec,
  MetronomeHandle,
  NoteSpec,
  ReferenceSynth,
  ScheduledHandle,
  SequenceNote,
  Timbre,
  VibratoSpec,
} from './synth-types';
import { midiToHz } from '../core/music';

/** `NoteSpec.startAt` / `GlideSpec.startAt` default: a small safety lead so the first render quantum isn't missed. */
const DEFAULT_START_LEAD_SEC = 0.03;
/** "Release ~60 ms ramp, no clicks" (spec). Used for both natural note end and an early stop(). */
const RELEASE_SEC = 0.06;
/** Extra pad after a release ramp before calling `osc.stop()`, so the ramp finishes inside the node's lifetime. */
const STOP_PAD_SEC = 0.01;

const DEFAULT_TIMBRE: Timbre = 'piano';

// ---------------------------------------------------------------------------
// Timbre tables (createPeriodicWave): index 0 is the DC term, ignored by the
// Web Audio spec (left at 0). Each table is normalised by the browser, so
// relative amplitudes define the character; absolute loudness comes from the
// per-voice gain envelope.

/** Bright additive partials: fundamental-heavy with a full, slowly-rolling-off harmonic series. */
const PIANO_REAL = new Float32Array([0, 1, 0.6, 0.4, 0.25, 0.16, 0.1, 0.07, 0.05]);
const PIANO_IMAG = new Float32Array(PIANO_REAL.length);

/** Warm, steady partials: fundamental plus a weak 2nd and fainter 3rd harmonic. */
const SOFT_REAL = new Float32Array([0, 1, 0.3, 0.1]);
const SOFT_IMAG = new Float32Array(SOFT_REAL.length);

interface EnvelopeShape {
  /** Linear rise to peak, seconds. */
  attackSec: number;
  /** Exponential decay from peak toward `sustainLevel * peak`, seconds. Omitted = steady sustain at peak. */
  decaySec?: number;
  /** Fraction of peak held during sustain (1 = no decay). */
  sustainLevel: number;
}

const ENVELOPES: Record<Timbre, EnvelopeShape> = {
  // Fast pluck, decays toward a low sustain: a clean, percussive note cue.
  piano: { attackSec: 0.005, decaySec: 0.35, sustainLevel: 0.25 },
  // Slow swell to a steady sustain: drones, long notes, vibrato demos.
  soft: { attackSec: 0.03, sustainLevel: 1 },
  // Plain reference tone: quick, steady.
  sine: { attackSec: 0.01, sustainLevel: 1 },
};

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---------------------------------------------------------------------------
// Metronome scheduling maths (pure, exported for tests).

/** The earliest beat at or after time `t`, on the grid `beat0 + k * (60 / bpm)`. */
export function nextBeatAtOrAfter(beat0: number, bpm: number, t: number): { index: number; time: number } {
  const secPerBeat = 60 / bpm;
  const EPS = 1e-9;
  const k = Math.ceil((t - beat0) / secPerBeat - EPS) || 0; // `|| 0` normalises a -0 result (ceil of a tiny negative) to +0
  return { index: k, time: beat0 + k * secPerBeat };
}

/** Every beat on the `beat0`/`bpm` grid whose time lies in `[from, to)`, including beats before `beat0` (negative index). */
export function beatsInWindow(beat0: number, bpm: number, from: number, to: number): { index: number; time: number }[] {
  if (!(to > from)) return [];
  const secPerBeat = 60 / bpm;
  const out: { index: number; time: number }[] = [];
  let b = nextBeatAtOrAfter(beat0, bpm, from);
  while (b.time < to) {
    out.push(b);
    b = { index: b.index + 1, time: b.time + secPerBeat };
  }
  return out;
}

// ---------------------------------------------------------------------------

export function createSynth(ctx: BaseAudioContext, destination: AudioNode): ReferenceSynth {
  const master = ctx.createGain();
  master.gain.value = 1;
  master.connect(destination);

  // PeriodicWaves are shared across every voice of that timbre (safe: a PeriodicWave is immutable once created).
  const pianoWave = ctx.createPeriodicWave(PIANO_REAL, PIANO_IMAG);
  const softWave = ctx.createPeriodicWave(SOFT_REAL, SOFT_IMAG);

  /** Every currently-sounding voice/metronome, so stopAll() can release them. Entries remove themselves when they end. */
  const active = new Set<{ stop: () => void }>();
  function registerVoice(stopFn: () => void): () => void {
    const entry = { stop: stopFn };
    active.add(entry);
    return () => active.delete(entry);
  }

  function makeOscillator(timbre: Timbre, startHz: number): OscillatorNode {
    const osc = ctx.createOscillator();
    if (timbre === 'piano') osc.setPeriodicWave(pianoWave);
    else if (timbre === 'soft') osc.setPeriodicWave(softWave);
    else osc.type = 'sine';
    osc.frequency.value = startHz;
    return osc;
  }

  /**
   * Schedule a click/decay amplitude envelope on `gain`. Always starts from an
   * explicit 0 at `startAt` (never a bare discontinuity) and holds a known,
   * analytically-computed value into the release so the release ramp starts
   * from the right place even though every event here is scheduled ahead of
   * real time (reading `.value` now would NOT give the future held value).
   * Returns the time the signal reaches exactly 0.
   */
  function scheduleEnvelope(gain: AudioParam, timbre: Timbre, startAt: number, duration: number, peak: number): number {
    const shape = ENVELOPES[timbre];
    const attackSec = Math.min(shape.attackSec, duration);
    const releaseStart = startAt + duration;

    gain.setValueAtTime(0, startAt);
    gain.linearRampToValueAtTime(peak, startAt + attackSec);

    let heldValue = peak;
    if (shape.decaySec !== undefined && shape.sustainLevel < 1) {
      const decayEnd = Math.min(startAt + attackSec + shape.decaySec, releaseStart);
      if (decayEnd > startAt + attackSec) {
        const target = Math.max(peak * shape.sustainLevel, 1e-4);
        gain.exponentialRampToValueAtTime(target, decayEnd);
        heldValue = target;
      }
    }
    // Re-anchor explicitly at the held value right before release: the decay (or attack) ramp already
    // holds this value from its end time, but a fresh event here guarantees the release ramp's start
    // point regardless of which branch above ran.
    gain.setValueAtTime(heldValue, releaseStart);
    gain.linearRampToValueAtTime(0, releaseStart + RELEASE_SEC);
    return releaseStart + RELEASE_SEC;
  }

  /** Cut a voice short: cancel future automation and ramp to 0 from whatever the gain actually is right now. */
  function releaseEarly(gain: AudioParam, stopNodes: readonly AudioScheduledSourceNode[]): void {
    const t = ctx.currentTime;
    gain.cancelScheduledValues(t);
    gain.setValueAtTime(gain.value, t);
    gain.linearRampToValueAtTime(0, t + RELEASE_SEC);
    const stopAt = t + RELEASE_SEC + STOP_PAD_SEC;
    for (const n of stopNodes) n.stop(stopAt);
  }

  /** Vibrato LFO -> depth gain (in cents, matching `detune`'s unit exactly) -> the voice oscillator's detune. */
  function attachVibrato(osc: OscillatorNode, vibrato: VibratoSpec, startAt: number): OscillatorNode {
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = vibrato.rateHz;
    const depth = ctx.createGain();
    const delay = vibrato.delaySec ?? 0;
    const fadeIn = vibrato.fadeInSec ?? 0;
    depth.gain.setValueAtTime(0, startAt);
    if (fadeIn > 0) {
      depth.gain.setValueAtTime(0, startAt + delay);
      depth.gain.linearRampToValueAtTime(vibrato.extentCents, startAt + delay + fadeIn);
    } else {
      depth.gain.setValueAtTime(vibrato.extentCents, startAt + delay);
    }
    lfo.connect(depth).connect(osc.detune);
    lfo.start(startAt);
    return lfo;
  }

  function playNote(spec: NoteSpec): ScheduledHandle {
    const startAt = spec.startAt ?? ctx.currentTime + DEFAULT_START_LEAD_SEC;
    const timbre = spec.timbre ?? DEFAULT_TIMBRE;
    const peak = clamp01(spec.gain ?? 1);
    const hz = midiToHz(spec.midi);

    const osc = makeOscillator(timbre, hz);
    const gain = ctx.createGain();
    osc.connect(gain).connect(master);

    const naturalEnd = scheduleEnvelope(gain.gain, timbre, startAt, spec.duration, peak);
    const lfo = spec.vibrato ? attachVibrato(osc, spec.vibrato, startAt) : null;

    osc.start(startAt);
    osc.stop(naturalEnd + STOP_PAD_SEC);
    lfo?.stop(naturalEnd + STOP_PAD_SEC);

    let stopped = false;
    const unregister = registerVoice(() => {
      if (stopped) return;
      stopped = true;
      releaseEarly(gain.gain, lfo ? [osc, lfo] : [osc]);
    });
    osc.addEventListener('ended', unregister);

    return {
      startAt,
      endAt: naturalEnd,
      stop(): void {
        if (stopped) return;
        stopped = true;
        unregister();
        releaseEarly(gain.gain, lfo ? [osc, lfo] : [osc]);
      },
    };
  }

  function playGlide(spec: GlideSpec): ScheduledHandle {
    const startAt = spec.startAt ?? ctx.currentTime + DEFAULT_START_LEAD_SEC;
    const timbre = spec.timbre ?? DEFAULT_TIMBRE;
    const peak = clamp01(spec.gain ?? 1);
    const fromHz = midiToHz(spec.fromMidi);
    const toHz = midiToHz(spec.toMidi);
    const glideStart = startAt + spec.holdBefore;
    const glideEnd = glideStart + spec.glideDuration;
    const totalDuration = spec.holdBefore + spec.glideDuration + spec.holdAfter;

    const osc = makeOscillator(timbre, fromHz);
    // Exponential in Hz = linear in pitch. Re-anchor at `glideStart` (not just the synchronous .value
    // assignment above) so the ramp's "previous event" is at the right time even if startAt is in the future.
    osc.frequency.setValueAtTime(fromHz, glideStart);
    osc.frequency.exponentialRampToValueAtTime(toHz, glideEnd);

    const gain = ctx.createGain();
    osc.connect(gain).connect(master);
    const naturalEnd = scheduleEnvelope(gain.gain, timbre, startAt, totalDuration, peak);

    osc.start(startAt);
    osc.stop(naturalEnd + STOP_PAD_SEC);

    let stopped = false;
    const unregister = registerVoice(() => {
      if (stopped) return;
      stopped = true;
      releaseEarly(gain.gain, [osc]);
    });
    osc.addEventListener('ended', unregister);

    return {
      startAt,
      endAt: naturalEnd,
      stop(): void {
        if (stopped) return;
        stopped = true;
        unregister();
        releaseEarly(gain.gain, [osc]);
      },
    };
  }

  function playSequence(
    notes: readonly SequenceNote[],
    opts?: { startAt?: number; timbre?: Timbre; gain?: number },
  ): ScheduledHandle {
    const seqStart = opts?.startAt ?? ctx.currentTime + DEFAULT_START_LEAD_SEC;
    const handles = notes.map((n) =>
      playNote({
        midi: n.midi,
        startAt: seqStart + n.start,
        duration: n.duration,
        gain: n.gain ?? opts?.gain,
        timbre: opts?.timbre,
      }),
    );
    const endAt = handles.reduce((max, h) => Math.max(max, h.endAt), seqStart);
    let stopped = false;
    return {
      startAt: seqStart,
      endAt,
      stop(): void {
        if (stopped) return;
        stopped = true;
        for (const h of handles) h.stop();
      },
    };
  }

  /** Loud, sharp-onset burst (~1 ms rise, ~10 ms total): a clean transient for loopback latency detection. */
  function fireClick(at: number, accent: boolean): void {
    const freq = accent ? 2800 : 1800;
    const peak = accent ? 0.9 : 0.6;
    const RISE_SEC = 0.001;
    const DECAY_SEC = 0.007;
    const TOTAL_SEC = 0.01;

    const osc = ctx.createOscillator();
    osc.type = 'square'; // harmonic-rich: a sharp, reliably-detectable transient
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(peak, at + RISE_SEC);
    gain.gain.exponentialRampToValueAtTime(Math.max(peak * 0.02, 1e-4), at + DECAY_SEC);
    gain.gain.linearRampToValueAtTime(0, at + TOTAL_SEC);
    osc.connect(gain).connect(master);
    osc.start(at);
    osc.stop(at + TOTAL_SEC + STOP_PAD_SEC);

    let stopped = false;
    const unregister = registerVoice(() => {
      if (stopped) return;
      stopped = true;
      releaseEarly(gain.gain, [osc]);
    });
    osc.addEventListener('ended', unregister);
  }

  function click(at: number, accent = false): void {
    fireClick(at, accent);
  }

  /** `~25 ms` scheduler tick; each tick looks `~120 ms` ahead on the AudioContext clock ("A Tale of Two Clocks"). */
  const METRONOME_TICK_MS = 25;
  const METRONOME_LOOKAHEAD_SEC = 0.12;

  function startMetronome(
    bpm: number,
    opts?: { beatsPerBar?: number; startAt?: number; countInBeats?: number },
  ): MetronomeHandle {
    const beatsPerBar = opts?.beatsPerBar ?? 4;
    const countInBeats = opts?.countInBeats ?? 0;
    // Default beat0 leaves room for the count-in to run starting right away (now + lead); an explicit
    // startAt is taken as the caller's exact intended downbeat time, count-in included or not is on them.
    const beat0 = opts?.startAt ?? ctx.currentTime + DEFAULT_START_LEAD_SEC + countInBeats * (60 / bpm);

    let currentBpm = bpm;
    // The scheduling anchor: beat `anchorIndex` happens at `anchorTime`. Re-anchored (not reset) by
    // setBpm so the bar position (accent pattern) and already-played beats are preserved exactly.
    let anchorIndex = -countInBeats;
    let anchorTime = beat0 - countInBeats * (60 / bpm);
    let scheduledUpTo = anchorTime;
    let stopped = false;

    function isDownbeat(absoluteIndex: number): boolean {
      return ((absoluteIndex % beatsPerBar) + beatsPerBar) % beatsPerBar === 0;
    }

    const timer = setInterval(() => {
      if (stopped) return;
      const to = ctx.currentTime + METRONOME_LOOKAHEAD_SEC;
      if (!(to > scheduledUpTo)) return;
      for (const b of beatsInWindow(anchorTime, currentBpm, scheduledUpTo, to)) {
        const absoluteIndex = anchorIndex + b.index;
        fireClick(b.time, isDownbeat(absoluteIndex));
      }
      scheduledUpTo = to;
    }, METRONOME_TICK_MS);

    const unregister = registerVoice(() => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    });

    return {
      startAt: anchorTime,
      endAt: Infinity, // runs until stop(); it has no inherent end.
      get bpm(): number {
        return currentBpm;
      },
      beat0,
      setBpm(newBpm: number): void {
        if (stopped) return;
        const now = ctx.currentTime;
        const pivot = nextBeatAtOrAfter(anchorTime, currentBpm, Math.max(now, scheduledUpTo));
        anchorIndex += pivot.index;
        anchorTime = pivot.time;
        currentBpm = newBpm;
      },
      stop(): void {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        unregister();
      },
    };
  }

  function stopAll(): void {
    for (const voice of [...active]) voice.stop();
    active.clear();
  }

  return {
    setVolume(v: number): void {
      // setTargetAtTime: smooth, click-free approach to a new level (useful for a live volume slider).
      master.gain.setTargetAtTime(clamp01(v), ctx.currentTime, 0.01);
    },
    playNote,
    playGlide,
    playSequence,
    click,
    startMetronome,
    stopAll,
  };
}
