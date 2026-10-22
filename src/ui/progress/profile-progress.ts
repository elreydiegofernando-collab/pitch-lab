/**
 * "Where is this singer up to?" for the Profiles list: the next level to sing, from the progress snapshot. The
 * active profile reads the session's live snapshot; the others are computed from their own stored log the same
 * way the session does (local calendar days, built-in routines resolved), so the two always agree.
 */
import { WORLDS, getExercise } from '../../exercises';
import { computeSnapshot, continueLevel, withRoutines, type ProgressSnapshot } from '../../progress';
import type { AppStorage } from '../../storage';

/** "Up next: Sustain II (Foundations)", or "Every level passed". */
export function progressLine(snapshot: ProgressSnapshot): string {
  const level = continueLevel(snapshot, WORLDS);
  if (!level) return 'Every level passed';
  const world = WORLDS.find((w) => w.id === level.worldId);
  return `Up next: ${level.title}${world ? ` (${world.title})` : ''}`;
}

/** The line for a profile that is not active, from its stored attempts. */
export async function loadProgressLine(storage: Pick<AppStorage, 'attempts'>, profileId: string, now: number = Date.now()): Promise<string> {
  const attempts = await storage.attempts.listByProfile(profileId);
  const utcOffsetMinutes = -new Date(now).getTimezoneOffset();
  return progressLine(computeSnapshot(profileId, WORLDS, attempts, now, { getExercise: withRoutines(getExercise), utcOffsetMinutes }));
}
