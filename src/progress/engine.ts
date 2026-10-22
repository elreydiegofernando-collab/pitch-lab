/**
 * Progression engine (SPEC §11): folds the append-only attempt log into a ProgressSnapshot. The
 * log is the only source of truth; nothing stores "unlocked" flags, so call computeSnapshot
 * again after every new attempt instead of patching a cached snapshot. Same log + same options
 * + same `now` always give the same snapshot, whatever the order the rows arrive in.
 *
 * The rules ("everything is earned", owner directive 2026-10-21):
 *  - STRICTLY LINEAR: inside an open world a pass only counts where the singer could have been,
 *    i.e. when every earlier level is passed. So statuses always read passed*, current?, locked*,
 *    and the single `current` level is the frontier. A pass recorded further along waits (it
 *    counts the moment the gap is legitimately closed) instead of skipping ahead.
 *  - A world opens only when the level named by its `unlockedBy` (the previous Boss Recital) is
 *    passed by a DIRECT attempt, in a world that is itself open. Nothing in a closed world counts.
 *  - An audition grants levels inside its OWN world, in an OPEN world only, and only its own SPAN:
 *    test i covers the levels past everything the earlier tests reach, up to its `unlockThrough`
 *    (auditions.ts). A later test can never vouch for skills an earlier test judges, and a grant
 *    counts like any other evidence, i.e. once every earlier level is passed. It never grants the
 *    Range finder (it sets the range every exercise transposes to, so it is always sung), a Boss
 *    Recital or anything past one, and never opens a world, whatever a bad catalog entry says.
 *  - Unlocks depend on the log alone, never on the clock: a wrong device clock cannot re-lock
 *    anything. Adding attempts can only add passes (soft-deleting an attempt is the one way to
 *    remove evidence, and it is the singer's own act).
 *  - A tempo-ladder level (Runs) passes only at its pass tempo: with the catalog lookup, a take
 *    recorded below it never counts, whatever `passed` says.
 *
 * Known trade-off: insert a level BEFORE levels singers have already passed and those later
 * levels (and, for a boss, its world) wait until the new level is passed; then everything returns
 * at once. The catalog says to add new ids rather than renumber, which keeps this rare.
 */
import { canPassAtTempo } from '../exercises/ladder';
import type { ExerciseDef, LevelDef, WorldDef, WorldId } from '../exercises/types';
import type { AttemptRecord } from '../storage/schema';
import type { LevelProgress, LevelStatus, Mastery, ProgressSnapshot } from './types';
import { auditionSpans } from './auditions';
import { LEVEL_ATTEMPT_KINDS, LEVEL_PASSING_KINDS, cleanScore, replayLog } from './log';
import type { LoggedAttempt } from './log';
import { momentumFromLog } from './momentum';
import type { MomentumKnobs } from './momentum';
import { foldRecords } from './records';
import type { ExerciseLookup } from './records';
import { dayIndexOf, dayKeyOf, requireMs } from './time';
import type { TimeInput } from './time';
import { LEVEL_REFS, unlockedFeatures } from './unlocks';

export type { ExerciseLookup } from './records';

export interface SnapshotOptions {
  /**
   * Catalog lookup (`getExercise` from src/exercises/catalog). With it, mastery is also derived
   * from the best passing score against the exercise's tiers, and records are limited to the
   * metrics each exercise scores.
   */
  getExercise?: ExerciseLookup;
  /** Minutes east of UTC that define a calendar day for momentum and lastPracticeDay (default 0 = UTC). */
  utcOffsetMinutes?: number;
  momentumKnobs?: Partial<MomentumKnobs>;
}

/** 1 (pass), 2 (solid) or 3 (studio) for a PASSING score against the exercise's tiers. */
export function masteryForScore(def: Pick<ExerciseDef, 'tiers'>, score: number): Mastery {
  const t = def.tiers;
  if (!t) return 1;
  return score >= t.studio ? 3 : score >= t.solid ? 2 : 1;
}

interface LevelStats {
  attempts: number;
  bestScore: number;
  pass: { at: string; bestScore: number; mastery: Mastery } | null;
}

interface Grant {
  at: string;
  score: number;
}

type Evidence = 'direct' | 'audition' | null;
type ResolvedLevel = { status: LevelStatus; evidence: Evidence };

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** A passing attempt's mastery as a tier 1..3 (a pass is at least one light). */
function passMastery(m: unknown): Mastery {
  return (typeof m === 'number' && m >= 3 ? 3 : typeof m === 'number' && m >= 2 ? 2 : 1) as Mastery;
}

