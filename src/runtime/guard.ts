/**
 * The route guard (SPEC §11.1): a locked item cannot be opened, deep links included. Pure: everything comes from
 * the GuardContext the session builds, and every unknown id is locked. A refusal names where to go instead (the
 * item's requirement: the map at that world, or Home where the locked tile shows its line) and the requirement line.
 *
 * Utility routes never reach this function (router.ts ALWAYS_OPEN), but it answers them too, so it can be tested
 * and reused on its own.
 */
import type { LevelDef, WorldDef, WorldId } from '../exercises/types';
import {
  auditionRequirementHint,
  isAuditionAvailable,
  isFeatureUnlocked,
  isLevelOpenable,
  isRecordAttemptAllowed,
  isSongUnlocked,
  isWorldUnlocked,
  levelRequirementHint,
  requirementHint,
  songRequirementHint,
} from '../progress';
import type { FeatureId } from '../progress/types';
import { ALWAYS_OPEN, routeOf, type GuardVerdict, type Route } from '../router';
import type { GuardContext } from './types';
import { targetFromParams } from './targets';

const OK: GuardVerdict = { ok: true };

function refuse(redirect: Route, hint: string): GuardVerdict {
  return { ok: false, redirect, hint };
}

function findLevel(worlds: readonly WorldDef[], levelId: string): { world: WorldDef; level: LevelDef } | undefined {
  for (const world of worlds) {
    const level = world.levels.find((l) => l.id === levelId);
    if (level) return { world, level };
  }
  return undefined;
}

function isKnownWorld(worlds: readonly WorldDef[], worldId: string): worldId is WorldId {
  return worlds.some((w) => w.id === worldId);
}

/** The map, scrolled to the level's world (or to the current level when the level is unknown). */
function mapAtLevel(worlds: readonly WorldDef[], levelId: string): Route {
  const found = findLevel(worlds, levelId);
  return found ? routeOf('map', { worldId: found.world.id }) : routeOf('map');
}

function levelVerdict(levelId: string, ctx: GuardContext): GuardVerdict {
  if (isLevelOpenable(levelId, ctx.snapshot)) return OK;
  const hint = levelRequirementHint(levelId, ctx.snapshot, ctx.worlds) ?? 'Not available.';
  return refuse(mapAtLevel(ctx.worlds, levelId), hint);
}

function featureVerdict(id: FeatureId, ctx: GuardContext): GuardVerdict {
  return isFeatureUnlocked(id, ctx.snapshot) ? OK : refuse(routeOf('home'), requirementHint(id));
}

function singVerdict(route: Extract<Route, { name: 'sing' }>, ctx: GuardContext): GuardVerdict {
  const target = targetFromParams(route.params);
  if (!target) return refuse(routeOf('map'), 'Not available.');
  switch (target.kind) {
    case 'level':
      return levelVerdict(target.levelId, ctx);
    case 'record': {
      const found = findLevel(ctx.worlds, target.levelId);
      if (!found) return refuse(routeOf('map'), 'Not available.');
      if (isFeatureUnlocked('records', ctx.snapshot) && isRecordAttemptAllowed(found.level.exerciseId, ctx.snapshot, ctx.worlds)) return OK;
      const back = isLevelOpenable(found.level.id, ctx.snapshot) ? routeOf('level', { levelId: found.level.id }) : mapAtLevel(ctx.worlds, found.level.id);
      return refuse(back, `Pass ${found.level.title} to chase personal records on it.`);
    }
    case 'audition': {
      if (!isKnownWorld(ctx.worlds, target.worldId)) return refuse(routeOf('map'), 'Not available.');
      if (isAuditionAvailable(target.worldId, ctx.snapshot, ctx.worlds)) return OK;
      const hint = auditionRequirementHint(target.worldId, ctx.snapshot, ctx.worlds) ?? 'This audition has nothing left to unlock.';
      return refuse(routeOf('map', { worldId: target.worldId }), hint);
    }
    case 'workout': {
      const feature = featureVerdict('daily-workout', ctx);
      if (!feature.ok) return feature;
      const n = ctx.workoutItems;
      if (n !== null && target.itemIndex >= 0 && target.itemIndex < n) return OK;
      return refuse(routeOf('workout'), 'Start a workout first.');
    }
  }
}

function songVerdict(songId: string, ctx: GuardContext): GuardVerdict {
  const stage = featureVerdict('song-stage', ctx);
  if (!stage.ok) return stage;
  if (!ctx.songsLoaded) return refuse(routeOf('songs'), 'Loading the song library.');
  const requiredWorld = ctx.songRequiredWorld(songId);
  if (requiredWorld === undefined) return refuse(routeOf('songs'), 'Song not found.');
  if (isSongUnlocked(requiredWorld, ctx.snapshot, ctx.worlds)) return OK;
  return refuse(routeOf('songs'), songRequirementHint(requiredWorld, ctx.snapshot, ctx.worlds) ?? 'Not available yet.');
}

export function guardRoute(route: Route, ctx: GuardContext): GuardVerdict {
  if (ALWAYS_OPEN.has(route.name)) return OK;
  switch (route.name) {
    case 'level':
      return levelVerdict(route.params.levelId, ctx);
    case 'sing':
      return singVerdict(route, ctx);
    case 'report':
      return ctx.hasOutcome ? OK : refuse(routeOf('map'), 'Sing a take first.');
    case 'audition': {
      // The audition screen is the run's intro and its results: open once the world is (the tests themselves are
      // gated by the 'sing' route above, so nothing can be sung out of order from here).
      const worldId = route.params.worldId;
      if (!isKnownWorld(ctx.worlds, worldId) || !ctx.worlds.find((w) => w.id === worldId)?.audition) return refuse(routeOf('map'), 'Not available.');
      if (isWorldUnlocked(worldId, ctx.snapshot)) return OK;
      return refuse(routeOf('map', { worldId }), auditionRequirementHint(worldId, ctx.snapshot, ctx.worlds) ?? 'Not available yet.');
    }
    case 'vibrato-meter':
      return featureVerdict('tool.vibrato-meter', ctx);
    case 'dashboard':
      return featureVerdict('dashboard', ctx);
    case 'workout':
      return featureVerdict('daily-workout', ctx);
    case 'songs':
      return featureVerdict('song-stage', ctx);
    case 'song-import':
      return featureVerdict('song.import', ctx);
    case 'song':
      return songVerdict(route.params.songId, ctx);
    default:
      // Every always-open route returned above; anything else is unknown and stays shut.
      return refuse(routeOf('home'), 'Not available.');
  }
}
