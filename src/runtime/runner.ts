/**
 * The exercise runner: one sung take from Listen to the written attempt (ExerciseRunner in ./types.ts), on the
 * pipeline of docs/ARCHITECTURE.md "Wave 1 integration" (src/integration/wave1.test.ts drives the same steps):
 *
 *   prepare  the target through the unlock registry (fail closed), realized in the singer's saved range at the
 *            tempo-ladder rung the log has reached
 *   listen   the Listen demo (buildDemo, gain = the reference volume), started inside the tap
 *   sing     engine.start() inside the tap -> the count-in on the AudioContext clock (clicks, the starting pitch)
 *            -> a TakeRecorder from before the downbeat to the end of the material plus a short tail
 *   finish   analyzeTake -> evaluate / reportTiles / pickTip with the whole analysis -> buildAttempt ->
 *            session.recordAttempt (durable first) -> storage.takes.save -> the range (a PASSED Range finder take
 *            only) -> nextTempo (a ladder) -> unlockEvents -> lastOutcome
 *
 * iOS: listen() and sing() do their audio work synchronously, before anything awaits, so call them straight from the
 * click handler. A take stopped in its count-in, interrupted (a call, Siri, a route change) or abandoned by leaving
 * the screen writes nothing; once the attempt is written, the rest of the take is finished even if the screen goes.
 */
import { batch, signal, untracked, type ReadonlySignal } from '@preact/signals';
import { buildDemo } from '../audio/demos';
import { getEngine } from '../audio/engine';
import { musicalClickGain } from '../audio/synth';
import type { AudioEngine, EngineError } from '../audio/engine-types';
import type { MetronomeHandle, ReferenceSynth, ScheduledHandle } from '../audio/synth-types';
import { TAKE_PRE_ROLL_SEC, TakeRecorder, encodeTake, roundTripSeconds, toInputTime, type TakeResult } from '../audio/take-recorder';
import { clamp01 } from '../core/math';
import type { TargetNote, VibratoStyle } from '../core/types';
import {
  WORLDS,
  analyzeTake,
  effectiveRange,
  evaluate,
  getExercise,
  getLevel,
  getWorld,
  ladderOf,
  nextTempo,
  passRequirements,
  pickTip,
  POLISH_TIP,
  rangeFromMeasurement,
  realize,
  reportTiles,
  startTempo,
  STOPPED_TIP,
  type Evaluation,
  type ExerciseDef,
  type LevelDef,
  type PickedTip,
  type RealizedExercise,
  type ReportTile,
  type TakeAnalysis,
  type TakeConditions,
  type WorldDef,
} from '../exercises';
import {
  auditionRequirementHint,
  buildAttempt,
  isExerciseOpenable,
  isFeatureUnlocked,
  isLevelOpenable,
  isRecordAttemptAllowed,
  levelRequirementHint,
  nextAuditionExercise,
  requirementHint,
  withRoutines,
  type AttemptSource,
  type ProgressSnapshot,
} from '../progress';
import { getSynth } from '../state/audio';
import { activeProfile, appStorage, attemptLog, bootPhase, recordAttempt, saveProfileRange, snapshot } from '../state/session';
import { deviceSettings, settings } from '../state/settings';
import { DEFAULT_SETTINGS } from '../state/settings-types';
import { isQuotaError, newId } from '../storage';
import type { AttemptRecord, TakeRecord } from '../storage/schema';
import { auditionTests, unlockEvents } from './flow';
import { RANGE_FINDER_NO_RECORDS, TAKE_AUDIO_NOT_KEPT } from './messages';
import { polishLine } from './polish';
import type { ExerciseRunner, PreparedRun, RunError, RunPhase, RunTarget, TakeOutcome } from './types';
import { activeWorkout, recordWorkoutTake } from './workout';

/** From the tap (or the mic opening) to the first count-in click, so nothing is scheduled in the past. */
const COUNT_IN_LEAD_SEC = 0.15;
/** Recording runs this long past the end of the material: a held last note, a late release. */
const TAKE_TAIL_SEC = 0.4;
/** After the tail, the wait for the last frames to arrive from the worklet (half its window plus the message hop). */
const FRAME_FLUSH_SEC = 0.12;
/** How often the count-in beat, the cue, the progress and the end of the take are read off the AudioContext clock. */
const TICK_MS = 33;
/** The metronome stops this long before the material ends, so its look-ahead (0.12 s) schedules no click past it. */
const METRONOME_STOP_LEAD_SEC = 0.15;
/** A cue shows this long before the step it belongs to, so the singer reads it in time. */
const CUE_LEAD_SEC = 0.25;
/** On a speaker, a reference tone ends this long before the next sung note: the recorder's pre-roll (which covers every analyzer's look-back) plus the synth's release. */
export const SPEAKER_CLEARANCE_SEC = TAKE_PRE_ROLL_SEC + 0.1;
/** On a speaker, a reference tone trimmed shorter than this is dropped: too short to hear as a pitch. */
const MIN_SPEAKER_TONE_SEC = 0.25;

