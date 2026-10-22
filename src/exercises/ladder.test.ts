import { describe, expect, it } from 'vitest';
import type { Metrics } from '../analysis/types';
import { getExercise } from './catalog';
import { evaluate } from './evaluate';
import { canPassAtTempo, isPassTempo, ladderOf, nextTempo, startTempo } from './ladder';
import type { ExerciseDef } from './types';

const run8 = getExercise('runs.run.8')!;
const sustain = getExercise('foundations.sustain.1')!;

/** Every scored term at its best (a clean take), every gated metric at least through its gate. */
const clean = (def: ExerciseDef): Metrics => {
  const m: Metrics = {};
  for (const t of def.scoring) m[t.metric] = t.best;
  return m;
};

describe('tempo ladders', () => {
  it('start at the slowest rung and pass only at the top one', () => {
    expect(startTempo(run8)).toBe(run8.tempoLadder![0]);
    expect(isPassTempo(run8, startTempo(run8))).toBe(false);
    expect(isPassTempo(run8, run8.tempoBpm)).toBe(true);
  });

  it('move up one rung after a take that passes the level\'s own rule at that rung, never past the top', () => {
    const [a, b, c] = ladderOf(run8);
    expect(evaluate(run8, clean(run8)).passed).toBe(true);
    expect(nextTempo(run8, a, clean(run8))).toBe(b);
    expect(nextTempo(run8, b, clean(run8))).toBe(c);
    expect(nextTempo(run8, c, clean(run8))).toBe(c);
    expect(nextTempo(run8, a, {})).toBe(a);
  });

  it('do not need an 85% run score: a studio take a little off-centre that passes still climbs', () => {
    // A singer ~20 cents off at studio tolerance: run.score sits near 0.8 (its accuracy counts against ±10 cents), yet the take passes.
    const offCentre = { ...clean(run8), 'run.score': 0.8 };
    expect(evaluate(run8, offCentre).passed).toBe(true);
    expect(nextTempo(run8, startTempo(run8), offCentre)).toBe(ladderOf(run8)[1]);
  });

  it('do not care whether run.score is 0.849, 0.85 or 0.851: the pass rule moves the tempo, the owner\'s 85% only moves the tip', () => {
    for (const runScore of [0.849, 0.85, 0.851]) {
      const take = { ...clean(run8), 'run.score': runScore };
      expect(nextTempo(run8, startTempo(run8), take), `clean take at ${runScore}`).toBe(ladderOf(run8)[1]);
      expect(nextTempo(run8, startTempo(run8), { ...take, 'run.definedRate': 0.6 }), `smeared take at ${runScore}`).toBe(startTempo(run8));
    }
  });

  it('never advance a take that fails the level, however high its run.score (smeared notes)', () => {
    const smeared = { ...clean(run8), 'run.score': 0.88, 'run.definedRate': 0.6 };
    expect(evaluate(run8, smeared).passed).toBe(false);
    expect(nextTempo(run8, startTempo(run8), smeared)).toBe(startTempo(run8));
  });

  it('never advance a take whose realization was folded into too narrow a range', () => {
    expect(nextTempo(run8, startTempo(run8), clean(run8), { fit: 'folded' })).toBe(startTempo(run8));
    expect(nextTempo(run8, startTempo(run8), clean(run8), { fit: 'fits', plan: { issues: [] } })).toBe(ladderOf(run8)[1]);
  });

  it('treat an exercise without a ladder as one rung', () => {
    expect(ladderOf(sustain)).toEqual([sustain.tempoBpm]);
    expect(nextTempo(sustain, sustain.tempoBpm, clean(sustain))).toBe(sustain.tempoBpm);
    expect(isPassTempo(sustain, sustain.tempoBpm)).toBe(true);
  });
});

describe('canPassAtTempo: only the pass tempo counts toward a pass', () => {
  it('rules out every lower rung of a laddered exercise, however well it was sung', () => {
    const rungs = ladderOf(run8);
    for (const rung of rungs.slice(0, -1)) expect(canPassAtTempo(run8, rung), `rung ${rung}`).toBe(false);
    expect(canPassAtTempo(run8, run8.tempoBpm)).toBe(true);
    expect(canPassAtTempo(run8, run8.tempoBpm + 10)).toBe(true);
  });

  it('applies to the laddered Boss Recital too, and to nothing without a ladder', () => {
    const boss = getExercise('runs.boss-recital')!;
    expect(canPassAtTempo(boss, startTempo(boss))).toBe(false);
    expect(canPassAtTempo(boss, boss.tempoBpm)).toBe(true);
    expect(canPassAtTempo(sustain, 30)).toBe(true); // a single tempo: nothing to rule out
  });

  it('cannot tell when the tempo is unknown, so a legacy row is not punished', () => {
    expect(canPassAtTempo(run8, null)).toBe(true);
    expect(canPassAtTempo(run8, undefined)).toBe(true);
    expect(canPassAtTempo(run8, Number.NaN)).toBe(true);
  });
});
