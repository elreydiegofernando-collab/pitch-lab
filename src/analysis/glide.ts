/**
 * Glide / slide analysis (SPEC 8.4): when the voice actually left the start pitch
 * and arrived at the end pitch, start/end accuracy, monotonicity, stair-stepping,
 * an overall 0..1 smoothness score and any cracks inside the glide.
 *
 * Method. The voiced contour (median-of-3, so a glitch frame cannot fake a step) is
 * expressed as PROGRESS toward the end pitch: 0 at the start pitch, 1 at the end
 * pitch, in either direction. The glide's departure and arrival are where progress
 * crosses 10% (the last time it does before arriving) and 90% (the first time it
 * stays there), interpolated between frames. For a linear ramp that 10%-90% span is
 * exactly 0.8 of the ramp, so `durationMs` is the linear-equivalent ramp time and
 * `departT`/`arriveT` extend the crossings by 10% each side. This is independent of
 * the tolerance, of the interval size and of any hold before or after the glide.
 *
 * Stair steps are flat stretches INSIDE the glide (between departure and arrival), so
 * the hold before and after a slide never counts. "Flat" is judged against the glide's
 * own speed: a stretch is a stair only if it is narrow in absolute terms AND its fitted
 * slope is a small fraction of the glide's mean speed, so a slow siren (locally flat on a
 * 60 ms scale) is not mistaken for a staircase. A flat spot that is a turning point (the
 * pitch was falling into it or rises out of it the wrong way) is vibrato or wobble, not a
 * stair: a staircase only ever stalls on the way.
 *
 * Vibrato on a siren needs more than that. Once its speed (amplitude x 2 pi x rate) is
 * comparable to the siren's, "ramp + oscillation" stalls every cycle, and a stall every cycle
 * is also exactly what a staircase is: at the critical amplitude the two contours are the same
 * contour. So the stair test is gated by a model of the vibrato. `explainVibrato` fits one
 * sinusoid in the vibrato band (CONFIG.vibrato wobble..bleat) to the contour left over after a
 * one-period moving average has taken the glide away, in overlapping windows. Where the
 * sinusoid explains it (a misfit within the scatter of the voice), the oscillation is vibrato:
 * stair candidates inside that stretch are not stairs and the oscillation is taken out before
 * reversals are measured. Where it does not (a flat-topped, non-sinusoidal wave, or a rate
 * outside the band) nothing is explained away and the raw plateaus count. The price is a
 * deliberate bias: a staircase whose steps are a vibrato's size and rhythm (short plateaus with
 * long ramps, 5-7 steps/s) is called vibrato, not stair-stepping.
 *
 * Edge cases are judged on what the voice did, not on where it ended up:
 *  - A glide that falls short (reaches at least half the interval but not 90%) is measured
 *    against the progress it did reach, so an undershooting siren still has a duration and a
 *    shape; the shortfall shows in `endErrorCents`.
 *  - A note that never moved (held at the start pitch, OR held at the end pitch the whole
 *    time) has no glide: `durationMs` null, `smoothness` 0. Net `travel`, not peak progress,
 *    decides this.
 *  - A move under CONFIG.transitions.portamentoFloorMs is a clean step. Where a long glide was
 *    asked for (>= 4 floors) a step is the opposite of a glide: smoothness 0 (and detectCracks
 *    flags the jump).
 *
 * The knobs that decide what counts (CONFIG.transitions portamentoFloorMs, stairPlateauMs, vibratoMisfitMinCents,
 * vibratoMisfitNoiseFactor, vibratoBandMarginHz, and the vibrato band's edges and extent cap, CONFIG.vibrato
 * wobbleBelowHz / bleatAboveHz / wobbleAboveExtentCents) are read from CONFIG; the rest are the clearly-named
 * PROVISIONAL consts below: they want a real-voice corpus, above all the misfit pair, which sets how irregular a
 * vibrato may be before its stalls count as stairs again.
 */
import type { PitchTrack, TargetNote } from '../core/types';
import type { AnalyzeGlide, CrackEvent, GlideResult } from './types';
import { CONFIG } from '../config';
import { detectCracks } from './cracks';
import { fitSlopeCentsPerSec, voicedContour, type Contour } from './segment';
import { frameRange, lowerBoundTimes, medianRange, medianSpacing } from './track';

