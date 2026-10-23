/**
 * The metric vocabulary as the exercise layer uses it: which MetricKeys each
 * analyzer produces (the catalog may only score or gate on those; validate.ts
 * enforces it), which way each metric is better, and how to label and format
 * it on the level screen and in take-report tiles.
 *
 * Take-level aggregation is analysis/score.ts's metricsFromResults (medians
 * of magnitudes with unmeasurable notes counted as the worst, shares over ALL
 * notes, summed counts, mean 0..1 scores); analyze.ts feeds it one result per
 * planned item (plan.ts) and adds three exercise-side rules:
 *  - dynamics.symmetry counts only holds cued as a swell (a crescendo or a
 *    soft/loud step is lopsided on purpose);
 *  - dynamics.rangeDb counts no range for a hold whose level went against its
 *    cue (loudness.ts), and none at all unless most holds followed theirs:
 *    only loudness changed the way it was asked counts;
 *  - with the 'cracks' analyzer, cracks are detected per phrase, so the
 *    breaths between phrases never count as breaks.
 * A metric is omitted (never NaN) when nothing could be measured; it then
 * scores 0 and fails any gate on it (evaluate.ts).
 */
import type { MetricKey } from '../analysis/types';
import type { AnalyzerId } from './types';

export const ANALYZER_METRICS: Readonly<Record<AnalyzerId, readonly MetricKey[]>> = {
  accuracy: ['accuracy.inTolerancePct', 'accuracy.medianAbsCents', 'accuracy.sdCents', 'accuracy.absBiasCents', 'accuracy.absDriftCentsPerSec'],
  onset: ['onset.settleMs', 'onset.scoopCents', 'onset.overshootCents', 'onset.crispRate'],
  vibrato: ['vibrato.present', 'vibrato.rateHz', 'vibrato.extentCents', 'vibrato.regularity', 'vibrato.inZone', 'vibrato.absCenteringCents'],
  switch: ['vibrato.switchCleanRate', 'vibrato.bloomOnCue'],
  pulse: ['pulse.rateErrorHz', 'pulse.regularity'],
  glide: ['glide.smoothness', 'glide.endAbsCents', 'glide.cracks'],
  cracks: ['glide.cracks'],
  transitions: ['transition.cleanRate'],
  inflection: ['inflection.score', 'inflection.landingAbsCents'],
  run: ['run.score', 'run.definedRate', 'run.missedRate'],
  dynamics: ['dynamics.rangeDb', 'dynamics.absSlopeCentsPerDb', 'dynamics.symmetry'],
  range: ['range.spanSemitones'],
};

/** 'higher' = bigger is better, 'lower' = smaller is better, 'target' = two-sided (judge it via vibrato.inZone instead). */
export type MetricDirection = 'higher' | 'lower' | 'target';

export interface MetricInfo {
  direction: MetricDirection;
  /** Short tile/requirement label, in plain words. */
  label: string;
  /** Display unit after scaling ('' = a count). */
  unit: string;
  /** Multiply the stored value by this for display (0..1 rates shown as %). */
  scale: number;
  /** Plausible stored-value bounds, for validating gate and band values. */
  min: number;
  max: number;
}

const rate = (label: string, direction: MetricDirection = 'higher'): MetricInfo => ({ direction, label, unit: '%', scale: 100, min: 0, max: 1 });
const cents = (label: string, max = 1200): MetricInfo => ({ direction: 'lower', label, unit: '¢', scale: 1, min: 0, max });

/**
 * The labels are plain words (owner, 2026-10-23: "you're using a lot of technical terms in the app that I don't know"):
 * they name what the singer did, not how the analyzer measured it (the coach's own labels are coaching/measures.ts).
 * Keys, units, scale and bounds are the analyst's and stay as they are: formatMetric still writes "250 ms" and "18¢",
 * for the coaching file and the dashboard; the take report writes the plain reading (teach/plain-metrics.ts).
 */
