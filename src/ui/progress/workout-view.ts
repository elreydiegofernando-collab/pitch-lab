/**
 * The Daily workout screen's words and numbers (DESIGN.md §13.11): stage headings, the reason line under each
 * item, take counts and durations, where a workout in progress stands, and what its summary says. Pure.
 */
import { getExercise, getWorld } from '../../exercises';
import type { Workout, WorkoutItem } from '../../progress';
import type { WorkoutSession, WorkoutSummary } from '../../runtime/workout';
import { formatMinutes, plural } from './format';
import { skillForKind } from './skills';

/** "Warm-up", "From Foundations", "Review", "Cool-down". */
export function stageHeading(item: WorkoutItem): string {
  switch (item.stage) {
    case 'warm-up':
      return 'Warm-up';
    case 'world-item':
      return `From ${(item.worldId ? getWorld(item.worldId)?.title : undefined) ?? 'your world'}`;
    case 'review':
      return 'Review';
    case 'cool-down':
      return 'Cool-down';
  }
}

/** Why the item is in today's set, in a short coach-like line. */
export function reasonCaption(item: WorkoutItem): string {
  switch (item.reason) {
    case 'warm-up':
      return 'Easy sirens to wake the voice';
    case 'cool-down':
      return 'Slow glides to let the voice settle';
    case 'current-level':
      return 'Your next level';
    case 'consolidate':
      return 'Making a level you passed solid';
    case 'weakest': {
      const kind = getExercise(item.exerciseId)?.kind;
      const skill = kind ? skillForKind(kind) : undefined;
      return skill ? `Your weakest skill: ${skill.label}` : 'Your weakest level';
    }
  }
}

/** "3 takes · about 4 min". */
export function itemMeta(item: WorkoutItem): string {
  return `${plural(item.takes, 'take')} · about ${Math.max(1, Math.round(item.estSeconds / 60))} min`;
}

/** "About 9 of 10 min". */
export function totalText(workout: Workout): string {
  return `About ${Math.max(1, Math.round(workout.totalEstMinutes))} of ${workout.minutes} min`;
}

export interface ItemStatus {
  takesDone: number;
  takesTotal: number;
  complete: boolean;
}

export interface SessionView {
  items: ItemStatus[];
  /** The first item still short of its takes: where Continue goes. Null when every item has all its takes. */
  nextIndex: number | null;
  takes: number;
}

/** Where a workout in progress stands, from the runtime's per-item results. */
export function sessionView(session: WorkoutSession): SessionView {
  const items = session.workout.items.map((item, i): ItemStatus => {
    const takesDone = session.results[i]?.attemptIds.length ?? 0;
    return { takesDone, takesTotal: item.takes, complete: takesDone >= item.takes };
  });
  const next = items.findIndex((s) => !s.complete);
  return { items, nextIndex: next < 0 ? null : next, takes: items.reduce((n, s) => n + s.takesDone, 0) };
}

export interface SummaryFacts {
  title: string;
  tiles: Array<{ label: string; value: string }>;
}

/**
 * The end-of-workout summary. The runtime's WorkoutSummary has the sung minutes and Momentum before and after;
 * without one (it was already taken) only the counts the session itself holds are shown, never made-up figures.
 */
export function summaryFacts(session: WorkoutSession, summary: WorkoutSummary | null): SummaryFacts {
  const view = sessionView(session);
  const itemCount = session.workout.items.length;
  if (!summary) {
    const itemsDone = view.items.filter((s) => s.takesDone > 0).length;
    return {
      title: itemsDone === itemCount ? 'Workout complete' : 'Workout ended early',
      tiles: [
        { label: 'Items', value: `${itemsDone} of ${itemCount}` },
        { label: 'Takes', value: String(view.takes) },
      ],
    };
  }
  return {
    title: summary.itemsDone >= summary.itemCount ? 'Workout complete' : 'Workout ended early',
    tiles: [
      { label: 'Items', value: `${summary.itemsDone} of ${summary.itemCount}` },
      { label: 'Takes', value: String(summary.takes) },
      { label: 'Minutes sung', value: formatMinutes(summary.minutes) },
      { label: 'Momentum', value: `${Math.round(summary.momentumBefore)} → ${Math.round(summary.momentumAfter)}` },
    ],
  };
}
