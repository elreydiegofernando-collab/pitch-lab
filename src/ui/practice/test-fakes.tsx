/**
 * Test support for the practice screens (Level, Sing, Report, Vibrato meter, Live): fakes for the engine, the session and
 * settings signals, the runner and the pitch view, and builders for a prepared run and a progress snapshot on the real
 * catalog. Imported only by tests; `vi.mock` factories reach it with `await import('../practice/test-fakes')`, so a test
 * file and the mocked modules share these signals.
 */
import { vi } from 'vitest';
import { useEffect } from 'preact/hooks';
import type { JSX } from 'preact';
import { signal } from '@preact/signals';
import type { AudioEngine, EngineInfo, EngineState } from '../../audio/engine-types';
import type { ReferenceSynth } from '../../audio/synth-types';
import type { PitchFrame } from '../../core/types';
import { WORLDS, getExercise, getLevel, getWorld, ladderOf, passRequirements, realize, startTempo } from '../../exercises';
import { computeSnapshot, isFeatureUnlocked, withRoutines } from '../../progress';
import { attempt } from '../../progress/test-fixtures';
import type { FeatureId, ProgressSnapshot } from '../../progress/types';
import type { ExerciseRunner, PreparedRun, RunError, RunPhase, RunTarget, TakeOutcome } from '../../runtime/types';
import { DEFAULT_DEVICE_SETTINGS, DEFAULT_SETTINGS, type Settings } from '../../state/settings-types';
import type { ProfileRecord, VocalRange } from '../../storage/schema';
import type { PitchViewHostProps } from '../pitch-view/PitchViewHost';
import type { PitchView } from '../pitch-view/types';

// ---------------------------------------------------------------- the engine

const INFO: EngineInfo = {
  state: 'idle',
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

export function createFakeEngine() {
  const frameListeners = new Set<(f: PitchFrame) => void>();
  const engine = {
    state: 'idle' as EngineState,
    error: null,
    context: null,
    output: null,
    ensureContext: vi.fn(() => ({}) as AudioContext),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),
    onFrame: vi.fn((listener: (f: PitchFrame) => void) => {
      frameListeners.add(listener);
      return () => {
        frameListeners.delete(listener);
      };
    }),
    onState: vi.fn(() => () => {}),
    onStats: vi.fn(() => () => {}),
    onTransient: vi.fn(() => () => {}),
    info: vi.fn((): EngineInfo => INFO),
    listInputs: vi.fn(async () => []),
    setPreferredInput: vi.fn(),
    setDetector: vi.fn(),
    setGating: vi.fn(),
    setTransientDetection: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(async () => ({ samples: new Float32Array(), sampleRate: 48000, startTime: 0 })),
  };
  return {
    engine: engine as unknown as AudioEngine,
    mocks: engine,
    /** Deliver frames to every subscriber, as the worklet would. */
    emit(frames: readonly PitchFrame[]): void {
      for (const f of frames) for (const l of [...frameListeners]) l(f);
    },
    get listeners(): number {
      return frameListeners.size;
    },
  };
}

export const engineRig = createFakeEngine();
export const engineModule = () => ({ getEngine: () => engineRig.engine });

// ---------------------------------------------------------------- audio helpers (synth, reset)

export const synthMocks = {
  playNote: vi.fn(() => ({ startAt: 0, endAt: 0, stop: vi.fn() })),
};
export const audioModule = () => ({
  getSynth: vi.fn(() => synthMocks as unknown as ReferenceSynth),
  resetAudio: vi.fn(async () => {}),
});

// ---------------------------------------------------------------- the session and settings

export const PROFILE_ID = 'singer-1';
export const TENOR_RANGE: VocalRange = { comfortable: { low: 47, high: 69 }, extended: { low: 45, high: 72 }, measuredAt: '2026-10-21T09:00:00.000Z' };

export function makeProfile(range: VocalRange | null = TENOR_RANGE): ProfileRecord {
  return {
    id: PROFILE_ID,
    profileId: PROFILE_ID,
    createdAt: '2026-10-21T09:00:00.000Z',
    updatedAt: '2026-10-21T09:00:00.000Z',
    deletedAt: null,
    name: 'Daniel',
    voiceType: 'tenor',
    range,
  };
}

/** A snapshot after passing the given levels in order (real catalog, real engine), each at `score` with `mastery`. */
export function snapshotAfter(passed: readonly string[] = [], opts: { score?: number; mastery?: 1 | 2 | 3 } = {}): ProgressSnapshot {
  const attempts = passed.map((levelId) => {
    const level = getLevel(levelId);
    if (!level) throw new Error(`no level ${levelId}`);
    return attempt({
      profileId: PROFILE_ID,
      levelId,
      exerciseId: level.exerciseId,
      kind: level.kind === 'boss' ? 'boss' : 'practice',
      passed: true,
      score: opts.score ?? 0.86,
      mastery: opts.mastery ?? 2,
    });
  });
  return computeSnapshot(PROFILE_ID, WORLDS, attempts, new Date('2026-10-22T12:00:00.000Z'), { getExercise: withRoutines(getExercise) });
}

export const session = {
  snapshot: signal<ProgressSnapshot>(snapshotAfter([])),
  activeProfile: signal<ProfileRecord | null>(makeProfile()),
};

export const sessionModule = () => ({
  snapshot: session.snapshot,
  activeProfile: session.activeProfile,
  isUnlocked: (id: FeatureId): boolean => isFeatureUnlocked(id, session.snapshot.value),
});

