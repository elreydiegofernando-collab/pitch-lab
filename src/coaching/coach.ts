/**
 * The coach: turns one take (and the log before it) into a Coaching (src/coaching/types.ts): the problem located in the
 * take, plain words and plain numbers, "since last time", and help that deepens with each miss in a row.
 *
 *   const coaching = coachTake(outcome, attemptLog.value, { notation, vibratoStyle });   // the report
 *   const coaching = coachFrom(source, log, ctx);   // a saved take re-analyzed (the Level screen's "Last time")
 *
 * Depth follows the misses in a row on the exercise (depthFor): the tip, then why it happens, then a walk-through, then
 * a gentler way in with next moves. A passed take is depth 1 with the polish or next-step tip and no more. Two voice-care
 * rules add a rest: many takes in a short time, or a long run of misses.
 *
 * The coaching leans on the latest voice check-up (owner, 2026-10-22: "if you can hold a note, but you have voice
 * cracking ... you should maybe practice voice cracking"): "Practise <level>" for a level that trains one of its focus
 * skills (checkup/skills.ts SKILL_LEVELS) is offered from the second miss in a row, not only the fourth, with the same
 * gates (already passed, earlier in the catalog, never the Range finder).
 *
 * Every tip id has a ladder in the content (src/coaching/content: the rule table's and the general tips'), so the card
 * always reads plain words. Beyond the contract stub: locateProblem also takes the take's pitch line and vibrato style,
 * progressLines and coachTake the vibrato style (and coachTake the time, for the rest rule), all optional; coachFrom
 * coaches a saved take read back (last-time.ts, and the coaching-file tool, offline.ts).
 */
import type { Metrics } from '../analysis/types';
import { SKILL_LEVELS } from '../checkup/skills';
import { latestCheckupFocus } from '../checkup/summary';
import type { Notation } from '../core/music';
import type { PitchTrack, VibratoStyle } from '../core/types';
import type { TakeAnalysis } from '../exercises/analyze';
import { WORLDS, getExercise, getLevel, levelForExercise } from '../exercises/catalog';
import { evaluate } from '../exercises/evaluate';
import { canPassAtTempo } from '../exercises/ladder';
import { POLISH_TIP, STOPPED_TIP, type PickedTip } from '../exercises/tips';
import type { RealizedExercise } from '../exercises/transpose';
import type { ExerciseDef, LevelDef } from '../exercises/types';
import { withRoutines } from '../progress/routines';
import type { TakeOutcome } from '../runtime/types';
import type { AttemptRecord } from '../storage/schema';
import { ladderFor } from './content/index';
import { locate } from './locate';
import { progressLinesFor } from './progress';
import type { CoachDepth, CoachLadder, CoachMove, Coaching, ProgressLine, TakeProblem } from './types';

/** Voice care: this many takes (of anything) within REST_WINDOW_MS ask for a rest ... */
export const REST_TAKES = 8;
export const REST_WINDOW_MS = 20 * 60_000;
/** ... and so do this many misses in a row on one exercise. */
export const REST_MISSES = 6;

/**
 * Misses in a row -> depth, one step deeper with each miss (owner, 2026-10-22: "each time I mess up ... it should have more
 * and more advice"): 0-1 -> 1 (the tip), 2 -> 2 (+ why), 3 -> 3 (+ steps), 4 or more -> 4 (+ an easier way in).
 */
export function depthFor(missesInARow: number): CoachDepth {
  if (missesInARow >= 4) return 4;
  if (missesInARow === 3) return 3;
  if (missesInARow === 2) return 2;
  return 1;
}

const lookup = withRoutines(getExercise);

/**
 * Did this take get it, as far as coaching goes? A pass of the level, or a lower rung of a tempo ladder that passed its
 * own rule (the ladder climbs on it: progress, not a miss, although the log never counts it as passing the level).
 */
function passedForCoaching(a: AttemptRecord, def: ExerciseDef | undefined): boolean {
  if (a.passed) return true;
  if (!def || !def.tempoLadder || def.tempoLadder.length === 0 || canPassAtTempo(def, a.tempoBpm)) return false;
  return evaluate(def, a.metrics).passed;
}

/**
 * Non-passing takes of this exercise in a row, newest first, up to the last pass (the log is oldest first). Any attempt
 * kind that sings the exercise counts; a lower rung of a tempo ladder that passed its rule counts as a pass.
 */
export function missesInARow(exerciseId: string, log: readonly AttemptRecord[]): number {
  const def = lookup(exerciseId);
  let n = 0;
  for (let i = log.length - 1; i >= 0; i--) {
    const a = log[i];
    if (a.exerciseId !== exerciseId || a.deletedAt !== null) continue;
    if (passedForCoaching(a, def)) break;
    n++;
  }
  return n;
}