/** Below this interval the "glide" has no direction to measure progress along. */
const MIN_GLIDE_CENTS = 50;
/** Progress levels that define departure and arrival. */
const DEPART_LEVEL = 0.1;
const ARRIVE_LEVEL = 0.9;
/** Look this far either side of the requested [start, end] for a late departure or late arrival: half the glide, clamped. */
const PAD_FRACTION = 0.5;
const PAD_MIN_SEC = 0.1;
const PAD_MAX_SEC = 0.3;
/** Start/end error = median pitch within this half-window of the requested time; falls back to the nearest frames within EDGE_FALLBACK_SEC. */
const EDGE_HALF_WINDOW_SEC = 0.06;
const EDGE_FALLBACK_SEC = 0.25;
/** Backslide (drop from the best progress so far) beyond max(MIN, FRACTION of the interval) is a reversal: it ignores vibrato-sized wobble. */
const BACKSLIDE_MIN_CENTS = 60;
const BACKSLIDE_FRACTION = 0.12;
/** A stair step is narrower than this and its fitted slope is below this fraction of the glide's mean speed ... */
const PLATEAU_MAX_RANGE_CENTS = 25;
/** On a noisy contour the flat window may be this many times the scatter wide (the slope test, not the width, separates a stall from a ramp). */
const PLATEAU_NOISE_FACTOR = 3.5;
const PLATEAU_SPEED_RATIO = 0.25;
/** ... and the pitch arrived at it and leaves it in the glide's direction by at least this much (judged over APPROACH_SEC either side). */
const PLATEAU_MIN_APPROACH_CENTS = 10;
const APPROACH_SEC = 0.09;
/** The slope of a window is only trusted if its standard error is below this fraction of the glide's mean speed (noisy contours need longer stalls). */
const PLATEAU_MAX_SLOPE_SE_RATIO = 0.18;
/**
 * Vibrato on a glide (see explainVibrato). The band is the one the vibrato analyzer flags: slower than CONFIG.vibrato.wobbleBelowHz is a
 * wobble and faster than CONFIG.vibrato.bleatAboveHz a bleat, neither is vibrato (the top edge also keeps clear of the bleat flag by a
 * margin, so an 8-step/s staircase is not taken for it). The extent cap is the wobble flag's.
 */
const VIBRATO_HZ_LO = CONFIG.vibrato.wobbleBelowHz;
const VIBRATO_HZ_HI = CONFIG.vibrato.bleatAboveHz - CONFIG.transitions.vibratoBandMarginHz;
const VIBRATO_HZ_STEP = 0.1;
const VIBRATO_MAX_AMP_CENTS = CONFIG.vibrato.wobbleAboveExtentCents;
/** An oscillation under this amplitude is not worth modelling (jitter finds sinusoids this big in any contour). */
const VIBRATO_MIN_AMP_CENTS = 6;
/** Interiors shorter than this, or windows holding fewer cycles, are too short to tell vibrato from a stall. */
const VIBRATO_MIN_INTERIOR_SEC = 0.5;
const VIBRATO_MIN_CYCLES = 2;
const VIBRATO_MIN_FRAMES = 8;
/** Analysis windows of this length overlap by half and cross-fade, so a long siren tracks a drifting rate and amplitude without seams. */
const VIBRATO_WINDOW_SEC = 0.8;
/**
 * A window is "explained" when the best sinusoid leaves at most max(CONFIG.transitions.vibratoMisfitMinCents, CONFIG.transitions.vibratoMisfitNoiseFactor
 * x the contour's own scatter) RMS cents unexplained: jitter alone leaves ~the scatter, natural vibrato (rate drift, amplitude bloom, a little
 * harmonic distortion) a few cents more, a staircase with real plateaus 15-30 c.
 */
