import { describe, expect, it } from 'vitest';
import {
  HLC_MAX_REMOTE_SKEW_MS,
  compareHlc,
  createHlc,
  formatHlc,
  isHlc,
  isPlausibleHlc,
  maxHlc,
  parseHlc,
  randomDeviceId,
  sanitizeHlcState,
} from './hlc';

const COUNTER_MAX = Math.pow(36, 5) - 1;
const WALL_MAX = Math.pow(36, 9) - 1;

describe('formatHlc / parseHlc', () => {
  it('round-trips a timestamp triple', () => {
    const ts = formatHlc({ wallMs: 1_700_000_000_000, counter: 42, deviceId: 'abcd1234' });
    expect(parseHlc(ts)).toEqual({ wallMs: 1_700_000_000_000, counter: 42, deviceId: 'abcd1234' });
  });

  it('isHlc accepts its own format and rejects junk', () => {
    const ts = formatHlc({ wallMs: 1, counter: 0, deviceId: 'abcd1234' });
    expect(isHlc(ts)).toBe(true);
    expect(isHlc('not-a-timestamp')).toBe(false);
    expect(isHlc(42)).toBe(false);
    expect(parseHlc('not-a-timestamp')).toBeNull();
    expect(parseHlc(undefined as unknown as string)).toBeNull();
  });

  it('pads so equal-width fields sort lexicographically like the numbers they encode', () => {
    const low = formatHlc({ wallMs: 5, counter: 0, deviceId: 'aaaaaaaa' });
    const high = formatHlc({ wallMs: 100, counter: 0, deviceId: 'aaaaaaaa' });
    expect(low < high).toBe(true); // would be false unpadded ("5" > "100" as strings)
    expect(compareHlc(low, high)).toBe(-1);
    expect(compareHlc(high, low)).toBe(1);
    expect(compareHlc(low, low)).toBe(0);
  });

  it('orders by wall, then counter, then device id', () => {
    const a = formatHlc({ wallMs: 10, counter: 1, deviceId: 'zzzzzzzz' });
    const b = formatHlc({ wallMs: 10, counter: 2, deviceId: 'aaaaaaaa' });
    const c = formatHlc({ wallMs: 11, counter: 0, deviceId: 'aaaaaaaa' });
    expect([c, b, a].sort()).toEqual([a, b, c]);
    const d1 = formatHlc({ wallMs: 10, counter: 1, deviceId: 'aaaaaaaa' });
    const d2 = formatHlc({ wallMs: 10, counter: 1, deviceId: 'bbbbbbbb' });
    expect(d1 < d2).toBe(true);
  });

  it('clamps out-of-range fields instead of overflowing the fixed widths', () => {
    expect(parseHlc(formatHlc({ wallMs: -5, counter: -1, deviceId: 'aaaaaaaa' }))).toMatchObject({ wallMs: 0, counter: 0 });
    expect(parseHlc(formatHlc({ wallMs: 12.9, counter: 3.7, deviceId: 'aaaaaaaa' }))).toMatchObject({ wallMs: 12, counter: 3 });
    expect(parseHlc(formatHlc({ wallMs: NaN, counter: Infinity, deviceId: 'aaaaaaaa' }))).toMatchObject({ wallMs: 0, counter: 0 });
    const huge = formatHlc({ wallMs: Number.MAX_SAFE_INTEGER, counter: Number.MAX_SAFE_INTEGER, deviceId: 'aaaaaaaa' });
    expect(huge).toHaveLength(9 + 1 + 5 + 1 + 8);
    expect(parseHlc(huge)).toMatchObject({ wallMs: WALL_MAX, counter: COUNTER_MAX });
  });

  it('normalises a device id to the 8 chars [0-9a-z] the format needs', () => {
    expect(parseHlc(formatHlc({ wallMs: 1, counter: 0, deviceId: 'ABCD-1234!' }))?.deviceId).toBe('abcd1234');
    expect(parseHlc(formatHlc({ wallMs: 1, counter: 0, deviceId: 'ab' }))?.deviceId).toBe('ab000000');
    expect(parseHlc(formatHlc({ wallMs: 1, counter: 0, deviceId: 'abcdefghijkl' }))?.deviceId).toBe('abcdefgh');
  });
});

describe('maxHlc', () => {
  it('returns the later stamp', () => {
    const a = formatHlc({ wallMs: 1, counter: 0, deviceId: 'aaaaaaaa' });
    const b = formatHlc({ wallMs: 2, counter: 0, deviceId: 'aaaaaaaa' });
    expect(maxHlc(a, b)).toBe(b);
    expect(maxHlc(b, a)).toBe(b);
    expect(maxHlc(a, a)).toBe(a);
  });
});

