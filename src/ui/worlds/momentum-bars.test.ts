import { describe, expect, it } from 'vitest';
import { computeMomentum } from '../../progress';
import { at, attempt } from '../../progress/test-fixtures';
import { localUtcOffsetMinutes, momentumBars, practiceSummary, type MomentumBar } from './momentum-bars';

/** Today is day 0 at noon UTC. */
const NOW = Date.parse(at(0));

const sung = (days: number, minutes = 10) => attempt({ createdAt: at(days), durationSec: minutes * 60 });
const known = (bars: ReadonlyArray<MomentumBar | null>): MomentumBar[] => bars.filter((b): b is MomentumBar => b !== null);

describe('momentumBars', () => {
  it('is seven slots, today last', () => {
    expect(momentumBars([sung(0)], NOW, 0)).toHaveLength(7);
    expect(momentumBars([sung(-20), sung(0)], NOW, 0)).toHaveLength(7);
  });

  it('leaves the days before the first practice empty, so a new singer sees a short row', () => {
    const bars = momentumBars([sung(-2)], NOW, 0);
    expect(bars.slice(0, 4)).toEqual([null, null, null, null]);
    expect(bars.slice(4).every((b) => b !== null)).toBe(true);
  });

  it('is all empty before any practice', () => {
    expect(momentumBars([], NOW, 0)).toEqual(Array(7).fill(null));
  });

  it("ends on today's momentum, as a share of 0..100", () => {
    const log = [sung(-3), sung(-2), sung(-1), sung(0)];
    const bars = momentumBars(log, NOW, 0);
    expect(bars[6]?.level).toBeCloseTo(computeMomentum(log, NOW) / 100, 6);
    for (const b of known(bars)) expect(b.level).toBeGreaterThan(0);
  });

  it('marks the days something was sung and the rest days between', () => {
    const bars = momentumBars([sung(-5), sung(-3), sung(-2), sung(0)], NOW, 0);
    expect(bars.map((b) => b?.practiced)).toEqual([undefined, true, false, true, true, false, true]);
  });

  it('rises with practice and eases down over rest days without dropping to zero', () => {
    const log = [sung(-14), sung(-13), sung(-12), sung(-11), sung(-10)];
    const bars = known(momentumBars(log, NOW, 0));
    expect(bars).toHaveLength(7);
    expect(bars.every((b) => !b.practiced)).toBe(true);
    for (let i = 1; i < bars.length; i++) expect(bars[i].level).toBeLessThanOrEqual(bars[i - 1].level);
    expect(bars[bars.length - 1].level).toBeGreaterThan(0);
  });

  it('keeps every value inside 0..1', () => {
    const log = Array.from({ length: 40 }, (_, i) => sung(-i, 60));
    for (const b of known(momentumBars(log, NOW, 0))) {
      expect(b.level).toBeGreaterThanOrEqual(0);
      expect(b.level).toBeLessThanOrEqual(1);
    }
  });

  it('counts days in the local time zone it is given', () => {
    // 23:30 UTC on day -1 is already day 0 for a singer 2 hours east.
    const late = attempt({ createdAt: at(-1, 23).replace(':00:00', ':30:00'), durationSec: 600 });
    expect(known(momentumBars([late], NOW, 0))).toHaveLength(2);
    expect(known(momentumBars([late], NOW, 120))).toHaveLength(1);
  });
});

describe('practiceSummary', () => {
  it('says how many of the days were practiced', () => {
    const bars = momentumBars([sung(-5), sung(-3), sung(-2), sung(0)], NOW, 0);
    expect(practiceSummary(bars)).toBe('Practiced 4 of the last 6 days.');
  });

  it('says nothing until there are two days to compare', () => {
    expect(practiceSummary(momentumBars([sung(0)], NOW, 0))).toBe('');
    expect(practiceSummary(momentumBars([], NOW, 0))).toBe('');
  });
});

describe('localUtcOffsetMinutes', () => {
  it('is minutes east of UTC for this device (the opposite sign of getTimezoneOffset)', () => {
    expect(localUtcOffsetMinutes()).toBe(-new Date().getTimezoneOffset());
  });
});
