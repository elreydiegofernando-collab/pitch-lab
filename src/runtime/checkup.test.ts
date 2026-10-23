/**
 * The voice check-up at runtime: its session (runtime/checkup.ts), every task sung through the real runner on the real
 * session, analyzers and progression (a fake audio engine and synth, as in runner.test.ts), what the report offers
 * next, and the route guard fed from the session. Each test gets a fresh IndexedDB and a fresh module graph.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTrack, sequence } from '../analysis/fixtures';
import type { EngineError, EngineState, Recording } from '../audio/engine-types';
import type { MetronomeHandle, NoteSpec, ScheduledHandle } from '../audio/synth-types';
import { CHECKUP_TASKS } from '../checkup/types';
import type { PitchFrame } from '../core/types';
import { WORLDS, getExercise, realize, type ExerciseDef, type RealizedExercise } from '../exercises';
import { GOOD_SINGER, singTake, type SingerModel } from '../exercises/test-singer';
import { computeSnapshot, withRoutines } from '../progress';
import { BASE_MS, P1 } from '../progress/test-fixtures';
import { routeOf, type Route } from '../router';
import type { AttemptRecord } from '../storage/schema';
import { installNoOpfs } from '../storage/test-helpers';
import { guardRoute } from './guard';
import type { ExerciseRunner, GuardContext, PreparedRun, TakeOutcome } from './types';

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
  setVolume(): void {}
  playNote(spec: NoteSpec): ScheduledHandle {
    const startAt = spec.startAt ?? 0;
    return { startAt, endAt: startAt + spec.duration, stop: () => undefined };
  }
  playGlide(): ScheduledHandle {
    throw new Error('the runner never plays glides itself');
  }
  playSequence(): ScheduledHandle {
    throw new Error('the runner never plays sequences itself');
  }
  click(): void {}
  startMetronome(bpm: number, opts?: { startAt?: number }): MetronomeHandle {
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
  fakes.engine = engine;
  fakes.synth = new FakeSynth();
  const session = await import('../state/session');
  const runnerMod = await import('./runner');
  const checkup = await import('./checkup');
  const flow = await import('./flow');
  const router = await import('../router');
  const summary = await import('../checkup/summary');
  await session.bootSession();
  return { engine, session, runnerMod, checkup, flow, router, summary };
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

/** Sing a whole take through `runner` (fed on the input timeline, the clock run past its end) and return the outcome. */
async function singWhole(r: Rig, runner: ExerciseRunner, rendition: Rendition): Promise<TakeOutcome> {
  runner.sing();
  await until(() => ['count-in', 'singing', 'error'].includes(runner.phase.value));
  expect(runner.error.value).toBeNull();
  const p = runner.prepared.value!;
  const origin = runner.origin.value!;
  for (const f of rendition(p.realized, p.def)) r.engine.emit({ ...f, t: f.t + origin });
  r.engine.context!.currentTime = origin + p.realized.totalSec + 2;
  vi.advanceTimersByTime(40);
  await until(() => runner.phase.value === 'done' || runner.phase.value === 'error');
  expect(runner.error.value).toBeNull();
  return runner.outcome.value!;
}

/** Sing check-up task `taskIndex` with `rendition`; the runner is disposed afterwards, as leaving the screen does. */
async function singTask(r: Rig, taskIndex: number, rendition: Rendition): Promise<TakeOutcome> {
  const runner = r.runnerMod.createRunner({ kind: 'checkup', taskIndex });
  expect(runner.error.value, `task ${taskIndex}`).toBeNull();
  const outcome = await singWhole(r, runner, rendition);
  runner.dispose();
  return outcome;
}

async function storedLog(r: Rig): Promise<AttemptRecord[]> {
  return r.session.appStorage.value!.attempts.listByProfile(r.session.activeProfile.value!.id);
}