/**
 * A take stopped this close to the end of its material counts as complete. A take stopped earlier is practice: it is
 * written, but never judged (evaluate's `complete: false`), and it never moves a tempo ladder (ladderTempo).
 */
export const COMPLETE_SLACK_SEC = 0.25;

/** The last finished take (the report screen reads it). Survives leaving the Sing screen; replaced by the next take. */
export const lastOutcome = signal<TakeOutcome | null>(null);

// ---------------------------------------------------------------- pure helpers

/**
 * The rung the log has reached on `def`'s tempo ladder, or null when no take of it can say (none yet, or only takes
 * stopped part way). The latest COMPLETE take of the exercise decides: one rung up when it passed the level's own pass
 * rule at its rung (exercises/ladder.ts nextTempo), else the same rung. A take stopped before the end of its material
 * (durationSec short of the realized count-in plus material at its tempo) is skipped: it was not judged, and its
 * metrics, measured on the part that was sung, would otherwise climb the ladder on a fraction of the exercise.
 */
function ladderRung(def: ExerciseDef, log: readonly AttemptRecord[]): number | null {
  const rungs = ladderOf(def);
  const fullSec = new Map<number, number>();
  /** Count-in plus material at `bpm`: the timing does not depend on the singer's range. */
  const takeSec = (bpm: number): number => {
    let sec = fullSec.get(bpm);
    if (sec === undefined) {
      const r = realize(def, null, 'unknown', { bpm });
      sec = r.countInSec + r.totalSec;
      fullSec.set(bpm, sec);
    }
    return sec;
  };
  for (let i = log.length - 1; i >= 0; i--) {
    const a = log[i];
    if (a.exerciseId !== def.id || a.deletedAt != null || a.tempoBpm === null || !Number.isFinite(a.tempoBpm) || a.tempoBpm <= 0) continue;
    if (a.durationSec < takeSec(a.tempoBpm) - COMPLETE_SLACK_SEC) continue; // stopped early: practice, never a step up
    let rung = rungs[0];
    for (const r of rungs) if (r <= a.tempoBpm + 1e-9) rung = r;
    return nextTempo(def, rung, a.metrics);
  }
  return null;
}

/**
 * The tempo of the next take of `def`. For a Runs tempo ladder it is the rung the singer has reached, read from the
 * attempt log so it survives a relaunch (ladderRung); the first rung before any complete take. Without a ladder:
 * def.tempoBpm.
 */
export function ladderTempo(def: ExerciseDef, log: readonly AttemptRecord[]): number {
  if (!def.tempoLadder || def.tempoLadder.length === 0) return def.tempoBpm;
  return ladderRung(def, log) ?? startTempo(def);
}

/**
 * The tempo a LEVEL take of `def` is sung at: ladderTempo, except that a level passed with no take of its own on the
 * ladder (granted by an audition test, which was sung at the pass tempo) starts at its pass tempo, so its first takes
 * can light tallies instead of climbing rungs the audition already proved.
 */
export function levelTempo(def: ExerciseDef, levelId: string, snap: ProgressSnapshot, log: readonly AttemptRecord[]): number {
  if (!def.tempoLadder || def.tempoLadder.length === 0) return def.tempoBpm;
  const rung = ladderRung(def, log);
  if (rung !== null) return rung;
  return snap.levels[levelId]?.status === 'passed' ? def.tempoBpm : startTempo(def);
}

/**
 * The cue in force at take time `t`: the latest cue text, shown CUE_LEAD_SEC early (and through the count-in when
 * the first one opens the take), else the syllable of the step being sung or next; null when there is neither.
 */
export function cueAt(realized: Pick<RealizedExercise, 'cues' | 'steps'>, t: number): string | null {
  const at = Math.max(0, t) + CUE_LEAD_SEC;
  let text: string | null = null;
  for (const c of realized.cues) {
    if (c.t > at) break;
    text = c.text;
  }
  if (text !== null) return text;
  return realized.steps.find((s) => s.role === 'sing' && s.end > t)?.syllable ?? null;
}

/**
 * The reference tones a take plays (realized.reference: the starting pitch in the count-in, Listen steps, a new key's
 * first note). They never overlap a sung note, so while the singer sings only clicks sound. In headphones all of them
 * play as written. On a speaker or an unknown route the mic hears them too, so each one ends SPEAKER_CLEARANCE_SEC
 * before the next sung note (clear of every window the analyzers judge, look-backs included), and one left too short
 * to hear is dropped.
 */
