/**
 * A finished check-up read back later (route 'checkup-results' { checkupId }), set against the one before it: the same
 * plain results as the end of the run (the range, "Then and now", each skill with its rating, what to focus on, what it
 * opened) and, under them, the pitch lines of the held notes and of the slide from both check-ups, drawn with the take
 * report's replay from the saved takes. The first check-up has nothing before it, so it shows its own lines alone.
 * Everything is read from the log and storage.takes; the screen opens nothing that the unlock registry does not.
 */
import { useMemo } from 'preact/hooks';
import type { JSX } from 'preact';
import { ClipboardCheck } from 'lucide-preact';
import { back, navigate, route } from '../../router';
import { snapshot } from '../../state/session';
import { AppBar } from '../components/AppBar';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { SummaryView } from '../checkup/SummaryView';
import { TakeCompare } from '../checkup/TakeCompare';
import { openCheckup, safeCompare, useCheckups } from '../checkup/model';
import { ActionBar } from '../worlds/ActionBar';

export function CheckupResults(): JSX.Element {
  const current = route.value;
  const checkupId = current.name === 'checkup-results' ? current.params.checkupId : '';
  const summaries = useCheckups();
  const at = summaries.findIndex((s) => s.checkupId === checkupId);
  const summary = at >= 0 ? summaries[at] : null;
  const before = at > 0 ? summaries[at - 1] : null;
  const comparison = useMemo(() => (summary && before ? safeCompare(before, summary) : null), [summary, before]);
  const snap = snapshot.value;

  if (!summary) {
    return (
      <div class="pl-screen ck-scope" data-testid="checkup-results-screen" data-view="missing">
        <AppBar title="Check-up results" routeIcon={ClipboardCheck} onBack={() => back()} />
        <div class="pl-scroll">
          <EmptyState icon={ClipboardCheck} title="That check-up is not on this device" message="It may belong to another profile, or it was never finished.">
            <Button variant="secondary" onClick={openCheckup} data-testid="checkup-results-open">
              Voice check-up
            </Button>
          </EmptyState>
        </div>
      </div>
    );
  }

  return (
    <div class="pl-screen ck-scope" data-testid="checkup-results-screen" data-view="results">
      <AppBar title="Check-up results" routeIcon={ClipboardCheck} onBack={() => back()} />
      <div class="pl-scroll">
        <main class="pl-page ck-page">
          <SummaryView summary={summary} comparison={comparison} view="past" snapshot={snap} onPractise={(levelId) => navigate('level', { levelId })} />
          <TakeCompare key={summary.checkupId} before={before} after={summary} />
        </main>
      </div>
      <ActionBar>
        <Button variant="primary" block class="ck-cta" onClick={() => back()} data-testid="checkup-done">
          Done
        </Button>
      </ActionBar>
    </div>
  );
}