const kinds = (actions: Array<{ kind: string; primary: boolean }>) => actions.map((a) => `${a.kind}${a.primary ? '*' : ''}`);

/**
 * The attempt of a check-up task's take as the runner writes it, as far as the check-up reads it: its exercise, every
 * metric its exercise scores at its best, and the length of a whole take (`measured`), or 0 s (silent: nothing measured).
 */
function taskAttempt(taskIndex: number, fields: { id?: string; checkupId?: string; passed?: boolean; measured?: boolean } = {}): AttemptRecord {
  const def = getExercise(CHECKUP_TASKS[taskIndex].exerciseId)!;
  const r = realize(def, null, 'unknown', { bpm: def.tempoBpm });
  const metrics = Object.fromEntries(def.scoring.map((t) => [t.metric, t.best]));
  const measured = fields.measured ?? true;
  return {
    id: fields.id ?? `t${taskIndex}`,
    checkupId: fields.checkupId,
    exerciseId: def.id,
    passed: fields.passed ?? measured,
    metrics,
    durationSec: measured ? r.countInSec + r.totalSec : 0,
    tempoBpm: def.tempoBpm,
  } as unknown as AttemptRecord;
}

// ---------------------------------------------------------------- the session

describe('the check-up session', () => {
  /** Just what recordCheckupTake reads from an outcome: a take that measured its task unless `measured` is false. */
  const outcome = (id: string, checkupId: string | undefined, taskIndex = 0, measured = true): TakeOutcome =>
    ({ attempt: taskAttempt(taskIndex, { id, checkupId, measured }) }) as unknown as TakeOutcome;

  it('starts with a new id and every task unsung; starting again drops the one running', async () => {
    const c = await import('./checkup');
    const first = c.startCheckup();
    expect(c.activeCheckup.value).toBe(first);
    expect(first.attemptIds).toEqual(CHECKUP_TASKS.map(() => null));
    expect(first.finishedAt).toBeNull();
    expect(Date.parse(first.startedAt)).not.toBeNaN();
    expect(first.checkupId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]+$/);
    c.recordCheckupTake(0, outcome('a0', first.checkupId));
    const second = c.startCheckup();
    expect(second.checkupId).not.toBe(first.checkupId);
    expect(c.activeCheckup.value).toEqual({ ...second, attemptIds: CHECKUP_TASKS.map(() => null) });
  });

  it('records each task’s latest take, ignores what is not this check-up’s, and the last task finishes it', async () => {
    const c = await import('./checkup');
    const s = c.startCheckup();
    c.recordCheckupTake(0, outcome('a0', s.checkupId));
    c.recordCheckupTake(2, outcome('a2', s.checkupId));
    c.recordCheckupTake(2, outcome('a2-again', s.checkupId));
    c.recordCheckupTake(1, outcome('other', 'another-checkup'));
    c.recordCheckupTake(1, outcome('untagged', undefined));
    c.recordCheckupTake(7, outcome('x', s.checkupId));
    c.recordCheckupTake(-1, outcome('x', s.checkupId));
    c.recordCheckupTake(1.5, outcome('x', s.checkupId));
    expect(c.activeCheckup.value?.attemptIds).toEqual(['a0', null, 'a2-again', null, null]);
    expect(c.activeCheckup.value).not.toBe(s); // a new value, so screens re-render
    expect(c.finishCheckup()).toBeNull(); // the last task is not sung yet
    expect(c.activeCheckup.value?.finishedAt).toBeNull();

    c.recordCheckupTake(4, outcome('a4', s.checkupId, 4));
    const done = c.activeCheckup.value!;
    expect(done.attemptIds).toEqual(['a0', null, 'a2-again', null, 'a4']);
    expect(done.finishedAt).not.toBeNull();
    expect(c.finishCheckup()).toBe(s.checkupId); // idempotent
    expect(c.activeCheckup.value).toBe(done);
    c.recordCheckupTake(3, outcome('late', s.checkupId, 3)); // finished: not counted
    expect(c.activeCheckup.value?.attemptIds[3]).toBeNull();

    c.abandonCheckup();
    expect(c.activeCheckup.value).toBeNull();
    expect(c.finishCheckup()).toBeNull();
  });

  it('a last take that measured nothing keeps it running, to be sung again; “See your results” (finishCheckup) ends it anyway', async () => {
    const c = await import('./checkup');
    const s = c.startCheckup();
    c.recordCheckupTake(4, outcome('slip', s.checkupId, 4, false)); // a slip of the Stop button, or a silent take
    expect(c.activeCheckup.value).toMatchObject({ attemptIds: [null, null, null, null, 'slip'], finishedAt: null });
    c.recordCheckupTake(4, outcome('again', s.checkupId, 4));
    expect(c.activeCheckup.value).toMatchObject({ attemptIds: [null, null, null, null, 'again'] });
    expect(c.activeCheckup.value?.finishedAt).not.toBeNull();

    const t = c.startCheckup();
    c.recordCheckupTake(4, outcome('slip', t.checkupId, 4, false));
    expect(c.finishCheckup()).toBe(t.checkupId);
    expect(c.activeCheckup.value?.finishedAt).not.toBeNull();
  });

  it('picks an unfinished check-up of the profile up again from its log, while it is recent (resumeCheckup)', async () => {
    const c = await import('./checkup');
    const row = (taskIndex: number, id: string, createdAt: string): AttemptRecord =>
      ({ ...taskAttempt(taskIndex, { id, checkupId: 'kept' }), kind: taskIndex === 0 ? 'practice' : 'audition', levelId: taskIndex === 0 ? 'foundations.01' : null, profileId: P1, createdAt, updatedAt: createdAt, deletedAt: null }) as AttemptRecord;
    const at = Date.parse('2026-10-22T19:00:00.000Z');
    const log = [row(0, 'r0', new Date(at).toISOString()), row(1, 'r1', new Date(at + 60_000).toISOString())];
    expect(c.resumeCheckup(log, P1, at + 3_600_000)).toEqual({ checkupId: 'kept', startedAt: log[0].createdAt, attemptIds: ['r0', 'r1', null, null, null], finishedAt: null });
    expect(c.activeCheckup.value?.checkupId).toBe('kept');
    expect(c.resumeCheckup(log, P1, at + 25 * 3_600_000)).toBeNull(); // more than a day on: started afresh
    expect(c.activeCheckup.value).toBeNull();
    expect(c.resumeCheckup(log, 'someone-else', at)).toBeNull();
  });
});