/**
 * A vibrato that is bigger than the siren is slow must move the contour BACKWARD every cycle (its speed, amplitude x 2 pi x rate, beats the
 * siren's); a staircase of the same period and size never does, and a sinusoid can mimic one once the detector has rounded its edges. So when
 * the fitted model's own backslide is clear of the noise (REVERSAL_MIN, REVERSAL_NOISE_FACTOR x scatter) and the contour has less than
 * REVERSAL_KEEP of it, the window is not that vibrato.
 */
const VIBRATO_REVERSAL_MIN_CENTS = 8;
const VIBRATO_REVERSAL_NOISE_FACTOR = 2.5;
const VIBRATO_REVERSAL_KEEP = 0.5;
/** A stair candidate whose frames are on average at least this much covered by explained vibrato is vibrato, not a stair. */
const VIBRATO_GATE = 0.5;
/** Smoothness = exp(-(PER_EVENT * stairs-and-reversals + PER_SHARE * share of the glide spent stalled or reversing)) * roughness factor. */
const SMOOTHNESS_PER_EVENT = 0.2;
const SMOOTHNESS_PER_SHARE = 1.2;
/** Frame-to-frame scatter (RMS of raw vs median-of-3, cents) above this starts to cost smoothness. */
const ROUGHNESS_FLOOR_CENTS = 25;
const ROUGHNESS_WEIGHT = 2;
const ROUGHNESS_SCALE_CENTS = 100;
/** A glide requested for at least this many portamento floors that is sung as a step has no smoothness (it jumped). */
const REQUESTED_GLIDE_MIN_FACTOR = 4;
/** Below this net travel (fraction of the interval) the glide did not happen at all: smoothness is 0. */
const MIN_PEAK_PROGRESS = 0.3;
/** Voicing that begins no further into a glide than this fraction of it is extrapolated back to the glide's start. */
const LATE_START_MAX_PROGRESS = 0.35;
/** A glide that reached at least this much of the interval but not 90% is measured against what it did reach. */
const MIN_UNDERSHOOT_PEAK = 0.5;

export interface GlideMeasure {
  /** Linear-equivalent ramp duration (10%-90% crossing span / 0.8), ms. Null if departure or arrival was not observed. */
  durationMs: number | null;
  /** Take time the glide started / ended (crossings extended by 10% each side). Null with durationMs. */
  departT: number | null;
  arriveT: number | null;
  /** Highest progress the contour reached (1 = the end pitch; > 1 = overshoot). 0 when nothing was voiced. */
  maxProgress: number;
  /** Net progress made: the peak minus the lowest progress before it. 0 for a note held at either end pitch, ~1 for a full glide. */
  travel: number;
  startErrorCents: number | null;
  endErrorCents: number | null;
  monotonic: boolean;
  /** Deepest drop from the best progress so far while gliding, cents. */
  maxBackslideCents: number;
  stairSteps: number;
  smoothness: number;
  cracks: CrackEvent[];
}

/** Median smoothed pitch within +/- `half` of `t0`; else the 3 nearest frames within `fallback`; else null. */
function pitchAround(c: Contour, t0: number, half: number, fallback: number): number | null {
  let lo = -1;
  let hi = -1;
  for (let k = 0; k < c.length; k++) {
    if (Math.abs(c.t[k] - t0) <= half) {
      if (lo < 0) lo = k;
      hi = k;
    }
  }
  if (lo >= 0) return medianRange(c.smooth, lo, hi + 1);
  let nearest = -1;
  let bestD = fallback;
  for (let k = 0; k < c.length; k++) {
    const d = Math.abs(c.t[k] - t0);
    if (d <= bestD) {
      bestD = d;
      nearest = k;
    }
  }
  if (nearest < 0) return null;
  return medianRange(c.smooth, Math.max(0, nearest - 1), Math.min(c.length, nearest + 2));
}

/** Time at which `p` crosses `level` going from index k-1 to k (linear interpolation; k itself when k-1 is already on the far side). */
function crossingTime(c: Contour, p: Float64Array, k: number, level: number): number {
  if (k <= 0) return c.t[0];
  const a = p[k - 1];
  const b = p[k];
  if (b === a) return c.t[k];
  const u = (level - a) / (b - a);
  return c.t[k - 1] + (u < 0 ? 0 : u > 1 ? 1 : u) * (c.t[k] - c.t[k - 1]);
}

