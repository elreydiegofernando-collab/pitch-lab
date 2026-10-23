/**
 * One finished check-up in plain words (the Checkup screen's results, and a past check-up on CheckupResults):
 *
 *   the range in note names; from the second check-up on, "Then and now" with its headline; each skill with a rating as
 *   a word and a glyph and its one sentence; what to focus on, with what to practise and a button to the level that
 *   trains it (only if it is openable, else the level's requirement as a Locked line, SPEC 11.1); where you start (just
 *   sung only); and what the check-up opened.
 *
 * A check-up, not a test: no scores, no pass or fail, and a crack is something to practise. Nothing here opens a level
 * the unlock registry does not: it only offers what is openable now.
 */
import type { JSX } from 'preact';
import { LockOpen, Repeat } from 'lucide-preact';
import type { CheckupComparison, CheckupSummary } from '../../checkup/types';
import { WORLDS } from '../../exercises';
import { isLevelOpenable, levelRequirementHint, type ProgressSnapshot } from '../../progress';
import { Button } from '../components/Button';
import { Locked } from '../components/Locked';
import { DOT, pad2, plural, rangeLabel, tieNumerals } from '../worlds/format';
import { locateLevel } from '../worlds/levels';
import { formatDate } from '../progress/format';
import { ComparisonView } from './ComparisonView';
import { SkillList } from './SkillList';
import { FOCUS_PRACTISE, anyMeasured, focusLevelId, isSkill, levelTitle, skillLabel } from './model';

export interface SummaryViewProps {
  summary: CheckupSummary;
  /** The check-up before this one, compared; null for the first. */
  comparison: CheckupComparison | null;
  /** 'fresh': just sung (it says where to start). 'past': a saved one, read back later. */
  view: 'fresh' | 'past';
  /** The singer's progress now: a level is offered as a button only when it is openable. */
  snapshot: ProgressSnapshot;
  onPractise: (levelId: string) => void;
}

/**
 * The range in note names when the engine has them (the check-up whose Range finder saved the range now); for an earlier
 * one, which kept only the span, the engine's sentence about it; and only when it was not measured at all, a plain line
 * saying so.
 */
function Range(props: { summary: CheckupSummary; date: string; view: SummaryViewProps['view'] }): JSX.Element {
  const { summary, date, view } = props;
  const rangeSkill = summary.skills.find((s) => s.skill === 'range');
  const spanWords = rangeSkill && rangeSkill.rating !== 'not-measured' && rangeSkill.what ? rangeSkill.what : null;
  return (
    <header class="ck-head" data-testid="checkup-range">
      <span class="pl-label">{`${view === 'fresh' ? 'Your check-up' : 'Check-up'} ${DOT} ${date}`}</span>
      <h2 class="pl-label ck-range__label">Your range</h2>
      {summary.range ? (
        <>
          <p class="ck-range__value pl-tabular" data-testid="checkup-range-value">
            {summary.range}
          </p>
          <p class="pl-body-s pl-muted pl-prose">The notes you sang comfortably in the Range finder.</p>
        </>
      ) : spanWords ? (
        <p class="pl-body pl-prose" data-testid="checkup-range-words">
          {spanWords}
        </p>
      ) : (
        <>
          <p class="ck-range__value ck-range__value--none" data-testid="checkup-range-value">
            Not measured
          </p>
          <p class="pl-body-s pl-muted pl-prose">Your range was not measured this time. Sing the Range finder again when you are ready.</p>
        </>
      )}
    </header>
  );
}