// ---------------------------------------------------------------- through the runner

describe('a check-up through the runner', () => {
  it('refuses a task with no check-up running (locked), an unknown task (unknown) and a finished check-up, writing nothing', async () => {
    const r = await rig();
    const none = r.runnerMod.createRunner({ kind: 'checkup', taskIndex: 0 });
    expect(none.error.value).toEqual({ code: 'locked', message: 'Start the check-up first.' });
    const s = r.checkup.startCheckup();
    for (const taskIndex of [5, -1, 1.5, 99]) {
      const runner = r.runnerMod.createRunner({ kind: 'checkup', taskIndex });
      expect(runner.error.value?.code, String(taskIndex)).toBe('unknown');
      expect(runner.prepared.value).toBeNull();
    }
    r.checkup.activeCheckup.value = { ...s, finishedAt: new Date().toISOString() };
    expect(r.runnerMod.createRunner({ kind: 'checkup', taskIndex: 1 }).error.value?.code).toBe('locked');
    expect(r.engine.starts).toBe(0);
    expect(await storedLog(r)).toEqual([]);
  });

  it('sings all five tasks, each logged as its task says with the check-up’s id, and never stops at a miss', async () => {
    const r = await rig();
    const { checkupId } = r.checkup.startCheckup();
    const outcomes: TakeOutcome[] = [];

    // 1. The Range finder: a practice rep of its level. A pass saves the range.
    let runner = r.runnerMod.createRunner({ kind: 'checkup', taskIndex: 0 });
    expect(runner.prepared.value).toMatchObject({
      def: { id: 'foundations.range-finder.1' },
      level: { id: 'foundations.01' },
      world: { id: 'foundations' },
      audition: null,
      workout: null,
      checkup: { taskIndex: 0, taskCount: 5, checkupId },
      usingDefaultRange: true,
    });
    outcomes.push(await singWhole(r, runner, rangeSweep(45, 72)));
    runner.dispose();
    expect(outcomes[0].attempt).toMatchObject({ kind: 'practice', levelId: 'foundations.01', exerciseId: 'foundations.range-finder.1', passed: true, checkupId });
    expect(outcomes[0].rangeSaved).toBe(true);
    expect(r.session.activeProfile.value?.range).toMatchObject({ extended: { low: 45, high: 72 } });
    expect(r.flow.afterTakeActions(outcomes[0])).toEqual([
      { kind: 'next-task', label: 'Next task', primary: true, route: routeOf('sing', { target: 'checkup', itemIndex: '1' }) },
      { kind: 'retry', label: 'Sing it again', primary: false, route: routeOf('sing', { target: 'checkup', itemIndex: '0' }) },
    ]);

    // 2. Match and hold: an audition take, sung in the range just saved.
    runner = r.runnerMod.createRunner({ kind: 'checkup', taskIndex: 1 });
    expect(runner.prepared.value).toMatchObject({ def: { id: 'foundations.audition.1' }, level: null, usingDefaultRange: false, checkup: { taskIndex: 1 } });
    outcomes.push(await singWhole(r, runner, good));
    runner.dispose();
    expect(outcomes[1].attempt).toMatchObject({ kind: 'audition', levelId: null, exerciseId: 'foundations.audition.1', passed: true, checkupId });
    expect(outcomes[1].after.levels['foundations.04']).toMatchObject({ status: 'passed', viaAudition: true });
    // A clean check-up take promises the next task, never a tally to light or a retake.
    expect(outcomes[0].tip).toMatchObject({ id: 'general.polish', text: 'Clean take. On to the next task.' });
    expect(outcomes[1].tip).toMatchObject({ id: 'general.polish', text: 'Clean take. On to the next task.' });

    // 3. The siren, sung three half steps off: a miss, but measured. The check-up goes on (it can be sung again).
    outcomes.push(await singTask(r, 2, singer({ offsetSemis: 3 })));
    expect(outcomes[2].attempt).toMatchObject({ kind: 'audition', exerciseId: 'foundations.audition.2', passed: false, checkupId });
    expect(kinds(r.flow.afterTakeActions(outcomes[2]))).toEqual(['next-task*', 'retry']);

    // 4-5. Both later tests pass, but out of order (the siren missed): the engine grants nothing past Sirens & glides.
    outcomes.push(await singTask(r, 3, good));
    outcomes.push(await singTask(r, 4, good));
    expect(outcomes[3].attempt).toMatchObject({ kind: 'audition', exerciseId: 'foundations.audition.3', passed: true, checkupId });
    expect(outcomes[4].attempt).toMatchObject({ kind: 'audition', exerciseId: 'foundations.audition.4', passed: true, checkupId });
    const snap = r.session.snapshot.value;
    expect(snap.levels['foundations.05'].status).toBe('current');
    expect(['foundations.06', 'foundations.08', 'foundations.09'].map((id) => snap.levels[id].status)).toEqual(['locked', 'locked', 'locked']);
    expect(outcomes[3].unlocked).toEqual([]);
    expect(outcomes[4].unlocked).toEqual([]);

    // The last task finished the check-up; its report opens the results.
    expect(r.flow.afterTakeActions(outcomes[4])).toEqual([{ kind: 'checkup-results', label: 'See your results', primary: true, route: routeOf('checkup') }]);
    expect(outcomes[4].tip).toMatchObject({ id: 'general.polish', text: 'Clean take. That was the last task: your results are next.' });
    const session = r.checkup.activeCheckup.value!;
    expect(session.attemptIds).toEqual(outcomes.map((o) => o.attempt.id));
    expect(session.finishedAt).not.toBeNull();
    expect(r.checkup.finishCheckup()).toBe(checkupId);

    // The log alone holds it: every take carries the id, and it reads back as one finished check-up.
    const log = await storedLog(r);
    expect(log.map((a) => [a.exerciseId, a.kind, a.checkupId])).toEqual(CHECKUP_TASKS.map((t, i) => [t.exerciseId, i === 0 ? 'practice' : 'audition', checkupId]));
    const [summary] = r.summary.checkupsOf(log, () => null, 'sharps', r.session.activeProfile.value?.range);
    expect(summary.tasks.map((t) => t.attemptId)).toEqual(session.attemptIds);
    expect(summary.tasks.map((t) => t.passed)).toEqual([true, true, false, true, true]);
    expect(summary.opened).toEqual(['foundations.02', 'foundations.03', 'foundations.04']);
    expect(summary.startLevelId).toBe('foundations.05');
    expect(summary.range).toBe('B2–A4');
    // Sung to its end, three half steps off: heard in full, so rated (never "not measured"), and clearly short.
    expect(summary.skills.find((s) => s.skill === 'slides')?.rating).toBe('focus');
    expect(summary.focus).toContain('slides');

    // Finished: no task of it can be sung again.
    expect(r.runnerMod.createRunner({ kind: 'checkup', taskIndex: 4 }).error.value?.code).toBe('locked');
  });

  it('a Range finder that misses saves no range: “Sing it again” leads, and tests sung on in the default range never grant, not even once the Range finder passes', async () => {
    const r = await rig();
    const { checkupId } = r.checkup.startCheckup();
    const first = await singTask(r, 0, (realized, def) => rangeSweep(realized.tonicMidi - 2, realized.tonicMidi + 3)(realized, def));
    expect(first.attempt).toMatchObject({ kind: 'practice', levelId: 'foundations.01', passed: false, checkupId });
    expect(first.rangeSaved).toBe(false);
    expect(r.session.activeProfile.value?.range).toBeNull();
    expect(r.flow.afterTakeActions(first)).toEqual([
      { kind: 'retry', label: 'Sing it again', primary: true, route: routeOf('sing', { target: 'checkup', itemIndex: '0' }) },
      { kind: 'next-task', label: 'Next task', primary: false, route: routeOf('sing', { target: 'checkup', itemIndex: '1' }) },
    ]);

    // The singer goes on anyway: every test passes, sung in the default range.
    const runner = r.runnerMod.createRunner({ kind: 'checkup', taskIndex: 1 });
    expect(runner.prepared.value).toMatchObject({ usingDefaultRange: true, checkup: { taskIndex: 1, checkupId } });
    runner.dispose();
    const tests: TakeOutcome[] = [];
    for (const i of [1, 2, 3, 4]) tests.push(await singTask(r, i, good));
    expect(tests.map((o) => o.attempt.passed)).toEqual([true, true, true, true]);
    expect(tests.every((o) => o.unlocked.length === 0)).toBe(true);
    const after = r.session.snapshot.value;
    expect(after.levels['foundations.01'].status).toBe('current');
    expect(Object.values(after.levels).filter((l) => l.status === 'passed')).toEqual([]);
    expect(r.checkup.activeCheckup.value?.finishedAt).not.toBeNull();

    // Weeks later the Range finder passes on its own level: Pitch match opens, and nothing the check-up sang counts.
    const finder = r.runnerMod.createRunner({ kind: 'level', levelId: 'foundations.01' });
    const passed = await singWhole(r, finder, rangeSweep(45, 72));
    finder.dispose();
    expect(passed.attempt.passed).toBe(true);
    const later = r.session.snapshot.value;
    expect(['foundations.01', 'foundations.02', 'foundations.03', 'foundations.05', 'foundations.09'].map((id) => later.levels[id].status)).toEqual(['passed', 'current', 'locked', 'locked', 'locked']);
    expect(Object.values(later.levels).some((l) => l.viaAudition)).toBe(false);
  });

  it('a relaunch picks an unfinished check-up up again from the log (iOS often closes an app left in the background)', async () => {
    let r = await rig();
    const { checkupId } = r.checkup.startCheckup();
    const first = await singTask(r, 0, rangeSweep(45, 72));
    // Pitch Lab is closed and opened again: a fresh page over the same device storage.
    vi.resetModules();
    r = await rig();
    expect(r.checkup.activeCheckup.value).toMatchObject({ checkupId, attemptIds: [first.attempt.id, null, null, null, null], finishedAt: null });
    expect(r.router.navigate('sing', { target: 'checkup', itemIndex: '1' })).toBe(true);
    const next = await singTask(r, 1, good);
    expect(next.attempt.checkupId).toBe(checkupId);
    expect(r.checkup.activeCheckup.value?.attemptIds.slice(0, 2)).toEqual([first.attempt.id, next.attempt.id]);
  });

  it('a task can be sung again while the check-up runs, and its latest take is the one the check-up keeps', async () => {
    const r = await rig();
    r.checkup.startCheckup();
    const once = await singTask(r, 1, singer({ offsetSemis: 2 }));
    const twice = await singTask(r, 1, good);
    expect(r.checkup.activeCheckup.value?.attemptIds[1]).toBe(twice.attempt.id);
    expect(once.attempt.id).not.toBe(twice.attempt.id);
  });
});

