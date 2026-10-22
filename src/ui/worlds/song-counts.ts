/** How many songs of the library are open for this singer (SPEC 11.2: a song opens with the Boss Recital of its required world). */
import type { WorldDef } from '../../exercises/types';
import { isSongUnlocked, type ProgressSnapshot } from '../../progress';
import type { SongEntry } from '../../state/songs';

export interface SongCounts {
  open: number;
  locked: number;
}

export function songCounts(entries: Iterable<SongEntry>, snapshot: ProgressSnapshot, worlds: readonly WorldDef[]): SongCounts {
  let open = 0;
  let locked = 0;
  for (const entry of entries) {
    if (isSongUnlocked(entry.difficulty.requiredWorld, snapshot, worlds)) open += 1;
    else locked += 1;
  }
  return { open, locked };
}
