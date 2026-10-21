/** TallyLights: three small dots marking mastery tiers (pass, solid, studio). docs/DESIGN.md §10. */
import type { JSX } from 'preact';

export interface TallyLightsProps {
  /** How many of the 3 tiers are lit, 0-3. */
  lit: number;
  labels?: readonly [string, string, string];
  class?: string;
}

const DEFAULT_LABELS: readonly [string, string, string] = ['Pass', 'Solid', 'Studio'];

export function TallyLights(props: TallyLightsProps): JSX.Element {
  const { lit, labels = DEFAULT_LABELS, class: className } = props;
  const clamped = Math.max(0, Math.min(3, lit));
  return (
    <span
      class={['pl-tally-lights', className ?? ''].filter(Boolean).join(' ')}
      role="img"
      aria-label={`${clamped} of 3 mastery tiers reached: ${labels.join(', ')}`}
    >
      {([0, 1, 2] as const).map((i) => (
        <span
          key={i}
          class={`pl-tally-lights__dot${i < clamped ? ' pl-tally-lights__dot--lit' : ''}`}
          aria-hidden="true"
        />
      ))}
    </span>
  );
}
