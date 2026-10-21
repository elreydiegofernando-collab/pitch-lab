import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startCalibration } from './latency';
import { CONFIG } from '../config';
import type { AudioEngine, EngineInfo, EngineState, Unsubscribe } from './engine-types';
import type { GlideSpec, MetronomeHandle, NoteSpec, ReferenceSynth, ScheduledHandle, SequenceNote, Timbre } from './synth-types';

// ---------------------------------------------------------------------------
// Fakes: a minimal AudioEngine (just enough of the input timeline + transient
// detection that latency.ts actually touches) and a minimal ReferenceSynth
// (click() recorded; everything else is a stub latency.ts never calls).

interface FakeCtx {
  currentTime: number;
  baseLatency?: number;
}

function makeEngine(ctx: FakeCtx) {
  const transientListeners = new Set<(t: number, peakDb: number) => void>();
  const transientCalls: Array<{ enabled: boolean; thresholdDb: number; refractorySec: number }> = [];

  const info: EngineInfo = {
    state: 'running',
    sampleRate: 48000,
    baseLatency: null,
    outputLatency: null,
    windowSize: 2048,
    hopSize: 512,
    detector: 'mpm',
    detectorCostMs: null,
    trackSettings: null,
    audioSessionType: null,
    inputDeviceLabel: null,
    isIOS: false,
    isStandalone: false,
    userAgent: 'test',
  };

  const engine: AudioEngine = {
    state: 'running' as EngineState,
    error: null,
    context: ctx as unknown as AudioContext,
    output: null,
    ensureContext(): AudioContext {
      return ctx as unknown as AudioContext;
    },
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    resume: () => Promise.resolve(),
    reset: () => Promise.resolve(),
    onFrame: (): Unsubscribe => () => {},
    onState: (): Unsubscribe => () => {},
    onStats: (): Unsubscribe => () => {},
    onTransient(listener): Unsubscribe {
      transientListeners.add(listener);
      return () => transientListeners.delete(listener);
    },
    info: () => info,
    listInputs: () => Promise.resolve([]),
    setPreferredInput: () => {},
    setDetector: () => {},
    setGating: () => {},
    setTransientDetection(opts): void {
      transientCalls.push(opts);
    },
    startRecording: () => {},
    stopRecording: () => Promise.reject(new Error('not used by latency.ts')),
  };

  function fireTransient(t: number, peakDb = -10): void {
    for (const l of [...transientListeners]) l(t, peakDb);
  }

  return { engine, transientCalls, fireTransient };
}

function dummyHandle(startAt: number): ScheduledHandle {
  return { startAt, endAt: startAt, stop: () => {} };
}
function dummyMetronome(startAt: number): MetronomeHandle {
  return { startAt, endAt: Infinity, bpm: 120, beat0: startAt, setBpm: () => {}, stop: () => {} };
}

function makeSynth() {
  const clicksPlayed: Array<{ at: number; accent: boolean }> = [];
  const synth: ReferenceSynth = {
    setVolume: () => {},
    playNote: (spec: NoteSpec) => dummyHandle(spec.startAt ?? 0),
    playGlide: (spec: GlideSpec) => dummyHandle(spec.startAt ?? 0),
    playSequence: (_notes: readonly SequenceNote[], opts?: { startAt?: number; timbre?: Timbre; gain?: number }) =>
      dummyHandle(opts?.startAt ?? 0),
    click(at: number, accent = false): void {
      clicksPlayed.push({ at, accent });
    },
    startMetronome: (_bpm: number, opts?: { startAt?: number }) => dummyMetronome(opts?.startAt ?? 0),
    stopAll: () => {},
  };
  return { synth, clicksPlayed };
}

/** Advance both the fake JS timers and the simulated AudioContext clock together, as real audio time would. */
function tick(ctx: FakeCtx, ms: number): void {
  ctx.currentTime += ms / 1000;
  vi.advanceTimersByTime(ms);
}

/**
 * Advance in small (25ms) steps until `predicate` holds, stopping the instant it does. Used only for
 * 'tap': unlike loopback/sing (where the "detection" is produced synchronously inside synth.click()),
 * tap's detection is a separate call the test makes afterward, so a single large tick risks also
 * running out the trailing match-window wait (and resolving the whole calibration) before that call
 * happens. Small steps keep every stop point far short of that.
 */