export function takeReferenceTones(realized: Pick<RealizedExercise, 'notes' | 'reference'>, headphones: boolean): TargetNote[] {
  if (headphones) return realized.reference.map((tone) => ({ ...tone }));
  const starts = realized.notes.map((n) => n.start).sort((a, b) => a - b);
  const out: TargetNote[] = [];
  for (const tone of realized.reference) {
    const next = starts.find((s) => s >= tone.start - 1e-9);
    const end = next === undefined ? tone.end : Math.min(tone.end, next - SPEAKER_CLEARANCE_SEC);
    if (end - tone.start >= MIN_SPEAKER_TONE_SEC) out.push({ ...tone, end });
  }
  return out;
}

// ---------------------------------------------------------------- plain-language errors

function micMessage(err: EngineError | null): string {
  switch (err?.code) {
    case 'permission-denied':
      return 'Microphone blocked. On iPhone open Settings › Safari › Microphone and choose Allow; in Chrome or Edge tap the site icon in the address bar and allow the microphone. Then tap Try again.';
    case 'no-microphone':
      return 'No microphone was found. Connect one, or pick another input in Setup & calibration, then tap Try again.';
    case 'mic-in-use':
      return 'Another app is using the microphone. Close it, then tap Try again.';
    case 'insecure-context':
      return 'The microphone only works on a secure (https) page. Open Pitch Lab from its https address, then tap Try again.';
    case 'no-mediadevices':
      return 'This browser cannot use the microphone. Use Safari on iPhone, or Chrome or Edge on a computer.';
    case 'worklet-unsupported':
      return 'This browser cannot run the Pitch Lab audio engine. Update it, or use Safari, Chrome or Edge.';
    case 'route-changed':
      return 'Your headphones or speaker changed. Tap Try again to reconnect, and recalibrate in Setup & calibration if takes feel late.';
    case 'session-interrupted':
    case 'mic-ended':
      return 'The microphone was interrupted (a call, Siri or the lock screen). Tap Try again to reconnect.';
    default:
      return 'The microphone did not start. Tap Try again; if it keeps failing, use Reset audio in Setup & calibration.';
  }
}

function interruptedMessage(err: EngineError | null): string {
  return err?.code === 'route-changed'
    ? 'Your headphones or speaker changed during the take, so it stopped and nothing was saved. Tap Try again, and recalibrate in Setup & calibration if takes feel late.'
    : 'The take was interrupted (a call, Siri, the lock screen or another app), so nothing was saved. Tap Try again.';
}

function saveFailedMessage(err: unknown): string {
  return isQuotaError(err)
    ? 'This device is out of storage space, so the take was not saved and did not count. Delete old recordings in Data & backup, then sing it again.'
    : 'The take could not be saved, so it did not count. Sing it again; if this keeps happening, check Data & backup.';
}

function takeSaveMessage(err: unknown): string {
  return isQuotaError(err)
    ? 'The take counted, but its recording was not kept: this device is out of storage space. Delete old recordings in Data & backup.'
    : 'The take counted, but its recording was not kept, so it cannot be replayed.';
}

// ---------------------------------------------------------------- prepare

interface Resolved {
  def: ExerciseDef;
  level: LevelDef | null;
  world: WorldDef | null;
  source: AttemptSource;
  bpm: number;
  audition: PreparedRun['audition'];
  workout: PreparedRun['workout'];
}

interface Prepared {
  run: PreparedRun;
  source: AttemptSource;
  profileId: string;
}

const UNKNOWN: RunError = { code: 'unknown', message: 'This exercise is not available. Go back and choose it again from the map.' };

function locked(hint: string | null): RunError {
  return { code: 'locked', message: hint ?? 'This is not open yet.' };
}

/** "Sustain II", or "the Foundations Boss Recital" (every boss level is titled "Boss Recital"). */
function describeLevel(level: LevelDef): string {
  const world = getWorld(level.worldId);
  return level.kind === 'boss' && world ? `the ${world.title} Boss Recital` : level.title;
}

