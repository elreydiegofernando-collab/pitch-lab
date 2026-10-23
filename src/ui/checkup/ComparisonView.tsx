/**
 * "Then and now": the engine's one warm sentence, then one line per skill that can be compared, each with the old and
 * the new reading in the engine's plain words and a verdict as a glyph AND words (better, not as good, about the same;
 * never colour alone, and "not as good" is neutral, never an alarm). From the second check-up on.
 */
import type { JSX } from 'preact';
import { ArrowRight, Equal, TrendingDown, TrendingUp } from 'lucide-preact';
import type { CheckupComparison } from '../../checkup/types';
import { formatDate } from '../progress/format';

function Verdict(props: { better: boolean | null }): JSX.Element {
  const { better } = props;
  const Glyph = better === true ? TrendingUp : better === false ? TrendingDown : Equal;
  const word = better === true ? 'better' : better === false ? 'not as good' : 'about the same';
  return (
    <span class="ck-line__mark">
      <Glyph size={16} strokeWidth={2} aria-hidden="true" />
      {word}
    </span>
  );
}

export function ComparisonView(props: { comparison: CheckupComparison }): JSX.Element {
  const { before, after, headline, lines } = props.comparison;
  return (
    <section class="ck-section" aria-labelledby="checkup-compare-heading" data-testid="checkup-compare">
      <h2 class="pl-label" id="checkup-compare-heading">
        Then and now
      </h2>
      {headline ? (
        <p class="pl-prose ck-headline" data-testid="checkup-headline">
          {headline}
        </p>
      ) : null}
      <p class="pl-body-s pl-muted pl-tabular">{`Then ${formatDate(before.finishedAt)}. Now ${formatDate(after.finishedAt)}.`}</p>
      {lines.length > 0 ? (
        <ul class="ck-lines" data-testid="checkup-lines">
          {lines.map((line) => {
            const state = line.better === true ? 'better' : line.better === false ? 'worse' : 'same';
            return (
              <li key={`${line.skill}-${line.label}`} class={`ck-line ck-line--${state}`} data-skill={line.skill} data-testid="checkup-line">
                <span class="ck-line__label">{line.label}</span>
                <span class="ck-line__values">
                  <span>
                    <span class="pl-visually-hidden">Then </span>
                    {line.before}
                  </span>
                  {/* The arrow stays with the new reading, so a long one wraps as a pair and never leaves the arrow dangling. */}
                  <span class="ck-line__to">
                    <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
                    <span class="pl-visually-hidden">, now </span>
                    <span class="ck-line__now">{line.now}</span>
                  </span>
                </span>
                <Verdict better={line.better} />
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
