/**
 * PracticeBar: the thumb-zone action row of the Level, Sing and Vibrato meter screens (docs/DESIGN.md §6, §13.3, §13.4).
 * Listen on the left, the one amber primary action in the centre, More on the right. Unlike the Live screen's BottomBar,
 * its labels follow the take: Listen reads "Stop" while the demo plays, the primary reads Sing, Stop, "Starting…",
 * "Scoring…" with an inline spinner, "Try again" or "Sing again", and it grows into a pill when its label is long.
 *
 * Desktop keys while it is mounted: Space is the primary action, L is Listen, and Esc is offered to `onEscape` first
 * (the Sing screen stops an active take with it), then falls through to the router's Back. Space never takes over a
 * focused button or link (it activates that control, as the keyboard user expects). Every handler is called straight
 * from the click or key event, which is what keeps iOS audio start inside the user gesture.
 */
import { useEffect, useRef } from 'preact/hooks';
import type { JSX } from 'preact';
import { Ellipsis, Mic, RotateCcw, Square, Volume2 } from 'lucide-preact';

export type PrimaryKind = 'sing' | 'stop' | 'retry' | 'busy';

export interface PracticeBarProps {
  listen?: { label: 'Listen' | 'Stop'; onClick: () => void; disabled?: boolean };
  primary: { kind: PrimaryKind; label: string; onClick: () => void; disabled?: boolean };
  more?: { onClick: () => void; disabled?: boolean };
  /**
   * Called on Esc before anything else sees it. Return true when it did something (the key is then consumed and the
   * router's Back does not run); false to let Esc go back.
   */
  onEscape?: () => boolean;
  class?: string;
}

const PRIMARY_ARIA: Record<PrimaryKind, string | undefined> = {
  sing: undefined,
  stop: 'Stop singing',
  retry: 'Try again',
  busy: undefined,
};

const SPACE_ACTIVATED_ROLES: ReadonlySet<string> = new Set(['button', 'switch', 'radio', 'checkbox', 'tab', 'menuitem', 'option', 'link']);

/** Shortcuts must not steal typing, a range slider, or anything inside an open sheet. */
function ignoresShortcuts(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
  return target.closest('[role="dialog"]') !== null;
}

/** Space already means "activate" on these: leave it to the browser. */
function activatedBySpace(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === 'BUTTON' || target.tagName === 'SUMMARY' || (target.tagName === 'A' && target.hasAttribute('href'))) return true;
  const role = target.getAttribute('role');
  return role !== null && SPACE_ACTIVATED_ROLES.has(role);
}

function PrimaryIcon({ kind }: { kind: PrimaryKind }): JSX.Element {
  if (kind === 'busy') return <span class="pl-btn__spinner" aria-hidden="true" />;
  if (kind === 'stop') return <Square size={26} strokeWidth={2} aria-hidden="true" />;
  if (kind === 'retry') return <RotateCcw size={26} strokeWidth={2} aria-hidden="true" />;
  return <Mic size={26} strokeWidth={2} aria-hidden="true" />;
}

export function PracticeBar(props: PracticeBarProps): JSX.Element {
  const { listen, primary, more } = props;
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') {
        if (!e.defaultPrevented && latest.current.onEscape?.()) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      if (ignoresShortcuts(e.target)) return;
      if (e.code === 'Space') {
        if (activatedBySpace(e.target)) return;
        e.preventDefault(); // the page must not scroll
        const p = latest.current.primary;
        if (!e.repeat && !p.disabled && p.kind !== 'busy') p.onClick();
      } else if ((e.key === 'l' || e.key === 'L') && !e.repeat) {
        const l = latest.current.listen;
        if (l && !l.disabled) {
          e.preventDefault();
          l.onClick();
        }
      }
    }
    // Capture phase: Esc has to be seen before the router's window listener and before a Sheet's own handler.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const busy = primary.kind === 'busy';
  return (
    <nav class={['pl-bottombar', 'pl-practice-bar', props.class ?? ''].filter(Boolean).join(' ')} aria-label="Primary actions">
      {listen ? (
        <button
          type="button"
          class="pl-bottombar__btn"
          onClick={listen.onClick}
          disabled={listen.disabled}
          aria-label={listen.label === 'Stop' ? 'Stop the demo' : 'Listen to the demo'}
          data-testid="listen-button"
        >
          {listen.label === 'Stop' ? <Square size={24} strokeWidth={2} aria-hidden="true" /> : <Volume2 size={24} strokeWidth={2} aria-hidden="true" />}
          <span>{listen.label}</span>
        </button>
      ) : (
        <span aria-hidden="true" />
      )}

      <button
        type="button"
        class={['pl-bottombar__primary', primary.kind === 'stop' ? 'pl-bottombar__primary--running' : ''].filter(Boolean).join(' ')}
        onClick={primary.onClick}
        disabled={primary.disabled || busy}
        aria-busy={busy ? 'true' : undefined}
        aria-label={PRIMARY_ARIA[primary.kind]}
        data-testid="sing-button"
      >
        <PrimaryIcon kind={primary.kind} />
        <span>{primary.label}</span>
      </button>

      {more ? (
        <button type="button" class="pl-bottombar__btn" onClick={more.onClick} disabled={more.disabled} aria-label="More options" data-testid="more-button">
          <Ellipsis size={24} strokeWidth={2} aria-hidden="true" />
          <span>More</span>
        </button>
      ) : (
        <span aria-hidden="true" />
      )}
    </nav>
  );
}