/** The vibrato `explainVibrato` found on a glide's interior, one entry per contour element (0 outside the explained stretches). */
interface GlideVibrato {
  /** 0..1: how far the element is covered by explained vibrato. Overlapping windows cross-fade, so an element's weights sum to at most 1. */
  weight: Float64Array;
  /** The fitted oscillation at that element, semitones, already weighted: take it from the contour to get the glide without its vibrato. */
  model: Float64Array;
}

/**
 * Finds the vibrato on contour elements [a, b] (a glide's interior) and where it explains the contour; null when it explains none of it.
 *
 * The interior is cut into overlapping windows (VIBRATO_WINDOW_SEC, half overlap). For each trial rate in the vibrato band the glide is taken
 * away with a centred moving average of exactly one period (it follows a ramp and cancels an oscillation of that period and its harmonics),
 * and a single sinusoid is least-squares fitted to what is left. The best rate is the one that leaves the least unexplained; the window is
 * "explained" when that sinusoid is a plausible vibrato (VIBRATO_MIN..MAX_AMP_CENTS) and what it leaves unexplained is no more than the
 * scatter of the voice allows (VIBRATO_MISFIT_*). A staircase is not a sinusoid: its flat tops and quick risers leave far more, and a train
 * of steps outside the band does not fit at all.
 *
 * Why a fit and not a rate: the zero-crossing rate of the residual is the step rate of a staircase just as it is the rate of a vibrato.
 * Only the shape tells them apart, and where the shapes coincide (a vibrato at the critical amplitude stalls ~100 ms a cycle) they cannot be
 * told apart at all, so those are called vibrato.
 *
 * `noiseRms` is the contour's frame-to-frame scatter (cents); `dir` is the glide's direction (+1 rising, -1 falling), which says which way
 * a backslide goes. Frames within half a period of the interior's ends take no part in the fit
 * (their average would be one-sided) but are still covered by the window's weight.
 */
