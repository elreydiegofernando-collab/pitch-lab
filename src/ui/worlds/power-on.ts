/**
 * "Power-on" (docs/DESIGN.md 9 and 13.2): after a take opened something, the newly opened node lights up once, with an
 * amber glow fade-in. The take's `unlocked` list says what opened; this module hands each take's nodes out exactly once,
 * so coming back to the map later (or re-rendering it) never replays the glow.
 */
import type { WorldDef } from '../../exercises/types';
import { currentLevelOf, type ProgressSnapshot } from '../../progress';
import type { TakeOutcome } from '../../runtime/types';

const NONE: ReadonlySet<string> = new Set<string>();

let lastTaken: string | null = null;

/**
 * The level ids to power on for `outcome`: levels that became playable (the next level, or levels an audition test
 * granted) and the first level of a world that opened. Each take answers once; every later call returns the empty set.
 */
export function takePowerOn(outcome: TakeOutcome | null, snapshot: ProgressSnapshot, worlds: readonly WorldDef[]): ReadonlySet<string> {
  if (!outcome || outcome.id === lastTaken) return NONE;
  lastTaken = outcome.id;
  const ids = new Set<string>();
  for (const event of outcome.unlocked) {
    if (event.kind === 'level-opened') {
      ids.add(event.levelId);
    } else if (event.kind === 'world-opened') {
      const first = currentLevelOf(event.worldId, snapshot, worlds);
      if (first) ids.add(first.id);
    }
  }
  return ids;
}

/** Test helper: forget which take was handed out. */
export function resetPowerOnForTests(): void {
  lastTaken = null;
}
