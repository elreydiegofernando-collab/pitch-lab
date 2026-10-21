/** Slider: a plain range input (reference volume, etc.), >= 48px tall hit area via track padding. */
import type { JSX } from 'preact';

export interface SliderProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  'aria-label': string;
  class?: string;
}

export function Slider(props: SliderProps): JSX.Element {
  const { value, min = 0, max = 1, step = 0.01, onChange, 'aria-label': ariaLabel, class: className } = props;
  return (
    <input
      type="range"
      class={['pl-slider', className ?? ''].filter(Boolean).join(' ')}
      min={min}
      max={max}
      step={step}
      value={value}
      aria-label={ariaLabel}
      onInput={(e) => onChange(Number(e.currentTarget.value))}
    />
  );
}
