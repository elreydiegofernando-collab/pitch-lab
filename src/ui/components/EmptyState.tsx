/** EmptyState: an icon, a title and an optional message/action for a screen or sheet with nothing to show yet. */
import type { ComponentChildren, JSX } from 'preact';
import type { Icon } from './icon';

export interface EmptyStateProps {
  icon?: Icon;
  title: string;
  message?: string;
  children?: ComponentChildren;
  class?: string;
}

export function EmptyState(props: EmptyStateProps): JSX.Element {
  const { icon: IconComp, title, message, children, class: className } = props;
  return (
    <div class={['pl-empty', className ?? ''].filter(Boolean).join(' ')}>
      {IconComp ? <IconComp size={32} strokeWidth={1.75} aria-hidden="true" /> : null}
      <p class="pl-empty__title">{title}</p>
      {message ? <p class="pl-body-s">{message}</p> : null}
      {children}
    </div>
  );
}
