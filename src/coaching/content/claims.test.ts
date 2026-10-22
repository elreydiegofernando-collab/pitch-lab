/**
 * The "-any" ladders (the mild tip for a measure at any value) open with a little praise ("Most of your note changes are
 * clean"), which is true only because a stronger rule on the same measure speaks first once that measure is poor. That
 * holds when the stronger rule has no qualifier (no direction, cue verdict, figure or tempo ladder) and every level that
 * shows the -any tip shows it too. Where it does not hold, the -any tip can be the main advice of a failed take (review
 * R4: run.score-any on the Turns levels, where run.score, a tempo-ladder rule, never speaks; acc.drift-any when the notes
 * drift both ways and neither direction rule speaks), so its words must make no claim about how well it went.
 */
import { describe, expect, it } from 'vitest';
import { EXERCISES } from '../../exercises/catalog';
import { COACHING_TIPS, type TipRule } from '../../exercises/tips';
import { LADDERS } from './index';

/** Words the -any ladders use to praise ("close to the note", "mostly clean", "nearly every note", "holding well"). */
const PRAISE = /\b(good|close|mostly|nearly|most|fairly|holding|barely|do settle)\b/i;

const isAny = (r: TipRule): boolean => /(-|\.)any$/.test(r.id);
const plain = (r: TipRule): boolean => !r.direction && !r.verdict && !r.againstCue && !r.inflection && !r.tempoLadder && !r.missing;

/** True when a plain, stronger rule on the same measure is offered wherever `any` is. */
function guarded(any: TipRule): boolean {
  const stronger = COACHING_TIPS.filter((r) => r !== any && !isAny(r) && plain(r) && r.when.metric === any.when.metric);
  if (stronger.length === 0) return false;
  return EXERCISES.every((def) => !(def.tipIds ?? []).includes(any.id) || stronger.some((r) => (def.tipIds ?? []).includes(r.id)));
}

describe('the -any ladders', () => {
  const unguarded = COACHING_TIPS.filter((r) => isAny(r) && !guarded(r)).map((r) => r.id);

  it('knows which can be the main advice of a failed take', () => {
    expect(unguarded).toEqual(expect.arrayContaining(['run.score-any', 'acc.drift-any']));
  });

  it.each(unguarded.map((id) => [id]))('%s makes no claim about how well it went', (id) => {
    const ladder = LADDERS[id];
    expect(ladder).toBeDefined();
    for (const text of [ladder.tip, ladder.why]) expect(text, `${id}: "${text}"`).not.toMatch(PRAISE);
  });
});
