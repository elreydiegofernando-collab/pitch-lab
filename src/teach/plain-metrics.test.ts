/**
 * A take-report tile in plain words (owner, 2026-10-23: "in tune 72% of the time" rather than "828c"): every metric has a
 * reading and a goal a singer can say aloud, and none of them carries a unit.
 */
import { describe, expect, it } from 'vitest';
import type { MetricKey } from '../analysis/types';
import { jargonIn } from '../coaching/plain';
import { METRIC_INFO } from '../exercises/metrics';
import { TERM_IDS } from './glossary';
import { metricTerm, plainGoal, plainValue } from './plain-metrics';

const METRICS = Object.keys(METRIC_INFO) as MetricKey[];
/** A number glued to a unit, which `jargonIn`'s word boundaries would miss ("250ms"). */
const UNIT_AFTER_NUMBER = /\d\s*(?:¢|ms|hz|db|bpm|semitones?|cents?)\b/i;

describe('plainValue: what was measured, in words', () => {
  it('reads time in tune as a share of the time', () => {
    expect(plainValue('accuracy.inTolerancePct', 72.4)).toBe('72% of the time');
    expect(plainValue('song.inTolerancePct', 100)).toBe('100% of the time');
  });

  it('reads a miss as a distance against the next note, never in cents (the 828 that read as "828c")', () => {
    expect(plainValue('glide.endAbsCents', 828)).toBe('about 8 half steps');
    expect(plainValue('accuracy.medianAbsCents', 4)).toBe('a hair');
    expect(plainValue('accuracy.medianAbsCents', 12)).toBe('a little');
    expect(plainValue('accuracy.medianAbsCents', 25)).toBe('about a quarter of the way to the next note');
    expect(plainValue('accuracy.absBiasCents', 100)).toBe('about a half step');
  });

  it('reads steadiness, drift, time and a scoop in the coach’s words', () => {
    expect(plainValue('accuracy.sdCents', 12)).toBe('steady');
    expect(plainValue('accuracy.sdCents', 30)).toBe('wavery');
    expect(plainValue('accuracy.absDriftCentsPerSec', 2)).toBe('drifted a little');
    expect(plainValue('onset.settleMs', 310)).toBe('about a third of a second');
    expect(plainValue('onset.scoopCents', 4)).toBe('hardly any');
    expect(plainValue('onset.scoopCents', 25)).toBe('from about a quarter of the way to the next note below');
  });

  it('says what a share is a share of', () => {
    expect(plainValue('onset.crispRate', 0.35)).toBe('35% of notes');
    expect(plainValue('transition.cleanRate', 0.55)).toBe('55% of changes');
    expect(plainValue('vibrato.switchCleanRate', 0.8)).toBe('80% of switches');
    expect(plainValue('glide.smoothness', 0.4)).toBe('40%');
  });

  it('counts breaks, and says none for none', () => {
    expect(plainValue('glide.cracks', 0)).toBe('none');
    expect(plainValue('glide.cracks', 1)).toBe('1 break');
    expect(plainValue('glide.cracks', 5)).toBe('5 breaks');
    expect(plainValue('glide.cracks', 0.4)).toBe('none');
  });

  it('reads a span of notes in half steps and octaves, and the vibrato speed as wobbles a second', () => {
    expect(plainValue('range.spanSemitones', 12)).toBe('an octave');
    expect(plainValue('range.spanSemitones', 14)).toBe('an octave and 2 half steps');
    expect(plainValue('vibrato.rateHz', 5.8)).toBe('about six wobbles a second');
  });

  it('says a reading that could not be taken was not measured', () => {
    expect(plainValue('accuracy.inTolerancePct', Number.NaN)).toBe('not measured');
    expect(plainValue('glide.cracks', Number.POSITIVE_INFINITY)).toBe('not measured');
  });
});

