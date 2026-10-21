/** Toggle: an on/off switch, >= 48px tap target (the visible pill is the familiar 52x32). */
import type { JSX } from 'preact';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  'aria-label': string;
  disabled?: boolean;
  class?: string;
}

export function Toggle(props: ToggleProps): JSX.Element {
  const { checked, onChange, disabled = false, class: className, ...rest } = props;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      class={['pl-toggle', className ?? ''].filter(Boolean).join(' ')}
      onClick={() => onChange(!checked)}
      {...rest}
    >
      <span class="pl-toggle__track" aria-hidden="true">
        <span class="pl-toggle__knob" />
      </span>
    </button>
  );
}
