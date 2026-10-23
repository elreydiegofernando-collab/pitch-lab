/**
 * Each metric as the coach says it (exercises/metrics.ts METRIC_INFO has the tile labels, with units): a plain label, a
 * plain reading of a value, and which way is better. The located problem quotes the readings and "since last time"
 * compares them, so the two always use the same words.
 */
import { CONFIG } from '../config';
import type { MetricKey } from '../analysis/types';
import type { VibratoStyle } from '../core/types';
import type { ExerciseDef } from '../exercises/types';
import * as P from './plain';

export interface Measure {
  /** "Time in tune", "Breaks". */
  label: string;
  /** The value in plain words: "52%", "about a quarter of the way to the next note", "about half a second". */
  words(value: number): string;
  /** Which way is better; 'zone' = closer to the vibrato style's zone. */
  better: 'higher' | 'lower' | 'zone';
}

const cents = (label: string): Measure => ({ label, words: P.pitchDistance, better: 'lower' });
const share = (label: string, better: 'higher' | 'lower' = 'higher'): Measure => ({ label, words: P.shareText, better });

export const MEASURES: Readonly<Record<MetricKey, Measure>> = {
  'accuracy.inTolerancePct': { label: 'Time in tune', words: P.percentText, better: 'higher' },
  'accuracy.medianAbsCents': cents('Typical miss'),
  'accuracy.sdCents': { label: 'How steady', words: P.steadiness, better: 'lower' },
  'accuracy.absBiasCents': cents('Off the middle by'),
  'accuracy.absDriftCentsPerSec': { label: 'Drift while holding', words: P.driftRate, better: 'lower' },
  'onset.settleMs': { label: 'Time to find the note', words: (v) => P.durationWords(v / 1000), better: 'lower' },
  'onset.scoopCents': { label: 'Slide up into the note', words: (v) => (v < 10 ? 'hardly any' : `from ${P.pitchDistance(v)} below`), better: 'lower' },
  'onset.overshootCents': { label: 'Going past the note', words: (v) => (v < 10 ? 'hardly any' : P.pitchDistance(v)), better: 'lower' },
  'onset.crispRate': share('Clean note starts'),
  'vibrato.present': share('Notes with vibrato'),
  'vibrato.rateHz': { label: 'Vibrato speed', words: P.wobbles, better: 'zone' },
  'vibrato.extentCents': { label: 'Vibrato width', words: (v) => `${P.pitchDistance(v)} each way`, better: 'zone' },
  'vibrato.regularity': share('Even vibrato'),
  'vibrato.inZone': share('Notes in the zone'),
  'vibrato.absCenteringCents': cents('Vibrato off the note by'),
  'vibrato.switchCleanRate': share('Clean switches'),
  'vibrato.bloomOnCue': share('Bloom on the cue'),
  'pulse.rateErrorHz': { label: 'Pulse speed off by', words: (v) => P.perSecond(v, 'pulse'), better: 'lower' },
  'pulse.regularity': share('Even pulses'),
  'glide.smoothness': share('Smooth slides'),
  'glide.endAbsCents': cents('Slide ending off by'),
  'glide.cracks': { label: 'Breaks', words: (v) => (Math.round(v) === 0 ? 'none' : String(Math.round(v))), better: 'lower' },
  'transition.cleanRate': share('Clean note changes'),
  'inflection.score': share('Shape match'),
  'inflection.landingAbsCents': cents('Landing off by'),
  'run.score': share('Run score'),
  'run.definedRate': share('Clear run notes'),
  'run.missedRate': share('Missed run notes', 'lower'),
  'dynamics.rangeDb': { label: 'Soft to loud', words: P.loudnessChange, better: 'higher' },
  'dynamics.absSlopeCentsPerDb': { label: 'Pitch as the loudness changed', words: P.pitchWithLoudness, better: 'lower' },
  'dynamics.symmetry': share('Even swell'),
  'range.spanSemitones': { label: 'Low to high', words: P.spanWords, better: 'higher' },
  'song.phraseScore': share('Phrase score'),
  'song.inTolerancePct': { label: 'Time in tune', words: P.percentText, better: 'higher' },
};

