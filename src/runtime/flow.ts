/**
 * What a take report offers next, and what a take unlocked.
 *
 * FEATURE_TITLES: short human names for the registry's features, used by unlock strips and locked tiles.
 * afterTakeActions: the report's buttons, exactly one primary, each opened with router.replace (so Back from the
 * next screen skips the report). unlockEvents: what changed between the snapshots around a take, for the one
 * celebratory moment (DESIGN.md §9).
 */
import { isTaskMeasured } from '../checkup/summary';
import { CHECKUP_TASKS } from '../checkup/types';
import { WORLDS, getLevel, nextLevel, worldsUnlockedBy } from '../exercises';
import type { LevelDef, WorldDef } from '../exercises/types';
import { lessonFor } from '../lessons';
import { isGoodTry, type TryRow } from '../lessons/progress';
import { LEVEL_REFS, auditionSpans, isLevelOpenable, isSongUnlocked, nextAuditionExercise } from '../progress';
import type { FeatureId, LevelProgress, ProgressSnapshot } from '../progress/types';
import { routeOf, type Route } from '../router';
import { songIndex } from '../state/songs';
import { paramsForTarget } from './targets';
import type { AfterTakeAction, RunTarget, TakeOutcome, UnlockEvent } from './types';

export const FEATURE_TITLES: Readonly<Record<FeatureId, string>> = {
  'live.basic': 'Live pitch monitor',
  'live.cracks': 'Cracks marked on your Live line',
  'live.onset': 'How each note starts, on Live',
  'live.vibrato': 'Your vibrato, on Live',
  'tool.vibrato-meter': 'Vibrato meter',
  'setting.vibratoStyle': 'Vibrato style setting',
  dashboard: 'Progress dashboard',
  'daily-workout': 'Daily workout',
  'song-stage': 'Song Stage',
  'song.import': 'Import your own songs',
  records: 'Personal records',
  export: 'Backup and export',
};

const byIndex = (a: LevelDef, b: LevelDef): number => a.index - b.index;

/** "Sustain II", or "Foundations Boss Recital" for a boss (every boss level is titled "Boss Recital"). */
function levelTitle(level: LevelDef, world: WorldDef | undefined): string {
  return level.kind === 'boss' && world ? `${world.title} Boss Recital` : level.title;
}

export interface AuditionTest {
  exerciseId: string;
  /** 0-based place in the run (the order the tests are sung in). */
  index: number;
  /** Titles of the first and last level the test unlocks ("unlocks Pitch match – Sustain II"). */
  unlocksFirst: string;
  unlocksLast: string;
}

/**
 * A world's placement-audition tests in sung order, with the levels each one unlocks (progress auditionSpans, so a
 * test that reaches nothing new is left out). The Range finder is always sung, never granted, so a span that starts
 * on it is captioned from the level after it. Empty for a world without an audition.
 */
export function auditionTests(world: WorldDef): AuditionTest[] {
  if (!world.audition) return [];
  const ordered = [...world.levels].sort(byIndex);
  return auditionSpans(world.audition, ordered).map((span, index) => {
    let first = span.first;
    while (first < span.last && ordered[first].id === LEVEL_REFS.rangeFinder) first += 1;
    return { exerciseId: span.exerciseId, index, unlocksFirst: ordered[first].title, unlocksLast: ordered[span.last].title };
  });
}

/**
 * Where "Next level" goes after passing `levelId`: the next level of its world, or after a Boss Recital the first
 * level of the world it opened; null when there is none or it is not openable (nothing is offered that the guard
 * would refuse).
 */
function nextOpenLevel(levelId: string, after: ProgressSnapshot): LevelDef | null {
  const next = nextLevel(levelId);
  if (next) return isLevelOpenable(next.id, after) ? next : null;
  if (getLevel(levelId)?.kind !== 'boss') return null;
  for (const world of worldsUnlockedBy(levelId)) {
    const first = [...world.levels].sort(byIndex)[0];
    if (first && isLevelOpenable(first.id, after)) return first;
  }
  return null;
}

function action(kind: AfterTakeAction['kind'], label: string, primary: boolean, route: Route): AfterTakeAction {
  return { kind, label, primary, route };
}

function singRoute(target: RunTarget): Route {
  return routeOf('sing', paramsForTarget(target));
}

/**
 * True when `attempt` is a good try of the lesson's practice step it sang (src/lessons/progress.ts isGoodTry: sung to its
 * end, and its step's rule holds); false for a lesson or step that does not exist.
 */
export function isGoodDrillTry(levelId: string, step: number, attempt: TryRow): boolean {
  const rule = lessonFor(levelId)?.practice[step]?.good;
  return rule !== undefined && isGoodTry(rule, attempt);
}

/**
 * A practice try's next steps (src/lessons): a good try that leaves its step with every good try it asks for moves on,
 * to the next step, or after the last step to the check (the level's own take); any other try is sung again, with the
 * lesson page beside it.
 */
