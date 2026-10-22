/**
 * Placement-audition spans (SPEC §11): which levels each test of a world's audition can grant. The ENGINE (what a
 * passed test grants) and the REGISTRY (which test is next, which one can be opened) both read this, so the two
 * cannot disagree about a test.
 *
 * The tests are sung IN ORDER and each one judges only the skills between the previous test's reach and its own.
 * So test i covers the levels PAST everything the tests before it reach (a running maximum, so a catalog that
 * stops rising cannot widen a span), up to its own `unlockThrough`. A later test can therefore never vouch for
 * skills an earlier test has not seen: opening the last test of a world does not pass the levels the first ones
 * check. The spans are held short of the first Boss Recital, so an audition never covers a boss or anything past
 * one. A test that reaches nothing new (an id outside the world, or one not past the earlier tests) has no span:
 * it grants nothing and is never offered.
 */
import type { AuditionDef, LevelDef } from '../exercises/types';

/** The levels one audition test covers, as INCLUSIVE indexes into the world's levels in order. */
export interface AuditionSpan {
  exerciseId: string;
  first: number;
  last: number;
}

/**
 * The spans of `audition` in sung order; they never overlap and together run from the first level to the deepest
 * level any test reaches. `levels` must be the world's levels sorted by index (the spans index into it).
 */
export function auditionSpans(audition: AuditionDef, levels: readonly LevelDef[]): AuditionSpan[] {
  const boss = levels.findIndex((l) => l.kind === 'boss');
  const ceiling = boss < 0 ? levels.length - 1 : boss - 1; // the deepest level an audition may ever cover
  const spans: AuditionSpan[] = [];
  let covered = -1; // deepest level the tests so far reach
  audition.exerciseIds.forEach((exerciseId, i) => {
    const last = Math.min(levels.findIndex((l) => l.id === audition.unlockThrough[i]), ceiling); // an unknown id is -1
    if (last <= covered) return;
    spans.push({ exerciseId, first: covered + 1, last });
    covered = last;
  });
  return spans;
}
