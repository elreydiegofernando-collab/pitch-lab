/**
 * Preact wrapper around {@link createPitchView}. Mounts the vanilla view
 * once into a ref'd div and keeps it alive across re-renders: prop changes
 * call the view's setters instead of recreating the canvas (recreating it
 * would drop the trace history and re-trigger the static-layer repaint on
 * every keystroke-level prop change).
 */
import { useEffect, useRef } from 'preact/hooks';
import type { AudioEngine } from '../../audio/engine-types';
import type { TargetNote } from '../../core/types';
import { createPitchView } from './pitch-view';
import type { PitchView, PitchViewOptions } from './types';

export interface PitchViewHostProps {
  engine: AudioEngine;
  targets?: readonly TargetNote[];
  targetOrigin?: number;
  toleranceCents?: number;
  vibratoZone?: { minExtentCents: number; maxExtentCents: number } | null;
  options?: Partial<PitchViewOptions>;
  onView?: (v: PitchView | null) => void;
  class?: string;
}

export function PitchViewHost(props: PitchViewHostProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<PitchView | null>(null);
  // Mirrors the latest props into the mount effect's closure without re-running it.
  const propsRef = useRef(props);
  propsRef.current = props;

  // Mount once; destroy on unmount. Deliberately NOT keyed on `props.engine` etc. - those are
  // applied via setters below so the canvas and its trace history survive prop changes.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const view = createPitchView(host, propsRef.current.options);
    viewRef.current = view;
    propsRef.current.onView?.(view);

    if (propsRef.current.targets) view.setTargets(propsRef.current.targets, propsRef.current.targetOrigin ?? 0);
    if (propsRef.current.toleranceCents !== undefined) view.setToleranceCents(propsRef.current.toleranceCents);
    view.setVibratoZone(propsRef.current.vibratoZone ?? null);

    const unsubscribe = propsRef.current.engine.onFrame((frame) => view.pushFrame(frame));
    view.start();

    return () => {
      unsubscribe();
      view.stop();
      view.destroy();
      viewRef.current = null;
      propsRef.current.onView?.(null);
    };
    // Intentionally mount-once (empty deps); see the comment above the effect.
  }, []);

  // Re-subscribing when `engine` itself changes (a new AudioEngine instance) is out of scope for
  // v1 (there's a single engine instance for the app's lifetime; getEngine() is a singleton), so
  // this effect only applies the setters that are meant to change at runtime.
  useEffect(() => {
    viewRef.current?.setTargets(props.targets ?? [], props.targetOrigin ?? 0);
  }, [props.targets, props.targetOrigin]);

  useEffect(() => {
    if (props.toleranceCents !== undefined) viewRef.current?.setToleranceCents(props.toleranceCents);
  }, [props.toleranceCents]);

  useEffect(() => {
    viewRef.current?.setVibratoZone(props.vibratoZone ?? null);
  }, [props.vibratoZone]);

  useEffect(() => {
    if (props.options) viewRef.current?.setOptions(props.options);
    // Individual option fields are compared by the view's setOptions itself; re-running this
    // whenever the options object identity changes is the simplest contract for callers.
  }, [props.options]);

  return (
    <div
      ref={hostRef}
      class={props.class}
      style={{ width: '100%', height: '100%', touchAction: 'none', overscrollBehavior: 'none' }}
    />
  );
}