describe('isPlausibleHlc', () => {
  const now = 1_800_000_000_000;

  it('accepts the past, the present and a modest future', () => {
    expect(isPlausibleHlc(formatHlc({ wallMs: now - 1_000_000, counter: 0, deviceId: 'aaaaaaaa' }), now)).toBe(true);
    expect(isPlausibleHlc(formatHlc({ wallMs: now + 3 * 24 * 3600 * 1000, counter: 0, deviceId: 'aaaaaaaa' }), now)).toBe(true);
  });

  it('rejects a timestamp further ahead than the skew allowance', () => {
    expect(isPlausibleHlc(formatHlc({ wallMs: now + HLC_MAX_REMOTE_SKEW_MS, counter: 0, deviceId: 'aaaaaaaa' }), now)).toBe(true); // exactly at the limit
    expect(isPlausibleHlc(formatHlc({ wallMs: now + HLC_MAX_REMOTE_SKEW_MS + 1, counter: 0, deviceId: 'aaaaaaaa' }), now)).toBe(false);
    expect(isPlausibleHlc(formatHlc({ wallMs: WALL_MAX, counter: 0, deviceId: 'aaaaaaaa' }), now)).toBe(false);
  });

  it('honours a custom allowance', () => {
    const ts = formatHlc({ wallMs: now + 5000, counter: 0, deviceId: 'aaaaaaaa' });
    expect(isPlausibleHlc(ts, now, 1000)).toBe(false);
    expect(isPlausibleHlc(ts, now, 10_000)).toBe(true);
  });

  it('rejects malformed and non-string input', () => {
    expect(isPlausibleHlc('garbage', now)).toBe(false);
    expect(isPlausibleHlc(null, now)).toBe(false);
    expect(isPlausibleHlc(12345, now)).toBe(false);
  });
});

describe('sanitizeHlcState', () => {
  it('passes a good state through', () => {
    expect(sanitizeHlcState({ wallMs: 1234, counter: 5 })).toEqual({ wallMs: 1234, counter: 5 });
  });

  it('turns anything malformed into the zero state', () => {
    for (const bad of [undefined, null, 'x', 7, [], {}, { wallMs: '1', counter: 2 }, { wallMs: 1 }]) {
      expect(sanitizeHlcState(bad)).toEqual({ wallMs: 0, counter: 0 });
    }
  });

  it('clamps rather than trusting out-of-range numbers', () => {
    expect(sanitizeHlcState({ wallMs: -1, counter: -1 })).toEqual({ wallMs: 0, counter: 0 });
    expect(sanitizeHlcState({ wallMs: NaN, counter: 3 })).toEqual({ wallMs: 0, counter: 3 });
    expect(sanitizeHlcState({ wallMs: Number.MAX_SAFE_INTEGER, counter: Number.MAX_SAFE_INTEGER })).toEqual({ wallMs: WALL_MAX, counter: COUNTER_MAX });
  });
});

