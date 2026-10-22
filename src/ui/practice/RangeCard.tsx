/**
 * The Range finder's result (docs/DESIGN.md §13.5): the comfortable and the extended range, as words ("C3–A4") and on a
 * mini keyboard strip, so it reads without colour. Shown only when a passed take actually saved the range. Worded for
 * a singer relearning music: what each range is for, and how the note names work (middle C is marked on the strip).
 */
import type { JSX } from 'preact';
import { isAccidental, noteName, type Notation } from '../../core/music';
import type { VocalRange } from '../../storage/schema';

/** "C3–A4". */
export function rangeLabel(low: number, high: number, notation: Notation): string {
  return `${noteName(low, notation)}–${noteName(high, notation)}`;
}

const KEY_W = 10;
const KEY_H = 26;
/** Middle C (C4), the reference most people know from the piano. */
const MIDDLE_C = 60;

export function RangeCard(props: { range: VocalRange; notation: Notation }): JSX.Element {
  const { range, notation } = props;
  const first = range.extended.low - 1;
  const last = range.extended.high + 1;
  const keys: number[] = [];
  for (let m = first; m <= last; m++) keys.push(m);
  const x = (m: number): number => (m - first) * KEY_W;
  const comfort = range.comfortable;
  const showsMiddleC = MIDDLE_C >= first && MIDDLE_C <= last;
  return (
    <section class="pl-rangecard" aria-label="Your saved range" data-testid="range-card">
      <h2 class="pl-label">Your range</h2>
      <dl class="pl-rangecard__lines">
        <div>
          <dt class="pl-body-s pl-muted">Practice range</dt>
          <dd class="pl-display-m pl-tabular">{rangeLabel(comfort.low, comfort.high, notation)}</dd>
          <dd class="pl-body-s pl-muted">Your exercises stay inside these notes.</dd>
        </div>
        <div>
          <dt class="pl-body-s pl-muted">Full reach</dt>
          <dd class="pl-display-m pl-tabular">{rangeLabel(range.extended.low, range.extended.high, notation)}</dd>
          <dd class="pl-body-s pl-muted">The lowest and highest notes you held.</dd>
        </div>
      </dl>
      <svg class="pl-rangecard__keys" viewBox={`0 0 ${keys.length * KEY_W} ${KEY_H + 12}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
        {keys.map((m) => (
          <rect
            key={m}
            x={x(m)}
            y={0}
            width={KEY_W}
            height={KEY_H}
            class={`pl-rangecard__key${isAccidental(m) ? ' pl-rangecard__key--black' : ''}${m >= comfort.low && m <= comfort.high ? ' pl-rangecard__key--comfort' : m >= range.extended.low && m <= range.extended.high ? ' pl-rangecard__key--extended' : ''}`}
          />
        ))}
        <rect class="pl-rangecard__bar pl-rangecard__bar--extended" x={x(range.extended.low)} y={KEY_H + 3} width={(range.extended.high - range.extended.low + 1) * KEY_W} height={2} />
        <rect class="pl-rangecard__bar pl-rangecard__bar--comfort" x={x(comfort.low)} y={KEY_H + 7} width={(comfort.high - comfort.low + 1) * KEY_W} height={4} />
        {showsMiddleC ? <rect class="pl-rangecard__middle-c" x={x(MIDDLE_C) + 3} y={KEY_H - 8} width={KEY_W - 6} height={5} data-testid="middle-c" /> : null}
      </svg>
      <p class="pl-body-s pl-muted pl-prose">
        {showsMiddleC
          ? 'Notes are named like piano keys. The dot marks middle C (C4), and a lower number is a lower note.'
          : 'Notes are named like piano keys: middle C is C4, and a lower number is a lower note.'}
      </p>
    </section>
  );
}
