/**
 * The voice check-up (docs/DESIGN.md 11-13; owner, 2026-10-22: "like a test to see where you should start off ... then
 * assessment on where you've been and how you've gotten better"). A check-up, not a test: about four minutes, five short
 * tasks, nothing that can lower progress. One route, three states, read from the running session and the log:
 *
 *   intro      what it is in two plain sentences, the five tasks, and Start (startCheckup, then the first task)
 *   progress   the singer came back part way: "Task 3 of 5" and Continue (Start over drops it). A check-up left part way
 *              is picked up from the log when Pitch Lab opens again within a day (runtime/checkup.ts resumeCheckup)
 *   results    the last task was sung: the range, "Then and now" from the second check-up on, each skill with its rating,
 *              what to focus on, where to start and what opened. Continue goes to the start level.
 *
 * The tasks themselves are sung on the Sing screen through the runner (RunTarget { kind: 'checkup' }). Every take is
 * already a durable attempt tagged with the check-up's id, so a check-up is read back from the log alone.
 */
import { useMemo, useState } from 'preact/hooks';
import type { ComponentChildren, JSX } from 'preact';
import { ClipboardCheck, ListChecks } from 'lucide-preact';
import { CHECKUP_TASKS, type CheckupSummary } from '../../checkup/types';
import { isLevelOpenable } from '../../progress';
import { back, navigate, resetTo } from '../../router';
import { activeCheckup, startCheckup, type CheckupSession } from '../../runtime/checkup';
import { snapshot } from '../../state/session';
import { AppBar } from '../components/AppBar';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { SummaryView } from '../checkup/SummaryView';
import { TaskList } from '../checkup/TaskList';
import { CARE_LINE, PITCH_INTRO, isInProgress, nextTaskIndex, safeCompare, taskStates, useCheckups } from '../checkup/model';
import { errorText, formatDate } from '../progress/format';
import { ActionBar } from '../worlds/ActionBar';

/** Start a new check-up and open its first task. Returns a plain sentence when it could not. */
function beginFromTheTop(): string | null {
  try {
    startCheckup();
  } catch (err) {
    return `Could not start the check-up. ${errorText(err)}`;
  }
  return navigate('sing', { target: 'checkup', itemIndex: '0' }) ? null : 'The check-up could not open. Go back to Home and try again.';
}

function Shell(props: { view: string; title: string; onBack: () => void; children: ComponentChildren; bar: JSX.Element }): JSX.Element {
  return (
    <div class="pl-screen ck-scope" data-testid="checkup-screen" data-view={props.view}>
      <AppBar title={props.title} routeIcon={ClipboardCheck} onBack={props.onBack} />
      <div class="pl-scroll">
        <main class="pl-page ck-page">{props.children}</main>
      </div>
      {props.bar}
    </div>
  );
}

// ---------------------------------------------------------------- intro

function IntroView(props: { latest: CheckupSummary | null }): JSX.Element {
  const { latest } = props;
  const [error, setError] = useState<string | null>(null);
  return (
    <Shell
      view="intro"
      title="Voice check-up"
      onBack={() => back()}
      bar={
        <ActionBar>
          <Button variant="primary" block class="ck-cta" onClick={() => setError(beginFromTheTop())} data-testid="checkup-start">
            Start
          </Button>
        </ActionBar>
      }
    >
      <header class="ck-head">
        <span class="pl-label">{latest ? 'Re-check' : 'Before you start'}</span>
        <h2 class="ck-title">A check-up, not a test</h2>
        <p class="pl-body pl-prose" data-testid="checkup-intro">
          {PITCH_INTRO}
        </p>
        {latest ? (
          <p class="pl-body-s pl-muted pl-prose" data-testid="checkup-last">
            {`These are the same five tasks as your last check-up on ${formatDate(latest.finishedAt)}, so Pitch Lab can show how far you have come.`}
          </p>
        ) : null}
      </header>
      <TaskList />
      <p class="pl-body-s pl-muted pl-prose" data-testid="checkup-care">
        {CARE_LINE}
      </p>
      {latest ? (
        <Button variant="ghost" icon={ListChecks} onClick={() => navigate('checkup-results', { checkupId: latest.checkupId })} data-testid="checkup-last-results">
          See your last check-up
        </Button>
      ) : null}
      {error ? <Banner kind="error" message={error} /> : null}
    </Shell>
  );
}

// ---------------------------------------------------------------- part way

