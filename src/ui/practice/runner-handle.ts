/** Creating a runner for a screen. createRunner is contracted not to throw, but a bad catalog entry must cost one screen, not the whole app. */
import { createRunner } from '../../runtime/runner';
import type { ExerciseRunner, RunTarget } from '../../runtime/types';

export interface RunnerHandle {
  runner: ExerciseRunner | null;
  /** Plain-language reason when no runner could be made. */
  failure: string | null;
}

export function tryCreateRunner(target: RunTarget): RunnerHandle {
  try {
    return { runner: createRunner(target), failure: null };
  } catch {
    return { runner: null, failure: "This exercise couldn't be prepared. Go back and open it again." };
  }
}
