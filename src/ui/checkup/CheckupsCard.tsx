/**
 * The dashboard's "Check-ups" section (docs/DESIGN.md 13.10): each finished voice check-up, newest first, with its date
 * and its focus, opening its results (set against the one before it); and a "Re-check" button once a re-check is due.
 * Before the first one it offers to take it. A card of the dashboard's own kind, so it sits in its columns.
 */
import { useMemo } from 'preact/hooks';
import type { JSX } from 'preact';
import { ChevronRight, RefreshCw } from 'lucide-preact';
import { navigate } from '../../router';
import { Button } from '../components/Button';
import { formatDate } from '../progress/format';
import { checkupLine, openCheckup, safeRecheckDue, useCheckups } from './model';
import { useReturnTick } from './use-return-tick';

export function CheckupsCard(): JSX.Element {
  const summaries = useCheckups();
  const tick = useReturnTick();
  // `tick` is a dependency on purpose: coming back to the app re-reads the clock.
  const due = useMemo(() => summaries.length > 0 && safeRecheckDue(summaries, Date.now()), [summaries, tick]);
  const newestFirst = useMemo(() => [...summaries].reverse(), [summaries]);

  return (
    <section class="pl-card pl-dash-card" aria-labelledby="dash-checkups" data-testid="dash-checkups">
      <h2 class="pl-label pl-dash-heading" id="dash-checkups">
        Check-ups
      </h2>
      {newestFirst.length === 0 ? (
        <>
          <p class="pl-body-s pl-muted pl-prose">
            A voice check-up takes about four minutes. It shows what is solid, what to focus on and where to start, and later how far you have come.
          </p>
          <Button variant="secondary" block onClick={openCheckup} data-testid="dash-checkup-take">
            Take the check-up
          </Button>
        </>
      ) : (
        <>
          <ul class="ck-dash__list" data-testid="dash-checkup-list">
            {newestFirst.map((s) => {
              const date = formatDate(s.finishedAt);
              const focus = checkupLine(s);
              return (
                <li key={s.checkupId}>
                  <button
                    type="button"
                    class="ck-dash__row"
                    data-testid="dash-checkup-row"
                    aria-label={`Check-up of ${date}. ${focus}. Open the results.`}
                    onClick={() => navigate('checkup-results', { checkupId: s.checkupId })}
                  >
                    <span class="ck-dash__text">
                      <span class="ck-dash__date pl-tabular">{date}</span>
                      <span class="pl-body-s pl-muted">{focus}</span>
                    </span>
                    <ChevronRight class="ck-chev" size={20} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
          {due ? (
            <>
              <p class="pl-body-s pl-muted pl-prose">It has been a while. The same five tasks show how far you have come.</p>
              <Button variant="secondary" icon={RefreshCw} block onClick={openCheckup} data-testid="dash-checkup-recheck">
                Re-check
              </Button>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
