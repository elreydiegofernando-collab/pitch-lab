/**
 * 8.6 Dynamics / messa di voce: whether pitch stays steady as loudness
 * swells and fades. Loudness is RELATIVE ONLY (an uncalibrated phone mic
 * has no absolute dB meaning) -- never compare rmsDb to a fixed target,
 * only to this take's own floor.
 *
 * Measured on the HELD portion of the note (after CONFIG.accuracy.holdStartSkipMs):
 * every sung note has a 20 dB attack in its first few frames, and a soft
 * start often scoops flat; counting those would pass a "crescendo" that never
 * crescendoed and fail a flawless messa di voce as "flat when soft". The
 * level envelope is median-filtered over a few frames so a pop or a one-frame
 * glitch cannot set the floor or the ceiling.
 *
 * The envelope's SHAPE is read the same relative way, and it has a direction: a
 * swell is soft-loud-soft, and its mirror image loud-soft-loud is a different
 * (wrong) thing even though the two are exactly as symmetric. So `symmetry` is
 * credited only as far as BOTH ends of the note come down from the peak: in full
 * for a swell, not at all for a one-way crescendo or decrescendo or an inversion
 * (whose far end is as loud as the peak); `shape` names what the envelope was.
 */
import type { PitchFrame, PitchTrack, TargetNote } from '../core/types';
import type { AnalyzeContext, DynamicsResult } from './types';
import { CONFIG } from '../config';
import { clamp01 } from '../core/math';
import { centsVsTarget, cleanSpikes, correlation, estimateFrameDt, framesInWindow, heldPortion, median, runningMean, runningMedian, theilSenSlope } from './track';

/*
 * Local tuning (PROVISIONAL). The shape knobs live in CONFIG.dynamics: shapeSmoothSec (the envelope is averaged over that
 * long before its shape is read, so a vibrato's loudness ripple is not the shape) and endDownShare (how far an end of the
 * note has come DOWN from the peak, as a share of the dynamic range: no symmetry credit at the first value or less, full
 * credit at the second or more, linear between; a ramp rather than a cut-off because real messa di voce is often lopsided
 * (RESEARCH 6) and a dB envelope is lopsided by itself: a start only a quarter of the range down is a modest start, not a
 * different exercise. The end that has come down least sets the credit).
 */
/** Below this |correlation|, a slope beyond the drift threshold is not cleanly loudness-driven: call it drift, not sharp/flat-when-loud/soft. */
const DRIFT_WEAK_CORRELATION = 0.3;
/** The envelope is median-filtered over this many frames (~53 ms at 94 fps) before range and shape are read. */
const ENVELOPE_MEDIAN_FRAMES = 5;
/** The regression runs on at most this many time-ordered block medians: Theil-Sen is O(n^2) and 60 s is 5,600 frames. */
const MAX_REGRESSION_POINTS = 128;
/** A note needs this many held frames before anything is measured. */
const MIN_HELD_FRAMES = 8;
/** The envelope is resampled to this many points for the shape measures. */
const SHAPE_POINTS = 64;
/** The peak is the centre of the one stretch within this many dB of the maximum that contains it (a flat-topped swell has no single loudest frame). */
const PEAK_PLATEAU_DB = 1.5;
/** An end counts as "down" for the shape LABEL at the middle of the CONFIG.dynamics.endDownShare ramp. */
const END_DOWN_LABEL_SHARE = (CONFIG.dynamics.endDownShare[0] + CONFIG.dynamics.endDownShare[1]) / 2;
/** An end's level is the median of this many of the SHAPE_POINTS points (~10% of the span) at that end. */
const SHAPE_END_POINTS = 6;

/** How the level moves across a held note, read from its smoothed envelope. */
export type DynamicsShape =
  /** Soft, loud, soft: both ends are well below the peak (messa di voce), however lopsided. */
  | 'swell'
  /** Soft to loud: the start is well below the peak and the end is not (it stays at, or near, the peak). */
  | 'crescendo'
  /** Loud to soft: the end is well below the peak and the start is not. */
  | 'decrescendo'
  /** Loud, soft, loud: both ends are well above the quietest stretch. The mirror image of a swell, exactly as symmetric, and not a swell. */
  | 'inverted'
  /** Anything else: no slow change in level to name, such as a steady note with a short burst of loudness that the smoothing wipes out. */
  | 'uneven';

/** DynamicsResult plus what the contract result has no field for: the envelope's shape. Null when the note had too little dynamic range to have one. */
export interface DynamicsDetail extends DynamicsResult {
  shape: DynamicsShape | null;
}

const INSUFFICIENT = (rangeDb: number): DynamicsDetail => ({
  rangeDb,
  slopeCentsPerDb: null,
  correlation: null,
  symmetry: null,
  peakPosition: null,
  verdict: 'insufficient-range',
  shape: null,
});

