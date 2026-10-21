/**
 * Reference-audio contract: plain Web Audio (no Tone.js). Everything is
 * scheduled on the AudioContext clock so exercises, demos, metronome and the
 * pitch track share one timeline.
 */

export type Timbre = 'piano' | 'sine' | 'soft';

export interface VibratoSpec {
  rateHz: number;
  /** Half peak-to-trough, cents (i.e. +/- extentCents around the note). */
  extentCents: number;
  /** Seconds of straight tone before vibrato starts ("straight to bloom" demo). */
  delaySec?: number;
  /** Seconds over which the vibrato depth fades in after the delay. */
  fadeInSec?: number;
}

export interface NoteSpec {
  /** Fractional MIDI allowed. */
  midi: number;
  /** AudioContext time; default: ctx.currentTime + a small safety lead. */
  startAt?: number;
  duration: number;
  /** Linear 0..1, multiplied by the synth master volume. */
  gain?: number;
  timbre?: Timbre;
  vibrato?: VibratoSpec;
}

export interface GlideSpec {
  fromMidi: number;
  toMidi: number;
  startAt?: number;
  /** Seconds holding fromMidi before the glide begins. */
  holdBefore: number;
  /** Glide duration, seconds (linear in pitch, i.e. exponential in Hz). */
  glideDuration: number;
  /** Seconds holding toMidi after arriving. */
  holdAfter: number;
  gain?: number;
  timbre?: Timbre;
}

export interface SequenceNote {
  midi: number;
  /** Seconds relative to the sequence start. */
  start: number;
  duration: number;
  gain?: number;
}

export interface ScheduledHandle {
  /** AudioContext times. */
  readonly startAt: number;
  readonly endAt: number;
  /** Stop early with a short release (no clicks). */
  stop(): void;
}

export interface MetronomeHandle extends ScheduledHandle {
  readonly bpm: number;
  /** AudioContext time of beat 0. */
  readonly beat0: number;
  setBpm(bpm: number): void;
}

export interface ReferenceSynth {
  /** Master volume 0..1. */
  setVolume(v: number): void;
  playNote(spec: NoteSpec): ScheduledHandle;
  playGlide(spec: GlideSpec): ScheduledHandle;
  playSequence(notes: readonly SequenceNote[], opts?: { startAt?: number; timbre?: Timbre; gain?: number }): ScheduledHandle;
  /** One click at an AudioContext time. Accent = louder/higher downbeat. */
  click(at: number, accent?: boolean): void;
  /** Lookahead-scheduled metronome ("A Tale of Two Clocks" pattern). */
  startMetronome(bpm: number, opts?: { beatsPerBar?: number; startAt?: number; countInBeats?: number }): MetronomeHandle;
  stopAll(): void;
}
