/**
 * The audition's results (docs/DESIGN.md 13.6), shown when the run ends (after a miss, when nothing is left, or when the
 * singer stops early): "You placed at <level>", what the run opened against the snapshot from before it, and a primary
 * "Go to <level>". While a test is left there is also a quiet secondary button to sing it. A miss is "Not yet", never an
 * alarm, and nothing earned is ever taken back.
 */
import type { JSX } from 'preact';
import { LockOpen } from 'lucide-preact';
import type { WorldDef } from '../../exercises/types';
import { Button } from '../components/Button';
import { ActionBar } from './ActionBar';
import { DOT, hueStyle, levelName, plural, rangeLabel, tieNumerals } from './format';
import { eventLabel, type OpenedSummary, type Placement, type TestModel } from './audition-model';

export interface AuditionResultsProps {
  world: WorldDef;
  /** Where the singer stands in the world now; null when the whole world is passed. */
  placement: Placement | null;
  tests: readonly TestModel[];
  /** The test that was missed and ended the run, if the run ended on a miss. */
  missed: TestModel | undefined;
  /** What the run opened; null when the snapshot from before it was not recorded. */
  opened: OpenedSummary | null;
  /** Sing the next test ("Start test 3", "Retake test 2"); null when no test is left. */
  next: { label: string; onStart: () => void } | null;
  onGo: () => void;
}

export function AuditionResults(props: AuditionResultsProps): JSX.Element {
  const { world, placement, tests, missed, opened, next, onGo } = props;
  const passedTests = tests.filter((t) => t.state === 'passed').length;
  const firstLevel = opened?.levels[0];
  const lastLevel = opened?.levels[opened.levels.length - 1];
  const events = opened?.events ?? [];
  const nothing = opened !== null && opened.levels.length === 0 && events.length === 0;

  return (
    <>
      <div class="pl-scroll">
        <div class="pl-page wl-page" data-testid="audition-results">
          <header class="wl-world__head" style={hueStyle(world)}>
            <span class="pl-label">You placed at</span>
            <h2 class="wl-display" data-testid="audition-placement">
              {placement ? placement.level.title : `Every ${world.title} level`}
            </h2>
            <p class="pl-body-s pl-muted pl-tabular">
              {placement
                ? `${world.title} ${DOT} ${placement.level.kind === 'boss' ? 'Boss Recital' : `level ${placement.number} of ${placement.total}`}`
                : 'Every level is passed.'}
            </p>
            <div class="wl-world__rule" aria-hidden="true" />
          </header>

          <p class="pl-body pl-prose">
            {`${passedTests} of ${tests.length} tests passed.`}
            {missed ? ` Test ${missed.n}: not yet. Retake it whenever you like.` : ''}
          </p>

          {opened !== null ? (
            <section class="wl-section" aria-labelledby="audition-opened">
              <h3 class="pl-label" id="audition-opened">
                Opened
              </h3>
              {nothing ? (
                <p class="pl-body pl-muted pl-prose" data-testid="audition-nothing">
                  Nothing new opened this time. Everything you have earned stays open.
                </p>
              ) : (
                <ul class="wl-opened" data-testid="audition-opened">
                  {firstLevel && lastLevel ? (
                    <li class="wl-opened__item">
                      <LockOpen class="wl-opened__icon" size={20} strokeWidth={2} aria-hidden="true" />
                      <span class="wl-opened__text">
                        <span class="pl-body">{tieNumerals(rangeLabel(firstLevel.title, lastLevel.title))}</span>
                        <span class="pl-body-s pl-muted">{`${plural(opened.levels.length, 'level')} passed by audition`}</span>
                      </span>
                    </li>
                  ) : null}
                  {events.map((event, i) => {
                    const label = eventLabel(event);
                    return label ? (
                      <li key={i} class="wl-opened__item">
                        <LockOpen class="wl-opened__icon" size={20} strokeWidth={2} aria-hidden="true" />
                        <span class="wl-opened__text">
                          <span class="pl-body">{label}</span>
                        </span>
                      </li>
                    ) : null;
                  })}
                </ul>
              )}
            </section>
          ) : null}

          {next ? (
            <Button variant="secondary" block onClick={next.onStart} data-testid="audition-next">
              {next.label}
            </Button>
          ) : null}
        </div>
      </div>

      <ActionBar>
        <Button variant="primary" block class="wl-cta" onClick={onGo} data-testid="audition-go">
          {placement ? `Go to ${levelName(placement.level)}` : 'Back to the world map'}
        </Button>
      </ActionBar>
    </>
  );
}
