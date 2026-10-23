/**
 * What the Sing screen's gauge measures the voice against during a take. On the Live screen the gauge reads the voice
 * against the nearest note (free singing has no other); during a take that would contradict the live hint (a voice a
 * half step off its note sits right on another one: the gauge said "On it" while the hint said "a little lower", and on
 * the wide zone of the first lessons it said "On it" for any voice at all). So during a take it reads the voice against
 * the note being asked for, as the hint and the bars do.
 *
 * At take time `t` (seconds from the downbeat): the note to hold then (MIDI), 'listen' while the app plays a note (the
 * voice is not read then: on a phone speaker the microphone hears the app), or null when nothing is asked (the count-in,
 * a rest, a slide or siren, whose line is a shape rather than a pitch, and the Range finder, where the singer goes where
 * the voice goes). Pure; `at` is called once per painted frame, so it walks the steps with a cursor.
 */
import type { RealizedExercise } from '../../exercises/transpose';
import type { ExerciseDef } from '../../exercises/types';

/** A held note's pitch (MIDI), 'listen', or null: see the module doc. */
export type GaugeTarget = number | 'listen' | null;

export interface GaugePlan {
  /** What the gauge measures against at take time `t`. */
  at(t: number): GaugeTarget;
}

export function planGauge(def: Pick<ExerciseDef, 'kind'>, realized: Pick<RealizedExercise, 'steps' | 'reference'>): GaugePlan {
  const free = def.kind === 'range-finder';
  const steps = realized.steps;
  const tones = realized.reference;
  let cursor = 0;
  return {
    at(t: number): GaugeTarget {
      if (!Number.isFinite(t)) return null;
      for (const tone of tones) if (t >= tone.start && t < tone.end) return 'listen';
      const n = steps.length;
      if (n === 0 || t < steps[0].start || t >= steps[n - 1].end) return null;
      while (cursor < n - 1 && t >= steps[cursor].end) cursor++;
      while (cursor > 0 && t < steps[cursor].start) cursor--;
      const s = steps[cursor];
      if (t < s.start || t >= s.end) return null;
      if (s.role === 'listen') return 'listen';
      if (free || s.role !== 'sing' || s.midi === undefined || s.toMidi !== undefined) return null;
      return s.midi;
    },
  };
}
