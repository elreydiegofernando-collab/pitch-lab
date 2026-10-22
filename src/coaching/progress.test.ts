/** "Since last time" and the measures behind it: the same plain words on both takes, and better only when they change. */
import { describe, expect, it } from 'vitest';
import type { MetricKey } from '../analysis/types';
import { EXERCISES, getExercise } from '../exercises';
import { MEASURES, compareMeasure, requirementWords, vibratoZone } from './measures';
import { jargonIn } from './plain';
import { measureLine, progressLinesFor, progressMetrics, scoreLine } from './progress';
import { attemptOf } from './test-takes';

const sustain = getExercise('foundations.sustain.1')!;
const sirens = getExercise('foundations.siren.1')!;

describe('measures', () => {
  it('reads every metric in plain words, for any value', () => {
    for (const metric of Object.keys(MEASURES) as MetricKey[]) {
      const m = MEASURES[metric];
      expect(jargonIn(m.label), m.label).toHaveLength(0);
      for (const v of [0, 0.3, 1, 4.5, 12, 30, 60, 120, 450, 900]) expect(jargonIn(m.words(v)), `${metric} ${v}`).toHaveLength(0);
    }
  });

  it('calls a change better or worse only when the words change', () => {
    expect(compareMeasure('accuracy.inTolerancePct', 40, 70)).toBe(true);
    expect(compareMeasure('accuracy.inTolerancePct', 70, 40)).toBe(false);
    expect(compareMeasure('accuracy.medianAbsCents', 40, 12)).toBe(true);
    expect(compareMeasure('accuracy.medianAbsCents', 22, 26)).toBeNull(); // both "about a quarter of the way"
    expect(compareMeasure('glide.cracks', 3, 1)).toBe(true);
    expect(compareMeasure('glide.cracks', undefined, 1)).toBeNull();
    expect(compareMeasure('onset.settleMs', 600, Number.NaN)).toBeNull();
  });

  it('judges vibrato speed and width by how close they come to the zone', () => {
    expect(vibratoZone().rateHz).toEqual([5, 7]);
    expect(vibratoZone('classical').extentCents).toEqual([40, 100]);
    expect(compareMeasure('vibrato.rateHz', 3.8, 5.6)).toBe(true);
    expect(compareMeasure('vibrato.rateHz', 6, 9)).toBe(false);
    expect(compareMeasure('vibrato.rateHz', 5.5, 6.5)).toBeNull(); // inside the zone both times
    expect(compareMeasure('vibrato.extentCents', 140, 90, 'pop')).toBe(true);
  });

  it('says what a level asks for in words, or nothing for a gate on a pitch distance', () => {
    expect(requirementWords(sustain, 'accuracy.inTolerancePct')).toMatch(/^this level asks for \d+%$/);
    expect(requirementWords(sirens, 'glide.cracks')).toMatch(/^this level allows (none|one|up to \d+)$/);
    expect(requirementWords(sirens, 'glide.endAbsCents')).toBeNull();
    expect(requirementWords(sustain, 'glide.cracks')).toBeNull();
    for (const def of EXERCISES) for (const g of def.pass.gates ?? []) {
      const words = requirementWords(def, g.metric);
      if (words) expect(jargonIn(words), `${def.id} ${g.metric}: ${words}`).toHaveLength(0);
    }
  });
});

describe('progress lines', () => {
  it('reads one measure on both takes', () => {
    expect(measureLine('accuracy.inTolerancePct', 52, 68)).toEqual({ label: 'Time in tune', before: '52%', now: '68%', better: true });
    expect(measureLine('glide.cracks', 0, 2)).toEqual({ label: 'Breaks', before: 'none', now: '2', better: false });
    expect(measureLine('onset.settleMs', undefined, 260)).toEqual({ label: 'Time to settle', before: 'not measured', now: 'about a quarter of a second', better: null });
    expect(scoreLine(0.42, 0.61)).toEqual({ label: 'Score', before: '42%', now: '61%', better: true });
    expect(scoreLine(0.6, 0.6)).toMatchObject({ better: null });
  });

  it('compares the problem’s measure, then each gate this take failed', () => {
    const prev = attemptOf(null, { exerciseId: sirens.id, metrics: { 'glide.cracks': 5, 'glide.smoothness': 0.2, 'glide.endAbsCents': 60 } });
    const cur = attemptOf(null, { exerciseId: sirens.id, metrics: { 'glide.cracks': 1, 'glide.smoothness': 0.1, 'glide.endAbsCents': 70 } });
    expect(progressMetrics(sirens, cur, { metric: 'glide.cracks' })).toEqual(['glide.cracks', 'glide.smoothness', 'glide.endAbsCents']);
    const lines = progressLinesFor(sirens, prev, cur, { metric: 'glide.cracks' });
    expect(lines.map((l) => l.label)).toEqual(['Breaks', 'Smooth slides', 'Slide ending off by']);
    expect(lines[0]).toMatchObject({ before: '5', now: '1', better: true });
    expect(lines[1]).toMatchObject({ before: '20%', now: '10%', better: false });
  });

  it('leaves out a measure one of the takes could not read, instead of calling it "about the same" (review R6)', () => {
    const sung = attemptOf(null, { exerciseId: sirens.id, score: 0.5, metrics: { 'glide.cracks': 2, 'glide.smoothness': 0.3, 'glide.endAbsCents': 15 } });
    const silent = attemptOf(null, { exerciseId: sirens.id, score: 0.1, metrics: { 'glide.cracks': 0, 'glide.smoothness': 0.3 } });
    const lines = progressLinesFor(sirens, sung, silent, { metric: 'glide.endAbsCents' });
    expect(lines.map((l) => l.label)).not.toContain('Slide ending off by');
    expect(lines.every((l) => l.before !== 'not measured' && l.now !== 'not measured')).toBe(true);
    // Nothing comparable at all: the score is the line.
    const none = attemptOf(null, { exerciseId: sirens.id, score: 0.05, metrics: {} });
    expect(progressLinesFor(sirens, sung, none, { metric: 'glide.endAbsCents' })).toEqual([{ label: 'Score', before: '50%', now: '5%', better: false }]);
  });

  it('has nothing to compare on a first take, and falls back to the score when nothing else applies', () => {
    const cur = attemptOf(null, { exerciseId: sustain.id, score: 0.9, metrics: { 'accuracy.inTolerancePct': 95 } });
    expect(progressLinesFor(sustain, null, cur, { metric: null })).toEqual([]);
    const prev = attemptOf(null, { exerciseId: sustain.id, score: 0.7, metrics: { 'accuracy.inTolerancePct': 80 } });
    expect(progressLinesFor(sustain, prev, cur, { metric: null })).toEqual([{ label: 'Score', before: '70%', now: '90%', better: true }]);
  });
});
