/**
 * Which card Home shows for the voice check-up (docs/DESIGN.md 13.1), and where. Pure; `useHomeCard` reads the session.
 *
 *   first     a profile that has sung nothing and has no check-up: "Start with a 4-minute voice check-up", prominent, above
 *             the Continue card (which then steps back to a secondary button)
 *   take      a profile that has sung but never took a check-up: "Take your voice check-up"
 *   continue  a check-up left part way: "Finish your voice check-up", above the Continue card like `first`
 *   recheck   the last check-up is RECHECK_AFTER_DAYS old or more: "Time for a re-check"
 *   latest    otherwise: a quiet row that opens the latest results
 */
import { useMemo } from 'preact/hooks';
import type { CheckupSummary } from '../../checkup/types';
import { activeCheckup, type CheckupSession } from '../../runtime/checkup';
import { attemptLog } from '../../state/session';
import { daysSince, isInProgress, safeRecheckDue, useCheckups } from './model';
import { useReturnTick } from './use-return-tick';

export type HomeCardKind = 'first' | 'take' | 'continue' | 'recheck' | 'latest';

export interface HomeCard {
  kind: HomeCardKind;
  /** The newest finished check-up, if any. */
  latest: CheckupSummary | null;
  /** The check-up left part way (kind 'continue' only). */
  session: CheckupSession | null;
  /** Whole days since the newest check-up ended; 0 without one. */
  days: number;
  /** The card is the first step on Home: it sits above the Continue card, whose button then steps back. */
  above: boolean;
}

export interface HomeCardInput {
  /** Finished check-ups, oldest first. */
  summaries: readonly CheckupSummary[];
  session: CheckupSession | null;
  /** The profile has sung at least one take. */
  hasSung: boolean;
  now: number;
}

export function homeCard(input: HomeCardInput): HomeCard {
  const { summaries, session, hasSung, now } = input;
  const latest = summaries.length > 0 ? summaries[summaries.length - 1] : null;
  let kind: HomeCardKind;
  if (isInProgress(session)) kind = 'continue';
  else if (latest === null) kind = hasSung ? 'take' : 'first';
  else if (safeRecheckDue(summaries, now)) kind = 'recheck';
  else kind = 'latest';
  return {
    kind,
    latest,
    session: kind === 'continue' ? session : null,
    days: latest ? daysSince(latest.finishedAt, now) : 0,
    above: kind === 'first' || kind === 'continue',
  };
}

/** The card for the active profile; re-read when the log or the running check-up changes, and when the app comes back into view. */
export function useHomeCard(): HomeCard {
  const summaries = useCheckups();
  const session = activeCheckup.value;
  const hasSung = attemptLog.value.some((a) => a.deletedAt == null);
  const tick = useReturnTick();
  // `tick` is a dependency on purpose: coming back to the app re-reads the clock (a re-check falls due while it sits open).
  return useMemo(() => homeCard({ summaries, session, hasSung, now: Date.now() }), [summaries, session, hasSung, tick]);
}
