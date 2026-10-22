/**
 * Calendar-day arithmetic for momentum, recency and "last practiced". Pure.
 *
 * A "day" is a UTC calendar day shifted by a fixed `utcOffsetMinutes` (default 0), so the same
 * log and the same `now` give the same answer on any machine. The UI may pass its own offset
 * (`-new Date().getTimezoneOffset()`) so days line up with the singer's evening.
 */

export const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;

/** A time as callers hold it: a Date, epoch milliseconds, or an ISO-8601 string. */
export type TimeInput = Date | number | string;

/** Epoch milliseconds of `t`; NaN when it is not a valid time. */
export function toMs(t: TimeInput): number {
  if (t instanceof Date) return t.getTime();
  if (typeof t === 'number') return t;
  return Date.parse(t);
}

/** Epoch milliseconds of `t`, or a RangeError naming `what` when it is not a valid time. */
export function requireMs(t: TimeInput, what: string): number {
  const ms = toMs(t);
  if (!Number.isFinite(ms)) throw new RangeError(`${what}: not a valid time (${String(t)})`);
  return ms;
}

/** Integer calendar-day index (days since 1970-01-01) of `ms` in a zone `utcOffsetMinutes` east of UTC. */
export function dayIndexOf(ms: number, utcOffsetMinutes = 0): number {
  return Math.floor((ms + utcOffsetMinutes * MS_PER_MINUTE) / MS_PER_DAY);
}

/** "YYYY-MM-DD" of a day index. */
export function dayKeyOf(dayIndex: number): string {
  return new Date(dayIndex * MS_PER_DAY).toISOString().slice(0, 10);
}
