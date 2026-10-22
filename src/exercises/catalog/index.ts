/**
 * The exercise catalog: every world, level, exercise, audition and Boss
 * Recital, as frozen JSON-serialisable data plus O(1) lookups.
 *
 * Order (SPEC §11): Foundations -> Vibrato -> Inflections -> Runs & Riffs ->
 * Dynamics; Song Stage opens after the Foundations Boss Recital. Level and
 * exercise ids are persisted in attempts: never rename or renumber one; add
 * new ones instead (index sets the order, id is identity).
 */
import type { AuditionDef, ExerciseDef, LevelDef, WorldDef, WorldId } from '../types';
import { DYNAMICS, DYNAMICS_EXERCISES } from './dynamics';
import { FOUNDATIONS, FOUNDATIONS_EXERCISES } from './foundations';
import { INFLECTIONS, INFLECTIONS_EXERCISES } from './inflections';
import { RUNS, RUNS_EXERCISES } from './runs';
import { SONG_STAGE } from './song-stage';
import { VIBRATO, VIBRATO_EXERCISES } from './vibrato';

export interface Catalog {
  worlds: readonly WorldDef[];
  exercises: readonly ExerciseDef[];
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

/** Training worlds in unlock order, then Song Stage. */
export const WORLDS: readonly WorldDef[] = deepFreeze([FOUNDATIONS, VIBRATO, INFLECTIONS, RUNS, DYNAMICS, SONG_STAGE]);
export const WORLD_ORDER: readonly WorldId[] = WORLDS.map((w) => w.id);

export const EXERCISES: readonly ExerciseDef[] = deepFreeze([
  ...FOUNDATIONS_EXERCISES, ...VIBRATO_EXERCISES, ...INFLECTIONS_EXERCISES, ...RUNS_EXERCISES, ...DYNAMICS_EXERCISES,
]);

export const CATALOG: Catalog = Object.freeze({ worlds: WORLDS, exercises: EXERCISES });

const worldById = new Map<string, WorldDef>(WORLDS.map((w) => [w.id, w]));
const exerciseById = new Map<string, ExerciseDef>(EXERCISES.map((e) => [e.id, e]));
const levelById = new Map<string, LevelDef>(WORLDS.flatMap((w) => w.levels.map((l) => [l.id, l] as const)));
const auditionById = new Map<string, AuditionDef>(
  WORLDS.flatMap((w) => (w.audition ? [[w.audition.id, w.audition] as const] : [])),
);
const levelByExercise = new Map<string, LevelDef>(WORLDS.flatMap((w) => w.levels.map((l) => [l.exerciseId, l] as const)));

export function getWorld(id: string): WorldDef | undefined {
  return worldById.get(id);
}
export function getExercise(id: string): ExerciseDef | undefined {
  return exerciseById.get(id);
}
export function getLevel(id: string): LevelDef | undefined {
  return levelById.get(id);
}
export function getAudition(id: string): AuditionDef | undefined {
  return auditionById.get(id);
}
/** The level that plays `exerciseId` (undefined for audition exercises). */
export function levelForExercise(exerciseId: string): LevelDef | undefined {
  return levelByExercise.get(exerciseId);
}
/** Levels of a world in order (empty for Song Stage). */
export function levelsOf(worldId: WorldId): readonly LevelDef[] {
  return worldById.get(worldId)?.levels ?? [];
}
/** A world's Boss Recital level. */
export function bossOf(worldId: WorldId): LevelDef | undefined {
  return levelsOf(worldId).find((l) => l.kind === 'boss');
}
/** The next level in the same world, or null after the boss. Never crosses worlds. */
export function nextLevel(levelId: string): LevelDef | null {
  const l = levelById.get(levelId);
  if (!l) return null;
  const levels = levelsOf(l.worldId);
  const i = levels.indexOf(l);
  return i >= 0 && i + 1 < levels.length ? levels[i + 1] : null;
}
/** Worlds whose `unlockedBy` is this level (a boss opens the next world, and Foundations' also opens Song Stage). */
export function worldsUnlockedBy(levelId: string): readonly WorldDef[] {
  return WORLDS.filter((w) => w.unlockedBy === levelId);
}
