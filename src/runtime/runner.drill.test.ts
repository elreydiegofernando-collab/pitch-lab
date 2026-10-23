/**
 * Lesson practice at runtime (RunTarget 'drill', src/lessons): practice tries sung through the real runner on the real
 * session, analyzers and progression (a fake audio engine and synth, as in runner.test.ts). What a try is open for, how
 * it is written (kind 'practice', no level), what it never touches (a level, a world, the range), the good tries it
 * counts, the coaching, and what the report offers next. Three known lessons stand in for the Foundations content, so
 * these cases do not move with it. Each test gets a fresh IndexedDB and a fresh module graph.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTrack, sequence } from '../analysis/fixtures';
import type { EngineError, EngineState, Recording } from '../audio/engine-types';
import type { GlideSpec, MetronomeHandle, NoteSpec, ScheduledHandle } from '../audio/synth-types';
import { coachTake } from '../coaching/coach';
import type { PitchFrame } from '../core/types';
import { WORLDS, getExercise, realize, type ExerciseDef, type RealizedExercise } from '../exercises';
import { GOOD_SINGER, singTake, type SingerModel } from '../exercises/test-singer';
import { CHECK_CLOSED_HINT, isCheckOpen } from '../lessons/progress';
import type { LessonDef } from '../lessons/types';
import { routeOf } from '../router';
import { installNoOpfs } from '../storage/test-helpers';
import type { AttemptRecord } from '../storage/schema';
import type { ExerciseRunner, GuardContext, RunTarget } from './types';

// ---------------------------------------------------------------- the lessons

const lessons = vi.hoisted(() => {
  const learn = { what: 'What it is.', why: 'Why it matters.', how: ['Listen.', 'Think it.', 'Sing it.'], onScreen: ['The bar is the note.'], terms: [] };
  /** Pitch match's lesson: an echo step that asks for two good tries in tune, then one slide sung to its end. */
  const pitch: LessonDef = {
    levelId: 'foundations.02',
    title: 'Match one note',
    outcome: 'Hear a note, then sing it back on it.',
    learn,
    practice: [
      { exerciseId: 'foundations.audition.5', title: 'Echo one note', ask: 'Listen, then sing it back.', goodTries: 2, good: { conditions: [{ metric: 'accuracy.inTolerancePct', op: '>=', value: 50 }] } },
      { exerciseId: 'foundations.audition.8', title: 'One slide', ask: 'Slide up and back down.', goodTries: 1, good: { conditions: [] } },
    ],
  };
  /** The Range finder's lesson, practising on the Range finder itself: a practice try must still never save a range. */
  const range: LessonDef = {
    levelId: 'foundations.01',
    title: 'Find your comfortable notes',
    outcome: 'Know your easy low and high notes.',
    learn,
    practice: [{ exerciseId: 'foundations.range.1', title: 'Explore', ask: 'Slide down, then up.', goodTries: 1, good: { conditions: [] } }],
  };
  /** Hold it's lesson, with a rule its drill can never meet (a slide reading on a held note): no try counts. */
  const strict: LessonDef = {
    levelId: 'foundations.03',
    title: 'Hold it',
    outcome: 'Hold a note.',
    learn,
    practice: [{ exerciseId: 'foundations.audition.5', title: 'Echo and hold', ask: 'Listen, then hold it.', goodTries: 1, good: { conditions: [{ metric: 'glide.smoothness', op: '>=', value: 0 }] } }],
  };
  /** A lesson whose step names retired material (the old Sustain II): never sung, whatever the lesson data says. */
  const retired: LessonDef = {
    levelId: 'foundations.13',
    title: 'Hold it steady',
    outcome: 'Hold a note steady.',
    learn,
    practice: [{ exerciseId: 'foundations.sustain.2', title: 'Old material', ask: 'Hold it.', goodTries: 1, good: { conditions: [] } }],
  };
  return { byLevel: { 'foundations.01': range, 'foundations.02': pitch, 'foundations.03': strict, 'foundations.13': retired } };
});
vi.mock('../lessons/foundations', () => ({ FOUNDATIONS_LESSONS: lessons.byLevel }));

