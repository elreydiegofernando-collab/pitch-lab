/**
 * Daily workout builder (SPEC §12): cold-start warm-up -> 1-3 items from the current world ->
 * ONE review of the weakest unlocked skill -> cool-down glides, sized to a 5, 10 or 20 minute
 * budget. Pure: the same inputs always give the same workout (variety across days comes from
 * the spaced-repetition ranking, not from randomness).
 *
 * Gating (everything is earned):
 *  - the whole workout is the `daily-workout` feature: until it is unlocked the result is
 *    `locked` with the requirement hint and no items;
 *  - every level item is current or passed; locked levels cannot appear;
 *  - Boss Recitals, the range finder (a measurement, not a drill) and audition exercises are
 *    never workout items;
 *  - warm-up and cool-down are the built-in routines (routines.ts): not levels, never unlock-bearing.
 *
 * Sizing: every kept item gets one take, then spare time is spent on extra takes (world items
 * first, then the review, warm-up, cool-down, each with a cap) so a 20-minute workout really
 * fills close to 20 minutes. If even single takes overshoot the budget, items drop in this order:
 * third world item, review, second world item, cool-down, warm-up, first world item. The summed
 * estimate NEVER exceeds the budget.
 *
 * CONTRACT GAP: src/config.ts has no `workout` section; WORKOUT_KNOBS are local PROVISIONAL knobs
 * (proposed CONFIG.workout), overridable per call.
 */
import type { ExerciseDef, ExerciseKind, LevelDef, WorldDef, WorldId } from '../exercises/types';
import type { AttemptRecord } from '../storage/schema';
import type { ExerciseLookup } from './records';
import { COOL_DOWN_ROUTINE_ID, ROUTINE_EXERCISES, WARM_UP_ROUTINE_ID } from './routines';
import type { TimeInput } from './time';
import type { ProgressSnapshot } from './types';
import { currentWorldOf, isFeatureUnlocked, isLevelOpenable, requirementHint } from './unlocks';
import { rankWeakness, weaknessInputsFromLog } from './weakness';
import type { WeaknessScore } from './weakness';

export type WorkoutMinutes = 5 | 10 | 20;
export type WorkoutStage = 'warm-up' | 'world-item' | 'review' | 'cool-down';
/** Why an item is there, for a short caption. */
export type WorkoutReason = 'warm-up' | 'cool-down' | 'current-level' | 'consolidate' | 'weakest';

export interface WorkoutItem {
  stage: WorkoutStage;
  /** 'level' = sing a catalog level; 'routine' = a built-in warm-up/cool-down (routines.ts). */
  source: 'level' | 'routine';
  /** Null for routines (they carry no progression). Record their attempts with levelId null, kind 'workout'. */
  levelId: string | null;
  /** The catalog exercise id, or the routine's id. */
  exerciseId: string;
  /** Null for routines. */
  worldId: WorldId | null;
  title: string;
  reason: WorkoutReason;
  /** Takes to sing (>= 1). */
  takes: number;
  /** Estimated time for the whole item: setup, listening, the takes and their reports. */
  estSeconds: number;
  estMinutes: number;
}

export interface Workout {
  minutes: WorkoutMinutes;
  /** True until the daily-workout feature is unlocked; then `items` is empty and `hint` says why. */
  locked: boolean;
  hint: string | null;
  items: WorkoutItem[];
  /** Sum of the items' estimates; never above `minutes`. */
  totalEstSeconds: number;
  totalEstMinutes: number;
}

export interface WorkoutKnobs {
  /** The spec's "2-3 items from the current world": at most this many. */
  maxWorldItems: number;
  /** Take length used when an exercise definition is unknown. */
  defaultTakeSec: number;
  /** Per level item: reading the cue and the Listen demo. */
  levelSetupSec: number;
  /** Per take of a level: the report and resetting. */
  levelTakeOverheadSec: number;
  routineSetupSec: number;
  routineTakeOverheadSec: number;
  maxTakes: { warmUp: number; worldItem: number; review: number; coolDown: number };
  /** Exercise kinds that never become workout items (when the exercise is known). */
  excludedKinds: readonly ExerciseKind[];
}