/** The vibrato zone of a style (CONFIG.vibrato.styles); with no style, the span both styles share between them. */
export function vibratoZone(style?: VibratoStyle): { rateHz: readonly [number, number]; extentCents: readonly [number, number] } {
  const z = CONFIG.vibrato.styles;
  if (style) return z[style];
  return {
    rateHz: [Math.min(z.pop.rateHz[0], z.classical.rateHz[0]), Math.max(z.pop.rateHz[1], z.classical.rateHz[1])],
    extentCents: [Math.min(z.pop.extentCents[0], z.classical.extentCents[0]), Math.max(z.pop.extentCents[1], z.classical.extentCents[1])],
  };
}

/** How far `v` lies outside [lo, hi] (0 inside). */
function outside(v: number, [lo, hi]: readonly [number, number]): number {
  return v < lo ? lo - v : v > hi ? v - hi : 0;
}

/**
 * True when `now` is better than `before` on `metric`, false when worse, null when the words do not change or either
 * value is missing (the reading must change for the coach to call it better or worse).
 */
export function compareMeasure(metric: MetricKey, before: number | undefined, now: number | undefined, style?: VibratoStyle): boolean | null {
  if (before === undefined || now === undefined || !Number.isFinite(before) || !Number.isFinite(now)) return null;
  const m = MEASURES[metric];
  if (m.words(before) === m.words(now)) return null;
  if (m.better === 'higher') return now > before;
  if (m.better === 'lower') return now < before;
  const zone = metric === 'vibrato.rateHz' ? vibratoZone(style).rateHz : vibratoZone(style).extentCents;
  const b = outside(before, zone);
  const n = outside(now, zone);
  return b === n ? null : n < b;
}

/** A pass gate on `metric`, if the exercise has one. */
export function gateOn(def: Pick<ExerciseDef, 'pass'>, metric: MetricKey): { op: '<=' | '>='; value: number } | undefined {
  return def.pass.gates?.find((g) => g.metric === metric);
}

/**
 * What the level asks for on `metric`, in plain words ("this level asks for 68%", "this level allows up to 3"), or
 * null when the exercise does not gate it, or gates a pitch distance (that reads better said against the take: the
 * locator's "more than this level allows").
 */
export function requirementWords(def: Pick<ExerciseDef, 'pass'>, metric: MetricKey): string | null {
  const g = gateOn(def, metric);
  if (!g) return null;
  const v = g.value;
  switch (metric) {
    case 'glide.cracks': {
      const n = Math.floor(v + 1e-9);
      return n <= 0 ? 'this level allows none' : n === 1 ? 'this level allows one' : `this level allows up to ${n}`;
    }
    case 'accuracy.inTolerancePct':
    case 'song.inTolerancePct':
      return `this level asks for ${P.percentText(v)}`;
    case 'onset.settleMs':
      return `this level asks for ${P.durationWords(v / 1000)} or less`;
    case 'dynamics.rangeDb':
      return 'this level needs a clear change from soft to loud';
    case 'dynamics.absSlopeCentsPerDb':
      return 'this level asks the pitch to hold still while the loudness changes';
    case 'accuracy.absDriftCentsPerSec':
      return 'this level asks you to hold each note level';
    case 'pulse.rateErrorHz':
      return `this level allows ${P.perSecond(v, 'pulse')} off`;
    case 'range.spanSemitones':
      return `the exercises need ${P.spanWords(v)}`;
    case 'run.missedRate':
      return `this level allows up to ${P.shareText(v)} missed`;
    default:
      break;
  }
  const info = MEASURES[metric];
  if (info.words === P.shareText) return g.op === '>=' ? `this level asks for ${P.shareText(v)}` : `this level allows up to ${P.shareText(v)}`;
  // A pitch distance reads better against the take ("more than this level allows") than as a second distance.
  return null;
}
