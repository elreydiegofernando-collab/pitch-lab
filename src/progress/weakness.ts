/**
 * Weakness ranking: a light spaced-repetition rule over UNLOCKED levels (current or passed),
 * used to pick the daily workout's review item and to drive a "needs work" view. Only unlocked
 * levels are ever built into inputs, so a locked skill can never surface.
 *
 * Each level scores 0 (strong) .. 1 (weak/most due) from three signals, newest attempts weighing most:
 *  - performance: how far recent scores sit below a perfect 1;
 *  - misses: the share of recent attempts that failed;
 *  - staleness: days since last practiced against a due interval that GROWS with mastery
 *    (a studio-tier level is not due again for two weeks; a fresh pass is due in a day or so).
 *    Staleness is 0.5 exactly when due and reaches 1 at `staleAtDueMultiple` times the interval.
 * A level never practiced scores 1. A level passed only through an audition counts the audition
 * score as its one recent attempt, practiced when it was granted.
 *
 * CONTRACT GAP: src/config.ts has no `weakness` section; WEAKNESS_KNOBS are local PROVISIONAL
 * knobs (proposed CONFIG.weakness). Every function accepts `knobs` so tuning needs no edit here.
 */
import { clamp01 } from '../core/math';
import type { WorldDef, WorldId } from '../exercises/types';
import type { AttemptRecord } from '../storage/schema';
import type { LoggedAttempt } from './log';
import { LEVEL_ATTEMPT_KINDS, cleanScore, replayLog } from './log';
import { MS_PER_DAY, requireMs } from './time';
import type { TimeInput } from './time';
import type { Mastery, ProgressSnapshot } from './types';

export interface WeaknessKnobs {
  /** Most recent attempts considered per level. */
  window: number;
  /** Weight of each older attempt relative to the next newer one (newest = 1). */
  recencyDecay: number;
  weights: { performance: number; misses: number; staleness: number };
  /** Days until a level of mastery 0, 1, 2, 3 is due for review again. */
  dueDaysByMastery: readonly [number, number, number, number];
  /** Staleness reaches 1 at this multiple of the due interval. */
  staleAtDueMultiple: number;
  /** Reason thresholds. */
  lowScoreBelowPerformance: number;
  missRateAtLeast: number;
}

export const WEAKNESS_KNOBS: Readonly<WeaknessKnobs> = {
  window: 5,
  recencyDecay: 0.75,
  weights: { performance: 0.45, misses: 0.25, staleness: 0.3 },
  dueDaysByMastery: [1, 3, 7, 14],
  staleAtDueMultiple: 2,
  lowScoreBelowPerformance: 0.35,
  missRateAtLeast: 0.34,
};

export interface RecentAttempt {
  score: number;
  passed: boolean;
}

export interface WeaknessInput {
  levelId: string;
  worldId: WorldId;
  mastery: Mastery;
  /** Newest first. */
  recent: readonly RecentAttempt[];
  /** ISO time of the most recent attempt (or of the audition grant); null if never practiced. */
  lastPracticedAt: string | null;
}

export type WeaknessReason = 'never-tried' | 'low-score' | 'recent-misses' | 'overdue';

export interface WeaknessScore {
  levelId: string;
  worldId: WorldId;
  mastery: Mastery;
  /** 0 (strong) .. 1 (weak / most due). */
  score: number;
  performance: number;
  misses: number;
  staleness: number;
  /** Days until due (negative = overdue); null when never practiced. */
  dueInDays: number | null;
  reasons: WeaknessReason[];
}

