/**
 * The song player's thumb-zone bar (DESIGN.md §6, §13.9): Listen on the left (it reads Stop while the phrase plays),
 * the one amber primary in the centre (Sing, Stop during a take, Scoring… while judging, or Calibrate when the
 * route has no latency calibration), More on the right. Desktop keys: Space = the primary, L = Listen; off while a
 * sheet is open, and never while typing.
 */
import { useEffect } from 'preact/hooks';
import type { JSX } from 'preact';
import { Ellipsis, Square, Volume2 } from 'lucide-preact';
import type { Icon } from '../components/icon';

export interface SongBarPrimary {
  label: string;
  icon: Icon;
  /** The accessible name ("Sing phrase 3"). */
  ariaLabel: string;
  onClick(): void;
  /** Async work in flight: disabled, with an inline spinner. */
  busy?: boolean;
  /** The Stop state of a take (the alert fill). */
  stop?: boolean;
}

export interface SongBarProps {
  listening: boolean;
  listenDisabled: boolean;
  onListen(): void;
  primary: SongBarPrimary;
  onMore(): void;
  /** Space and L work (no sheet is open). */
  shortcuts: boolean;
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
}

export function SongBar(props: SongBarProps): JSX.Element {
  const { listening, listenDisabled, onListen, primary, onMore, shortcuts } = props;
  const PrimaryIcon = primary.icon;

  useEffect(() => {
    if (!shortcuts) return undefined;
    function onKeyDown(e: KeyboardEvent): void {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Space' && !primary.busy) {
        e.preventDefault();
        primary.onClick();
      } else if ((e.key === 'l' || e.key === 'L') && !listenDisabled) {
        e.preventDefault();
        onListen();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [shortcuts, primary, listenDisabled, onListen]);

  return (
    <nav class="pl-bottombar" aria-label="Song actions">
      <button type="button" class="pl-bottombar__btn" onClick={onListen} disabled={listenDisabled} aria-label={listening ? 'Stop listening' : 'Listen to the selection'}>
        {listening ? <Square size={24} strokeWidth={2} aria-hidden="true" /> : <Volume2 size={24} strokeWidth={2} aria-hidden="true" />}
        <span>{listening ? 'Stop' : 'Listen'}</span>
      </button>
      <button
        type="button"
        class={['pl-bottombar__primary', primary.stop ? 'pl-bottombar__primary--running' : ''].filter(Boolean).join(' ')}
        onClick={primary.onClick}
        disabled={primary.busy}
        aria-busy={primary.busy ? 'true' : undefined}
        aria-label={primary.ariaLabel}
        data-testid="song-primary"
      >
        {primary.busy ? <span class="pl-btn__spinner" aria-hidden="true" /> : <PrimaryIcon size={26} strokeWidth={2} aria-hidden="true" />}
        <span>{primary.label}</span>
      </button>
      <button type="button" class="pl-bottombar__btn" onClick={onMore} aria-label="More options">
        <Ellipsis size={24} strokeWidth={2} aria-hidden="true" />
        <span>More</span>
      </button>
    </nav>
  );
}
