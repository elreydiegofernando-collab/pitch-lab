/** Catalog lookups the world screens share (pure). */
import type { LevelDef, WorldDef } from '../../exercises/types';

/** A world's levels in play order (`index` sets the order; the Boss Recital is last). */
export function orderedLevels(world: WorldDef): LevelDef[] {
  return [...world.levels].sort((a, b) => a.index - b.index);
}

/** The world a level belongs to, with the level's 1-based place in it; undefined for an unknown id. */
export function locateLevel(
  worlds: readonly WorldDef[],
  levelId: string,
): { world: WorldDef; level: LevelDef; number: number; total: number } | undefined {
  for (const world of worlds) {
    const levels = orderedLevels(world);
    const at = levels.findIndex((l) => l.id === levelId);
    if (at >= 0) return { world, level: levels[at], number: at + 1, total: levels.length };
  }
  return undefined;
}