export const WORKOUT_KNOBS: Readonly<WorkoutKnobs> = {
  maxWorldItems: 3,
  defaultTakeSec: 30,
  levelSetupSec: 15,
  levelTakeOverheadSec: 12,
  routineSetupSec: 5,
  routineTakeOverheadSec: 5,
  maxTakes: { warmUp: 3, worldItem: 6, review: 4, coolDown: 2 },
  excludedKinds: ['range-finder', 'boss-recital', 'audition'],
};

export interface WorkoutInput {
  minutes: WorkoutMinutes;
  snapshot: ProgressSnapshot;
  worlds: readonly WorldDef[];
  /** The profile's attempt log (other profiles' rows are ignored). */
  attempts: readonly AttemptRecord[];
  now: TimeInput;
  /** Catalog lookup (`getExercise`): real take lengths, and the kinds to leave out. */
  getExercise?: ExerciseLookup;
  /** Replace the computed spaced-repetition ranking (weakest first); levels not in it rank last. */
  weakness?: readonly WeaknessScore[];
  knobs?: Partial<WorkoutKnobs>;
}

/** Seconds one take of the exercise lasts (count-in plus every repeat of the pattern); `fallbackSec` when unknown. */
export function estimateTakeSeconds(def: ExerciseDef | undefined, fallbackSec: number = WORKOUT_KNOBS.defaultTakeSec): number {
  if (!def || !(def.tempoBpm > 0)) return fallbackSec;
  let patternBeats = 0;
  for (const step of def.pattern) if (step.beats > 0) patternBeats += step.beats;
  const repeats = Math.max(1, Math.floor(def.repeats?.count ?? 1));
  return ((Math.max(0, def.countInBeats) + patternBeats * repeats) * 60) / def.tempoBpm;
}

interface Candidate {
  level: LevelDef;
  world: WorldDef;
  status: 'current' | 'passed';
  def: ExerciseDef | undefined;
}

interface Slot {
  stage: WorkoutStage;
  source: WorkoutItem['source'];
  levelId: string | null;
  exerciseId: string;
  worldId: WorldId | null;
  title: string;
  reason: WorkoutReason;
  takeSec: number;
  setupSec: number;
  overheadSec: number;
  takes: number;
  maxTakes: number;
  /** Lower = dropped first when the budget is too small. */
  dropRank: number;
}

const itemSeconds = (s: Slot, takes: number): number => Math.ceil(s.setupSec + takes * (s.takeSec + s.overheadSec));

function routineSlot(stage: 'warm-up' | 'cool-down', k: WorkoutKnobs): Slot {
  const id = stage === 'warm-up' ? WARM_UP_ROUTINE_ID : COOL_DOWN_ROUTINE_ID;
  const def = ROUTINE_EXERCISES[id];
  return {
    stage,
    source: 'routine',
    levelId: null,
    exerciseId: id,
    worldId: null,
    title: def.title,
    reason: stage,
    takeSec: estimateTakeSeconds(def, k.defaultTakeSec),
    setupSec: k.routineSetupSec,
    overheadSec: k.routineTakeOverheadSec,
    takes: 1,
    maxTakes: stage === 'warm-up' ? k.maxTakes.warmUp : k.maxTakes.coolDown,
    dropRank: stage === 'warm-up' ? 4 : 3,
  };
}

function levelSlot(c: Candidate, stage: 'world-item' | 'review', reason: WorkoutReason, dropRank: number, k: WorkoutKnobs): Slot {
  return {
    stage,
    source: 'level',
    levelId: c.level.id,
    exerciseId: c.level.exerciseId,
    worldId: c.world.id,
    title: c.level.title,
    reason,
    takeSec: estimateTakeSeconds(c.def, k.defaultTakeSec),
    setupSec: k.levelSetupSec,
    overheadSec: k.levelTakeOverheadSec,
    takes: 1,
    maxTakes: stage === 'review' ? k.maxTakes.review : k.maxTakes.worldItem,
    dropRank,
  };
}

