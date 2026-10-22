/**
 * Unlock registry (SPEC §11.1/§11.2): the SINGLE gate for every feature, readout, setting,
 * level, exercise and song. Nothing bypasses it: not deep links, not the debug hook, not imported
 * packs. A locked item is shown (dimmed, with its requirement line) but cannot be opened.
 *
 * Everything resolves from a ProgressSnapshot alone (the snapshot already encodes strict
 * linearity, boss gates and audition grants); `worlds` is only needed to look up titles, boss
 * levels and exercise ownership. Every lookup fails CLOSED: an unknown id is locked.
 *
 * Level ids named below are the catalog's persisted ids (src/exercises/catalog: "never rename or
 * renumber"); catalog.integration.test.ts fails if one stops resolving.
 */
import type { LevelDef, WorldDef, WorldId } from '../exercises/types';
import type { FeatureId, LevelStatus, ProgressSnapshot, Requirement } from './types';
import { auditionSpans } from './auditions';
import { isRoutineExerciseId } from './routines';

/** Catalog level ids the registry keys on. */
export const LEVEL_REFS = {
  /**
   * Foundations "Range finder": measures and saves the singer's range, which every other exercise transposes
   * to. So it is always SUNG: an audition never passes it, and none is offered before it is passed.
   */
  rangeFinder: 'foundations.01',
  /** Foundations "Sirens & glides": opens crack markers on the trace. */
  sirens: 'foundations.05',
  /** Foundations "Crispness": opens the settle/scoop readouts. */
  crispness: 'foundations.06',
  /** Foundations Boss Recital: opens Vibrato, Song Stage and song import. */
  foundationsBoss: 'foundations.boss',
} as const;

/** Every FeatureId -> its requirement (the compiler rejects a missing id). Hints are one line, naming the thing to pass. */
export const FEATURES: Readonly<Record<FeatureId, Requirement>> = {
  'live.basic': { kind: 'start', hint: 'Available from the start.' },
  'live.cracks': { kind: 'levelPassed', ref: LEVEL_REFS.sirens, hint: 'Pass Sirens & glides to see crack markers on the trace.' },
  'live.onset': { kind: 'levelPassed', ref: LEVEL_REFS.crispness, hint: 'Pass Crispness to see settle and scoop readouts.' },
  'live.vibrato': { kind: 'worldUnlocked', ref: 'vibrato', hint: 'Pass the Foundations Boss Recital to see vibrato readouts.' },
  'tool.vibrato-meter': { kind: 'worldUnlocked', ref: 'vibrato', hint: 'Pass the Foundations Boss Recital to use the vibrato meter.' },
  'setting.vibratoStyle': { kind: 'worldUnlocked', ref: 'vibrato', hint: 'Pass the Foundations Boss Recital to choose a vibrato style.' },
  'dashboard': { kind: 'levelPassed', hint: 'Pass your first level to see the progress dashboard.' },
  'daily-workout': { kind: 'levelPassed', hint: 'Pass your first level to unlock the daily workout.' },
  'song-stage': { kind: 'levelPassed', ref: LEVEL_REFS.foundationsBoss, hint: 'Pass the Foundations Boss Recital to open Song Stage.' },
  'song.import': { kind: 'levelPassed', ref: LEVEL_REFS.foundationsBoss, hint: 'Pass the Foundations Boss Recital to import your own songs.' },
  'records': { kind: 'levelPassed', hint: 'Pass an exercise to start chasing personal records on it.' },
  'export': { kind: 'start', hint: 'Available from the start.' },
};

/** Every registered feature id, in registry order. */
export const FEATURE_IDS: readonly FeatureId[] = Object.keys(FEATURES) as FeatureId[];

/** True when `id` is a registered feature (a deep link may carry any string). */
export function isKnownFeature(id: string): id is FeatureId {
  return Object.prototype.hasOwnProperty.call(FEATURES, id);
}

