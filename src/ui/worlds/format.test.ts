import { describe, expect, it } from 'vitest';
import { DASH, DOT, hueStyle, initialsOf, levelName, pad2, percent, plural, rangeLabel, testTitle, tierLabel, tieNumerals } from './format';

const NBSP = String.fromCharCode(0xa0);

describe('set-list numbers and scores', () => {
  it('pads numbers to two digits', () => {
    expect(pad2(4)).toBe('04');
    expect(pad2(10)).toBe('10');
  });

  it('writes scores as whole percentages and clamps them', () => {
    expect(percent(0.86)).toBe('86%');
    expect(percent(0.855)).toBe('86%');
    expect(percent(1.4)).toBe('100%');
    expect(percent(-0.2)).toBe('0%');
    expect(percent(Number.NaN)).toBe('0%');
  });

  it('names the mastery tiers and nothing before a pass', () => {
    expect([0, 1, 2, 3].map((m) => tierLabel(m as 0 | 1 | 2 | 3))).toEqual(['', 'Passed', 'Solid', 'Studio']);
  });

  it('pluralizes counts', () => {
    expect(plural(1, 'song')).toBe('1 song');
    expect(plural(3, 'song')).toBe('3 songs');
    expect(plural(0, 'short test')).toBe('0 short tests');
    expect(plural(2, 'box', 'boxes')).toBe('2 boxes');
  });

  it('joins a level range with an en dash, or names the one level', () => {
    expect(rangeLabel('Pitch match', 'Sustain II')).toBe(`Pitch match ${DASH} Sustain II`);
    expect(rangeLabel('Sirens & glides', 'Sirens & glides')).toBe('Sirens & glides');
    expect(DOT).toBe('·');
  });

  it('names a boss as the Boss Recital and any other level by its title', () => {
    expect(levelName({ kind: 'boss', title: 'Boss Recital' })).toBe('the Boss Recital');
    expect(levelName({ kind: 'level', title: 'Sustain II' })).toBe('Sustain II');
  });
});

describe('initialsOf', () => {
  it('takes one initial from a single name and two from several words', () => {
    expect(initialsOf('Daniel')).toBe('D');
    expect(initialsOf('Mary Jane')).toBe('MJ');
    expect(initialsOf('  mary   anne  smith ')).toBe('MS');
  });

  it('upper-cases, skips symbols and works on any script', () => {
    expect(initialsOf('élan')).toBe('É');
    expect(initialsOf('-- ada')).toBe('A');
    expect(initialsOf('张伟')).toBe('张');
    expect(initialsOf('7 of 9')).toBe('79');
  });

  it('falls back to a question mark when there is nothing to show', () => {
    expect(initialsOf('')).toBe('?');
    expect(initialsOf('   ')).toBe('?');
    expect(initialsOf('***')).toBe('?');
    expect(initialsOf(null)).toBe('?');
    expect(initialsOf(undefined)).toBe('?');
  });
});

describe('testTitle', () => {
  it('drops the Audition prefix and capitalizes', () => {
    expect(testTitle('Audition: match and hold')).toBe('Match and hold');
    expect(testTitle('audition : siren')).toBe('Siren');
  });

  it('keeps a title that has no prefix, or nothing after it', () => {
    expect(testTitle('Free vibrato')).toBe('Free vibrato');
    expect(testTitle('Audition:')).toBe('Audition:');
  });
});

describe('hueStyle', () => {
  it("points --wk at the world's accent token", () => {
    expect(hueStyle({ accent: '--world-vibrato' })).toEqual({ '--wk': 'var(--world-vibrato)' });
  });
});

describe('tieNumerals', () => {
  it('ties a trailing numeral to the word before it', () => {
    expect(tieNumerals('Sustain II')).toBe(`Sustain${NBSP}II`);
    expect(tieNumerals('Pulse builder III')).toBe(`Pulse builder${NBSP}III`);
    expect(tieNumerals('Messa di voce I')).toBe(`Messa di voce${NBSP}I`);
    expect(tieNumerals('Level 4')).toBe(`Level${NBSP}4`);
  });

  it('ties the numeral at the end of each title in a range, and leaves the rest of the spaces alone', () => {
    expect(tieNumerals(`Pitch match ${DASH} Sustain II`)).toBe(`Pitch match ${DASH} Sustain${NBSP}II`);
    expect(tieNumerals(`Sustain I ${DASH} Interval jumps II`)).toBe(`Sustain${NBSP}I ${DASH} Interval jumps${NBSP}II`);
  });

  it('does not touch words that merely start with a numeral letter', () => {
    expect(tieNumerals('Interval jumps')).toBe('Interval jumps');
    expect(tieNumerals('Free vibrato')).toBe('Free vibrato');
    expect(tieNumerals('Vibrato meter')).toBe('Vibrato meter');
    expect(tieNumerals('Sirens & glides')).toBe('Sirens & glides');
    expect(tieNumerals('Intentional scoop')).toBe('Intentional scoop');
  });
});