// ---------------------------------------------------------------- what the report offers

describe('afterTakeActions for a check-up task', () => {
  interface Take {
    passed?: boolean;
    measured?: boolean;
    rangeSaved?: boolean;
    usingDefaultRange?: boolean;
    checkup?: PreparedRun['checkup'];
  }
  const outcome = (taskIndex: number, take: Take = {}): TakeOutcome => {
    const def = getExercise(CHECKUP_TASKS[taskIndex].exerciseId)!;
    const checkup = take.checkup === undefined ? { taskIndex, taskCount: CHECKUP_TASKS.length, checkupId: 'c' } : take.checkup;
    return {
      prepared: { target: { kind: 'checkup', taskIndex }, checkup, workout: null, def, usingDefaultRange: take.usingDefaultRange ?? false },
      attempt: taskAttempt(taskIndex, { passed: take.passed, measured: take.measured }),
      rangeSaved: take.rangeSaved ?? false,
      after: {},
    } as unknown as TakeOutcome;
  };
  const task = (i: number) => routeOf('sing', { target: 'checkup', itemIndex: String(i) });

  it('the next task after every measured take, pass or miss, with “Sing it again” beside it; exactly one primary', async () => {
    const { afterTakeActions } = await import('./flow');
    for (const passed of [true, false]) {
      for (let i = 0; i < CHECKUP_TASKS.length - 1; i++) {
        const actions = afterTakeActions(outcome(i, { passed, rangeSaved: i === 0 && passed }));
        expect(actions).toEqual([
          { kind: 'next-task', label: 'Next task', primary: true, route: task(i + 1) },
          { kind: 'retry', label: 'Sing it again', primary: false, route: task(i) },
        ]);
      }
      // The last task's measured take ended the check-up: its results are next, and there is no task left to sing.
      expect(afterTakeActions(outcome(4, { passed }))).toEqual([{ kind: 'checkup-results', label: 'See your results', primary: true, route: routeOf('checkup') }]);
    }
  });

  it('“Sing it again” leads after a take that measured nothing, the last task’s included', async () => {
    const { afterTakeActions } = await import('./flow');
    for (let i = 0; i < CHECKUP_TASKS.length - 1; i++) expect(kinds(afterTakeActions(outcome(i, { measured: false }))), `task ${i}`).toEqual(['retry*', 'next-task']);
    expect(afterTakeActions(outcome(4, { measured: false }))).toEqual([
      { kind: 'retry', label: 'Sing it again', primary: true, route: task(4) },
      { kind: 'checkup-results', label: 'See your results', primary: false, route: routeOf('checkup') },
    ]);
  });

  it('“Sing it again” leads after a Range finder that saved no range when none was saved before: the later tasks need one', async () => {
    const { afterTakeActions } = await import('./flow');
    expect(kinds(afterTakeActions(outcome(0, { passed: false, usingDefaultRange: true })))).toEqual(['retry*', 'next-task']);
    expect(kinds(afterTakeActions(outcome(0, { passed: true, rangeSaved: false, usingDefaultRange: true })))).toEqual(['retry*', 'next-task']); // the save failed
    // A range saved by an earlier Range finder is used by the later tasks: going on is fine.
    expect(kinds(afterTakeActions(outcome(0, { passed: false, usingDefaultRange: false })))).toEqual(['next-task*', 'retry']);
    expect(kinds(afterTakeActions(outcome(0, { passed: true, rangeSaved: true, usingDefaultRange: true })))).toEqual(['next-task*', 'retry']);
  });

  it('without the prepared check-up (never in practice), the battery’s own length decides', async () => {
    const { afterTakeActions } = await import('./flow');
    expect(kinds(afterTakeActions(outcome(3, { checkup: null })))).toEqual(['next-task*', 'retry']);
    expect(kinds(afterTakeActions(outcome(4, { checkup: null })))).toEqual(['checkup-results*']);
  });
});

