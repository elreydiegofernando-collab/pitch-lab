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
  /**
   * The node every voice of this synth mixes into, ahead of its output stage (the soft limiter in synth.ts). Code that
   * builds its own voices on the same context (the Listen demos' shaped voices) connects them here, so the whole mix is
   * limited together and overlapping voices never sum past full scale. Optional: a stand-in synth may leave it out.
   */
  readonly input?: AudioNode;
  /** Master volume 0..1. */
  setVolume(v: number): void;
  playNote(spec: NoteSpec): ScheduledHandle;
  playGlide(spec: GlideSpec): ScheduledHandle;
  playSequence(notes: readonly SequenceNote[], opts?: { startAt?: number; timbre?: Timbre; gain?: number }): ScheduledHandle;
  /**
   * One click at an AudioContext time. Accent = louder/higher downbeat. `gain` (linear 0..1, optional) is the accented
   * click's peak, an unaccented one sounds at two thirds of it; omitted, the click is the full-level transient the
   * latency calibration listens for. Musical clicks (count-ins, metronomes) pass a level that follows the reference
   * volume, so they never sum past full scale with the notes they play against.
   */
  click(at: number, accent?: boolean, gain?: number): void;
  /** Lookahead-scheduled metronome ("A Tale of Two Clocks" pattern). `gain`: the clicks' level, as for click(). */
  startMetronome(bpm: number, opts?: { beatsPerBar?: number; startAt?: number; countInBeats?: number; gain?: number }): MetronomeHandle;
  stopAll(): void;
}
