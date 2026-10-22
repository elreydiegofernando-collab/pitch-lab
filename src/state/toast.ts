/** Global toast queue (SW update prompts, save confirmations, etc.). Rendered once by <ToastRegion> in app.tsx. */
import { signal } from '@preact/signals';

export interface ToastMessage {
  readonly id: number;
  readonly message: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}

export const toasts = signal<readonly ToastMessage[]>([]);

/**
 * How many sheets are open right now (Sheet registers itself while open). A toast never covers an open sheet: while one
 * is open the toast region moves to the top of the screen, clear of the sheet's actions at the bottom.
 */
export const openSheets = signal(0);

/** A sheet opened: count it until the returned function is called (once) as it closes. */
export function sheetOpened(): () => void {
  openSheets.value += 1;
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    openSheets.value = Math.max(0, openSheets.value - 1);
  };
}

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
