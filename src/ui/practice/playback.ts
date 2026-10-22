/**
 * Take playback for the report (docs/DESIGN.md §13.5, SPEC §9.4): the take at speed, the take at half speed (WSOLA
 * time-stretch, so the pitch stays put), and for runs the target melody on the synth at the same slowed tempo
 * alongside it. The slowed copy is computed once, in small slices that yield to the main thread, while the report
 * celebrates; until it is ready only normal playback is offered.
 *
 * Audio stays on the device: it plays through the app's own AudioContext and goes nowhere else.
 */
import { signal, type ReadonlySignal } from '@preact/signals';
import type { TakeAudio } from '../../audio/take-recorder';
import type { ReferenceSynth, Timbre } from '../../audio/synth-types';
import type { TargetNote } from '../../core/types';
import { WsolaStretcher } from '../../dsp/wsola';

export type PlaybackMode = 'normal' | 'slow' | 'slow-target';

/** Slow playback speed: half. */
export const SLOW_RATE = 0.5;

/** Time the stretch may hold the main thread before it yields (ms), and the windows it tries per check. */
const SLICE_MS = 6;
const SLICE_FRAMES = 24;
/** Playback starts this long after the tap, so the source and the melody are scheduled on one clock. */
const START_LEAD_SEC = 0.06;

/** What playback needs from the device; the screen supplies the real engine, tests a fake. */
export interface PlaybackEnv {
  /** Create and resume the AudioContext, synchronously (it runs inside the tap), and say where sound goes. */
  acquire(): { ctx: BaseAudioContext; destination: AudioNode };
  /** The reference synth, for the target melody (only called for 'slow-target'). */
  synth(): ReferenceSynth;
}

export interface TakePlayerOptions {
  audio: TakeAudio;
  /** The melody for "Slow + target", take-relative seconds. Empty: that mode is not offered. */
  targetNotes: readonly TargetNote[];
  timbre: Timbre;
  /** 0..1, the singer's reference volume. */
  gain: number;
  env: PlaybackEnv;
  /** Test seam: how the stretch yields between slices. Default a macrotask. */
  yieldToMain?: () => Promise<void>;
}

export interface TakePlayer {
  /** The mode that is playing now. */
  readonly playing: ReadonlySignal<PlaybackMode | null>;
  /** The slowed copy is ready. */
  readonly slowReady: ReadonlySignal<boolean>;
  /** Set when playback could not start. */
  readonly error: ReadonlySignal<string | null>;
  /** Stop whatever is playing and start `mode`. Call straight from the click handler (iOS needs the gesture). */
  play(mode: PlaybackMode): void;
  stop(): void;
  /** Stop and drop the slowed copy; also cancels a stretch still running. */
  dispose(): void;
}

const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export function createTakePlayer(opts: TakePlayerOptions): TakePlayer {
  const { audio, targetNotes, env } = opts;
  const yieldToMain = opts.yieldToMain ?? macrotask;
  const playing = signal<PlaybackMode | null>(null);
  const slowReady = signal(false);
  const error = signal<string | null>(null);
  let slow: Float32Array | null = null;
  let disposed = false;
  let ticket = 0;
  let current: { source: AudioBufferSourceNode; melody: { stop(): void } | null } | null = null;

  async function prepareSlow(): Promise<void> {
    if (audio.samples.length === 0) return;
    try {
      const stretch = new WsolaStretcher(audio.samples, audio.sampleRate, SLOW_RATE);
      while (!stretch.done) {
        const until = performance.now() + SLICE_MS;
        do {
          stretch.process(SLICE_FRAMES);
        } while (!stretch.done && performance.now() < until);
        await yieldToMain();
        if (disposed) return;
      }
      slow = stretch.output;
      slowReady.value = true;
    } catch {
      // The slowed copy is a nicety: normal playback still works.
    }
  }
  void prepareSlow();

  function release(): void {
    const c = current;
    current = null;
    ticket++;
    playing.value = null;
    if (!c) return;
    c.source.onended = null;
    try {
      c.source.stop();
    } catch {
      // Already stopped.
    }
    c.melody?.stop();
  }

  function play(mode: PlaybackMode): void {
    release();
    error.value = null;
    const samples = mode === 'normal' ? audio.samples : slow;
    if (!samples || samples.length === 0) return;
    if (mode === 'slow-target' && targetNotes.length === 0) return;
    const rate = mode === 'normal' ? 1 : SLOW_RATE;
    try {
      const { ctx, destination } = env.acquire();
      const buffer = ctx.createBuffer(1, samples.length, audio.sampleRate);
      buffer.getChannelData(0).set(samples);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(destination);
      const startAt = ctx.currentTime + START_LEAD_SEC;
      const mine = ++ticket;
      source.onended = () => {
        if (mine !== ticket) return;
        current = null;
        playing.value = null;
      };
      source.start(startAt);
      const melody =
        mode === 'slow-target'
          ? env.synth().playSequence(
              targetNotes.map((n) => ({ midi: n.midi, start: n.start / rate, duration: (n.end - n.start) / rate })),
              { startAt, timbre: opts.timbre, gain: opts.gain },
            )
          : null;
      current = { source, melody };
      playing.value = mode;
    } catch {
      release();
      error.value = "Playback didn't start. Check the volume, then try again.";
    }
  }

  return {
    playing,
    slowReady,
    error,
    play,
    stop: release,
    dispose(): void {
      disposed = true;
      release();
      slow = null;
      slowReady.value = false;
    },
  };
}
