/**
 * What the Sing screen's controls say and allow in each phase of a take (docs/DESIGN.md §13.4), as one pure table so the
 * rules are tested once: Listen reads "Stop" while the demo plays; Sing becomes Stop through the count-in and the take;
 * "Starting…" and "Scoring…" wait with a spinner; after a failure the primary reads "Try again".
 */
import type { RunError, RunPhase } from '../../runtime/types';
import type { PrimaryKind } from './PracticeBar';

export interface SingControls {
  listen: { label: 'Listen' | 'Stop'; disabled: boolean };
  primary: { kind: PrimaryKind; label: string; disabled: boolean };
  /** More is for the idle screen: it never opens mid-take. */
  moreDisabled: boolean;
}

/** Errors that a second try can fix; the others (a locked or unknown target) can only go back. */
export function isRetryable(error: RunError | null): boolean {
  return error !== null && error.code !== 'locked' && error.code !== 'unknown';
}

export function singControls(phase: RunPhase, ready: boolean, error: RunError | null): SingControls {
  const taking = phase === 'starting' || phase === 'count-in' || phase === 'singing' || phase === 'analyzing' || phase === 'done';
  const listen: SingControls['listen'] = { label: phase === 'listening' ? 'Stop' : 'Listen', disabled: !ready || taking };
  const base = { listen, moreDisabled: taking };
  switch (phase) {
    case 'starting':
      return { ...base, primary: { kind: 'busy', label: 'Starting…', disabled: true } };
    case 'count-in':
    case 'singing':
      return { ...base, primary: { kind: 'stop', label: 'Stop', disabled: false } };
    case 'analyzing':
    case 'done':
      return { ...base, primary: { kind: 'busy', label: 'Scoring…', disabled: true } };
    case 'error':
      return isRetryable(error)
        ? { ...base, primary: { kind: 'retry', label: 'Try again', disabled: false } }
        : { ...base, primary: { kind: 'sing', label: 'Sing', disabled: true } };
    default:
      return { ...base, primary: { kind: 'sing', label: 'Sing', disabled: !ready } };
  }
}
