import { describe, expect, it } from 'vitest';
import { MOMENTUM_KNOBS, computeMomentum, momentumTimeline, practiceMinutesByDay } from './momentum';
import { attempt, at, deepFreeze } from './test-fixtures';

const K = MOMENTUM_KNOBS;
/** One practice session `minutes` long on day `n` (n days after the base day, midday UTC). */
const session = (n: number, minutes: number, extra: Parameters<typeof attempt>[0] = {}) => attempt({ createdAt: at(n), durationSec: minutes * 60, ...extra });
const m = (attempts: ReturnType<typeof attempt>[], dayNow: number) => computeMomentum(attempts, at(dayNow, 20));

describe('computeMomentum: growth', () => {
  it('is 0 before any practice (nothing to decay yet)', () => {
    expect(m([], 0)).toBe(0);
    expect(m([session(0, 0)], 0)).toBe(0); // a row with no sung time is not practice
  });

  it('a first session lifts it above the floor by the saturating gain', () => {
    const expected = K.floor + (K.max - K.floor) * K.gainRate * (1 - Math.pow(2, -10 / K.halfMinutes));
    expect(m([session(0, 10)], 0)).toBeCloseTo(expected, 9);
  });

  it('grows with minutes but with diminishing returns, and one day can never pass its ceiling', () => {
    const minutes = [1, 5, 10, 20, 60, 600];
    const values = minutes.map((x) => m([session(0, x)], 0));
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1]);
    // Each extra minute is worth less than the one before it.
    const perMinute = (i: number) => (values[i] - values[i - 1]) / (minutes[i] - minutes[i - 1]);
    for (let i = 2; i < values.length; i++) expect(perMinute(i)).toBeLessThan(perMinute(i - 1));
    expect(values[5] - values[4]).toBeLessThan(0.1); // 60 -> 600 minutes adds almost nothing
    expect(values[5]).toBeLessThanOrEqual(K.floor + (K.max - K.floor) * K.gainRate + 1e-9);
  });

  it('adds same-day attempts together', () => {
    expect(m([session(0, 5), session(0, 5)], 0)).toBeCloseTo(m([session(0, 10)], 0), 9);
  });

  it('builds slowly toward, and never past, the maximum', () => {
    const daily = (days: number, minutes: number) => m(Array.from({ length: days }, (_, i) => session(i, minutes)), days - 1);
    expect(daily(7, 10)).toBeGreaterThan(20);
    expect(daily(7, 10)).toBeLessThan(45);
    expect(daily(30, 10)).toBeGreaterThan(60);
    expect(daily(30, 10)).toBeLessThan(85);
    expect(daily(365, 30)).toBeLessThanOrEqual(K.max);
    expect(daily(365, 30)).toBeGreaterThan(95);
    expect(daily(30, 20)).toBeGreaterThan(daily(30, 10));
  });

  it('ignores zero, negative and non-finite durations', () => {
    expect(m([session(0, -5), attempt({ createdAt: at(0), durationSec: NaN })], 0)).toBe(0);
  });
});

describe('computeMomentum: the floor, and no hard reset', () => {
  it('never drops below the floor once the singer has practiced at all, however long the break', () => {
    const tiny = [attempt({ createdAt: at(0), durationSec: 1 })];
    expect(m(tiny, 0)).toBeGreaterThanOrEqual(K.floor);
    const built = Array.from({ length: 60 }, (_, i) => session(i, 15));
    for (const away of [5, 30, 365, 3650, 100000]) {
      expect(m(built, 59 + away)).toBeGreaterThanOrEqual(K.floor);
      expect(m(built, 59 + away)).toBeGreaterThan(0);
    }
    expect(m(built, 59 + 3650)).toBeCloseTo(K.floor, 6);
  });

  it('decays slowly: never in one jump, and a month away keeps a large share', () => {
    const built = Array.from({ length: 60 }, (_, i) => session(i, 15));
    const atEnd = m(built, 59);
    const curve = Array.from({ length: 60 }, (_, d) => m(built, 59 + d));
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]).toBeLessThanOrEqual(curve[i - 1] + 1e-12);
      expect(curve[i - 1] - curve[i]).toBeLessThanOrEqual(K.decayPerDay * (curve[i - 1] - K.floor) + 1e-9);
    }
    expect(m(built, 59 + 30)).toBeGreaterThan(0.4 * atEnd);
    expect(m(built, 59 + 30)).toBeLessThan(atEnd);
  });
});