// ---------------------------------------------------------------- snapshot lookups

/** Status of one level; 'locked' when it is not in the snapshot at all. */
export function levelStatus(levelId: string, snapshot: ProgressSnapshot): LevelStatus {
  return snapshot.levels[levelId]?.status ?? 'locked';
}

/** A level can be opened (sung) iff it is the current level or already passed; never while locked. */
export function isLevelOpenable(levelId: string, snapshot: ProgressSnapshot): boolean {
  const s = levelStatus(levelId, snapshot);
  return s === 'current' || s === 'passed';
}

/** True when the world is open (its gate level was passed). */
export function isWorldUnlocked(worldId: WorldId, snapshot: ProgressSnapshot): boolean {
  return snapshot.worldsUnlocked.includes(worldId);
}

function isRequirementMet(req: Requirement, snapshot: ProgressSnapshot): boolean {
  switch (req.kind) {
    case 'start':
      return true;
    case 'worldUnlocked':
      return req.ref !== undefined && isWorldUnlocked(req.ref as WorldId, snapshot);
    case 'levelPassed':
      // No ref = "any level passed" (the first-level-passed features).
      if (req.ref === undefined) return Object.values(snapshot.levels).some((l) => l.status === 'passed');
      return levelStatus(req.ref, snapshot) === 'passed';
  }
}

/** Is `id` unlocked for this profile? Unknown ids are locked. */
export function isFeatureUnlocked(id: FeatureId, snapshot: ProgressSnapshot): boolean {
  const req = isKnownFeature(id) ? FEATURES[id] : undefined;
  return req !== undefined && isRequirementMet(req, snapshot);
}

/** The unlocked feature ids, in registry order. */
export function unlockedFeatures(snapshot: ProgressSnapshot): FeatureId[] {
  return FEATURE_IDS.filter((id) => isFeatureUnlocked(id, snapshot));
}

/** The one-line "Pass X to unlock" caption for a feature (SPEC §11.1). */
export function requirementHint(id: FeatureId): string {
  return isKnownFeature(id) ? FEATURES[id].hint : 'Not available.';
}

// ---------------------------------------------------------------- worlds, bosses, songs

function worldById(worlds: readonly WorldDef[], worldId: string): WorldDef | undefined {
  return worlds.find((w) => w.id === worldId);
}

function orderedLevels(world: WorldDef): LevelDef[] {
  return [...world.levels].sort((a, b) => a.index - b.index);
}

function findLevel(worlds: readonly WorldDef[], levelId: string): { world: WorldDef; level: LevelDef } | undefined {
  for (const world of worlds) {
    const level = world.levels.find((l) => l.id === levelId);
    if (level) return { world, level };
  }
  return undefined;
}

/** A world's Boss Recital: its (last) level of kind 'boss'; null when the world has none (Song Stage). */
export function bossLevelOf(worlds: readonly WorldDef[], worldId: WorldId): LevelDef | null {
  const world = worldById(worlds, worldId);
  if (!world) return null;
  let boss: LevelDef | null = null;
  for (const l of world.levels) if (l.kind === 'boss' && (boss === null || l.index > boss.index)) boss = l;
  return boss;
}

/**
 * The world the singer is working through: the furthest OPEN world that has a current level;
 * when everything open is passed, the last open world with levels; null when none has levels.
 */
export function currentWorldOf(snapshot: ProgressSnapshot, worlds: readonly WorldDef[]): WorldDef | null {
  let withCurrent: WorldDef | null = null;
  let lastOpen: WorldDef | null = null;
  for (const w of worlds) {
    if (!isWorldUnlocked(w.id, snapshot) || w.levels.length === 0) continue;
    lastOpen = w;
    if (w.levels.some((l) => levelStatus(l.id, snapshot) === 'current')) withCurrent = w;
  }
  return withCurrent ?? lastOpen;
}

