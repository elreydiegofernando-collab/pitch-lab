/**
 * Audition: a world's placement audition (docs/DESIGN.md 13.6, SPEC 11). The intro lists the short tests and starts the
 * next one (the Sing screen sings it; the report opens the next test, or this screen again). Opened from the report
 * ("See your placement": after a missed test, after the last test, or to stop early) it shows the results instead:
 * where the singer placed and what the run opened. The tests themselves are gated by the router (isAuditionAvailable);
 * nothing here can open a locked one.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { SkipForward } from 'lucide-preact';
import { getWorld, WORLDS } from '../../exercises';
import { auditionRequirementHint } from '../../progress';
import { back, navigate, resetTo, route } from '../../router';
import { lastOutcome } from '../../runtime/runner';
import { attemptLog, snapshot } from '../../state/session';
import { AppBar } from '../components/AppBar';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { AuditionIntro } from '../worlds/AuditionIntro';
import { AuditionResults } from '../worlds/AuditionResults';
import {
  beginAuditionRun,
  buildTests,
  claimResults,
  openedBetween,
  placementOf,
  rememberIntro,
  startLabel,
  testsLeft,
} from '../worlds/audition-model';

export function Audition(): JSX.Element {
  const current = route.value;
  const worldId = current.name === 'audition' ? current.params.worldId : '';
  const world = getWorld(worldId);
  const audition = world?.audition ?? null;

  // Opened by the report's "See your placement": the results of the take just sung, claimed once (audition-model.ts).
  const [claimed] = useState(() => (world ? claimResults({ worldId: world.id, outcome: lastOutcome.peek(), entry: current }) : null));
  // Back (or Esc) from the results lands on this same screen: from then on it shows the intro.
  const openedAs = useRef(current);
  const showResults = claimed !== null && current === openedAs.current;
  useLayoutEffect(() => {
    if (!showResults && current.name === 'audition') rememberIntro(current);
  });

  const start = useCallback(() => {
    if (!world || !audition) return;
    beginAuditionRun({ worldId: world.id, before: snapshot.peek(), attempts: attemptLog.peek(), testIds: audition.exerciseIds });
    navigate('sing', { target: 'audition', worldId: world.id });
  }, [world, audition]);

  if (!world || !audition) {
    return (
      <div class="pl-screen wl-scope" data-testid="audition-screen">
        <AppBar title="Placement audition" routeIcon={SkipForward} onBack={() => back()} />
        <div class="pl-scroll">
          <EmptyState icon={SkipForward} title="No audition here" message="This world has no placement audition.">
            <Button variant="secondary" onClick={() => navigate('map')}>
              World map
            </Button>
          </EmptyState>
        </div>
      </div>
    );
  }

  const snap = snapshot.value;
  const tests = buildTests(world, snap, WORLDS);
  const label = startLabel(tests, attemptLog.value);

  if (showResults && claimed) {
    const placement = placementOf(world, snap, WORLDS);
    const leave = (): void => resetTo('map', { worldId: world.id });
    const go = (): void => {
      leave();
      if (placement) navigate('level', { levelId: placement.level.id });
    };
    return (
      <div class="pl-screen wl-scope" data-testid="audition-screen" data-view="results">
        <AppBar title="Placement audition" routeIcon={SkipForward} onBack={leave} />
        <AuditionResults
          world={world}
          placement={placement}
          tests={tests}
          missed={claimed.outcome.attempt.passed ? undefined : tests.find((t) => t.exerciseId === claimed.outcome.attempt.exerciseId)}
          opened={claimed.before ? openedBetween(claimed.before, snap, world, WORLDS) : null}
          next={label ? { label, onStart: start } : null}
          onGo={go}
        />
      </div>
    );
  }

  return (
    <div class="pl-screen wl-scope" data-testid="audition-screen" data-view="intro">
      <AppBar title="Placement audition" routeIcon={SkipForward} onBack={() => back()} />
      <AuditionIntro
        world={world}
        tests={tests}
        left={testsLeft(tests)}
        lockedHint={auditionRequirementHint(world.id, snap, WORLDS)}
        startLabel={label}
        onStart={start}
      />
    </div>
  );
}
