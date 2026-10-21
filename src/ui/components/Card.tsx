/** Card: a surface. With `onClick` it is a 56px+ tappable nav row (icon, title, subtitle, unseen dot, chevron); without one it is a plain container for arbitrary content, or a static icon+title row when `title` is given. */
import type { ComponentChildren, JSX } from 'preact';
import { ChevronRight } from 'lucide-preact';
import type { Icon } from './icon';

export interface CardProps {
  onClick?: () => void;
  icon?: Icon;
  title?: string;
  subtitle?: string;
  /** Unseen/attention dot next to the title (e.g. Setup before calibration exists). */
  dot?: boolean;
  muted?: boolean;
  /** Hide the chevron on a tappable card (default shown). */
  chevron?: boolean;
  'aria-label'?: string;
  class?: string;
  children?: ComponentChildren;
}

export function Card(props: CardProps): JSX.Element {
  const {
    onClick,
    icon: IconComp,
    title,
    subtitle,
    dot = false,
    muted = false,
    chevron = true,
    class: className,
    children,
    ...rest
  } = props;

  const isRow = Boolean(onClick) || Boolean(IconComp) || Boolean(title);
  const classes = [
    'pl-card',
    onClick ? 'pl-card--tap' : isRow ? 'pl-card--row' : '',
    muted ? 'pl-card--muted' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  const row = (
    <>
      {IconComp ? (
        <span class="pl-card__icon" aria-hidden="true">
          <IconComp size={22} strokeWidth={2} />
        </span>
      ) : null}
      <span class="pl-card__body">
        {title ? (
          <span class="pl-card__title">
            {title}
            {dot ? <span class="pl-dot" aria-hidden="true" /> : null}
          </span>
        ) : null}
        {subtitle ? <span class="pl-body-s pl-muted">{subtitle}</span> : null}
        {children}
      </span>
      {onClick && chevron ? <ChevronRight class="pl-card__chevron" size={20} aria-hidden="true" /> : null}
    </>
  );

  if (onClick) {
    return (
      <button type="button" class={classes} onClick={onClick} {...rest}>
        {row}
      </button>
    );
  }

  return (
    <div class={classes} {...rest}>
      {isRow ? row : children}
    </div>
  );
}