/**
 * analyzeDynamics(track, note, ctx) -- one sustained target note, typically a swell/messa-di-voce.
 *
 * `symmetry` is the swell's: 0..1, how close the second half of the envelope is to the mirror image of the first
 * (1 = as long to fade as to grow, ~0.6 = a peak a quarter of the way in), times how far down both ends come (see
 * CONFIG.dynamics.endDownShare). So a crescendo, a decrescendo or a loud-soft-loud inversion, whose far end is as loud as the peak,
 * scores 0 however mirror-like it is, and a swell that only half comes back down scores part.
 * `peakPosition` is where the loudest stretch is (0..1 of the held span) whatever the shape.
 */
export function analyzeDynamics(track: PitchTrack, note: TargetNote, _ctx: AnalyzeContext): DynamicsDetail {
  const scope = cleanSpikes(framesInWindow(track, note.start, note.end));
  const held = heldPortion(scope, note, CONFIG.accuracy.holdStartSkipMs).filter((f) => Number.isFinite(f.rmsDb));
  if (held.length < MIN_HELD_FRAMES) return INSUFFICIENT(0);

  const env = runningMedian(
    held.map((f) => f.rmsDb),
    ENVELOPE_MEDIAN_FRAMES,
  ); // a Float64Array
  let floorDb = Infinity;
  let ceilingDb = -Infinity;
  for (const e of env) {
    if (e < floorDb) floorDb = e;
    if (e > ceilingDb) ceilingDb = e;
  }
  const rangeDb = ceilingDb - floorDb;
  if (rangeDb < CONFIG.dynamics.minRangeDb) return INSUFFICIENT(rangeDb);
  const relDb = env.map((e) => e - floorDb); // this take's own floor, not an absolute level

  const cents = held.map((f) => centsVsTarget(f, note));
  const pts = blockMedians(relDb, cents, MAX_REGRESSION_POINTS);
  const slopeCentsPerDb = theilSenSlope(pts.x, pts.y);
  const corr = correlation(pts.x, pts.y);
  const verdict = classifyVerdict(pts, slopeCentsPerDb, corr);

  const shape = envelopeShape(held, relDb, rangeDb);
  return { rangeDb, slopeCentsPerDb, correlation: corr, symmetry: shape.symmetry, peakPosition: shape.peakPosition, verdict, shape: shape.shape };
}

/**
 * Reduces (x, y) pairs to at most `maxPoints` by taking the median of each
 * contiguous time-ordered block. Unlike a stride, a block median averages a
 * vibrato riding on the pitch instead of aliasing it. Non-finite y values are
 * dropped first. Short series pass through untouched.
 */
function blockMedians(x: ArrayLike<number>, y: ArrayLike<number>, maxPoints: number): { x: number[]; y: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < x.length; i++) {
    if (Number.isFinite(y[i])) {
      xs.push(x[i]);
      ys.push(y[i]);
    }
  }
  if (xs.length <= maxPoints) return { x: xs, y: ys };
  const block = Math.ceil(xs.length / maxPoints);
  const bx: number[] = [];
  const by: number[] = [];
  for (let i = 0; i < xs.length; i += block) {
    bx.push(median(xs.slice(i, i + block)));
    by.push(median(ys.slice(i, i + block)));
  }
  return { x: bx, y: by };
}

/**
 * "Sharp when loud" and "flat when soft" share a slope sign (pitch rising
 * with loudness); they differ in which end carries the visible error. So
 * beyond the slope and correlation gates this compares the median cents in the
 * quietest and loudest thirds and names the verdict after the end whose error
 * is larger (and signed the right way). Pitch FALLING as loudness rises is
 * neither named shape, so it is plain drift.
 */
function classifyVerdict(pts: { x: number[]; y: number[] }, slope: number | null, corr: number | null): DynamicsResult['verdict'] {
  if (slope === null || Math.abs(slope) <= CONFIG.dynamics.maxDriftCentsPerDb) return 'steady';
  if (corr !== null && Math.abs(corr) < DRIFT_WEAK_CORRELATION) return 'drifts';
  if (slope < 0) return 'drifts';

  const order = pts.x.map((_, i) => i).sort((a, b) => pts.x[a] - pts.x[b]);
  const third = Math.max(1, Math.floor(order.length / 3));
  const quiet = median(order.slice(0, third).map((i) => pts.y[i]));
  const loud = median(order.slice(order.length - third).map((i) => pts.y[i]));
  if (loud > 0 && Math.abs(loud) >= Math.abs(quiet)) return 'sharp-when-loud';
  if (quiet < 0 && Math.abs(quiet) > Math.abs(loud)) return 'flat-when-soft';
  return 'sharp-when-loud';
}