describe('Hlc.next()', () => {
  it('advances the wall field as the injected clock advances', () => {
    let now = 1000;
    const clock = createHlc('dev00001', undefined, () => now);
    const a = parseHlc(clock.next())!;
    now = 1001;
    const b = parseHlc(clock.next())!;
    expect(a.wallMs).toBe(1000);
    expect(b.wallMs).toBe(1001);
    expect(b.counter).toBe(0);
  });

  it('bumps the counter, not the wall field, when called twice at the same instant', () => {
    const now = 1000;
    const clock = createHlc('dev00001', undefined, () => now);
    const a = parseHlc(clock.next())!;
    const b = parseHlc(clock.next())!;
    expect(a.wallMs).toBe(1000);
    expect(b.wallMs).toBe(1000);
    expect(b.counter).toBe(a.counter + 1);
  });

  it('stays monotonic when the wall clock goes backward', () => {
    const times = [5000, 4000, 3000]; // simulated clock regression
    let i = 0;
    const clock = createHlc('dev00001', undefined, () => times[i++]);
    const a = clock.next();
    const b = clock.next();
    const c = clock.next();
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
    // the wall field never goes backward even though the injected clock did
    const [pa, pb, pc] = [a, b, c].map((t) => parseHlc(t)!);
    expect(pa.wallMs).toBe(5000);
    expect(pb.wallMs).toBe(5000);
    expect(pc.wallMs).toBe(5000);
    expect(pb.counter).toBe(pa.counter + 1);
    expect(pc.counter).toBe(pb.counter + 1);
  });

  it('every tick from one clock is strictly increasing over many calls, backward jumps included', () => {
    const schedule = [100, 100, 50, 200, 199, 198, 500];
    let i = 0;
    const clock = createHlc('dev00001', undefined, () => schedule[i++]);
    const stamps = schedule.map(() => clock.next());
    for (let k = 1; k < stamps.length; k++) {
      expect(compareHlc(stamps[k - 1], stamps[k])).toBe(-1);
    }
  });

  it('resumes from a persisted state: a clock restarted behind its last stamp still sorts after it', () => {
    // The previous session stamped at wall 9000, counter 5. The OS clock now reads 100 (it went backward).
    const clock = createHlc('dev00001', { wallMs: 9000, counter: 5 }, () => 100);
    const next = parseHlc(clock.next())!;
    expect(next.wallMs).toBe(9000);
    expect(next.counter).toBe(6);
  });

  it('floors a fractional clock reading (performance.now()-style) so the wall field stays an integer', () => {
    const clock = createHlc('dev00001', undefined, () => 1234.987);
    expect(parseHlc(clock.next())!.wallMs).toBe(1234);
  });

  it('survives a misbehaving clock (NaN, negative, throwing) by ticking the counter', () => {
    const readings: Array<number | 'throw'> = [1000, NaN, -5, 'throw', 1000];
    let i = 0;
    const clock = createHlc('dev00001', undefined, () => {
      const r = readings[i++];
      if (r === 'throw') throw new Error('clock broke');
      return r;
    });
    const stamps = readings.map(() => clock.next());
    for (let k = 1; k < stamps.length; k++) expect(compareHlc(stamps[k - 1], stamps[k])).toBe(-1);
    expect(stamps.every(isHlc)).toBe(true);
  });

  it('guards counter overflow by advancing the wall field instead of wrapping', () => {
    // Seed right at the boundary (rather than ticking millions of times to reach
    // it) so the test stays fast regardless of the counter's field width.
    const now = 42;
    const clock = createHlc('dev00001', { wallMs: now, counter: COUNTER_MAX - 1 }, () => now);

    const atMax = parseHlc(clock.next())!;
    expect(atMax.wallMs).toBe(42);
    expect(atMax.counter).toBe(COUNTER_MAX);

    const overflowed = parseHlc(clock.next())!;
    expect(overflowed.wallMs).toBe(43); // advanced 1ms ahead of the stuck physical clock
    expect(overflowed.counter).toBe(0);
  });

  it("saturates instead of overflowing the fixed wall-field width at the format's absolute ceiling", () => {
    // Only reachable by seeding (a corrupted persisted state) right at the top of both
    // fields at once - real wall-clock time cannot reach it for millennia. Without the
    // saturation guard, formatHlc would emit a wall field wider than WALL_WIDTH, silently
    // breaking whole-string lexicographic ordering.
    const clock = createHlc('dev00001', { wallMs: WALL_MAX, counter: COUNTER_MAX }, () => 1);

    const ts = clock.next();
    expect(ts).toHaveLength(9 + 1 + 5 + 1 + 8); // fixed width preserved, no overflow digit
    const parsed = parseHlc(ts)!;
    expect(parsed.wallMs).toBe(WALL_MAX);
    expect(parsed.counter).toBe(COUNTER_MAX); // saturated, not wrapped and not advanced past the ceiling
  });

  it('snapshot() reports the state to persist', () => {
    let now = 700;
    const clock = createHlc('dev00001', undefined, () => now);
    clock.next();
    clock.next();
    expect(clock.snapshot()).toEqual({ wallMs: 700, counter: 1 });
    now = 800;
    clock.next();
    expect(clock.snapshot()).toEqual({ wallMs: 800, counter: 0 });
  });
});

