/**
 * Wave 2 runtime contract (orchestrator-owned: builders report needed changes, never edit this file).
 *
 * The runtime turns the Wave 1 engines into the app's one take pipeline (docs/ARCHITECTURE.md "Wave 1 integration"):
 *
 *   session  storage, active profile, profile-keyed settings, attempt log, snapshot   src/state/session.ts
 *   runner   Listen demo, count-in, record, analyze, judge, write, recompute           src/runtime/runner.ts
 *   flow     what a report offers next, what a take unlocked                          src/runtime/flow.ts
 *   workout  the daily-workout session the runner works through                       src/runtime/workout.ts
 *   guard    the router's gate (SPEC §11.1, fail closed)                              src/runtime/guard.ts
 *   songs    bundled + imported song index (the guard reads requiredWorld)             src/state/songs.ts
 *
 * Song mode has its own take pipeline (src/runtime/song-session.ts, owned by the song builder).
 */
import type { ReadonlySignal } from '@preact/signals';
import type { ExerciseDef, LevelDef, WorldDef, WorldId } from '../exercises/types';
import type { RealizedExercise } from '../exercises/transpose';
import type { TakeAnalysis } from '../exercises/analyze';
import type { Evaluation, ReportTile, Requirement as PassLine } from '../exercises/evaluate';
import type { PickedTip } from '../exercises/tips';
import type { FeatureId, Mastery, ProgressSnapshot } from '../progress/types';
import type { WorkoutItem } from '../progress/workout';
import type { AttemptRecord, TakeRecord } from '../storage/schema';
import type { TakeResult } from '../audio/take-recorder';
import type { Route } from '../router';

export type { PassLine };

// ---------------------------------------------------------------- what a take is for

/** What a sung take counts for. Decides the attempt's source (progress/attempt.ts) and what the report offers next. */
export type RunTarget =
  /** An openable level (isLevelOpenable): a practice rep, or the world's Boss Recital. Passing it advances progress. */
  | { kind: 'level'; levelId: string }
  /** A personal-record attempt on a PASSED level (isRecordAttemptAllowed). Logged as kind 'record'. */
  | { kind: 'record'; levelId: string }
  /** The world's NEXT placement-audition test (nextAuditionExercise), sung in order, stopping at the first miss. */
  | { kind: 'audition'; worldId: WorldId }
  /** One item of the active daily workout (runtime/workout.ts activeWorkout). */
  | { kind: 'workout'; itemIndex: number }
  /**
   * One task of the active voice check-up (runtime/checkup.ts activeCheckup; src/checkup/types.ts CHECKUP_TASKS): the
   * Range finder is logged as a practice take of its level, the placement tests as audition takes (the engine grants
   * their levels in order, as for the audition), every one tagged with the check-up's id.
   */
  | { kind: 'checkup'; taskIndex: number }
  /**
   * One practice try of a lesson (src/lessons): the drill at `step` of the lesson of `levelId`. Logged as kind 'practice'
   * with levelId null, so it never passes a level; open whenever the lesson's level is openable.
   */
  | { kind: 'drill'; levelId: string; step: number };

// ---------------------------------------------------------------- the runner

export type RunPhase =
  /** Prepared: waiting for Listen or Sing. */
  | 'idle'
  /** The Listen demo is playing. */
  | 'listening'
  /** Starting the mic (inside the Sing gesture). */
  | 'starting'
  /** Metronome clicks before the downbeat (the starting pitch sounds here). */
  | 'count-in'
  /** Recording the take. */
  | 'singing'
  /** Analyzing, judging, writing the attempt and recomputing progress (well under a second). */
  | 'analyzing'
  /** The outcome is ready: open the report. */
  | 'done'
  | 'error';

