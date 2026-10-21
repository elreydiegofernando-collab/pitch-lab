/** Sheet: a focus-trapped bottom sheet. Esc and the scrim close it; focus returns to the opener on close. */
import { useEffect, useRef } from 'preact/hooks';
import type { ComponentChildren, JSX } from 'preact';
import { X } from 'lucide-preact';

export interface SheetProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children?: ComponentChildren;
  class?: string;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

export function Sheet(props: SheetProps): JSX.Element | null {
  const { open, title, onClose, children, class: className } = props;
  const sheetRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const container = sheetRef.current;
    const first = container ? focusableIn(container)[0] : undefined;
    (first ?? container)?.focus();

    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        // Stop here: otherwise this same keydown bubbles to app.tsx's
        // window-level Escape listener (router.ts's bindDesktopBackKey) and
        // pops the route stack too, navigating the user away from the
        // screen behind the sheet they just closed.
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !container) return;
      const items = focusableIn(container);
      if (items.length === 0) return;
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstItem) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && document.activeElement === lastItem) {
        e.preventDefault();
        firstItem.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div class="pl-sheet-scrim" onClick={onClose}>
      <div
        ref={sheetRef}
        class={['pl-sheet', className ?? ''].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="pl-sheet__grabber" aria-hidden="true" />
        <div class="pl-sheet__header">
          <span class="pl-sheet__title">{title}</span>
          <button type="button" class="pl-sheet__close" aria-label="Close" onClick={onClose}>
            <X size={22} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        <div class="pl-sheet__body">{children}</div>
      </div>
    </div>
  );
}
