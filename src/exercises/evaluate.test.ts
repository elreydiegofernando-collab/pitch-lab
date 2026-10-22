import { describe, expect, it } from 'vitest';
import { scoreExercise } from '../analysis/score';
import type { MetricKey, Metrics } from '../analysis/types';
import { seededRandom } from '../dsp/test-signals';
import { EXERCISES, getExercise } from './catalog';
import { evaluate, gateHolds, isFolded, passRequirements, reportTiles, termScore } from './evaluate';
import { METRIC_INFO, formatMetric, metricsProducedBy } from './metrics';

const sustain2 = getExercise('foundations.sustain.2')!;

describe('termScore', () => {
  it('maps worst -> 0 and best -> 1 linearly, clamped, in either direction', () => {
    const up = { metric: 'accuracy.inTolerancePct' as MetricKey, weight: 1, best: 90, worst: 50 };
    expect(termScore(up, 70)).toBeCloseTo(0.5, 12);
    expect(termScore(up, 99)).toBe(1);
    expect(termScore(up, 10)).toBe(0);
    const down = { metric: 'accuracy.sdCents' as MetricKey, weight: 1, best: 10, worst: 30 };
    expect(termScore(down, 15)).toBeCloseTo(0.75, 12);
  });

  it('returns null for an unmeasured metric', () => {
    expect(termScore(sustain2.scoring[0], undefined)).toBeNull();
    expect(termScore(sustain2.scoring[0], NaN)).toBeNull();
  });
});

describe('evaluate', () => {
  it('agrees with analysis/score.ts on random takes of every catalog exercise', () => {
    const rand = seededRandom(7);
    for (const def of EXERCISES) {
      const keys = [...metricsProducedBy(def.analyzers)];
      for (let trial = 0; trial < 25; trial++) {
        const m: Metrics = {};
        for (const k of keys) {
          if (rand() < 0.1) continue; // sometimes unmeasured
          const { min, max } = METRIC_INFO[k];
          const hi = Math.min(max, k.endsWith('Pct') ? 100 : max > 100 ? 120 : max);
          m[k] = min + rand() * (hi - min);
        }
        const mine = evaluate(def, m);
        const theirs = scoreExercise(def, m);
        expect(mine.score).toBeCloseTo(theirs.score, 12);
        expect(mine.passed).toBe(theirs.passed);
        expect(mine.mastery).toBe(theirs.mastery);
        const gates = def.pass.gates ?? [];
        expect(mine.failedGates).toEqual(gates.flatMap((g, i) => (gateHolds(g, m) ? [] : [i])));
      }
    }
  });

  it('never passes a take with nothing measured, and fails a gate on an unmeasured metric', () => {
    for (const def of EXERCISES) expect(evaluate(def, {}).passed).toBe(false);
    const best = Object.fromEntries(sustain2.scoring.map((t) => [t.metric, t.best])) as Metrics;
    expect(evaluate(sustain2, best).passed).toBe(true);
    delete best['accuracy.absDriftCentsPerSec'];
    const e = evaluate(sustain2, best);
    expect(e.passed).toBe(false);
    expect(e.failedGates).toEqual([1]);
  });

  it('treats NaN like an unmeasured metric', () => {
    const best = Object.fromEntries(sustain2.scoring.map((t) => [t.metric, t.best])) as Metrics;
    best['accuracy.inTolerancePct'] = NaN;
    expect(evaluate(sustain2, best).passed).toBe(false);
  });

  it('lights the tally that the score reaches once passed', () => {
    const at = (score: number): Metrics =>
      Object.fromEntries(sustain2.scoring.map((t) => [t.metric, t.worst + score * (t.best - t.worst)])) as Metrics;
    expect(evaluate(sustain2, at(0.65)).mastery).toBe(1);
    expect(evaluate(sustain2, at(0.85)).mastery).toBe(2);
    expect(evaluate(sustain2, at(1)).mastery).toBe(3);
    expect(evaluate(sustain2, at(0.5)).mastery).toBe(0);
  });

  it('never passes a take whose realization was folded by octaves or lost a figure, but still shows its score', () => {
    const best = Object.fromEntries(sustain2.scoring.map((t) => [t.metric, t.best])) as Metrics;
    expect(evaluate(sustain2, best, { fit: 'fits', plan: { issues: [] } })).toMatchObject({ passed: true, mastery: 3 });
    expect(evaluate(sustain2, best, { fit: 'extended' }).passed).toBe(true);
    const folded = evaluate(sustain2, best, { fit: 'folded' });
    expect(folded).toMatchObject({ passed: false, mastery: 0, notJudged: 'folded' });
    expect(folded.score).toBeCloseTo(1, 12);
    expect(evaluate(sustain2, best, { fit: 'fits', plan: { issues: ['step 8 (rep 0) "Flip up": a flip is a held note followed directly by a higher one'] } }).passed).toBe(false);
    expect(isFolded({})).toBe(false);
  });
});

