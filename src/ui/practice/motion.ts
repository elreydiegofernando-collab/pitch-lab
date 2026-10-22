/**
 * Motion for the practice screens (docs/DESIGN.md §9). Reduced motion is resolved the way state/theme.ts resolves it
 * (the in-app setting first, then the OS query). The report's celebration is two pure curves plus one small hook each:
 * the score count-up and the tally-light stagger.
 */
import { useEffect, useState } from 'preact/hooks';
import type { Settings } from '../../state/settings-types';

/** True when the OS or the in-app setting asks for reduced motion (state/theme.ts writes the resolved value onto <html>). */
export function prefersReducedMotion(): boolean {
  if (typeof document !== 'undefined') {
    const resolved = document.documentElement.dataset.reducedMotion;
    if (resolved === 'on') return true;
    if (resolved === 'off') return false;
  }
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The PitchView `reducedMotion` option for a setting: 'system' returns undefined so the view reads the OS query itself
 * (passing false would override a reduced-motion preference).
 */
export function viewReducedMotion(setting: Settings['reducedMotion']): boolean | undefined {
  return setting === 'system' ? undefined : setting === 'on';
}

/** Ease-out: fast at first, settling into the final value. */
export function easeOutCubic(u: number): number {
  const c = u < 0 ? 0 : u > 1 ? 1 : u;
  return 1 - (1 - c) ** 3;
}

/** The count-up value `elapsedMs` into a `durationMs` animation towards `target`. */
export function countUpValue(elapsedMs: number, target: number, durationMs: number): number {
  return durationMs <= 0 ? target : target * easeOutCubic(elapsedMs / durationMs);
}

/** A number that counts from 0 to `target` over `durationMs` once (per target); `target` at once when not animating. */
export function useCountUp(target: number, durationMs: number, animate: boolean): number {
  const [value, setValue] = useState(animate ? 0 : target);
  useEffect(() => {
    if (!animate) {
      setValue(target);
      return undefined;
    }
    let frame = 0;
    const started = performance.now();
    const step = (now: number): void => {
      const elapsed = now - started;
      setValue(countUpValue(elapsed, target, durationMs));
      if (elapsed < durationMs) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs, animate]);
  return value;
}

/** How many of `total` lights are on: the first after `delayMs`, then one per `stepMs`; all of them at once when not animating. */
export function useStaggeredCount(total: number, delayMs: number, stepMs: number, animate: boolean): number {
  const [lit, setLit] = useState(animate ? 0 : total);
  useEffect(() => {
    if (!animate || total <= 0) {
      setLit(total);
      return undefined;
    }
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    for (let i = 1; i <= total; i++) timers.push(setTimeout(() => setLit(i), delayMs + (i - 1) * stepMs));
    return () => timers.forEach((t) => clearTimeout(t));
  }, [total, delayMs, stepMs, animate]);
  return lit;
}
