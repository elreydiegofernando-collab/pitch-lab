/**
 * Latency calibration: how much later a sound the user hears shows up on the
 * input (mic) timeline, relative to when it was scheduled on the
 * AudioContext clock. Call from a button's click handler with the engine
 * already running (mic open) — the AudioContext this reads via
 * `deps.engine.context` must already exist.
 *
 * All three methods share one mechanism: schedule a train of clicks on the
 * AudioContext clock (lookahead-scheduled, like the metronome in synth.ts,
 * so `cancel()` can stop issuing clicks that haven't been scheduled into the
 * audio graph yet), collect "detected" times for each, and reduce the two
 * series with `estimateOffset`. They differ only in where "detected" comes
 * from and how sensitive/forgiving that is:
 *
 *  - loopback: speaker -> mic, sample-accurate transient detection. Primary
 *    method — a true round trip (output + input latency) in one number.
 *  - sing: same transient-detection mechanism, tuned for a sung "ta" (a
 *    softer, less percussive transient than loopback's click/decay burst).
 *    Works with Bluetooth, where acoustic loopback is unreliable.
 *  - tap: the UI calls `session.tap(event.timeStamp)` from pointerdown; that
 *    DOMHighResTimeStamp is mapped onto the AudioContext clock. This only
 *    measures output + touch latency (no mic/input path), so an assumed
 *    input latency is added back in — approximate, and documented as such.
 */
import type { Unsubscribe } from './engine-types';
import type {
  CalibrationDeps,
  CalibrationMethod,
  CalibrationProgress,
  CalibrationSession,
  OffsetEstimate,
} from './latency-types';
import { CONFIG } from '../config';
import { estimateOffset } from './latency-math';

/** Quiet lead-in before the first click, for all methods (loopback's spec value, used uniformly). */
const LEAD_SEC = 0.6;
/** Click-train lookahead scheduler, same cadence as the metronome in synth.ts. */
const TICK_MS = 25;
const LOOKAHEAD_SEC = 0.12;
/** Fallback input latency for 'tap', when the browser doesn't report `ctx.baseLatency`. */
const ASSUMED_INPUT_LATENCY_SEC = 0.01;


function abortError(message: string): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export function startCalibration(method: CalibrationMethod, deps: CalibrationDeps): CalibrationSession {
  const { engine, synth } = deps;

  const progressCbs = new Set<(p: CalibrationProgress) => void>();
  const progress: CalibrationProgress = { clicksPlayed: 0, clicksTotal: 0, eventsDetected: 0 };
  function emitProgress(): void {
    const snapshot = { ...progress };
    for (const cb of progressCbs) cb(snapshot);
  }

  let settled = false;
  let cancelled = false;
  let resolveResult!: (v: OffsetEstimate) => void;
  let rejectResult!: (e: unknown) => void;
  const result = new Promise<OffsetEstimate>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  let tapFn: (eventTimeStamp: number) => void = () => {};
  let timer: ReturnType<typeof setInterval> | undefined;
  let finishTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubTransient: Unsubscribe | undefined;

  const session: CalibrationSession = {
    method,
    tap(eventTimeStamp: number): void {
      tapFn(eventTimeStamp);
    },
    onProgress(cb: (p: CalibrationProgress) => void): Unsubscribe {
      progressCbs.add(cb);
      return () => progressCbs.delete(cb);
    },
    result,
    cancel(): void {
      if (settled) return;
      cancelled = true;
      clearInterval(timer);
      clearTimeout(finishTimer);
      unsubTransient?.();
      disableTransientsIfUsed();
      settled = true;
      rejectResult(abortError('Latency calibration cancelled'));
    },
  };

  const maybeCtx = engine.context;
  if (!maybeCtx) {
    // Defensive: the contract requires the engine to already be running (mic open) before this is called.
    queueMicrotask(() => {
      if (!settled) {
        settled = true;
        rejectResult(new Error('startCalibration: engine.context is null (start the engine first)'));
      }
    });
    return session;
  }
  // Rebind as a fresh, never-reassigned const so its non-null type survives capture by closures
  // (including the hoisted `finish` function below) that run after this point.
  const ctx = maybeCtx;

  function disableTransientsIfUsed(): void {
    if (method === 'loopback' || method === 'sing') {
      engine.setTransientDetection({ enabled: false, thresholdDb: 0, refractorySec: 0 });
    }
  }

  const methodCfg = CONFIG.latency[method];
  const total = methodCfg.clicks;
  const intervalSec = methodCfg.intervalSec;
  progress.clicksTotal = total;

  const detected: number[] = [];
  function onDetected(t: number): void {
    if (cancelled || settled) return;
    detected.push(t);
    progress.eventsDetected++;
    emitProgress();
  }

  if (method === 'loopback') {
    engine.setTransientDetection({
      enabled: true,
      thresholdDb: CONFIG.latency.loopback.thresholdDb,
      refractorySec: CONFIG.latency.loopback.refractorySec,
    });
    unsubTransient = engine.onTransient((t) => onDetected(t));
  } else if (method === 'sing') {
    engine.setTransientDetection({
      enabled: true,
      thresholdDb: CONFIG.latency.sing.thresholdDb,
      refractorySec: CONFIG.latency.sing.refractorySec,
    });
    unsubTransient = engine.onTransient((t) => onDetected(t));
  } else {
    // 'tap': map the pointer event's DOMHighResTimeStamp onto the AudioContext clock by sampling both
    // clocks "now" and taking the difference — see the module doc comment.
    tapFn = (eventTimeStamp: number) => {
      if (cancelled || settled) return;
      const tapCtxTime = ctx.currentTime + (eventTimeStamp - performance.now()) / 1000;
      onDetected(tapCtxTime);
    };
  }

  const startAt = ctx.currentTime + LEAD_SEC;
  const scheduledTimes: number[] = [];
  for (let i = 0; i < total; i++) scheduledTimes.push(startAt + i * intervalSec);

  function finish(): void {
    if (settled) return;
    settled = true;
    unsubTransient?.();
    disableTransientsIfUsed();

    let estimate = estimateOffset(scheduledTimes, detected, {
      matchWindowMs: CONFIG.latency.matchWindowMs,
      minMatches: CONFIG.latency.minMatches,
      maxJitterMs: methodCfg.maxJitterMs,
    });
    if (method === 'tap') {
      // Tap only measures output + touch latency; add the assumed/measured input latency back in.
      // Approximate — see the module doc comment.
      const inputLatencySec = ctx.baseLatency ?? ASSUMED_INPUT_LATENCY_SEC;
      estimate = { ...estimate, offsetMs: estimate.offsetMs + inputLatencySec * 1000 };
    }
    resolveResult(estimate);
  }

  let nextToPlay = 0;
  timer = setInterval(() => {
    if (cancelled) return;
    const horizon = ctx.currentTime + LOOKAHEAD_SEC;
    while (nextToPlay < total && scheduledTimes[nextToPlay] <= horizon) {
      synth.click(scheduledTimes[nextToPlay], nextToPlay === 0);
      nextToPlay++;
      progress.clicksPlayed = nextToPlay;
      emitProgress();
    }
    if (nextToPlay >= total) {
      clearInterval(timer);
      const maxMatchSec = CONFIG.latency.matchWindowMs[1] / 1000;
      const lastClickEnd = scheduledTimes[total - 1] + maxMatchSec;
      const waitMs = Math.max(0, (lastClickEnd - ctx.currentTime) * 1000) + 50;
      finishTimer = setTimeout(finish, waitMs);
    }
  }, TICK_MS);

  return session;
}
