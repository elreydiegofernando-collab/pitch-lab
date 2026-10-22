/**
 * The placement-audition run in progress: the progress snapshot from before its first test, so the results can say
 * what the run opened (the Sing screen and the report in between do not know about it). It is per-singer state, so it
 * lives here, next to the runner's lastOutcome, and the session clears it whenever the data underneath changes (a
 * profile switch, deleting the active profile, a backup import, Delete all data): a run never compares one singer's
 * results against another singer's, or against a log that was just replaced. src/ui/worlds/audition-model.ts manages it.
 */
import { signal } from '@preact/signals';
import type { WorldId } from '../exercises/types';
import type { ProgressSnapshot } from '../progress/types';

export interface AuditionRun {
  worldId: WorldId;
  /** The singer the run belongs to: a run is never carried over to (or read back by) another profile. */
  profileId: string;
  /** The progress snapshot from before the first test of the run. */
  before: ProgressSnapshot;
  /** Epoch ms of the Start that opened the run. */
  since: number;
}

/** The run in progress: set when Start is tapped, handed to the results view (and cleared) when the run ends. */
export const auditionRun = signal<AuditionRun | null>(null);
