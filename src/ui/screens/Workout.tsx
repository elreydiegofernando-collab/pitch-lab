/**
 * Daily workout (SPEC §12, DESIGN.md §13.11): pick 5, 10 or 20 minutes, read today's set (warm-up, your next
 * levels, one review, cool-down), start it. The same screen shows a workout in progress and, once it ends, its
 * summary. The takes themselves are sung on the Sing screen through the runner (src/runtime/workout.ts).
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { Check, Dumbbell, Play } from 'lucide-preact';
import { back, navigate, resetTo } from '../../router';
import type { Workout as WorkoutPlan, WorkoutMinutes } from '../../progress';
import {
  abandonWorkout,
  activeWorkout,
  finishWorkout,
  planWorkout,
  startWorkout,
  type WorkoutSummary,
} from '../../runtime/workout';
import { attemptLog, snapshot } from '../../state/session';
import { settings, updateSettings } from '../../state/settings';
import { AppBar } from '../components/AppBar';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { Locked } from '../components/Locked';
import { Segmented } from '../components/Segmented';
import { errorText } from '../progress/format';
import { SetList } from '../progress/SetList';
import { sessionView, summaryFacts, totalText } from '../progress/workout-view';

const LENGTH_OPTIONS = [
  { value: '5' as const, label: '5 min' },
  { value: '10' as const, label: '10 min' },
  { value: '20' as const, label: '20 min' },
];

function lengthOf(value: '5' | '10' | '20'): WorkoutMinutes {
  return Number(value) as WorkoutMinutes;
}

/** Today's plan, or null when the runtime could not build one (shown as an error, never a blank screen). */
function planFor(minutes: WorkoutMinutes): WorkoutPlan | null {
  try {
    return planWorkout(minutes);
  } catch {
    return null;
  }
}

