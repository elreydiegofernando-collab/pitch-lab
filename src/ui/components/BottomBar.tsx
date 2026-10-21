/** BottomBar: Listen (left) / Sing-Stop (centre, 64px primary) / More (right) — the thumb-zone action row (docs/DESIGN.md §6-7). */
import { useEffect } from 'preact/hooks';
import type { JSX } from 'preact';
import { Ellipsis, Mic, Square, Volume2 } from 'lucide-preact';

export interface BottomBarProps {
  onListen?: () => void;
  onToggleSing: () => void;
  singing: boolean;
  /** Disables Sing/Stop while start()/stop() is in flight, so a second tap can't fire a second call. */
  singBusy?: boolean;
  onMore?: () => void;
  class?: string;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
}

export function BottomBar(props: BottomBarProps): JSX.Element {
  const { onListen, onToggleSing, singing, singBusy = false, onMore, class: className } = props;

  // Desktop shortcuts (docs/DESIGN.md §6): Space = Sing/Stop, L = Listen. Scoped to while this bar is mounted (Live only).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (isTypingTarget(e.target)) return;
      if (e.code === 'Space' && !singBusy) {
        e.preventDefault();
        onToggleSing();
      } else if ((e.key === 'l' || e.key === 'L') && onListen) {
        e.preventDefault();
        onListen();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onToggleSing, onListen, singBusy]);

  return (
    <nav class={['pl-bottombar', className ?? ''].filter(Boolean).join(' ')} aria-label="Primary actions">
      <button
        type="button"
        class="pl-bottombar__btn"
        onClick={onListen}
        disabled={!onListen}
        aria-label="Listen to the reference tone"
      >
        <Volume2 size={24} strokeWidth={2} aria-hidden="true" />
        <span>Listen</span>
      </button>

      <button
        type="button"
        class={['pl-bottombar__primary', singing ? 'pl-bottombar__primary--running' : '']
          .filter(Boolean)
          .join(' ')}
        onClick={onToggleSing}
        disabled={singBusy}
        aria-busy={singBusy ? 'true' : undefined}
        aria-label={singing ? 'Stop singing' : 'Start singing'}
        data-testid="sing-button"
      >
        {singing ? (
          <Square size={26} strokeWidth={2} aria-hidden="true" />
        ) : (
          <Mic size={26} strokeWidth={2} aria-hidden="true" />
        )}
        <span>{singing ? 'Stop' : 'Sing'}</span>
      </button>

      <button
        type="button"
        class="pl-bottombar__btn"
        onClick={onMore}
        disabled={!onMore}
        aria-label="More options"
      >
        <Ellipsis size={24} strokeWidth={2} aria-hidden="true" />
        <span>More</span>
      </button>
    </nav>
  );
}