export interface PreparedRun {
  target: RunTarget;
  def: ExerciseDef;
  /** The catalog level the take counts for; null for an audition test or a built-in routine. */
  level: LevelDef | null;
  world: WorldDef | null;
  /** The material placed in the singer's saved range (or the voice type's default range) at `bpm`. */
  realized: RealizedExercise;
  /** The tempo of this take: the current rung of a Runs tempo ladder, else def.tempoBpm. */
  bpm: number;
  /** A tempo ladder's rungs (slowest first) and this take's rung index (0-based); null without a ladder. */
  ladder: { rungs: readonly number[]; index: number } | null;
  /** The pass lines to show before singing ("Pass: 70% in tune, settle < 150 ms"): exercises/evaluate.ts passRequirements. */
  passLines: PassLine[];
  /** True when no range is saved yet and the material uses the voice type's default range. */
  usingDefaultRange: boolean;
  /** Audition only: this test's place in the run (index 0-based), and the level titles it unlocks (auditionSpans). */
  audition: { index: number; count: number; unlocksFirst: string; unlocksLast: string } | null;
  /** Workout only: the item being sung, which take of it this is (1-based), and where it sits in the workout (itemIndex 0-based). */
  workout: { item: WorkoutItem; itemIndex: number; itemCount: number; take: number } | null;
  /** Check-up only: the task being sung (0-based), how many there are, and the check-up's id. */
  checkup?: { taskIndex: number; taskCount: number; checkupId: string } | null;
  /**
   * Lesson practice only: the step (0-based), how many steps, and the good tries needed and so far on this step: before
   * the take on the Sing screen, and in the finished outcome counting this take (the runner reads them again once the
   * take is written). `ready`: every step of the lesson is done (its check opens); `openStep`: the first step not done.
   */
  drill?: { levelId: string; step: number; stepCount: number; good: number; needed: number; ready?: boolean; openStep?: number } | null;
}

export type UnlockEvent =
  /** A level passed for the first time (mastery = the tier reached). */
  | { kind: 'level-passed'; levelId: string; title: string; mastery: Mastery }
  /** A higher mastery tier on a level that was already passed. */
  | { kind: 'mastery'; levelId: string; title: string; mastery: Mastery }
  /** A level that became playable (the next level, or levels granted by an audition test). */
  | { kind: 'level-opened'; levelId: string; title: string }
  | { kind: 'world-opened'; worldId: WorldId; title: string }
  /** A registry feature that unlocked; `title` is a short human name ("Crack markers on the Live trace"). */
  | { kind: 'feature'; featureId: FeatureId; title: string }
  /** Songs that opened because a Boss Recital was passed (SPEC §11.2). */
  | { kind: 'songs'; requiredWorld: WorldId; count: number };

export interface TakeOutcome {
  /** The attempt id: unique per take. */
  id: string;
  prepared: PreparedRun;
  /** Take-relative, latency-compensated track, plus the audio when the profile keeps take audio. */
  take: TakeResult;
  analysis: TakeAnalysis;
  /**
   * evaluate(def, analysis.metrics, analysis): a folded realization is `notJudged: 'folded'` and never passes. It is the
   * pass rule at the tempo SUNG, so a lower rung of a tempo ladder can pass it while the level is not passed: the level
   * verdict (and the tally) is `attempt.passed` / `attempt.mastery`.
   */
  evaluation: Evaluation;
  /** 2-4 report tiles: exercises/evaluate.ts reportTiles. */
  tiles: ReportTile[];
  /**
   * The one coaching tip: pickTip(analysis.metrics, def, analysis.tipContext), or STOPPED_TIP for a take stopped before
   * the end, or the polish line when nothing is left to fix (runtime/polish.ts).
   */
  tip: PickedTip;
  /** The row appended to the log; its `passed` already folds in the tempo-ladder and range-fit rules (buildAttempt). */
  attempt: AttemptRecord;
  /** The saved take (pitch track, plus audio when kept); null when the save failed (`saveError` says why). */
  savedTake: TakeRecord | null;
  /**
   * Why the recording, or (a passed Range finder) the range, was not saved; null when both were. The attempt itself is
   * written either way: the take counts, and `after` and `unlocked` are real.
   */
  saveError: string | null;
  /** Ladder: the bpm of the next take (nextTempo); null without a ladder. */
  nextBpm: number | null;
  /** A PASSED Range finder take saved the profile's range (the only way a range is saved). */
  rangeSaved: boolean;
  before: ProgressSnapshot;
  after: ProgressSnapshot;
  /** What this take opened, in display order; empty for most takes. Drives the one celebratory moment (DESIGN.md §9). */
  unlocked: UnlockEvent[];
}

export interface RunError {
  code:
    | 'locked' //            the target is not openable for this profile (fail closed), or an audition has nothing left to unlock
    | 'unknown' //           no such level, exercise, audition test or workout item
    | 'mic' //               permission denied, no input, or the engine failed to start (EngineError has the detail)
    | 'interrupted' //       a call, Siri or a route change stopped the take; nothing was written
    | 'save-failed' //       the attempt could not be written (the take is lost; say so plainly)
    | 'internal';
  /** Plain language with the fix (DESIGN.md §6), e.g. "Microphone blocked. In Settings › Safari › Microphone choose Allow, then tap Try again." */
  message: string;
}

