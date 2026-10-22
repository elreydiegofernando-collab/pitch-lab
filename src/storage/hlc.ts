/**
 * Hybrid logical clock for `RecordBase.updatedAt` (schema.ts). Combines wall-clock
 * time with a logical counter so timestamps stay monotonic even when the system
 * clock jumps backward (DST, NTP, a user-set clock), and merge cleanly when two
 * devices' histories combine (backup import).
 *
 * Format: `<wallMs base36, 9 chars>-<counter base36, 5 chars>-<deviceId, 8 chars>`.
 * Every field is fixed-width, so the whole string sorts lexicographically exactly
 * like the (wallMs, counter, deviceId) tuple would - schema.ts's ordering promise.
 */
import { newShortId } from './ids';

const WALL_WIDTH = 9; // base36^9 ~= 1.0e14 ms, comfortably past any real wall-clock value
const COUNTER_WIDTH = 5; // base36^5 ~= 60.5M ticks/ms before the overflow guard below fires
const DEVICE_WIDTH = 8;
const COUNTER_MAX = Math.pow(36, COUNTER_WIDTH) - 1;
const WALL_MAX = Math.pow(36, WALL_WIDTH) - 1;
const HLC_RE = /^([0-9a-z]{9})-([0-9a-z]{5})-([0-9a-z]{8})$/;

/**
 * A remote timestamp more than this far ahead of local real time is treated as
 * corrupt rather than merged: trusting it would pin this device's clock in the
 * far future forever. A year is generous for a phone with a wrong date, and
 * still stops a damaged or hostile backup from poisoning the clock.
 */
export const HLC_MAX_REMOTE_SKEW_MS = 366 * 24 * 60 * 60 * 1000;

export interface HlcTimestamp {
  wallMs: number;
  counter: number;
  deviceId: string;
}

/** Persistable clock state - everything but the deviceId, which is fixed per device. */
export interface HlcState {
  wallMs: number;
  counter: number;
}

function pad36(n: number, width: number): string {
  return n.toString(36).padStart(width, '0');
}

function clampInt(n: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(0, Math.floor(n))) : 0;
}

/** Lower-cases and strips a device id down to the [0-9a-z]{8} the format requires. */
function normaliseDeviceId(deviceId: string): string {
  return deviceId.toLowerCase().replace(/[^0-9a-z]/g, '').padEnd(DEVICE_WIDTH, '0').slice(0, DEVICE_WIDTH);
}

/** Formats a timestamp triple as the string stored in `updatedAt`. Out-of-range fields are clamped, never overflowed. */
export function formatHlc(ts: HlcTimestamp): string {
  return `${pad36(clampInt(ts.wallMs, WALL_MAX), WALL_WIDTH)}-${pad36(clampInt(ts.counter, COUNTER_MAX), COUNTER_WIDTH)}-${normaliseDeviceId(ts.deviceId)}`;
}

/** Parses a formatted HLC string back into its parts, or null if it isn't one. */
export function parseHlc(ts: string): HlcTimestamp | null {
  if (typeof ts !== 'string') return null;
  const m = HLC_RE.exec(ts);
  if (!m) return null;
  return { wallMs: parseInt(m[1], 36), counter: parseInt(m[2], 36), deviceId: m[3] };
}

/** String comparison already orders two HLC timestamps correctly; this just reads better at call sites. */
export function compareHlc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The later of two HLC timestamps. */
export function maxHlc(a: string, b: string): string {
  return compareHlc(a, b) >= 0 ? a : b;
}

/** True when `ts` parses as a well-formed HLC timestamp. */
export function isHlc(ts: unknown): ts is string {
  return typeof ts === 'string' && HLC_RE.test(ts);
}

/**
 * True when `ts` is well-formed and not further ahead of `nowMs` than `maxSkewMs`.
 * The import path rejects anything else (see HLC_MAX_REMOTE_SKEW_MS).
 */
export function isPlausibleHlc(ts: unknown, nowMs: number, maxSkewMs: number = HLC_MAX_REMOTE_SKEW_MS): boolean {
  if (typeof ts !== 'string') return false;
  const parsed = parseHlc(ts);
  return parsed !== null && parsed.wallMs <= nowMs + maxSkewMs;
}

