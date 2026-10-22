/**
 * The runner end to end: the real session over fake-indexeddb, the real analyzers and progression, and a fake audio
 * engine and synth. Takes are synthesized pitch tracks (exercises/test-singer.ts, analysis/fixtures.ts) put on the
 * engine's input timeline the way src/integration/wave1.test.ts does, and the AudioContext clock is moved by hand.
 * Each test gets a fresh IndexedDB and a fresh module graph.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTrack, sequence } from '../analysis/fixtures';
import type { EngineError, EngineState, Recording } from '../audio/engine-types';
import type { MetronomeHandle, NoteSpec, ScheduledHandle } from '../audio/synth-types';
import type { PitchFrame } from '../core/types';
import { WORLDS, analyzeTake, getExercise, realize, type ExerciseDef, type RealizedExercise } from '../exercises';
import { GOOD_SINGER, singTake, type SingerModel } from '../exercises/test-singer';
import type { AttemptRecord } from '../storage/schema';
import { installNoOpfs } from '../storage/test-helpers';
import type { ExerciseRunner, RunTarget } from './types';

// ---------------------------------------------------------------- fakes

class FakeContext {
  currentTime = 0;
  readonly sampleRate = 48000;
  readonly state = 'running';
}

class FakeEngine {
  state: EngineState = 'idle';
  error: EngineError | null = null;
  context: FakeContext | null = null;
  output: object | null = null;
  /** What start() ends in. */
  startResult: 'running' | EngineError = 'running';
  recording: Recording = { samples: new Float32Array(0), sampleRate: 48000, startTime: 0 };
  starts = 0;
  stops = 0;
  recordings = 0;
  private readonly frameListeners = new Set<(f: PitchFrame) => void>();
  private readonly stateListeners = new Set<(s: EngineState, e: EngineError | null) => void>();

  ensureContext(): FakeContext {
    if (!this.context) {
      this.context = new FakeContext();
      this.output = {};
    }
    return this.context;
  }
  start(): Promise<void> {
    this.starts += 1;
    this.ensureContext();
    this.set('starting', null);
    return Promise.resolve().then(() => {
      if (this.startResult === 'running') this.set('running', null);
      else this.set('error', this.startResult);
    });
  }
  stop(): Promise<void> {
    this.stops += 1;
    this.set('idle', null);
    return Promise.resolve();
  }
  resume(): Promise<void> {
    this.set('running', null);
    return Promise.resolve();
  }
  onFrame(listener: (f: PitchFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }
  onState(listener: (s: EngineState, e: EngineError | null) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }
  startRecording(): void {
    this.recordings += 1;
  }
  stopRecording(): Promise<Recording> {
    return Promise.resolve(this.recording);
  }
  set(state: EngineState, error: EngineError | null): void {
    this.state = state;
    this.error = error;
    for (const l of [...this.stateListeners]) l(state, error);
  }
  emit(frame: PitchFrame): void {
    for (const l of [...this.frameListeners]) l(frame);
  }
  get frameListenerCount(): number {
    return this.frameListeners.size;
  }
}

class FakeSynth {
  clicks: Array<{ at: number; accent: boolean }> = [];
  notes: Array<NoteSpec & { stopped: boolean }> = [];
  metronomes: Array<{ bpm: number; startAt: number | undefined; stopped: boolean }> = [];
  stopAlls = 0;
  setVolume(): void {}
  playNote(spec: NoteSpec): ScheduledHandle {
    const rec = { ...spec, stopped: false };
    this.notes.push(rec);
    const startAt = spec.startAt ?? 0;
    return { startAt, endAt: startAt + spec.duration, stop: () => void (rec.stopped = true) };
  }
  playGlide(): ScheduledHandle {
    throw new Error('the runner never plays glides itself');
  }
  playSequence(): ScheduledHandle {
    throw new Error('the runner never plays sequences itself');
  }
  click(at: number, accent = false): void {
    this.clicks.push({ at, accent });
  }
  startMetronome(bpm: number, opts?: { startAt?: number }): MetronomeHandle {
    const m = { bpm, startAt: opts?.startAt, stopped: false };
    this.metronomes.push(m);
    return { startAt: opts?.startAt ?? 0, endAt: Infinity, bpm, beat0: opts?.startAt ?? 0, setBpm: () => undefined, stop: () => void (m.stopped = true) };
  }
  stopAll(): void {
    this.stopAlls += 1;
  }
}

const fakes = vi.hoisted(() => ({
  engine: null as unknown,
  synth: null as unknown,
  buildDemo: vi.fn(),
}));

