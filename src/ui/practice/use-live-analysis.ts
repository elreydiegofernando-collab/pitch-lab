/** Mounts a LiveAnalysis (live-analysis.ts) for a screen: created once, re-configured when the features or the style change, disposed on unmount. */
import { useEffect, useMemo, useRef } from 'preact/hooks';
import type { ReadonlySignal } from '@preact/signals';
import type { AudioEngine } from '../../audio/engine-types';
import type { VibratoStyle } from '../../core/types';
import { createLiveAnalysis, type LiveFeatures, type LiveHooks, type LiveReadings } from './live-analysis';

export interface UseLiveAnalysisOptions {
  engine: Pick<AudioEngine, 'onFrame'>;
  features: LiveFeatures;
  vibratoStyle: VibratoStyle;
  toleranceCents: number;
  targetMidi: number | null;
  hooks: LiveHooks;
}

export function useLiveAnalysis(opts: UseLiveAnalysisOptions): ReadonlySignal<LiveReadings> {
  // The hooks are called from timers: keep the latest ones in a ref instead of re-creating the analysis.
  const hooksRef = useRef(opts.hooks);
  hooksRef.current = opts.hooks;
  const analysis = useMemo(
    () =>
      createLiveAnalysis(opts.engine, {
        onCrack: (t) => hooksRef.current.onCrack(t),
        onOnset: (t) => hooksRef.current.onOnset(t),
      }),
    [opts.engine],
  );
  const { cracks, onset, vibrato } = opts.features;
  useEffect(() => {
    analysis.configure({ features: { cracks, onset, vibrato }, vibratoStyle: opts.vibratoStyle, toleranceCents: opts.toleranceCents, targetMidi: opts.targetMidi });
  }, [analysis, cracks, onset, vibrato, opts.vibratoStyle, opts.toleranceCents, opts.targetMidi]);
  useEffect(() => () => analysis.dispose(), [analysis]);
  return analysis.readings;
}
