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
 *  - A placement test sung in a voice check-up (a row with a `checkupId`) grants only what the audition
 *    itself could have: the check-up sings every test whatever the one before it did, so the registry
 *    did not choose it, and its pass counts only if it was the audition's NEXT test when it was sung
 *    (nextAuditionExercise on the log before it: the Range finder sung, every level before its span
 *    passed). A test it passed out of order, or before the Range finder was sung, never grants, now or
 *    later. An ordinary audition row was the next test by construction (the registry opens no other).
 *  - Unlocks depend on the log alone, never on the clock: a wrong device clock cannot re-lock
 *    anything. Adding attempts can only add passes (soft-deleting an attempt is the one way to
 *    remove evidence, and it is the singer's own act).
 *  - A tempo-ladder level (Runs) passes only at its pass tempo: with the catalog lookup, a take
 *    recorded below it never counts, whatever `passed` says.
 *  - A world rebuilt since (Foundations as lessons, 2026-10-23) keeps what was earned before: a level
 *    keeps its id while it still teaches what it did, so its passes stand, and a pass of a former
 *    audition test (AuditionDef.former) keeps what it granted then. That test is judged by the audition
 *    it was sung under, in that order and against the levels then (so a check-up's test that was out of
 *    order then still grants nothing), and it grants now only the levels that still teach what it judged
 *    (`keeps`): a level that is new, or that now judges something the test never did, is earned again.
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
import { LEVEL_REFS, nextAuditionExercise, unlockedFeatures } from './unlocks';

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
  /** The best score of a take at the level's pass tempo (a lower rung of a Runs ladder is practice at another speed). */
  bestScore: number;
  /** The direct passes: the first one's time and place in the replayed log (`index`), the best score and mastery of all. */
  pass: { at: string; index: number; bestScore: number; mastery: Mastery } | null;
  /**
   * The best of the PASSED personal-record takes at the pass tempo: they light the level's tally lights (a record take
   * is the level sung again, judged by its own rule), though they never pass it. 0 when there is none.
   */
  record: { bestScore: number; mastery: Mastery } | null;
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
  for (let index = 0; index < log.length; index++) {
    const { a } = log[index];
    if (a.levelId == null || !LEVEL_ATTEMPT_KINDS.has(a.kind)) continue;
    const owner = levelOwner.get(a.levelId);
    if (!owner) continue;
    const score = cleanScore(a.score);
    let s = stats.get(a.levelId);
    if (!s) {
      s = { attempts: 0, bestScore: 0, pass: null, record: null };
      stats.set(a.levelId, s);
    }
    s.attempts += 1;
    const atTempo = atPassTempo(a, owner.level, getExercise);
    // The level's "Best" is a score at its own tempo: the Map, Home's Continue card and Level then agree.
    if (atTempo && score > s.bestScore) s.bestScore = score;
    if (a.passed === true && LEVEL_PASSING_KINDS.has(a.kind) && atTempo) {
      const mastery = passMastery(a.mastery);
      if (!s.pass) s.pass = { at: a.createdAt, index, bestScore: score, mastery };
      else {
        if (score > s.pass.bestScore) s.pass.bestScore = score;
        if (mastery > s.pass.mastery) s.pass.mastery = mastery;
      }
    } else if (a.passed === true && a.kind === 'record' && atTempo) {
      const mastery = passMastery(a.mastery);
      if (!s.record) s.record = { bestScore: score, mastery };
      else {
        if (score > s.record.bestScore) s.record.bestScore = score;
        if (mastery > s.record.mastery) s.record.mastery = mastery;
      }
    }
  }
  return stats;
}

type LevelOwners = ReadonlyMap<string, { world: WorldDef; level: LevelDef }>;

/** A take of a voice check-up (src/checkup): it carries the check-up's id. */
function isCheckupTake(a: AttemptRecord): boolean {
  return typeof a.checkupId === 'string' && a.checkupId !== '';
}

/**
 * The progress the registry saw just before log row `index` was sung, as much of it as nextAuditionExercise reads: each
 * level's status and whether an audition granted it, and the open worlds. It is built from the direct passes before
 * that row and from `grants`, which holds exactly the grants of the rows before it while collectGrants walks the log in
 * order. Scores, mastery, features and momentum are left empty: no rule here reads them.
 */