/** Resamples `level` (one value per held frame, at the frames' own times) to SHAPE_POINTS evenly spaced points across the span, by linear interpolation. */
function resample(held: readonly PitchFrame[], level: ArrayLike<number>): Float64Array {
  const t0 = held[0].t;
  const span = held[held.length - 1].t - t0;
  const grid = new Float64Array(SHAPE_POINTS);
  let j = 0;
  for (let k = 0; k < SHAPE_POINTS; k++) {
    const t = t0 + (span * k) / (SHAPE_POINTS - 1);
    while (j < held.length - 2 && held[j + 1].t < t) j++;
    const ta = held[j].t;
    const tb = held[j + 1].t;
    const u = tb > ta ? Math.min(1, Math.max(0, (t - ta) / (tb - ta))) : 0;
    grid[k] = level[j] + (level[j + 1] - level[j]) * u;
  }
  return grid;
}

/** The one stretch of `grid` that contains its extremum `at` and stays within PEAK_PLATEAU_DB of it, as its centre position (0..1). `sign` is 1 for a maximum, -1 for a minimum. */
function plateauCentre(grid: Float64Array, at: number, sign: 1 | -1): number {
  const limit = sign * grid[at] - PEAK_PLATEAU_DB;
  let lo = at;
  let hi = at;
  while (lo > 0 && sign * grid[lo - 1] >= limit) lo--;
  while (hi < grid.length - 1 && sign * grid[hi + 1] >= limit) hi++;
  return (lo + hi) / 2 / (grid.length - 1);
}

function argExtremum(grid: Float64Array, sign: 1 | -1): number {
  let at = 0;
  for (let k = 1; k < grid.length; k++) if (sign * grid[k] > sign * grid[at]) at = k; // the first on a tie
  return at;
}

/**
 * Shape of the level envelope across the held span, resampled to SHAPE_POINTS
 * after a CONFIG.dynamics.shapeSmoothSec average (so a vibrato's loudness ripple is not the shape):
 *  - peakPosition (0..1 of the held span): the centre of the ONE stretch within
 *    PEAK_PLATEAU_DB of the maximum that contains the loudest point. (The centre of
 *    every point near the maximum would put the peak of a loud-soft-loud envelope, which
 *    is loudest at both ends, in the middle of the note.)
 *  - shape: which ends come down from the peak (see DynamicsShape).
 *  - symmetry (0..1): 1 minus the rms difference between the envelope and its
 *    time-reversal, relative to the range, times how far down both ends come
 *    (CONFIG.dynamics.endDownShare). A mirror-image swell scores 1; a peak a quarter of the way in
 *    ~0.6. A swell and its loud-soft-loud inversion are each other's mirror images and
 *    so tie on the first factor; the second is what tells them apart.
 *    (Comparing median levels of the rising and falling halves cannot see a
 *    sharp-rise-slow-fall shape: both halves cover the same levels.)
 */
function envelopeShape(
  held: readonly PitchFrame[],
  relDb: ArrayLike<number>,
  rangeDb: number,
): { symmetry: number | null; peakPosition: number | null; shape: DynamicsShape | null } {
  const span = held[held.length - 1].t - held[0].t;
  if (!(span > 0) || !(rangeDb > 0)) return { symmetry: null, peakPosition: null, shape: null };

  const frameSec = estimateFrameDt(held);
  const smoothFrames = Number.isFinite(frameSec) && frameSec > 0 ? Math.max(1, Math.round(CONFIG.dynamics.shapeSmoothSec / frameSec) | 1) : 1;
  const grid = resample(held, runningMean(relDb, smoothFrames));

  const top = argExtremum(grid, 1);
  const bottom = argExtremum(grid, -1);
  const peakPosition = plateauCentre(grid, top, 1);
  const start = median(grid.subarray(0, SHAPE_END_POINTS));
  const end = median(grid.subarray(SHAPE_POINTS - SHAPE_END_POINTS));
  // How far each end sits below the peak and above the floor, as shares of the range.
  const startDown = (grid[top] - start) / rangeDb;
  const endDown = (grid[top] - end) / rangeDb;
  const startUp = (start - grid[bottom]) / rangeDb;
  const endUp = (end - grid[bottom]) / rangeDb;
  const shape = classifyShape(startDown, endDown, startUp, endUp);

  let sq = 0;
  for (let k = 0; k < SHAPE_POINTS; k++) {
    const d = grid[k] - grid[SHAPE_POINTS - 1 - k];
    sq += d * d;
  }
  const mirror = clamp01(1 - Math.sqrt(sq / SHAPE_POINTS) / rangeDb);
  const [none, full] = CONFIG.dynamics.endDownShare;
  const credit = clamp01((Math.min(startDown, endDown) - none) / (full - none));
  return { symmetry: mirror * credit, peakPosition, shape };
}

function classifyShape(startDown: number, endDown: number, startUp: number, endUp: number): DynamicsShape {
  const down = END_DOWN_LABEL_SHARE;
  if (startDown >= down && endDown >= down) return 'swell';
  if (startUp >= down && endUp >= down) return 'inverted'; // the mirror image: a valley with both ends well above it
  if (startDown >= down) return 'crescendo'; // the end is not down: it stays at, or near, the peak
  if (endDown >= down) return 'decrescendo';
  return 'uneven';
}
