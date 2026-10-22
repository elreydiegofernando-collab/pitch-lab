/**
 * ScoreRing: a score (0..1) as an arc around a circle (DESIGN.md §10 level nodes, §13 take report).
 * The arc takes `currentColor`, so the parent picks the hue (world accent, `--tally`, `--on`); the track is `--line`.
 * Animating the value (the report's count-up) is the caller's job: pass the animated number.
 */
import type { ComponentChildren, JSX } from 'preact';

export interface ScoreRingProps {
  /** 0..1; null = never scored (track only). */
  value: number | null;
  /** Outer diameter in px. Default 56 (a map node). */
  size?: number;
  /** Arc thickness in px. Default size / 14, at least 3. */
  stroke?: number;
  /** Centre content (a level number, or the score text on the report). */
  children?: ComponentChildren;
  /** Accessible name, e.g. "Best score 86%". Without it the ring is decorative. */
  label?: string;
  class?: string;
}

export function ScoreRing(props: ScoreRingProps): JSX.Element {
  const { value, size = 56, children, label, class: className } = props;
  const stroke = props.stroke ?? Math.max(3, Math.round(size / 14));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = value === null || !Number.isFinite(value) ? 0 : Math.max(0, Math.min(1, value));
  return (
    <span
      class={['pl-score-ring', className ?? ''].filter(Boolean).join(' ')}
      style={{ width: `${size}px`, height: `${size}px` }}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false">
        <circle class="pl-score-ring__track" cx={size / 2} cy={size / 2} r={r} fill="none" stroke-width={stroke} />
        {value !== null ? (
          <circle
            class="pl-score-ring__arc"
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke-width={stroke}
            stroke-linecap="round"
            stroke-dasharray={`${c} ${c}`}
            stroke-dashoffset={c * (1 - v)}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        ) : null}
      </svg>
      {children !== undefined ? <span class="pl-score-ring__centre">{children}</span> : null}
    </span>
  );
}