/**
 * Where in the take the tip's problem shows, and one plain sentence with plain numbers. `track` (the take's pitch line)
 * lets it place what only the line can show (where a slide stalled, which notes went unsung); `vibratoStyle` sets the
 * vibrato zone it compares against (default: the span both styles share).
 */
export function locateProblem(input: {
  def: ExerciseDef;
  realized: Pick<RealizedExercise, 'notes' | 'totalSec' | 'tonicMidi'>;
  analysis: TakeAnalysis;
  tip: PickedTip;
  notation: Notation;
  track?: PitchTrack | null;
  vibratoStyle?: VibratoStyle;
}): TakeProblem {
  return locate({ ...input, metrics: input.analysis.metrics, analysis: input.analysis });
}

/** The same measures on the previous take of this exercise and on this one. */
export function progressLines(
  def: ExerciseDef,
  previous: AttemptRecord | null,
  current: AttemptRecord,
  problem: TakeProblem,
  vibratoStyle?: VibratoStyle,
): ProgressLine[] {
  return progressLinesFor(def, previous, current, problem, vibratoStyle);
}

/** One take to coach: a finished outcome, or a saved take read back. */
export interface CoachSource {
  def: ExerciseDef;
  /** This take's row of the log. */
  attempt: AttemptRecord;
  tip: PickedTip;
  /** The take passed the pass rule at the tempo it was sung (TakeOutcome.evaluation.passed). */
  passed: boolean;
  metrics: Metrics;
  /** The analysis detail; null when only the attempt's metrics are known (a take whose pitch line was not saved). */
  analysis: Pick<TakeAnalysis, 'details' | 'tipContext' | 'reach'> | null;
  realized: Pick<RealizedExercise, 'notes' | 'totalSec' | 'tonicMidi'>;
  track?: PitchTrack | null;
}

export interface CoachContext {
  notation?: Notation;
  vibratoStyle?: VibratoStyle;
  /** Whether the singer has passed a level: "Practise <level>" is offered only then (replaying never bypasses gating). */
  isLevelPassed: (levelId: string) => boolean;
  /** Now, for the voice-care rest rule (epoch ms). Default: the take's own time. */
  now?: number;
}

/** "Sirens & glides", or the Boss Recital's own title. */
function levelTitle(level: LevelDef): string {
  if (level.kind !== 'boss') return level.title;
  return getExercise(level.exerciseId)?.title ?? level.title;
}

/** Every level's place in the catalog: the worlds in order, each world's levels by index. */
const CATALOG_ORDER: ReadonlyMap<string, number> = new Map(
  WORLDS.flatMap((w) => [...w.levels].sort((a, b) => a.index - b.index)).map((l, i) => [l.id, i] as const),
);

/**
 * The level a ladder's "Practise <level>" may open from a take of `current`: one strictly earlier in the catalog (a tip
 * shared by several levels names one level for all of them, which on some is the level itself or a later one), already
 * passed (replaying earned material never bypasses gating), and never the Range finder (a passed take of it saves the
 * range again, which moves every exercise). Undefined when none qualifies.
 */
function practiseLevel(ladder: CoachLadder | undefined, current: string | null, ctx: CoachContext): LevelDef | undefined {
  const id = ladder?.practiseLevelId;
  const level = id !== undefined ? getLevel(id) : undefined;
  if (!level || level.id === current || !ctx.isLevelPassed(level.id)) return undefined;
  if (lookup(level.exerciseId)?.kind === 'range-finder') return undefined;
  const at = current !== null ? CATALOG_ORDER.get(current) : undefined;
  const from = CATALOG_ORDER.get(level.id);
  if (at !== undefined && (from === undefined || from >= at)) return undefined;
  return level;
}

/** From this depth (misses in a row) a level that trains a check-up focus skill is offered; any other level from depth 4. */
export const FOCUS_PRACTISE_DEPTH: CoachDepth = 2;

/** The levels behind the latest finished voice check-up's focus skills in `log` (empty without one). The song coach leans the same way. */
export function checkupFocusLevels(log: readonly AttemptRecord[]): ReadonlySet<string> {
  return new Set(latestCheckupFocus(log).flatMap((skill) => SKILL_LEVELS[skill]));
}

/** Takes of anything in the REST_WINDOW_MS up to `now`. */
function recentTakes(log: readonly AttemptRecord[], now: number): number {
  let n = 0;
  for (const a of log) {
    if (a.deletedAt !== null) continue;
    const at = Date.parse(a.createdAt);
    if (Number.isFinite(at) && at <= now + 1000 && now - at < REST_WINDOW_MS) n++;
  }
  return n;
}

/**
 * The card's tip: the ladder's plain words, except a clean take's line, which the runner words for that take
 * (runtime/polish.ts: the next rung, a closed test, every tally lit) and which stands as it is.
 */