/** Every level the singer must have passed, in order, for `levelId` to be the current one. */
export function levelsBefore(levelId: string): string[] {
  const ids: string[] = [];
  for (const world of WORLDS) {
    for (const level of [...world.levels].sort((a, b) => a.index - b.index)) {
      if (level.id === levelId) return ids;
      ids.push(level.id);
    }
  }
  throw new Error(`no level ${levelId}`);
}

export const settingsSignal = signal<Settings>(DEFAULT_SETTINGS);
export const updateSettingsMock = vi.fn((patch: Partial<Settings>) => {
  settingsSignal.value = { ...settingsSignal.value, ...patch };
});
export const settingsModule = () => ({
  settings: settingsSignal,
  deviceSettings: signal(DEFAULT_DEVICE_SETTINGS),
  updateSettings: updateSettingsMock,
  updateDeviceSettings: vi.fn(),
  settingsReady: Promise.resolve(),
});

/** Back to a fresh singer with nothing passed and a saved range; call from beforeEach. */
export function resetSession(passed: readonly string[] = [], range: VocalRange | null = TENOR_RANGE): void {
  session.snapshot.value = snapshotAfter(passed);
  session.activeProfile.value = makeProfile(range);
  settingsSignal.value = DEFAULT_SETTINGS;
  updateSettingsMock.mockClear();
  engineRig.mocks.start.mockClear();
  engineRig.mocks.stop.mockClear();
}

// ---------------------------------------------------------------- the runner

export function makePrepared(levelId: string, opts: { range?: VocalRange | null; bpm?: number } = {}): PreparedRun {
  const level = getLevel(levelId);
  const def = level ? getExercise(level.exerciseId) : undefined;
  if (!level || !def) throw new Error(`no level ${levelId}`);
  const range = opts.range === undefined ? TENOR_RANGE : opts.range;
  const bpm = opts.bpm ?? startTempo(def);
  const rungs = ladderOf(def);
  return {
    target: { kind: 'level', levelId },
    def,
    level,
    world: getWorld(level.worldId) ?? null,
    realized: realize(def, range, 'tenor', { bpm }),
    bpm,
    ladder: def.tempoLadder && def.tempoLadder.length > 0 ? { rungs: def.tempoLadder, index: Math.max(0, rungs.indexOf(bpm)) } : null,
    passLines: passRequirements(def),
    usingDefaultRange: range === null,
    audition: null,
    workout: null,
  };
}

/** A runner with writable signals and spy methods; drive a take by setting `phase`, `origin`, `countIn` and the rest. */
export class FakeRunner implements ExerciseRunner {
  readonly phase = signal<RunPhase>('idle');
  readonly prepared = signal<PreparedRun | null>(null);
  readonly origin = signal<number | null>(null);
  readonly countIn = signal<number | null>(null);
  readonly cue = signal<string | null>(null);
  readonly progress = signal<number | null>(null);
  readonly outcome = signal<TakeOutcome | null>(null);
  readonly error = signal<RunError | null>(null);
  readonly listen = vi.fn();
  readonly sing = vi.fn();
  readonly stop = vi.fn();
  readonly dispose = vi.fn();
  constructor(readonly target: RunTarget) {}
}

export const runnerState: { last: FakeRunner | null; prepare: (target: RunTarget) => PreparedRun | null; fail: boolean } = {
  last: null,
  prepare: (target) => (target.kind === 'level' || target.kind === 'record' ? makePrepared(target.levelId) : null),
  fail: false,
};

export const createRunnerMock = vi.fn((target: RunTarget): ExerciseRunner => {
  if (runnerState.fail) throw new Error('nope');
  const runner = new FakeRunner(target);
  runner.prepared.value = runnerState.prepare(target);
  runnerState.last = runner;
  return runner;
});

export const lastOutcomeSignal = signal<TakeOutcome | null>(null);
export const runnerModule = () => ({ createRunner: createRunnerMock, lastOutcome: lastOutcomeSignal });

export function resetRunner(): void {
  createRunnerMock.mockClear();
  runnerState.last = null;
  runnerState.fail = false;
  runnerState.prepare = (target) => (target.kind === 'level' || target.kind === 'record' ? makePrepared(target.levelId) : null);
  lastOutcomeSignal.value = null;
}

// ---------------------------------------------------------------- the pitch view

export const viewMocks = {
  pushFrame: vi.fn(),
  setRange: vi.fn(),
  setAutoRange: vi.fn(),
  setTargets: vi.fn(),
  setToleranceCents: vi.fn(),
  setVibratoZone: vi.fn(),
  addMarker: vi.fn(),
  clear: vi.fn(),
  setOptions: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  destroy: vi.fn(),
};
export const fakeView = { ...viewMocks, fps: 60 } as unknown as PitchView;

/** What the last mounted PitchViewHost was given; the stub stands in for the canvas, which happy-dom cannot draw. */
export const hostProbe: { props: PitchViewHostProps | null } = { props: null };

export function PitchViewHostStub(props: PitchViewHostProps): JSX.Element {
  hostProbe.props = props;
  useEffect(() => {
    props.onView?.(fakeView);
    return () => props.onView?.(null);
    // Mount once, as the real host does.
  }, []);
  return <div data-testid="pitch-view-host" />;
}

export function resetView(): void {
  for (const mock of Object.values(viewMocks)) mock.mockClear();
  hostProbe.props = null;
}