/** Rank levels weakest-first. Ties break on staleness, then lower mastery, then level id, so the order is total. */
export function rankWeakness(items: readonly WeaknessInput[], now: TimeInput, knobs: Partial<WeaknessKnobs> = {}): WeaknessScore[] {
  const k: WeaknessKnobs = { ...WEAKNESS_KNOBS, ...knobs };
  const nowMs = requireMs(now, 'rankWeakness: now');
  const w = k.weights;
  return items
    .map((it): WeaknessScore => {
      const recent = it.recent.slice(0, Math.max(1, Math.floor(k.window)));
      const lastMs = it.lastPracticedAt === null ? NaN : Date.parse(it.lastPracticedAt);
      const due = k.dueDaysByMastery[it.mastery] ?? k.dueDaysByMastery[0];
      if (recent.length === 0) {
        const dueInDays = Number.isFinite(lastMs) ? due - Math.max(0, nowMs - lastMs) / MS_PER_DAY : null;
        return { levelId: it.levelId, worldId: it.worldId, mastery: it.mastery, score: 1, performance: 1, misses: 1, staleness: 1, dueInDays, reasons: ['never-tried'] };
      }
      let weightSum = 0;
      let scoreSum = 0;
      let missSum = 0;
      let weight = 1;
      for (const r of recent) {
        weightSum += weight;
        scoreSum += weight * cleanScore(r.score);
        missSum += r.passed ? 0 : weight;
        weight *= k.recencyDecay;
      }
      const performance = clamp01(1 - scoreSum / weightSum);
      const misses = clamp01(missSum / weightSum);
      const daysSince = Number.isFinite(lastMs) ? Math.max(0, nowMs - lastMs) / MS_PER_DAY : Infinity;
      const staleness = clamp01(daysSince / (due * k.staleAtDueMultiple));
      const reasons: WeaknessReason[] = [];
      if (performance >= k.lowScoreBelowPerformance) reasons.push('low-score');
      if (misses >= k.missRateAtLeast) reasons.push('recent-misses');
      if (daysSince > due) reasons.push('overdue');
      return {
        levelId: it.levelId,
        worldId: it.worldId,
        mastery: it.mastery,
        score: clamp01(w.performance * performance + w.misses * misses + w.staleness * staleness),
        performance,
        misses,
        staleness,
        dueInDays: Number.isFinite(daysSince) ? due - daysSince : null,
        reasons,
      };
    })
    .sort((a, b) => b.score - a.score || b.staleness - a.staleness || a.mastery - b.mastery || (a.levelId < b.levelId ? -1 : a.levelId > b.levelId ? 1 : 0));
}

/**
 * Weakness inputs for every UNLOCKED level (current or passed) of `worlds`, built from the
 * profile's attempt log and its snapshot. Locked levels are never included.
 */
export function weaknessInputsFromLog(
  snapshot: ProgressSnapshot,
  worlds: readonly WorldDef[],
  attempts: readonly AttemptRecord[],
  knobs: Partial<WeaknessKnobs> = {},
): WeaknessInput[] {
  const window = Math.max(1, Math.floor(knobs.window ?? WEAKNESS_KNOBS.window));
  const byLevel = new Map<string, LoggedAttempt[]>();
  const log = replayLog(snapshot.profileId, attempts);
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    const { levelId, kind } = entry.a;
    if (levelId == null || !LEVEL_ATTEMPT_KINDS.has(kind)) continue;
    const list = byLevel.get(levelId);
    if (list) list.push(entry);
    else byLevel.set(levelId, [entry]);
  }

  const out: WeaknessInput[] = [];
  for (const world of worlds) {
    for (const level of world.levels) {
      const lp = snapshot.levels[level.id];
      if (!lp || lp.status === 'locked') continue;
      const list = byLevel.get(level.id) ?? []; // newest first
      let lastPracticedAt: string | null = null;
      let lastMs = -Infinity;
      for (const { a, ms } of list) {
        if (ms !== null && ms > lastMs) {
          lastMs = ms;
          lastPracticedAt = a.createdAt;
        }
      }
      let recent: RecentAttempt[] = list.slice(0, window).map(({ a }) => ({ score: cleanScore(a.score), passed: a.passed === true }));
      if (list.length === 0 && lp.viaAudition) {
        recent = [{ score: lp.bestScore, passed: true }];
        lastPracticedAt = lp.passedAt;
      }
      out.push({ levelId: level.id, worldId: world.id, mastery: lp.mastery, recent, lastPracticedAt });
    }
  }
  return out;
}
