/**
 * Signal mirror of the single AudioEngine, subscribed once at module load.
 * Screens read these signals instead of calling engine.info()/polling, so
 * Preact components re-render on real changes without each owning a
 * subscription.
 */
import { signal } from '@preact/signals';
import { getEngine } from '../audio/engine';
import type { EngineError, EngineInfo, EngineState, EngineStats } from '../audio/engine-types';

const engine = getEngine();

export const engineState = signal<EngineState>(engine.state);
export const engineError = signal<EngineError | null>(engine.error);
export const engineInfo = signal<EngineInfo>(engine.info());
export const engineStats = signal<EngineStats>({ framesPerSec: 0, droppedQuanta: 0, maxQuantum: 0 });

engine.onState((state, error) => {
  engineState.value = state;
  engineError.value = error;
  engineInfo.value = engine.info();
});

engine.onStats((stats) => {
  engineStats.value = stats;
});

/** Diagnostics calls this after actions that change EngineInfo without a state transition (e.g. setDetector). */
export function refreshEngineInfo(): void {
  engineInfo.value = engine.info();
}