function drillActions(target: Extract<RunTarget, { kind: 'drill' }>, outcome: TakeOutcome): AfterTakeAction[] {
  const { levelId, step } = target;
  const d = outcome.prepared.drill;
  const good = isGoodDrillTry(levelId, step, outcome.attempt);
  const tryAgain = (label: string, primary: boolean) => action('next-try', label, primary, singRoute(target));
  if (good && d && d.good >= d.needed) {
    // The check opens once every step is done (lessons/progress.ts isCheckOpen); until then, on to the first step not done.
    const ready = d.ready ?? step + 1 >= d.stepCount;
    const open = d.openStep !== undefined && d.openStep < d.stepCount ? d.openStep : step + 1;
    const next = ready
      ? action('take-check', 'Take the check', true, singRoute({ kind: 'level', levelId }))
      : action('next-step', 'Next step', true, singRoute({ kind: 'drill', levelId, step: Math.min(open, d.stepCount - 1) }));
    return [next, tryAgain('One more try', false)];
  }
  return [tryAgain(good ? 'Again' : 'Try again', true), action('lesson', 'Back to the lesson', false, routeOf('level', { levelId }))];
}

/**
 * The report's actions for this outcome, exactly one primary. Level: pass -> "Next level" (primary; "World map"
 * when there is no next level) + "Retry"; miss -> "Retry" (primary) + "Back to level", except that a missed check of a
 * level taught by a lesson (src/lessons) leads back to practice (owner's plan, 2026-10-23: "miss it and you go back to
 * practice, with coaching"): "Back to practice" (primary: the lesson page, which then puts the step that trains what was
 * missed first) + "Take the check again". A tempo-ladder take below the
 * pass tempo is a miss of the LEVEL even when it climbed a rung: then the retry sings the next take at the new rung,
 * and says so ("Sing at 68 bpm").
 * Audition: pass with a next test -> "Next test" (+ "See your placement" to stop there); miss or last test ->
 * "See your placement". Workout: "Next take" / "Next item" / "Finish workout", with the next step as a secondary.
 * Record: "Retry" + "Back to level". Check-up: "Next task" after every task, pass or miss (a check-up never stops at a
 * miss), with "Sing it again" beside it; "Sing it again" leads instead when the take measured nothing (silent, stopped
 * early, gone quiet before its end), or when the Range finder saved no range and none was saved before (every later task
 * would be sung in a default range). After the last task, "See your results", which opens the check-up screen (its
 * results once it is finished); led by "Sing it again" when that take measured nothing (it then did not end the check-up).
 * Lesson practice (drillActions): a good try that finished its step -> "Next step", or "Take the check" after the last
 * step (primary) + "One more try"; a good try short of its step -> "Again" (primary) + "Back to the lesson"; a try that was
 * not good -> "Try again" (primary) + "Back to the lesson". Pass or fail never enters into it: practice has neither.
 */