vi.mock('../audio/engine', () => ({ getEngine: () => fakes.engine }));
vi.mock('../state/audio', () => ({
  getSynth: () => {
    (fakes.engine as { ensureContext(): unknown }).ensureContext();
    return fakes.synth;
  },
}));
vi.mock('../audio/demos', () => ({ buildDemo: fakes.buildDemo }));
vi.mock('../state/songs', async () => {
  const { signal } = await import('@preact/signals');
  return { songIndex: signal(new Map()), songsLoaded: signal(true), songLoadErrors: signal([]), loadSongs: async () => undefined, getSong: async () => undefined };
});

// ---------------------------------------------------------------- the rig

async function rig() {
  const engine = new FakeEngine();
  const synth = new FakeSynth();
  fakes.engine = engine;
  fakes.synth = synth;
  const session = await import('../state/session');
  const runnerMod = await import('./runner');
  const settings = await import('../state/settings');
  const workout = await import('./workout');
  const flow = await import('./flow');
  await session.bootSession();
  return { engine, synth, session, runnerMod, settings, workout, flow };
}
type Rig = Awaited<ReturnType<typeof rig>>;

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
  installNoOpfs();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  fakes.buildDemo.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** A take-relative PitchTrack of `realized` (t = 0 at the downbeat). */
type Rendition = (realized: RealizedExercise, def: ExerciseDef) => PitchFrame[];

const singer =
  (model: Partial<SingerModel> = {}): Rendition =>
  (realized, def) =>
    singTake(realized, { ...GOOD_SINGER, vibratoEverywhere: def.analyzers.includes('vibrato'), ...model });
const good = singer();

/** The Range finder as a voice from MIDI `low` to `high` sings it: each end held for three seconds. */
const rangeSweep =
  (low: number, high: number): Rendition =>
  (realized) => {
    const mid = realized.tonicMidi;
    const sweep = sequence([
      [2, () => mid],
      [4, (u) => mid + (low - mid) * (u / 4)],
      [3, () => low],
      [2, () => NaN],
      [2, () => mid],
      [4, (u) => mid + (high - mid) * (u / 4)],
      [3, () => high],
    ]);
    return makeTrack({ duration: realized.totalSec + 1, t0: -0.5, midi: (t) => (t < 0 ? NaN : sweep(t)), jitterCents: 4, seed: 3 });
  };

function setClock(r: Rig, ctxTime: number): void {
  r.engine.context!.currentTime = ctxTime;
  vi.advanceTimersByTime(40);
}

/** Tap Sing and wait for the count-in (or an error). */
async function tapSing(runner: ExerciseRunner): Promise<void> {
  runner.sing();
  await until(() => ['count-in', 'singing', 'error'].includes(runner.phase.value));
}

/** The singer's frames, reaching the input `origin` (downbeat + round trip) later than they were sung. */
function feed(r: Rig, runner: ExerciseRunner, rendition: Rendition, keep: (f: PitchFrame) => boolean = () => true): void {
  const p = runner.prepared.value!;
  const origin = runner.origin.value!;
  for (const f of rendition(p.realized, p.def)) if (keep(f)) r.engine.emit({ ...f, t: f.t + origin });
}

/** Run the clock past the take's end and wait for the outcome. */
async function finishTake(r: Rig, runner: ExerciseRunner): Promise<void> {
  setClock(r, runner.origin.value! + runner.prepared.value!.realized.totalSec + 2);
  await until(() => runner.phase.value === 'done' || runner.phase.value === 'error');
}

async function singWhole(r: Rig, runner: ExerciseRunner, rendition: Rendition) {
  await tapSing(runner);
  feed(r, runner, rendition);
  await finishTake(r, runner);
  expect(runner.error.value).toBeNull();
  return runner.outcome.value!;
}

/** Passing rows for every level up to `throughLevelId`, written straight to storage, then the session reloaded. */
async function seedPasses(r: Rig, throughLevelId: string): Promise<void> {
  const storage = r.session.appStorage.value!;
  const profileId = r.session.activeProfile.value!.id;
  for (const world of WORLDS) {
    for (const level of [...world.levels].sort((a, b) => a.index - b.index)) {
      await storage.attempts.add({
        profileId,
        exerciseId: level.exerciseId,
        levelId: level.id,
        kind: level.kind === 'boss' ? 'boss' : 'practice',
        score: 0.9,
        passed: true,
        mastery: 2,
        metrics: {},
        durationSec: 10,
        tonicMidi: 60,
        tempoBpm: null,
        takeId: null,
      });
      if (level.id === throughLevelId) {
        await r.session.reloadSession();
        return;
      }
    }
  }
  throw new Error(`no level ${throughLevelId}`);
}

const TENOR_RANGE = { comfortable: { low: 47, high: 69 }, extended: { low: 45, high: 72 }, measuredAt: '2026-10-21T09:00:00.000Z' };

