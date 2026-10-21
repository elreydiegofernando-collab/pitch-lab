/**
 * Reference-synth lifecycle. The synth is created lazily against the
 * engine's current AudioContext + output node, and must be re-created after
 * engine.reset() because reset() replaces both (see AudioEngine.output doc).
 */
import { getEngine } from '../audio/engine';
import { createSynth } from '../audio/synth';
import type { ReferenceSynth } from '../audio/synth-types';

let synth: ReferenceSynth | null = null;
let synthOutput: AudioNode | null = null;

/**
 * Get (creating if needed) the reference synth for the engine's current
 * output. Calls engine.ensureContext() synchronously, so call this directly
 * from a gesture handler the first time (e.g. the Listen button), not after
 * an await.
 */
export function getSynth(): ReferenceSynth {
  const engine = getEngine();
  const ctx = engine.ensureContext();
  const output = engine.output;
  if (!output) {
    // ensureContext() always sets output alongside the context; this is defensive.
    throw new Error('AudioEngine.output is null after ensureContext()');
  }
  if (!synth || synthOutput !== output) {
    synth = createSynth(ctx, output);
    synthOutput = output;
  }
  return synth;
}

/**
 * "Reset audio" escape hatch. Call this function directly from a gesture
 * handler: it calls engine.reset() before any other await, satisfying the
 * iOS rule, then drops the stale synth so the next getSynth() rebuilds it
 * against the fresh context/output.
 */
export async function resetAudio(): Promise<void> {
  const engine = getEngine();
  await engine.reset();
  synth = null;
  synthOutput = null;
  getSynth();
}