/** The level in progress in a world (its frontier); null when the world is closed or finished. */
export function currentLevelOf(worldId: WorldId, snapshot: ProgressSnapshot, worlds: readonly WorldDef[]): LevelDef | null {
  const world = worldById(worlds, worldId);
  return world ? (orderedLevels(world).find((l) => levelStatus(l.id, snapshot) === 'current') ?? null) : null;
}

/** Where a "Continue" button goes: the current level of the current world; null once everything is passed. */
export function continueLevel(snapshot: ProgressSnapshot, worlds: readonly WorldDef[]): LevelDef | null {
  const world = currentWorldOf(snapshot, worlds);
  return world ? currentLevelOf(world.id, snapshot, worlds) : null;
}

/**
 * Is a song open? SPEC §11.2: it opens when the world its rated difficulty requires has had its
 * Boss Recital PASSED (merely reaching that world is not enough). Call as
 * `isSongUnlocked(song.difficulty.requiredWorld, snapshot, worlds)`. A world without a Boss
 * Recital (Song Stage) counts once it is open; an unknown world is locked.
 */
export function isSongUnlocked(requiredWorld: WorldId, snapshot: ProgressSnapshot, worlds: readonly WorldDef[]): boolean {
  if (!worldById(worlds, requiredWorld)) return false;
  const boss = bossLevelOf(worlds, requiredWorld);
  if (boss) return levelStatus(boss.id, snapshot) === 'passed';
  return isWorldUnlocked(requiredWorld, snapshot);
}

// ---------------------------------------------------------------- exercises, auditions, records

/**
 * True when the world's Range finder has been SUNG: passed by a real attempt, never granted by an audition.
 * A world without a Range finder has nothing to wait for.
 */
function isRangeFinderSung(world: WorldDef, snapshot: ProgressSnapshot): boolean {
  if (!world.levels.some((l) => l.id === LEVEL_REFS.rangeFinder)) return true;
  const range = snapshot.levels[LEVEL_REFS.rangeFinder];
  return range?.status === 'passed' && !range.viaAudition;
}

/**
 * The audition exercise to sing next in a world's placement audition, or null when none can be offered.
 * The tests are sung IN ORDER and the run stops at the first miss (each one judges only the skills past the
 * previous test's reach, auditions.ts), so this is the first test that still has an unpassed level to grant:
 * a failed test stays next (retake it), a passed one closes. It is null when the world is closed or has no
 * audition, when every level the tests cover is passed, and, in the world that holds the Range finder, until
 * the Range finder has been sung (it sets the saved range, so an audition can neither skip it nor come before
 * it). A test that reaches nothing new (an id outside the world, or not past the earlier tests) is never offered.
 */
export function nextAuditionExercise(worldId: WorldId, snapshot: ProgressSnapshot, worlds: readonly WorldDef[]): string | null {
  const world = worldById(worlds, worldId);
  if (!world?.audition || !isWorldUnlocked(worldId, snapshot) || !isRangeFinderSung(world, snapshot)) return null;
  const ordered = orderedLevels(world);
  for (const { exerciseId, first, last } of auditionSpans(world.audition, ordered)) {
    for (let i = first; i <= last; i++) if (levelStatus(ordered[i].id, snapshot) !== 'passed') return exerciseId;
  }
  return null;
}

/** Can the singer take this world's placement audition now? Exactly when there is a test to sing next. */
export function isAuditionAvailable(worldId: WorldId, snapshot: ProgressSnapshot, worlds: readonly WorldDef[]): boolean {
  return nextAuditionExercise(worldId, snapshot, worlds) !== null;
}

/**
 * Can this exercise be opened? A level's exercise opens with its level; an audition exercise only when it is
 * the audition's NEXT test (a deep link to a later test is refused: one short test must not pass the skills of
 * the levels before it); a built-in routine with the daily-workout feature. Anything else (an unknown or
 * imported id) is locked.
 */
