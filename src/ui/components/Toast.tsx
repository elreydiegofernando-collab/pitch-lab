/** ToastRegion: renders the global toast queue (src/state/toast.ts). Mount once, in app.tsx. */
import type { JSX } from 'preact';
import { dismissToast, toasts } from '../../state/toast';

export function ToastRegion(): JSX.Element | null {
  if (toasts.value.length === 0) return null;
  return (
    <div class="pl-toast-region" role="status" aria-live="polite">
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