/**
 * A take below a tempo ladder's pass tempo is practice, however well it was sung (the runner records it as not
 * passed; this is the second lock). Needs the catalog lookup: without one the recorded `passed` is all there is.
 */
function atPassTempo(a: AttemptRecord, level: LevelDef, getExercise: ExerciseLookup | undefined): boolean {
  const def = getExercise?.(level.exerciseId);
  return def === undefined || canPassAtTempo(def, a.tempoBpm);
}

function collectLevelStats(
  log: readonly LoggedAttempt[],
  levelOwner: ReadonlyMap<string, { level: LevelDef }>,
  getExercise: ExerciseLookup | undefined,
): Map<string, LevelStats> {
  const stats = new Map<string, LevelStats>();
  for (const { a } of log) {
    if (a.levelId == null || !LEVEL_ATTEMPT_KINDS.has(a.kind)) continue;
    const owner = levelOwner.get(a.levelId);
    if (!owner) continue;
    const score = cleanScore(a.score);
    let s = stats.get(a.levelId);
    if (!s) {
      s = { attempts: 0, bestScore: 0, pass: null };
      stats.set(a.levelId, s);
    }
    s.attempts += 1;
    if (score > s.bestScore) s.bestScore = score;
    if (a.passed === true && LEVEL_PASSING_KINDS.has(a.kind) && atPassTempo(a, owner.level, getExercise)) {
      const mastery = passMastery(a.mastery);
      if (!s.pass) s.pass = { at: a.createdAt, bestScore: score, mastery };
      else {
        if (score > s.pass.bestScore) s.pass.bestScore = score;
        if (mastery > s.pass.mastery) s.pass.mastery = mastery;
      }
    }
  }
  return stats;
}

/**
 * Levels each world's passed auditions grant. A test grants only its own span (auditions.ts: past what the
 * earlier tests reach, short of any Boss Recital) and never the Range finder, which only a real take passes.
 * Whether a grant COUNTS is resolveWorld's call: it waits until every earlier level is passed.
 */
function collectGrants(log: readonly LoggedAttempt[], worlds: readonly WorldDef[], ordered: ReadonlyMap<WorldId, LevelDef[]>): Map<WorldId, Map<string, Grant>> {
  const spanOf = new Map<string, { worldId: WorldId; first: number; last: number }>();
  for (const world of worlds) {
    if (!world.audition) continue;
    for (const { exerciseId, first, last } of auditionSpans(world.audition, ordered.get(world.id) ?? [])) {
      if (!spanOf.has(exerciseId)) spanOf.set(exerciseId, { worldId: world.id, first, last });
    }
  }
  const grants = new Map<WorldId, Map<string, Grant>>();
  for (const { a } of log) {
    if (a.kind !== 'audition' || a.passed !== true) continue;
    const span = spanOf.get(a.exerciseId);
    if (!span) continue; // not a test of any audition, or one that reaches nothing new
    const levels = ordered.get(span.worldId) ?? [];
    let granted = grants.get(span.worldId);
    if (!granted) {
      granted = new Map();
      grants.set(span.worldId, granted);
    }
    const score = cleanScore(a.score);
    for (let i = span.first; i <= span.last; i++) {
      const level = levels[i];
      if (level.id === LEVEL_REFS.rangeFinder) continue; // it measures the range every exercise transposes to: sung, never granted
      const prev = granted.get(level.id);
      if (!prev) granted.set(level.id, { at: a.createdAt, score });
      else if (score > prev.score) prev.score = score;
    }
  }
  return grants;
}

/** Statuses of one OPEN world: strictly linear, evidence counts only while every earlier level is passed. */
function resolveWorld(levels: readonly LevelDef[], stats: ReadonlyMap<string, LevelStats>, grants: ReadonlyMap<string, Grant> | undefined): Map<string, ResolvedLevel> {
  const out = new Map<string, ResolvedLevel>();
  let reachable = true;
  for (const level of levels) {
    const direct = stats.get(level.id)?.pass != null;
    const granted = grants?.has(level.id) === true;
    if (reachable && (direct || granted)) {
      out.set(level.id, { status: 'passed', evidence: direct ? 'direct' : 'audition' });
    } else if (reachable) {
      out.set(level.id, { status: 'current', evidence: null });
      reachable = false;
    } else {
      out.set(level.id, { status: 'locked', evidence: null });
    }
  }
  return out;
}

