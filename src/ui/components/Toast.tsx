/**
 * ToastRegion: renders the global toast queue (src/state/toast.ts). Mount once, in app.tsx.
 *
 * The region is always in the page, empty or not: a live region only announces changes to content inside it once it
 * already exists, so one created together with its message is often skipped by screen readers. While a sheet is open the
 * region sits at the top of the screen, so a toast never covers the sheet (its actions are at the bottom).
 */
import type { JSX } from 'preact';
import { dismissToast, openSheets, toasts } from '../../state/toast';

export function ToastRegion(): JSX.Element {
  const top = openSheets.value > 0;
  return (
    <div class={`pl-toast-region${top ? ' pl-toast-region--top' : ''}`} role="status" aria-live="polite" data-testid="toast-region">
      {toasts.value.map((t) => (
        <div key={t.id} class="pl-toast">
          <span class="pl-toast__msg">{t.message}</span>
          {t.actionLabel ? (
            <button
              type="button"
              class="pl-toast__action"
              onClick={() => {
                t.onAction?.();
                dismissToast(t.id);
              }}
            >
              {t.actionLabel}
            </button>
          ) : (
            <button type="button" class="pl-toast__action" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
              Dismiss
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
