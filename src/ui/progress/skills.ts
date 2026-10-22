/**
 * The eight skills the dashboard trends (SPEC §1, §12): Accuracy, Stability, Crispness, Transitions, Vibrato,
 * Inflections, Runs and Dynamics. Each reads ONE metric out of the attempt log (the metric the skill is best told
 * by), and appears only once the world that teaches it is unlocked (SPEC §11.1: locked skills are not shown at all).
 * Pure: everything comes from the log, the snapshot and a clock the caller passes in.
 */
import type { MetricKey } from '../../analysis/types';
import { CONFIG } from '../../config';
import type { ToleranceLevel } from '../../core/types';
import { getExercise } from '../../exercises';
import type { AnalyzerId, ExerciseKind, WorldId } from '../../exercises/types';
import { dayIndexOf, dayKeyOf, isWorldUnlocked, type ProgressSnapshot } from '../../progress';
import type { AttemptRecord } from '../../storage/schema';

export type SkillId = 'accuracy' | 'stability' | 'crispness' | 'transitions' | 'vibrato' | 'inflections' | 'runs' | 'dynamics';

export interface SkillDef {
  id: SkillId;
  label: string;
  /** The skill appears once this world is unlocked. */
  worldId: WorldId;
  /**
   * The metric the trend follows. A skill's line must follow the VOICE, not the curriculum, so it is a metric that does
   * not depend on the level's tolerance (or, `perTier`, one tier is followed at a time): Foundations tightens from ±50 to
   * ±10 cents, and a share "in tolerance" would fall level by level for a singer who sings exactly as well.
   */
  metric: MetricKey;
  /** The metric value at the top of the sparkline, and at its bottom: a rising line always means getting better. */
  best: number;
  worst: number;
  /** Takes of exercises with any of these analyzers are left out: their pitch moves on purpose (a pulse, vibrato), which would read as error. */
  excludeAnalyzers?: readonly AnalyzerId[];
  /** The metric is judged against the level's tolerance: the line follows one tier, the one sung most recently, and says which. */
  perTier?: boolean;
}

/** Pitch that moves on purpose: pulses and vibrato are not misses (and not wobble) for the Accuracy and Stability lines. */
const DELIBERATE_MOTION: readonly AnalyzerId[] = ['pulse', 'vibrato', 'switch'];

/** In dashboard order. Foundations teaches the first four; every later world adds one. */
export const SKILLS: readonly SkillDef[] = [
  { id: 'accuracy', label: 'Accuracy', worldId: 'foundations', metric: 'accuracy.medianAbsCents', best: 0, worst: 50, excludeAnalyzers: DELIBERATE_MOTION },
  { id: 'stability', label: 'Stability', worldId: 'foundations', metric: 'accuracy.sdCents', best: 0, worst: 40, excludeAnalyzers: DELIBERATE_MOTION },
  { id: 'crispness', label: 'Crispness', worldId: 'foundations', metric: 'onset.scoopCents', best: 0, worst: 80 },
  { id: 'transitions', label: 'Transitions', worldId: 'foundations', metric: 'transition.cleanRate', best: 1, worst: 0, perTier: true },
  { id: 'vibrato', label: 'Vibrato', worldId: 'vibrato', metric: 'vibrato.inZone', best: 1, worst: 0 },
  { id: 'inflections', label: 'Inflections', worldId: 'inflections', metric: 'inflection.score', best: 1, worst: 0 },
  { id: 'runs', label: 'Runs', worldId: 'runs', metric: 'run.score', best: 1, worst: 0 },
  { id: 'dynamics', label: 'Dynamics', worldId: 'dynamics', metric: 'dynamics.absSlopeCentsPerDb', best: 0, worst: 3 },
];

/** Which skill each kind of exercise trains: a workout item's reason line names it ("Your weakest skill: Crispness"). */
const SKILL_BY_KIND: Readonly<Partial<Record<ExerciseKind, SkillId>>> = {
  'pitch-match': 'accuracy',
  sustain: 'stability',
  siren: 'transitions',
  staccato: 'crispness',
  intervals: 'crispness',
  legato: 'transitions',
  'vibrato-meter': 'vibrato',
  'pulse-builder': 'vibrato',
  oscillation: 'vibrato',
  'straight-to-bloom': 'vibrato',
  'vibrato-switch': 'vibrato',
  scoop: 'inflections',
  fall: 'inflections',
  slide: 'inflections',
  turn: 'inflections',
  flip: 'inflections',
  run: 'runs',
  swell: 'dynamics',
};

export function skillForKind(kind: ExerciseKind): SkillDef | undefined {
  const id = SKILL_BY_KIND[kind];
  return id === undefined ? undefined : SKILLS.find((s) => s.id === id);
}