describe('plainGoal: what the level asks for, in words', () => {
  it('asks for a share as "or more", or "or less" for a share to keep small', () => {
    expect(plainGoal('accuracy.inTolerancePct', '>=', 55)).toBe('55% of the time or more');
    expect(plainGoal('onset.crispRate', '>=', 0.35)).toBe('35% of notes or more');
    expect(plainGoal('glide.smoothness', '>=', 0.25)).toBe('25% or more');
    expect(plainGoal('run.missedRate', '<=', 0.1)).toBe('10% of notes or less');
  });

  it('asks for a pitch distance as "within" it', () => {
    expect(plainGoal('accuracy.medianAbsCents', '<=', 25)).toBe('within about a quarter of the way to the next note');
    expect(plainGoal('glide.endAbsCents', '<=', 48)).toBe('within about half the way to the next note');
    expect(plainGoal('onset.settleMs', '<=', 250)).toBe('within about a quarter of a second');
  });

  it('asks for breaks as none, one at most, or up to a few (a fraction never rounds up)', () => {
    expect(plainGoal('glide.cracks', '<=', 0)).toBe('no breaks');
    expect(plainGoal('glide.cracks', '<=', 1)).toBe('one break at most');
    expect(plainGoal('glide.cracks', '<=', 3.8)).toBe('up to 3 breaks');
    expect(plainGoal('glide.cracks', '<=', 0.5)).toBe('no breaks');
  });

  it('asks for a range as at least so many notes', () => {
    expect(plainGoal('range.spanSemitones', '>=', 12)).toBe('at least an octave');
  });

  it('asks for steadiness and a level hold in words, not in a bucket that reads as an allowance', () => {
    expect(plainGoal('accuracy.sdCents', '<=', 6)).toBe('very steady');
    expect(plainGoal('accuracy.sdCents', '<=', 12)).toBe('steady');
    expect(plainGoal('accuracy.sdCents', '<=', 18)).toBe('a little wavery at most');
    expect(plainGoal('accuracy.absDriftCentsPerSec', '<=', 1)).toBe('held level');
    expect(plainGoal('accuracy.absDriftCentsPerSec', '<=', 2.5)).toBe('drifting a little at most');
    expect(plainGoal('accuracy.absDriftCentsPerSec', '<=', 6.25)).toBe('drifting slowly at most');
  });

  it('asks for a scoop and for going past the note in words', () => {
    expect(plainGoal('onset.scoopCents', '<=', 5)).toBe('hardly any scoop');
    expect(plainGoal('onset.scoopCents', '<=', 30)).toBe('a scoop of no more than about a third of the way to the next note');
    expect(plainGoal('onset.overshootCents', '<=', 20)).toBe('no more than about a quarter of the way to the next note past the note');
  });

  it('asks for a change in loudness and a pitch that holds as the loudness changes', () => {
    expect(plainGoal('dynamics.rangeDb', '>=', 10)).toBe('a clear change from soft to loud');
    expect(plainGoal('dynamics.absSlopeCentsPerDb', '<=', 0.8)).toBe('pitch holding still as it gets louder or softer');
    expect(plainGoal('dynamics.absSlopeCentsPerDb', '<=', 2)).toBe('pitch moving only a little as it gets louder or softer');
  });

  it('says a goal that was never set is not set', () => {
    expect(plainGoal('accuracy.inTolerancePct', '>=', Number.NaN)).toBe('not set');
  });
});

describe('every metric reads plainly', () => {
  const VALUES = [0, 0.04, 0.3, 0.9, 1, 3, 7, 12, 25, 40, 60, 100, 150, 340, 828, 1190, 1300, 5000];

  it.each(METRICS.map((m) => [m] as const))('%s: a reading and a goal in words, with no unit and no jargon', (metric) => {
    for (const v of VALUES) {
      const outputs = [plainValue(metric, v), plainGoal(metric, '>=', v), plainGoal(metric, '<=', v)];
      for (const out of outputs) {
        expect(out.trim().length, `${metric} ${v}`).toBeGreaterThan(0);
        expect(jargonIn(out), `${metric} ${v}: "${out}"`).toEqual([]);
        expect(out, `${metric} ${v}: "${out}"`).not.toMatch(UNIT_AFTER_NUMBER);
        expect(out).not.toMatch(/NaN|undefined|Infinity/);
      }
    }
  });
});

describe('metricTerm: a label that is a music word can be tapped', () => {
  it('names the glossary term a label is', () => {
    expect(metricTerm('accuracy.inTolerancePct')).toBe('in-tune');
    expect(metricTerm('song.inTolerancePct')).toBe('in-tune');
    expect(metricTerm('accuracy.absDriftCentsPerSec')).toBe('drift');
    expect(metricTerm('onset.scoopCents')).toBe('scoop');
    expect(metricTerm('onset.crispRate')).toBe('clean-start');
    expect(metricTerm('glide.cracks')).toBe('crack');
    expect(metricTerm('vibrato.inZone')).toBe('vibrato');
    expect(metricTerm('glide.smoothness')).toBeUndefined();
  });

  it('only ever names a term the glossary has', () => {
    for (const metric of METRICS) {
      const id = metricTerm(metric);
      if (id !== undefined) expect(TERM_IDS).toContain(id);
    }
  });
});

describe('the metric labels the singer reads', () => {
  it('are plain: no units, no analyzer words', () => {
    for (const metric of METRICS) {
      const label = METRIC_INFO[metric].label;
      expect(jargonIn(label), `${metric}: ${label}`).toEqual([]);
      expect(label, `${metric}: ${label}`).not.toMatch(/\b(?:settle|onsets?|overshoot|spread|symmetry|bloom|centring|centre|arrival|per dB)\b/i);
    }
  });
});