function progressBefore(
  index: number,
  worlds: readonly WorldDef[],
  ordered: ReadonlyMap<WorldId, LevelDef[]>,
  levelOwner: LevelOwners,
  stats: ReadonlyMap<string, LevelStats>,
  grants: ReadonlyMap<WorldId, ReadonlyMap<string, Grant>>,
): ProgressSnapshot {
  const direct = (levelId: string): boolean => (stats.get(levelId)?.pass?.index ?? Infinity) < index;
  const resolved = new Map<WorldId, Map<string, ResolvedLevel>>();
  const resolve = (world: WorldDef): Map<string, ResolvedLevel> => {
    let r = resolved.get(world.id);
    if (!r) {
      const granted = grants.get(world.id);
      r = resolveWorld(ordered.get(world.id) ?? [], direct, (levelId) => granted?.has(levelId) === true);
      resolved.set(world.id, r);
    }
    return r;
  };
  const open = openWorlds(worlds, levelOwner, resolve);
  const levels: Record<string, LevelProgress> = {};
  for (const world of worlds) {
    const r = open.has(world.id) ? resolve(world) : null;
    for (const level of ordered.get(world.id) ?? []) {
      const res = r?.get(level.id);
      levels[level.id] = { levelId: level.id, status: res?.status ?? 'locked', bestScore: 0, mastery: 0, attempts: 0, passedAt: null, viaAudition: res?.evidence === 'audition' };
    }
  }
  const worldsUnlocked = [...new Set(worlds.filter((w) => open.has(w.id)).map((w) => w.id))];
  return { profileId: '', computedAt: '', levels, worldsUnlocked, features: [], momentum: 0, lastPracticeDay: null, records: {} };
}

/**
 * A world's audition as it was before the world was rebuilt (AuditionDef.former), ready to judge the takes of its tests
 * against it: each test's levels then (its span over the levels then), and the levels a pass of it still grants now.
 */
interface FormerAudition {
  worldId: WorldId;
  /** The world's levels then, in order. */
  levelIds: readonly string[];
  /** The tests then, in sung order, each with the levels it covered then. */
  tests: ReadonlyArray<{ exerciseId: string; levelIds: readonly string[] }>;
  keeps: ReadonlySet<string>;
  /** The first row that passed each level then by a sung take (its place in the replayed log). */
  direct: ReadonlyMap<string, number>;
  /** The levels then that a former test has granted so far, and the row that granted each: filled in log order. */
  granted: Map<string, number>;
}

function formerAuditions(log: readonly LoggedAttempt[], worlds: readonly WorldDef[]): Map<string, FormerAudition> {
  const byTest = new Map<string, FormerAudition>();
  for (const world of worlds) {
    const f = world.audition?.former;
    if (!f) continue;
    // The levels then, as auditionSpans reads a world's levels (its Boss Recital by its id: the catalog names it so).
    const levels: LevelDef[] = f.levelIds.map((id, i) => ({ id, worldId: world.id, index: i + 1, title: id, exerciseId: '', kind: id === `${world.id}.boss` ? 'boss' : 'level' }));
    const spans = auditionSpans({ id: `${world.id}.former`, worldId: world.id, exerciseIds: [...f.exerciseIds], unlockThrough: [...f.unlockThrough] }, levels);
    const then = new Set(f.levelIds);
    const direct = new Map<string, number>();
    log.forEach(({ a }, index) => {
      if (a.levelId == null || !then.has(a.levelId) || a.passed !== true || !LEVEL_PASSING_KINDS.has(a.kind)) return;
      if (!direct.has(a.levelId)) direct.set(a.levelId, index);
    });
    const former: FormerAudition = {
      worldId: world.id,
      levelIds: f.levelIds,
      tests: spans.map((s) => ({ exerciseId: s.exerciseId, levelIds: levels.slice(s.first, s.last + 1).map((l) => l.id) })),
      keeps: new Set(f.keeps),
      direct,
      granted: new Map(),
    };
    for (const t of former.tests) if (!byTest.has(t.exerciseId)) byTest.set(t.exerciseId, former);
  }
  return byTest;
}

/**
 * The former test that was the audition's NEXT one just before log row `index`, as the registry then saw it (unlocks.ts
 * nextAuditionExercise, over the levels then): none before the Range finder was sung, else the first test with a level
 * that was not passed then (passed = a sung pass or an earlier former grant, strictly in order).
 */
function nextFormerTest(f: FormerAudition, index: number): string | null {
  const before = (at: number | undefined): boolean => at !== undefined && at < index;
  if (f.levelIds.includes(LEVEL_REFS.rangeFinder) && !before(f.direct.get(LEVEL_REFS.rangeFinder))) return null;
  const passed = new Set<string>();
  for (const id of f.levelIds) {
    if (!before(f.direct.get(id)) && !before(f.granted.get(id))) break;
    passed.add(id);
  }
  for (const t of f.tests) if (t.levelIds.some((id) => !passed.has(id))) return t.exerciseId;
  return null;
}

/**
 * Levels each world's passed auditions grant. A test grants only its own span (auditions.ts: past what the
 * earlier tests reach, short of any Boss Recital) and never the Range finder, which only a real take passes.
 * Whether a grant COUNTS is resolveWorld's call: it waits until every earlier level is passed. A check-up's test
 * grants nothing unless it was the audition's next test when it was sung (the module doc), so a check-up never grants
 * more than the audition could, and never later. A test of a world's former audition grants what it covered then,
 * judged against that audition (nextFormerTest), and now only the levels its world still `keeps`.
 */
