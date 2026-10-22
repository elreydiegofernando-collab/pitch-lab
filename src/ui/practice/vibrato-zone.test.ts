import { describe, expect, it } from 'vitest';
import { extentRangeLabel, rateRangeLabel, viewZone, zoneInfo } from './vibrato-zone';

describe('the vibrato zone', () => {
  it('follows CONFIG.vibrato.styles for each style', () => {
    const pop = zoneInfo('pop');
    expect(pop.name).toBe('Pop');
    expect(rateRangeLabel(pop)).toBe('5–7 Hz');
    expect(extentRangeLabel(pop)).toBe('±20–60¢');
    const classical = zoneInfo('classical');
    expect(classical.name).toBe('Classical');
    expect(extentRangeLabel(classical)).toBe('±40–100¢');
  });

  it('gives the band the pitch view shades', () => {
    expect(viewZone('pop')).toEqual({ minExtentCents: 20, maxExtentCents: 60 });
    expect(viewZone('classical')).toEqual({ minExtentCents: 40, maxExtentCents: 100 });
  });

  it('falls back to pop for a style that is not in the set, rather than crashing', () => {
    const z = zoneInfo('operatic' as never);
    expect(z.style).toBe('pop');
    expect(z.name).toBe('Pop');
    expect(viewZone('operatic' as never)).toEqual({ minExtentCents: 20, maxExtentCents: 60 });
  });
});
