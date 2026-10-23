/**
 * Good tries on a practice step: a filled dot for each good try and an empty ring for each still to come, always with
 * the words ("2 of 3 good tries"), so the count never rests on the dots or their colour alone. Phrasing content (spans),
 * so it can sit inside a step's button.
 */
import type { JSX } from 'preact';
import { goodTriesText } from './model';

export interface GoodTriesProps {
  good: number;
  needed: number;
  class?: string;
}

export function GoodTries(props: GoodTriesProps): JSX.Element {
  const needed = Math.max(0, Math.round(props.needed));
  const good = Math.max(0, Math.min(needed, Math.round(props.good)));
  return (
    <span class={['pl-tries', props.class ?? ''].filter(Boolean).join(' ')} data-testid="good-tries">
      <span class="pl-tries__dots" aria-hidden="true">
        {Array.from({ length: needed }, (_, i) => (
          <span key={i} class={`pl-tries__dot${i < good ? ' pl-tries__dot--good' : ''}`} />
        ))}
      </span>
      <span class="pl-tries__text pl-tabular">{goodTriesText(good, needed)}</span>
    </span>
  );
}
