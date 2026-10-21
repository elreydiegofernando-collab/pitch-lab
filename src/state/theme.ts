/**
 * Resolves the `theme` / `reducedMotion` settings (which may be "system")
 * against the OS media queries and writes the result onto `<html>` as
 * `data-theme` / `data-reduced-motion`. styles/tokens.css and base.css key
 * off those attributes, not off the media queries directly, so a user
 * override always wins even while the OS preference also changes.
 */
import { effect } from '@preact/signals';
import { settings } from './settings';
import type { Settings } from './settings-types';

function resolveTheme(pref: Settings['theme']): 'dark' | 'light' {
  if (pref === 'system') {
    return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark';
  }
  return pref;
}

function resolveReducedMotion(pref: Settings['reducedMotion']): 'on' | 'off' {
  if (pref === 'system') {
    return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'on'
      : 'off';
  }
  return pref;
}

let initialized = false;

/** Idempotent; call once from app.tsx on boot. */
export function initTheme(): void {
  if (initialized || typeof document === 'undefined') return;
  initialized = true;
  const root = document.documentElement;

  const apply = (): void => {
    root.dataset.theme = resolveTheme(settings.value.theme);
    root.dataset.reducedMotion = resolveReducedMotion(settings.value.reducedMotion);
  };

  // Re-run whenever settings.theme / settings.reducedMotion change...
  effect(apply);

  // ...and whenever the OS preference changes while a setting is "system".
  if (typeof matchMedia !== 'undefined') {
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', apply);
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', apply);
  }
}
