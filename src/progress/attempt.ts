/**
 * Writing an attempt: the one place that turns a finished take into the AttemptRecord fields the
 * progression engine reads, so no runner has to remember the conventions (they are what keeps the
 * log honest, and progress/engine.ts replays it as the single source of truth):
 *
 *  - which KIND a take is written as, and whether it carries a level id:
 *      practice rep            -> kind 'practice' + levelId
 *      Boss Recital            -> kind 'boss'     + levelId   (the level says it is a boss)
 *      personal-record attempt -> kind 'record'   + levelId
 *      daily-workout level     -> kind 'workout'  + levelId
 *      warm-up / cool-down     -> kind 'workout'  + levelId null (a routine carries no progression)
 *      placement audition      -> kind 'audition' + the audition exercise's id + levelId null
 *      song                    -> kind 'song'     + songId + levelId null, with the phrases, key and speed sung
 *    and a take of the voice check-up is one of those (its Range finder a practice rep, its placement tests audition
 *    takes) carrying the check-up's id, so a check-up is read back from the log alone (src/checkup);
 *  - a take counts as PASSED only if the evaluation passed AND (for a tempo-ladder exercise) it was sung at
 *    the pass tempo: the lower rungs of a Runs ladder are practice, however well they went; AND its realization
 *    was not folded (a `fit` of 'folded' means notes were moved by octaves to squeeze the material into too
 *    narrow a range: what was sung was not the exercise). evaluate(def, metrics, analysis) already refuses
 *    such a take; this is the second line, for a runner that forgot to pass the analysis. A take that is
 *    not passed carries mastery 0, so the tally lights never show a pass that did not happen;
 *  - the duration (count-in plus the pattern) is always filled, because Momentum counts it as practice time.
 *
 * Pure: nothing here reads a clock or storage. Hand the result to `storage.attempts.add`.
 */
import type { Metrics } from '../analysis/types';
import { canPassAtTempo } from '../exercises/ladder';
import type { RealizedExercise } from '../exercises/transpose';
import type { ExerciseDef, LevelDef } from '../exercises/types';
import type { AttemptRecord } from '../storage/schema';
import { isRoutineExerciseId } from './routines';
import type { Mastery } from './types';

/** The fields of an attempt the caller supplies (storage adds id, createdAt, updatedAt and deletedAt). */
export type AttemptFields = Omit<AttemptRecord, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>;

/** What the take was for. A level is the catalog's LevelDef (its exercise must be the one that was sung). */
export type AttemptSource =
  | { type: 'level'; level: Pick<LevelDef, 'id' | 'kind' | 'exerciseId'> }
  | { type: 'record'; level: Pick<LevelDef, 'id' | 'exerciseId'> }
  | { type: 'workout-level'; level: Pick<LevelDef, 'id' | 'exerciseId'> }
  | { type: 'workout-routine' }
  | { type: 'audition' };

/** The parts of a realized exercise (src/exercises/transpose.ts) an attempt records. */
export interface RealizedTake {
  tonicMidi: number;
  /** The tempo actually sung (a Runs ladder rung), not the exercise's pass tempo. */
  bpm: number;
  countInSec: number;
  totalSec: number;
  /** RealizedExercise.fit: a 'folded' realization can never be written as passed. Optional, so a hand-built take without it still works. */
  fit?: RealizedExercise['fit'];
}

/** The outcome of scoring the take (`evaluate` in src/exercises/evaluate.ts returns this and more). */
export interface TakeEvaluation {
  score: number;
  passed: boolean;
  mastery: Mastery;
}

export interface AttemptInput {
  profileId: string;
  /** The exercise that was sung (a catalog exercise, or a built-in routine for 'workout-routine'). */
  def: Pick<ExerciseDef, 'id' | 'tempoBpm' | 'tempoLadder'>;
  source: AttemptSource;
  realized: RealizedTake;
  evaluation: TakeEvaluation;
  /** The take's metrics (`analyzeTake(...).metrics`). */
  metrics: Metrics;
  /** The saved take (`storage.takes.save(...).id`), if it was kept. */
  takeId?: string | null;
  /** The voice check-up this take is a task of (runtime/checkup.ts); omit (or null) for any other take. */
  checkupId?: string | null;
}

