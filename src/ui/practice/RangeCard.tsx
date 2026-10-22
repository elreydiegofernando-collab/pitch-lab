/**
 * The Range finder's result (docs/DESIGN.md §13.5): the comfortable and the extended range, as words ("C3–A4") and on a
 * mini keyboard strip, so it reads without colour. Shown only when a passed take actually saved the range.
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

export function RangeCard(props: { range: VocalRange; notation: Notation }): JSX.Element {
  const { range, notation } = props;
  const first = range.extended.low - 1;
  const last = range.extended.high + 1;
  const keys: number[] = [];
  for (let m = first; m <= last; m++) keys.push(m);
  const x = (m: number): number => (m - first) * KEY_W;
  const comfort = range.comfortable;
  return (
    <section class="pl-rangecard" aria-label="Your saved range" data-testid="range-card">
      <h2 class="pl-label">Your range</h2>
      <dl class="pl-rangecard__lines">
        <div>
          <dt class="pl-body-s pl-muted">Comfortable</dt>
          <dd class="pl-display-m pl-tabular">{rangeLabel(comfort.low, comfort.high, notation)}</dd>
        </div>
        <div>
          <dt class="pl-body-s pl-muted">Extended</dt>
          <dd class="pl-display-m pl-tabular">{rangeLabel(range.extended.low, range.extended.high, notation)}</dd>
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
      </svg>
    </section>
  );
}
