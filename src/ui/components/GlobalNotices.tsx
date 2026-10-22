/**
 * The app-wide notices (app.tsx), placed so they never move a screen under the singer or sit under the status bar:
 *
 *  - NotSavingBanner: storage is not durable on this launch (ARCHITECTURE "Wave 2 must-dos": not dismissable). It sits
 *    above every screen, padded for the status bar, and sticks to the top; the app bar sticks just below it without
 *    padding for the status bar a second time (components.css `.pl-has-global-banner`).
 *  - useBreakReminder: after CONFIG.health.breakReminderMin of actual singing (mic running), a toast that waits for its
 *    Dismiss. A toast floats over the screen above the bottom bar, so a take in progress keeps its canvas where it was.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { CONFIG } from '../../config';
import { engineState } from '../../state/engine-store';
import { dismissToast, showToast, toasts } from '../../state/toast';
import { Banner } from './Banner';

export const NOT_SAVING_MESSAGE = 'This browser is not saving your data on this visit. Progress and takes will be lost when you close Pitch Lab.';
export const BREAK_REMINDER_MESSAGE = "You've been singing for a while. A short break helps your voice.";
const BREAK_REMINDER_MS = CONFIG.health.breakReminderMin * 60 * 1000;
/** How often the singing time is checked against the reminder's threshold. */
const BREAK_CHECK_MS = 10_000;

/** While mounted: <html> gets `pl-has-global-banner` and `--global-banner-h` (the banner's height, kept current). */
function useGlobalBannerHeight(el: HTMLDivElement | null): void {
  useEffect(() => {
    if (!el || typeof document === 'undefined') return undefined;
    const root = document.documentElement;
    const write = (): void => root.style.setProperty('--global-banner-h', `${el.getBoundingClientRect().height}px`);
    root.classList.add('pl-has-global-banner');
    write();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(write) : null;
    observer?.observe(el);
    return () => {
      observer?.disconnect();
      root.classList.remove('pl-has-global-banner');
      root.style.removeProperty('--global-banner-h');
    };
  }, [el]);
}

export function NotSavingBanner(): JSX.Element {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  useGlobalBannerHeight(el);
  return (
    <div class="pl-global-banner" data-testid="not-saving-banner" ref={setEl}>
      <Banner kind="warn" message={NOT_SAVING_MESSAGE} />
    </div>
  );
}

/** Counts actual singing time (the mic running) and shows the break reminder toast once it reaches the threshold. */
export function useBreakReminder(): void {
  const runningSince = useRef<number | null>(null);
  const accumulatedMs = useRef(0);
  const toastId = useRef<number | null>(null);
  const state = engineState.value;

  // Accumulate actual running time (paused while stopped), independent of wall-clock time since mount.
  useEffect(() => {
    if (state === 'running') {
      if (runningSince.current === null) runningSince.current = Date.now();
    } else if (runningSince.current !== null) {
      accumulatedMs.current += Date.now() - runningSince.current;
      runningSince.current = null;
    }
  }, [state]);

  useEffect(() => {
    const restart = (): void => {
      toastId.current = null;
      accumulatedMs.current = 0;
      runningSince.current = engineState.peek() === 'running' ? Date.now() : null;
    };
    const id = setInterval(() => {
      if (toastId.current !== null) {
        if (!toasts.peek().some((t) => t.id === toastId.current)) restart(); // dismissed: count afresh
        return;
      }
      const extra = runningSince.current !== null ? Date.now() - runningSince.current : 0;
      if (accumulatedMs.current + extra >= BREAK_REMINDER_MS) {
        toastId.current = showToast(BREAK_REMINDER_MESSAGE, { actionLabel: 'Dismiss', onAction: restart });
      }
    }, BREAK_CHECK_MS);
    return () => {
      clearInterval(id);
      if (toastId.current !== null) dismissToast(toastId.current);
    };
  }, []);
}
