/** The vibrato styles in plain words: no Hz or cents, and the speed follows the config. */
import { describe, expect, it } from 'vitest';
import { jargonIn } from '../coaching/plain';
import { CONFIG } from '../config';
import type { VibratoStyle } from '../core/types';
import { vibratoStyleWords } from './vibrato-words';

describe('vibratoStyleWords', () => {
  it('says what each style sounds like and how fast both go', () => {
    expect(vibratoStyleWords('pop')).toBe('A light, narrow vibrato, like many pop and R&B singers use. Both go about five to seven wobbles a second.');
    expect(vibratoStyleWords('classical')).toBe('A fuller, wider vibrato, like opera and choir singers use. Both go about five to seven wobbles a second.');
  });

  it('reads an out-of-set style as pop', () => {
    expect(vibratoStyleWords('jazz' as VibratoStyle)).toBe(vibratoStyleWords('pop'));
    expect(vibratoStyleWords('__proto__' as VibratoStyle)).toBe(vibratoStyleWords('pop'));
  });

  it('uses no unit or jargon, and gives every style the config knows its own words', () => {
    const lines = (Object.keys(CONFIG.vibrato.styles) as VibratoStyle[]).map((style) => vibratoStyleWords(style));
    for (const words of lines) {
      expect(jargonIn(words)).toEqual([]);
      expect(words).not.toMatch(/\d/);
    }
    expect(new Set(lines).size).toBe(lines.length);
  });
});