/** The exercise a target sings, checked against the unlock registry (fail closed: an unknown id is refused). */
function resolveTarget(target: RunTarget, snap: ProgressSnapshot, log: readonly AttemptRecord[]): Resolved | RunError {
  switch (target.kind) {
    case 'level': {
      const level = getLevel(target.levelId);
      const def = level && getExercise(level.exerciseId);
      if (!level || !def) return UNKNOWN;
      if (!isLevelOpenable(level.id, snap)) return locked(levelRequirementHint(level.id, snap, WORLDS));
      const world = getWorld(level.worldId) ?? null;
      return { def, level, world, source: { type: 'level', level }, bpm: levelTempo(def, level.id, snap, log), audition: null, workout: null };
    }
    case 'record': {
      const level = getLevel(target.levelId);
      const def = level && getExercise(level.exerciseId);
      if (!level || !def) return UNKNOWN;
      if (def.kind === 'range-finder') return locked(RANGE_FINDER_NO_RECORDS);
      if (!isFeatureUnlocked('records', snap) || !isRecordAttemptAllowed(def.id, snap, WORLDS)) {
        return locked(`Pass ${describeLevel(level)} to chase personal records on it.`);
      }
      // Records come only from passed takes, and a tempo ladder passes only at its pass tempo.
      const world = getWorld(level.worldId) ?? null;
      return { def, level, world, source: { type: 'record', level }, bpm: def.tempoBpm, audition: null, workout: null };
    }
    case 'audition': {
      const world = getWorld(target.worldId);
      if (!world?.audition) return UNKNOWN;
      const exerciseId = nextAuditionExercise(world.id, snap, WORLDS);
      if (exerciseId === null || !isExerciseOpenable(exerciseId, snap, WORLDS)) {
        return locked(auditionRequirementHint(world.id, snap, WORLDS) ?? 'This audition has nothing left to unlock.');
      }
      const def = getExercise(exerciseId);
      const tests = auditionTests(world);
      const test = tests.find((t) => t.exerciseId === exerciseId);
      if (!def || !test) return UNKNOWN;
      return {
        def,
        level: null,
        world,
        source: { type: 'audition' },
        bpm: def.tempoBpm, // tests are sung at their pass rules, at their own tempo
        audition: { index: test.index, count: tests.length, unlocksFirst: test.unlocksFirst, unlocksLast: test.unlocksLast },
        workout: null,
      };
    }
    case 'workout': {
      if (!isFeatureUnlocked('daily-workout', snap)) return locked(requirementHint('daily-workout'));
      const session = activeWorkout.value;
      const item = session && session.finishedAt === null ? session.workout.items[target.itemIndex] : undefined;
      if (!session || !item) return { code: 'unknown', message: 'This workout item is not available. Start the workout again from the Daily workout screen.' };
      const def = withRoutines(getExercise)(item.exerciseId);
      if (!def) return UNKNOWN;
      let level: LevelDef | null = null;
      let source: AttemptSource;
      if (item.source === 'level') {
        const found = item.levelId === null ? undefined : getLevel(item.levelId);
        if (!found || found.exerciseId !== def.id) return UNKNOWN;
        if (!isLevelOpenable(found.id, snap)) return locked(levelRequirementHint(found.id, snap, WORLDS));
        level = found;
        source = { type: 'workout-level', level: found };
      } else {
        if (!isExerciseOpenable(def.id, snap, WORLDS)) return locked(requirementHint('daily-workout'));
        source = { type: 'workout-routine' };
      }
      return {
        def,
        level,
        world: item.worldId === null ? null : (getWorld(item.worldId) ?? null),
        source,
        bpm: level ? levelTempo(def, level.id, snap, log) : ladderTempo(def, log),
        audition: null,
        workout: { item, itemIndex: target.itemIndex, itemCount: session.workout.items.length, take: session.results[target.itemIndex].attemptIds.length + 1 },
      };
    }
  }
}

function prepare(target: RunTarget): Prepared | RunError {
  const profile = activeProfile.value;
  if (bootPhase.value !== 'ready' || !profile) return { code: 'internal', message: 'Your progress is still loading. Go back and try again in a moment.' };
  const resolved = resolveTarget(target, snapshot.value, attemptLog.value);
  if ('code' in resolved) return resolved;
  const { def } = resolved;
  const realized = realize(def, profile.range, profile.voiceType, { bpm: resolved.bpm });
  const rungs = ladderOf(def);
  return {
    profileId: profile.id,
    source: resolved.source,
    run: {
      target,
      def,
      level: resolved.level,
      world: resolved.world,
      realized,
      bpm: realized.bpm,
      ladder: def.tempoLadder && def.tempoLadder.length > 0 ? { rungs, index: rungs.indexOf(realized.bpm) } : null,
      passLines: passRequirements(def),
      usingDefaultRange: !effectiveRange(profile.range, profile.voiceType).saved,
      audition: resolved.audition,
      workout: resolved.workout,
    },
  };
}

// ---------------------------------------------------------------- the microphone

/** The runner that opened the mic last: only it releases it, so leaving one Sing screen never cuts another's take. */
let micOwner: object | null = null;

/** Leaving the screen: release the mic (the recording indicator goes off and playback routes normally again). */
function releaseMic(owner: object): void {
  if (micOwner !== owner) return;
  const engine = getEngine();
  if (engine.state === 'starting') {
    // Still opening (a permission prompt is up): release it once it opens, unless another runner claimed it meanwhile.
    const off = engine.onState((state) => {
      if (state === 'starting') return;
      off();
      if (micOwner === owner && state !== 'idle') void engine.stop().catch(() => undefined);
      if (micOwner === owner) micOwner = null;
    });
    return;
  }
  micOwner = null;
  if (engine.state !== 'idle') void engine.stop().catch(() => undefined);
}

// ---------------------------------------------------------------- the runner

interface TakeState {
  token: number;
  ctx: BaseAudioContext;
  downbeat: number;
  spb: number;
  beats: number;
  /** AudioContext time the material ends. */
  materialEnd: number;
  /** AudioContext time by which the last frame of the take (tail included) has arrived. */
  stopAt: number;
  recorder: TakeRecorder;
  metronome: MetronomeHandle | null;
  tones: ScheduledHandle[];
}