// ---------------------------------------------------------------- the guard

describe('the guard with the check-up context', () => {
  function ctx(over: Partial<GuardContext> = {}, attempts: AttemptRecord[] = []): GuardContext {
    return {
      snapshot: computeSnapshot(P1, WORLDS, attempts, BASE_MS, { getExercise: withRoutines(getExercise) }),
      worlds: WORLDS,
      songRequiredWorld: () => undefined,
      songsLoaded: true,
      hasOutcome: false,
      workoutItems: null,
      ...over,
    };
  }
  const task = (i: string): Route => routeOf('sing', { target: 'checkup', itemIndex: i });

  it('the check-up screen is open from the start; a task only while a check-up runs, by its index', () => {
    expect(guardRoute(routeOf('checkup'), ctx())).toEqual({ ok: true });
    for (const over of [{}, { checkupTasks: null }, { checkupTasks: 0 }]) {
      expect(guardRoute(task('0'), ctx(over))).toEqual({ ok: false, redirect: routeOf('checkup'), hint: 'Start the check-up first.' });
    }
    const running = ctx({ checkupTasks: 5 });
    for (const i of ['0', '1', '2', '3', '4']) expect(guardRoute(task(i), running), i).toEqual({ ok: true });
    expect(guardRoute(task('5'), running)).toMatchObject({ ok: false, redirect: routeOf('checkup') });
    for (const bad of ['-1', 'x', '', '12345']) expect(guardRoute(task(bad), running), bad).toMatchObject({ ok: false, redirect: routeOf('map') });
  });

  it('the results of a check-up only when the profile’s log holds it finished', () => {
    const results = routeOf('checkup-results', { checkupId: 'c1' });
    const refused = { ok: false, redirect: routeOf('checkup'), hint: 'That check-up is not on this device.' };
    expect(guardRoute(results, ctx())).toEqual(refused);
    expect(guardRoute(results, ctx({ hasCheckup: () => false }))).toEqual(refused);
    expect(guardRoute(results, ctx({ hasCheckup: (id) => id === 'c1' }))).toEqual({ ok: true });
    expect(guardRoute(routeOf('checkup-results', { checkupId: 'c2' }), ctx({ hasCheckup: (id) => id === 'c1' }))).toEqual(refused);
  });

  it('the session feeds it: tasks while the check-up runs, results once its last task is in the log', async () => {
    const r = await rig();
    const { navigate, route, refusal } = r.router;
    expect(navigate('checkup')).toBe(true);
    expect(navigate('sing', { target: 'checkup', itemIndex: '0' })).toBe(false);
    expect(route.value).toEqual(routeOf('checkup'));
    expect(refusal.value?.hint).toBe('Start the check-up first.');

    const s = r.checkup.startCheckup();
    expect(navigate('sing', { target: 'checkup', itemIndex: '4' })).toBe(true);
    expect(navigate('sing', { target: 'checkup', itemIndex: '5' })).toBe(false);
    expect(navigate('checkup-results', { checkupId: s.checkupId })).toBe(false); // nothing sung yet

    // The last task's take in the log (written as the runner writes it): finished.
    const storage = r.session.appStorage.value!;
    const profileId = r.session.activeProfile.value!.id;
    const last = getExercise(CHECKUP_TASKS[4].exerciseId)!;
    await storage.attempts.add({ profileId, exerciseId: last.id, levelId: null, kind: 'audition', score: 0.5, passed: false, mastery: 0, metrics: {}, durationSec: 20, tonicMidi: 60, tempoBpm: last.tempoBpm, takeId: null, checkupId: s.checkupId });
    await r.session.reloadSession();
    expect(navigate('checkup-results', { checkupId: s.checkupId })).toBe(true);
    expect(navigate('checkup-results', { checkupId: 'someone-elses' })).toBe(false);
    // A finished (or dropped) check-up has no tasks left to sing.
    expect(r.checkup.activeCheckup.value).toBeNull(); // the reload dropped it, as a backup import does
    expect(navigate('sing', { target: 'checkup', itemIndex: '0' })).toBe(false);
    r.checkup.activeCheckup.value = { ...s, finishedAt: new Date().toISOString() };
    expect(navigate('sing', { target: 'checkup', itemIndex: '0' })).toBe(false);
  });

  it('a profile switch, a backup import and Delete all data drop the running check-up', async () => {
    const r = await rig();
    r.checkup.startCheckup();
    await r.session.reloadSession();
    expect(r.checkup.activeCheckup.value).toBeNull();

    const other = await r.session.createProfile({ name: 'B' });
    r.checkup.startCheckup();
    await r.session.switchProfile(other.id);
    expect(r.checkup.activeCheckup.value).toBeNull();

    r.checkup.startCheckup();
    await r.session.appStorage.value!.deleteAllData();
    await r.session.reloadSession({ pendingSettings: 'discard' });
    expect(r.checkup.activeCheckup.value).toBeNull();
  });

  it('a check-up belongs to its profile: another singer cannot open its results', async () => {
    const r = await rig();
    const storage = r.session.appStorage.value!;
    const me = r.session.activeProfile.value!;
    const last = getExercise(CHECKUP_TASKS[4].exerciseId)!;
    await storage.attempts.add({ profileId: me.id, exerciseId: last.id, levelId: null, kind: 'audition', score: 0.5, passed: false, mastery: 0, metrics: {}, durationSec: 20, tonicMidi: 60, tempoBpm: last.tempoBpm, takeId: null, checkupId: 'mine' });
    await r.session.reloadSession();
    expect(r.router.navigate('checkup-results', { checkupId: 'mine' })).toBe(true);
    const other = await r.session.createProfile({ name: 'B' });
    await r.session.switchProfile(other.id);
    expect(r.router.navigate('checkup-results', { checkupId: 'mine' })).toBe(false);
  });
});
