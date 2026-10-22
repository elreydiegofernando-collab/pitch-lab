import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTrack, withVibrato } from '../../analysis/fixtures';
import type { PitchFrame } from '../../core/types';
import { createFrameRing } from './frame-ring';
import { STALE_AFTER_SEC, TICK_MS, createLiveAnalysis, type LiveFeatures, type LiveSettings } from './live-analysis';

/** The slice of the engine the analysis uses: a frame subscription we can drive by hand. */
function fakeEngine() {
  const listeners = new Set<(f: PitchFrame) => void>();
  return {
    onFrame: vi.fn((l: (f: PitchFrame) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    }),
    emit(frames: readonly PitchFrame[]): void {
      for (const f of frames) for (const l of [...listeners]) l(f);
    },
    get listeners(): number {
      return listeners.size;
    },
  };
}

const ALL: LiveFeatures = { cracks: true, onset: true, vibrato: true };
const settings = (features: LiveFeatures, over: Partial<LiveSettings> = {}): LiveSettings => ({
  features,
  vibratoStyle: 'pop',
  toleranceCents: 25,
  targetMidi: null,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createFrameRing', () => {
  it('holds the newest frames, in order, and drops the oldest', () => {
    const ring = createFrameRing(4);
    const frames = makeTrack({ duration: 0.2, t0: 0, midi: () => 60 }).slice(0, 7);
    for (const f of frames) ring.push(f);
    expect(ring.count).toBe(4);
    expect(ring.latestT).toBe(frames[6].t);
    expect(ring.since(-1).map((f) => f.t)).toEqual(frames.slice(3).map((f) => f.t));
    expect(ring.since(frames[5].t).map((f) => f.t)).toEqual([frames[5].t, frames[6].t]);
    expect(ring.since(99)).toEqual([]);
    ring.clear();
    expect(ring.count).toBe(0);
    expect(ring.latestT).toBe(-Infinity);
  });
});