export function afterTakeActions(outcome: TakeOutcome): AfterTakeAction[] {
  const target = outcome.prepared.target;
  const passed = outcome.attempt.passed;
  switch (target.kind) {
    case 'level': {
      const { nextBpm } = outcome;
      const climbed = nextBpm !== null && nextBpm !== undefined && nextBpm > outcome.prepared.bpm;
      if (!passed) {
        const levelRoute = routeOf('level', { levelId: target.levelId });
        // A missed check sends the singer back to practice first (the lesson page opens on the step that trains what
        // was missed: lessons/progress.ts stepAfterMiss); the check stays one tap away.
        if (lessonFor(target.levelId)) return [action('lesson', 'Back to practice', true, levelRoute), action('retry', 'Take the check again', false, singRoute(target))];
        return [action('retry', climbed ? `Sing at ${nextBpm} bpm` : 'Retry', true, singRoute(target)), action('level', 'Back to level', false, levelRoute)];
      }
      const retry = action('retry', climbed ? `Sing at ${nextBpm} bpm` : 'Retry', false, singRoute(target));
      const next = nextOpenLevel(target.levelId, outcome.after);
      if (next) return [action('next-level', 'Next level', true, routeOf('level', { levelId: next.id })), retry];
      const worldId = getLevel(target.levelId)?.worldId;
      return [action('map', 'World map', true, worldId ? routeOf('map', { worldId }) : routeOf('map')), retry];
    }
    case 'record':
      return [action('retry', 'Retry', true, singRoute(target)), action('level', 'Back to level', false, routeOf('level', { levelId: target.levelId }))];
    case 'audition': {
      const results = (primary: boolean) => action('audition-results', 'See your placement', primary, routeOf('audition', { worldId: target.worldId }));
      if (passed && nextAuditionExercise(target.worldId, outcome.after, WORLDS) !== null) {
        return [action('next-test', 'Next test', true, singRoute(target)), results(false)];
      }
      return [results(true)];
    }
    case 'workout': {
      const finish = (primary: boolean) => action('finish-workout', 'Finish workout', primary, routeOf('workout'));
      const w = outcome.prepared.workout;
      if (!w) return [finish(true)];
      const last = w.itemIndex + 1 >= w.itemCount;
      const nextItem = (primary: boolean) =>
        last ? finish(primary) : action('next-item', 'Next item', primary, singRoute({ kind: 'workout', itemIndex: w.itemIndex + 1 }));
      // A warm-up or cool-down where nothing came through was not done (the runner does not count it): sing it again.
      if (outcome.prepared.level === null && outcome.analysis.tipContext.noVoice) return [action('retry', 'Retry', true, singRoute(target)), nextItem(false)];
      if (w.take < w.item.takes) return [action('next-take', 'Next take', true, singRoute(target)), nextItem(false)];
      return last ? [finish(true)] : [nextItem(true), finish(false)];
    }
    case 'checkup': {
      const { prepared } = outcome;
      const c = prepared.checkup;
      const taskIndex = c?.taskIndex ?? target.taskIndex;
      const taskCount = c?.taskCount ?? CHECKUP_TASKS.length;
      const again = (primary: boolean) => action('retry', 'Sing it again', primary, singRoute({ kind: 'checkup', taskIndex }));
      const measured = isTaskMeasured(taskIndex, outcome.attempt);
      if (taskIndex + 1 >= taskCount) {
        const results = (primary: boolean) => action('checkup-results', 'See your results', primary, routeOf('checkup'));
        return measured ? [results(true)] : [again(true), results(false)];
      }
      const nextTask = (primary: boolean) => action('next-task', 'Next task', primary, singRoute({ kind: 'checkup', taskIndex: taskIndex + 1 }));
      const noRange = prepared.def.kind === 'range-finder' && !outcome.rangeSaved && prepared.usingDefaultRange;
      return !measured || noRange ? [again(true), nextTask(false)] : [nextTask(true), again(false)];
    }
    case 'drill':
      return drillActions(target, outcome);
  }
}

function newlyPassed(before: LevelProgress | undefined, after: LevelProgress): boolean {
  return after.status === 'passed' && before?.status !== 'passed';
}

/**
 * What changed between two snapshots of the same profile, in display order: levels passed (by a sung take), higher
 * mastery on levels already passed, levels that became playable (the next level, or a span granted by an audition
 * test), worlds that opened, features that unlocked, and songs that opened (counted in the song index by the world
 * their difficulty requires). Song Stage has no levels, so its opening is told by its feature and its songs.
 */
export function unlockEvents(before: ProgressSnapshot, after: ProgressSnapshot, worlds: readonly WorldDef[]): UnlockEvent[] {
  const passed: UnlockEvent[] = [];
  const mastery: UnlockEvent[] = [];
  const opened: UnlockEvent[] = [];
  for (const world of worlds) {
    for (const level of [...world.levels].sort(byIndex)) {
      const b = before.levels[level.id];
      const a = after.levels[level.id];
      if (!a) continue;
      const title = levelTitle(level, world);
      if (newlyPassed(b, a)) {
        if (a.viaAudition) opened.push({ kind: 'level-opened', levelId: level.id, title });
        else passed.push({ kind: 'level-passed', levelId: level.id, title, mastery: a.mastery });
      } else if (a.status === 'passed' && a.mastery > (b?.mastery ?? 0)) {
        mastery.push({ kind: 'mastery', levelId: level.id, title, mastery: a.mastery });
      } else if (a.status === 'current' && (b === undefined || b.status === 'locked')) {
        opened.push({ kind: 'level-opened', levelId: level.id, title });
      }
    }
  }

  const worldEvents: UnlockEvent[] = [];
  for (const id of after.worldsUnlocked) {
    if (before.worldsUnlocked.includes(id)) continue;
    const world = worlds.find((w) => w.id === id);
    if (world && world.levels.length > 0) worldEvents.push({ kind: 'world-opened', worldId: world.id, title: world.title });
  }

  const features: UnlockEvent[] = [];
  for (const id of after.features) {
    if (before.features.includes(id) || !Object.prototype.hasOwnProperty.call(FEATURE_TITLES, id)) continue;
    const featureId = id as FeatureId;
    features.push({ kind: 'feature', featureId, title: FEATURE_TITLES[featureId] });
  }

  const songs: UnlockEvent[] = [];
  const index = songIndex.value;
  for (const world of worlds) {
    if (isSongUnlocked(world.id, before, worlds) || !isSongUnlocked(world.id, after, worlds)) continue;
    let count = 0;
    for (const song of index.values()) if (song.difficulty.requiredWorld === world.id) count += 1;
    if (count > 0) songs.push({ kind: 'songs', requiredWorld: world.id, count });
  }

  return [...passed, ...mastery, ...opened, ...worldEvents, ...features, ...songs];
}