const LEVEL = 'foundations.02';
const ECHO = 'foundations.audition.5';
const SLIDE = 'foundations.audition.8';
const step = (n: number): RunTarget => ({ kind: 'drill', levelId: LEVEL, step: n });

// ---------------------------------------------------------------- fakes (as in runner.test.ts)

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
  recording: Recording = { samples: new Float32Array(0), sampleRate: 48000, startTime: 0 };
  starts = 0;
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
    return Promise.resolve().then(() => this.set('running', null));
  }
  stop(): Promise<void> {
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
  startRecording(): void {}
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
}

class FakeSynth {
  notes: NoteSpec[] = [];
  metronomes = 0;
  setVolume(): void {}
  playNote(spec: NoteSpec): ScheduledHandle {
    this.notes.push(spec);
    const startAt = spec.startAt ?? 0;
    return { startAt, endAt: startAt + spec.duration, stop: () => undefined };
  }
  glides: GlideSpec[] = [];
  /** A Listen slide (a lesson's echo plays a slide as it is sung). */
  playGlide(spec: GlideSpec): ScheduledHandle {
    this.glides.push(spec);
    const startAt = spec.startAt ?? 0;
    return { startAt, endAt: startAt + spec.holdBefore + spec.glideDuration + spec.holdAfter, stop: () => undefined };
  }
  playSequence(): ScheduledHandle {
    throw new Error('the runner never plays sequences itself');
  }
  click(): void {}
  startMetronome(bpm: number, opts?: { startAt?: number }): MetronomeHandle {
    this.metronomes += 1;
    return { startAt: opts?.startAt ?? 0, endAt: Infinity, bpm, beat0: opts?.startAt ?? 0, setBpm: () => undefined, stop: () => undefined };
  }
  stopAll(): void {}
}

const fakes = vi.hoisted(() => ({ engine: null as unknown, synth: null as unknown }));

vi.mock('../audio/engine', () => ({ getEngine: () => fakes.engine }));
vi.mock('../state/audio', () => ({
  getSynth: () => {
    (fakes.engine as { ensureContext(): unknown }).ensureContext();
    return fakes.synth;
  },
}));
vi.mock('../audio/demos', () => ({ buildDemo: vi.fn() }));
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
  const flow = await import('./flow');
  const guard = await import('./guard');
  await session.bootSession();
  return { engine, synth, session, runnerMod, flow, guard };
}
type Rig = Awaited<ReturnType<typeof rig>>;

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
  installNoOpfs();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
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

type Rendition = (realized: RealizedExercise, def: ExerciseDef) => PitchFrame[];

const singer =
  (model: Partial<SingerModel> = {}): Rendition =>
  (realized) =>
    singTake(realized, { ...GOOD_SINGER, ...model });
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

async function tapSing(runner: ExerciseRunner): Promise<void> {
  runner.sing();
  await until(() => ['count-in', 'singing', 'error'].includes(runner.phase.value));
}

/** The singer's frames reach the input `origin` (downbeat + round trip) later than they were sung. */
function feed(r: Rig, runner: ExerciseRunner, rendition: Rendition, keep: (f: PitchFrame) => boolean = () => true): void {
  const p = runner.prepared.value!;
  const origin = runner.origin.value!;
  for (const f of rendition(p.realized, p.def)) if (keep(f)) r.engine.emit({ ...f, t: f.t + origin });
}

async function singWhole(r: Rig, runner: ExerciseRunner, rendition: Rendition) {
  await tapSing(runner);
  feed(r, runner, rendition);
  setClock(r, runner.origin.value! + runner.prepared.value!.realized.totalSec + 2);
  await until(() => runner.phase.value === 'done' || runner.phase.value === 'error');
  expect(runner.error.value).toBeNull();
  return runner.outcome.value!;
}

