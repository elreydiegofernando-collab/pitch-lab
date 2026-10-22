/**
 * Momentum (SPEC §12): a slow-moving 0..100 practice score that replaces a daily streak. It is
 * recomputed from the whole attempt log plus `now` every time, so it needs no stored state and
 * is deterministic.
 *
 * The model (all knobs in MOMENTUM_KNOBS):
 *  - Practice days grow it by a SATURATING amount: more minutes help with diminishing returns
 *    (1 - 2^(-minutes/halfMinutes)), and each day closes only a fraction (`gainRate`) of the gap
 *    to `max`, so it can never overshoot.
 *  - Rest is healthy: the first `restGraceDays` idle days in a row cost nothing, and returning
 *    after 1..`recoveryMaxIdleDays` idle days earns a small bonus on that day's gain.
 *  - Longer breaks decay it SLOWLY (`decayPerDay` of the distance above the floor per extra idle
 *    day), toward a floor that is always > 0. It never hard-resets: once you have practiced,
 *    momentum is never below `floor`, however long the break.
 *  - Today is not an idle day until it is over.
 *
 * Before any practice there is nothing to decay, so the value is 0. Days are UTC calendar days
 * shifted by an optional fixed offset (see time.ts); attempts dated after `now` count as today.
 *
 * CONTRACT GAP: src/config.ts has no `momentum` section, so MOMENTUM_KNOBS are local PROVISIONAL
 * knobs (proposed CONFIG.momentum); every function accepts `knobs` so tests and tuning need no edit.
 */
import { clamp } from '../core/math';
import type { AttemptRecord } from '../storage/schema';
import type { LoggedAttempt } from './log';
import { logged } from './log';
import type { TimeInput } from './time';
import { dayIndexOf, dayKeyOf, requireMs } from './time';

export interface MomentumKnobs {
  /** Lowest value once the singer has practiced at all (> 0: never a hard reset). */
  floor: number;
  max: number;
  /** Minutes in one day that earn half of the maximum daily gain. */
  halfMinutes: number;
  /** Largest fraction of the remaining gap to `max` that one day can close. */
  gainRate: number;
  /** Idle days in a row that cost nothing (rest is healthy). */
  restGraceDays: number;
  /** Fraction of the distance above the floor lost per idle day beyond the grace. */
  decayPerDay: number;
  /** Extra share of the day's gain when practice resumes after a rest. */
  recoveryBonus: number;
  /** The recovery bonus applies after 1..this many idle days. */
  recoveryMaxIdleDays: number;
}

/** PROVISIONAL tuning: ~a month of 10 daily minutes reaches ~70; a month away from there lands ~35; a year away ~floor. */
export const MOMENTUM_KNOBS: Readonly<MomentumKnobs> = {
  floor: 8,
  max: 100,
  halfMinutes: 8,
  gainRate: 0.07,
  restGraceDays: 3,
  decayPerDay: 0.03,
  recoveryBonus: 0.25,
  recoveryMaxIdleDays: 3,
};

export interface MomentumOptions {
  /** Minutes east of UTC that define a calendar day (default 0 = UTC). */
  utcOffsetMinutes?: number;
  knobs?: Partial<MomentumKnobs>;
}

/** One calendar day of the momentum curve: the value shown on that day and the minutes sung that day. */
export interface MomentumPoint {
  day: string;
  momentum: number;
  minutes: number;
}

export interface PracticeDay {
  dayIndex: number;
  minutes: number;
}

function minutesOf(a: AttemptRecord): number {
  const sec = a.durationSec;
  return typeof sec === 'number' && Number.isFinite(sec) && sec > 0 ? sec / 60 : 0;
}

/**
 * Practice minutes per calendar day (days with no sung time are left out), oldest first. Attempts
 * dated after `todayIndex` count as that day. Attempts with an unparsable time are skipped.
 */
export function practiceDaysOf(log: readonly LoggedAttempt[], todayIndex: number, utcOffsetMinutes = 0): PracticeDay[] {
  const byDay = new Map<number, number>();
  for (const { a, ms } of log) {
    const minutes = minutesOf(a);
    if (ms === null || minutes <= 0) continue;
    const day = Math.min(dayIndexOf(ms, utcOffsetMinutes), todayIndex);
    byDay.set(day, (byDay.get(day) ?? 0) + minutes);
  }
  return [...byDay].map(([dayIndex, minutes]) => ({ dayIndex, minutes })).sort((x, y) => x.dayIndex - y.dayIndex);
}

