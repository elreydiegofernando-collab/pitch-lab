/**
 * Plain-language labels for the practice screens, kept pure so each rule is tested once (docs/DESIGN.md §11: coach-like,
 * specific, brief; numbers over adjectives).
 */
import { CHECKUP_TASKS } from '../../checkup/types';
import { CONFIG } from '../../config';
import { CUE } from '../../exercises/cues';
import { ladderOf } from '../../exercises/ladder';
import type { ExerciseDef, LevelDef, WorldDef } from '../../exercises/types';
import type { PreparedRun, RunTarget } from '../../runtime/types';

/** "04" for the fourth level of its world (by order, never by the stored index). */
export function levelNumber(world: WorldDef | undefined, level: LevelDef): string {
  const ordered = world ? [...world.levels].sort((a, b) => a.index - b.index) : [level];
  const position = ordered.findIndex((l) => l.id === level.id);
  return String((position < 0 ? 0 : position) + 1).padStart(2, '0');
}

/** The tolerance chip: "±25¢". */
export function toleranceLabel(def: Pick<ExerciseDef, 'tolerance'>): string {
  return `±${CONFIG.tolerance[def.tolerance]}¢`;
}

/**
 * The tempo chip. A Runs ladder says where practice is headed ("Tempo climbs 72 → 96 bpm as you pass"); a metronome
 * exercise says its tempo ("72 bpm"). Null when no tempo is audible (a held note has no tempo to speak of).
 */
export function tempoLabel(def: Pick<ExerciseDef, 'tempoBpm' | 'tempoLadder' | 'metronome'>): string | null {
  const rungs = ladderOf(def);
  if (rungs.length > 1) return `Tempo climbs ${rungs[0]} → ${rungs[rungs.length - 1]} bpm as you pass`;
  return def.metronome ? `${def.tempoBpm} bpm` : null;
}

/** The sections of a Boss Recital's one continuous take, in order: the cue that opens each. */
export function bossChain(def: Pick<ExerciseDef, 'pattern'>): string[] {
  const out: string[] = [];
  for (const step of def.pattern) {
    const cue = step.cue;
    if (cue && cue !== CUE.listen && cue !== CUE.sing && !out.includes(cue)) out.push(cue);
  }
  return out;
}

/**
 * What the Sing screen's title bar says: the level, the audition test or the workout item. A Boss Recital is named in
 * full ("Foundations Boss Recital", as on Level, Home and the report): every boss level is titled just "Boss Recital".
 * A task of the voice check-up goes by its plain title ("Slide up and down"), not the audition's exercise title.
 */
export function singTitle(prepared: PreparedRun): string {
  const task = prepared.checkup ? CHECKUP_TASKS[prepared.checkup.taskIndex] : undefined;
  if (task) return task.title;
  return prepared.level?.kind === 'boss' ? prepared.def.title : (prepared.level?.title ?? prepared.def.title);
}

/** "Check-up · 2 of 5": the place of a check-up task, from the runner's 0-based index. */
function checkupChip(taskIndex: number, taskCount: number): string {
  return `Check-up · ${taskIndex + 1} of ${taskCount}`;
}

/**
 * The one context chip over the canvas (top right): a check-up task, a workout item, an audition test, a tempo-ladder
 * rung, or a record attempt, in that order of precedence (a check-up task is an audition test underneath, but the
 * singer is on the check-up). `index`, `itemIndex`, `taskIndex` and the ladder index are 0-based, as in RunTarget.
 */
export function contextChip(prepared: PreparedRun, target: RunTarget): string | null {
  if (prepared.checkup) return checkupChip(prepared.checkup.taskIndex, prepared.checkup.taskCount);
  if (target.kind === 'checkup') return checkupChip(target.taskIndex, CHECKUP_TASKS.length);
  if (prepared.workout) {
    const w = prepared.workout;
    return `Workout · ${w.itemIndex + 1} of ${w.itemCount}${w.take > 1 ? ` · take ${w.take}` : ''}`;
  }
  if (prepared.audition) return `Test ${prepared.audition.index + 1} of ${prepared.audition.count}`;
  if (prepared.ladder) return `${prepared.bpm} bpm · rung ${prepared.ladder.index + 1} of ${prepared.ladder.rungs.length}`;
  if (target.kind === 'record') return 'Record attempt';
  return null;
}

/** "86%" for a 0..1 score. */
export function percent(score: number): string {
  return `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`;
}
