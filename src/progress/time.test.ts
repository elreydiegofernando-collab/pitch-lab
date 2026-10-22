import { describe, expect, it } from 'vitest';
import { MS_PER_DAY, dayIndexOf, dayKeyOf, requireMs, toMs } from './time';

describe('time helpers', () => {
  it('reads a Date, epoch milliseconds or an ISO string', () => {
    const iso = '2026-03-01T12:00:00.000Z';
    const ms = Date.parse(iso);
    expect(toMs(new Date(iso))).toBe(ms);
    expect(toMs(ms)).toBe(ms);
    expect(toMs(iso)).toBe(ms);
    expect(toMs('garbage')).toBeNaN();
  });

  it('requireMs throws a RangeError naming what was wrong', () => {
    expect(requireMs('2026-03-01T00:00:00Z', 'x')).toBe(Date.parse('2026-03-01T00:00:00Z'));
    expect(() => requireMs('nope', 'my-arg')).toThrow(/my-arg/);
    expect(() => requireMs(NaN, 'x')).toThrow(RangeError);
    expect(() => requireMs(new Date('bad'), 'x')).toThrow(RangeError);
  });

  it('buckets by UTC day, shifted by a fixed offset east of UTC', () => {
    const lateEvening = Date.parse('2026-03-01T23:30:00.000Z');
    expect(dayKeyOf(dayIndexOf(lateEvening))).toBe('2026-03-01');
    expect(dayKeyOf(dayIndexOf(lateEvening, 60))).toBe('2026-03-02');
    expect(dayKeyOf(dayIndexOf(lateEvening, -24 * 60))).toBe('2026-02-28');
    expect(dayIndexOf(Date.parse('2026-03-02T00:00:00.000Z')) - dayIndexOf(Date.parse('2026-03-01T23:59:59.999Z'))).toBe(1);
  });

  it('turns a day index into a calendar key and back', () => {
    const idx = dayIndexOf(Date.parse('2026-12-31T08:00:00.000Z'));
    expect(dayKeyOf(idx)).toBe('2026-12-31');
    expect(dayKeyOf(idx + 1)).toBe('2027-01-01');
    expect(dayIndexOf(idx * MS_PER_DAY)).toBe(idx);
    expect(dayKeyOf(0)).toBe('1970-01-01');
  });
});
