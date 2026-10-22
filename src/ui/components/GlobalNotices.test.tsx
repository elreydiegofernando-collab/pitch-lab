// @vitest-environment happy-dom
/**
 * The app-wide notices never move a screen under the singer or sit under the status bar: the break reminder is a toast
 * that waits for its Dismiss, the not-saving warning sticks above the app bar, toasts move clear of an open sheet, and the
 * toast region exists before its first message (so screen readers announce it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';

vi.mock('../../state/engine-store', async () => {
  const { signal } = await import('@preact/signals');
  return { engineState: signal('idle') };
});

import { CONFIG } from '../../config';
import { engineState } from '../../state/engine-store';
import { openSheets, showToast, toasts } from '../../state/toast';
import { Banner } from './Banner';
import { BREAK_REMINDER_MESSAGE, NOT_SAVING_MESSAGE, NotSavingBanner, useBreakReminder } from './GlobalNotices';
import { Sheet } from './Sheet';
import { ToastRegion } from './Toast';

let container: HTMLElement;

async function show(node: preact.ComponentChild): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(() => {
    render(node, container);
  });
}

beforeEach(() => {
  toasts.value = [];
  openSheets.value = 0;
  (engineState as { value: string }).value = 'idle';
});

afterEach(async () => {
  await act(() => {
    render(null, container);
  });
  container.remove();
  vi.useRealTimers();
});

function Reminder(): null {
  useBreakReminder();
  return null;
}

describe('the break reminder', () => {
  it('is a toast that waits for Dismiss, after the configured singing time, and counts afresh once dismissed', async () => {
    vi.useFakeTimers();
    await show(
      <>
        <Reminder />
        <ToastRegion />
      </>,
    );
    await act(() => {
      (engineState as { value: string }).value = 'running';
    });
    const threshold = CONFIG.health.breakReminderMin * 60 * 1000;
    await act(() => {
      vi.advanceTimersByTime(threshold - 20_000);
    });
    expect(toasts.value).toEqual([]);
    await act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(toasts.value.map((t) => t.message)).toEqual([BREAK_REMINDER_MESSAGE]);
    // It stays until dismissed: no auto-dismiss.
    await act(() => {
      vi.advanceTimersByTime(10 * 60 * 1000);
    });
    expect(toasts.value).toHaveLength(1);
    const dismiss = [...container.querySelectorAll<HTMLButtonElement>('.pl-toast__action')].find((b) => b.textContent === 'Dismiss')!;
    await act(() => {
      dismiss.click();
    });
    expect(toasts.value).toEqual([]);
    await act(() => {
      vi.advanceTimersByTime(threshold - 20_000);
    });
    expect(toasts.value).toEqual([]); // the count started again from the dismiss
  });

  it('counts singing time only, not time with the mic off', async () => {
    vi.useFakeTimers();
    await show(<Reminder />);
    const threshold = CONFIG.health.breakReminderMin * 60 * 1000;
    await act(() => {
      vi.advanceTimersByTime(threshold * 2);
    });
    expect(toasts.value).toEqual([]);
  });
});

describe('the not-saving warning', () => {
  it('sits in its own sticky wrapper, tells the app bar its height, and is not dismissable', async () => {
    await show(<NotSavingBanner />);
    const wrapper = container.querySelector('[data-testid="not-saving-banner"]')!;
    expect(wrapper.className).toBe('pl-global-banner');
    expect(wrapper.textContent).toContain(NOT_SAVING_MESSAGE);
    expect(wrapper.querySelector('button')).toBeNull();
    expect(document.documentElement.classList.contains('pl-has-global-banner')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--global-banner-h')).toMatch(/px$/);
    await act(() => {
      render(null, container);
    });
    expect(document.documentElement.classList.contains('pl-has-global-banner')).toBe(false);
  });
});

describe('the toast region', () => {
  it('is in the page before any toast, so its first message is announced', async () => {
    await show(<ToastRegion />);
    const region = container.querySelector('[data-testid="toast-region"]')!;
    expect(region).not.toBeNull();
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.childElementCount).toBe(0);
    await act(() => {
      showToast('Profile saved.');
    });
    expect(container.querySelector('[data-testid="toast-region"]')).toBe(region); // the same element, now with the message
    expect(region.textContent).toContain('Profile saved.');
  });

  it('moves to the top while a sheet is open, so a toast never covers the sheet, and back when it closes', async () => {
    let open = true;
    const close = (): void => {
      open = false;
    };
    await show(
      <>
        <Sheet open={open} title="Voice care" onClose={close}>
          <p>Warm up first.</p>
        </Sheet>
        <ToastRegion />
      </>,
    );
    await act(() => {
      showToast('Pitch Lab is ready to work offline.', { durationMs: 3000 });
    });
    expect(openSheets.value).toBe(1);
    expect(container.querySelector('[data-testid="toast-region"]')!.className).toContain('pl-toast-region--top');
    expect(container.querySelector('.pl-toast__msg')?.textContent).toBe('Pitch Lab is ready to work offline.'); // still shown
    await act(() => {
      render(
        <>
          <Sheet open={false} title="Voice care" onClose={close} />
          <ToastRegion />
        </>,
        container,
      );
    });
    expect(openSheets.value).toBe(0);
    expect(container.querySelector('[data-testid="toast-region"]')!.className).not.toContain('pl-toast-region--top');
  });
});

describe('Banner', () => {
  it('offers its action as a secondary button, so a screen keeps its one amber primary', async () => {
    await show(<Banner kind="info" message="Hello" actionLabel="Dismiss" onAction={() => undefined} />);
    const button = container.querySelector('button')!;
    expect(button.className).toContain('pl-btn--secondary');
    expect(container.querySelector('.pl-btn--primary')).toBeNull();
  });
});
