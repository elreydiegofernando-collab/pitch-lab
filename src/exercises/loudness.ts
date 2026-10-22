/**
 * Loudness shape (SPEC §9.5): did a held note's level move the way its cue
 * asked? The dynamics analyzer measures the level range, pitch against
 * loudness and a swell's symmetry; none of them can tell a crescendo from a
 * decrescendo, or a swell from its inversion (a mirror image is just as
 * symmetric). Only the exercise knows what the cue asked, so it checks the
 * direction here.
 *
 * The asked path is the hold's LoudnessContour (cues.ts, read by plan.ts):
 * ramps for crescendo, decrescendo and swell, equal-length steps for a
 * soft/loud step cue. The score is the correlation of the held level
 * envelope with that path, floored at 0: about 1 when the level followed the
 * cue, about 0 for a flat or unrelated level (a one-way ramp on a swell
 * correlates 0 with it), 0 for the opposite way. It is scale-free, so it never
 * asks for an absolute loudness (the mic is uncalibrated) and leaves "how
 * much" to dynamics.rangeDb. Post-take only.
 */
import { CONFIG } from '../config';
import type { PitchTrack, TargetNote } from '../core/types';
import { correlation, heldPortion, median } from '../analysis/track';
import type { LoudnessContour } from './cues';

/**
 * A hold followed its cue at this score or above (CONFIG.dynamics.minShapeScore): half way between an
 * unrelated level (0) and the exact path (1). analyze.ts counts no loudness range for a hold below it.
 */
export const FOLLOWS_CUE_SCORE: number = CONFIG.dynamics.minShapeScore;
/** The envelope is median-filtered over this many frames (~53 ms at 94 fps): a pop or a one-frame glitch cannot steer it. */
const ENVELOPE_MEDIAN_FRAMES = 5;
/** Fewer held frames than this: too little to read a shape from. */
const MIN_HELD_FRAMES = 8;

const levelOf = (l: LoudnessContour['points'][number]): number => (l === 'loud' ? 1 : 0);

/** The contour's level (0 = soft, 1 = loud) at fraction `u` (clamped to 0..1) of the note. */
export function contourAt(contour: LoudnessContour, u: number): number {
  const n = contour.points.length;
  if (n === 0) return 0;
  if (n === 1) return levelOf(contour.points[0]);
  const x = Math.min(1, Math.max(0, u));
  if (!contour.smooth) return levelOf(contour.points[Math.min(n - 1, Math.floor(x * n))]);
  const pos = x * (n - 1);
  const i = Math.min(n - 2, Math.floor(pos));
  const a = levelOf(contour.points[i]);
  return a + (levelOf(contour.points[i + 1]) - a) * (pos - i);
}

/**
 * How closely the level held on `note` followed `contour`, 0..1. Read over the
 * held portion (after CONFIG.accuracy.holdStartSkipMs, as the dynamics
 * analyzer reads it). Null when the note was too short or too broken to read,
 * or when its level moved less than CONFIG.dynamics.minRangeDb: with no real
 * change there is no direction to judge, and dynamics.rangeDb already fails it.
 */
export function loudnessShapeScore(track: PitchTrack, note: TargetNote, contour: LoudnessContour): number | null {
  const held = heldPortion(track, note, CONFIG.accuracy.holdStartSkipMs);
  if (held.length < MIN_HELD_FRAMES || !(note.end > note.start)) return null;
  const half = ENVELOPE_MEDIAN_FRAMES >> 1;
  const env = new Array<number>(held.length);
  const want = new Array<number>(held.length);
  const win: number[] = [];
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < held.length; i++) {
    win.length = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(held.length - 1, i + half); k++) win.push(held[k].rmsDb);
    const e = median(win);
    env[i] = e;
    if (e < lo) lo = e;
    if (e > hi) hi = e;
    want[i] = contourAt(contour, (held[i].t - note.start) / (note.end - note.start));
  }
  if (!(hi - lo >= CONFIG.dynamics.minRangeDb)) return null;
  const r = correlation(want, env);
  return r === null ? null : Math.max(0, r);
}
