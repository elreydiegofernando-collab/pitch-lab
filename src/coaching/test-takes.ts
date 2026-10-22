/**
 * Test support for the coach: a level sung by the synthetic singer (exercises/test-singer.ts) through the real
 * analyzers, scorer and tip picker, exactly as the runner judges a take, plus a way to force any tip so each family's
 * locator can be checked on a known fault. Imported only by tests.
 */
import type { PitchFrame } from '../core/types';
import { WORLDS, analyzeTake, canPassAtTempo, evaluate, getExercise, getLevel, getWorld, passRequirements, pickTip, realize, reportTiles, startTempo } from '../exercises';
import type { TakeAnalysis } from '../exercises/analyze';
import type { Evaluation } from '../exercises/evaluate';
import { getTip, type PickedTip } from '../exercises/tips';
import type { RealizedExercise } from '../exercises/transpose';
import type { ExerciseDef, LevelDef } from '../exercises/types';
import { GOOD_SINGER, singTake, type SingerModel } from '../exercises/test-singer';
import { computeSnapshot, withRoutines } from '../progress';
import type { ProgressSnapshot } from '../progress/types';
import type { PreparedRun, TakeOutcome } from '../runtime/types';
import type { AttemptRecord, VocalRange } from '../storage/schema';
import { locateProblem } from './coach';
import type { TakeProblem } from './types';

/** The practice screens' test tenor (ui/practice/test-fakes.tsx TENOR_RANGE). */
export const TEST_RANGE: VocalRange = { comfortable: { low: 47, high: 69 }, extended: { low: 45, high: 72 }, measuredAt: '2026-10-21T09:00:00.000Z' };

export interface SungTake {
  level: LevelDef;
  def: ExerciseDef;
  realized: RealizedExercise;
  track: PitchFrame[];
  analysis: TakeAnalysis;
  evaluation: Evaluation;
  tip: PickedTip;
}

export interface SingOptions {
  bpm?: number;
  /** Change the sung track before it is analyzed (a skipped note, a staircase slide). */
  edit?: (track: PitchFrame[], realized: RealizedExercise) => PitchFrame[];
}

/** `levelId` sung by the synthetic singer (GOOD_SINGER with `singer` over it), judged as the runner judges it. */
export function sing(levelId: string, singer: Partial<SingerModel> = {}, opts: SingOptions = {}): SungTake {
  const level = getLevel(levelId);
  const def = level ? getExercise(level.exerciseId) : undefined;
  if (!level || !def) throw new Error(`no level ${levelId}`);
  const realized = realize(def, TEST_RANGE, 'tenor', { bpm: opts.bpm ?? startTempo(def) });
  const sung = singTake(realized, { ...GOOD_SINGER, vibratoEverywhere: def.analyzers.includes('vibrato'), ...singer });
  const track = opts.edit ? opts.edit(sung, realized) : sung;
  const analysis = analyzeTake(def, realized, track, { vibratoStyle: 'pop' });
  return { level, def, realized, track, analysis, evaluation: evaluate(def, analysis.metrics, analysis), tip: pickTip(analysis.metrics, def, analysis.tipContext) };
}

/** A tip as pickTip would hand it over, for any rule id (or a general id with no metric). */
export function tipOf(id: string, take?: SungTake, text = 'The tip text.'): PickedTip {
  const rule = getTip(id);
  const metric = rule?.when.metric ?? null;
  const value = metric && take ? (take.analysis.metrics[metric] ?? null) : null;
  return { id, text, metric, value };
}

/** The take's problem, located for its own tip or for a forced one. */
export function problemOf(take: SungTake, tip: PickedTip | string = take.tip): TakeProblem {
  const picked = typeof tip === 'string' ? tipOf(tip, take) : tip;
  return locateProblem({ def: take.def, realized: take.realized, analysis: take.analysis, tip: picked, notation: 'sharps', track: take.track });
}

export const TEST_PROFILE = 'singer-1';
/** Midday UTC on the owner's test day: the clock every test log counts from. */
export const T0 = Date.parse('2026-10-22T12:00:00.000Z');
let seq = 0;

/** An attempt row of the log: the take's own (as buildAttempt writes it), or a bare one for an exercise. */
export function attemptOf(take: SungTake | null, extra: Partial<AttemptRecord> = {}): AttemptRecord {
  seq += 1;
  const passed = take ? take.evaluation.passed && canPassAtTempo(take.def, take.realized.bpm) : false;
  const createdAt = extra.createdAt ?? new Date(T0 + seq * 60_000).toISOString();
  return {
    id: `attempt-${String(seq).padStart(5, '0')}`,
    profileId: TEST_PROFILE,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    exerciseId: take?.def.id ?? 'foundations.sustain.1',
    levelId: take?.level.id ?? null,
    kind: 'practice',
    score: take?.evaluation.score ?? 0.3,
    passed,
    mastery: passed ? (take?.evaluation.mastery ?? 1) : 0,
    metrics: take?.analysis.metrics ?? {},
    durationSec: take ? take.realized.countInSec + take.realized.totalSec : 20,
    tonicMidi: take?.realized.tonicMidi ?? null,
    tempoBpm: take?.realized.bpm ?? null,
    takeId: null,
    ...extra,
  };
}

/** The progress of a log (real catalog and engine), as the runner hands it to the report. */
export function snapshotOf(log: readonly AttemptRecord[]): ProgressSnapshot {
  return computeSnapshot(TEST_PROFILE, WORLDS, log, new Date(T0 + 86_400_000), { getExercise: withRoutines(getExercise) });
}

/** The runner's outcome for `take`, written as `attempt`, with the progress after it. */
export function outcomeOf(take: SungTake, attempt: AttemptRecord, after: ProgressSnapshot = snapshotOf([attempt])): TakeOutcome {
  const prepared: PreparedRun = {
    target: { kind: 'level', levelId: take.level.id },
    def: take.def,
    level: take.level,
    world: getWorld(take.level.worldId) ?? null,
    realized: take.realized,
    bpm: take.realized.bpm,
    ladder: null,
    passLines: passRequirements(take.def),
    usingDefaultRange: false,
    audition: null,
    workout: null,
  };
  return {
    id: attempt.id,
    prepared,
    take: { track: take.track, audio: null, latencyMs: 0, downbeat: 0, frameRate: 93.75 },
    analysis: take.analysis,
    evaluation: take.evaluation,
    tiles: reportTiles(take.def, take.analysis.metrics),
    tip: take.tip,
    attempt,
    savedTake: null,
    saveError: null,
    nextBpm: null,
    rangeSaved: false,
    before: after,
    after,
    unlocked: [],
  };
}
