/**
 * The stylesheets' contrast and focus promises, read from the CSS itself (DESIGN.md §3, §6): text in a hue meets 4.5:1
 * and a graphic 3:1 in BOTH themes, the Stop label is readable on its fill, the world hues hold up on light surfaces on
 * every screen, and the focus ring inside a clipping list is drawn where it can be seen.
 */
import { describe, expect, it } from 'vitest';

// Vitest hands a stylesheet import (even `?raw`) over as an empty string, so the files are read from disk. The module
// name is built at run time: the app's tsconfig has no Node types, and this is the one test that needs a Node module.
const { readFileSync } = (await import(/* @vite-ignore */ `node:${'fs'}`)) as { readFileSync(path: URL, encoding: 'utf8'): string };
const css = (name: string): string => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const tokens = css('tokens.css');
const components = css('components.css');
const song = css('song.css');
const worlds = css('worlds.css');
const progress = css('progress.css');

/** The declarations of the first rule whose selector is exactly `selector` (at any nesting depth). */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule ${selector}`);
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('}', open));
}

function props(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

/** A theme's custom properties: the :root defaults with the theme block over them, var() references resolved. */
function theme(name: 'light' | 'dark'): Record<string, string> {
  const merged = { ...props(rule(tokens, ':root')), ...props(rule(tokens, `:root[data-theme='${name}']`)) };
  const resolve = (v: string, depth = 0): string => {
    const m = /^var\((--[\w-]+)\)$/.exec(v);
    return m && depth < 8 ? resolve(merged[m[1]], depth + 1) : v;
  };
  return Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, resolve(v)]));
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const SURFACES = ['--bg-0', '--bg-1', '--bg-2'] as const;
const TEXT_HUES = ['--tally-text', '--on-text', '--off-text', '--alert-text'] as const;

describe('text in a hue is readable in both themes', () => {
  it('the text-safe hues meet 4.5:1 on every surface in the light theme, and are the hue itself in the dark theme', () => {
    const light = theme('light');
    for (const t of TEXT_HUES) for (const s of SURFACES) expect(contrast(light[t], light[s]), `${t} on ${s}`).toBeGreaterThanOrEqual(4.5);
    const dark = theme('dark');
    expect(dark['--tally-text']).toBe(dark['--tally']);
    expect(dark['--on-text']).toBe(dark['--on']);
    expect(dark['--off-text']).toBe(dark['--off']);
    expect(dark['--alert-text']).toBe(dark['--alert']);
  });

  it('the system-light theme (no data-theme yet) defines the same text hues and world hues as the explicit light theme', () => {
    const media = tokens.slice(tokens.indexOf('@media (prefers-color-scheme: light)'));
    const system = props(rule(media, ':root:not([data-theme])'));
    const explicit = props(rule(tokens, ":root[data-theme='light']"));
    for (const k of [...TEXT_HUES, '--world-vibrato', '--world-inflections', '--world-runs', '--world-dynamics', '--world-song']) expect(system[k], k).toBe(explicit[k]);
  });

  it('the status pills, the toast action, Import, the key line and the pressed toggles use the text-safe hues', () => {
    expect(rule(components, '.pl-status-pill--running')).toContain('color: var(--on-text)');
    expect(rule(components, '.pl-toast__action')).toContain('color: var(--tally-text)');
    expect(rule(song, '.pl-song-appbar-action')).toContain('color: var(--tally-text)');
    expect(rule(song, '.pl-song-key__suggest')).toContain('color: var(--tally-text)');
    expect(rule(song, '.pl-song-key__fit')).toContain('color: var(--on-text)');
    expect(rule(song, ".pl-song-tbtn[aria-pressed='true']")).toContain('color: var(--tally-text)');
    expect(rule(progress, '.pl-data-chip--off')).toContain('color: var(--text-mid)');
  });
});

describe('the Stop button', () => {
  it('writes its label and glyph in the page colour on the alert fill: 4.5:1 or better in both themes', () => {
    const running = rule(components, '.pl-bottombar__primary--running');
    expect(running).toContain('background: var(--alert)');
    expect(running).toContain('color: var(--bg-0)');
    for (const name of ['light', 'dark'] as const) {
      const t = theme(name);
      expect(contrast(t['--bg-0'], t['--alert']), name).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('world hues', () => {
  it('hold 3:1 on the light surfaces as graphics, on every screen (tokens.css, not one screen\'s scope)', () => {
    const light = theme('light');
    for (const w of ['--world-foundations', '--world-vibrato', '--world-inflections', '--world-runs', '--world-dynamics', '--world-song']) {
      for (const s of ['--bg-0', '--bg-1'] as const) expect(contrast(light[w], light[s]), `${w} on ${s}`).toBeGreaterThanOrEqual(3);
    }
    expect(worlds).not.toMatch(/--world-(vibrato|inflections|runs|dynamics|song)\s*:/);
    expect(progress).not.toMatch(/#000\b/);
  });
});

describe('Live and Sing on a 320 px phone', () => {
  it('keep their one column to the screen width and wrap the readouts (the gauge on its own row) below 380 px', () => {
    expect(rule(components, '.pl-live-body')).toContain('grid-template-columns: minmax(0, 1fr)');
    const at = components.indexOf('@media (max-width: 379px)');
    expect(at).toBeGreaterThan(0);
    const narrow = components.slice(at, components.indexOf('\n}\n', at));
    expect(rule(narrow, '.pl-readouts')).toContain('flex-wrap: wrap');
    expect(rule(narrow, '.pl-readouts__note')).toContain('min-width: 0');
    expect(rule(narrow, '.pl-readouts__gauge')).toContain('flex: 1 1 100%');
  });
});

describe('focus rings', () => {
  it('are drawn inset inside a list (which clips its corners) and on the note pills (whose row scrolls)', () => {
    const at = components.indexOf('.pl-list :focus-visible');
    expect(at).toBeGreaterThan(0);
    const block = components.slice(at, components.indexOf('}', at));
    expect(block).toContain('.pl-note-pill:focus-visible');
    expect(block).toContain('outline-offset: -2px');
  });
});