export const METRIC_INFO: Readonly<Record<MetricKey, MetricInfo>> = {
  'accuracy.inTolerancePct': { direction: 'higher', label: 'In tune', unit: '%', scale: 1, min: 0, max: 100 },
  'accuracy.medianAbsCents': cents('Typical miss'),
  'accuracy.sdCents': cents('How steady'),
  'accuracy.absBiasCents': cents('Off the middle by'),
  'accuracy.absDriftCentsPerSec': { direction: 'lower', label: 'Drift', unit: '¢/s', scale: 1, min: 0, max: 200 },
  'onset.settleMs': { direction: 'lower', label: 'Time to find the note', unit: 'ms', scale: 1, min: 0, max: 5000 },
  'onset.scoopCents': cents('Scoop'),
  'onset.overshootCents': cents('Going past the note'),
  'onset.crispRate': rate('Clean starts'),
  'vibrato.present': rate('Vibrato heard'),
  'vibrato.rateHz': { direction: 'target', label: 'Vibrato speed', unit: 'Hz', scale: 1, min: 0, max: 20 },
  'vibrato.extentCents': { direction: 'target', label: 'Vibrato width', unit: '¢', scale: 1, min: 0, max: 600 },
  'vibrato.regularity': rate('Vibrato evenness'),
  'vibrato.inZone': rate('In the vibrato zone'),
  'vibrato.absCenteringCents': cents('Vibrato off the note by'),
  'vibrato.switchCleanRate': rate('Clean switches'),
  'vibrato.bloomOnCue': rate('Vibrato on cue'),
  'pulse.rateErrorHz': { direction: 'lower', label: 'Pulse speed off by', unit: 'Hz', scale: 1, min: 0, max: 50 },
  'pulse.regularity': rate('Pulse evenness'),
  'glide.smoothness': rate('Smoothness'),
  'glide.endAbsCents': cents('Slide ending off by'),
  'glide.cracks': { direction: 'lower', label: 'Breaks', unit: '', scale: 1, min: 0, max: 100 },
  'transition.cleanRate': rate('Clean changes'),
  'inflection.score': rate('Shape match'),
  'inflection.landingAbsCents': cents('Landing'),
  'run.score': rate('Run score'),
  'run.definedRate': rate('Defined notes'),
  'run.missedRate': rate('Missed notes', 'lower'),
  'dynamics.rangeDb': { direction: 'higher', label: 'Soft to loud', unit: 'dB', scale: 1, min: 0, max: 80 },
  'dynamics.absSlopeCentsPerDb': { direction: 'lower', label: 'Pitch as the loudness changed', unit: '¢/dB', scale: 1, min: 0, max: 50 },
  'dynamics.symmetry': rate('Even swell'),
  'range.spanSemitones': { direction: 'higher', label: 'Low to high', unit: 'half steps', scale: 1, min: 0, max: 48 },
  'song.phraseScore': rate('Phrase score'),
  'song.inTolerancePct': { direction: 'higher', label: 'In tune', unit: '%', scale: 1, min: 0, max: 100 },
};

/** Direction of each metric (kept as its own map for callers that only need this). */
export const METRIC_DIRECTION: Readonly<Record<MetricKey, MetricDirection>> = Object.fromEntries(
  Object.entries(METRIC_INFO).map(([k, v]) => [k, v.direction]),
) as Record<MetricKey, MetricDirection>;

/** Union of the metrics produced by `analyzers`. */
export function metricsProducedBy(analyzers: readonly AnalyzerId[]): Set<MetricKey> {
  const out = new Set<MetricKey>();
  for (const a of analyzers) for (const m of ANALYZER_METRICS[a] ?? []) out.add(m);
  return out;
}

/** "62%", "18¢", "240 ms", "5.8 Hz", "2 breaks"-style display of a stored metric value. */
export function formatMetric(metric: MetricKey, value: number): string {
  const info = METRIC_INFO[metric];
  if (!Number.isFinite(value)) return '–';
  const v = value * info.scale;
  const a = Math.abs(v);
  const num = info.unit === 'Hz' || info.unit === '¢/dB' || info.unit === '¢/s' ? (a >= 10 ? Math.round(v).toString() : v.toFixed(1)) : Math.round(v).toString();
  if (info.unit === '%' || info.unit === '¢') return `${num}${info.unit}`;
  if (info.unit === '') return `${num}`;
  return `${num} ${info.unit}`;
}
