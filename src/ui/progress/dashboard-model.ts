/**
 * Everything the progress dashboard shows, computed from the attempt log and the progress snapshot (SPEC §12,
 * DESIGN.md §13.10). Pure: the screen passes the signals' values and a clock, and gets plain data back.
 *
 * Honest by construction: every number is derived from the log (never from a cached figure of its own), skills
 * and personal bests appear only when the registry has opened them, and a chart's data is exactly what its
 * "Show as table" view lists.
 */
import type { MetricKey } from '../../analysis/types';
import { METRIC_INFO, formatMetric } from '../../exercises';
import type { LevelDef, WorldDef } from '../../exercises/types';
import {
  computeMomentum,
  currentLevelOf,
  dayIndexOf,
  dayKeyOf,
  isFeatureUnlocked,
  isWorldUnlocked,
  momentumTimeline,
  practiceMinutesByDay,
  recordsForExercise,
  type Mastery,
  type MomentumPoint,
  type ProgressSnapshot,
} from '../../progress';
import type { AttemptRecord } from '../../storage/schema';
import { unlockedSkills, skillTrend, type SkillTrend } from './skills';

/** Days of Momentum the dashboard draws. */
const MOMENTUM_DAYS = 30;

// ---------------------------------------------------------------- momentum

export interface MomentumView {
  /** Today's Momentum, 0..100 (the caller rounds it for display). */
  value: number;
  /** Exactly MOMENTUM_DAYS slots, oldest first; null before the first practice day. */
  slots: Array<MomentumPoint | null>;
  /** Whole points gained (negative: lost) since a week ago; null with under a week of history. */
  deltaWeek: number | null;
}

export function momentumView(attempts: readonly AttemptRecord[], now: number, utcOffsetMinutes: number): MomentumView {
  const points = momentumTimeline(attempts, now, { utcOffsetMinutes, lastDays: MOMENTUM_DAYS });
  const empty = Math.max(0, MOMENTUM_DAYS - points.length);
  const slots: Array<MomentumPoint | null> = [...Array.from({ length: empty }, () => null), ...points];
  const deltaWeek = points.length >= 8 ? Math.round(points[points.length - 1].momentum) - Math.round(points[points.length - 8].momentum) : null;
  return { value: computeMomentum(attempts, now, { utcOffsetMinutes }), slots, deltaWeek };
}

// ---------------------------------------------------------------- level map completion

export interface WorldCompletion {
  world: WorldDef;
  passed: number;
  total: number;
  /** The level in progress; null once the whole world is passed. */
  next: LevelDef | null;
}

/** One entry per OPEN world that has levels (Song Stage has none), in world order. */
export function worldCompletion(snapshot: ProgressSnapshot, worlds: readonly WorldDef[]): WorldCompletion[] {
  const out: WorldCompletion[] = [];
  for (const world of worlds) {
    if (world.levels.length === 0 || !isWorldUnlocked(world.id, snapshot)) continue;
    const passed = world.levels.filter((l) => snapshot.levels[l.id]?.status === 'passed').length;
    out.push({ world, passed, total: world.levels.length, next: currentLevelOf(world.id, snapshot, worlds) });
  }
  return out;
}

/** The first training world that is still shut: the dashboard shows what opens it, as a locked line. */
export function nextLockedWorld(snapshot: ProgressSnapshot, worlds: readonly WorldDef[]): WorldDef | null {
  return worlds.find((w) => w.levels.length > 0 && !isWorldUnlocked(w.id, snapshot)) ?? null;
}

/** "5 of 8 levels · Boss Recital next". */
export function completionText(c: WorldCompletion): string {
  const base = `${c.passed} of ${c.total} levels`;
  if (c.next === null) return `${base} · Complete`;
  return c.next.kind === 'boss' ? `${base} · Boss Recital next` : `${base} · Next: ${c.next.title}`;
}

// ---------------------------------------------------------------- range

export interface RangePoint {
  dayIndex: number;
  dayKey: string;
  /** Semitones between the lowest and highest notes held cleanly (the Range finder's `range.spanSemitones`). */
  span: number;
}

/**
 * The Range finder's measured span, one point per day (the widest that day), oldest first. An attempt stores the
 * span, not the two notes, so the band's width over time is what the log can honestly tell.
 */
export function rangeSpans(attempts: readonly AttemptRecord[], utcOffsetMinutes: number): RangePoint[] {
  const byDay = new Map<number, number>();
  for (const a of attempts) {
    if (a.deletedAt != null) continue;
    const span = a.metrics?.['range.spanSemitones'];
    const ms = Date.parse(a.createdAt);
    if (typeof span !== 'number' || !Number.isFinite(span) || !Number.isFinite(ms)) continue;
    const day = dayIndexOf(ms, utcOffsetMinutes);
    byDay.set(day, Math.max(byDay.get(day) ?? 0, span));
  }
  return [...byDay].sort((a, b) => a[0] - b[0]).map(([dayIndex, span]) => ({ dayIndex, dayKey: dayKeyOf(dayIndex), span }));
}

