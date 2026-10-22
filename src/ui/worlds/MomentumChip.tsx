/**
 * The Momentum chip: the number and a 7-day mini bar row (docs/DESIGN.md 13.1). Shown on Home only once the
 * dashboard is unlocked, and it opens the dashboard. Rest days keep it: momentum decays slowly and never resets, so a
 * rest day's bar is only dimmer, never empty.
 */
import { useMemo } from 'preact/hooks';
import type { JSX } from 'preact';
import { ChevronRight } from 'lucide-preact';
import { navigate } from '../../router';
import { attemptLog, snapshot } from '../../state/session';
import { localUtcOffsetMinutes, momentumBars, practiceSummary } from './momentum-bars';

export function MomentumChip(): JSX.Element {
  const value = Math.round(snapshot.value.momentum);
  const log = attemptLog.value;
  const bars = useMemo(() => momentumBars(log, Date.now(), localUtcOffsetMinutes()), [log]);
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
