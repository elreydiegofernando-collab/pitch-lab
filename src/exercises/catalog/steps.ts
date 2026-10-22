/**
 * Small builders that keep the world files readable. Everything they return
 * is plain JSON data (no functions, no undefined-valued keys).
 */
import type { ExerciseDef, LevelDef, PatternStep, WorldId } from '../types';
import { tipIdsFor } from '../tips';

type StepExtra = Pick<PatternStep, 'cue' | 'syllable'>;

function withExtra(step: PatternStep, extra?: StepExtra): PatternStep {
  if (extra?.cue !== undefined) step.cue = extra.cue;
  if (extra?.syllable !== undefined) step.syllable = extra.syllable;
  return step;
}

/** A sung note `semis` from the tonic for `beats`. */
export function note(semis: number, beats: number, extra?: StepExtra): PatternStep {
  return withExtra({ semis, beats }, extra);
}

/** A glide from `from` to `to` (semitones from the tonic) over `beats`. */
export function glide(from: number, to: number, beats: number, extra?: StepExtra): PatternStep {
  return withExtra({ semis: from, beats, glideToSemis: to }, extra);
}

/** Silence (breath) for `beats`. */
export function rest(beats: number): PatternStep {
  return { beats };
}

/** Equal-length notes; `extra` applies to the first one only (cue shown once). */
export function line(semis: readonly number[], beats: number, extra?: StepExtra, syllable?: string): PatternStep[] {
  return semis.map((s, i) => {
    const st = note(s, beats, i === 0 ? extra : undefined);
    if (syllable !== undefined && st.syllable === undefined) st.syllable = syllable;
    return st;
  });
}

/** `count` equal notes on one pitch (pulses). */
export function pulses(semis: number, count: number, beats: number, extra?: StepExtra): PatternStep[] {
  return line(new Array<number>(count).fill(semis), beats, extra);
}

/** Alternate between `a` and `b`, `count` notes in total, starting on `a`. */
export function alternate(a: number, b: number, count: number, beats: number, extra?: StepExtra): PatternStep[] {
  const semis: number[] = [];
  for (let i = 0; i < count; i++) semis.push(i % 2 === 0 ? a : b);
  return line(semis, beats, extra);
}

/** Finalise an exercise: fills tipIds from the rule table. */
export function defineExercise(def: Omit<ExerciseDef, 'tipIds'>): ExerciseDef {
  return { ...def, tipIds: tipIdsFor(def) };
}

/** Level `index` (1-based) of `world`; ids are persisted, so never renumber an existing one. */
export function level(worldId: WorldId, index: number, title: string, exerciseId: string): LevelDef {
  return { id: `${worldId}.${String(index).padStart(2, '0')}`, worldId, index, title, exerciseId, kind: 'level' };
}

/** The world's Boss Recital level (always last). */
export function bossLevel(worldId: WorldId, index: number, exerciseId: string): LevelDef {
  return { id: `${worldId}.boss`, worldId, index, title: 'Boss Recital', exerciseId, kind: 'boss' };
}