export function isExerciseOpenable(exerciseId: string, snapshot: ProgressSnapshot, worlds: readonly WorldDef[]): boolean {
  if (isRoutineExerciseId(exerciseId)) return isFeatureUnlocked('daily-workout', snapshot);
  for (const world of worlds) {
    const level = world.levels.find((l) => l.exerciseId === exerciseId);
    if (level) return isLevelOpenable(level.id, snapshot);
    if (world.audition?.exerciseIds.includes(exerciseId)) return nextAuditionExercise(world.id, snapshot, worlds) === exerciseId;
  }
  return false;
}

/** Personal-record attempts are allowed on an exercise once its level is PASSED (SPEC §11.2). */
export function isRecordAttemptAllowed(exerciseId: string, snapshot: ProgressSnapshot, worlds: readonly WorldDef[]): boolean {
  for (const world of worlds) {
    const level = world.levels.find((l) => l.exerciseId === exerciseId);
    if (level) return levelStatus(level.id, snapshot) === 'passed';
  }
  return false;
}

// ---------------------------------------------------------------- requirement lines for locked tiles

/** "Sustain II", or "the Foundations Boss Recital" for a boss. */
function describeLevel(world: WorldDef, level: LevelDef): string {
  return level.kind === 'boss' ? `the ${world.title} Boss Recital` : level.title;
}

/** One line saying how to open a world; null when it is already open (or open from the start). */
export function worldRequirementHint(worldId: WorldId, snapshot: ProgressSnapshot, worlds: readonly WorldDef[]): string | null {
  const world = worldById(worlds, worldId);
  if (!world || isWorldUnlocked(worldId, snapshot) || world.unlockedBy === null) return null;
  const gate = findLevel(worlds, world.unlockedBy);
  return gate ? `Pass ${describeLevel(gate.world, gate.level)} to unlock ${world.title}.` : 'Not available yet.';
}

/** One line saying how to open a level ("Pass Sustain II to unlock."); null when it is openable or unknown. */
export function levelRequirementHint(levelId: string, snapshot: ProgressSnapshot, worlds: readonly WorldDef[]): string | null {
  const found = findLevel(worlds, levelId);
  if (!found || isLevelOpenable(levelId, snapshot)) return null;
  if (!isWorldUnlocked(found.world.id, snapshot)) return worldRequirementHint(found.world.id, snapshot, worlds);
  const current = orderedLevels(found.world).find((l) => levelStatus(l.id, snapshot) === 'current');
  return current ? `Pass ${describeLevel(found.world, current)} to unlock.` : 'Pass the earlier levels to unlock.';
}

/**
 * One line saying why a world's audition cannot be taken yet: its world is shut, or (Foundations) the Range
 * finder has not been sung. Null when it can be taken, when it has nothing left to unlock, or when the world
 * has no audition.
 */
export function auditionRequirementHint(worldId: WorldId, snapshot: ProgressSnapshot, worlds: readonly WorldDef[]): string | null {
  const world = worldById(worlds, worldId);
  if (!world?.audition) return null;
  if (!isWorldUnlocked(worldId, snapshot)) return worldRequirementHint(worldId, snapshot, worlds);
  const range = world.levels.find((l) => l.id === LEVEL_REFS.rangeFinder);
  return range && !isRangeFinderSung(world, snapshot) ? `Pass ${describeLevel(world, range)} to unlock the audition.` : null;
}

/** One line saying how to open a song of the given required world; null when it is open. */
export function songRequirementHint(requiredWorld: WorldId, snapshot: ProgressSnapshot, worlds: readonly WorldDef[]): string | null {
  if (isSongUnlocked(requiredWorld, snapshot, worlds)) return null;
  const world = worldById(worlds, requiredWorld);
  if (!world) return 'Not available yet.';
  if (bossLevelOf(worlds, requiredWorld)) return `Pass the ${world.title} Boss Recital to unlock this song.`;
  return worldRequirementHint(requiredWorld, snapshot, worlds) ?? 'Not available yet.';
}
