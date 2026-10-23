/**
 * Your pitch lines, then and now: for the two tasks whose line says the most (the held notes and the slide) the saved
 * take of the older check-up beside the saved take of this one, each drawn with the same replay the take report uses. The
 * line is the voice and the bars are the notes asked for. On a phone the pair stacks (the older one first), since two
 * narrow lines side by side would be too small to read; where there is room they sit in two columns. A take that was
 * not saved is said in a sentence, and a line still loading holds its place, so nothing jumps.
 */
import type { JSX } from 'preact';
import { CHECKUP_TASKS, type CheckupSummary } from '../../checkup/types';
import { settings } from '../../state/settings';
import { TraceReplay } from '../practice/TraceReplay';
import { formatDate } from '../progress/format';
import { DOT } from '../worlds/format';
import { useSavedTake } from './saved-take';

/**
 * The tasks compared: the held notes (Match and hold a note) and the slide (Slide up and down), as indexes into
 * CHECKUP_TASKS, found by the skills they rate so a battery sung in another order still compares the right two.
 */
export const COMPARED_TASKS: readonly number[] = (['steadiness', 'slides'] as const)
  .map((skill) => CHECKUP_TASKS.findIndex((t) => t.skills.some((s) => s.skill === skill)))
  .filter((i) => i >= 0);

function Line(props: { summary: CheckupSummary; taskIndex: number; label: string }): JSX.Element {
  const { summary, taskIndex, label } = props;
  const state = useSavedTake(summary.tasks[taskIndex]?.attemptId ?? null);
  const notation = settings.value.notation;
  return (
    <div class="ck-pair__col" data-testid="checkup-line-col" data-status={state.status}>
      <p class="ck-pair__label pl-tabular">{label}</p>
      {state.status === 'ready' ? (
        <TraceReplay
          notes={state.take.notes}
          totalSec={state.take.totalSec}
          toleranceCents={state.take.toleranceCents}
          track={state.take.track}
          cracks={state.take.cracks}
          notation={notation}
        />
      ) : state.status === 'missing' ? (
        <p class="pl-body-s pl-muted ck-pair__none" data-testid="checkup-line-missing">
          {state.message}
        </p>
      ) : (
        <div class="ck-skeleton" aria-hidden="true" data-testid="checkup-line-loading" />
      )}
    </div>
  );
}

export function TakeCompare(props: { before: CheckupSummary | null; after: CheckupSummary }): JSX.Element {
  const { before, after } = props;
  return (
    <section class="ck-section ck-takes" aria-labelledby="checkup-takes-heading" data-testid="checkup-takes">
      <h2 class="pl-label" id="checkup-takes-heading">
        Your pitch lines
      </h2>
      <p class="pl-body-s pl-muted pl-prose">
        {before
          ? 'The line is your voice and the bars are the notes you were asked to sing. Your older check-up comes first, then this one.'
          : 'The line is your voice and the bars are the notes you were asked to sing.'}
      </p>
      {COMPARED_TASKS.map((i) => (
        <div key={i} class="ck-take" data-testid={`checkup-take-${i + 1}`}>
          <h3 class="ck-take__title">{CHECKUP_TASKS[i].title}</h3>
          <div class={`ck-pair${before ? ' ck-pair--two' : ''}`}>
            {before ? <Line summary={before} taskIndex={i} label={`Then ${DOT} ${formatDate(before.finishedAt)}`} /> : null}
            <Line summary={after} taskIndex={i} label={before ? `Now ${DOT} ${formatDate(after.finishedAt)}` : formatDate(after.finishedAt)} />
          </div>
        </div>
      ))}
    </section>
  );
}