function Focus(props: { summary: CheckupSummary; view: SummaryViewProps['view']; snapshot: ProgressSnapshot; onPractise: (levelId: string) => void }): JSX.Element {
  const { summary, view, snapshot, onPractise } = props;
  const skills = summary.focus.filter(isSkill);
  return (
    <section class="ck-section" aria-labelledby="checkup-focus-heading" data-testid="checkup-focus">
      <h2 class="pl-label" id="checkup-focus-heading">
        What to focus on
      </h2>
      {skills.length === 0 ? (
        <p class="pl-body pl-prose" data-testid="checkup-focus-none">
          {!anyMeasured(summary)
            ? 'Nothing could be measured this time. Check that the microphone is on, then take the check-up again when you are ready.'
            : view === 'fresh'
              ? 'Nothing stands out. Everything measured is solid, so carry on from where you start.'
              : 'Nothing stood out in this check-up. Everything measured was solid.'}
        </p>
      ) : (
        <ul class="ck-focus">
          {skills.map((skill) => {
            const levelId = focusLevelId(skill, snapshot);
            const title = levelTitle(levelId);
            const open = isLevelOpenable(levelId, snapshot);
            const hint = open ? null : levelRequirementHint(levelId, snapshot, WORLDS);
            return (
              <li key={skill} class="ck-focus__item" data-skill={skill} data-level={levelId} data-testid={`checkup-focus-${skill}`}>
                <h3 class="ck-focus__title">{skillLabel(skill)}</h3>
                <p class="pl-body pl-prose">{FOCUS_PRACTISE[skill]}</p>
                {open && title ? (
                  <Button variant="secondary" icon={Repeat} onClick={() => onPractise(levelId)} data-testid={`checkup-practise-${skill}`}>
                    {`Practise ${title}`}
                  </Button>
                ) : hint ? (
                  <Locked compact hint={hint} />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Start(props: { levelId: string | null }): JSX.Element {
  const { levelId } = props;
  const found = levelId ? locateLevel(WORLDS, levelId) : undefined;
  return (
    <section class="ck-section ck-start" aria-labelledby="checkup-start-heading" data-testid="checkup-start-level">
      <h2 class="pl-label" id="checkup-start-heading">
        Where you start
      </h2>
      {found ? (
        <>
          <p class="ck-start__title">{found.level.kind === 'boss' ? `${found.world.title} Boss Recital` : found.level.title}</p>
          <p class="pl-body-s pl-muted pl-prose">
            {`Level ${pad2(found.number)} of ${found.total} in ${found.world.title}.${found.number > 1 ? ' Everything before it is open.' : ''}`}
          </p>
        </>
      ) : (
        <p class="pl-body pl-prose">You have already passed every Foundations level. Carry on from Home.</p>
      )}
    </section>
  );
}

function Opened(props: { levelIds: readonly string[]; view: SummaryViewProps['view'] }): JSX.Element {
  const titles = props.levelIds.map(levelTitle).filter((t): t is string => t !== null);
  return (
    <section class="ck-section" aria-labelledby="checkup-opened-heading" data-testid="checkup-opened">
      <h2 class="pl-label" id="checkup-opened-heading">
        What opened
      </h2>
      {titles.length === 0 ? (
        <p class="pl-body pl-muted pl-prose" data-testid="checkup-nothing-opened">
          {props.view === 'fresh' ? 'Nothing new opened this time. Everything you have earned stays open.' : 'Nothing new opened with this check-up.'}
        </p>
      ) : (
        <ul class="ck-opened">
          <li class="ck-opened__item">
            <LockOpen class="ck-opened__icon" size={20} strokeWidth={2} aria-hidden="true" />
            <span class="ck-opened__text">
              <span class="pl-body" data-testid="checkup-opened-levels">
                {tieNumerals(rangeLabel(titles[0], titles[titles.length - 1]))}
              </span>
              <span class="pl-body-s pl-muted">
                {`${plural(titles.length, 'level')} you showed you can already sing, so they count as passed. Sing any of them again whenever you like.`}
              </span>
            </span>
          </li>
        </ul>
      )}
    </section>
  );
}

export function SummaryView(props: SummaryViewProps): JSX.Element {
  const { summary, comparison, view, snapshot, onPractise } = props;
  return (
    <div class="ck-summary" data-testid="checkup-summary" data-view={view}>
      <Range summary={summary} date={formatDate(summary.finishedAt)} view={view} />
      {comparison ? <ComparisonView comparison={comparison} /> : null}
      <section class="ck-section" aria-labelledby="checkup-skills-heading">
        <h2 class="pl-label" id="checkup-skills-heading">
          How your voice did
        </h2>
        <SkillList skills={summary.skills} />
      </section>
      <Focus summary={summary} view={view} snapshot={snapshot} onPractise={onPractise} />
      {view === 'fresh' ? <Start levelId={summary.startLevelId} /> : null}
      <Opened levelIds={summary.opened} view={view} />
    </div>
  );
}