function cardTip(tip: PickedTip, ladder: CoachLadder | undefined): string {
  if (tip.id === POLISH_TIP.id) return tip.text;
  return ladder?.tip ?? tip.text;
}

/**
 * A miss is never coached as clean. Read back without what the runner knew (the take was stopped early: the log says
 * so, the pitch line does not), a missed take can measure clean; it was practice, and gets the stopped tip.
 */
function missTip(tip: PickedTip, passed: boolean): PickedTip {
  return !passed && tip.id === POLISH_TIP.id ? { id: STOPPED_TIP.id, text: STOPPED_TIP.text, metric: null, value: null } : tip;
}

/** The coaching for one take of `src.def`; `log` is the profile's attempt log with this take in it (it is added when missing). */
export function coachFrom(src: CoachSource, log: readonly AttemptRecord[], ctx: CoachContext): Coaching {
  const { def, attempt } = src;
  const at = log.findIndex((a) => a.id === attempt.id);
  const upTo = at >= 0 ? log.slice(0, at + 1) : [...log, attempt];
  const before = upTo.slice(0, -1);
  const passed = src.passed;
  const misses = passed ? 0 : 1 + missesInARow(def.id, before);
  const depth: CoachDepth = passed ? 1 : depthFor(misses);
  const notation = ctx.notation ?? 'sharps';
  const tip = missTip(src.tip, passed);

  const problem = locate({
    def,
    realized: src.realized,
    metrics: src.metrics,
    analysis: src.analysis,
    tip,
    notation,
    track: src.track,
    vibratoStyle: ctx.vibratoStyle,
  });

  let previous: AttemptRecord | null = null;
  for (let i = before.length - 1; i >= 0; i--) {
    if (before[i].exerciseId === def.id && before[i].deletedAt === null) {
      previous = before[i];
      break;
    }
  }
  const progress = progressLinesFor(def, previous, attempt, problem, ctx.vibratoStyle);

  const ladder = ladderFor(tip.id);
  const moves: CoachMove[] = [];
  if (!passed && depth >= 4) moves.push({ kind: 'listen-slow' });
  const level = passed ? undefined : practiseLevel(ladder, attempt.levelId ?? levelForExercise(def.id)?.id ?? null, ctx);
  // The latest check-up's focus, as the log stood before this take: its levels are offered from the second miss.
  if (level && depth >= (checkupFocusLevels(before).has(level.id) ? FOCUS_PRACTISE_DEPTH : 4)) {
    moves.push({ kind: 'practise-level', levelId: level.id, title: levelTitle(level) });
  }
  if (!passed && depth >= 3) moves.push({ kind: 'send-to-claude' });
  const now = ctx.now ?? Date.parse(attempt.createdAt);
  if (misses >= REST_MISSES || (Number.isFinite(now) && recentTakes(upTo, now) >= REST_TAKES)) moves.push({ kind: 'rest' });

  return {
    depth,
    missesInARow: misses,
    passed,
    problem,
    tip: cardTip(tip, ladder),
    why: !passed && depth >= 2 ? (ladder?.why ?? null) : null,
    steps: !passed && depth >= 3 ? (ladder?.steps ?? []) : [],
    easier: !passed && depth >= 4 ? (ladder?.easier ?? null) : null,
    progress,
    moves,
  };
}

/** The take's own tip and nothing more: what a screen shows if coaching a take ever fails, rather than no report at all. */
export function tipOnly(tip: PickedTip, passed: boolean): Coaching {
  const shown = missTip(tip, passed);
  return {
    depth: 1,
    missesInARow: passed ? 0 : 1,
    passed,
    problem: { tipId: shown.id, metric: shown.metric, what: '', spots: [] },
    tip: cardTip(shown, ladderFor(shown.id)),
    why: null,
    steps: [],
    easier: null,
    progress: [],
    moves: [],
  };
}

/** The coaching for a finished take; `log` is the profile's attempt log AFTER this take was written. */
export function coachTake(outcome: TakeOutcome, log: readonly AttemptRecord[], opts?: { notation?: Notation; vibratoStyle?: VibratoStyle; now?: number }): Coaching {
  const { prepared, analysis, attempt } = outcome;
  return coachFrom(
    {
      def: prepared.def,
      attempt,
      tip: outcome.tip,
      passed: outcome.evaluation.passed,
      metrics: analysis.metrics,
      analysis,
      realized: prepared.realized,
      track: outcome.take.track,
    },
    log,
    {
      notation: opts?.notation,
      vibratoStyle: opts?.vibratoStyle,
      now: opts?.now,
      isLevelPassed: (id) => outcome.after.levels[id]?.status === 'passed',
    },
  );
}
