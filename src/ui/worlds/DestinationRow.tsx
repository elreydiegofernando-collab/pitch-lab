/**
 * A destination on Home (docs/DESIGN.md 13.1): an open one is a ListRow with a chevron; a locked one is NOT a control.
 * It keeps its place, dimmed, with `<Locked compact>` and the requirement line where the chevron would be (SPEC 11.1).
 */
import type { JSX } from 'preact';
import { ChevronRight } from 'lucide-preact';
import { ListRow } from '../components/ListRow';
import { Locked } from '../components/Locked';
import type { Icon } from '../components/icon';

export interface DestinationRowProps {
  icon: Icon;
  title: string;
  subtitle: string;
  testId: string;
  /** Opens the destination. Leave out for a locked one. */
  onOpen?: () => void;
  /** The requirement line of a locked destination; its presence makes the row a static locked line. */
  lockedHint?: string;
  /** A row that needs attention gets a dot, and the reason as its subtitle. */
  attention?: boolean;
}

export function DestinationRow(props: DestinationRowProps): JSX.Element {
  const { icon: RowIcon, title, subtitle, testId, onOpen, lockedHint, attention = false } = props;
  if (lockedHint !== undefined) {
    return (
      <div class="pl-row wl-row--locked" data-testid={testId} data-locked="true">
        <span class="pl-row__icon" aria-hidden="true">
          <RowIcon size={20} strokeWidth={2} />
        </span>
        <span class="pl-row__label">
          <span class="pl-row__title">{title}</span>
          <Locked compact hint={lockedHint} />
        </span>
      </div>
    );
  }
  return (
    <ListRow
      icon={RowIcon}
      title={title}
      subtitle={subtitle}
      onClick={onOpen}
      data-testid={testId}
      trailing={
        <>
          {attention ? (
            <>
              <span class="pl-dot" aria-hidden="true" />
              <span class="pl-visually-hidden">Needs attention</span>
            </>
          ) : null}
          <ChevronRight class="wl-chev" size={20} aria-hidden="true" />
        </>
      }
    />
  );
}