describe('pass requirements and report tiles', () => {
  it('states the score and every gate the way the level screen shows them', () => {
    const req = passRequirements(getExercise('foundations.staccato.1')!).map((r) => r.text);
    expect(req[0]).toBe('Score ≥ 60%');
    expect(req[1]).toMatch(/^Settle ≤ \d+ ms$/);
    expect(req[2]).toMatch(/^Scoop ≤ \d+¢$/);
    expect(passRequirements(getExercise('runs.run.1')!).map((r) => r.text)[1]).toMatch(/^Defined notes ≥ \d+%$/);
  });

  it('shows gated metrics first, then the heaviest terms, up to four', () => {
    const def = getExercise('foundations.boss-recital')!;
    const m: Metrics = { 'accuracy.inTolerancePct': 50, 'onset.scoopCents': 40, 'transition.cleanRate': 0.9, 'accuracy.sdCents': 12 };
    const tiles = reportTiles(def, m);
    expect(tiles).toHaveLength(4);
    expect(tiles.slice(0, 3).map((t) => t.metric)).toEqual(def.pass.gates!.map((g) => g.metric));
    expect(tiles[0]).toMatchObject({ label: 'In tune', display: '50%', met: true });
    expect(tiles[1].met).toBe(false); // 40¢ scoop against a studio gate
    expect(tiles[3].metric).toBe('accuracy.sdCents');
    expect(reportTiles(def, {})[0]).toMatchObject({ value: null, display: '–', met: null });
  });

  it('gives every tile its threshold: the gate for a gated metric, else where the term scores the pass mark', () => {
    // Sustain II (default tier): gates on in-tune time and drift, then the terms by weight: spread (0.3), then typical miss (0.15).
    // A term's target is worst + pass x (best - worst): spread [13, 30.5] -> 20 c, typical miss [10, 22.5] -> 15 c.
    const m: Metrics = { 'accuracy.inTolerancePct': 60, 'accuracy.absDriftCentsPerSec': 7, 'accuracy.sdCents': 18, 'accuracy.medianAbsCents': 16 };
    const tiles = reportTiles(sustain2, m);
    expect(tiles.map((t) => ({ metric: t.metric, op: t.op, target: Number(t.target.toFixed(3)), targetDisplay: t.targetDisplay, display: t.display, met: t.met }))).toEqual([
      { metric: 'accuracy.inTolerancePct', op: '>=', target: 53, targetDisplay: '53%', display: '60%', met: true },
      { metric: 'accuracy.absDriftCentsPerSec', op: '<=', target: 6.3, targetDisplay: '6.3 ¢/s', display: '7.0 ¢/s', met: false },
      { metric: 'accuracy.sdCents', op: '<=', target: 20, targetDisplay: '20¢', display: '18¢', met: true },
      { metric: 'accuracy.medianAbsCents', op: '<=', target: 15, targetDisplay: '15¢', display: '16¢', met: false },
    ]);
    // Crispness lists typical miss (0.2) after overshoot (0.15) and crisp rate (0.1): the tiles still go by weight.
    const crisp = getExercise('foundations.staccato.1')!;
    expect(crisp.scoring.map((t) => t.metric).indexOf('accuracy.medianAbsCents')).toBeGreaterThan(crisp.scoring.map((t) => t.metric).indexOf('onset.overshootCents'));
    expect(reportTiles(crisp, {}).map((t) => t.metric)).toEqual(['onset.settleMs', 'onset.scoopCents', 'accuracy.medianAbsCents', 'onset.overshootCents']);
    // Rates are stored 0..1 and shown as %; a non-gated rate term's target follows the same rule.
    const run3 = getExercise('runs.run.3')!;
    const runTiles = reportTiles(run3, { 'run.definedRate': 0.9, 'run.missedRate': 0.02, 'run.score': 0.8 });
    expect(runTiles.map((t) => [t.metric, t.op])).toEqual([['run.definedRate', '>='], ['run.missedRate', '<='], ['run.score', '>=']]);
    const score = run3.scoring.find((t) => t.metric === 'run.score')!;
    expect(runTiles[2].target).toBeCloseTo(score.worst + run3.pass.score * (score.best - score.worst), 12);
    expect(runTiles[2]).toMatchObject({ display: '80%', met: true });
  });
});

describe('formatMetric', () => {
  it('prints each unit the way the take report shows it', () => {
    const cases: Array<[Parameters<typeof formatMetric>[0], number, string]> = [
      ['vibrato.rateHz', 5.8, '5.8 Hz'],
      ['vibrato.rateHz', 12.4, '12 Hz'],
      ['dynamics.absSlopeCentsPerDb', 0.8, '0.8 ¢/dB'],
      ['accuracy.absDriftCentsPerSec', 3.25, '3.3 ¢/s'],
      ['onset.settleMs', 143.6, '144 ms'],
      ['glide.cracks', 2, '2'],
      ['accuracy.inTolerancePct', 53.1, '53%'],
      ['run.definedRate', 0.537, '54%'],
      ['accuracy.medianAbsCents', 14.6, '15¢'],
      ['dynamics.rangeDb', 24.04, '24 dB'],
      ['range.spanSemitones', 12, '12 semitones'],
      ['accuracy.sdCents', Number.NaN, '–'],
      ['vibrato.rateHz', Number.POSITIVE_INFINITY, '–'],
    ];
    for (const [metric, value, shown] of cases) expect(formatMetric(metric, value), `${metric} ${value}`).toBe(shown);
  });
});