/**
 * One runner per Sing screen visit (createRunner(target) in src/runtime/runner.ts). It prepares on creation from the
 * session (profile range and voice type, settings, snapshot) and refuses a target the registry does not open.
 */
export interface ExerciseRunner {
  readonly target: RunTarget;
  readonly phase: ReadonlySignal<RunPhase>;
  /** Null until prepared, and when preparing failed (`error` says why). */
  readonly prepared: ReadonlySignal<PreparedRun | null>;
  /**
   * AudioContext time at which take time 0 reaches the input: downbeat + the route's round-trip latency. Feed it to
   * PitchView.setTargets(prepared.realized.notes, origin) so in-time singing sits on the bars. Null outside a take.
   */
  readonly origin: ReadonlySignal<number | null>;
  /** Count-in beats still to come (3, 2, 1) during 'count-in'; null otherwise. */
  readonly countIn: ReadonlySignal<number | null>;
  /** The cue in force now ("straight", "bloom", "vibrato on", a syllable); null when none. */
  readonly cue: ReadonlySignal<string | null>;
  /** 0..1 through the take while singing (for the progress hairline); null otherwise. */
  readonly progress: ReadonlySignal<number | null>;
  readonly outcome: ReadonlySignal<TakeOutcome | null>;
  readonly error: ReadonlySignal<RunError | null>;
  /** Play (or stop) the Listen demo. Call straight from the click handler: the iOS audio rules need the gesture. */
  listen(): void;
  /**
   * Start a take: a playing Listen demo stops, the engine starts inside the gesture, then the count-in, the take (until
   * the material ends plus a short tail), then analyze, judge, write the attempt, save the take and recompute progress.
   * Call straight from the click handler. On 'done', `outcome` is set and lastOutcome (runner.ts) holds it for the report.
   */
  sing(): void;
  /** During the count-in: cancel (nothing written). While singing: end the take now and judge what was sung. */
  stop(): void;
  /** Leaving the screen: stop audio and discard an unfinished take (nothing written). Idempotent. */
  dispose(): void;
}

// ---------------------------------------------------------------- the report's next steps

export interface AfterTakeAction {
  kind:
    | 'retry' //            the same target again (a ladder may have climbed a rung)
    | 'next-level' //       the next level, when this take opened it or it was already open
    | 'next-test' //        the audition's next test (after a passed test)
    | 'audition-results' // the placement result (after a missed test, or the last one)
    | 'next-take' //        the same workout item again (it asks for more takes)
    | 'next-item' //        the next workout item
    | 'finish-workout' //   the workout summary
    | 'next-task' //        the check-up's next task
    | 'checkup-results' //  the check-up's results (after its last task)
    | 'next-try' //         the same practice step again
    | 'next-step' //        the lesson's next practice step (this one is done)
    | 'take-check' //       the lesson's check (every practice step is done)
    | 'lesson' //           back to the lesson page
    | 'level' //            back to the level screen
    | 'map';
  /** Button label: "Retry", "Next level", "Next test", "See your placement", "Next take", "Next item", "Finish workout", "Back to level", "World map". */
  label: string;
  /** Exactly one action is primary (the amber bottom-bar button). */
  primary: boolean;
  /** Open it with router.replace(route.name, route.params) so Back from the next screen skips the report. */
  route: Route;
}

// ---------------------------------------------------------------- the guard

/** What the route guard needs; built by the session from its signals. Every unknown id is locked. */
export interface GuardContext {
  snapshot: ProgressSnapshot;
  worlds: readonly WorldDef[];
  /** The required world of a song in the index (bundled, or imported for the active profile); undefined = unknown. */
  songRequiredWorld(songId: string): WorldId | undefined;
  /** False until the song index has loaded (a song link then waits on the library screen). */
  songsLoaded: boolean;
  /** A take outcome exists for the report. */
  hasOutcome: boolean;
  /** The active workout's item count; null when no workout is running. */
  workoutItems: number | null;
  /** The active check-up's task count; null when none is running. Optional: absent reads as null. */
  checkupTasks?: number | null;
  /** A finished check-up of the active profile with this id exists. Optional: absent reads as none. */
  hasCheckup?: (checkupId: string) => boolean;
  /** A lesson's check is open (lessons/progress.ts isCheckOpen: its practice done, or the lesson passed). Absent: open. */
  checkOpen?: (levelId: string) => boolean;
}