function explainVibrato(c: Contour, a: number, b: number, noiseRms: number, dir: 1 | -1): GlideVibrato | null {
  const secTotal = c.t[b] - c.t[a];
  if (secTotal < VIBRATO_MIN_INTERIOR_SEC) return null;
  const winLen = Math.min(secTotal, VIBRATO_WINDOW_SEC);
  const nWin = secTotal <= winLen * 1.0001 ? 1 : Math.ceil((secTotal - winLen) / (winLen / 2)) + 1;
  const hop = nWin > 1 ? (secTotal - winLen) / (nWin - 1) : 0;
  const maxMisfit = Math.max(CONFIG.transitions.vibratoMisfitMinCents, CONFIG.transitions.vibratoMisfitNoiseFactor * noiseRms);

  const prefix = new Float64Array(c.length + 1);
  for (let k = 0; k < c.length; k++) prefix[k + 1] = prefix[k] + c.smooth[k];

  let weight: Float64Array | null = null;
  let model: Float64Array | null = null;
  for (let w = 0; w < nWin; w++) {
    const tA = c.t[a] + w * hop;
    const tB = w === nWin - 1 ? c.t[b] : tA + winLen;
    const wa = Math.max(a, lowerBoundTimes(c.t, tA));
    const wb = Math.min(b, lowerBoundTimes(c.t, tB + 1e-9) - 1);
    if (wb - wa + 1 < VIBRATO_MIN_FRAMES) continue;

    let bestHz = 0;
    let bestS = 0;
    let bestC = 0;
    let bestAmp = 0;
    let bestResid = Infinity;
    for (let f = VIBRATO_HZ_LO; f <= VIBRATO_HZ_HI + 1e-9; f += VIBRATO_HZ_STEP) {
      const half = 0.5 / f;
      const tLo = c.t[a] + half;
      const tHi = c.t[b] - half;
      const omega = 2 * Math.PI * f;
      let ss = 0;
      let cc = 0;
      let sc = 0;
      let sy = 0;
      let cy = 0;
      let yy = 0;
      let n = 0;
      let tFirst = Infinity;
      let tLast = -Infinity;
      for (let k = wa; k <= wb; k++) {
        const t = c.t[k];
        if (t < tLo || t > tHi) continue;
        const lo = Math.max(a, lowerBoundTimes(c.t, t - half));
        const hi = Math.min(b + 1, lowerBoundTimes(c.t, t + half + 1e-9));
        const r = (c.smooth[k] - (prefix[hi] - prefix[lo]) / (hi - lo)) * 100;
        const s = Math.sin(omega * t);
        const co = Math.cos(omega * t);
        ss += s * s;
        cc += co * co;
        sc += s * co;
        sy += s * r;
        cy += co * r;
        yy += r * r;
        n++;
        if (t < tFirst) tFirst = t;
        if (t > tLast) tLast = t;
      }
      if (n < VIBRATO_MIN_FRAMES || (tLast - tFirst) * f < VIBRATO_MIN_CYCLES) continue;
      const det = ss * cc - sc * sc;
      if (Math.abs(det) < 1e-9) continue;
      const S = (sy * cc - cy * sc) / det;
      const C = (cy * ss - sy * sc) / det;
      const amp = Math.hypot(S, C);
      if (amp < VIBRATO_MIN_AMP_CENTS) continue;
      const resid = Math.sqrt(Math.max(0, yy - (S * sy + C * cy)) / n);
      if (resid < bestResid) {
        bestResid = resid;
        bestHz = f;
        bestS = S;
        bestC = C;
        bestAmp = amp;
      }
    }
    if (bestHz === 0 || bestAmp > VIBRATO_MAX_AMP_CENTS || bestResid > maxMisfit) continue;

    // The model's backslide (moving average + fitted oscillation) against the contour's own over the same frames.
    {
      const half = 0.5 / bestHz;
      const omega = 2 * Math.PI * bestHz;
      const tLo = c.t[a] + half;
      const tHi = c.t[b] - half;
      let runModel = -Infinity;
      let runData = -Infinity;
      let backModel = 0;
      let backData = 0;
      for (let k = wa; k <= wb; k++) {
        const t = c.t[k];
        if (t < tLo || t > tHi) continue;
        const lo = Math.max(a, lowerBoundTimes(c.t, t - half));
        const hi = Math.min(b + 1, lowerBoundTimes(c.t, t + half + 1e-9));
        const yModel = dir * ((prefix[hi] - prefix[lo]) / (hi - lo) + (bestS * Math.sin(omega * t) + bestC * Math.cos(omega * t)) / 100);
        const yData = dir * c.smooth[k];
        if (yModel > runModel) runModel = yModel;
        if (yData > runData) runData = yData;
        if (runModel - yModel > backModel) backModel = runModel - yModel;
        if (runData - yData > backData) backData = runData - yData;
      }
      // (Both are measured along the glide's direction, so a falling siren's backslide is a rise.)
      if (backModel * 100 >= Math.max(VIBRATO_REVERSAL_MIN_CENTS, VIBRATO_REVERSAL_NOISE_FACTOR * noiseRms) && backData < VIBRATO_REVERSAL_KEEP * backModel) continue;
    }

    if (weight === null || model === null) {
      weight = new Float64Array(c.length);
      model = new Float64Array(c.length);
    }
    const centre = tA + winLen / 2;
    const omega = 2 * Math.PI * bestHz;
    for (let k = wa; k <= wb; k++) {
      const t = c.t[k];
      // Triangular cross-fade: neighbouring windows' weights sum to 1; the outermost windows keep full weight out to the interior's ends.
      let wg = 1;
      if (hop > 0 && !((w === 0 && t < centre) || (w === nWin - 1 && t > centre))) wg = Math.max(0, 1 - Math.abs(t - centre) / hop);
      weight[k] = Math.min(1, weight[k] + wg);
      model[k] += (wg * (bestS * Math.sin(omega * t) + bestC * Math.cos(omega * t))) / 100;
    }
  }
  return weight !== null && model !== null ? { weight, model } : null;
}

const EMPTY_CRACKS: CrackEvent[] = [];

/**
 * Measures one glide/slide target (`toMidi` is the arrival pitch). Shared by
 * analyzeGlide and the slide/fall inflections; see the module doc for the method.
 */
