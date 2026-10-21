/** Banner: info/warn/error, with an optional action. Never color alone: each kind also gets a distinct glyph. */
import type { ComponentChildren, JSX } from 'preact';
import { CircleAlert, Info, TriangleAlert } from 'lucide-preact';
import { Button } from './Button';

export type BannerKind = 'info' | 'warn' | 'error';

export interface BannerProps {
  kind?: BannerKind;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  children?: ComponentChildren;
  class?: string;
}

const KIND_ICON = { info: Info, warn: TriangleAlert, error: CircleAlert } as const;

export function Banner(props: BannerProps): JSX.Element {
  const { kind = 'info', message, actionLabel, onAction, children, class: className } = props;
  const KindIcon = KIND_ICON[kind];
  // 'error' needs an assertive announcement (role="alert") so a screen-reader
  // user is interrupted for actionable failures like a blocked mic; role="alert"
  // implies its own live-region semantics, so no separate aria-live is needed.
  const role = kind === 'error' ? 'alert' : 'status';
  return (
    <div class={['pl-banner', `pl-banner--${kind}`, className ?? ''].filter(Boolean).join(' ')} role={role}>
      <KindIcon aria-hidden="true" />
      <div class="pl-banner__body">
        <p class="pl-banner__msg">{message}</p>
        {children}
        {actionLabel && onAction ? (
          <Button variant="primary" onClick={onAction}>
            {actionLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