describe('computeMomentum: rest is healthy', () => {
  it('holds steady through the rest days, then decays from the day after the grace', () => {
    const one = [session(0, 20)];
    const base = m(one, 0);
    for (let d = 1; d <= K.restGraceDays + 1; d++) expect(m(one, d)).toBeCloseTo(base, 12); // today is not idle until it is over
    expect(m(one, K.restGraceDays + 2)).toBeLessThan(base);
  });

  it('a 1-3 day rest between sessions never costs ground, and earns a small bonus', () => {
    const backToBack = m([session(0, 15), session(1, 15)], 1);
    for (const rest of [1, 2, 3]) {
      const rested = m([session(0, 15), session(1 + rest, 15)], 1 + rest);
      expect(rested).toBeGreaterThan(backToBack);
    }
  });

  it('...even from well-built momentum, where a decaying rest would show', () => {
    const built = Array.from({ length: 30 }, (_, i) => session(i, 15)); // days 0..29
    const next = m([...built, session(30, 15)], 30);
    expect(m(built, 29)).toBeGreaterThan(50);
    for (const rest of [1, 2, 3]) expect(m([...built, session(30 + rest, 15)], 30 + rest)).toBeGreaterThan(next);
    expect(m([...built, session(34, 15)], 34)).toBeLessThan(m([...built, session(33, 15)], 33)); // 4 idle days: the grace is spent
  });

  it('the recovery bonus is small: well under the day\'s own gain', () => {
    const withBonus = m([session(0, 15), session(2, 15)], 2);
    const withoutBonus = computeMomentum([session(0, 15), session(2, 15)], at(2, 20), { knobs: { recoveryBonus: 0 } });
    const gainWithout = withoutBonus - m([session(0, 15)], 0);
    expect(withBonus).toBeGreaterThan(withoutBonus);
    expect(withBonus - withoutBonus).toBeLessThan(0.5 * gainWithout);
  });

  it('a longer break loses ground and earns no bonus', () => {
    const rest3 = m([session(0, 15), session(4, 15)], 4);
    const gap4 = m([session(0, 15), session(5, 15)], 5);
    const gap10 = m([session(0, 15), session(11, 15)], 11);
    expect(gap4).toBeLessThan(rest3);
    expect(gap10).toBeLessThan(gap4);
  });

  it('practicing every other day beats not practicing, and daily beats every other day', () => {
    const daily = Array.from({ length: 20 }, (_, i) => session(i, 10));
    const alternate = Array.from({ length: 10 }, (_, i) => session(i * 2, 10));
    expect(m(daily, 19)).toBeGreaterThan(m(alternate, 19));
    expect(m(alternate, 19)).toBeGreaterThan(m([], 19));
  });

  it('honours the literal "decay every idle day" setting through the knobs', () => {
    const strict = (day: number) => computeMomentum([session(0, 20)], at(day, 20), { knobs: { restGraceDays: 0 } });
    expect(strict(1)).toBe(strict(0)); // today is not idle until it is over
    expect(strict(2)).toBeLessThan(strict(1)); // the first completed idle day already costs something
    expect(strict(3)).toBeLessThan(strict(2));
  });
});

