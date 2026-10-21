// @vitest-environment happy-dom
/**
 * Regression test for the Esc-closes-sheet-and-also-navigates-back bug:
 * Sheet's own Escape handler must stop the keydown from reaching a
 * window-level listener (app.tsx binds router.ts's bindDesktopBackKey there),
 * or closing a sheet with Esc also pops the app's route stack. See the
 * comment on the Escape branch in Sheet.tsx.
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { Sheet } from './Sheet';

/** Preact's useEffect runs after-paint (rAF + a trailing setTimeout), so poll instead of assuming it already ran. */
async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('Sheet: Escape key', () => {
  it('closes the sheet but does not bubble to a window-level keydown listener', async () => {
    const onClose = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);

    render(
      <Sheet open title="More" onClose={onClose}>
        <button type="button">Inside</button>
      </Sheet>,
      container,
    );

    const sheet = container.querySelector('[role="dialog"]') as HTMLElement;
    // The mount effect moves focus into the sheet; wait for it so we know the
    // document-level Escape listener is attached too (same effect call).
    await waitUntil(() => sheet.contains(document.activeElement));

    const windowListener = vi.fn();
    window.addEventListener('keydown', windowListener);
    try {
      sheet.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(windowListener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', windowListener);
      render(null, container);
      container.remove();
    }
  });
});