function ProgressView(props: { session: CheckupSession }): JSX.Element {
  const { session } = props;
  const [error, setError] = useState<string | null>(null);
  const next = nextTaskIndex(session) ?? 0;
  const carryOn = (): void => {
    if (!navigate('sing', { target: 'checkup', itemIndex: String(next) })) setError('The check-up could not open. Go back to Home and try again.');
  };
  return (
    <Shell
      view="progress"
      title="Voice check-up"
      onBack={() => back()}
      bar={
        <ActionBar>
          <div class="ck-bar">
            <Button variant="primary" block class="ck-cta" onClick={carryOn} data-testid="checkup-continue">
              Continue
            </Button>
            <Button variant="ghost" block onClick={() => setError(beginFromTheTop())} data-testid="checkup-restart">
              Start over
            </Button>
          </div>
        </ActionBar>
      }
    >
      <header class="ck-head">
        <span class="pl-label">In progress</span>
        <h2 class="ck-title pl-tabular" data-testid="checkup-progress-title">
          {`Task ${next + 1} of ${CHECKUP_TASKS.length}`}
        </h2>
        <p class="pl-body pl-prose">{`${CHECKUP_TASKS[next].title}: ${CHECKUP_TASKS[next].ask}`}</p>
        <p class="pl-body-s pl-muted pl-prose" data-testid="checkup-resume">
          The tasks you have sung are saved. Pick up within a day, even after closing Pitch Lab.
        </p>
      </header>
      <TaskList states={taskStates(session)} />
      {error ? <Banner kind="error" message={error} /> : null}
    </Shell>
  );
}

// ---------------------------------------------------------------- results

function ResultsView(props: { summaries: readonly CheckupSummary[]; done: CheckupSummary }): JSX.Element {
  const { summaries, done } = props;
  const snap = snapshot.value;
  const at = summaries.indexOf(done);
  const before = at > 0 ? summaries[at - 1] : null;
  const comparison = useMemo(() => (before ? safeCompare(before, done) : null), [before, done]);
  const start = done.startLevelId;
  const startOpen = start !== null && isLevelOpenable(start, snap);

  // The results are the end of the run: Back (and Continue) leave to Home, not to the run's own earlier screens.
  const leave = (): void => resetTo('home');
  const carryOn = (): void => {
    leave();
    if (startOpen && start) navigate('level', { levelId: start });
  };
  return (
    <Shell
      view="results"
      title="Check-up results"
      onBack={leave}
      bar={
        <ActionBar>
          <Button
            variant="primary"
            block
            class="ck-cta"
            onClick={carryOn}
            aria-label={startOpen ? 'Continue to where you start' : undefined}
            data-testid="checkup-continue"
          >
            {startOpen ? 'Continue' : 'Back to Home'}
          </Button>
        </ActionBar>
      }
    >
      <SummaryView summary={done} comparison={comparison} view="fresh" snapshot={snap} onPractise={(levelId) => navigate('level', { levelId })} />
      {before ? (
        <Button variant="secondary" icon={ListChecks} block onClick={() => navigate('checkup-results', { checkupId: done.checkupId })} data-testid="checkup-see-lines">
          Compare your pitch lines
        </Button>
      ) : null}
    </Shell>
  );
}

function UnreadableView(): JSX.Element {
  return (
    <Shell
      view="unreadable"
      title="Voice check-up"
      onBack={() => resetTo('home')}
      bar={
        <ActionBar>
          <Button variant="primary" block class="ck-cta" onClick={() => resetTo('home')} data-testid="checkup-home">
            Back to Home
          </Button>
        </ActionBar>
      }
    >
      <Banner kind="error" message="Your check-up was saved, but its results could not be put together. Close Pitch Lab, open it again and look for the check-up on Home." />
    </Shell>
  );
}

// ---------------------------------------------------------------- the screen

export function Checkup(): JSX.Element {
  const session = activeCheckup.value;
  const summaries = useCheckups();
  const done = session ? (summaries.find((s) => s.checkupId === session.checkupId) ?? null) : null;

  if (done) return <ResultsView summaries={summaries} done={done} />;
  // Every task sung, or marked finished, yet no summary in the log: say so rather than start a second run on top of it.
  if (session && (session.finishedAt !== null || nextTaskIndex(session) === null)) return <UnreadableView />;
  if (isInProgress(session)) return <ProgressView session={session} />;
  return <IntroView latest={summaries.length > 0 ? summaries[summaries.length - 1] : null} />;
}
