/**
 * The audition's intro (docs/DESIGN.md 13.6): the world, one paragraph, the tests as a numbered list (what each one
 * unlocks, and whether it is passed, next or not reached yet), and the primary Start button. When the audition cannot be
 * taken it shows the one requirement line and no Start button at all.
 */
import type { JSX } from 'preact';
import { ArrowRight, Check, Minus } from 'lucide-preact';
import type { WorldDef } from '../../exercises/types';
import { Button } from '../components/Button';
import { Locked } from '../components/Locked';
import { ActionBar } from './ActionBar';
import { hueStyle, plural, tieNumerals } from './format';
import type { TestModel, TestState } from './audition-model';

const STATE_TEXT: Record<TestState, string> = { passed: 'Passed', next: 'Next', ahead: 'Not reached' };

function StateMark(props: { state: TestState }): JSX.Element {
  const { state } = props;
  const Glyph = state === 'passed' ? Check : state === 'next' ? ArrowRight : Minus;
  return (
    <span class="wl-test__state">
      <Glyph size={16} strokeWidth={2.25} aria-hidden="true" />
      {STATE_TEXT[state]}
    </span>
  );
}

export interface AuditionIntroProps {
  world: WorldDef;
  tests: readonly TestModel[];
  /** Tests that still have something to open. */
  left: number;
  /** Why the audition cannot be taken yet; null when it can, or when nothing is left to open. */
  lockedHint: string | null;
  /** The Start button's label ("Start test 1", "Retake test 2"); null when there is no test to sing. */
  startLabel: string | null;
  onStart: () => void;
}

export function AuditionIntro(props: AuditionIntroProps): JSX.Element {
  const { world, tests, left, lockedHint, startLabel, onStart } = props;
  return (
    <>
      <div class="pl-scroll">
        <div class="pl-page wl-page">
          <header class="wl-world__head" style={hueStyle(world)}>
            <span class="pl-label">Placement audition</span>
            <h2 class="wl-world__title">{world.title}</h2>
            <div class="wl-world__rule" aria-hidden="true" />
          </header>

          {lockedHint ? (
            <div class="wl-linkrow wl-linkrow--locked" data-testid="audition-locked" data-locked="true">
              <Locked title="Placement audition" hint={lockedHint} />
            </div>
          ) : left > 0 ? (
            <p class="pl-body pl-prose">
              {`Sing ${plural(left, 'short test')}. Each pass unlocks the levels it covers. The run stops at the first miss. Nothing you've earned is ever locked again.`}
            </p>
          ) : (
            <p class="pl-body pl-prose" data-testid="audition-done">
              Every test is passed. There is nothing left for this audition to unlock.
            </p>
          )}

          <ol class="wl-tests" data-testid="audition-tests">
            {tests.map((t) => (
              <li key={t.exerciseId} class={`wl-test wl-test--${t.state}`} data-state={t.state} data-testid={`audition-test-${t.n}`}>
                <span class="wl-test__n pl-tabular" aria-hidden="true">
                  {t.n}
                </span>
                <span class="wl-test__title">{t.title}</span>
                <StateMark state={t.state} />
                <span class="pl-body-s pl-muted wl-test__caption">{t.caption ? `Unlocks ${tieNumerals(t.caption)}` : 'Nothing left to unlock'}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>

      {startLabel && !lockedHint ? (
        <ActionBar>
          <Button variant="primary" block class="wl-cta" onClick={onStart} data-testid="audition-start">
            {startLabel}
          </Button>
        </ActionBar>
      ) : null}
    </>
  );
}