export function measureGlide(track: PitchTrack, glide: TargetNote): GlideMeasure {
  const from = glide.midi;
  const to = glide.toMidi ?? glide.midi;
  const spanCents = (to - from) * 100;
  const absSpan = Math.abs(spanCents);
  const dur = Math.max(0.001, glide.end - glide.start);
  const pad = Math.min(PAD_MAX_SEC, Math.max(PAD_MIN_SEC, dur * PAD_FRACTION));

  const win = frameRange(track, glide.start - pad, glide.end + pad);
  const c = voicedContour(track, win.lo, win.hi);
  const crackWin = frameRange(track, glide.start - 0.05, glide.end + 0.1);
  // A glide is one continuous phonation by construction, so a hole in the middle of it is a break however long it is (the voice
  // cutting out for half a second is worse than for 100 ms). Silence before the voice starts or after it stops is never a break.
  const cracks = crackWin.hi - crackWin.lo >= 2 ? detectCracks(track.slice(crackWin.lo, crackWin.hi), { maxDropoutMs: Infinity }) : EMPTY_CRACKS;

  const result: GlideMeasure = {
    durationMs: null,
    departT: null,
    arriveT: null,
    maxProgress: 0,
    travel: 0,
    startErrorCents: null,
    endErrorCents: null,
    monotonic: true,
    maxBackslideCents: 0,
    stairSteps: 0,
    smoothness: 0,
    cracks,
  };
  if (c.length === 0) return result;

  const startPitch = pitchAround(c, glide.start, EDGE_HALF_WINDOW_SEC, EDGE_FALLBACK_SEC);
  const endPitch = pitchAround(c, glide.end, EDGE_HALF_WINDOW_SEC, EDGE_FALLBACK_SEC);
  if (startPitch !== null) result.startErrorCents = (startPitch - from) * 100;
  if (endPitch !== null) result.endErrorCents = (endPitch - to) * 100;

  if (absSpan < MIN_GLIDE_CENTS) {
    // No interval to travel (a plain hold): nothing to be smooth or stepped about.
    result.maxProgress = 1;
    result.travel = 1;
    result.smoothness = 1;
    return result;
  }

  const n = c.length;
  const p = new Float64Array(n);
  let maxP = -Infinity;
  for (let k = 0; k < n; k++) {
    p[k] = (c.smooth[k] - from) / (to - from);
    if (p[k] > maxP) maxP = p[k];
  }
  result.maxProgress = maxP;
  // The peak that counts is a SUSTAINED one (two frames in a row), so a stray frame cannot set the level the glide is judged against.
  let kPeak = 0;
  let sustained = n > 1 ? Math.min(p[0], p[1]) : p[0];
  for (let k = 1; k + 1 < n; k++) {
    const v = Math.min(p[k], p[k + 1]);
    if (v > sustained) {
      sustained = v;
      kPeak = k;
    }
  }
  let pMin = p[0];
  for (let k = 1; k <= kPeak; k++) if (p[k] < pMin) pMin = p[k];
  result.travel = sustained - pMin;
  // Nothing moved (a note held at the start pitch, or at the END pitch the whole time): there is no glide, so no smoothness.
  if (result.travel < MIN_PEAK_PROGRESS) return result;

  // A glide that fell short is still a glide: measure it against the progress it actually reached (its own 10% and 90%),
  // so an undershooting siren still has a duration and a shape, and its shortfall shows in endErrorCents.
  const top = sustained >= ARRIVE_LEVEL ? 1 : sustained >= MIN_UNDERSHOOT_PEAK ? sustained : 0;
  const arriveLevel = ARRIVE_LEVEL * top;
  const departLevel = DEPART_LEVEL * top;

  // Arrival: first frame at >= the arrival level that is followed by another one (or is the last frame).
  let kArr = -1;
  if (top > 0) {
    for (let k = 0; k < n; k++) {
      if (p[k] >= arriveLevel && (k === n - 1 || p[k + 1] >= arriveLevel)) {
        kArr = k;
        break;
      }
    }
  }
  const kEnd = kArr >= 0 ? kArr : kPeak;

  // Departure: the last frame at or below the departure level before arriving; progress crosses it just after.
  let kDep = -1;
  for (let k = kEnd; k >= 0; k--) {
    if (p[k] <= (top > 0 ? departLevel : DEPART_LEVEL)) {
      kDep = k;
      break;
    }
  }
  const kStart = kDep >= 0 ? kDep + 1 : 0;

  if (kArr >= 0) {
    const tB = crossingTime(c, p, kArr, arriveLevel);
    let t1 = NaN;
    let p1 = NaN;
    if (kDep >= 0 && kDep + 1 < n) {
      t1 = crossingTime(c, p, kDep + 1, departLevel);
      p1 = departLevel;
    } else if (kDep < 0 && p[0] > departLevel && p[0] <= LATE_START_MAX_PROGRESS * top) {
      // Voicing began a little way into the glide: extrapolate linearly from the first frame.
      t1 = c.t[0];
      p1 = p[0];
    }
    if (Number.isFinite(t1) && tB > t1) {
      const full = (tB - t1) / (arriveLevel - p1);
      result.durationMs = full * 1000;
      result.departT = t1 - p1 * full;
      result.arriveT = result.departT + full;
    }
  }

  const dt = medianSpacing(c.t);
  const frameSec = Number.isFinite(dt) ? dt : 0;
  const interiorSec = kEnd >= kStart ? c.t[kEnd] - c.t[kStart] + frameSec : 0;
  const floorMs = CONFIG.transitions.portamentoFloorMs;
  if (kEnd - kStart + 1 < 3 || (result.durationMs !== null && result.durationMs < floorMs)) {
    // Too brief to perceive as a slide: a clean step. For a short move that is all there is to assess (smooth); but where a
    // long glide was asked for (a siren, a slide) a jump is the opposite of one.
    result.smoothness = dur * 1000 >= REQUESTED_GLIDE_MIN_FACTOR * floorMs ? 0 : 1;
    return result;
  }

  // Frame-to-frame scatter of the contour (raw vs median-of-3): both a roughness cost and the noise floor for "flat".
  let sumSq = 0;
  for (let k = kStart; k <= kEnd; k++) {
    const d = (c.midi[k] - c.smooth[k]) * 100;
    sumSq += d * d;
  }
  const rms = Math.sqrt(sumSq / (kEnd - kStart + 1));
  const rough = Math.min(1, Math.max(0, (rms - ROUGHNESS_FLOOR_CENTS) / ROUGHNESS_SCALE_CENTS));

  // Where vibrato explains the contour: its oscillation is neither a reversal nor a stair, so reversals are measured without it ...
  const vibrato = explainVibrato(c, kStart, kEnd, rms, to > from ? 1 : -1);

  // Reversals: drops from the best progress so far, beyond the backslide tolerance.
  const backslideTol = Math.max(BACKSLIDE_MIN_CENTS, BACKSLIDE_FRACTION * absSpan);
  const progress = (k: number): number => (vibrato === null ? p[k] : p[k] - vibrato.model[k] / (to - from));
  let best = progress(kStart);
  let reversals = 0;
  let reversalSec = 0;
  let inReversal = false;
  let maxBackslide = 0;
  for (let k = kStart; k <= kEnd; k++) {
    const pk = progress(k);
    if (pk > best) best = pk;
    const slide = (best - pk) * absSpan;
    if (slide > maxBackslide) maxBackslide = slide;
    if (slide >= backslideTol) {
      if (!inReversal) {
        reversals++;
        inReversal = true;
      }
      reversalSec += k + 1 <= kEnd ? c.t[k + 1] - c.t[k] : frameSec;
    } else {
      inReversal = false;
    }
  }
  result.maxBackslideCents = maxBackslide;
  result.monotonic = maxBackslide < backslideTol;

  // Stair steps: flat (within the noise floor), much slower than the glide's mean speed, and stalled ON THE WAY; and not a vibrato's stall.
  const meanSpeed = result.durationMs !== null ? (absSpan * 1000) / result.durationMs : absSpan / dur; // cents per second
  const minPlateauSec = CONFIG.transitions.stairPlateauMs / 1000;
  const vibratoCover = (k1: number, k2: number): number => {
    if (vibrato === null) return 0;
    let s = 0;
    for (let k = k1; k <= k2; k++) s += vibrato.weight[k];
    return s / (k2 - k1 + 1);
  };
  const rangeCap = Math.max(PLATEAU_MAX_RANGE_CENTS, PLATEAU_NOISE_FACTOR * rms);
  const dirSign = to > from ? 1 : -1;
  const approachOk = (k1: number, k2: number, level: number): boolean => {
    let kb = k1 - 1;
    while (kb >= 0 && c.t[k1] - c.t[kb] <= APPROACH_SEC) kb--;
    if (k1 - 1 - kb >= 2 && dirSign * (level - medianRange(c.smooth, kb + 1, k1)) * 100 < PLATEAU_MIN_APPROACH_CENTS) return false;
    let ka = k2 + 1;
    while (ka < n && c.t[ka] - c.t[k2] <= APPROACH_SEC) ka++;
    if (ka - (k2 + 1) >= 2 && dirSign * (medianRange(c.smooth, k2 + 1, ka) - level) * 100 < PLATEAU_MIN_APPROACH_CENTS) return false;
    return true;
  };
  let stairs = 0;
  let stairSec = 0;
  let lastEnd = -10;
  let lastLevel = 0;
  let k1 = kStart;
  while (k1 <= kEnd) {
    let mn = c.smooth[k1];
    let mx = mn;
    let k2 = k1;
    while (k2 + 1 <= kEnd) {
      const v = c.smooth[k2 + 1];
      const nmn = v < mn ? v : mn;
      const nmx = v > mx ? v : mx;
      if ((nmx - nmn) * 100 > rangeCap) break;
      mn = nmn;
      mx = nmx;
      k2++;
    }
    const sec = c.t[k2] - c.t[k1] + frameSec;
    if (sec >= minPlateauSec) {
      const level = medianRange(c.smooth, k1, k2 + 1);
      const frames = k2 - k1 + 1;
      const slopeSe = frameSec > 0 && frames > 2 ? rms / (frameSec * Math.sqrt((frames * (frames * frames - 1)) / 12)) : Infinity;
      const slow =
        slopeSe <= PLATEAU_MAX_SLOPE_SE_RATIO * meanSpeed && Math.abs(fitSlopeCentsPerSec(c.t, c.smooth, k1, k2 + 1)) <= PLATEAU_SPEED_RATIO * meanSpeed;
      if (slow && approachOk(k1, k2, level) && vibratoCover(k1, k2) < VIBRATO_GATE) {
        // A long flat stretch can break into two windows on a noisy contour: one stair, not two.
        if (!(k1 <= lastEnd + 2 && Math.abs(level - lastLevel) * 100 <= rangeCap)) stairs++;
        stairSec += sec;
        lastEnd = k2;
        lastLevel = level;
        k1 = k2 + 1;
        continue;
      }
    }
    k1++;
  }
  result.stairSteps = stairs;

  // Smoothness: stalls and reversals, then frame-to-frame scatter.
  const share = interiorSec > 0 ? Math.min(1, (stairSec + reversalSec) / interiorSec) : 0;
  result.smoothness = Math.exp(-(SMOOTHNESS_PER_EVENT * (stairs + reversals) + SMOOTHNESS_PER_SHARE * share)) * Math.exp(-ROUGHNESS_WEIGHT * rough);
  return result;
}

/** analyzeGlide(track, glide, ctx) - one glide/slide TargetNote (`toMidi` is the arrival pitch). The tolerance does not enter: glide quality is judged on shape, endpoints on cents. */
export const analyzeGlide: AnalyzeGlide = (track, glide, _ctx): GlideResult => {
  const m = measureGlide(track, glide);
  return {
    durationMs: m.durationMs,
    startErrorCents: m.startErrorCents,
    endErrorCents: m.endErrorCents,
    monotonic: m.monotonic,
    stairSteps: m.stairSteps,
    smoothness: m.smoothness,
    cracks: m.cracks,
  };
};
