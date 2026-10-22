import { describe, expect, it } from 'vitest';
import type { VocalRange } from '../../storage/schema';
import {
  asLocalDay,
  errorText,
  formatBytes,
  formatClock,
  formatDayKey,
  formatMinutes,
  localDateStamp,
  plural,
  rangeLabel,
  squash,
  voiceTypeLabel,
} from './format';

describe('formatBytes', () => {
  it('reads sizes in the unit a person would say', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(3.4 * 1024)).toBe('3.4 KB');
    expect(formatBytes(12.3 * 1024 * 1024)).toBe('12.3 MB');
    expect(formatBytes(120 * 1024 * 1024)).toBe('120 MB');
    expect(formatBytes(1.2 * 1024 ** 3)).toBe('1.2 GB');
  });

  it('never prints 1024.0 of a unit', () => {
    expect(formatBytes(1024 * 1023.97)).toBe('1.0 MB');
  });

  it('shows a dash pair for what is unknown', () => {
    expect(formatBytes(null)).toBe('––');
    expect(formatBytes(undefined)).toBe('––');
    expect(formatBytes(Number.NaN)).toBe('––');
    expect(formatBytes(-1)).toBe('––');
  });
});

describe('formatMinutes and formatClock', () => {
  it('formats practice time', () => {
    expect(formatMinutes(0)).toBe('0 min');
    expect(formatMinutes(0.4)).toBe('<1 min');
    expect(formatMinutes(42.2)).toBe('42 min');
    expect(formatMinutes(60)).toBe('1 h');
    expect(formatMinutes(65)).toBe('1 h 05 min');
    expect(formatMinutes(Number.NaN)).toBe('0 min');
  });

  it('formats a take length as m:ss', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(9.6)).toBe('0:10');
    expect(formatClock(-3)).toBe('0:00');
  });
});

describe('dates', () => {
  it('formats a day key as the calendar day it names, whatever the time zone', () => {
    // Worded in the viewer's locale ("Oct 21", "21 Oct"), so only the day number is asserted.
    const day = formatDayKey('2026-10-21');
    expect(day).toContain('21');
    expect(day).not.toContain('2026');
    expect(formatDayKey('not a day')).toBe('not a day');
  });

  it('stamps a take with the singer\'s own local date', () => {
    const local = new Date(2026, 9, 21, 20, 30, 0); // 8:30 PM local on Oct 21: UTC may already be Oct 22
    expect(localDateStamp(local.toISOString())).toBe('2026-10-21');
    expect(localDateStamp(local)).toBe('2026-10-21');
    expect(localDateStamp('garbage')).toBe('unknown-date');
  });

  it('shifts a date so its UTC day is the local one (the backup file name is dated by UTC day)', () => {
    const local = new Date(2026, 9, 21, 20, 30, 0);
    expect(asLocalDay(local).toISOString().slice(0, 10)).toBe('2026-10-21');
  });
});

describe('small text helpers', () => {
  it('pluralizes', () => {
    expect(plural(1, 'profile')).toBe('1 profile');
    expect(plural(2, 'profile')).toBe('2 profiles');
    expect(plural(0, 'take')).toBe('0 takes');
    expect(plural(2, 'copy', 'copies')).toBe('2 copies');
  });

  it('turns whatever was thrown into a sentence', () => {
    expect(errorText(new Error('disk full'))).toBe('disk full');
    expect(errorText('plain')).toBe('plain');
    expect(errorText({})).toBe('Something went wrong.');
    expect(errorText(new Error(''))).toBe('Something went wrong.');
  });

  it('squashes whitespace for typed confirmations', () => {
    expect(squash('  Daniel \n  Reyes ')).toBe('Daniel Reyes');
  });

  it('names voice types and ranges', () => {
    expect(voiceTypeLabel('tenor')).toBe('Tenor');
    expect(voiceTypeLabel('unknown')).toBe('Not sure');
    const range: VocalRange = { comfortable: { low: 48, high: 69 }, extended: { low: 45, high: 72 }, measuredAt: '2026-10-01T00:00:00.000Z' };
    expect(rangeLabel(range, 'sharps')).toBe('C3–A4');
    expect(rangeLabel(null, 'sharps')).toBe('Range not measured');
  });
});
