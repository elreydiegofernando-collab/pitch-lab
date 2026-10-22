/**
 * Pass and tier thresholds checked against the calibration model in
 * catalog/scoring.ts: on every level, the tier's entry singer sits on the pass
 * line, the next singer up reaches the solid tally, and the singer below the
 * tier fails. If a gate, weight or pass mark drifts away from the model, this
 * fails before a real singer finds out.
 */
import { describe, expect, it } from 'vitest';
import type { Metrics } from '../analysis/types';
import { EXERCISES, WORLDS, getExercise } from './catalog';
import { ENTRY, NEXT, RANGE_MIN_SPAN, populationValue, type Population, type ScoredMetric } from './catalog/scoring';
import { evaluate } from './evaluate';
import { nextTempo, startTempo } from './ladder';
import type { ExerciseDef } from './types';

const BELOW: Readonly<Record<ExerciseDef['tolerance'], Population | null>> = { easy: null, default: 'B', studio: 'D' };

/** A typical take of `pop` on `def`: every judged metric at that singer's typical value for the level's tier. */
function take(def: ExerciseDef, pop: Population): Metrics {
  const m: Metrics = {};
  const judged = new Set([...def.scoring.map((t) => t.metric), ...(def.pass.gates ?? []).map((g) => g.metric)]);
  for (const k of judged) m[k] = populationValue(k as ScoredMetric, def.tolerance, pop);
  return m;
}

const levelExercises = WORLDS.flatMap((w) => w.levels.map((l) => getExercise(l.exerciseId)!)).filter((e) => e.kind !== 'range-finder');

describe('calibration model', () => {
  it('puts each tier\'s entry singer on the pass line and through every gate', () => {
    for (const def of levelExercises) {
      const e = evaluate(def, take(def, ENTRY[def.tolerance]));
      expect(e.failedGates, def.id).toEqual([]);
      expect(e.score, def.id).toBeGreaterThanOrEqual(def.pass.score - 0.06);
      expect(e.score, def.id).toBeLessThan(def.tiers.solid);
    }
  });

  it('gives the next singer up the solid tally or better', () => {
    for (const def of EXERCISES.filter((e) => e.kind !== 'range-finder')) {
      const e = evaluate(def, take(def, NEXT[def.tolerance]));
      expect(e.passed, def.id).toBe(true);
      expect(e.mastery, def.id).toBeGreaterThanOrEqual(2);
    }
  });

  it('fails the singer below the tier', () => {
    for (const def of EXERCISES) {
      const below = BELOW[def.tolerance];
      if (!below || def.kind === 'range-finder') continue;
      expect(evaluate(def, take(def, below)).passed, def.id).toBe(false);
    }
  });

  it('lets an honest octave or more through the range finder, and not less, with the usual tallies', () => {
    const def = getExercise('foundations.range-finder.1')!;
    const at = (span: number) => evaluate(def, { 'range.spanSemitones': span });
    expect(RANGE_MIN_SPAN).toBe(12);
    expect(at(12)).toMatchObject({ passed: true, mastery: 1 });
    expect(at(11).passed).toBe(false);
    expect(at(14).mastery).toBe(2);
    expect(at(16).mastery).toBe(3);
    expect(at(27).mastery).toBe(3); // a big voice is measured, never asked to strain for more
  });

  it('lets every singer who can pass a laddered level climb its tempo ladder to the pass tempo, and keeps the singer below on the first rung', () => {
    const laddered = EXERCISES.filter((e) => (e.tempoLadder?.length ?? 0) > 0);
    expect(laddered.map((e) => e.tolerance)).toEqual(expect.arrayContaining(['easy', 'default', 'studio']));
    const climbed: string[] = [];
    for (const def of laddered) {
      // A calibration take is the singer's at the pass tempo; at a slower rung they sing it at least as well.
      for (const pop of [ENTRY[def.tolerance], NEXT[def.tolerance]]) {
        const m = take(def, pop);
        if (!evaluate(def, m).passed) continue;
        let bpm = startTempo(def);
        for (let k = 0; k < def.tempoLadder!.length && bpm < def.tempoBpm; k++) bpm = nextTempo(def, bpm, m);
        expect(bpm, `${def.id} ${pop}`).toBe(def.tempoBpm);
        climbed.push(`${def.id}:${pop === NEXT[def.tolerance] ? 'next' : 'entry'}`);
      }
      const below = BELOW[def.tolerance];
      if (below) expect(nextTempo(def, startTempo(def), take(def, below)), def.id).toBe(startTempo(def));
    }
    // The studio entry singer (run.score ~0.82, under the old fixed 85% advance mark) is among them, and every next-up singer.
    expect(climbed).toEqual(expect.arrayContaining(['runs.run.7:entry', 'runs.run.8:entry', 'runs.boss-recital:entry']));
    expect(climbed.filter((c) => c.endsWith(':next'))).toHaveLength(laddered.length);
  });

  it('makes auditions at least as demanding as the levels they skip', () => {
    for (const w of WORLDS) {
      if (!w.audition) continue;
      w.audition.exerciseIds.forEach((id, i) => {
        const test = getExercise(id)!;
        const level = getExercise(w.levels.find((l) => l.id === w.audition!.unlockThrough[i])!.exerciseId)!;
        // The skipped level's entry singer must not sail through the audition with a higher score than the level gives.
        const atLevel = evaluate(level, take(level, ENTRY[level.tolerance])).score;
        const atTest = evaluate(test, take(test, ENTRY[level.tolerance])).score;
        expect(atTest, `${id} vs ${level.id}`).toBeLessThanOrEqual(atLevel + 0.15);
      });
    }
  });
});
