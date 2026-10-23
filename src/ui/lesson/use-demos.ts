/**
 * The lesson screen's Listen demos (the Learn page's demo, and the bar's Listen for the move the amber button makes):
 * one runner per demo target, made on its first tap (inside the gesture, for iOS audio), disposed on leaving. Starting
 * one demo stops any other that is playing, so two never sound at once; tapping a playing demo stops it.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { targetKey } from '../../runtime/targets';
import type { ExerciseRunner, RunTarget } from '../../runtime/types';
import { tryCreateRunner } from '../practice/runner-handle';

export interface Demos {
  /** Play the target's demo, or stop it while it plays. Call straight from the click handler. */
  toggle(target: RunTarget): void;
  /** The target's demo is playing now (read in render: it follows the runner's phase). */
  playing(target: RunTarget): boolean;
  /** A plain line when the last demo tapped could not be made or played; null otherwise. */
  error: string | null;
}

export function useDemos(): Demos {
  const runners = useRef(new Map<string, ExerciseRunner>());
  // A new runner re-renders the screen once, so its phase is read (and followed) from then on.
  const [, setMade] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const [lastKey, setLastKey] = useState<string | null>(null);

  useEffect(
    () => () => {
      for (const runner of runners.current.values()) runner.dispose();
      runners.current.clear();
    },
    [],
  );

  function toggle(target: RunTarget): void {
    const key = targetKey(target);
    let runner = runners.current.get(key);
    if (!runner) {
      const handle = tryCreateRunner(target);
      if (!handle.runner) {
        setFailure(handle.failure);
        return;
      }
      runner = handle.runner;
      runners.current.set(key, runner);
      setMade((n) => n + 1);
    }
    for (const [k, other] of runners.current) if (k !== key && other.phase.peek() === 'listening') other.listen();
    setFailure(null);
    setLastKey(key);
    runner.listen();
  }

  const last = lastKey === null ? undefined : runners.current.get(lastKey);
  return {
    toggle,
    playing: (target) => runners.current.get(targetKey(target))?.phase.value === 'listening',
    error: failure ?? last?.error.value?.message ?? null,
  };
}
