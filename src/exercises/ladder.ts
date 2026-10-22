/**
 * Tempo ladders (runs, SPEC §9.4): practice starts slow and moves up one rung
 * after a take that PASSES the level's own pass rule at the rung it was sung
 * at; the level itself is passed only at its pass tempo (def.tempoBpm, the
 * ladder's top rung). An exercise without a ladder has a single rung, its own
 * tempo. Pure.
 *
 * Why the pass rule and not a fixed run.score (SPEC's 85%): run.score's
 * accuracy scales with the level's tolerance (analysis/runs.ts), so at studio
 * ±10¢ a singer 15-20¢ off who passes the level at its pass tempo still sits
 * under 85% on every rung and could never climb to that tempo, and in the
 * calibration model (catalog/scoring.ts) no tier's entry singer reaches 85%
 * at all. A fixed mark also advanced takes that fail the level's gates (fast
 * but smeared runs score 86-88%). The pass rule is calibrated per tier and
 * includes the gates, so it advances exactly the takes that are clean enough
 * at this speed.
 */
import type { Metrics } from '../analysis/types';
import { evaluate, type TakeConditions } from './evaluate';
import type { ExerciseDef } from './types';

const EPS = 1e-9;

/** The rungs, slowest first. */
export function ladderOf(def: Pick<ExerciseDef, 'tempoBpm' | 'tempoLadder'>): readonly number[] {
  return def.tempoLadder && def.tempoLadder.length > 0 ? def.tempoLadder : [def.tempoBpm];
}

/** Where practice starts. */
export function startTempo(def: Pick<ExerciseDef, 'tempoBpm' | 'tempoLadder'>): number {
  return ladderOf(def)[0];
}

/** True when a take at `bpm` can pass the level (the pass rule only counts at the pass tempo). */
export function isPassTempo(def: Pick<ExerciseDef, 'tempoBpm'>, bpm: number): boolean {
  return bpm >= def.tempoBpm - EPS;
}

/**
 * May a take at `bpm` count as a PASS of the level? Only a take at the pass tempo may for an exercise with a
 * tempo ladder: the lower rungs are practice, however well they were sung. Exercises without a ladder have a
 * single tempo, so nothing is ruled out; neither is a take whose tempo is unknown (`null`, a legacy row). This
 * is the one rule the attempt writer (progress/attempt.ts) and the progression engine both apply.
 */
export function canPassAtTempo(def: Pick<ExerciseDef, 'tempoBpm' | 'tempoLadder'>, bpm: number | null | undefined): boolean {
  if (!def.tempoLadder || def.tempoLadder.length === 0) return true;
  if (bpm === null || bpm === undefined || !Number.isFinite(bpm)) return true;
  return isPassTempo(def, bpm);
}

/**
 * Tempo for the next take: one rung up when this take, sung at `bpm`, passes the level's pass rule (evaluate:
 * score and every gate; give it the take, as to evaluate, so a folded one never counts), else unchanged. Never
 * down, never past the top rung.
 */
export function nextTempo(def: ExerciseDef, bpm: number, metrics: Metrics, take?: TakeConditions): number {
  if (!evaluate(def, metrics, take).passed) return bpm;
  const up = ladderOf(def).find((r) => r > bpm + EPS);
  return up ?? bpm;
}
