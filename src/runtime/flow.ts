/**
 * What a take report offers next, and what a take unlocked.
 *
 * FEATURE_TITLES: short human names for the registry's features, used by unlock strips and locked tiles.
 * afterTakeActions: the report's buttons, exactly one primary, each opened with router.replace (so Back from the
 * next screen skips the report). unlockEvents: what changed between the snapshots around a take, for the one
 * celebratory moment (DESIGN.md §9).
 */
import { WORLDS, getLevel, nextLevel, worldsUnlockedBy } from '../exercises';
import type { LevelDef, WorldDef } from '../exercises/types';
import { LEVEL_REFS, auditionSpans, isLevelOpenable, isSongUnlocked, nextAuditionExercise } from '../progress';
import type { FeatureId, LevelProgress, ProgressSnapshot } from '../progress/types';
import { routeOf, type Route } from '../router';
import { songIndex } from '../state/songs';
import { paramsForTarget } from './targets';
import type { AfterTakeAction, RunTarget, TakeOutcome, UnlockEvent } from './types';

export const FEATURE_TITLES: Readonly<Record<FeatureId, string>> = {
  'live.basic': 'Live pitch monitor',
  'live.cracks': 'Crack markers on the Live trace',
  'live.onset': 'Settle and scoop readouts',
  'live.vibrato': 'Vibrato readouts on the Live trace',
  'tool.vibrato-meter': 'Vibrato meter',
  'setting.vibratoStyle': 'Vibrato style setting',
  dashboard: 'Progress dashboard',
  'daily-workout': 'Daily workout',
  'song-stage': 'Song Stage',
  'song.import': 'Import your own songs',
  records: 'Personal records',
  export: 'Backup and export',
};

const byIndex = (a: LevelDef, b: LevelDef): number => a.index - b.index;

/** "Sustain II", or "Foundations Boss Recital" for a boss (every boss level is titled "Boss Recital"). */
function levelTitle(level: LevelDef, world: WorldDef | undefined): string {
  return level.kind === 'boss' && world ? `${world.title} Boss Recital` : level.title;
}

export interface AuditionTest {
  exerciseId: string;
  /** 0-based place in the run (the order the tests are sung in). */
  index: number;
  /** Titles of the first and last level the test unlocks ("unlocks Pitch match – Sustain II"). */
  unlocksFirst: string;
  unlocksLast: string;
}

/**
 * A world's placement-audition tests in sung order, with the levels each one unlocks (progress auditionSpans, so a
 * test that reaches nothing new is left out). The Range finder is always sung, never granted, so a span that starts
 * on it is captioned from the level after it. Empty for a world without an audition.
 */
export function auditionTests(world: WorldDef): AuditionTest[] {
  if (!world.audition) return [];
  const ordered = [...world.levels].sort(byIndex);
  return auditionSpans(world.audition, ordered).map((span, index) => {
    let first = span.first;
    while (first < span.last && ordered[first].id === LEVEL_REFS.rangeFinder) first += 1;
    return { exerciseId: span.exerciseId, index, unlocksFirst: ordered[first].title, unlocksLast: ordered[span.last].title };
  });
}

/**
 * Where "Next level" goes after passing `levelId`: the next level of its world, or after a Boss Recital the first
 * level of the world it opened; null when there is none or it is not openable (nothing is offered that the guard
 * would refuse).
 */
function nextOpenLevel(levelId: string, after: ProgressSnapshot): LevelDef | null {
  const next = nextLevel(levelId);
  if (next) return isLevelOpenable(next.id, after) ? next : null;
  if (getLevel(levelId)?.kind !== 'boss') return null;
  for (const world of worldsUnlockedBy(levelId)) {
    const first = [...world.levels].sort(byIndex)[0];
    if (first && isLevelOpenable(first.id, after)) return first;
  }
  return null;
}

function action(kind: AfterTakeAction['kind'], label: string, primary: boolean, route: Route): AfterTakeAction {
  return { kind, label, primary, route };
}

function singRoute(target: RunTarget): Route {
  return routeOf('sing', paramsForTarget(target));
}

/**
 * The report's actions for this outcome, exactly one primary. Level: pass -> "Next level" (primary; "World map"
 * when there is no next level) + "Retry"; miss -> "Retry" (primary) + "Back to level". A tempo-ladder take below the
 * pass tempo is a miss of the LEVEL even when it climbed a rung: "Retry" sings the next take at the new rung.
 * Audition: pass with a next test -> "Next test" (+ "See your placement" to stop there); miss or last test ->
 * "See your placement". Workout: "Next take" / "Next item" / "Finish workout", with the next step as a secondary.
 * Record: "Retry" + "Back to level".
 */