/** Practice minutes per "YYYY-MM-DD" (soft-deleted attempts excluded), for the dashboard's practice-time chart. */
export function practiceMinutesByDay(attempts: readonly AttemptRecord[], utcOffsetMinutes = 0): Map<string, number> {
  const byDay = new Map<string, number>();
  for (const a of attempts) {
    if (a.deletedAt != null) continue;
    const { ms } = logged(a);
    const minutes = minutesOf(a);
    if (ms === null || minutes <= 0) continue;
    const key = dayKeyOf(dayIndexOf(ms, utcOffsetMinutes));
    byDay.set(key, (byDay.get(key) ?? 0) + minutes);
  }
  return byDay;
}

/** `momentum` after `idleDays` completed idle days: free during the grace, then slow decay toward the floor. */
function decayed(momentum: number, idleDays: number, k: MomentumKnobs): number {
  const excess = idleDays - k.restGraceDays;
  if (excess <= 0 || momentum <= k.floor) return momentum;
  return k.floor + (momentum - k.floor) * Math.pow(1 - k.decayPerDay, excess);
}

/** Fraction of the day's maximum gain earned by `minutes` (saturating, < 1). */
function saturate(minutes: number, k: MomentumKnobs): number {
  return 1 - Math.pow(2, -minutes / Math.max(k.halfMinutes, 1e-9));
}

function run(days: readonly PracticeDay[], todayIndex: number, k: MomentumKnobs, wantPoints: boolean): { value: number; points: MomentumPoint[] } {
  const points: MomentumPoint[] = [];
  if (days.length === 0) return { value: 0, points };
  let m = 0;
  let prev = days[0].dayIndex;
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    let boost = 1;
    if (i === 0) {
      m = k.floor;
    } else {
      const idle = d.dayIndex - prev - 1;
      if (wantPoints) for (let j = 1; j <= idle; j++) points.push({ day: dayKeyOf(prev + j), momentum: decayed(m, j - 1, k), minutes: 0 });
      m = decayed(m, idle, k);
      if (idle >= 1 && idle <= k.recoveryMaxIdleDays) boost = 1 + k.recoveryBonus;
    }
    m = clamp(m + (k.max - m) * k.gainRate * saturate(d.minutes, k) * boost, k.floor, k.max);
    if (wantPoints) points.push({ day: dayKeyOf(d.dayIndex), momentum: m, minutes: d.minutes });
    prev = d.dayIndex;
  }
  if (wantPoints) for (let j = 1; prev + j <= todayIndex; j++) points.push({ day: dayKeyOf(prev + j), momentum: decayed(m, j - 1, k), minutes: 0 });
  return { value: decayed(m, Math.max(0, todayIndex - prev - 1), k), points };
}

/** Momentum from an already-replayed log (engine.ts). */
export function momentumFromLog(log: readonly LoggedAttempt[], nowMs: number, utcOffsetMinutes = 0, knobs?: Partial<MomentumKnobs>): number {
  const today = dayIndexOf(nowMs, utcOffsetMinutes);
  return run(practiceDaysOf(log, today, utcOffsetMinutes), today, { ...MOMENTUM_KNOBS, ...knobs }, false).value;
}

/** Momentum of ONE profile's attempts at `now` (soft-deleted attempts are ignored). */
export function computeMomentum(attempts: readonly AttemptRecord[], now: TimeInput, options: MomentumOptions = {}): number {
  return momentumFromLog(liveLog(attempts), requireMs(now, 'computeMomentum: now'), options.utcOffsetMinutes ?? 0, options.knobs);
}

/**
 * The momentum curve, one point per calendar day from the first practice day to today (the last
 * point equals computeMomentum). `lastDays` keeps only the most recent N days (a 30-day sparkline).
 */
export function momentumTimeline(attempts: readonly AttemptRecord[], now: TimeInput, options: MomentumOptions & { lastDays?: number } = {}): MomentumPoint[] {
  const offset = options.utcOffsetMinutes ?? 0;
  const today = dayIndexOf(requireMs(now, 'momentumTimeline: now'), offset);
  const { points } = run(practiceDaysOf(liveLog(attempts), today, offset), today, { ...MOMENTUM_KNOBS, ...options.knobs }, true);
  const n = options.lastDays;
  return n !== undefined && n >= 0 && n < points.length ? points.slice(points.length - Math.floor(n)) : points;
}

function liveLog(attempts: readonly AttemptRecord[]): LoggedAttempt[] {
  const out: LoggedAttempt[] = [];
  for (const a of attempts) if (a.deletedAt == null) out.push(logged(a));
  return out;
}
