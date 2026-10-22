/**
 * A fixed ring of the most recent engine frames, for the throttled live analyzers. Frames are held BY REFERENCE: the
 * engine hands out one immutable object per frame (TakeRecorder relies on the same), so pushing one is a single array
 * write, with no allocation and no copying, at ~94 Hz. `since` builds a window for an analyzer: that allocates one
 * small array, a few times a second, never per frame (docs/ARCHITECTURE.md "Performance rules").
 */
import type { PitchFrame } from '../../core/types';

export interface FrameRing {
  /** Add the newest frame. Frame times must not go backwards; the caller clears the ring when they do. */
  push(frame: PitchFrame): void;
  /** Frames held. */
  readonly count: number;
  /** Time of the newest frame; -Infinity when empty. */
  readonly latestT: number;
  /** The held frames with `t >= fromT`, oldest first. */
  since(fromT: number): PitchFrame[];
  clear(): void;
}

export function createFrameRing(capacity: number): FrameRing {
  const cap = Math.max(1, Math.floor(capacity));
  const slots: Array<PitchFrame | undefined> = new Array<PitchFrame | undefined>(cap);
  let write = 0;
  let size = 0;
  let latestT = -Infinity;

  /** The frame at logical index `i`, 0 = oldest. */
  const at = (i: number): PitchFrame => slots[(write - size + i + cap * 2) % cap] as PitchFrame;

  return {
    push(frame: PitchFrame): void {
      slots[write] = frame;
      write = (write + 1) % cap;
      if (size < cap) size++;
      latestT = frame.t;
    },
    get count(): number {
      return size;
    },
    get latestT(): number {
      return latestT;
    },
    since(fromT: number): PitchFrame[] {
      let lo = 0;
      let hi = size;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (at(mid).t < fromT) lo = mid + 1;
        else hi = mid;
      }
      const out: PitchFrame[] = new Array<PitchFrame>(size - lo);
      for (let i = lo; i < size; i++) out[i - lo] = at(i);
      return out;
    },
    clear(): void {
      slots.fill(undefined);
      write = 0;
      size = 0;
      latestT = -Infinity;
    },
  };
}
