/** Button: primary (amber), secondary, ghost, or danger. docs/DESIGN.md §6: disable + inline progress while an async action runs, never fire twice. */
import type { ComponentChildren, JSX } from 'preact';
import type { Icon } from './icon';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps {
  variant?: ButtonVariant;
  icon?: Icon;
  loading?: boolean;
  disabled?: boolean;
  block?: boolean;
  type?: 'button' | 'submit';
  onClick?: (e: MouseEvent) => void;
  'aria-label'?: string;
  class?: string;
  children?: ComponentChildren;
}

export function Button(props: ButtonProps): JSX.Element {
  const {
    variant = 'secondary',
    icon: IconComp,
    loading = false,
    disabled = false,
    block = false,
    type = 'button',
    onClick,
    class: className,
    children,
    ...rest
  } = props;

  const classes = ['pl-btn', `pl-btn--${variant}`, block ? 'pl-btn--block' : '', className ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type={type}
      class={classes}
      disabled={disabled || loading}
      aria-busy={loading ? 'true' : undefined}
      onClick={onClick}
      {...rest}
    >
      {loading ? (
        <span class="pl-btn__spinner" aria-hidden="true" />
      ) : IconComp ? (
        <IconComp size={20} strokeWidth={2} aria-hidden="true" />
      ) : null}
      {children}
    </button>
  );
}