/** AttemptRecord.kind and levelId for a source; throws on a source that contradicts the exercise (a programming error). */
function kindAndLevel(def: AttemptInput['def'], source: AttemptSource): Pick<AttemptRecord, 'kind' | 'levelId'> {
  switch (source.type) {
    case 'level':
    case 'record':
    case 'workout-level': {
      if (source.level.exerciseId !== def.id) {
        throw new Error(`buildAttempt: level ${source.level.id} is played with ${source.level.exerciseId}, not ${def.id}`);
      }
      const kind = source.type === 'level' ? (source.level.kind === 'boss' ? 'boss' : 'practice') : source.type === 'record' ? 'record' : 'workout';
      return { kind, levelId: source.level.id };
    }
    case 'workout-routine':
      if (!isRoutineExerciseId(def.id)) throw new Error(`buildAttempt: ${def.id} is not a built-in routine`);
      return { kind: 'workout', levelId: null };
    case 'audition':
      return { kind: 'audition', levelId: null };
  }
}

/** The AttemptRecord fields for one sung take of an exercise. See the module doc for the conventions it applies. */
export function buildAttempt(input: AttemptInput): AttemptFields {
  const { def, realized, evaluation } = input;
  const { kind, levelId } = kindAndLevel(def, input.source);
  const passed = evaluation.passed && canPassAtTempo(def, realized.bpm) && realized.fit !== 'folded';
  return {
    profileId: input.profileId,
    exerciseId: def.id,
    levelId,
    kind,
    score: evaluation.score,
    passed,
    mastery: passed ? evaluation.mastery : 0,
    metrics: input.metrics,
    durationSec: realized.countInSec + realized.totalSec,
    tonicMidi: realized.tonicMidi,
    tempoBpm: realized.bpm,
    takeId: input.takeId ?? null,
    // Only a check-up's takes carry the field: every other row keeps the shape it always had.
    ...(input.checkupId ? { checkupId: input.checkupId } : {}),
  };
}

export interface SongAttemptInput {
  profileId: string;
  songId: string;
  /** 0..1, e.g. the duration-weighted phrase score. */
  score: number;
  /** The runner's own call (a song attempt never passes or unlocks a level). */
  passed: boolean;
  /** `song.phraseScore` and `song.inTolerancePct` (analysis/score.ts metricsFromResults). */
  metrics: Metrics;
  /** Seconds sung. */
  durationSec: number;
  /** The key the song was sung in, if transposed (null when unknown). */
  tonicMidi?: number | null;
  takeId?: string | null;
  /**
   * The phrases sung: [from, to) into pitchedView(song).phrases, e.g. { from: 2, to: 3 } for phrase 3 alone; null for
   * the whole song. Omitted, the row carries none (as every song take before phrases were recorded).
   */
  phrase?: { from: number; to: number } | null;
  /** Half steps from the chart's own key (0 = as written). */
  songShift?: number | null;
  /** The playback speed sung at (0.5, 0.75 or 1). */
  songSpeed?: number | null;
}

/** The exercise id song attempts are filed under (they have no ExerciseDef): `song.<songId>`. */
export function songExerciseId(songId: string): string {
  return `song.${songId}`;
}

/**
 * The AttemptRecord fields for one sung take of a song: kind 'song', no level, the song's id on the row, and the phrases,
 * key and speed it was sung at when given (src/song/practice.ts reads a song's progress back from them; storage keeps a
 * value only when it is well formed).
 */
export function buildSongAttempt(input: SongAttemptInput): AttemptFields {
  const { phrase, songShift, songSpeed } = input;
  return {
    profileId: input.profileId,
    exerciseId: songExerciseId(input.songId),
    levelId: null,
    kind: 'song',
    score: input.score,
    passed: input.passed,
    mastery: 0,
    metrics: input.metrics,
    durationSec: input.durationSec,
    tonicMidi: input.tonicMidi ?? null,
    tempoBpm: null,
    takeId: input.takeId ?? null,
    songId: input.songId,
    ...(phrase !== undefined ? { phrase: phrase === null ? null : { from: phrase.from, to: phrase.to } } : {}),
    ...(songShift !== undefined ? { songShift } : {}),
    ...(songSpeed !== undefined ? { songSpeed } : {}),
  };
}