/** A passing row for every Foundations level up to `throughLevelId`, written straight to storage, then the session reloaded. */
async function seedPasses(r: Rig, throughLevelId: string): Promise<void> {
  const storage = r.session.appStorage.value!;
  const profileId = r.session.activeProfile.value!.id;
  for (const level of [...WORLDS[0].levels].sort((a, b) => a.index - b.index)) {
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
  throw new Error(`no level ${throughLevelId}`);
}

const TENOR_RANGE = { comfortable: { low: 47, high: 69 }, extended: { low: 45, high: 72 }, measuredAt: '2026-10-21T09:00:00.000Z' };

/** Pitch match open (the Range finder passed) and a range saved. */
async function pitchMatchOpen(r: Rig): Promise<void> {
  await r.session.saveProfileRange(TENOR_RANGE);
  await seedPasses(r, 'foundations.01');
}

/** A good try of a step's drill as the runner writes it: practice, no level, sung to its end, in tune. */
async function goodTry(r: Rig, exerciseId: string): Promise<void> {
  const def = getExercise(exerciseId)!;
  const whole = realize(def, null, 'unknown', { bpm: def.tempoBpm });
  await r.session.appStorage.value!.attempts.add({
    profileId: r.session.activeProfile.value!.id,
    exerciseId,
    levelId: null,
    kind: 'practice',
    score: 0.9,
    passed: true,
    mastery: 0,
    metrics: { 'accuracy.inTolerancePct': 80 },
    durationSec: whole.countInSec + whole.totalSec,
    tonicMidi: 60,
    tempoBpm: def.tempoBpm,
    takeId: null,
  });
}

async function storedLog(r: Rig): Promise<AttemptRecord[]> {
  return r.session.appStorage.value!.attempts.listByProfile(r.session.activeProfile.value!.id);
}

function guardContext(r: Rig): GuardContext {
  const log = r.session.attemptLog.value;
  const snapshot = r.session.snapshot.value;
  return {
    snapshot,
    worlds: WORLDS,
    songRequiredWorld: () => undefined,
    songsLoaded: true,
    hasOutcome: true,
    workoutItems: null,
    checkOpen: (levelId) => isCheckOpen(levelId, log, snapshot),
  };
}

const statuses = (levels: Record<string, { status: string }>) => Object.fromEntries(Object.entries(levels).map(([id, l]) => [id, l.status]));
const kinds = (actions: Array<{ kind: string; primary: boolean }>) => actions.map((a) => `${a.kind}${a.primary ? '*' : ''}`);

// ---------------------------------------------------------------- the echo

describe('playReferenceTone: the chunk the singer is about to sing, exactly', () => {
  it('a held note as a note; a Listen slide as one glide that arrives by the tone’s end', async () => {
    const { playReferenceTone } = await import('./runner');
    const calls: unknown[] = [];
    const handle = (startAt: number, endAt: number): ScheduledHandle => ({ startAt, endAt, stop: () => undefined });
    const synth = {
      playNote: (spec: NoteSpec) => (calls.push(['note', spec]), handle(spec.startAt!, spec.startAt! + spec.duration)),
      playGlide: (spec: GlideSpec) => (calls.push(['glide', spec]), handle(spec.startAt!, spec.startAt! + spec.glideDuration)),
    };
    const opts = { timbre: 'piano' as const, gain: 0.5 };
    expect(playReferenceTone(synth, { midi: 60, start: 1, end: 2.5 }, 10, opts)).toMatchObject({ startAt: 11, endAt: 12.5 });
    playReferenceTone(synth, { midi: 60, start: 3, end: 5, toMidi: 64 }, 10, opts);
    playReferenceTone(synth, { midi: 62, start: -2, end: 0, toMidi: 62 }, 10, opts); // no change of pitch: a note
    expect(calls).toEqual([
      ['note', { midi: 60, startAt: 11, duration: 1.5, timbre: 'piano', gain: 0.5 }],
      ['glide', { fromMidi: 60, toMidi: 64, startAt: 13, holdBefore: 0, glideDuration: 2, holdAfter: 0, timbre: 'piano', gain: 0.5 }],
      ['note', { midi: 62, startAt: 8, duration: 2, timbre: 'piano', gain: 0.5 }],
    ]);
  });
});

describe('referenceVoices: a Listen slide sounds as one slide, a siren as one slide each way (review R9)', () => {
  it('joins a held note, its slide and its landing into one glide, and leaves every other tone a note', async () => {
    const { referenceVoices } = await import('./runner');
    const tones = [
      { midi: 55, start: 0, end: 1 },
      { midi: 55, start: 1, end: 3, toMidi: 57 },
      { midi: 57, start: 3, end: 4 },
      { midi: 60, start: 8, end: 9 }, // a plain echo note
    ];
    expect(referenceVoices(tones)).toEqual([
      { kind: 'glide', fromMidi: 55, toMidi: 57, start: 0, holdBefore: 1, glideDuration: 2, holdAfter: 1 },
      { kind: 'note', tone: { midi: 60, start: 8, end: 9 } },
    ]);
  });

  it('plays a siren as one glide up and one glide down, back to back, and keeps two touching notes of an echo apart', async () => {
    const { referenceVoices } = await import('./runner');
    expect(referenceVoices([{ midi: 51, start: 0, end: 1 }, { midi: 51, start: 1, end: 3, toMidi: 58 }, { midi: 58, start: 3, end: 5, toMidi: 51 }])).toEqual([
      { kind: 'glide', fromMidi: 51, toMidi: 58, start: 0, holdBefore: 1, glideDuration: 2, holdAfter: 0 },
      { kind: 'glide', fromMidi: 58, toMidi: 51, start: 3, holdBefore: 0, glideDuration: 2, holdAfter: 0 },
    ]);
    expect(referenceVoices([{ midi: 54, start: 0, end: 1 }, { midi: 56, start: 1, end: 2 }]).map((v) => v.kind)).toEqual(['note', 'note']);
  });
});

// ---------------------------------------------------------------- preparing

describe('a practice try: what it is open for', () => {
  it('refuses a step while its lesson’s level is locked, and an unknown lesson or step, writing nothing and never touching the mic', async () => {
    const r = await rig();
    const cases: Array<[RunTarget, string, string]> = [
      [step(0), 'locked', 'Pass Range finder to unlock.'],
      [step(1), 'locked', 'Pass Range finder to unlock.'],
      [step(2), 'unknown', 'This practice step is not available. Go back to the lesson and choose it again.'],
      [step(-1), 'unknown', ''],
      [step(0.5), 'unknown', ''],
      [{ kind: 'drill', levelId: 'foundations.05', step: 0 }, 'unknown', ''], // a level with no lesson
      [{ kind: 'drill', levelId: 'foundations.04', step: 0 }, 'unknown', ''], // no such level since the rebuild
      [{ kind: 'drill', levelId: 'foundations.99', step: 0 }, 'unknown', ''],
      // A step on retired material is never sung, before its level is even open.
      [{ kind: 'drill', levelId: 'foundations.13', step: 0 }, 'unknown', 'This practice step is not available. Go back to the lesson and choose it again.'],
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
    expect(await storedLog(r)).toEqual([]);
    // The route guard refuses the same step with the same line.
    const verdict = r.guard.guardRoute(routeOf('sing', { target: 'drill', levelId: LEVEL, itemIndex: '0' }), guardContext(r));
    expect(verdict).toMatchObject({ ok: false, hint: 'Pass Range finder to unlock.' });
    // The Range finder is open from the start, and so is its lesson's practice.
    expect(r.runnerMod.createRunner({ kind: 'drill', levelId: 'foundations.01', step: 0 }).phase.value).toBe('idle');
  });

  it('opens with its lesson’s level, and prepares the step’s drill in the singer’s range: no level, no pass lines, its good tries so far', async () => {
    const r = await rig();
    await pitchMatchOpen(r);
    const runner = r.runnerMod.createRunner(step(0));
    expect(runner.error.value).toBeNull();
    const def = getExercise(ECHO)!;
    const p = runner.prepared.value!;
    expect(p).toMatchObject({
      target: step(0),
      def: { id: ECHO },
      level: null,
      world: { id: 'foundations' },
      bpm: def.tempoBpm,
      ladder: null,
      passLines: [],
      usingDefaultRange: false,
      audition: null,
      workout: null,
      checkup: null,
      drill: { levelId: LEVEL, step: 0, stepCount: 2, good: 0, needed: 2 },
    });
    expect(p.realized).toEqual(realize(def, TENOR_RANGE, 'tenor', { bpm: def.tempoBpm }));
    expect(r.runnerMod.createRunner(step(1)).prepared.value).toMatchObject({ def: { id: SLIDE }, drill: { step: 1, good: 0, needed: 1 } });
  });
});

// ---------------------------------------------------------------- singing

describe('a practice try: sung, written, counted', () => {
  it('nothing sounds while the singer sings: the note is played before each sung note, never over it', async () => {
    const r = await rig();
    await pitchMatchOpen(r);
    const runner = r.runnerMod.createRunner(step(0));
    await tapSing(runner);
    const p = runner.prepared.value!;
    const downbeat = runner.origin.value!; // no latency is calibrated: the origin is the downbeat
    expect(r.synth.notes.length).toBeGreaterThan(0);
    for (const tone of r.synth.notes) {
      const from = tone.startAt! - downbeat;
      const to = from + tone.duration;
      for (const sung of p.realized.notes) expect(to <= sung.start + 1e-9 || from >= sung.end - 1e-9, `tone ${from.toFixed(2)}-${to.toFixed(2)}`).toBe(true);
    }
    // Every sung note has the note played before it (Listen steps).
    for (const sung of p.realized.notes) expect(r.synth.notes.some((t) => t.startAt! - downbeat < sung.start && t.midi === sung.midi)).toBe(true);
    expect(r.synth.metronomes).toBe(0);
    runner.dispose();
  });

  it('the siren step plays each Listen slide as one sliding sound before the singer slides, never over the singing (review R9)', async () => {
    const r = await rig();
    await pitchMatchOpen(r);
    const runner = r.runnerMod.createRunner(step(1));
    await tapSing(runner);
    const p = runner.prepared.value!;
    const downbeat = runner.origin.value!;
    const listenSlides = p.realized.reference.filter((t) => t.toMidi !== undefined && t.toMidi !== t.midi);
    expect(listenSlides.length).toBeGreaterThan(0);
    expect(r.synth.glides.length).toBeGreaterThan(0);
    for (const g of r.synth.glides) {
      const from = g.startAt! - downbeat;
      const to = from + g.holdBefore + g.glideDuration + g.holdAfter;
      for (const sung of p.realized.notes) expect(to <= sung.start + 1e-9 || from >= sung.end - 1e-9, `glide ${from.toFixed(2)}-${to.toFixed(2)}`).toBe(true);
    }
    // Every Listen slide is inside a glide, and no slide's ends are played as notes of their own.
    for (const s of listenSlides) {
      expect(r.synth.glides.some((g) => g.startAt! - downbeat <= s.start + 1e-6 && g.startAt! - downbeat + g.holdBefore + g.glideDuration + g.holdAfter >= s.end - 1e-6)).toBe(true);
      expect(r.synth.notes.some((n) => Math.abs(n.startAt! - downbeat - s.start) < 1e-6 || Math.abs(n.startAt! - downbeat - s.end) < 1e-6)).toBe(false);
    }
    runner.dispose();
  });

  it('a good try is written as practice with no level, moves no level, counts towards its step, and is coached', async () => {
    const r = await rig();
    await pitchMatchOpen(r);
    const runner = r.runnerMod.createRunner(step(0));
    const first = await singWhole(r, runner, good);
    const p = runner.prepared.value!;
    expect(first.attempt).toMatchObject({ kind: 'practice', levelId: null, exerciseId: ECHO, tempoBpm: p.bpm });
    expect(first.attempt.durationSec).toBeCloseTo(p.realized.countInSec + p.realized.totalSec, 6);
    expect(first.prepared.drill).toEqual({ levelId: LEVEL, step: 0, stepCount: 2, good: 1, needed: 2, ready: false, openStep: 0 });
    expect(p.drill).toEqual(first.prepared.drill); // a try sung again from here counts on from it
    // Practice never moves a level: nothing opened, nothing passed, the range untouched.
    expect(statuses(first.after.levels)).toEqual(statuses(first.before.levels));
    expect(first.after.worldsUnlocked).toEqual(first.before.worldsUnlocked);
    expect(first.unlocked).toEqual([]);
    expect(first.rangeSaved).toBe(false);
    expect(r.session.snapshot.value.levels[LEVEL].status).toBe('current');
    // A clean try's coaching line promises no tally (practice has none); the lesson's report shows the step's good tries.
    expect(first.tip).toMatchObject({ id: 'general.polish', text: 'Clean try: nothing to fix.' });
    expect(r.flow.afterTakeActions(first)).toEqual([
      { kind: 'next-try', label: 'Again', primary: true, route: routeOf('sing', { target: 'drill', levelId: LEVEL, itemIndex: '0' }) },
      { kind: 'lesson', label: 'Back to the lesson', primary: false, route: routeOf('level', { levelId: LEVEL }) },
    ]);
    // The coaching card works on a practice try as on any take.
    const coaching = coachTake(first, r.session.attemptLog.value);
    expect(coaching.tip.length).toBeGreaterThan(0);
    expect(coaching.problem).toBeDefined();
    runner.dispose();

    // The next visit reads the step's good tries from the log; the second good try finishes the step.
    const again = r.runnerMod.createRunner(step(0));
    expect(again.prepared.value?.drill).toMatchObject({ good: 1, needed: 2 });
    const second = await singWhole(r, again, good);
    expect(second.prepared.drill).toMatchObject({ good: 2, needed: 2 });
    expect(second.tip.text).toBe('Clean try: nothing to fix.');
    const next = r.flow.afterTakeActions(second);
    expect(kinds(next)).toEqual(['next-step*', 'next-try']);
    expect(next[0].route).toEqual(routeOf('sing', { target: 'drill', levelId: LEVEL, itemIndex: '1' }));
    for (const a of next) expect(r.guard.guardRoute(a.route, guardContext(r)), a.kind).toEqual({ ok: true });
    expect((await storedLog(r)).map((a) => [a.kind, a.levelId, a.exerciseId])).toEqual([
      ['practice', 'foundations.01', 'foundations.range.1'], // the seeded pass
      ['practice', null, ECHO],
      ['practice', null, ECHO],
    ]);
    again.dispose();
  });

  it('a try that is not good never counts: off pitch, stopped part way, or silent', async () => {
    const r = await rig();
    await pitchMatchOpen(r);
    const off = await singWhole(r, r.runnerMod.createRunner(step(0)), singer({ offsetSemis: 2 }));
    expect(off.prepared.drill).toMatchObject({ good: 0, needed: 2 });
    expect(r.flow.afterTakeActions(off)).toEqual([
      { kind: 'next-try', label: 'Try again', primary: true, route: routeOf('sing', { target: 'drill', levelId: LEVEL, itemIndex: '0' }) },
      { kind: 'lesson', label: 'Back to the lesson', primary: false, route: routeOf('level', { levelId: LEVEL }) },
    ]);

    const silent = await singWhole(r, r.runnerMod.createRunner(step(0)), singer({ silent: true }));
    expect(silent.attempt.durationSec).toBe(0);
    expect(silent.prepared.drill).toMatchObject({ good: 0 });
    expect(kinds(r.flow.afterTakeActions(silent))).toEqual(['next-try*', 'lesson']);

    // Sung well, but stopped half way: practice of practice, it counts for nothing.
    const runner = r.runnerMod.createRunner(step(0));
    await tapSing(runner);
    const p = runner.prepared.value!;
    const cut = 0.5 * p.realized.totalSec;
    feed(r, runner, good, (f) => f.t < cut);
    setClock(r, runner.origin.value! + cut);
    runner.stop();
    await until(() => runner.phase.value === 'done' || runner.phase.value === 'error');
    const stopped = runner.outcome.value!;
    expect(stopped.evaluation.notJudged).toBe('stopped');
    expect(stopped.prepared.drill).toMatchObject({ good: 0 });
    expect(kinds(r.flow.afterTakeActions(stopped))).toEqual(['next-try*', 'lesson']);
    expect(await storedLog(r)).toHaveLength(4); // the seeded pass and three practice tries
  });

  it('a clean try its step’s rule does not count is never called clean, and is sung again', async () => {
    const r = await rig();
    await r.session.saveProfileRange(TENOR_RANGE);
    await seedPasses(r, 'foundations.02');
    const target: RunTarget = { kind: 'drill', levelId: 'foundations.03', step: 0 };
    const outcome = await singWhole(r, r.runnerMod.createRunner(target), good);
    expect(outcome.tip).toMatchObject({ id: 'general.polish', text: 'Nearly there: sing it once more.' });
    expect(outcome.prepared.drill).toMatchObject({ good: 0, needed: 1 });
    expect(kinds(r.flow.afterTakeActions(outcome))).toEqual(['next-try*', 'lesson']);
    expect(r.flow.afterTakeActions(outcome)[0].label).toBe('Try again');
    // The drill's own pass rule passed it; the row and the coaching carry the step's verdict, with the runner's line
    // (never the stopped tip a clean miss read back gets).
    expect(outcome.evaluation.passed).toBe(true);
    expect(outcome.attempt.passed).toBe(false);
    expect(coachTake(outcome, r.session.attemptLog.value)).toMatchObject({ passed: false, missesInARow: 1, tip: 'Nearly there: sing it once more.' });
  });

  it('the last step’s good try offers the check: the level’s own take, which the guard opens', async () => {
    const r = await rig();
    await pitchMatchOpen(r);
    // Step 1 first (its two good tries), so the slide is the last step left: then the check opens.
    await goodTry(r, ECHO);
    await goodTry(r, ECHO);
    await r.session.reloadSession();
    const last = await singWhole(r, r.runnerMod.createRunner(step(1)), good);
    expect(last.attempt).toMatchObject({ kind: 'practice', levelId: null, exerciseId: SLIDE });
    expect(last.prepared.drill).toEqual({ levelId: LEVEL, step: 1, stepCount: 2, good: 1, needed: 1, ready: true, openStep: 2 });
    const actions = r.flow.afterTakeActions(last);
    expect(actions[0]).toEqual({ kind: 'take-check', label: 'Take the check', primary: true, route: routeOf('sing', { target: 'level', levelId: LEVEL }) });
    expect(kinds(actions)).toEqual(['take-check*', 'next-try']);
    for (const a of actions) expect(r.guard.guardRoute(a.route, guardContext(r)), a.kind).toEqual({ ok: true });
    // The check is the level's own exercise and pass rule, and only it can pass the level.
    expect(r.runnerMod.createRunner({ kind: 'level', levelId: LEVEL }).prepared.value).toMatchObject({ def: { id: 'foundations.match.1' }, level: { id: LEVEL } });
  });

  it('a missed check of a level taught by a lesson sends the singer back to practice first; the check again comes second', async () => {
    const r = await rig();
    await pitchMatchOpen(r);
    // The practice is done, so the check is open; the check then misses.
    await goodTry(r, ECHO);
    await goodTry(r, ECHO);
    await goodTry(r, SLIDE);
    await r.session.reloadSession();
    const miss = await singWhole(r, r.runnerMod.createRunner({ kind: 'level', levelId: LEVEL }), singer({ offsetSemis: 2 }));
    expect(miss.attempt).toMatchObject({ kind: 'practice', levelId: LEVEL, passed: false });
    expect(r.flow.afterTakeActions(miss)).toEqual([
      { kind: 'lesson', label: 'Back to practice', primary: true, route: routeOf('level', { levelId: LEVEL }) },
      expect.objectContaining({ kind: 'retry', label: 'Take the check again', primary: false, route: routeOf('sing', { target: 'level', levelId: LEVEL }) }),
    ]);
  });

  it('a try is coached by its step’s rule, never the drill’s own pass: a good try is no miss, an uncounted try is one', async () => {
    const r = await rig();
    await pitchMatchOpen(r);
    // The slide step counts any slide sung to its end; this one ends a whole step off, which the siren's own pass refuses.
    const off = await singWhole(r, r.runnerMod.createRunner(step(1)), singer({ offsetSemis: 2 }));
    expect(off.evaluation.passed).toBe(false);
    expect(off.attempt).toMatchObject({ kind: 'practice', levelId: null, passed: true }); // the row carries the step's verdict
    expect(off.prepared.drill).toMatchObject({ good: 1, needed: 1 });
    expect(coachTake(off, r.session.attemptLog.value)).toMatchObject({ passed: true, missesInARow: 0, depth: 1 });

    // The echo step asks for half its notes in tune: the same whole step off counts for nothing, and is a miss.
    const miss = await singWhole(r, r.runnerMod.createRunner(step(0)), singer({ offsetSemis: 2 }));
    expect(miss.attempt.passed).toBe(false);
    expect(coachTake(miss, r.session.attemptLog.value)).toMatchObject({ passed: false, missesInARow: 1 });
    const again = await singWhole(r, r.runnerMod.createRunner(step(0)), singer({ offsetSemis: 2 }));
    expect(coachTake(again, r.session.attemptLog.value)).toMatchObject({ passed: false, missesInARow: 2, depth: 2 });
  });

  it('a practice try never saves a range, even one that sings the Range finder well', async () => {
    const r = await rig();
    const target: RunTarget = { kind: 'drill', levelId: 'foundations.01', step: 0 };
    const tryIt = await singWhole(r, r.runnerMod.createRunner(target), rangeSweep(45, 72));
    expect(tryIt.attempt).toMatchObject({ kind: 'practice', levelId: null, exerciseId: 'foundations.range.1' });
    expect(tryIt.rangeSaved).toBe(false);
    expect(r.session.activeProfile.value?.range).toBeNull();
    expect(r.session.snapshot.value.levels['foundations.01'].status).toBe('current');
    expect(tryIt.unlocked).toEqual([]);
    expect(kinds(r.flow.afterTakeActions(tryIt))).toEqual(['take-check*', 'next-try']);
    // The level's own take (the check) is still what saves it.
    const check = await singWhole(r, r.runnerMod.createRunner({ kind: 'level', levelId: 'foundations.01' }), rangeSweep(45, 72));
    expect(check.rangeSaved).toBe(true);
    expect(r.session.snapshot.value.levels['foundations.01'].status).toBe('passed');
  });
});

// ---------------------------------------------------------------- the check after the practice

describe('the check opens after the practice (owner, 2026-10-23: a test alone "doesn’t train me to do better")', () => {
  it('refuses the check while the practice is not done, and opens it once every step has its good tries', async () => {
    const r = await rig();
    await pitchMatchOpen(r);
    const early = r.runnerMod.createRunner({ kind: 'level', levelId: LEVEL });
    expect(early.error.value).toMatchObject({ code: 'locked', message: CHECK_CLOSED_HINT });
    early.dispose();
    expect(r.guard.guardRoute(routeOf('sing', { target: 'level', levelId: LEVEL }), guardContext(r))).toMatchObject({ ok: false, hint: CHECK_CLOSED_HINT });
    await goodTry(r, ECHO);
    await goodTry(r, ECHO);
    await goodTry(r, SLIDE);
    await r.session.reloadSession();
    const ready = r.runnerMod.createRunner({ kind: 'level', levelId: LEVEL });
    expect(ready.error.value).toBeNull();
    expect(ready.prepared.value).toMatchObject({ level: { id: LEVEL } });
    ready.dispose();
  });

  it('a daily-workout item on a lesson whose check is closed sings the lesson’s next practice step instead', async () => {
    const r = await rig();
    await pitchMatchOpen(r);
    const workout = await import('./workout');
    const session = workout.startWorkout(10);
    const index = session.workout.items.findIndex((item) => item.levelId === LEVEL);
    expect(index, 'the workout plans the current lesson').toBeGreaterThanOrEqual(0);
    const runner = r.runnerMod.createRunner({ kind: 'workout', itemIndex: index });
    expect(runner.error.value).toBeNull();
    expect(runner.prepared.value).toMatchObject({ def: { id: ECHO }, level: null, drill: { levelId: LEVEL, step: 0 }, workout: { itemIndex: index } });
    runner.dispose();
  });
});
