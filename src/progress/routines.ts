/**
 * Built-in daily-workout routines: the cold-start warm-up (gentle sirens) and the cool-down
 * (slow descending glides). They are NOT levels and never carry progression: an attempt at one
 * is recorded with `levelId: null`, so it cannot pass, unlock or re-lock anything. It still
 * counts as practice time for Momentum.
 *
 * Gating: a routine is part of the daily-workout feature, so it opens exactly when that
 * feature does (first level passed); see isExerciseOpenable in unlocks.ts.
 *
 * Content note: the exercises catalog has no warm-up/cool-down entries, so these are the
 * defaults. A catalog entry with the same id may replace them (look the id up in the catalog
 * first, then in ROUTINE_EXERCISES). Both are completion-based (pass.score 0): the point is
 * easy, unforced sound, never a scored hurdle. The sirens are kind 'siren' (the realizer
 * places those in the extended range), kept short (a fifth to a ninth) and placed low.
 */
import type { ExerciseDef, PatternStep } from '../exercises/types';

export const WARM_UP_ROUTINE_ID = 'routine.warm-up';
export const COOL_DOWN_ROUTINE_ID = 'routine.cool-down';

const glideStep = (from: number, to: number, beats: number, extra?: Pick<PatternStep, 'cue' | 'syllable'>): PatternStep => ({
  semis: from,
  beats,
  glideToSemis: to,
  ...extra,
});

/** Shared, non-judging scoring: smooth glides, nothing gated. */
const COMPLETION_SCORING: ExerciseDef['scoring'] = [{ metric: 'glide.smoothness', weight: 1, best: 1, worst: 0.3 }];

export const WARM_UP_ROUTINE: ExerciseDef = {
  id: WARM_UP_ROUTINE_ID,
  worldId: 'foundations',
  kind: 'siren',
  title: 'Warm-up sirens',
  goal: 'Wake the voice with easy sirens on “oo”: light, slow and never pushed.',
  pattern: [
    { semis: 0, beats: 2, cue: 'Easy siren on “oo”', syllable: 'oo' },
    glideStep(0, 5, 3),
    glideStep(5, 0, 3),
    { beats: 1 },
    glideStep(2, 7, 3, { syllable: 'oo' }),
    glideStep(7, 2, 3),
    { beats: 1 },
    glideStep(0, 9, 4, { cue: 'A little wider, still light', syllable: 'oo' }),
    glideStep(9, 0, 4),
  ],
  tempoBpm: 60,
  tonicPlacement: 'low',
  countInBeats: 2,
  metronome: false,
  demo: { timbre: 'sine', vibrato: null },
  analyzers: ['glide', 'cracks'],
  scoring: COMPLETION_SCORING,
  pass: { score: 0 },
  tolerance: 'easy',
  tiers: { solid: 0.8, studio: 0.92 },
};

export const COOL_DOWN_ROUTINE: ExerciseDef = {
  id: COOL_DOWN_ROUTINE_ID,
  worldId: 'foundations',
  kind: 'siren',
  title: 'Cool-down glides',
  goal: 'Let the voice settle with slow glides down on “oo”, easy and breathy-soft.',
  pattern: [
    { semis: 7, beats: 2, cue: 'Slow slide down on “oo”', syllable: 'oo' },
    glideStep(7, 0, 4),
    { beats: 1 },
    glideStep(5, -2, 4, { syllable: 'oo' }),
    { beats: 1 },
    glideStep(4, -5, 5, { cue: 'Last one: let it fall away', syllable: 'oo' }),
  ],
  tempoBpm: 56,
  tonicPlacement: 'mid',
  countInBeats: 2,
  metronome: false,
  demo: { timbre: 'sine', vibrato: null },
  analyzers: ['glide', 'cracks'],
  scoring: COMPLETION_SCORING,
  pass: { score: 0 },
  tolerance: 'easy',
  tiers: { solid: 0.8, studio: 0.92 },
};

/** Routine exercises by id. */
export const ROUTINE_EXERCISES: Readonly<Record<string, ExerciseDef>> = {
  [WARM_UP_ROUTINE_ID]: WARM_UP_ROUTINE,
  [COOL_DOWN_ROUTINE_ID]: COOL_DOWN_ROUTINE,
};

/** True for the ids of the built-in routines (they are gated by the daily-workout feature). */
export function isRoutineExerciseId(exerciseId: string): boolean {
  return Object.prototype.hasOwnProperty.call(ROUTINE_EXERCISES, exerciseId);
}

/**
 * An exercise lookup that resolves the catalog first and falls back to the built-in routines, so
 * the runner can open every workout item with one call: `withRoutines(getExercise)(item.exerciseId)`.
 */
export function withRoutines(lookup?: (exerciseId: string) => ExerciseDef | undefined): (exerciseId: string) => ExerciseDef | undefined {
  return (exerciseId) => lookup?.(exerciseId) ?? (isRoutineExerciseId(exerciseId) ? ROUTINE_EXERCISES[exerciseId] : undefined);
}
