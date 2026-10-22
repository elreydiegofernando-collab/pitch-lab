/**
 * The line a clean take's report ends on (the polish tip). pickTip judges only the take, so its line promises a tally
 * to light and a place to move on to. Whether either exists depends on what the take was for, which only the runner
 * knows: a lower rung of a tempo ladder lights no tally and leads to the next rung, a passed audition test closes (it
 * opens levels and has no tallies), a warm-up or cool-down is completion, and a take that lit all three tallies has
 * none left to light. The line reaches the singer as written (the take report's coaching card), so it is in plain
 * words: "a step faster" and "full speed" (the top rung, where a Runs level counts), never a tempo number. Pure.
 */
import { POLISH_TIP, canPassAtTempo } from '../exercises';
import type { PreparedRun } from './types';

/** The tally lights a take can light: pass, solid, studio. */
const ALL_TALLIES = 3;

/**
 * The polish line for a clean take of `prepared`, given the attempt as written (passed, and the tallies it lit) and the
 * tempo of the next take (a tempo ladder; null without one).
 */
export function polishLine(
  prepared: Pick<PreparedRun, 'target' | 'level' | 'def' | 'bpm' | 'workout'>,
  attempt: { passed: boolean; mastery: number },
  nextBpm: number | null,
): string {
  const { target, level, def, bpm, workout } = prepared;
  if (target.kind === 'audition') return attempt.passed ? 'Test passed: the levels it covers are open.' : 'Clean take.';
  // A warm-up or cool-down of the daily workout: completion, with no tally and no level.
  if (level === null) return `${def.title} done. Easy, unforced sound is all it asks.`;
  if (!canPassAtTempo(def, bpm)) {
    // A lower rung of a tempo ladder: practice on the way to full speed (the level's pass tempo, its top rung).
    if (nextBpm !== null && nextBpm > bpm) {
      return nextBpm >= def.tempoBpm
        ? 'Clean at this speed. The next take is at full speed, where the level counts.'
        : 'Clean at this speed. The next take is a step faster, on the way to full speed, where the level counts.';
    }
    return 'Clean at this speed. The level counts at full speed.';
  }
  if (attempt.mastery >= ALL_TALLIES) return 'Clean take. Every tally is lit: move on when you’re ready.';
  // The last take of a workout item: its report offers no replay, only the next step.
  if (workout && workout.take >= workout.item.takes) return 'Clean take. Move on when you’re ready.';
  return POLISH_TIP.text;
}