describe('computeMomentum: determinism and inputs', () => {
  const attempts = [session(0, 5), session(2, 15), session(10, 1), session(11, 30)];

  it('is the same for any input order, and does not mutate its inputs', () => {
    const a = m(attempts, 20);
    expect(m([...attempts].reverse(), 20)).toBe(a);
    expect(() => computeMomentum(deepFreeze(attempts.map((x) => ({ ...x }))), at(20))).not.toThrow();
  });

  it('accepts a Date, epoch milliseconds or an ISO string for now', () => {
    const iso = at(20, 20);
    expect(computeMomentum(attempts, new Date(iso))).toBe(computeMomentum(attempts, Date.parse(iso)));
    expect(computeMomentum(attempts, iso)).toBe(computeMomentum(attempts, Date.parse(iso)));
    expect(() => computeMomentum(attempts, 'tomorrow')).toThrow(RangeError);
  });

  it('ignores soft-deleted attempts', () => {
    expect(m([session(0, 15), session(1, 15, { deletedAt: at(2) })], 1)).toBe(m([session(0, 15)], 1));
  });

  it('counts an attempt dated after now as today (a clock set backwards cannot erase effort)', () => {
    expect(m([session(100, 15)], 5)).toBeCloseTo(m([session(5, 15)], 5), 9);
    expect(m([session(100, 15)], 5)).toBeGreaterThan(0);
  });

  it('draws days in the requested offset: a late-evening session lands on the next local day', () => {
    const late = attempt({ createdAt: '2026-03-01T23:30:00.000Z', durationSec: 600 });
    const early = attempt({ createdAt: '2026-03-02T00:30:00.000Z', durationSec: 600 });
    expect([...practiceMinutesByDay([late, early]).keys()]).toEqual(['2026-03-01', '2026-03-02']);
    expect([...practiceMinutesByDay([late, early], 60).keys()]).toEqual(['2026-03-02']);
    expect(practiceMinutesByDay([late, early], 60).get('2026-03-02')).toBeCloseTo(20, 9);
  });
});

describe('practiceMinutesByDay', () => {
  it('sums sung minutes per day, leaving out deleted rows and rows with no sung time', () => {
    const map = practiceMinutesByDay([session(0, 10), session(0, 5), session(1, 20, { deletedAt: at(3) }), session(2, 0), session(3, 7)]);
    expect([...map.entries()].map(([k, v]) => [k, Math.round(v)])).toEqual([
      ['2026-03-01', 15],
      ['2026-03-04', 7],
    ]);
  });
});

describe('momentumTimeline', () => {
  const attempts = [session(0, 15), session(1, 15), session(5, 15)];

  it('has one point per day from the first practice day to today, ending at the current value', () => {
    const tl = momentumTimeline(attempts, at(8, 20));
    expect(tl).toHaveLength(9);
    expect(tl[0].day).toBe('2026-03-01');
    expect(tl[8].day).toBe('2026-03-09');
    expect(tl[8].momentum).toBeCloseTo(m(attempts, 8), 12);
    expect(tl.map((p) => p.minutes > 0)).toEqual([true, true, false, false, false, true, false, false, false]);
    for (const p of tl) {
      expect(p.momentum).toBeGreaterThanOrEqual(K.floor);
      expect(p.momentum).toBeLessThanOrEqual(K.max);
    }
  });

  it('is flat through the rest days, then drifts down', () => {
    const tl = momentumTimeline([session(0, 15)], at(10, 20));
    for (let i = 1; i <= K.restGraceDays + 1; i++) expect(tl[i].momentum).toBeCloseTo(tl[0].momentum, 12);
    expect(tl[K.restGraceDays + 2].momentum).toBeLessThan(tl[0].momentum);
    expect(tl[10].momentum).toBeLessThan(tl[K.restGraceDays + 2].momentum);
  });

  it('can be limited to the most recent days, and is empty with no practice', () => {
    expect(momentumTimeline(attempts, at(8, 20), { lastDays: 3 }).map((p) => p.day)).toEqual(['2026-03-07', '2026-03-08', '2026-03-09']);
    expect(momentumTimeline(attempts, at(8, 20), { lastDays: 0 })).toEqual([]);
    expect(momentumTimeline(attempts, at(8, 20), { lastDays: 99 })).toHaveLength(9);
    expect(momentumTimeline([], at(8))).toEqual([]);
  });
});