export function Workout(): JSX.Element {
  const session = activeWorkout.value;
  const minutes = settings.value.workoutMinutes;
  const snap = snapshot.value;
  const attempts = attemptLog.value;
  const [error, setError] = useState<string | null>(null);
  /** The summary of the workout that just ended, keyed by its start time (finishing replaces the session object). */
  const [ended, setEnded] = useState<{ startedAt: string; summary: WorkoutSummary | null } | null>(null);

  const planning = session === null;
  const plan = useMemo(() => (planning ? planFor(minutes) : null), [planning, minutes, snap, attempts]);
  const view = session ? sessionView(session) : null;
  const finished = session !== null && session.finishedAt !== null;
  const allSung = session !== null && !finished && view !== null && session.workout.items.length > 0 && view.nextIndex === null;
  const summaryTaken = session !== null && ended !== null && ended.startedAt === session.startedAt;

  // The workout is over (every take sung, or the runtime marked it finished): take its summary, once.
  useEffect(() => {
    if (session && (finished || allSung) && !summaryTaken) setEnded({ startedAt: session.startedAt, summary: finishWorkout() });
  }, [session, finished, allSung, summaryTaken]);

  // A finished workout is one sitting: leaving the screen clears it, so tomorrow opens on a fresh plan.
  useEffect(
    () => () => {
      const s = activeWorkout.peek();
      if (s && s.finishedAt !== null) abandonWorkout();
    },
    [],
  );

  function handleStart(): void {
    setError(null);
    try {
      startWorkout(minutes);
    } catch (err) {
      setError(`Could not start the workout. ${errorText(err)}`);
      return;
    }
    navigate('sing', { target: 'workout', itemIndex: '0' });
  }

  function handleContinue(): void {
    if (view?.nextIndex == null) return;
    navigate('sing', { target: 'workout', itemIndex: String(view.nextIndex) });
  }

  function handleEnd(): void {
    if (session) setEnded({ startedAt: session.startedAt, summary: finishWorkout() });
  }

  function handleDone(): void {
    abandonWorkout();
    setEnded(null);
    resetTo('home');
  }

  function handleSeeProgress(): void {
    handleDone();
    navigate('dashboard');
  }

  // ---------------------------------------------------------------- summary
  if (session && (finished || allSung)) {
    // The summary lands one effect after the first render: hold its place so nothing jumps.
    if (!summaryTaken || ended === null) {
      return (
        <div class="pl-screen" data-testid="workout-screen">
          <AppBar title="Daily workout" routeIcon={Dumbbell} onBack={handleDone} />
          <div class="pl-scroll">
            <div class="pl-page">
              <div class="pl-workout-skeleton" aria-hidden="true" />
            </div>
          </div>
        </div>
      );
    }
    const facts = summaryFacts(session, ended.summary);
    return (
      <div class="pl-screen" data-testid="workout-screen">
        <AppBar title="Daily workout" routeIcon={Dumbbell} onBack={handleDone} />
        <div class="pl-scroll">
          <div class="pl-page">
            <header class="pl-stack">
              <span class="pl-label">Summary</span>
              <h2 class="pl-display-l" data-testid="workout-summary-title">
                {facts.title}
              </h2>
            </header>
            <dl class="pl-workout-tiles pl-tabular">
              {facts.tiles.map((t) => (
                <div key={t.label} class="pl-workout-tile">
                  <dt class="pl-label">{t.label}</dt>
                  <dd class="pl-readout-l">{t.value}</dd>
                </div>
              ))}
            </dl>
            <p class="pl-body-s pl-muted pl-prose">Every take in it is already saved to your history. Momentum counts the minutes you sang.</p>
          </div>
        </div>
        <div class="pl-workout-bar">
          <Button variant="primary" icon={Check} block onClick={handleDone}>
            Done
          </Button>
          <Button variant="ghost" block onClick={handleSeeProgress}>
            See your progress
          </Button>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- in progress
  if (session && view) {
    const doneCount = view.items.filter((s) => s.complete).length;
    return (
      <div class="pl-screen" data-testid="workout-screen">
        <AppBar title="Daily workout" routeIcon={Dumbbell} onBack={() => back()} />
        <div class="pl-scroll">
          <div class="pl-page">
            <header class="pl-stack">
              <span class="pl-label">In progress</span>
              <p class="pl-body pl-tabular">
                {doneCount} of {session.workout.items.length} items done
              </p>
            </header>
            <SetList items={session.workout.items} statuses={view.items} nextIndex={view.nextIndex} />
          </div>
        </div>
        <div class="pl-workout-bar">
          <Button variant="primary" icon={Play} block onClick={handleContinue}>
            Continue
          </Button>
          <Button variant="ghost" block onClick={handleEnd}>
            End workout
          </Button>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- before
  return (
    <div class="pl-screen" data-testid="workout-screen">
      <AppBar title="Daily workout" routeIcon={Dumbbell} onBack={() => back()} />
      <div class="pl-scroll">
        <div class="pl-page">
          <section class="pl-stack">
            <span class="pl-label">How long today</span>
            <Segmented
              aria-label="Workout length"
              options={LENGTH_OPTIONS}
              value={String(minutes) as '5' | '10' | '20'}
              onChange={(v) => updateSettings({ workoutMinutes: lengthOf(v) })}
            />
          </section>

          {plan === null ? (
            <Banner kind="error" message="Could not build today's workout. Close Pitch Lab and open it again." />
          ) : plan.locked ? (
            <Locked title="Daily workout" hint={plan.hint ?? 'Pass your first level to unlock the daily workout.'} />
          ) : plan.items.length === 0 ? (
            <Banner kind="info" message={`Nothing fits in ${minutes} minutes yet. Try a longer workout.`} />
          ) : (
            <>
              <p class="pl-body-s pl-muted pl-prose">Built from your progress. Each line says why it is in today&apos;s set.</p>
              <SetList items={plan.items} nextIndex={0} />
              <p class="pl-set-total pl-data pl-tabular" data-testid="workout-total">
                {totalText(plan)}
              </p>
            </>
          )}

          {error ? <Banner kind="error" message={error} /> : null}
        </div>
      </div>
      <div class="pl-workout-bar">
        <Button variant="primary" icon={Play} block disabled={plan === null || plan.locked || plan.items.length === 0} onClick={handleStart}>
          Start workout
        </Button>
      </div>
    </div>
  );
}
