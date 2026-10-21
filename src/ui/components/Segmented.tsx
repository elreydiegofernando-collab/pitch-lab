/** Segmented: a single-choice control (Setup route, calibration method, Settings notation/theme/motion). */
import type { JSX } from 'preact';
import type { Icon } from './icon';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: Icon;
}

export interface SegmentedProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  'aria-label': string;
  class?: string;
}

export function Segmented<T extends string>(props: SegmentedProps<T>): JSX.Element {
  const { options, value, onChange, 'aria-label': ariaLabel, class: className } = props;
  return (
    <div
      class={['pl-segmented', className ?? ''].filter(Boolean).join(' ')}
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {options.map((opt) => {
        const OptIcon = opt.icon;
        const checked = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={checked}
            class="pl-segmented__opt"
            onClick={() => onChange(opt.value)}
          >
            {OptIcon ? <OptIcon size={16} strokeWidth={2} aria-hidden="true" /> : null}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