/**
 * The single gate: a profile's progression at `now`. `attempts` may hold any profiles' rows in
 * any order; this keeps the profile's live rows and replays them in append order.
 * `now` is a Date, epoch milliseconds or ISO string; an invalid one throws a RangeError.
 */
export function computeSnapshot(
  profileId: string,
  worlds: readonly WorldDef[],
  attempts: readonly AttemptRecord[],
  now: TimeInput,
  options: SnapshotOptions = {},
): ProgressSnapshot {
  const nowMs = requireMs(now, 'computeSnapshot: now');
  const utcOffsetMinutes = options.utcOffsetMinutes ?? 0;
  const log = replayLog(profileId, attempts);

  const levelOwner = new Map<string, { world: WorldDef; level: LevelDef }>();
  const ordered = new Map<WorldId, LevelDef[]>();
  for (const world of worlds) {
    ordered.set(world.id, [...world.levels].sort((a, b) => a.index - b.index));
    for (const level of world.levels) levelOwner.set(level.id, { world, level });
  }

  const stats = collectLevelStats(log, levelOwner, options.getExercise);
  const grants = collectGrants(log, worlds, ordered);

  const resolved = new Map<WorldId, Map<string, ResolvedLevel>>();
  const resolve = (world: WorldDef): Map<string, ResolvedLevel> => {
    let r = resolved.get(world.id);
    if (!r) {
      r = resolveWorld(ordered.get(world.id) ?? [], stats, grants.get(world.id));
      resolved.set(world.id, r);
    }
    return r;
  };

  // Worlds open from the start, plus each world whose gate level a DIRECT pass cleared inside an open world.
  const open = new Set<WorldId>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const world of worlds) {
      if (open.has(world.id)) continue;
      let opens = world.unlockedBy == null;
      if (!opens) {
        const gate = levelOwner.get(world.unlockedBy as string);
        opens = !!gate && gate.world.id !== world.id && open.has(gate.world.id) && resolve(gate.world).get(gate.level.id)?.evidence === 'direct';
      }
      if (opens) {
        open.add(world.id);
        changed = true;
      }
    }
  }

  const levels: Record<string, LevelProgress> = {};
  for (const world of worlds) {
    const worldResolved = open.has(world.id) ? resolve(world) : null;
    for (const level of ordered.get(world.id) ?? []) {
      const st = stats.get(level.id);
      const res = worldResolved?.get(level.id);
      const evidence = res?.evidence ?? null;
      let bestScore = st?.bestScore ?? 0;
      let mastery: Mastery = 0;
      let passedAt: string | null = null;
      if (evidence === 'direct' && st?.pass) {
        passedAt = st.pass.at;
        const def = options.getExercise?.(level.exerciseId);
        mastery = def ? (Math.max(st.pass.mastery, masteryForScore(def, st.pass.bestScore)) as Mastery) : st.pass.mastery;
      } else if (evidence === 'audition') {
        const grant = grants.get(world.id)?.get(level.id);
        passedAt = grant?.at ?? null;
        bestScore = Math.max(bestScore, grant?.score ?? 0);
        mastery = 1;
      }
      levels[level.id] = {
        levelId: level.id,
        status: res?.status ?? 'locked',
        bestScore,
        mastery,
        attempts: st?.attempts ?? 0,
        passedAt,
        viaAudition: evidence === 'audition',
      };
    }
  }

  const worldsUnlocked = [...new Set(worlds.filter((w) => open.has(w.id)).map((w) => w.id))];
  const nowIso = new Date(nowMs).toISOString();
  const withoutFeatures: ProgressSnapshot = {
    profileId,
    computedAt: nowIso,
    levels,
    worldsUnlocked,
    features: [],
    momentum: 0,
    lastPracticeDay: null,
    records: {},
  };

  const today = dayIndexOf(nowMs, utcOffsetMinutes);
  let lastDay = -Infinity;
  for (const { ms } of log) if (ms !== null) lastDay = Math.max(lastDay, dayIndexOf(ms, utcOffsetMinutes));

  return {
    ...withoutFeatures,
    features: unlockedFeatures(withoutFeatures),
    momentum: round3(momentumFromLog(log, nowMs, utcOffsetMinutes, options.momentumKnobs)),
    lastPracticeDay: lastDay === -Infinity ? null : dayKeyOf(Math.min(lastDay, today)),
    records: foldRecords(log, options.getExercise),
  };
}
