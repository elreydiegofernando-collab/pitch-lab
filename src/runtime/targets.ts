/**
 * RunTarget <-> 'sing' route params. Pure; part of the Wave 2 contract (orchestrator-owned).
 */
import type { WorldId } from '../exercises/types';
import type { RouteParams } from '../router';
import type { RunTarget } from './types';

const WORLD_IDS: ReadonlySet<string> = new Set<WorldId>(['foundations', 'vibrato', 'inflections', 'runs', 'dynamics', 'song-stage']);

/** The 'sing' route params for a target. */
export function paramsForTarget(target: RunTarget): RouteParams['sing'] {
  switch (target.kind) {
    case 'level':
    case 'record':
      return { target: target.kind, levelId: target.levelId };
    case 'audition':
      return { target: 'audition', worldId: target.worldId };
    case 'workout':
      return { target: 'workout', itemIndex: String(target.itemIndex) };
    case 'checkup':
      return { target: 'checkup', itemIndex: String(target.taskIndex) };
    case 'drill':
      return { target: 'drill', levelId: target.levelId, itemIndex: String(target.step) };
  }
}

/** The target named by 'sing' route params; null when they are malformed (the guard then refuses). */
export function targetFromParams(params: Readonly<RouteParams['sing']>): RunTarget | null {
  switch (params.target) {
    case 'level':
    case 'record':
      return params.levelId ? { kind: params.target, levelId: params.levelId } : null;
    case 'audition':
      return params.worldId && WORLD_IDS.has(params.worldId) ? { kind: 'audition', worldId: params.worldId as WorldId } : null;
    case 'workout':
    case 'checkup': {
      const raw = params.itemIndex;
      if (raw === undefined || !/^\d{1,4}$/.test(raw)) return null;
      return params.target === 'workout' ? { kind: 'workout', itemIndex: Number(raw) } : { kind: 'checkup', taskIndex: Number(raw) };
    }
    case 'drill': {
      const raw = params.itemIndex;
      if (!params.levelId || raw === undefined || !/^\d{1,3}$/.test(raw)) return null;
      return { kind: 'drill', levelId: params.levelId, step: Number(raw) };
    }
    default:
      return null;
  }
}

/** A stable key for a target (remount the Sing screen when it changes). */
export function targetKey(target: RunTarget): string {
  switch (target.kind) {
    case 'level':
    case 'record':
      return `${target.kind}:${target.levelId}`;
    case 'audition':
      return `audition:${target.worldId}`;
    case 'workout':
      return `workout:${target.itemIndex}`;
    case 'checkup':
      return `checkup:${target.taskIndex}`;
    case 'drill':
      return `drill:${target.levelId}:${target.step}`;
  }
}
