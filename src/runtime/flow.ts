/**
 * What a take report offers next, and what a take unlocked.
 *
 * WAVE 2 CONTRACT STUB for the two functions (the runtime builder implements them; signatures are the contract).
 * FEATURE_TITLES is final: short human names for the registry's features, used by unlock strips and locked tiles.
 */
import type { WorldDef } from '../exercises/types';
import type { FeatureId, ProgressSnapshot } from '../progress/types';
import type { AfterTakeAction, TakeOutcome, UnlockEvent } from './types';

export const FEATURE_TITLES: Readonly<Record<FeatureId, string>> = {
  'live.basic': 'Live pitch monitor',
  'live.cracks': 'Crack markers on the Live trace',
  'live.onset': 'Settle and scoop readouts',
  'live.vibrato': 'Vibrato readouts on the Live trace',
  'tool.vibrato-meter': 'Vibrato meter',
  'setting.vibratoStyle': 'Vibrato style setting',
  dashboard: 'Progress dashboard',
  'daily-workout': 'Daily workout',
  'song-stage': 'Song Stage',
  'song.import': 'Import your own songs',
  records: 'Personal records',
  export: 'Backup and export',
};

/**
 * The report's actions for this outcome, exactly one primary. Level: pass -> "Next level" (primary) + "Retry";
 * miss -> "Retry" (primary) + "Back to level". Audition: pass with a next test -> "Next test"; miss or last test ->
 * "See your placement". Workout: "Next take" / "Next item" / "Finish workout". Record: "Retry" + "Back to level".
 */
export function afterTakeActions(outcome: TakeOutcome): AfterTakeAction[] {
  void outcome;
  return [];
}

/** What changed between two snapshots of the same profile, in display order (passed, mastery, opened, worlds, features, songs). */
export function unlockEvents(before: ProgressSnapshot, after: ProgressSnapshot, worlds: readonly WorldDef[]): UnlockEvent[] {
  void before;
  void after;
  void worlds;
  return [];
}