/** Reads persisted clock state defensively: anything malformed becomes the zero state. */
export function sanitizeHlcState(raw: unknown): HlcState {
  const r = raw as { wallMs?: unknown; counter?: unknown } | null | undefined;
  if (!r || typeof r.wallMs !== 'number' || typeof r.counter !== 'number') return { wallMs: 0, counter: 0 };
  return { wallMs: clampInt(r.wallMs, WALL_MAX), counter: clampInt(r.counter, COUNTER_MAX) };
}

/** A random per-device id for the HLC's tie-breaking field. Persist it (storage/db.ts
 *  meta store) so a device's identity - and therefore its tie-break order - is stable
 *  across sessions. */
export function randomDeviceId(): string {
  return newShortId(DEVICE_WIDTH);
}

/**
 * A hybrid logical clock for one device. `next()` stamps a local write; `receive()`
 * folds in a remote timestamp (import/merge) so later local writes sort after
 * everything already seen, from any device. Both are pure/sync and take an
 * injectable `now` so clock-regression behaviour is deterministic in tests.
 */
export class Hlc {
  private wallMs: number;
  private counter: number;
  private readonly device: string;

  constructor(
    deviceId: string,
    initial: HlcState = { wallMs: 0, counter: 0 },
    private readonly now: () => number = Date.now,
    private readonly maxSkewMs: number = HLC_MAX_REMOTE_SKEW_MS,
  ) {
    const state = sanitizeHlcState(initial);
    this.wallMs = state.wallMs;
    this.counter = state.counter;
    this.device = normaliseDeviceId(deviceId);
  }

  /** Current state, for persisting across sessions (storage/db.ts piggybacks it on every record write). */
  snapshot(): HlcState {
    return { wallMs: this.wallMs, counter: this.counter };
  }

  /** Real wall-clock ms, floored; 0 if the injected clock misbehaves (NaN, throws). */
  private physical(): number {
    try {
      const p = Math.floor(this.now());
      return Number.isFinite(p) && p > 0 ? Math.min(p, WALL_MAX) : 0;
    } catch {
      return 0;
    }
  }

  private format(): string {
    return formatHlc({ wallMs: this.wallMs, counter: this.counter, deviceId: this.device });
  }

  /** Next timestamp for a local write. Monotonic even when `now()` goes backward or repeats. */
  next(): string {
    const physical = this.physical();
    if (physical > this.wallMs) {
      this.wallMs = physical;
      this.counter = 0;
    } else {
      this.bumpCounter();
    }
    return this.format();
  }

  /**
   * Merges a remote timestamp (e.g. backup import) and returns a fresh local timestamp
   * guaranteed to sort after both the remote one and everything seen locally so far.
   * A remote that is unparseable, or implausibly far ahead (HLC_MAX_REMOTE_SKEW_MS), is
   * ignored: the call then behaves like `next()`.
   */
  receive(remoteTs: string): string {
    const physical = this.physical();
    const parsed = parseHlc(remoteTs);
    const remote = parsed && parsed.wallMs <= physical + this.maxSkewMs ? parsed : null;
    const maxWall = Math.max(physical, this.wallMs, remote ? remote.wallMs : 0);
    if (remote && maxWall === this.wallMs && maxWall === remote.wallMs) {
      this.counter = Math.max(this.counter, remote.counter);
      this.bumpCounter();
    } else if (maxWall === this.wallMs) {
      this.bumpCounter();
    } else if (remote && maxWall === remote.wallMs) {
      this.wallMs = maxWall;
      this.counter = remote.counter;
      this.bumpCounter();
    } else {
      this.wallMs = maxWall;
      this.counter = 0;
    }
    return this.format();
  }

  /** Counter-overflow guard: instead of wrapping, advance the wall field 1ms ahead of real
   *  time. Bounded drift is the standard HLC trade-off for an unbounded local write rate.
   *  Right at the format's absolute ceiling (WALL_MAX - only reachable via a crafted or
   *  corrupted persisted state; real wall-clock time cannot reach it until ~year 5138)
   *  this saturates instead of advancing, so the wall field can never grow past its fixed
   *  width - which would silently break the whole-string lexicographic ordering. */
  private bumpCounter(): void {
    if (this.counter >= COUNTER_MAX) {
      if (this.wallMs < WALL_MAX) {
        this.wallMs += 1;
        this.counter = 0;
      }
    } else {
      this.counter += 1;
    }
  }
}

export function createHlc(deviceId: string, initial?: HlcState, now?: () => number, maxSkewMs?: number): Hlc {
  return new Hlc(deviceId, initial, now, maxSkewMs);
}
