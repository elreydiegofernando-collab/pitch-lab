import { describe, expect, it } from 'vitest';
import * as progress from './index';

/** The names the UI codes against. Removing or renaming one must be a deliberate, visible change. */
const PUBLIC_API = [
  // the engine
  'computeSnapshot',
  'masteryForScore',
  // the gate
  'FEATURES',
  'FEATURE_IDS',
  'LEVEL_REFS',
  'isFeatureUnlocked',
  'isKnownFeature',
  'unlockedFeatures',
  'requirementHint',
  'levelStatus',
  'isLevelOpenable',
  'isWorldUnlocked',
  'isSongUnlocked',
  'isAuditionAvailable',
  'nextAuditionExercise',
  'auditionRequirementHint',
  'auditionSpans',
  'isExerciseOpenable',
  'isRecordAttemptAllowed',
  'bossLevelOf',
  'currentWorldOf',
  'currentLevelOf',
  'continueLevel',
  'levelRequirementHint',
  'worldRequirementHint',
  'songRequirementHint',
  // attempts, records, momentum
  'LEVEL_PASSING_KINDS',
  'LEVEL_ATTEMPT_KINDS',
  'RECORD_KINDS',
  'recordKey',
  'parseRecordKey',
  'recordsForExercise',
  'recordDirection',
  'isImprovement',
  'foldRecords',
  'computeMomentum',
  'momentumTimeline',
  'practiceMinutesByDay',
  'MOMENTUM_KNOBS',
  // weakness and the workout
  'rankWeakness',
  'weaknessInputsFromLog',
  'WEAKNESS_KNOBS',
  'buildDailyWorkout',
  'estimateTakeSeconds',
  'WORKOUT_KNOBS',
  'WARM_UP_ROUTINE',
  'COOL_DOWN_ROUTINE',
  'WARM_UP_ROUTINE_ID',
  'COOL_DOWN_ROUTINE_ID',
  'ROUTINE_EXERCISES',
  'isRoutineExerciseId',
  'withRoutines',
  // time
  'dayIndexOf',
  'dayKeyOf',
];

describe('progress public API', () => {
  it('exports everything the UI needs from one place', () => {
    for (const name of PUBLIC_API) expect(progress, name).toHaveProperty(name);
  });

  it('exports functions as functions and tables as data', () => {
    expect(typeof progress.computeSnapshot).toBe('function');
    expect(typeof progress.isLevelOpenable).toBe('function');
    expect(typeof progress.buildDailyWorkout).toBe('function');
    expect(Object.keys(progress.FEATURES).length).toBe(progress.FEATURE_IDS.length);
  });
});