function collectGrants(
  log: readonly LoggedAttempt[],
  worlds: readonly WorldDef[],
  ordered: ReadonlyMap<WorldId, LevelDef[]>,
  levelOwner: LevelOwners,
  stats: ReadonlyMap<string, LevelStats>,
): Map<WorldId, Map<string, Grant>> {
  const spanOf = new Map<string, { worldId: WorldId; first: number; last: number }>();
  for (const world of worlds) {
    if (!world.audition) continue;
    for (const { exerciseId, first, last } of auditionSpans(world.audition, ordered.get(world.id) ?? [])) {
      if (!spanOf.has(exerciseId)) spanOf.set(exerciseId, { worldId: world.id, first, last });
    }
  }
  const former = formerAuditions(log, worlds);
  const grants = new Map<WorldId, Map<string, Grant>>();
  const grant = (worldId: WorldId, levelId: string, a: AttemptRecord): void => {
    if (levelId === LEVEL_REFS.rangeFinder) return; // it measures the range every exercise transposes to: sung, never granted
    let granted = grants.get(worldId);
    if (!granted) {
      granted = new Map();
      grants.set(worldId, granted);
    }
    const score = cleanScore(a.score);
    const prev = granted.get(levelId);
    if (!prev) granted.set(levelId, { at: a.createdAt, score });
    else if (score > prev.score) prev.score = score;
  };
  for (let index = 0; index < log.length; index++) {
    const { a } = log[index];
    if (a.kind !== 'audition' || a.passed !== true) continue;
    const then = former.get(a.exerciseId);
    if (then) {
      if (isCheckupTake(a) && nextFormerTest(then, index) !== a.exerciseId) continue; // out of order as it was sung: no grant
      const test = then.tests.find((t) => t.exerciseId === a.exerciseId);
      for (const levelId of test?.levelIds ?? []) {
        if (levelId !== LEVEL_REFS.rangeFinder && !then.granted.has(levelId)) then.granted.set(levelId, index);
        if (then.keeps.has(levelId) && levelOwner.get(levelId)?.world.id === then.worldId) grant(then.worldId, levelId, a);
      }
      continue;
    }
    const span = spanOf.get(a.exerciseId);
    if (!span) continue; // not a test of any audition, or one that reaches nothing new
    if (isCheckupTake(a) && nextAuditionExercise(span.worldId, progressBefore(index, worlds, ordered, levelOwner, stats, grants), worlds) !== a.exerciseId) {
      continue; // sung by a check-up out of the audition's order: it measured the skill, and grants nothing
    }
    const levels = ordered.get(span.worldId) ?? [];
    for (let i = span.first; i <= span.last; i++) grant(span.worldId, levels[i].id, a);
  }
  return grants;
}

/**
 * Statuses of one OPEN world: strictly linear, evidence counts only while every earlier level is passed. `isDirect` and
 * `isGranted` say whether a level has a direct pass and an audition grant.
 */
function resolveWorld(levels: readonly LevelDef[], isDirect: (levelId: string) => boolean, isGranted: (levelId: string) => boolean): Map<string, ResolvedLevel> {
  const out = new Map<string, ResolvedLevel>();
  let reachable = true;
  for (const level of levels) {
    const direct = isDirect(level.id);
    const granted = isGranted(level.id);
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

/** Worlds open from the start, plus each world whose gate level a DIRECT pass cleared inside an open world. */
function openWorlds(worlds: readonly WorldDef[], levelOwner: LevelOwners, resolve: (world: WorldDef) => ReadonlyMap<string, ResolvedLevel>): Set<WorldId> {
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
  return open;
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
  const grants = collectGrants(log, worlds, ordered, levelOwner, stats);

  const resolved = new Map<WorldId, Map<string, ResolvedLevel>>();
  const resolve = (world: WorldDef): Map<string, ResolvedLevel> => {
    let r = resolved.get(world.id);
    if (!r) {
      const granted = grants.get(world.id);
      r = resolveWorld(ordered.get(world.id) ?? [], (levelId) => stats.get(levelId)?.pass != null, (levelId) => granted?.has(levelId) === true);
      resolved.set(world.id, r);
    }
    return r;
  };

  const open = openWorlds(worlds, levelOwner, resolve);

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
      const def = options.getExercise?.(level.exerciseId);
      // A passed record take lights the tally like any passing take (never the pass itself: that needs evidence above).
      const recordMastery: Mastery = st?.record ? (def ? (Math.max(st.record.mastery, masteryForScore(def, st.record.bestScore)) as Mastery) : st.record.mastery) : 0;
      if (evidence === 'direct' && st?.pass) {
        passedAt = st.pass.at;
        mastery = def ? (Math.max(st.pass.mastery, masteryForScore(def, st.pass.bestScore), recordMastery) as Mastery) : (Math.max(st.pass.mastery, recordMastery) as Mastery);
      } else if (evidence === 'audition') {
        const grant = grants.get(world.id)?.get(level.id);
        passedAt = grant?.at ?? null;
        bestScore = Math.max(bestScore, grant?.score ?? 0);
        mastery = Math.max(1, recordMastery) as Mastery;
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
