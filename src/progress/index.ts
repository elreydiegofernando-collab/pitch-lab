/**
 * Progression public API (SPEC §11, §12). The UI imports from here; the contract types stay in
 * ./types. Typical use:
 *
 *   const snapshot = computeSnapshot(profileId, WORLDS, attempts, new Date(), { getExercise });
 *   if (!isLevelOpenable(levelId, snapshot)) redirect(levelRequirementHint(levelId, snapshot, WORLDS));
 *   const workout = buildDailyWorkout({ minutes: 10, snapshot, worlds: WORLDS, attempts, now, getExercise });
 *
 * A placement audition: sing `nextAuditionExercise(worldId, snapshot, WORLDS)`, recompute, repeat; stop at the first miss
 * (a missed test stays next). It is null while the audition is locked (`auditionRequirementHint` says why) or finished,
 * and `isExerciseOpenable` opens only that one test.
 */
export type { FeatureId, LevelProgress, LevelStatus, Mastery, ProgressSnapshot, Requirement } from './types';

export { computeSnapshot, masteryForScore } from './engine';
export type { SnapshotOptions } from './engine';

export { auditionSpans } from './auditions';
export type { AuditionSpan } from './auditions';

export {
  FEATURES,
  FEATURE_IDS,
  LEVEL_REFS,
  auditionRequirementHint,
  bossLevelOf,
  continueLevel,
  currentLevelOf,
  currentWorldOf,
  isAuditionAvailable,
  isExerciseOpenable,
  isFeatureUnlocked,
  isKnownFeature,
  isLevelOpenable,
  isRecordAttemptAllowed,
  isSongUnlocked,
  isWorldUnlocked,
  levelRequirementHint,
  levelStatus,
  nextAuditionExercise,
  requirementHint,
  songRequirementHint,
  unlockedFeatures,
  worldRequirementHint,
} from './unlocks';

export { buildAttempt, buildSongAttempt, songExerciseId } from './attempt';
export type { AttemptFields, AttemptInput, AttemptSource, RealizedTake, SongAttemptInput, TakeEvaluation } from './attempt';

export { LEVEL_ATTEMPT_KINDS, LEVEL_PASSING_KINDS, RECORD_KINDS } from './log';

export { foldRecords, isImprovement, parseRecordKey, recordDirection, recordKey, recordsForExercise } from './records';
export type { ExerciseLookup, RecordEntry } from './records';

export { MOMENTUM_KNOBS, computeMomentum, momentumTimeline, practiceMinutesByDay } from './momentum';
export type { MomentumKnobs, MomentumOptions, MomentumPoint } from './momentum';

export { WEAKNESS_KNOBS, rankWeakness, weaknessInputsFromLog } from './weakness';
export type { RecentAttempt, WeaknessInput, WeaknessKnobs, WeaknessReason, WeaknessScore } from './weakness';

export { WORKOUT_KNOBS, buildDailyWorkout, estimateTakeSeconds } from './workout';
export type { Workout, WorkoutInput, WorkoutItem, WorkoutKnobs, WorkoutMinutes, WorkoutReason, WorkoutStage } from './workout';

export { COOL_DOWN_ROUTINE, COOL_DOWN_ROUTINE_ID, ROUTINE_EXERCISES, WARM_UP_ROUTINE, WARM_UP_ROUTINE_ID, isRoutineExerciseId, withRoutines } from './routines';

export { dayIndexOf, dayKeyOf } from './time';
export type { TimeInput } from './time';
