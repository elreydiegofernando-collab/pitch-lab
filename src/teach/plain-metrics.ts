/**
 * A take-report tile in plain words (owner, 2026-10-23: "in tune 72% of the time" rather than "828c"). What was
 * measured becomes a reading a singer can say aloud, and what the level asks for becomes a goal in words: never cents, Hz,
 * dB or ms. The words are the coach's own (coaching/measures.ts over coaching/plain.ts), so the tile, the coaching card
 * and "since last time" always agree; this adds the part a tile needs on top: what a share is a share of ("of the time",
 * "of notes"), and a goal for every metric that reads as a sentence ("within about a quarter of the way to the next note",
 * "no breaks", "at least an octave").
 *
 * Every function is pure and total: it answers for every MetricKey and any finite value (glossary.test.ts and
 * plain-metrics.test.ts sweep them). The stored numbers and units stay with the analyst (exercises/metrics.ts).
 */
import type { MetricKey } from '../analysis/types';
import { MEASURES } from '../coaching/measures';
import * as P from '../coaching/plain';
import type { TermId } from './glossary';

/** What a share is a share of, where "72%" alone would not say: "72% of the time", "35% of notes". */
const SHARE_OF: Readonly<Partial<Record<MetricKey, string>>> = {
  'accuracy.inTolerancePct': ' of the time',
  'song.inTolerancePct': ' of the time',
  'onset.crispRate': ' of notes',
  'vibrato.present': ' of notes',
  'vibrato.inZone': ' of notes',
  'vibrato.switchCleanRate': ' of switches',
  'vibrato.bloomOnCue': ' of cues',
  'transition.cleanRate': ' of changes',
  'run.definedRate': ' of notes',
  'run.missedRate': ' of notes',
};

/** True for a metric the coach reads as a share (a 0..1 rate, or a 0..100 percentage). */
function isShare(metric: MetricKey): boolean {
  const words = MEASURES[metric].words;
  return words === P.shareText || words === P.percentText;
}

/** True for a metric the coach reads as how far a pitch was from where it should be. */
function isDistance(metric: MetricKey): boolean {
  return MEASURES[metric].words === P.pitchDistance;
}

/**
 * What was measured, in words, for a tile: "72% of the time", "a little", "about half a second", "steady", "5 breaks",
 * "about 8 half steps". A reading that could not be measured is "not measured".
 */
export function plainValue(metric: MetricKey, value: number): string {
  if (!Number.isFinite(value)) return 'not measured';
  if (metric === 'glide.cracks') {
    const n = Math.round(value);
    return n <= 0 ? 'none' : P.count(n, 'break');
  }
  return `${MEASURES[metric].words(value)}${SHARE_OF[metric] ?? ''}`;
}

/** Where the coach's drift words change (plain.ts driftRate): below the first a note "held level", below the second it "drifted a little". */
const DRIFT_STEADY = 1.5;
const DRIFT_LITTLE = 3;

/**
 * What the level asks for, as the end of "Goal: ...": "55% of the time or more", "within about a quarter of the way to
 * the next note", "no breaks", "at least an octave". `target` is in the metric's stored unit, as ReportTile.target is.
 */
export function plainGoal(metric: MetricKey, op: '>=' | '<=', target: number): string {
  if (!Number.isFinite(target)) return 'not set';
  if (isShare(metric)) return `${plainValue(metric, target)} or ${op === '>=' ? 'more' : 'less'}`;
  if (isDistance(metric)) return `within ${P.pitchDistance(target)}`;
  switch (metric) {
    case 'glide.cracks': {
      const n = Math.floor(target + 1e-9);
      return n <= 0 ? 'no breaks' : n === 1 ? 'one break at most' : `up to ${n} breaks`;
    }
    case 'range.spanSemitones':
      return `at least ${P.spanWords(target)}`;
    case 'accuracy.sdCents':
      return target < 15 ? P.steadiness(target) : `${P.steadiness(target)} at most`;
    case 'accuracy.absDriftCentsPerSec':
      return target < DRIFT_STEADY ? 'held level' : target < DRIFT_LITTLE ? 'drifting a little at most' : 'drifting slowly at most';
    case 'onset.settleMs':
      return `within ${P.durationWords(target / 1000)}`;
    case 'onset.scoopCents':
      return target < 10 ? 'hardly any scoop' : `a scoop of no more than ${P.pitchDistance(target)}`;
    case 'onset.overshootCents':
      return target < 10 ? 'hardly any going past the note' : `no more than ${P.pitchDistance(target)} past the note`;
    case 'vibrato.rateHz':
      return P.wobbles(target);
    case 'vibrato.extentCents':
      return `${P.pitchDistance(target)} each way`;
    case 'pulse.rateErrorHz':
      return `within ${P.perSecond(target, 'pulse')}`;
    case 'dynamics.rangeDb':
      return target < 5 ? 'any change from soft to loud' : target < 10 ? 'a small change from soft to loud' : target < 16 ? 'a clear change from soft to loud' : 'a big change from soft to loud';
    case 'dynamics.absSlopeCentsPerDb':
      return target < 1 ? 'pitch holding still as it gets louder or softer' : 'pitch moving only a little as it gets louder or softer';
    default:
      // Every metric above is a share, a distance or has its own line; a new one gets the coach's words as they are.
      return `${MEASURES[metric].words(target)} ${op === '>=' ? 'or more' : 'or less'}`;
  }
}

/** The music word a metric's label is, so the label can be tapped to learn it (tiles label it with a Term), if it is one. */
export function metricTerm(metric: MetricKey): TermId | undefined {
  switch (metric) {
    case 'accuracy.inTolerancePct':
    case 'song.inTolerancePct':
      return 'in-tune';
    case 'accuracy.sdCents':
      return 'steady';
    case 'accuracy.absDriftCentsPerSec':
      return 'drift';
    case 'onset.scoopCents':
      return 'scoop';
    case 'onset.crispRate':
      return 'clean-start';
    case 'glide.cracks':
      return 'crack';
    case 'range.spanSemitones':
      return 'range';
    case 'vibrato.present':
    case 'vibrato.rateHz':
    case 'vibrato.extentCents':
    case 'vibrato.regularity':
    case 'vibrato.inZone':
    case 'vibrato.absCenteringCents':
    case 'vibrato.switchCleanRate':
    case 'vibrato.bloomOnCue':
      return 'vibrato';
    default:
      return undefined;
  }
}
