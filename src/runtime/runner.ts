/**
 * The exercise runner: one sung take from Listen to the written attempt (ExerciseRunner in ./types.ts).
 *
 * WAVE 2 CONTRACT STUB. The exported names and signatures are the contract; the runtime builder replaces the
 * bodies and keeps the signatures (report needed changes to the orchestrator).
 *
 * The pipeline it must follow is docs/ARCHITECTURE.md "Wave 1 integration" + "Wave 2 must-dos": realize ->
 * buildDemo (gain = settings.referenceVolume) -> TakeRecorder (downbeat, route latency, recordAudio =
 * settings.keepTakeAudio) -> analyzeTake -> evaluate/pickTip/reportTiles with the whole analysis -> buildAttempt
 * -> session.recordAttempt -> storage.takes.save -> range save ONLY from a passed Range finder take -> nextTempo
 * for a ladder -> unlockEvents(before, after).
 */
import { signal } from '@preact/signals';
import type { ExerciseRunner, RunTarget, TakeOutcome } from './types';

/** The last finished take (the report screen reads it). Survives leaving the Sing screen; replaced by the next take. */
export const lastOutcome = signal<TakeOutcome | null>(null);

/** Create the runner for one Sing screen visit. Prepares at once (phase 'idle', or 'error' with RunError 'locked'/'unknown'). */
export function createRunner(target: RunTarget): ExerciseRunner {
  void target;
  throw new Error('createRunner: not built yet (Wave 2 runtime)');
}