export function afterTakeActions(outcome: TakeOutcome): AfterTakeAction[] {
  const target = outcome.prepared.target;
  const passed = outcome.attempt.passed;
  switch (target.kind) {
    case 'level': {
      const retry = action('retry', 'Retry', !passed, singRoute(target));
      if (!passed) return [retry, action('level', 'Back to level', false, routeOf('level', { levelId: target.levelId }))];
      const next = nextOpenLevel(target.levelId, outcome.after);
      if (next) return [action('next-level', 'Next level', true, routeOf('level', { levelId: next.id })), retry];
      const worldId = getLevel(target.levelId)?.worldId;
      return [action('map', 'World map', true, worldId ? routeOf('map', { worldId }) : routeOf('map')), retry];
    }
    case 'record':
      return [action('retry', 'Retry', true, singRoute(target)), action('level', 'Back to level', false, routeOf('level', { levelId: target.levelId }))];
    case 'audition': {
      const results = (primary: boolean) => action('audition-results', 'See your placement', primary, routeOf('audition', { worldId: target.worldId }));
      if (passed && nextAuditionExercise(target.worldId, outcome.after, WORLDS) !== null) {
        return [action('next-test', 'Next test', true, singRoute(target)), results(false)];
      }
      return [results(true)];
    }
    case 'workout': {
      const finish = (primary: boolean) => action('finish-workout', 'Finish workout', primary, routeOf('workout'));
      const w = outcome.prepared.workout;
      if (!w) return [finish(true)];
      const last = w.itemIndex + 1 >= w.itemCount;
      const nextItem = (primary: boolean) =>
        last ? finish(primary) : action('next-item', 'Next item', primary, singRoute({ kind: 'workout', itemIndex: w.itemIndex + 1 }));
      if (w.take < w.item.takes) return [action('next-take', 'Next take', true, singRoute(target)), nextItem(false)];
      return last ? [finish(true)] : [nextItem(true), finish(false)];
    }
  }
}

function newlyPassed(before: LevelProgress | undefined, after: LevelProgress): boolean {
  return after.status === 'passed' && before?.status !== 'passed';
}

/**
 * What changed between two snapshots of the same profile, in display order: levels passed (by a sung take), higher
 * mastery on levels already passed, levels that became playable (the next level, or a span granted by an audition
 * test), worlds that opened, features that unlocked, and songs that opened (counted in the song index by the world
 * their difficulty requires). Song Stage has no levels, so its opening is told by its feature and its songs.
 */
export function unlockEvents(before: ProgressSnapshot, after: ProgressSnapshot, worlds: readonly WorldDef[]): UnlockEvent[] {
  const passed: UnlockEvent[] = [];
  const mastery: UnlockEvent[] = [];
  const opened: UnlockEvent[] = [];
  for (const world of worlds) {
    for (const level of [...world.levels].sort(byIndex)) {
      const b = before.levels[level.id];
      const a = after.levels[level.id];
      if (!a) continue;
      const title = levelTitle(level, world);
      if (newlyPassed(b, a)) {
        if (a.viaAudition) opened.push({ kind: 'level-opened', levelId: level.id, title });
        else passed.push({ kind: 'level-passed', levelId: level.id, title, mastery: a.mastery });
      } else if (a.status === 'passed' && a.mastery > (b?.mastery ?? 0)) {
        mastery.push({ kind: 'mastery', levelId: level.id, title, mastery: a.mastery });
      } else if (a.status === 'current' && (b === undefined || b.status === 'locked')) {
        opened.push({ kind: 'level-opened', levelId: level.id, title });
      }
    }
  }

  const worldEvents: UnlockEvent[] = [];
  for (const id of after.worldsUnlocked) {
    if (before.worldsUnlocked.includes(id)) continue;
    const world = worlds.find((w) => w.id === id);
    if (world && world.levels.length > 0) worldEvents.push({ kind: 'world-opened', worldId: world.id, title: world.title });
  }

  const features: UnlockEvent[] = [];
  for (const id of after.features) {
    if (before.features.includes(id) || !Object.prototype.hasOwnProperty.call(FEATURE_TITLES, id)) continue;
    const featureId = id as FeatureId;
    features.push({ kind: 'feature', featureId, title: FEATURE_TITLES[featureId] });
  }

  const songs: UnlockEvent[] = [];
  const index = songIndex.value;
  for (const world of worlds) {
    if (isSongUnlocked(world.id, before, worlds) || !isSongUnlocked(world.id, after, worlds)) continue;
    let count = 0;
    for (const song of index.values()) if (song.difficulty.requiredWorld === world.id) count += 1;
    if (count > 0) songs.push({ kind: 'songs', requiredWorld: world.id, count });
  }

  return [...passed, ...mastery, ...opened, ...worldEvents, ...features, ...songs];
}
