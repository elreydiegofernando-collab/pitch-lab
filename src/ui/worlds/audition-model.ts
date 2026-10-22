/**
 * The placement audition as its screens show it (docs/DESIGN.md 13.6): the tests in sung order with their status, the
 * label of the Start button, where a run left the singer and what it opened.
 *
 * Everything here is derived from the progress snapshot (src/progress is the one gate: which test is next, which
 * levels a test covers). The one piece of module state is the snapshot from before the run, so the results can say what
 * the run opened: the Sing screen and the report in between do not know about it.
 */
import { getExercise } from '../../exercises';
import type { LevelDef, WorldDef, WorldId } from '../../exercises/types';
import { LEVEL_REFS, auditionSpans, currentLevelOf, levelStatus, nextAuditionExercise, type ProgressSnapshot } from '../../progress';
import { unlockEvents } from '../../runtime/flow';
import { auditionRun } from '../../runtime/audition-run';
import type { TakeOutcome, UnlockEvent } from '../../runtime/types';
import type { AttemptRecord } from '../../storage/schema';
import { plural, rangeLabel, testTitle } from './format';
import { orderedLevels } from './levels';

// ---------------------------------------------------------------- the tests

/** passed: nothing left to open; next: the one to sing now; ahead: not reached yet. */
export type TestState = 'passed' | 'next' | 'ahead';

export interface TestModel {
  /** 1-based place in the run; the tests are sung in this order. */
  n: number;
  exerciseId: string;
  /** "Match and hold": the exercise title without its "Audition:" prefix. */
  title: string;
  state: TestState;
  /** What a pass can still open: the first and last level of its span that are not passed. Null once all are. */
  unlocks: { first: LevelDef; last: LevelDef } | null;
  /** The span as a caption ("Pitch match – Sustain II"); null when nothing is left to open. */
  caption: string | null;
}

/** The world's audition tests in sung order (empty for a world without an audition). */
export function buildTests(world: WorldDef, snapshot: ProgressSnapshot, worlds: readonly WorldDef[]): TestModel[] {
  if (!world.audition) return [];
  const levels = orderedLevels(world);
  const next = nextAuditionExercise(world.id, snapshot, worlds);
  return auditionSpans(world.audition, levels).map((span, i) => {
    // The Range finder is always sung, never granted: it is not something a test "opens".
    const open = levels
      .slice(span.first, span.last + 1)
      .filter((l) => l.id !== LEVEL_REFS.rangeFinder && levelStatus(l.id, snapshot) !== 'passed');
    const unlocks = open.length > 0 ? { first: open[0], last: open[open.length - 1] } : null;
    const state: TestState = unlocks === null ? 'passed' : span.exerciseId === next ? 'next' : 'ahead';
    return {
      n: i + 1,
      exerciseId: span.exerciseId,
      title: testTitle(getExercise(span.exerciseId)?.title ?? span.exerciseId),
      state,
      unlocks,
      caption: unlocks ? rangeLabel(unlocks.first.title, unlocks.last.title) : null,
    };
  });
}

/** How many tests still have something to open. */
export function testsLeft(tests: readonly TestModel[]): number {
  return tests.filter((t) => t.state !== 'passed').length;
}

/**
 * The label of the primary button: "Start test 2", or "Retake test 2" when that test was sung before and missed
 * (a failed test stays open). Null when there is no test to sing.
 */
export function startLabel(tests: readonly TestModel[], attempts: readonly AttemptRecord[]): string | null {
  const next = tests.find((t) => t.state === 'next');
  if (!next) return null;
  const sung = attempts.some((a) => a.deletedAt == null && a.kind === 'audition' && a.exerciseId === next.exerciseId);
  return `${sung ? 'Retake' : 'Start'} test ${next.n}`;
}

/** The first and last level a whole audition can still open, for the map row's caption; null when nothing is left. */
export function reachLabel(tests: readonly TestModel[]): string | null {
  const pending = tests.filter((t) => t.unlocks !== null);
  const first = pending[0]?.unlocks;
  const last = pending[pending.length - 1]?.unlocks;
  return first && last ? rangeLabel(first.first.title, last.last.title) : null;
}

// ---------------------------------------------------------------- the results

export interface Placement {
  level: LevelDef;
  /** 1-based place in the world, and the world's level count. */
  number: number;
  total: number;
}

