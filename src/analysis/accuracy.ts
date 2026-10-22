/**
 * 8.1 Accuracy & stability: how close to the target, how steady, and
 * whether it drifts over the hold. Pure function over a take-relative
 * PitchTrack plus the sustained TargetNote it was sung against.
 */
import type { PitchTrack, TargetNote } from '../core/types';
import type { AccuracyResult, AnalyzeContext } from './types';
import { CONFIG } from '../config';
import { centsVsTarget, cleanSpikes, estimateFrameDt, framesInWindow, heldPortion, linearFit, median, standardDeviation } from './track';

/*
 * CONFIG.accuracy.lateStartAllowanceSec: a singer may come in this late after the note's start and still be measured
 * against the part of the note they sang: that is a reaction to the cue, and lateness inside it is the onset
 * analyzer's business (where there is one) or nobody's. Later than this the missing start counts against coverage,
 * because for a long hold nothing else would: a 4-8 s sustain or a six-second audition note could otherwise be
 * "passed" by singing the last second or two of it, in perfect tune.
 */

/** AccuracyResult plus what the scorer needs to tell "sang it all" from "sang a little, perfectly". */
export interface AccuracyDetail extends AccuracyResult {
  /**
   * Seconds the held portion should last: from the earlier of the singer's own onset and CONFIG.accuracy.lateStartAllowanceSec
   * after the note's start (+ holdStartSkipMs) to the end of the note. 0 when never voiced.
   */
  heldWindowSec: number;
  /** Fraction of that window that was actually voiced, 0..1. Dropouts, stopping early and starting more than the allowance late lower it; a start within the allowance does not. */
  coverage: number;
}

/**
 * analyzeAccuracy(track, note, ctx) -- one sustained target note.
 * Measures only the held portion (CONFIG.accuracy.holdStartSkipMs after the
 * note's own onset, owned by analyzeOnset), so a slow approach to pitch
 * doesn't get counted twice against both onset and accuracy. Isolated
 * detector spikes (an octave glitch, a consonant pop) are removed first:
 * one 300-cent frame in a 200-frame hold would otherwise quadruple the
 * standard deviation.
 *
 * A note that was never voiced returns zeros and NaNs (not a throw):
 * `inTolerancePct` 0, `voicedSec` 0, every cents figure NaN, drift null.
 * `metricsFromResults` (score.ts) drops the NaNs and counts the note as a miss.
 */
export function analyzeAccuracy(track: PitchTrack, note: TargetNote, ctx: AnalyzeContext): AccuracyDetail {
  const scope = cleanSpikes(framesInWindow(track, note.start, note.end));
  const held = heldPortion(scope, note, CONFIG.accuracy.holdStartSkipMs);
  if (held.length === 0) {
    return { voicedSec: 0, biasCents: NaN, medianAbsCents: NaN, inTolerancePct: 0, sdCents: NaN, driftCentsPerSec: null, heldWindowSec: 0, coverage: 0 };
  }

  const dt = estimateFrameDt(scope);
  const voicedSec = Number.isFinite(dt) ? held.length * dt : 0;
  const onset = scope.find((f) => f.voiced) ?? held[0];
  const windowStart = Math.min(onset.t, note.start + CONFIG.accuracy.lateStartAllowanceSec) + CONFIG.accuracy.holdStartSkipMs / 1000;
  const heldWindowSec = Math.max(0, note.end - windowStart);
  const coverage = heldWindowSec > 0 ? Math.min(1, voicedSec / heldWindowSec) : 0;

  const cents = held.map((f) => centsVsTarget(f, note));
  const biasCents = median(cents);
  const medianAbsCents = median(cents.map((c) => Math.abs(c)));
  const sdCents = standardDeviation(cents);
  let inCount = 0;
  for (const c of cents) if (Math.abs(c) <= ctx.toleranceCents) inCount++;
  const inTolerancePct = (100 * inCount) / cents.length;

  const heldSpanSec = held[held.length - 1].t - held[0].t;
  let driftCentsPerSec: number | null = null;
  if (heldSpanSec >= CONFIG.accuracy.driftMinHoldSec) {
    const fit = linearFit(
      held.map((f) => f.t),
      cents,
    );
    driftCentsPerSec = fit ? fit.slope : null;
  }

  return { voicedSec, biasCents, medianAbsCents, inTolerancePct, sdCents, driftCentsPerSec, heldWindowSec, coverage };
}
