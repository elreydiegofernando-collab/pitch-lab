/**
 * Pulse builder (9.2): deliberate rhythmic pitch pulses on one held note at a
 * target rate (a "ha-ha-ha" feel, 3-5 Hz), the stepping stone toward natural
 * vibrato. The same analyzer scores the oscillation drills (alternating two
 * notes a tone or semitone apart): a pulse train on one pitch is one swing per
 * cycle, an alternation is one swing up and one down per cycle, so in both the
 * target is "cycles per second" (RealizedExercise.pulseHz).
 *
 * Built on vibrato.ts's oscillation primitives (detrend, lobes, chains): the
 * pulse rate is the zero-crossing rate over the longest run of consecutive
 * pulses (sub-frame timing, so a 4.5 Hz train is measured to a few hundredths
 * of a hertz instead of +/-1 frame = +/-0.2 Hz), regularity is the
 * cycle-to-cycle variability of that rhythm, and a "pulse" has to swing at
 * least as far as the straight-tone threshold or it does not count.
 *
 * `PulseResult` isn't in src/analysis/types.ts (only its two scored facets,
 * `pulse.rateErrorHz` and `pulse.regularity`, are named there as MetricKeys)
 * -- it is defined here instead.
 */
import type { PitchTrack, TargetNote } from '../core/types';
import { CONFIG } from '../config';
import { cleanSpikes, framesInWindow, voicedRuns } from './track';
import { detectOscillation, longestChain, measureChain, type LobeChain, type OscillationBand } from './vibrato';

export interface PulseResult {
  /** Hz actually produced: zero-crossing rate over the longest run of consecutive pulses. Null when fewer than 2 whole pulses were found. */
  measuredRateHz: number | null;
  /** Hz the exercise step asked for. */
  targetRateHz: number;
  /** measuredRateHz - targetRateHz, signed (+ = pulsed faster than asked). Null when measuredRateHz is null. */
  rateErrorHz: number | null;
  /** 0..1 from cycle-to-cycle rate variability; 1 = perfectly even rhythm. Null when fewer than 3 pulses (variability needs at least two cycles). */
  regularity: number | null;
  /** Whole pulses (cycles) in the measured run. */
  pulseCount: number;
  /** Median full swing (peak to trough) of the pulses, cents. Null when no pulses were found. */
  swingCents: number | null;
}

/** Pulses are found within this factor of the target rate either way; the rate itself is measured, not assumed. */
const BAND_FACTOR = 2.5;
/** Pulses ride on a held note, so the detrend window must span at least this many target periods (the vibrato window is too short for a slow alternation). */
const DETREND_PERIODS = 3;
/** Dropouts up to ~3 frames do not split a pulse train. */
const BRIDGE_GAP_SEC = 0.045;
/** A rate CV (std/mean of the instantaneous cycle rate) of this maps regularity to 0. */
const RATE_CV_BAD = 0.25;
/** A rhythm needs at least this many whole cycles before its evenness is judged (two cycles give only a couple of intervals to compare). */
const MIN_CYCLES_FOR_REGULARITY = 3;
/** Fewer samples than this cannot show a rhythm. */
const MIN_FRAMES = 8;
/** A non-periodic pulse train must swing this many times the straight-tone threshold to count. */
const IRREGULAR_PULSE_SWING_FACTOR = 2;

const NONE = (targetRateHz: number, pulseCount = 0): PulseResult => ({
  measuredRateHz: null,
  targetRateHz,
  rateErrorHz: null,
  regularity: null,
  pulseCount,
  swingCents: null,
});

/**
 * analyzePulse(track, notes, targetRateHz) -- a pulse train or oscillation
 * drill. `notes` is the single held note, or the realized notes of the whole
 * train (their span is analyzed). Frames outside the span are ignored.
 */
export function analyzePulse(track: PitchTrack, notes: TargetNote | readonly TargetNote[], targetRateHz: number): PulseResult {
  const list: readonly TargetNote[] = Array.isArray(notes) ? notes : [notes as TargetNote];
  if (list.length === 0 || !(targetRateHz > 0)) return NONE(targetRateHz);
  let start = Infinity;
  let end = -Infinity;
  for (const n of list) {
    if (n.start < start) start = n.start;
    if (n.end > end) end = n.end;
  }
  const scope = cleanSpikes(framesInWindow(track, start, end));

  const band: OscillationBand = {
    detrendSec: Math.max(CONFIG.vibrato.detrendWindowSec, DETREND_PERIODS / targetRateHz),
    minRateHz: Math.max(0.5, targetRateHz / BAND_FACTOR),
    maxRateHz: targetRateHz * BAND_FACTOR,
  };

  // Longest chain over every continuous stretch of voice.
  let best: { chain: LobeChain; det: ReturnType<typeof detectOscillation>; ts: Float64Array } | null = null;
  for (const run of voicedRuns(scope, BRIDGE_GAP_SEC)) {
    const frames = scope.slice(run.startIndex, run.endIndex).filter((f) => f.voiced);
    if (frames.length < MIN_FRAMES) continue;
    const ts = Float64Array.from(frames, (f) => f.t);
    const ys = Float64Array.from(frames, (f) => f.midi * 100);
    const det = detectOscillation(ts, ys, band);
    const chain = longestChain(det.chains);
    if (chain && (!best || chain.lobes.length > best.chain.lobes.length)) best = { chain, det, ts };
  }
  if (!best || best.chain.lobes.length < 4) return NONE(targetRateHz, best ? Math.floor(best.chain.lobes.length / 2) : 0);

  const m = measureChain(best.chain, best.det, best.ts, band, 0);
  // A pulse has to swing at least as far as the straight-tone threshold: smaller wobble is not a pulse. Pulses that are NOT periodic (an
  // uneven rhythm is still a rhythm to be scored) must swing clearly, or frame noise on a straight tone could pass for a train.
  const minSwing = CONFIG.vibrato.straightBelowExtentCents * (m.periodic ? 1 : IRREGULAR_PULSE_SWING_FACTOR);
  if (m.extentCents === null || m.extentCents < minSwing || m.zeroCrossingRateHz === null) {
    return NONE(targetRateHz, Math.floor(m.cycles));
  }

  const measuredRateHz = m.zeroCrossingRateHz;
  const regularity = m.cycles >= MIN_CYCLES_FOR_REGULARITY && m.rateCv !== null ? 1 - Math.min(1, Math.max(0, m.rateCv / RATE_CV_BAD)) : null;
  return {
    measuredRateHz,
    targetRateHz,
    rateErrorHz: measuredRateHz - targetRateHz,
    regularity,
    pulseCount: Math.floor(m.cycles),
    swingCents: m.extentCents * 2,
  };
}