function advanceUntil(ctx: FakeCtx, predicate: () => boolean, stepMs = 25, maxMs = 5000): void {
  let elapsed = 0;
  while (!predicate() && elapsed < maxMs) {
    tick(ctx, stepMs);
    elapsed += stepMs;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe("startCalibration('loopback')", () => {
  it('recovers the true round-trip offset from synthetic transients, and toggles transient detection correctly', async () => {
    const ctx: FakeCtx = { currentTime: 0 };
    const { engine, transientCalls, fireTransient } = makeEngine(ctx);
    const { synth, clicksPlayed } = makeSynth();

    const ECHO_SEC = 0.045; // the "true" latency every click's echo arrives after
    synth.click = (at: number, accent = false): void => {
      clicksPlayed.push({ at, accent });
      fireTransient(at + ECHO_SEC);
    };

    const session = startCalibration('loopback', { engine, synth });
    tick(ctx, 10000); // comfortably covers lead-in + all clicks + the trailing match window

    const estimate = await session.result;
    expect(estimate.ok).toBe(true);
    expect(estimate.offsetMs).toBeCloseTo(ECHO_SEC * 1000, 6);
    expect(estimate.jitterMs).toBeCloseTo(0, 6);
    expect(estimate.matched).toBe(CONFIG.latency.loopback.clicks);
    expect(clicksPlayed).toHaveLength(CONFIG.latency.loopback.clicks);

    // Enabled once, with the loopback threshold/refractory; disabled once at the end.
    expect(transientCalls[0]).toEqual({
      enabled: true,
      thresholdDb: CONFIG.latency.loopback.thresholdDb,
      refractorySec: CONFIG.latency.loopback.refractorySec,
    });
    expect(transientCalls[transientCalls.length - 1].enabled).toBe(false);
  });

  it('tolerates a few missed echoes and one spurious transient, and still reports ok', async () => {
    const ctx: FakeCtx = { currentTime: 0 };
    const { engine, fireTransient } = makeEngine(ctx);
    const { synth } = makeSynth();

    let i = 0;
    const lastIndex = CONFIG.latency.loopback.clicks - 1;
    synth.click = (at: number): void => {
      const index = i++;
      // Miss the LAST click specifically: CONFIG.latency.matchWindowMs (600ms) is wider than
      // loopback's click spacing (500ms), so a missed click's window would otherwise overlap the
      // NEXT click's own echo and wrongly steal it. Missing the last click has no "next" to steal.
      if (index === lastIndex) return;
      fireTransient(at + 0.05);
    };

    const session = startCalibration('loopback', { engine, synth });
    tick(ctx, 2000); // partway through the click train
    fireTransient(999); // a spurious, unrelated detection far outside any click's window
    tick(ctx, 8000);

    const estimate = await session.result;
    expect(estimate.ok).toBe(true);
    expect(estimate.offsetMs).toBeCloseTo(50, 6);
    expect(estimate.matched).toBe(CONFIG.latency.loopback.clicks - 1);
    expect(estimate.rejected).toBeGreaterThanOrEqual(1); // the spurious detection, at least
  });

  it('cancel() stops issuing further clicks, disables transient detection, and rejects with AbortError', async () => {
    const ctx: FakeCtx = { currentTime: 0 };
    const { engine, transientCalls, fireTransient } = makeEngine(ctx);
    const { synth, clicksPlayed } = makeSynth();
    synth.click = (at: number, accent = false): void => {
      clicksPlayed.push({ at, accent });
      fireTransient(at + 0.05);
    };

    const session = startCalibration('loopback', { engine, synth });
    tick(ctx, 700); // let the first click (or two) go out
    const playedBeforeCancel = clicksPlayed.length;
    expect(playedBeforeCancel).toBeGreaterThan(0);
    expect(playedBeforeCancel).toBeLessThan(CONFIG.latency.loopback.clicks);

    session.cancel();
    const resultPromise = session.result;

    tick(ctx, 10000); // long enough that, uncancelled, every remaining click would have gone out
    expect(clicksPlayed).toHaveLength(playedBeforeCancel); // nothing further was scheduled

    await expect(resultPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(transientCalls[transientCalls.length - 1].enabled).toBe(false);

    session.cancel(); // idempotent: no throw, no second rejection attempt
  });
});

describe("startCalibration('sing')", () => {
  it("uses a more sensitive, hardcoded threshold/refractory (CONFIG has no sing.thresholdDb/refractorySec)", async () => {
    const ctx: FakeCtx = { currentTime: 0 };
    const { engine, transientCalls, fireTransient } = makeEngine(ctx);
    const { synth } = makeSynth();
    synth.click = (at: number): void => fireTransient(at + 0.06);

    const session = startCalibration('sing', { engine, synth });
    tick(ctx, 10000);
    const estimate = await session.result;

    expect(estimate.ok).toBe(true);
    expect(estimate.matched).toBe(CONFIG.latency.sing.clicks);
    expect(transientCalls[0].enabled).toBe(true);
    expect(transientCalls[0].thresholdDb).toBe(-45);
    expect(transientCalls[0].refractorySec).toBe(0.3);
  });
});

describe("startCalibration('tap')", () => {
  /** Run the tap click train, tapping each click at exactly `offsetSec` after its scheduled time. */
  async function runTapTrain(ctx: FakeCtx, offsetSec: number) {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const { engine } = makeEngine(ctx);
    const { synth, clicksPlayed } = makeSynth();
    const session = startCalibration('tap', { engine, synth });

    const total = CONFIG.latency.tap.clicks;
    for (let i = 0; i < total; i++) {
      advanceUntil(ctx, () => clicksPlayed.length > i);
      const click = clicksPlayed[i];
      // performance.now() is mocked to 0, so passing (desiredCtxTime - ctx.currentTime) * 1000
      // as the DOMHighResTimeStamp makes tap() map it back to exactly `click.at + offsetSec`.
      session.tap((click.at + offsetSec - ctx.currentTime) * 1000);
    }
    tick(ctx, 2000); // flush the trailing match-window wait and let finish() run
    return session.result;
  }

  it('maps the tap timestamp onto the AudioContext clock and adds ctx.baseLatency as the assumed input latency', async () => {
    const ctx: FakeCtx = { currentTime: 0, baseLatency: 0.02 };
    const estimate = await runTapTrain(ctx, 0.08);
    expect(estimate.ok).toBe(true);
    expect(estimate.matched).toBe(CONFIG.latency.tap.clicks);
    expect(estimate.jitterMs).toBeCloseTo(0, 6);
    expect(estimate.offsetMs).toBeCloseTo(100, 6); // 80ms measured + 20ms assumed input latency
  });

  it('falls back to a 10ms assumed input latency when ctx.baseLatency is unavailable', async () => {
    const ctx: FakeCtx = { currentTime: 0 }; // baseLatency left undefined
    const estimate = await runTapTrain(ctx, 0.08);
    expect(estimate.offsetMs).toBeCloseTo(90, 6); // 80ms measured + 10ms fallback
  });
});