class Runner implements ExerciseRunner {
  readonly target: RunTarget;
  private readonly phaseSig = signal<RunPhase>('idle');
  private readonly preparedSig = signal<PreparedRun | null>(null);
  private readonly originSig = signal<number | null>(null);
  private readonly countInSig = signal<number | null>(null);
  private readonly cueSig = signal<string | null>(null);
  private readonly progressSig = signal<number | null>(null);
  private readonly outcomeSig = signal<TakeOutcome | null>(null);
  private readonly errorSig = signal<RunError | null>(null);

  readonly phase: ReadonlySignal<RunPhase> = this.phaseSig;
  readonly prepared: ReadonlySignal<PreparedRun | null> = this.preparedSig;
  readonly origin: ReadonlySignal<number | null> = this.originSig;
  readonly countIn: ReadonlySignal<number | null> = this.countInSig;
  readonly cue: ReadonlySignal<string | null> = this.cueSig;
  readonly progress: ReadonlySignal<number | null> = this.progressSig;
  readonly outcome: ReadonlySignal<TakeOutcome | null> = this.outcomeSig;
  readonly error: ReadonlySignal<RunError | null> = this.errorSig;

  /** What the take is written as, and for whom; null when preparing failed. */
  private readonly attemptFor: { source: AttemptSource; profileId: string } | null = null;
  private synth: ReferenceSynth | null = null;
  private demo: { handle: ScheduledHandle; ctx: BaseAudioContext } | null = null;
  private take: TakeState | null = null;
  /** Bumped by every new take and every cancel: a callback holding an older token has nothing left to do. */
  private token = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private engineOff: (() => void) | null = null;
  private disposed = false;

  constructor(target: RunTarget) {
    this.target = target;
    // A screen creates its runner while rendering: preparing must not subscribe that render to the session.
    const result = untracked(() => prepare(target));
    if ('code' in result) {
      this.errorSig.value = result;
      this.phaseSig.value = 'error';
    } else {
      this.preparedSig.value = result.run;
      this.attemptFor = { source: result.source, profileId: result.profileId };
    }
  }

  listen(): void {
    if (this.disposed) return;
    const phase = this.phaseSig.value;
    if (phase === 'listening') {
      this.stopDemo();
      this.phaseSig.value = 'idle';
      return;
    }
    const p = this.preparedSig.value;
    if (!p || !(phase === 'idle' || phase === 'done' || phase === 'error')) return;
    let synth: ReferenceSynth;
    let engine: AudioEngine;
    try {
      synth = getSynth(); // engine.ensureContext() first, inside the tap
      engine = getEngine();
    } catch {
      this.fail('internal', 'Audio could not start. Tap Listen again; if it keeps failing, use Reset audio in Setup & calibration.');
      return;
    }
    const ctx = engine.context;
    const dest = engine.output;
    if (!ctx || !dest) {
      this.fail('internal', 'Audio could not start. Tap Listen again; if it keeps failing, use Reset audio in Setup & calibration.');
      return;
    }
    this.synth = synth;
    let handle: ScheduledHandle;
    try {
      handle = buildDemo(p.def, p.realized, synth, ctx, dest, { vibratoStyle: this.vibratoStyle(), gain: settings.value.referenceVolume });
    } catch {
      synth.stopAll();
      this.fail('internal', 'The demo could not play. Tap Listen again; if it keeps failing, use Reset audio in Setup & calibration.');
      return;
    }
    this.demo = { handle, ctx };
    batch(() => {
      this.errorSig.value = null;
      this.phaseSig.value = 'listening';
    });
    this.startTicker();
  }

  sing(): void {
    if (this.disposed) return;
    const phase = this.phaseSig.value;
    if (!this.preparedSig.value || !(phase === 'idle' || phase === 'listening' || phase === 'done' || phase === 'error')) return;
    if (phase === 'listening') {
      this.stopDemo();
      this.stopTicker();
    }
    // First, inside the tap: open (or reopen) the mic before anything else runs (docs/ARCHITECTURE.md start-audio
    // recipe; Live.tsx does the same). A start that fails at once is settled below, once its promise resolves.
    const engine = getEngine();
    let opening: Promise<void> | null = null;
    if (engine.state === 'idle' || engine.state === 'error') opening = engine.start();
    else if (engine.state === 'suspended' || engine.state === 'interrupted') opening = engine.resume();
    const token = ++this.token;
    micOwner = this;
    batch(() => {
      this.errorSig.value = null;
      this.outcomeSig.value = null;
      this.phaseSig.value = 'starting';
    });
    this.watchEngine(engine, token);
    if (engine.state === 'running') {
      this.beginCountIn(token);
      return;
    }
    const settle = (): void => {
      if (token !== this.token || this.phaseSig.value !== 'starting') return;
      if (engine.state === 'running') this.beginCountIn(token);
      else if (engine.state !== 'starting') this.fail('mic', micMessage(engine.error));
    };
    opening?.then(settle, settle);
  }