/** The skills whose world is open for this profile, in dashboard order. */
export function unlockedSkills(snapshot: ProgressSnapshot): SkillDef[] {
  return SKILLS.filter((s) => isWorldUnlocked(s.worldId, snapshot));
}

/** True when a smaller metric value is better (spread in cents, drift per dB). */
export function isLowerBetter(skill: SkillDef): boolean {
  return skill.best < skill.worst;
}

/** 0 (worst) .. 1 (best) position of a metric value on the skill's own scale. */
export function skillLevel(skill: SkillDef, value: number): number {
  const span = skill.best - skill.worst;
  if (!Number.isFinite(value) || span === 0) return 0;
  return Math.max(0, Math.min(1, (value - skill.worst) / span));
}

/** Days a skill's sparkline looks back. */
const TREND_DAYS = 30;

export interface SkillPoint {
  dayIndex: number;
  /** "YYYY-MM-DD" */
  dayKey: string;
  /** The day's mean of the metric, in the metric's stored units. */
  value: number;
  /** Takes that measured it that day. */
  takes: number;
}

export interface SkillTrend {
  skill: SkillDef;
  /** One point per day with a measurement, oldest first, within the last `days` days. */
  points: SkillPoint[];
  latest: SkillPoint | null;
  /** A `perTier` skill: the tolerance tier the line follows ("at ±10¢"); null otherwise, or before any take. */
  tier: { tolerance: ToleranceLevel; label: string } | null;
}

/** The exercise behind an attempt, for its analyzers and tolerance (undefined for songs and unknown ids). */
const exerciseOf = (a: AttemptRecord) => getExercise(a.exerciseId);

/**
 * A skill's recent trend: for each calendar day (shifted by `utcOffsetMinutes`, like Momentum) in the last `days`,
 * the mean of the skill's metric over that day's takes. Failed takes count: a trend that hid misses would flatter.
 * Deleted attempts, takes without the metric and unparsable times are skipped; a future time counts as today. Takes of
 * exercises whose pitch moves on purpose are left out (`excludeAnalyzers`), and a `perTier` skill follows only the
 * tolerance tier of its most recent take.
 */
export function skillTrend(
  skill: SkillDef,
  attempts: readonly AttemptRecord[],
  todayIndex: number,
  utcOffsetMinutes: number,
  days: number = TREND_DAYS,
): SkillTrend {
  const first = todayIndex - (days - 1);
  const measured: Array<{ a: AttemptRecord; value: number; ms: number }> = [];
  for (const a of attempts) {
    if (a.deletedAt != null) continue;
    const value = a.metrics?.[skill.metric];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const ms = Date.parse(a.createdAt);
    if (!Number.isFinite(ms)) continue;
    if (skill.excludeAnalyzers && exerciseOf(a)?.analyzers.some((id) => skill.excludeAnalyzers!.includes(id))) continue;
    measured.push({ a, value, ms });
  }
  let tier: SkillTrend['tier'] = null;
  let kept = measured;
  if (skill.perTier && measured.length > 0) {
    const newest = measured.reduce((x, y) => (y.ms >= x.ms ? y : x));
    const tolerance = exerciseOf(newest.a)?.tolerance;
    if (tolerance) {
      tier = { tolerance, label: `at ±${CONFIG.tolerance[tolerance]}¢` };
      kept = measured.filter((m) => exerciseOf(m.a)?.tolerance === tolerance);
    }
  }
  const byDay = new Map<number, { sum: number; n: number }>();
  for (const { value, ms } of kept) {
    const day = Math.min(dayIndexOf(ms, utcOffsetMinutes), todayIndex);
    if (day < first) continue;
    const slot = byDay.get(day);
    if (slot) {
      slot.sum += value;
      slot.n += 1;
    } else {
      byDay.set(day, { sum: value, n: 1 });
    }
  }
  const points = [...byDay]
    .sort((a, b) => a[0] - b[0])
    .map(([dayIndex, { sum, n }]): SkillPoint => ({ dayIndex, dayKey: dayKeyOf(dayIndex), value: sum / n, takes: n }));
  return { skill, points, latest: points.length > 0 ? points[points.length - 1] : null, tier };
}

/** Sparkline coordinates, both 0..1: x across the window (oldest day left), y from the top (best) to the bottom (worst). */
export function sparkCoords(trend: SkillTrend, todayIndex: number, days: number = TREND_DAYS): Array<{ x: number; y: number }> {
  const first = todayIndex - (days - 1);
  const span = Math.max(1, days - 1);
  return trend.points.map((p) => ({ x: (p.dayIndex - first) / span, y: 1 - skillLevel(trend.skill, p.value) }));
}
