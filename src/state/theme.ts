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

/** --bg-1 of each theme (tokens.css), for when the stylesheet's value cannot be read. */
const APP_BAR_COLOR: Record<'dark' | 'light', string> = { dark: '#15171d', light: '#ffffff' };

/**
 * The browser's own chrome (the title bar of an installed Chrome/Edge app, the tab strip tint) follows the RESOLVED
 * theme, not only the OS: index.html's theme-color metas pick by prefers-color-scheme, so a Settings override would
 * otherwise leave a light title bar over a dark app. Both metas get the app bar's colour (--bg-1), so the title bar runs
 * straight into the app bar.
 */
export function syncThemeColor(theme: 'dark' | 'light'): void {
  if (typeof document === 'undefined') return;
  let color = '';
  try {
    color = getComputedStyle(document.documentElement).getPropertyValue('--bg-1').trim();
  } catch {
    // no stylesheet to read (tests): the fallback below
  }
  if (!/^#[0-9a-f]{3,8}$/i.test(color)) color = APP_BAR_COLOR[theme];
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute('content', color);
}

/** Idempotent; call once from app.tsx on boot. */
export function initTheme(): void {
  if (initialized || typeof document === 'undefined') return;
  initialized = true;
  const root = document.documentElement;

  const apply = (): void => {
    const theme = resolveTheme(settings.value.theme);
    root.dataset.theme = theme;
    root.dataset.reducedMotion = resolveReducedMotion(settings.value.reducedMotion);
    syncThemeColor(theme);
  };

  // Re-run whenever settings.theme / settings.reducedMotion change...
  effect(apply);

  // ...and whenever the OS preference changes while a setting is "system".
  if (typeof matchMedia !== 'undefined') {
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', apply);
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', apply);
  }
}