describe('Hlc.receive() (merge on import)', () => {
  it('when the remote is ahead, the local clock jumps past it', () => {
    const clock = createHlc('local000', undefined, () => 100);
    const remote = formatHlc({ wallMs: 5000, counter: 3, deviceId: 'remote00' });
    const merged = parseHlc(clock.receive(remote))!;
    expect(merged.wallMs).toBe(5000);
    expect(merged.counter).toBe(4); // remote.counter + 1
  });

  it('when the local clock is ahead, receive() just ticks the local counter', () => {
    const clock = createHlc('local000', undefined, () => 100);
    const local1 = clock.next(); // wallMs 100, counter 0
    const remote = formatHlc({ wallMs: 1, counter: 9, deviceId: 'remote00' });
    const merged = parseHlc(clock.receive(remote))!;
    const before = parseHlc(local1)!;
    expect(merged.wallMs).toBe(before.wallMs);
    expect(merged.counter).toBe(before.counter + 1);
  });

  it('when local and remote wall times tie, the counter is the max of the two plus one', () => {
    const clock = createHlc('local000', { wallMs: 1000, counter: 2 }, () => 1);
    const remote = formatHlc({ wallMs: 1000, counter: 7, deviceId: 'remote00' });
    const merged = parseHlc(clock.receive(remote))!;
    expect(merged.wallMs).toBe(1000);
    expect(merged.counter).toBe(8); // max(2, 7) + 1
  });

  it('after receiving a remote timestamp, every subsequent local tick still sorts after it', () => {
    const clock = createHlc('local000', undefined, () => 10);
    const remote = formatHlc({ wallMs: 999_999, counter: 0, deviceId: 'remote00' });
    const received = clock.receive(remote);
    const nextLocal = clock.next();
    expect(compareHlc(remote, received)).toBe(-1);
    expect(compareHlc(received, nextLocal)).toBe(-1);
  });

  it('merging an unparseable remote string behaves like a plain next() at the current instant', () => {
    const clock = createHlc('local000', undefined, () => 500);
    const merged = parseHlc(clock.receive('garbage'))!;
    expect(merged.wallMs).toBe(500);
  });

  it('ignores a remote implausibly far in the future instead of pinning the local clock there', () => {
    const now = 1_800_000_000_000;
    const clock = createHlc('local000', undefined, () => now);
    const poisoned = formatHlc({ wallMs: now + HLC_MAX_REMOTE_SKEW_MS + 1, counter: 0, deviceId: 'remote00' });
    const merged = parseHlc(clock.receive(poisoned))!;
    expect(merged.wallMs).toBe(now); // behaved like next()
    const absurd = formatHlc({ wallMs: WALL_MAX, counter: COUNTER_MAX, deviceId: 'remote00' });
    expect(parseHlc(clock.receive(absurd))!.wallMs).toBe(now);
  });

  it('still merges a remote right at the skew limit', () => {
    const now = 1_800_000_000_000;
    const clock = createHlc('local000', undefined, () => now);
    const limit = formatHlc({ wallMs: now + HLC_MAX_REMOTE_SKEW_MS, counter: 4, deviceId: 'remote00' });
    const merged = parseHlc(clock.receive(limit))!;
    expect(merged.wallMs).toBe(now + HLC_MAX_REMOTE_SKEW_MS);
    expect(merged.counter).toBe(5);
  });

  it('takes a custom skew allowance', () => {
    const clock = createHlc('local000', undefined, () => 1000, 500);
    const remote = formatHlc({ wallMs: 1600, counter: 0, deviceId: 'remote00' });
    expect(parseHlc(clock.receive(remote))!.wallMs).toBe(1000); // 600ms ahead > 500ms allowance
  });
});

describe('two devices exchanging timestamps', () => {
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  it('keeps each device strictly increasing and every receive above its remote, through wild clock jumps', () => {
    const rand = rng(7);
    const clocksMs = [10_000, 10_000];
    const devices = [
      createHlc('devicea0', undefined, () => clocksMs[0]),
      createHlc('deviceb0', undefined, () => clocksMs[1]),
    ];
    const last = ['', ''];
    for (let step = 0; step < 2000; step++) {
      const d = rand() < 0.5 ? 0 : 1;
      // each device's wall clock drifts forward, stalls, or jumps backward
      const r = rand();
      clocksMs[d] += r < 0.5 ? Math.floor(rand() * 5) : r < 0.8 ? 0 : -Math.floor(rand() * 400);
      if (clocksMs[d] < 1) clocksMs[d] = 1;

      let stamp: string;
      if (last[1 - d] && rand() < 0.4) {
        stamp = devices[d].receive(last[1 - d]);
        expect(compareHlc(stamp, last[1 - d])).toBe(1); // sorts after the remote it merged
      } else {
        stamp = devices[d].next();
      }
      if (last[d]) expect(compareHlc(stamp, last[d])).toBe(1);
      last[d] = stamp;
    }
  });
});

describe('randomDeviceId', () => {
  it('produces an 8-character id usable in a formatted timestamp', () => {
    const id = randomDeviceId();
    expect(id).toHaveLength(8);
    const ts = formatHlc({ wallMs: 1, counter: 0, deviceId: id });
    expect(parseHlc(ts)?.deviceId).toBe(id);
  });
});