// ---------------------------------------------------------------- personal bests

export interface BestMetric {
  metric: MetricKey;
  label: string;
  /** "92%", "8¢", "210 ms" */
  text: string;
}

export interface BestRow {
  level: LevelDef;
  world: WorldDef;
  /** The level's best overall score, 0..1. */
  bestScore: number;
  mastery: Mastery;
  metrics: BestMetric[];
  /** When the most recent of these records was set. */
  latestAt: string;
}

function isMetricKey(metric: string): metric is MetricKey {
  return Object.prototype.hasOwnProperty.call(METRIC_INFO, metric);
}

/**
 * The records of every level that has any (from passed takes only), most recently improved first. A record
 * belongs to an exercise, and an exercise to a level, so a locked level can never show one.
 */
export function personalBests(snapshot: ProgressSnapshot, worlds: readonly WorldDef[]): BestRow[] {
  const found: Array<{ row: BestRow; at: number; order: number }> = [];
  let order = 0;
  for (const world of worlds) {
    for (const level of [...world.levels].sort((a, b) => a.index - b.index)) {
      order += 1;
      const progress = snapshot.levels[level.id];
      if (!progress || progress.status === 'locked') continue;
      const records = recordsForExercise(snapshot, level.exerciseId).filter((r): r is typeof r & { metric: MetricKey } => isMetricKey(r.metric));
      if (records.length === 0) continue;
      let latestAt = records[0].at;
      for (const r of records) if (Date.parse(r.at) > Date.parse(latestAt)) latestAt = r.at;
      const row: BestRow = {
        level,
        world,
        bestScore: progress.bestScore,
        mastery: progress.mastery,
        metrics: records.map((r) => ({ metric: r.metric, label: METRIC_INFO[r.metric].label, text: formatMetric(r.metric, r.value) })),
        latestAt,
      };
      found.push({ row, at: Date.parse(latestAt) || 0, order });
    }
  }
  return found.sort((a, b) => b.at - a.at || a.order - b.order).map((f) => f.row);
}

// ---------------------------------------------------------------- practice time

export interface PracticeWeeks {
  /** The last 14 days, oldest first. */
  days: Array<{ dayKey: string; minutes: number }>;
  /** Minutes sung in the last 7 days (today included). */
  recent: number;
  /** Minutes sung in the 7 days before those. */
  before: number;
}

/**
 * Rolling weeks, so the two always cover seven days each: a calendar week that is only a day old would look like a
 * collapse next to a finished one.
 */
export function practiceWeeks(attempts: readonly AttemptRecord[], todayIndex: number, utcOffsetMinutes: number): PracticeWeeks {
  const byDay = practiceMinutesByDay(attempts, utcOffsetMinutes);
  const days: PracticeWeeks['days'] = [];
  for (let i = 13; i >= 0; i--) {
    const dayKey = dayKeyOf(todayIndex - i);
    days.push({ dayKey, minutes: byDay.get(dayKey) ?? 0 });
  }
  const sum = (from: number, to: number): number => days.slice(from, to).reduce((total, d) => total + d.minutes, 0);
  return { days, before: sum(0, 7), recent: sum(7, 14) };
}

// ---------------------------------------------------------------- the whole dashboard

export interface DashboardInput {
  attempts: readonly AttemptRecord[];
  snapshot: ProgressSnapshot;
  worlds: readonly WorldDef[];
  /** Epoch milliseconds. */
  now: number;
  /** Minutes east of UTC that define a calendar day: the same offset the session used for the snapshot. */
  utcOffsetMinutes: number;
}

export interface DashboardModel {
  todayIndex: number;
  momentum: MomentumView;
  completion: WorldCompletion[];
  nextLocked: WorldDef | null;
  /** Unlocked skills only, in dashboard order. */
  skills: SkillTrend[];
  range: RangePoint[];
  /** Null while Personal records is locked. */
  bests: BestRow[] | null;
  practice: PracticeWeeks;
}

export function buildDashboard(input: DashboardInput): DashboardModel {
  const { attempts, snapshot, worlds, now, utcOffsetMinutes } = input;
  const todayIndex = dayIndexOf(now, utcOffsetMinutes);
  return {
    todayIndex,
    momentum: momentumView(attempts, now, utcOffsetMinutes),
    completion: worldCompletion(snapshot, worlds),
    nextLocked: nextLockedWorld(snapshot, worlds),
    skills: unlockedSkills(snapshot).map((s) => skillTrend(s, attempts, todayIndex, utcOffsetMinutes)),
    range: rangeSpans(attempts, utcOffsetMinutes),
    bests: isFeatureUnlocked('records', snapshot) ? personalBests(snapshot, worlds) : null,
    practice: practiceWeeks(attempts, todayIndex, utcOffsetMinutes),
  };
}