  stop(): void {
    switch (this.phaseSig.value) {
      case 'listening':
        this.stopDemo();
        this.stopTicker();
        this.phaseSig.value = 'idle';
        return;
      case 'starting':
      case 'count-in':
        this.cancelTake();
        this.phaseSig.value = 'idle';
        return;
      case 'singing':
        if (this.take) this.end(this.take.token, true);
        return;
      default:
        return;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopDemo();
    const phase = this.phaseSig.value;
    if (phase === 'starting' || phase === 'count-in' || phase === 'singing') {
      this.cancelTake();
      this.phaseSig.value = 'idle';
    } else {
      // An 'analyzing' take finishes on its own: past its commit point it is already written.
      this.stopTicker();
      this.unwatchEngine();
      if (phase === 'listening') this.phaseSig.value = 'idle';
    }
    releaseMic(this);
  }

  // ---------------------------------------------------------------- internals

  /** The vibrato style the analysis uses: the singer's choice once that setting is earned (SPEC §11.1), else the default. */
  private vibratoStyle(): VibratoStyle {
    return isFeatureUnlocked('setting.vibratoStyle', snapshot.value) ? settings.value.vibratoStyle : DEFAULT_SETTINGS.vibratoStyle;
  }

  private watchEngine(engine: AudioEngine, token: number): void {
    this.unwatchEngine();
    this.engineOff = engine.onState((state, err) => {
      if (token !== this.token) return;
      const phase = this.phaseSig.value;
      if (phase === 'starting') {
        // 'suspended' can be a passing state while the context resumes; the rest end the opening.
        if (state === 'running') this.beginCountIn(token);
        else if (state === 'error' || state === 'idle' || state === 'interrupted') this.fail('mic', micMessage(err));
      } else if ((phase === 'count-in' || phase === 'singing') && state !== 'running') {
        this.fail('interrupted', interruptedMessage(err));
      }
    });
  }

  private unwatchEngine(): void {
    this.engineOff?.();
    this.engineOff = null;
  }

  private startTicker(): void {
    if (this.ticker === null) this.ticker = setInterval(() => this.tick(), TICK_MS);
  }

  private stopTicker(): void {
    if (this.ticker !== null) clearInterval(this.ticker);
    this.ticker = null;
  }

  private stopDemo(): void {
    this.demo?.handle.stop();
    this.demo = null;
  }

  /** Everything this take still has scheduled: the metronome, reference tones, and the count-in clicks (which have no handles). */
  private silence(take: TakeState | null): void {
    take?.metronome?.stop();
    for (const h of take?.tones ?? []) h.stop();
    this.synth?.stopAll();
  }

  /** Abandon the take in flight (nothing is written) and clear its live signals. */
  private cancelTake(): void {
    this.token++;
    this.stopTicker();
    this.unwatchEngine();
    const take = this.take;
    this.take = null;
    take?.recorder.cancel();
    this.silence(take);
    batch(() => {
      this.originSig.value = null;
      this.countInSig.value = null;
      this.cueSig.value = null;
      this.progressSig.value = null;
    });
  }

  private fail(code: RunError['code'], message: string): void {
    this.cancelTake();
    batch(() => {
      this.errorSig.value = { code, message };
      this.phaseSig.value = 'error';
    });
  }

  /**
   * The mic is open: schedule the count-in, the reference tones and the recorder on the AudioContext clock. It can
   * run inside the engine's state listeners, so it never throws: a failure becomes this runner's error.
   */
  private beginCountIn(token: number): void {
    const p = this.preparedSig.value;
    if (!p || token !== this.token) return;
    try {
      this.scheduleTake(token, p);
    } catch {
      this.fail('internal', 'Audio could not start. Tap Try again; if it keeps failing, use Reset audio in Setup & calibration.');
    }
  }

  private scheduleTake(token: number, p: PreparedRun): void {
    const engine = getEngine();
    const synth = getSynth(); // the mic is open, so this leaves the audio session as start() set it
    const ctx = engine.context;
    if (!ctx) {
      this.fail('mic', micMessage(engine.error));
      return;
    }
    this.synth = synth;
    const r = p.realized;
    const spb = 60 / r.bpm;
    const beats = Math.round(r.countInSec / spb);
    const countInStart = ctx.currentTime + COUNT_IN_LEAD_SEC;
    const downbeat = countInStart + r.countInSec;
    const device = deviceSettings.value;
    const latency = device.latency[device.route] ?? null;
    const roundTrip = roundTripSeconds(latency);
    const endSec = r.totalSec + TAKE_TAIL_SEC;
    const s = settings.value;

    const recorder = new TakeRecorder(engine, { downbeat, latency, recordAudio: s.keepTakeAudio, window: { startSec: -TAKE_PRE_ROLL_SEC, endSec } });
    // Held from the moment it records, so a failure while scheduling below cancels it with everything else.
    const take: TakeState = {
      token,
      ctx,
      downbeat,
      spb,
      beats,
      materialEnd: downbeat + r.totalSec,
      stopAt: toInputTime(endSec, downbeat, roundTrip) + FRAME_FLUSH_SEC,
      recorder,
      metronome: null,
      tones: [],
    };
    this.take = take;
    recorder.start();
    // Count-in and metronome clicks follow the reference volume (the calibration's full-level click would sum with the
    // starting pitch past full scale in the singer's headphones).
    const clickGain = musicalClickGain(s.referenceVolume);
    for (let k = 0; k < beats; k++) synth.click(countInStart + k * spb, k === 0, clickGain);
    if (p.def.metronome) take.metronome = synth.startMetronome(r.bpm, { startAt: downbeat, gain: clickGain });
    const headphones = device.route === 'wired' || device.route === 'bluetooth';
    for (const tone of takeReferenceTones(r, headphones)) {
      take.tones.push(
        synth.playNote({ midi: tone.midi, startAt: downbeat + tone.start, duration: tone.end - tone.start, timbre: s.referenceTimbre, gain: s.referenceVolume }),
      );
    }
    batch(() => {
      this.originSig.value = downbeat + roundTrip;
      this.phaseSig.value = beats > 0 ? 'count-in' : 'singing';
      this.countInSig.value = beats > 0 ? beats : null;
      this.progressSig.value = beats > 0 ? null : 0;
      this.cueSig.value = cueAt(r, -r.countInSec);
    });
    this.startTicker();
  }

  private tick(): void {
    const phase = this.phaseSig.value;
    if (phase === 'listening') {
      const demo = this.demo;
      if (!demo || demo.ctx.currentTime >= demo.handle.endAt) {
        this.demo = null;
        this.stopTicker();
        this.phaseSig.value = 'idle';
      }
      return;
    }
    const take = this.take;
    const p = this.preparedSig.value;
    if (!take || !p || (phase !== 'count-in' && phase !== 'singing')) {
      this.stopTicker();
      return;
    }
    const now = take.ctx.currentTime;
    const t = now - take.downbeat;
    batch(() => {
      if (t < 0) {
        this.countInSig.value = Math.min(take.beats, Math.max(1, Math.ceil(-t / take.spb - 1e-9)));
      } else {
        if (this.phaseSig.value === 'count-in') {
          this.phaseSig.value = 'singing';
          this.countInSig.value = null;
        }
        this.progressSig.value = Math.round(clamp01(t / Math.max(p.realized.totalSec, 1e-6)) * 1000) / 1000;
      }
      this.cueSig.value = cueAt(p.realized, t);
    });
    if (take.metronome && now >= take.materialEnd - METRONOME_STOP_LEAD_SEC) {
      take.metronome.stop();
      take.metronome = null;
    }
    if (now >= take.stopAt) this.end(take.token, false);
  }

  /** End the take (its end, or Stop while singing); an unexpected failure must not leave the screen scoring forever. */
  private end(token: number, early: boolean): void {
    this.endTake(token, early).catch(() => {
      if (this.phaseSig.value === 'analyzing') this.fail('internal', 'This take could not be finished. Tap Sing to try again.');
    });
  }

  /** The take is over: collect it, then judge and write it. */
  private async endTake(token: number, early: boolean): Promise<void> {
    const take = this.take;
    const p = this.preparedSig.value;
    if (!take || !p || take.token !== token || token !== this.token) return;
    this.take = null;
    this.stopTicker();
    this.unwatchEngine(); // the take is captured: what the engine does next no longer matters to it
    const sungSec = Math.min(p.realized.totalSec, Math.max(0, take.ctx.currentTime - take.downbeat));
    // Stop tapped before the material ended: the take is practice, never judged (the rest of it was never sung).
    const complete = !early || sungSec >= p.realized.totalSec - COMPLETE_SLACK_SEC;
    if (early) this.silence(take);
    else take.metronome?.stop();
    batch(() => {
      this.phaseSig.value = 'analyzing';
      this.countInSig.value = null;
      this.cueSig.value = null;
      this.progressSig.value = null;
    });
    const result = await take.recorder.stop();
    if (token !== this.token || this.disposed) return;
    await this.finish(token, p, result, complete ? p.realized.totalSec : sungSec, complete);
  }

  private async finish(token: number, p: PreparedRun, take: TakeResult, sungSec: number, complete: boolean): Promise<void> {
    const { def, realized } = p;
    const owner = this.attemptFor;
    if (!owner) return;
    let analysis: TakeAnalysis;
    let conditions: TakeConditions;
    let evaluation: Evaluation;
    let tiles: ReportTile[];
    let tip: PickedTip;
    try {
      analysis = analyzeTake(def, realized, take.track, { vibratoStyle: this.vibratoStyle() });
      // The analyzers measure what WAS sung, so a take stopped part way is judged with `complete: false` (practice,
      // not judged) and one that went quiet part way is refused by its note reach (both inside evaluate). The one
      // evaluation goes into the attempt, the outcome (the report reads it) and the ladder.
      conditions = complete ? analysis : { ...analysis, complete: false };
      evaluation = evaluate(def, analysis.metrics, conditions);
      tiles = reportTiles(def, analysis.metrics);
      tip = !complete && !analysis.tipContext.noVoice ? { id: STOPPED_TIP.id, text: STOPPED_TIP.text, metric: null, value: null } : pickTip(analysis.metrics, def, analysis.tipContext);
    } catch {
      this.fail('internal', 'This take could not be scored, so nothing was saved. Tap Sing to try again.');
      return;
    }
    const takeId = newId();
    // The time actually sung: a take stopped early counts only what it ran, one refused for the notes it left unsung
    // only up to its last sung note, and one where nothing came through counts none (Momentum and the workout's minutes
    // are practice time). ladderTempo reads a short duration as "not a whole take" and never climbs on it, as nextBpm
    // below does not.
    const silent = analysis.tipContext.noVoice === true;
    const sungFor = evaluation.unsung ? Math.min(sungSec, Math.max(0, evaluation.unsung.lastReachedEnd ?? sungSec)) : sungSec;
    const fields = buildAttempt({
      profileId: owner.profileId,
      def,
      source: owner.source,
      // The tempo actually sung, and the time actually sung.
      realized: { tonicMidi: realized.tonicMidi, bpm: realized.bpm, countInSec: silent ? 0 : realized.countInSec, totalSec: silent ? 0 : sungFor, fit: realized.fit },
      evaluation,
      metrics: analysis.metrics,
      takeId,
    });

    // The commit point: a take abandoned before here writes nothing.
    if (token !== this.token || this.disposed) return;
    let recorded: Awaited<ReturnType<typeof recordAttempt>>;
    try {
      recorded = await recordAttempt(fields);
    } catch (err) {
      if (token === this.token) this.fail('save-failed', saveFailedMessage(err));
      return;
    }

    // The attempt is durable: everything below completes even if the screen was left meanwhile.
    const { attempt, before, after } = recorded;
    const problems: string[] = [];
    let savedTake: TakeRecord | null = null;
    const storage = appStorage.value;
    try {
      if (!storage) throw new Error('storage is not open');
      savedTake = await storage.takes.save({ id: takeId, profileId: owner.profileId, exerciseId: def.id, ...encodeTake(take) });
      // The store keeps the take but drops its sound when the audio will not write (no space left to free): say so,
      // or the report would offer playback of a recording Recordings will never show.
      if (take.audio && savedTake.audioRef === null) problems.push(TAKE_AUDIO_NOT_KEPT);
    } catch (err) {
      problems.push(takeSaveMessage(err));
    }
    let rangeSaved = false;
    // Only a level take of the Range finder (the first one, or a re-measure with Sing again) saves the range: never a
    // record attempt, which could only push the extremes toward notes the singer forces.
    if (def.kind === 'range-finder' && attempt.passed && owner.source.type === 'level') {
      const measured = analysis.details.range;
      const range = measured ? rangeFromMeasurement(measured.lowestMidi, measured.highestMidi, attempt.createdAt) : null;
      if (range) {
        try {
          await saveProfileRange(range);
          rangeSaved = true;
        } catch {
          problems.push('Your range was not saved. Sing the Range finder again to save it.');
        }
      }
    }
    const nextBpm = p.ladder ? nextTempo(def, realized.bpm, analysis.metrics, conditions) : null;
    // A clean take's line says what is next for THIS take (a rung, a closed test, a routine, every tally lit).
    if (tip.id === POLISH_TIP.id) tip = { ...tip, text: polishLine(p, attempt, nextBpm) };
    const outcome: TakeOutcome = {
      id: attempt.id,
      prepared: p,
      take,
      analysis,
      evaluation,
      tiles,
      tip,
      attempt,
      savedTake,
      saveError: problems.length > 0 ? problems.join(' ') : null,
      nextBpm,
      rangeSaved,
      before,
      after,
      unlocked: unlockEvents(before, after, WORLDS),
    };
    lastOutcome.value = outcome;
    // A warm-up or cool-down is completion: one where nothing came through is not done (the report says so).
    if (this.target.kind === 'workout' && !(silent && p.level === null)) recordWorkoutTake(this.target.itemIndex, outcome);
    batch(() => {
      this.outcomeSig.value = outcome;
      this.originSig.value = null;
      this.phaseSig.value = 'done';
    });
  }
}

/** Create the runner for one Sing screen visit. Prepares at once (phase 'idle', or 'error' with RunError 'locked'/'unknown'). */
export function createRunner(target: RunTarget): ExerciseRunner {
  return new Runner(target);
}