describe('createLiveAnalysis', () => {
  it('costs nothing while no feature is on: no frame subscription, no timer', () => {
    const engine = fakeEngine();
    const analysis = createLiveAnalysis(engine, { onCrack: vi.fn(), onOnset: vi.fn() });
    analysis.configure(settings({ cracks: false, onset: false, vibrato: false }));
    expect(engine.onFrame).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(analysis.readings.value).toEqual({ onset: null, vibrato: null });
  });

  it('subscribes once when a feature turns on, and lets go when they all turn off', () => {
    const engine = fakeEngine();
    const analysis = createLiveAnalysis(engine, { onCrack: vi.fn(), onOnset: vi.fn() });
    analysis.configure(settings({ cracks: true, onset: false, vibrato: false }));
    analysis.configure(settings(ALL));
    expect(engine.onFrame).toHaveBeenCalledTimes(1);
    expect(engine.listeners).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    analysis.configure(settings({ cracks: false, onset: false, vibrato: false }));
    expect(engine.listeners).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a crack once, at its time, and not again on later ticks', () => {
    const engine = fakeEngine();
    const onCrack = vi.fn();
    const analysis = createLiveAnalysis(engine, { onCrack, onOnset: vi.fn() });
    analysis.configure(settings({ cracks: true, onset: false, vibrato: false }));
    // 60, then a jump of nine semitones between two frames: a crack.
    const frames = makeTrack({ duration: 2, t0: 5, midi: (t) => (t < 6 ? 60 : 69) });
    engine.emit(frames);
    vi.advanceTimersByTime(TICK_MS);
    expect(onCrack).toHaveBeenCalledTimes(1);
    expect(onCrack.mock.calls[0][0]).toBeGreaterThan(5.9);
    expect(onCrack.mock.calls[0][0]).toBeLessThan(6.1);
    engine.emit(makeTrack({ duration: 1, t0: 7, midi: () => 69 }));
    vi.advanceTimersByTime(TICK_MS);
    expect(onCrack).toHaveBeenCalledTimes(1);
  });

  it('measures vibrato a few times a second and publishes only what changed', () => {
    const engine = fakeEngine();
    const analysis = createLiveAnalysis(engine, { onCrack: vi.fn(), onOnset: vi.fn() });
    analysis.configure(settings({ cracks: false, onset: false, vibrato: true }));
    const seen: Array<unknown> = [];
    const stop = analysis.readings.subscribe((r) => seen.push(r.vibrato));
    const frames = makeTrack({ duration: 3, t0: 0, midi: withVibrato(() => 60, 5.8, 40), jitterCents: 2, seed: 5 });
    engine.emit(frames);
    vi.advanceTimersByTime(TICK_MS);
    const r = analysis.readings.value.vibrato!;
    expect(r.present).toBe(true);
    expect(r.rateHz!).toBeGreaterThan(5.3);
    expect(r.rateHz!).toBeLessThan(6.3);
    expect(r.stale).toBe(false);
    const published = seen.length;
    // Nothing new arrived: the next tick does no work and publishes nothing.
    vi.advanceTimersByTime(TICK_MS * 3);
    expect(seen.length).toBe(published);
    stop();
  });

  it('dims the vibrato reading once the voice has stopped for a while', () => {
    const engine = fakeEngine();
    const analysis = createLiveAnalysis(engine, { onCrack: vi.fn(), onOnset: vi.fn() });
    analysis.configure(settings({ cracks: false, onset: false, vibrato: true }));
    engine.emit(makeTrack({ duration: 3, t0: 0, midi: withVibrato(() => 60, 5.8, 40), seed: 5 }));
    vi.advanceTimersByTime(TICK_MS);
    expect(analysis.readings.value.vibrato!.stale).toBe(false);
    // Silence follows; once the window holds too little singing and STALE_AFTER_SEC has passed, the reading is kept but dimmed.
    engine.emit(makeTrack({ duration: STALE_AFTER_SEC + 2.6, t0: 3, midi: () => NaN }));
    vi.advanceTimersByTime(TICK_MS);
    const r = analysis.readings.value.vibrato!;
    expect(r.stale).toBe(true);
    expect(r.present).toBe(true);
  });

  it('reads how a note started: settling first, then settle time and scoop, and marks the onset once', () => {
    const engine = fakeEngine();
    const onOnset = vi.fn();
    const analysis = createLiveAnalysis(engine, { onCrack: vi.fn(), onOnset });
    analysis.configure(settings({ cracks: false, onset: true, vibrato: false }));
    const note = makeTrack({ duration: 2.2, t0: 20, midi: (t) => (t < 20.5 ? NaN : 60 - 0.6 * Math.exp(-(t - 20.5) / 0.08)), jitterCents: 1, seed: 8 });

    engine.emit(note.filter((f) => f.t < 21.0));
    vi.advanceTimersByTime(TICK_MS);
    expect(analysis.readings.value.onset?.state).toBe('settling');
    expect(onOnset).not.toHaveBeenCalled();

    engine.emit(note.filter((f) => f.t >= 21.0));
    vi.advanceTimersByTime(TICK_MS);
    const done = analysis.readings.value.onset!;
    expect(done.state).toBe('settled');
    expect(done.scoopCents).toBeGreaterThan(30);
    expect(onOnset).toHaveBeenCalledTimes(1);
    expect(onOnset.mock.calls[0][0]).toBeCloseTo(20.5, 1);

    vi.advanceTimersByTime(TICK_MS * 4);
    expect(onOnset).toHaveBeenCalledTimes(1);
  });

  it('starts over when the engine restarts on a new clock', () => {
    const engine = fakeEngine();
    const onCrack = vi.fn();
    const analysis = createLiveAnalysis(engine, { onCrack, onOnset: vi.fn() });
    analysis.configure(settings({ cracks: true, onset: false, vibrato: true }));
    engine.emit(makeTrack({ duration: 3, t0: 100, midi: (t) => (t < 101 ? 60 : 69) }));
    vi.advanceTimersByTime(TICK_MS);
    expect(onCrack).toHaveBeenCalledTimes(1);
    // The context was rebuilt: time starts again near zero. A crack there is a new crack.
    engine.emit(makeTrack({ duration: 2, t0: 0.5, midi: (t) => (t < 1 ? 60 : 69) }));
    vi.advanceTimersByTime(TICK_MS);
    expect(onCrack).toHaveBeenCalledTimes(2);
  });

  it('hides a reading when its feature is turned off, and dispose leaves nothing running', () => {
    const engine = fakeEngine();
    const analysis = createLiveAnalysis(engine, { onCrack: vi.fn(), onOnset: vi.fn() });
    analysis.configure(settings({ cracks: false, onset: false, vibrato: true }));
    engine.emit(makeTrack({ duration: 3, t0: 0, midi: withVibrato(() => 60, 5.8, 40), seed: 5 }));
    vi.advanceTimersByTime(TICK_MS);
    expect(analysis.readings.value.vibrato).not.toBeNull();
    analysis.configure(settings({ cracks: true, onset: false, vibrato: false }));
    expect(analysis.readings.value.vibrato).toBeNull();
    analysis.dispose();
    expect(engine.listeners).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
