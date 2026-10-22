/**
 * The Momentum chip: the number and a 7-day mini bar row (docs/DESIGN.md 13.1). Shown on Home only once the
 * dashboard is unlocked, and it opens the dashboard. Rest days keep it: momentum decays slowly and never resets, so a
 * rest day's bar is only dimmer, never empty.
 *
 * The number is computed the way the dashboard computes it (dashboard-model momentumView): from the attempt log at the
 * time it is shown, not from the session snapshot, which is recomputed only at boot and after a take. Both the number
 * and the bars are recomputed when the app comes back into view, so a tab or a home-screen app left open for days
 * never shows the day it was opened.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { ChevronRight } from 'lucide-preact';
import { computeMomentum } from '../../progress';
import { navigate } from '../../router';
import { attemptLog } from '../../state/session';
import { localUtcOffsetMinutes, momentumBars, practiceSummary } from './momentum-bars';

/** A counter that moves each time the page becomes visible again (or the window regains focus). */
function useReturnTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const onReturn = (): void => {
      if (document.visibilityState !== 'hidden') setTick((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    return () => {
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
    };
  }, []);
  return tick;
}

export function MomentumChip(): JSX.Element {
  const log = attemptLog.value;
  const tick = useReturnTick();
  const { value, bars } = useMemo(() => {
    const now = Date.now();
    const utcOffsetMinutes = localUtcOffsetMinutes();
    return {
      value: Math.round(computeMomentum(log, now, { utcOffsetMinutes })),
      bars: momentumBars(log, now, utcOffsetMinutes),
    };
    // `tick` is a dependency on purpose: coming back to the app re-reads the clock.
  }, [log, tick]);
  const summary = practiceSummary(bars);
  return (
    <button
      type="button"
      class="wl-momentum"
      data-testid="momentum-chip"
      aria-label={`Momentum ${value} of 100.${summary ? ` ${summary}` : ''} Open the progress dashboard.`}
      onClick={() => navigate('dashboard')}
    >
      <span class="wl-momentum__text">
        <span class="pl-label">Momentum</span>
        <span class="wl-momentum__value pl-tabular">{value}</span>
      </span>
      <span class="wl-momentum__bars" aria-hidden="true">
        {bars.map((bar, i) => (
          <span
            key={i}
            class={[
              'wl-momentum__bar',
              bar === null ? 'wl-momentum__bar--none' : '',
              bar !== null && !bar.practiced ? 'wl-momentum__bar--rest' : '',
              i === bars.length - 1 ? 'wl-momentum__bar--today' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            style={{ '--h': bar === null ? 0.06 : Math.max(0.08, bar.level) }}
          />
        ))}
      </span>
      <ChevronRight class="wl-chev" size={20} aria-hidden="true" />
    </button>
  );
}
