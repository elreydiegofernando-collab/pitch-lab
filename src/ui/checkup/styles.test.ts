/**
 * checkup.css keeps the design system's promises (docs/DESIGN.md 3, 6, 9; docs/ARCHITECTURE.md "Styles"): tokens only (no
 * new hue, no new font), text in a hue uses the text-safe tokens that meet 4.5:1 in both themes, targets are at least
 * 48 px (64 px for the primary), nothing moves under reduced motion, and every `ck-` class the screens use is styled.
 */
import { describe, expect, it } from 'vitest';

// Vitest hands a stylesheet import over as an empty string, so the files are read from disk. The module name is built at
// run time: the app's tsconfig has no Node types, and this is one of the few tests that needs a Node module.
const { readFileSync } = (await import(/* @vite-ignore */ `node:${'fs'}`)) as { readFileSync(path: URL, encoding: 'utf8'): string };
const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const css = read('../../styles/checkup.css');

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule ${selector}`);
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('}', open));
}

describe('checkup.css: tokens only', () => {
  it('uses no colour literal: every colour is a token (or a mix of tokens)', () => {
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(code).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(/);
  });

  it('defines no custom property but its own (no new hue, no world hue, no new font)', () => {
    // A custom property is declared at the start of a line (`--name: value;`); `.ck-task--next::before` is a selector.
    const declared = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) expect(name.startsWith('--ck-'), name).toBe(true);
    expect(css).not.toMatch(/font-family:\s*['"]/);
    expect(css).not.toMatch(/@font-face|@import/);
  });

  it('writes text in a hue with the text-safe tokens, never the base hues (which fall under 4.5:1 on the light surfaces)', () => {
    expect(rule('.ck-rating--solid')).toContain('color: var(--on-text)');
    expect(rule('.ck-rating--focus')).toContain('color: var(--tally-text)');
    expect(rule('.ck-line--better .ck-line__mark')).toContain('color: var(--on-text)');
    expect(rule('.ck-card__icon')).toContain('color: var(--tally-text)');
    for (const block of css.matchAll(/(?:^|\s)color:\s*var\((--[\w-]+)\)/g)) {
      expect(['--on', '--off', '--alert', '--tally', '--good', '--meh'], `color: var(${block[1]})`).not.toContain(block[1]);
    }
  });

  it('never uses an alarm colour for a rating or a verdict: a worse line and a focus skill are calm', () => {
    expect(css).not.toMatch(/var\(--alert/);
    expect(css).not.toMatch(/var\(--off\b/);
  });
});

describe('checkup.css: touch and motion', () => {
  it('keeps targets at least 48 px, and the primary action 64 px', () => {
    expect(rule('.ck-dash__row')).toContain('min-height: var(--target-min)');
    expect(rule('.ck-cta')).toContain('min-height: var(--target-primary)');
    expect(rule('.ck-card--row')).toContain('min-height: 64px');
  });

  it('stops the one thing that moves (a skeleton fading) under reduced motion, by the OS setting and by the app\'s own', () => {
    const media = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(media).toMatch(/\.ck-skeleton\s*\{\s*animation:\s*none;/);
    expect(css).toMatch(/:root\[data-reduced-motion='on'\] \.ck-skeleton\s*\{\s*animation:\s*none;/);
  });

  it('animates nothing but opacity (docs/DESIGN.md 9): no width, height, margin or shadow in a keyframe', () => {
    for (const block of css.matchAll(/@keyframes [\w-]+\s*\{([\s\S]*?)\n\}/g)) {
      expect(block[1]).not.toMatch(/\b(?:width|height|margin|padding|top|left|box-shadow)\s*:/);
    }
  });
});

describe('checkup.css: every class the screens use is styled', () => {
  const sources = [
    '../checkup/CheckupsCard.tsx',
    '../checkup/ComparisonView.tsx',
    '../checkup/SkillList.tsx',
    '../checkup/SummaryView.tsx',
    '../checkup/TakeCompare.tsx',
    '../checkup/TaskList.tsx',
    '../screens/Checkup.tsx',
    '../screens/CheckupResults.tsx',
    '../worlds/CheckupCard.tsx',
  ];

  it('defines each ck- class (or, for one built from a state word, at least the family of it)', () => {
    const missing: string[] = [];
    for (const file of sources) {
      const source = read(file);
      for (const m of source.matchAll(/\bck-[a-z0-9_-]+/g)) {
        const name = m[0];
        const dynamic = name.endsWith('-');
        const defined = new RegExp(`\\.${name.replace(/[-_]/g, (c) => `\\${c}`)}${dynamic ? '' : '(?![\\w-])'}`).test(css);
        if (!defined) missing.push(`${file}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('styles the state classes the screens build from a word: task states, ratings, verdicts and card kinds', () => {
    for (const cls of ['ck-task--done', 'ck-task--next', 'ck-rating--solid', 'ck-rating--focus', 'ck-rating--not-measured', 'ck-line--better', 'ck-card--prominent', 'ck-card--standard', 'ck-card--row', 'ck-pair--two']) {
      expect(css, cls).toContain(`.${cls}`);
    }
  });
});
