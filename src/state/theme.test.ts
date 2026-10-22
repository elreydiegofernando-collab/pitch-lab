// @vitest-environment happy-dom
/** The resolved theme reaches the browser's own chrome: both theme-color metas follow a Settings override, not only the OS. */
import { beforeEach, describe, expect, it } from 'vitest';
import { settings, updateSettings } from './settings';
import { initTheme, syncThemeColor } from './theme';

function metas(): string[] {
  return [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute('content') ?? '');
}

beforeEach(() => {
  document.head.innerHTML = [
    '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#F5F2EC" />',
    '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0E0F13" />',
  ].join('');
});

describe('theme-color follows the resolved theme', () => {
  it('writes the app bar colour of the theme into every theme-color meta', () => {
    syncThemeColor('dark');
    expect(metas()).toEqual(['#15171d', '#15171d']);
    syncThemeColor('light');
    expect(metas()).toEqual(['#ffffff', '#ffffff']);
  });

  it('applies on boot and again when the singer overrides the theme in Settings', () => {
    initTheme();
    updateSettings({ theme: 'dark' });
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(metas()).toEqual(['#15171d', '#15171d']);
    updateSettings({ theme: 'light' });
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(metas()).toEqual(['#ffffff', '#ffffff']);
    settings.value = { ...settings.value, theme: 'system' };
  });
});
