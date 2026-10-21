/** Global toast queue (SW update prompts, save confirmations, etc.). Rendered once by <ToastRegion> in app.tsx. */
import { signal } from '@preact/signals';

export interface ToastMessage {
  readonly id: number;
  readonly message: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}

export const toasts = signal<readonly ToastMessage[]>([]);

let nextId = 1;

export interface ShowToastOptions {
  actionLabel?: string;
  onAction?: () => void;
  /** Auto-dismiss after this long. Omit for a toast with an action, which should wait for the tap. */
  durationMs?: number;
}

export function showToast(message: string, opts: ShowToastOptions = {}): number {
  const id = nextId++;
  toasts.value = [...toasts.value, { id, message, actionLabel: opts.actionLabel, onAction: opts.onAction }];
  if (opts.durationMs !== undefined) {
    setTimeout(() => dismissToast(id), opts.durationMs);
  }
  return id;
}

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}
