/** The 7-day mini bar row of the Momentum chip (docs/DESIGN.md 13.1): one bar per calendar day, today last. */
import { momentumTimeline } from '../../progress';
import type { AttemptRecord } from '../../storage/schema';

const BAR_DAYS = 7;

export interface MomentumBar {
  /** Momentum that day as a share of its 0..100 scale. */
  level: number;
  /** Something was sung that day; otherwise it was a rest day (which momentum treats as healthy). */
  practiced: boolean;
}

/**
 * The last 7 days, oldest first. Days before the first practice have no value yet (null), so a new singer sees a short
 * row, not a row of zeros. `utcOffsetMinutes` makes days local.
 */
export function momentumBars(attempts: readonly AttemptRecord[], now: number | Date, utcOffsetMinutes: number): Array<MomentumBar | null> {
  const points = momentumTimeline(attempts, now, { lastDays: BAR_DAYS, utcOffsetMinutes });
  const bars = points.map((p): MomentumBar => ({ level: Math.max(0, Math.min(1, p.momentum / 100)), practiced: p.minutes > 0 }));
  const missing = Math.max(0, BAR_DAYS - bars.length);
  return [...Array<null>(missing).fill(null), ...bars];
}

/** What a screen reader gets in place of the bars: how many of the days the singer practiced ("" before there are two). */
export function practiceSummary(bars: ReadonlyArray<MomentumBar | null>): string {
  const known = bars.filter((b): b is MomentumBar => b !== null);
  if (known.length < 2) return '';
  return `Practiced ${known.filter((b) => b.practiced).length} of the last ${known.length} days.`;
}

/** Local calendar days: minutes east of UTC for this device right now. */
export function localUtcOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}
