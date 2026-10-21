/**
 * Preallocated circular buffer of display samples (one slot per pushed
 * frame): input-timeline time, display-smoothed MIDI, and voiced flag.
 * Backs the scrolling trace. `push` and the `*At` readers never allocate, so
 * the render loop can walk any time window without generating garbage.
 */
import { CONFIG } from '../../config';

export interface TrackRing {
  readonly capacity: number;
  /** Number of valid samples currently held (<= capacity). */
  readonly length: number;
  /** Logical index of the most recently pushed sample, or -1 when empty. */
  readonly latest: number;
  push(t: number, midi: number, voiced: boolean): void;
  /** Input-timeline time at logical index `i` (0 = oldest). */
  tAt(i: number): number;
  /** Display-smoothed MIDI at logical index `i`; NaN when that sample was unvoiced. */
  midiAt(i: number): number;
  voicedAt(i: number): boolean;
  /**
   * First logical index whose time is >= `fromT` (binary search over the
   * ascending `t` sequence). Returns `length` when every sample is older.
   */
  lowerBound(fromT: number): number;
  clear(): void;
}

/** Frames/s used only to size the default capacity (CONFIG.display.pastSeconds + 2s headroom). */
const DEFAULT_SIZING_FPS = 120;

/** Default capacity: pastSeconds of history plus 2s headroom, at DEFAULT_SIZING_FPS. */
export function defaultTrackRingCapacity(pastSeconds: number = CONFIG.display.pastSeconds): number {
  return Math.ceil((pastSeconds + 2) * DEFAULT_SIZING_FPS);
}

export function createTrackRing(capacity: number = defaultTrackRingCapacity()): TrackRing {
  const cap = Math.max(1, Math.floor(capacity));
  const tBuf = new Float64Array(cap);
  const midiBuf = new Float32Array(cap);
  const voicedBuf = new Uint8Array(cap);
  let writeIndex = 0;
  let count = 0;

  function physicalIndex(i: number): number {
    const start = (writeIndex - count + cap) % cap;
    return (start + i) % cap;
  }

  function push(t: number, midi: number, voiced: boolean): void {
    tBuf[writeIndex] = t;
    midiBuf[writeIndex] = midi;
    voicedBuf[writeIndex] = voiced ? 1 : 0;
    writeIndex = (writeIndex + 1) % cap;
    if (count < cap) count++;
  }

  function tAt(i: number): number {
    return tBuf[physicalIndex(i)];
  }
  function midiAt(i: number): number {
    return midiBuf[physicalIndex(i)];
  }
  function voicedAt(i: number): boolean {
    return voicedBuf[physicalIndex(i)] !== 0;
  }

  function lowerBound(fromT: number): number {
    let lo = 0;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (tAt(mid) < fromT) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function clear(): void {
    writeIndex = 0;
    count = 0;
  }

  return {
    capacity: cap,
    get length() {
      return count;
    },
    get latest() {
      return count - 1;
    },
    push,
    tAt,
    midiAt,
    voicedAt,
    lowerBound,
    clear,
  };
}