/** Where the singer stands in the world now (the level in progress); null when the whole world is passed. */
export function placementOf(world: WorldDef, snapshot: ProgressSnapshot, worlds: readonly WorldDef[]): Placement | null {
  const level = currentLevelOf(world.id, snapshot, worlds);
  if (!level) return null;
  const levels = orderedLevels(world);
  return { level, number: levels.indexOf(level) + 1, total: levels.length };
}

export interface OpenedSummary {
  /** The levels the run passed for the singer, in catalog order. */
  levels: LevelDef[];
  /** What opened because of them: worlds, features and songs (runtime/flow.ts unlockEvents). */
  events: UnlockEvent[];
}

/** What changed between the snapshot from before the run and now. */
export function openedBetween(
  before: ProgressSnapshot,
  after: ProgressSnapshot,
  world: WorldDef,
  worlds: readonly WorldDef[],
): OpenedSummary {
  const levels = orderedLevels(world).filter((l) => levelStatus(l.id, after) === 'passed' && levelStatus(l.id, before) !== 'passed');
  const events = unlockEvents(before, after, worlds).filter((e) => e.kind === 'world-opened' || e.kind === 'feature' || e.kind === 'songs');
  return { levels, events };
}

/** One line for an unlock event of the kinds `openedBetween` keeps; null for any other kind. */
export function eventLabel(event: UnlockEvent): string | null {
  switch (event.kind) {
    case 'world-opened':
      return `${event.title} world`;
    case 'feature':
      return event.title;
    case 'songs':
      return `${plural(event.count, 'song')} in Song Stage`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------- the run

// The run itself is per-singer state the session clears on every change of profile or data (src/runtime/audition-run.ts).
export { auditionRun, type AuditionRun } from '../../runtime/audition-run';

/**
 * Start a run. A run that was left unfinished (the singer passed a test and went Back) keeps its baseline, so the
 * results still count what its first tests opened, unless the singer has sung anything else since. A run of another
 * singer (or of no one) never lends this one its baseline: `attempts` is the CURRENT singer's log, so it could not tell.
 */
export function beginAuditionRun(input: {
  worldId: WorldId;
  /** The active profile: the run is theirs. */
  profileId: string;
  before: ProgressSnapshot;
  attempts: readonly AttemptRecord[];
  /** The world's audition exercise ids (a run is made of attempts at these). */
  testIds: readonly string[];
  now?: number;
}): void {
  const run = auditionRun.peek();
  const now = input.now ?? Date.now();
  if (run && run.worldId === input.worldId && run.profileId === input.profileId) {
    const tests = new Set(input.testIds);
    const movedOn = input.attempts.some(
      (a) => a.deletedAt == null && Date.parse(a.createdAt) >= run.since && !(a.kind === 'audition' && tests.has(a.exerciseId)),
    );
    if (!movedOn) return;
  }
  auditionRun.value = { worldId: input.worldId, profileId: input.profileId, before: input.before, since: now };
}

export interface ClaimedResults {
  outcome: TakeOutcome;
  /** The snapshot from before the run; null when the run's start was not recorded. */
  before: ProgressSnapshot | null;
}

let lastClaimed: string | null = null;
/** The route entry the intro was last shown on. */
let introEntry: object | null = null;

/** The intro is showing on this route entry (see claimResults). */
export function rememberIntro(entry: object): void {
  introEntry = entry;
}

/**
 * The results of the audition take that was just sung, for the screen to show instead of the intro. The report offers
 * "See your placement" (after a miss, after the last test, or to stop early), and the router opens it with `replace`,
 * which puts a NEW entry on the stack. Back from the report, by contrast, returns to the intro's own entry, so that
 * entry shows the intro again. Handed out ONCE per take (a later visit from the map shows the intro) and it ends the
 * run. Null when `outcome` is not an audition take of this world, or was already seen.
 */
export function claimResults(input: { worldId: WorldId; outcome: TakeOutcome | null; entry: object; profileId: string | null }): ClaimedResults | null {
  const { worldId, outcome, entry, profileId } = input;
  if (!outcome || outcome.id === lastClaimed) return null;
  const target = outcome.prepared.target;
  if (target.kind !== 'audition' || target.worldId !== worldId) return null;
  lastClaimed = outcome.id;
  if (entry === introEntry) return null;
  const run = auditionRun.peek();
  auditionRun.value = null;
  // Another singer's run (a profile switch since) is no baseline for this one's results.
  return { outcome, before: run && run.worldId === worldId && run.profileId === profileId ? run.before : null };
}

/** Test helper: forget the run, the claimed results and the intro entry. */
export function resetAuditionStateForTests(): void {
  auditionRun.value = null;
  lastClaimed = null;
  introEntry = null;
}
