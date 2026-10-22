/**
 * The workout as a set list taped to a monitor (DESIGN.md §13): numbered entries, one cable joining them, the
 * amber tally light on the entry you are at. The cable is lit from the top down to the next entry. Used for the
 * plan before the workout and for the workout in progress (where entries also say how many takes are done).
 */
import type { JSX } from 'preact';
import { Check } from 'lucide-preact';
import type { WorkoutItem } from '../../progress';
import { itemMeta, reasonCaption, stageHeading, type ItemStatus } from './workout-view';

export interface SetListProps {
  items: readonly WorkoutItem[];
  /** Per-item take counts of a workout in progress; omit for a plan that has not started. */
  statuses?: readonly ItemStatus[];
  /** The entry the tally light is on; null when every entry is done. */
  nextIndex: number | null;
}

export function SetList(props: SetListProps): JSX.Element {
  const { items, statuses, nextIndex } = props;
  const rows: JSX.Element[] = [];
  items.forEach((item, i) => {
    const heading = stageHeading(item);
    const status = statuses?.[i];
    const done = status?.complete === true;
    const state = done ? 'done' : i === nextIndex ? 'next' : 'later';
    if (i === 0 || heading !== stageHeading(items[i - 1])) {
      const lit = i > 0 && statuses?.[i - 1]?.complete === true;
      rows.push(
        <li key={`stage-${i}`} class={`pl-set__stage${i === 0 ? ' pl-set__stage--first' : ''}${lit ? ' pl-set__lit' : ''}`} aria-hidden="true">
          <span class="pl-label">{heading}</span>
        </li>,
      );
    }
    rows.push(
      <li
        key={`item-${i}`}
        class={`pl-set__item pl-set__item--${state}${i === items.length - 1 ? ' pl-set__item--last' : ''}${done ? ' pl-set__lit' : ''}`}
        aria-current={state === 'next' ? 'step' : undefined}
      >
        <span class="pl-set__node pl-tabular" aria-hidden="true">
          {done ? <Check size={20} strokeWidth={2.5} /> : String(i + 1).padStart(2, '0')}
        </span>
        <div class="pl-set__body">
          <span class="pl-set__title">
            <span class="pl-visually-hidden">{`${state === 'done' ? 'Done. ' : state === 'next' ? 'Up next. ' : ''}${heading}: `}</span>
            {item.title}
          </span>
          <span class="pl-body-s pl-muted">{reasonCaption(item)}</span>
          <span class="pl-body-s pl-lo pl-tabular">{status ? `${status.takesDone} of ${status.takesTotal} takes` : itemMeta(item)}</span>
        </div>
      </li>,
    );
  });
  return <ol class="pl-set">{rows}</ol>;
}
