/** ListRow: a >= 56px row inside a `.pl-list` group (Settings, Setup device/mic pickers, note picker). */
import type { ComponentChildren, JSX } from 'preact';
import { Check } from 'lucide-preact';
import type { Icon } from './icon';

export interface ListRowProps {
  icon?: Icon;
  title: string;
  subtitle?: string;
  /** Right-aligned secondary text (e.g. the current value for a settings row that opens a sheet). */
  value?: string;
  /** Shows a check glyph (never color alone) to mark the selected option in a picker list. */
  selected?: boolean;
  onClick?: () => void;
  /** Custom trailing control (Toggle, etc.) instead of `value`/`selected`. */
  trailing?: ComponentChildren;
  'aria-label'?: string;
  /** Forwarded to the row element (Diagnostics identifies its rows this way for the e2e suite). */
  'data-testid'?: string;
  class?: string;
}

export function ListRow(props: ListRowProps): JSX.Element {
  const { icon: IconComp, title, subtitle, value, selected, onClick, trailing, class: className, ...rest } = props;
  const classes = ['pl-row', className ?? ''].filter(Boolean).join(' ');

  const content = (
    <>
      {IconComp ? (
        <span class="pl-row__icon" aria-hidden="true">
          <IconComp size={20} strokeWidth={2} />
        </span>
      ) : null}
      <span class="pl-row__label">
        <span class="pl-row__title">{title}</span>
        {subtitle ? <span class="pl-row__sub">{subtitle}</span> : null}
      </span>
      {value ? <span class="pl-row__value">{value}</span> : null}
      {trailing}
      {selected ? (
        <Check class="pl-row__icon" size={20} strokeWidth={2.5} aria-hidden="true" />
      ) : null}
    </>
  );

  if (onClick) {
    return (
      <button type="button" class={classes} onClick={onClick} {...rest}>
        {content}
      </button>
    );
  }
  return (
    <div class={classes} {...rest}>
      {content}
    </div>
  );
}