/** Build the 5/10/20-minute workout. Every level item is unlocked and the total never exceeds the budget. */
export function buildDailyWorkout(input: WorkoutInput): Workout {
  const { minutes, snapshot, worlds } = input;
  const k: WorkoutKnobs = { ...WORKOUT_KNOBS, ...input.knobs, maxTakes: { ...WORKOUT_KNOBS.maxTakes, ...input.knobs?.maxTakes } };

  if (!isFeatureUnlocked('daily-workout', snapshot)) {
    return { minutes, locked: true, hint: requirementHint('daily-workout'), items: [], totalEstSeconds: 0, totalEstMinutes: 0 };
  }

  const ranking = input.weakness ?? rankWeakness(weaknessInputsFromLog(snapshot, worlds, input.attempts), input.now);
  const rank = new Map<string, number>();
  ranking.forEach((r, i) => {
    if (!rank.has(r.levelId)) rank.set(r.levelId, i);
  });
  const weakestFirst = (a: Candidate, b: Candidate): number => (rank.get(a.level.id) ?? Infinity) - (rank.get(b.level.id) ?? Infinity) || a.level.index - b.level.index;

  const candidates: Candidate[] = [];
  for (const world of worlds) {
    for (const level of world.levels) {
      if (level.kind === 'boss' || !isLevelOpenable(level.id, snapshot)) continue;
      const def = input.getExercise?.(level.exerciseId);
      if (def && k.excludedKinds.includes(def.kind)) continue;
      candidates.push({ level, world, status: snapshot.levels[level.id].status === 'current' ? 'current' : 'passed', def });
    }
  }

  // World items: the level in progress first, then the weakest passed levels of the same world.
  const world = currentWorldOf(snapshot, worlds);
  const inWorld = world ? candidates.filter((c) => c.world.id === world.id) : [];
  const worldPicks = [...inWorld.filter((c) => c.status === 'current'), ...inWorld.filter((c) => c.status === 'passed').sort(weakestFirst)].slice(0, Math.max(0, k.maxWorldItems));
  const used = new Set(worldPicks.map((c) => c.level.id));
  const reviewPick = candidates.filter((c) => c.status === 'passed' && !used.has(c.level.id)).sort(weakestFirst)[0];

  const budget = minutes * 60;
  const worldDropRanks = [5, 2, 0]; // first world item is kept longest, the third dropped first
  const slots: Slot[] = [routineSlot('warm-up', k)];
  worldPicks.forEach((c, i) => slots.push(levelSlot(c, 'world-item', c.status === 'current' ? 'current-level' : 'consolidate', worldDropRanks[Math.min(i, 2)], k)));
  if (reviewPick) slots.push(levelSlot(reviewPick, 'review', 'weakest', 1, k));
  slots.push(routineSlot('cool-down', k));
  const total = (): number => slots.reduce((sum, s) => sum + itemSeconds(s, s.takes), 0);

  // A level that cannot fit even on its own never makes the cut (so it cannot crowd out the routines).
  for (let i = slots.length - 1; i >= 0; i--) if (slots[i].source === 'level' && itemSeconds(slots[i], 1) > budget) slots.splice(i, 1);

  // Too long even at one take each: drop the least valuable items until it fits.
  while (slots.length > 0 && total() > budget) {
    let drop = 0;
    for (let i = 1; i < slots.length; i++) if (slots[i].dropRank < slots[drop].dropRank) drop = i;
    slots.splice(drop, 1);
  }

  // Spend the spare time on extra takes: world items first, then the review, warm-up and cool-down.
  const fillOrder = [...slots.filter((s) => s.stage === 'world-item'), ...slots.filter((s) => s.stage === 'review'), ...slots.filter((s) => s.stage === 'warm-up'), ...slots.filter((s) => s.stage === 'cool-down')];
  let spent = total();
  for (let progressed = true; progressed; ) {
    progressed = false;
    for (const s of fillOrder) {
      if (s.takes >= s.maxTakes) continue;
      const delta = itemSeconds(s, s.takes + 1) - itemSeconds(s, s.takes);
      if (spent + delta > budget) continue;
      s.takes += 1;
      spent += delta;
      progressed = true;
    }
  }

  const items: WorkoutItem[] = slots.map((s) => {
    const estSeconds = itemSeconds(s, s.takes);
    return {
      stage: s.stage,
      source: s.source,
      levelId: s.levelId,
      exerciseId: s.exerciseId,
      worldId: s.worldId,
      title: s.title,
      reason: s.reason,
      takes: s.takes,
      estSeconds,
      estMinutes: estSeconds / 60,
    };
  });
  const totalEstSeconds = items.reduce((sum, it) => sum + it.estSeconds, 0);
  return { minutes, locked: false, hint: null, items, totalEstSeconds, totalEstMinutes: totalEstSeconds / 60 };
}