async function storedLog(r: Rig): Promise<AttemptRecord[]> {
  return r.session.appStorage.value!.attempts.listByProfile(r.session.activeProfile.value!.id);
}

// ---------------------------------------------------------------- pure helpers

describe('runner helpers', () => {
  it('ladderTempo: the first rung, then one up after a take that passed its rung, from the latest take only', async () => {
    const { ladderTempo } = await import('./runner');
    const def = getExercise('runs.run.1')!;
    const [r0, r1] = def.tempoLadder!;
    expect(ladderTempo(getExercise('foundations.sustain.1')!, [])).toBe(60); // no ladder: the exercise tempo
    expect(ladderTempo(def, [])).toBe(r0);
    const realized = realize(def, TENOR_RANGE, 'tenor', { bpm: r0 });
    const passing = analyzeTake(def, realized, singTake(realized, GOOD_SINGER), { vibratoStyle: 'pop' }).metrics;
    const row = (over: Partial<AttemptRecord>): AttemptRecord => ({
      id: Math.random().toString(36),
      profileId: 'p',
      createdAt: '2026-10-21T09:00:00.000Z',
      updatedAt: '0',
      deletedAt: null,
      exerciseId: def.id,
      levelId: 'runs.01',
      kind: 'practice',
      score: 0.9,
      passed: false,
      mastery: 0,
      metrics: passing,
      durationSec: 10,
      tonicMidi: 60,
      tempoBpm: r0,
      takeId: null,
      ...over,
    });
    expect(ladderTempo(def, [row({})])).toBe(r1);
    expect(ladderTempo(def, [row({}), row({ metrics: {} })])).toBe(r0); // the latest take missed: the rung holds
    expect(ladderTempo(def, [row({ metrics: {} }), row({}), row({ exerciseId: 'other' }), row({ tempoBpm: null })])).toBe(r1);
    expect(ladderTempo(def, [row({ tempoBpm: def.tempoBpm })])).toBe(def.tempoBpm); // never past the top
    expect(ladderTempo(def, [row({ tempoBpm: r0 + 1 })])).toBe(r1); // an off-ladder tempo snaps to the rung below it
  });

  it('cueAt: cues show a little early and through the count-in; a syllable fills in when there is none', async () => {
    const { cueAt } = await import('./runner');
    const pitchMatch = realize(getExercise('foundations.pitch-match.1')!, TENOR_RANGE, 'tenor');
    expect(cueAt(pitchMatch, -1)).toBe('Listen');
    const sing = pitchMatch.cues.find((c) => c.text === 'Sing')!;
    expect(cueAt(pitchMatch, sing.t - 0.5)).toBe('Listen');
    expect(cueAt(pitchMatch, sing.t - 0.1)).toBe('Sing');
    const bare = { cues: [], steps: [{ index: 0, rep: 0, role: 'sing' as const, start: 0, end: 2, midi: 60, syllable: 'ah' }] };
    expect(cueAt(bare, -1)).toBe('ah');
    expect(cueAt(bare, 3)).toBeNull();
  });

  it('takeReferenceTones: all of them in headphones; on a speaker each one stays clear of the singing', async () => {
    const { takeReferenceTones, SPEAKER_CLEARANCE_SEC } = await import('./runner');
    const sustain = realize(getExercise('foundations.sustain.1')!, TENOR_RANGE, 'tenor');
    expect(sustain.reference).toEqual([expect.objectContaining({ start: -sustain.countInSec, end: 0 })]);
    expect(takeReferenceTones(sustain, true)).toEqual(sustain.reference);
    expect(takeReferenceTones(sustain, false)).toEqual([{ ...sustain.reference[0], end: -SPEAKER_CLEARANCE_SEC }]);

    // Pitch match: the Listen tones ARE the exercise, and the rest after each keeps them clear already.
    const pitchMatch = realize(getExercise('foundations.pitch-match.1')!, TENOR_RANGE, 'tenor');
    expect(takeReferenceTones(pitchMatch, false)).toEqual(pitchMatch.reference);
    for (const tone of takeReferenceTones(pitchMatch, false)) {
      const next = pitchMatch.notes.find((n) => n.start >= tone.start)!;
      expect(next.start - tone.end).toBeGreaterThanOrEqual(SPEAKER_CLEARANCE_SEC);
    }
    // A tone with no room left before the next sung note is dropped.
    const tight = { notes: [{ midi: 60, start: 0.5, end: 2 }], reference: [{ midi: 60, start: 0, end: 0.5 }] };
    expect(takeReferenceTones(tight, false)).toEqual([]);
  });

  it('on a speaker, every exercise still sounds its starting pitch and every Listen step', async () => {
    const { takeReferenceTones } = await import('./runner');
    const { EXERCISES } = await import('../exercises');
    const { ROUTINE_EXERCISES } = await import('../progress');
    for (const def of [...EXERCISES, ...Object.values(ROUTINE_EXERCISES)]) {
      const realized = realize(def, TENOR_RANGE, 'tenor');
      const kept = takeReferenceTones(realized, false);
      const listens = realized.steps.filter((s) => s.role === 'listen').map((s) => s.start);
      for (const tone of realized.reference) {
        if (tone.start >= 0 && !listens.some((t) => Math.abs(t - tone.start) < 1e-9)) continue; // a new key's first note may go at speed
        expect(kept.some((k) => Math.abs(k.start - tone.start) < 1e-9 && k.end - k.start >= 0.25), `${def.id}: the tone at ${tone.start.toFixed(2)} s`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------- preparing

describe('createRunner: preparing a target', () => {
  it('prepares an open level in the saved range, with its pass lines', async () => {
    const r = await rig();
    const runner = r.runnerMod.createRunner({ kind: 'level', levelId: 'foundations.01' });
    expect(runner.phase.value).toBe('idle');
    const p = runner.prepared.value!;
    expect(p).toMatchObject({ def: { id: 'foundations.range-finder.1' }, level: { id: 'foundations.01' }, world: { id: 'foundations' }, bpm: 60, ladder: null, usingDefaultRange: true, audition: null, workout: null });
    expect(p.passLines[0].text).toMatch(/^Score ≥/);
    await r.session.saveProfileRange(TENOR_RANGE);
    expect(r.runnerMod.createRunner({ kind: 'level', levelId: 'foundations.01' }).prepared.value?.usingDefaultRange).toBe(false);
  });

  it('refuses what the registry does not open, and unknown ids, writing nothing and never touching the mic', async () => {
    const r = await rig();
    const cases: Array<[RunTarget, string, string]> = [
      [{ kind: 'level', levelId: 'foundations.02' }, 'locked', 'Pass Range finder to unlock.'],
      [{ kind: 'level', levelId: 'foundations.03' }, 'locked', 'Pass Pitch match to unlock.'],
      [{ kind: 'level', levelId: 'vibrato.01' }, 'locked', 'Pass the Foundations Boss Recital to unlock Vibrato.'],
      [{ kind: 'record', levelId: 'foundations.01' }, 'locked', 'Pass Range finder to chase personal records on it.'],
      [{ kind: 'audition', worldId: 'foundations' }, 'locked', 'Pass Range finder to unlock the audition.'],
      [{ kind: 'workout', itemIndex: 0 }, 'locked', 'Pass your first level to unlock the daily workout.'],
      [{ kind: 'level', levelId: 'foundations.99' }, 'unknown', ''],
      [{ kind: 'audition', worldId: 'song-stage' }, 'unknown', ''],
    ];
    for (const [target, code, message] of cases) {
      const runner = r.runnerMod.createRunner(target);
      expect(runner.phase.value, JSON.stringify(target)).toBe('error');
      expect(runner.error.value?.code, JSON.stringify(target)).toBe(code);
      if (message) expect(runner.error.value?.message).toBe(message);
      expect(runner.prepared.value).toBeNull();
      runner.sing();
      runner.listen();
      expect(runner.phase.value).toBe('error');
      runner.dispose();
    }
    expect(r.engine.starts).toBe(0);
    expect(fakes.buildDemo).not.toHaveBeenCalled();
    expect(await storedLog(r)).toEqual([]);
  });
});

// ---------------------------------------------------------------- Listen

describe('listen', () => {
  it('plays the demo from the tap at the reference volume, with the earned vibrato style only, and toggles off', async () => {
    const r = await rig();
    r.settings.updateSettings({ referenceVolume: 0.4, vibratoStyle: 'classical' }); // the style setting is not earned yet
    const stopped = vi.fn();
    fakes.buildDemo.mockImplementation(() => ({ startAt: 0.05, endAt: 3, stop: stopped }));
    const runner = r.runnerMod.createRunner({ kind: 'level', levelId: 'foundations.01' });
    runner.listen();
    expect(runner.phase.value).toBe('listening');
    const [def, realized, synth, ctx, dest, opts] = fakes.buildDemo.mock.calls[0];
    expect(def).toBe(runner.prepared.value!.def);
    expect(realized).toBe(runner.prepared.value!.realized);
    expect(synth).toBe(r.synth);
    expect(ctx).toBe(r.engine.context);
    expect(dest).toBe(r.engine.output);
    expect(opts).toEqual({ vibratoStyle: 'pop', gain: 0.4 });

    setClock(r, 3.1); // the demo ended on the AudioContext clock
    expect(runner.phase.value).toBe('idle');

    runner.listen();
    runner.listen(); // a second tap stops it
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(runner.phase.value).toBe('idle');
    expect(r.engine.starts).toBe(0); // Listen never opens the mic
  });
});

// ---------------------------------------------------------------- a whole take

describe('sing: one take, start to finish', () => {
  it('a passing Range finder: written, judged, the range saved, the take kept, progress recomputed', async () => {
    const r = await rig();
    const runner = r.runnerMod.createRunner({ kind: 'level', levelId: 'foundations.01' });
    await tapSing(runner);
    expect(r.engine.starts).toBe(1);
    expect(runner.phase.value).toBe('count-in');
    const p = runner.prepared.value!;
    const beats = p.def.countInBeats;
    expect(runner.countIn.value).toBe(beats);
    expect(r.synth.clicks).toHaveLength(beats);
    expect(r.synth.clicks[0].accent).toBe(true);
    expect(r.synth.metronomes).toEqual([]); // no metronome in the Range finder: count-in clicks only
    // Unknown route = a speaker: the starting pitch ends well before the downbeat.
    const downbeat = runner.origin.value!;
    expect(r.synth.notes).toHaveLength(1);
    expect(r.synth.notes[0].startAt! + r.synth.notes[0].duration).toBeCloseTo(downbeat - 0.6, 9);
    expect(runner.cue.value).toBe('Start in the middle');

    feed(r, runner, rangeSweep(45, 72));
    setClock(r, downbeat - 0.5 * (60 / p.bpm)); // half a beat before the downbeat: the last count
    expect(runner.countIn.value).toBe(1);
    setClock(r, downbeat + 3);
    expect(runner.phase.value).toBe('singing');
    expect(runner.countIn.value).toBeNull();
    expect(runner.progress.value).toBeCloseTo(3 / p.realized.totalSec, 2);
    await finishTake(r, runner);

    const outcome = runner.outcome.value!;
    expect(runner.phase.value).toBe('done');
    expect(r.runnerMod.lastOutcome.value).toBe(outcome);
    expect(outcome.evaluation.passed).toBe(true);
    expect(outcome.attempt).toMatchObject({ kind: 'practice', levelId: 'foundations.01', passed: true, tempoBpm: 60, takeId: outcome.savedTake!.id });
    expect(outcome.attempt.durationSec).toBeCloseTo(p.realized.countInSec + p.realized.totalSec, 6);
    expect(outcome.tiles.length).toBeGreaterThanOrEqual(1);
    expect(outcome.tip.text.length).toBeGreaterThan(0);
    expect(outcome.saveError).toBeNull();
    expect(outcome.nextBpm).toBeNull();
    expect(outcome.rangeSaved).toBe(true);
    expect(r.session.activeProfile.value?.range).toMatchObject({ extended: { low: 45, high: 72 }, comfortable: { low: 47, high: 69 } });
    expect(outcome.before.levels['foundations.01'].status).toBe('current');
    expect(outcome.after.levels['foundations.02'].status).toBe('current');
    expect(r.session.snapshot.value).toEqual(outcome.after);
    expect(outcome.unlocked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'level-passed', levelId: 'foundations.01' }),
        expect.objectContaining({ kind: 'level-opened', levelId: 'foundations.02' }),
        expect.objectContaining({ kind: 'feature', featureId: 'dashboard' }),
      ]),
    );
    expect((await storedLog(r)).map((a) => a.id)).toEqual([outcome.attempt.id]);
    const saved = await r.session.appStorage.value!.takes.get(outcome.savedTake!.id);
    expect(saved).toMatchObject({ exerciseId: 'foundations.range-finder.1', latencyMs: 0 });
    expect(r.engine.frameListenerCount).toBe(0); // the recorder let go of the engine
    expect(r.flow.afterTakeActions(outcome).find((a) => a.primary)).toMatchObject({ kind: 'next-level', route: { name: 'level', params: { levelId: 'foundations.02' } } });

    runner.dispose();
    expect(r.engine.stops).toBe(1); // leaving releases the mic
  });

  it('a failed take is written as not passed, saves no range, and opens nothing', async () => {
    const r = await rig();
    const runner = r.runnerMod.createRunner({ kind: 'level', levelId: 'foundations.01' });
    const outcome = await singWhole(r, runner, (realized, def) => rangeSweep(realized.tonicMidi - 2, realized.tonicMidi + 3)(realized, def));
    expect(outcome.evaluation.passed).toBe(false);
    expect(outcome.attempt).toMatchObject({ passed: false, mastery: 0 });
    expect(outcome.rangeSaved).toBe(false);
    expect(r.session.activeProfile.value?.range).toBeNull();
    expect(outcome.unlocked).toEqual([]);
    expect((await storedLog(r)).map((a) => a.passed)).toEqual([false]);
    expect(r.session.snapshot.value.levels['foundations.01'].status).toBe('current');
    expect(r.flow.afterTakeActions(outcome).map((a) => [a.kind, a.primary])).toEqual([['retry', true], ['level', false]]);
  });

  it('compensates the route latency, plays every reference tone in headphones, and keeps the audio when asked', async () => {
    const r = await rig();
    await r.session.saveProfileRange(TENOR_RANGE);
    await seedPasses(r, 'foundations.01');
    r.settings.updateDeviceSettings({ route: 'wired' });
    r.settings.setLatencyCalibration('wired', { route: 'wired', method: 'loopback', roundTripMs: 120, jitterMs: 2, matched: 10, date: '2026-10-21' });
    const runner = r.runnerMod.createRunner({ kind: 'level', levelId: 'foundations.02' });
    await tapSing(runner);
    const p = runner.prepared.value!;
    const ctx = r.engine.context!;
    const downbeat = runner.origin.value! - 0.12;
    expect(downbeat).toBeCloseTo(ctx.currentTime + 0.15 + p.realized.countInSec, 9);
    // Every Listen tone, exactly as written.
    expect(r.synth.notes.map((n) => [n.midi, n.startAt! - downbeat, n.duration])).toEqual(p.realized.reference.map((t) => [t.midi, expect.closeTo(t.start, 9), expect.closeTo(t.end - t.start, 9)]));
    const sampleRate = 8000;
    r.engine.recording = { samples: new Float32Array(sampleRate * (p.realized.totalSec + 1)).fill(0.1), sampleRate, startTime: runner.origin.value! - 0.25 };
    feed(r, runner, good);
    await finishTake(r, runner);
    const outcome = runner.outcome.value!;
    expect(outcome.evaluation.passed).toBe(true);
    expect(outcome.take.latencyMs).toBe(120);
    expect(r.engine.recordings).toBe(1);
    expect(outcome.take.audio).not.toBeNull();
    expect(outcome.savedTake?.audioRef).not.toBeNull();
    expect(outcome.savedTake?.latencyMs).toBe(120);
  });

  it('keeps no audio when the singer turned that off', async () => {
    const r = await rig();
    r.settings.updateSettings({ keepTakeAudio: false });
    const runner = r.runnerMod.createRunner({ kind: 'level', levelId: 'foundations.01' });
    const outcome = await singWhole(r, runner, rangeSweep(45, 72));
    expect(r.engine.recordings).toBe(0);
    expect(outcome.take.audio).toBeNull();
    expect(outcome.savedTake?.audioRef).toBeNull();
  });
});

// ---------------------------------------------------------------- stopping, interruptions, leaving

describe('sing: nothing is written unless a take is judged', () => {
  it('Stop in the count-in cancels: no attempt, nothing left playing or listening', async () => {
    const r = await rig();
    const runner = r.runnerMod.createRunner({ kind: 'level', levelId: 'foundations.01' });
    await tapSing(runner);
    feed(r, runner, rangeSweep(45, 72));
    runner.stop();
    expect(runner.phase.value).toBe('idle');
    expect(runner.origin.value).toBeNull();
    expect(runner.countIn.value).toBeNull();
    expect(r.synth.stopAlls).toBeGreaterThan(0);
    expect(r.synth.notes.every((n) => n.stopped)).toBe(true);
    expect(r.engine.frameListenerCount).toBe(0);
    setClock(r, 1000);
    await new Promise((res) => setTimeout(res, 20));
    expect(runner.phase.value).toBe('idle');
    expect(await storedLog(r)).toEqual([]);
    expect(r.runnerMod.lastOutcome.value).toBeNull();

    // And the next tap is a fresh take.
    const outcome = await singWhole(r, runner, rangeSweep(45, 72));
    expect(outcome.attempt.passed).toBe(true);
  });

  it('an interruption mid-take cancels it with a plain message and writes nothing', async () => {
    const r = await rig();
    const runner = r.runnerMod.createRunner({ kind: 'level', levelId: 'foundations.01' });
    await tapSing(runner);
    feed(r, runner, rangeSweep(45, 72));
    setClock(r, runner.origin.value! + 5);
    expect(runner.phase.value).toBe('singing');
    r.engine.set('interrupted', { code: 'session-interrupted', message: 'call' });
    expect(runner.phase.value).toBe('error');
    expect(runner.error.value?.code).toBe('interrupted');
    expect(runner.error.value?.message).toMatch(/nothing was saved/);
    expect(runner.progress.value).toBeNull();
    await new Promise((res) => setTimeout(res, 20));
    expect(await storedLog(r)).toEqual([]);
  });

  it('a blocked mic is a mic error with the fix, and nothing is written', async () => {
    const r = await rig();
    r.engine.startResult = { code: 'permission-denied', message: 'NotAllowedError' };
    const runner = r.runnerMod.createRunner({ kind: 'level', levelId: 'foundations.01' });
    await tapSing(runner);
    expect(runner.phase.value).toBe('error');
    expect(runner.error.value).toMatchObject({ code: 'mic' });
    expect(runner.error.value?.message).toMatch(/^Microphone blocked\./);
    expect(r.synth.clicks).toEqual([]);
    // Try again after allowing it.
    r.engine.startResult = 'running';
    const outcome = await singWhole(r, runner, rangeSweep(45, 72));
    expect(outcome.attempt.passed).toBe(true);
    expect(r.engine.starts).toBe(2);
  });

  it('a failure while scheduling the count-in leaves nothing recording and says so', async () => {
    const r = await rig();
    vi.spyOn(r.synth, 'click').mockImplementationOnce(() => {
      throw new DOMException('the context is closed', 'InvalidStateError');
    });
    const runner = r.runnerMod.createRunner({ kind: 'level', levelId: 'foundations.01' });
    await tapSing(runner);
    expect(runner.phase.value).toBe('error');
    expect(runner.error.value?.code).toBe('internal');
    expect(r.engine.frameListenerCount).toBe(0);
    expect(r.synth.stopAlls).toBeGreaterThan(0);
  });

  it('Stop while singing ends the take there and judges what was sung', async () => {
    const r = await rig();
    const runner = r.runnerMod.createRunner({ kind: 'level', levelId: 'foundations.01' });
    await tapSing(runner);
    const origin = runner.origin.value!;
    feed(r, runner, rangeSweep(45, 72), (f) => f.t < 8);
    setClock(r, origin + 8);
    runner.stop();
    await until(() => runner.phase.value === 'done');
    const outcome = runner.outcome.value!;
    expect(outcome.attempt.passed).toBe(false); // the top was never reached
    expect(outcome.attempt.durationSec).toBeCloseTo(runner.prepared.value!.realized.countInSec + 8, 6);
    expect(await storedLog(r)).toHaveLength(1);
  });

  it('leaving in the middle of a take writes nothing and releases the mic', async () => {
    const r = await rig();
    const runner = r.runnerMod.createRunner({ kind: 'level', levelId: 'foundations.01' });
    await tapSing(runner);
    feed(r, runner, rangeSweep(45, 72));
    setClock(r, runner.origin.value! + 5);
    runner.dispose();
    expect(r.engine.stops).toBe(1);
    setClock(r, 1000);
    await new Promise((res) => setTimeout(res, 20));
    expect(await storedLog(r)).toEqual([]);
    runner.sing(); // a disposed runner does nothing
    expect(r.engine.starts).toBe(1);
  });

  it('one screen leaving never releases a mic another runner has since opened', async () => {
    const r = await rig();
    const first = r.runnerMod.createRunner({ kind: 'level', levelId: 'foundations.01' });
    const second = r.runnerMod.createRunner({ kind: 'level', levelId: 'foundations.01' });
    await tapSing(second);
    first.dispose();
    expect(r.engine.stops).toBe(0);
    second.dispose();
    expect(r.engine.stops).toBe(1);
  });
});

// ---------------------------------------------------------------- ladders, auditions, workouts, records

describe('sing: what a take counts for', () => {
  it('a tempo ladder climbs from the log: rung by rung, and the rung survives a relaunch', async () => {
    let r = await rig();
    await r.session.saveProfileRange(TENOR_RANGE);
    await seedPasses(r, 'inflections.boss');
    const def = getExercise('runs.run.1')!;
    const [r0, r1] = def.tempoLadder!;
    let runner = r.runnerMod.createRunner({ kind: 'level', levelId: 'runs.01' });
    expect(runner.prepared.value).toMatchObject({ bpm: r0, ladder: { rungs: def.tempoLadder, index: 0 } });
    expect(r.synth.metronomes).toEqual([]);

    const outcome = await singWhole(r, runner, good);
    expect(r.synth.metronomes).toEqual([{ bpm: r0, startAt: outcome.take.downbeat, stopped: true }]);
    expect(outcome.evaluation.passed).toBe(true); // the rung was sung well...
    expect(outcome.attempt).toMatchObject({ passed: false, tempoBpm: r0 }); // ...but a lower rung never passes the level
    expect(outcome.nextBpm).toBe(r1);
    expect(r.flow.afterTakeActions(outcome).find((a) => a.primary)?.kind).toBe('retry');
    runner.dispose();
    expect(r.runnerMod.createRunner({ kind: 'level', levelId: 'runs.01' }).prepared.value?.bpm).toBe(r1);

    // Relaunch: a fresh page on the same storage.
    vi.resetModules();
    r = await rig();
    runner = r.runnerMod.createRunner({ kind: 'level', levelId: 'runs.01' });
    expect(runner.prepared.value).toMatchObject({ bpm: r1, ladder: { index: 1 } });
  });

  it('an audition sings its NEXT test, stops at the first miss, and moves on after a pass', async () => {
    const r = await rig();
    await r.session.saveProfileRange(TENOR_RANGE);
    await seedPasses(r, 'foundations.01');
    const target: RunTarget = { kind: 'audition', worldId: 'foundations' };
    let runner = r.runnerMod.createRunner(target);
    expect(runner.prepared.value).toMatchObject({
      def: { id: 'foundations.audition.1' },
      level: null,
      world: { id: 'foundations' },
      audition: { index: 0, count: 4, unlocksFirst: 'Pitch match', unlocksLast: 'Sustain II' },
    });

    const miss = await singWhole(r, runner, singer({ offsetSemis: 2 }));
    expect(miss.attempt).toMatchObject({ kind: 'audition', levelId: null, exerciseId: 'foundations.audition.1', passed: false });
    expect(r.flow.afterTakeActions(miss)).toEqual([expect.objectContaining({ kind: 'audition-results', primary: true, route: { name: 'audition', params: { worldId: 'foundations' } } })]);
    runner.dispose();

    runner = r.runnerMod.createRunner(target); // a missed test stays next
    expect(runner.prepared.value?.def.id).toBe('foundations.audition.1');
    const pass = await singWhole(r, runner, good);
    expect(pass.attempt.passed).toBe(true);
    expect(pass.after.levels['foundations.04']).toMatchObject({ status: 'passed', viaAudition: true });
    expect(r.flow.afterTakeActions(pass).find((a) => a.primary)?.kind).toBe('next-test');
    runner.dispose();

    expect(r.runnerMod.createRunner(target).prepared.value).toMatchObject({ def: { id: 'foundations.audition.2' }, audition: { index: 1 } });
  });

  it('workout takes are written as workout attempts and recorded in the session', async () => {
    const r = await rig();
    await r.session.saveProfileRange(TENOR_RANGE);
    await seedPasses(r, 'foundations.01');
    const session = r.workout.startWorkout(5);
    expect(session.workout.items[0]).toMatchObject({ stage: 'warm-up', source: 'routine' });
    let runner = r.runnerMod.createRunner({ kind: 'workout', itemIndex: 0 });
    expect(runner.prepared.value).toMatchObject({ def: { id: 'routine.warm-up' }, level: null, world: null, workout: { itemIndex: 0, itemCount: session.workout.items.length, take: 1 } });
    const outcome = await singWhole(r, runner, good);
    expect(outcome.attempt).toMatchObject({ kind: 'workout', levelId: null, exerciseId: 'routine.warm-up', passed: true });
    expect(r.workout.activeWorkout.value?.results[0].attemptIds).toEqual([outcome.attempt.id]);
    runner.dispose();
    runner = r.runnerMod.createRunner({ kind: 'workout', itemIndex: 0 });
    expect(runner.prepared.value?.workout?.take).toBe(2);

    const levelItem = session.workout.items.findIndex((i) => i.source === 'level');
    expect(levelItem).toBeGreaterThan(0);
    runner = r.runnerMod.createRunner({ kind: 'workout', itemIndex: levelItem });
    expect(runner.prepared.value).toMatchObject({ level: { id: session.workout.items[levelItem].levelId } });
    const levelTake = await singWhole(r, runner, good);
    expect(levelTake.attempt).toMatchObject({ kind: 'workout', levelId: session.workout.items[levelItem].levelId });
    expect(r.workout.activeWorkout.value?.results[levelItem].attemptIds).toEqual([levelTake.attempt.id]);

    expect(r.runnerMod.createRunner({ kind: 'workout', itemIndex: 99 }).error.value?.code).toBe('unknown');
  });

  it('a personal-record attempt is sung at the pass tempo and written as a record', async () => {
    const r = await rig();
    await r.session.saveProfileRange(TENOR_RANGE);
    await seedPasses(r, 'runs.01');
    const def = getExercise('runs.run.1')!;
    const runner = r.runnerMod.createRunner({ kind: 'record', levelId: 'runs.01' });
    expect(runner.prepared.value).toMatchObject({ bpm: def.tempoBpm, ladder: { index: def.tempoLadder!.length - 1 } });
    const outcome = await singWhole(r, runner, good);
    expect(outcome.attempt).toMatchObject({ kind: 'record', levelId: 'runs.01', tempoBpm: def.tempoBpm });
    expect(r.flow.afterTakeActions(outcome).map((a) => a.kind)).toEqual(['retry', 'level']);
  });
});
