/**
 * Inflection scoring (SPEC 8.4 / 9.3): scoop, fall, slide, turn, flip. Each is scored
 * against the REQUESTED shape, not merely detected: docs/RESEARCH.md 6 is explicit that
 * "intentional vs error" cannot be certified from audio, so the exercise says what it
 * wants and this module reports how close the take came, and says so when it cannot tell.
 * Scores are 0..1 (1 = the requested shape); `notes` carries short, plain observations.
 *
 * TARGETS (what src/exercises/plan.ts passes; the optional extras are used when present):
 *   scoop: [glide from the start-below pitch to the landing pitch]: start = when the singer should
 *          begin, end = the requested arrival. Optional: the hold on the landing note after it.
 *   fall:  [the held note]: the release is expected from its end. Optional: the fall glide after it
 *          (held pitch -> where the fall should reach), which sets the requested drop and duration.
 *   slide: [glide from the start pitch to the end pitch]: end = the requested arrival. Optional:
 *          the holds before and after it (the hold after is where the landing is measured).
 *   turn:  [main note spanning the whole figure, one neighbour note inside it], once per excursion;
 *          or the full figure as a sequence [main, neighbour, main, other neighbour, main, ...].
 *   flip:  [low note, high note].
 * The glide is found as "the target with toMidi", so reordered or trimmed groups still work. `track`
 * may be the whole take: each kind looks only at its own window.
 *
 * `landingAbsCents` is the MEDIAN of the absolute cents error over the landing note's held
 * part (the first CONFIG.accuracy.holdStartSkipMs after the move are skipped).
 *
 * Shapes and thresholds below are PROVISIONAL local stand-ins for CONFIG entries that do not
 * exist yet (see contractIssues); tune them on the real-voice corpus. Signed values are
 * direction-normalised where it matters (a negative slide size always means "fell short").
 */
import type { PitchTrack, TargetNote } from '../core/types';
import type { AnalyzeContext, AnalyzeInflection, InflectionResult } from './types';
import { CONFIG } from '../config';
import { clamp01 } from '../core/math';
import { measureGlide } from './glide';
import { alignedNoteStats } from './runs';
import { analyzeTransitions } from './transitions';
import { CONTIGUOUS_GAP_FRAMES, voicedContour, type Contour } from './segment';
import { frameRange, lowerBound, lowerBoundTimes, medianRange, medianSpacing } from './track';

type Body = Omit<InflectionResult, 'kind'>;

// ---------------------------------------------------------------- tuning (PROVISIONAL)
/** A band narrower than this makes "arrived" meaningless on a real voice, whatever the level's tolerance. */
const MIN_BAND_CENTS = 20;
/** A landing's accuracy score falls linearly from 1 at 0 cents to 0 at this many tolerances of median error (as in runs.ts and phrases.ts). */
const LANDING_ZERO_TOLERANCES = 2.5;
/** Scoop: how early the singer may start before the requested start, and the least depth that counts as a scoop at all. */
const SCOOP_EARLY_SEC = 0.25;
const SCOOP_MIN_DEPTH_CENTS = 30;
const SCOOP_MIN_DEPTH_FRACTION = 0.25;
/** Fall: least drop that counts as a fall; how far below the hold the pitch must go to call the release; level the release is measured from; RMS fall that counts as "dying away". */
const FALL_MIN_CENTS = 100;
const FALL_MIN_FRACTION = 0.35;
const FALL_RELEASE_START_CENTS = 15;
const FALL_RMS_DROP_DB = 3;
/** Fall: a gap this long ends the fall (voicing lost), a rise this far off the running minimum ends it (pitch bounced back). */
const FALL_GAP_SEC = 0.12;
const FALL_BOUNCE_CENTS = 150;
/** Fall: sag in the hold before the release beyond this is flagged and costs score. */
const FALL_SAG_FREE_CENTS = 15;
const FALL_SAG_ZERO_CENTS = 75;
/** Slide: it counts as travelled once the contour reached this much of the interval. */
const SLIDE_MIN_PROGRESS = 0.6;
/** A move shorter than this is a step, not a slide (scoops and slides); a slide this far from the requested length is not the requested shape. */
const MIN_SLIDE_MS = 40;
const SLIDE_MIN_LENGTH_RATIO = 0.35;
const SLIDE_MAX_LENGTH_RATIO = 2.5;
/** Fall: a drop completed faster than this is a step down, not a fall. The bottom is the first frame within this of the final level. */
const FALL_MIN_MS = 60;
const FALL_BOTTOM_CENTS = 20;
/** Fall: the voice "holds" the bottom note while it stays within this of the level it settled at. */
const FALL_LANDING_HOLD_CENTS = 40;
/** Flip: an abrupt jump takes at most this long; a slide of this long or more is not a flip. */
const FLIP_ABRUPT_MS = 80;
const FLIP_SLOW_MS = 300;
/** Turn: a note this far from the main pitch is a neighbour; note changes within this of their slot are on time. */
const TURN_NEIGHBOUR_MIN_CENTS = 50;
const TURN_TIMING_FREE_MS = 25;

/** Weights of the pieces of each kind's 0..1 score (each row sums to 1). */
const WEIGHTS = {
  scoop: { depth: 0.35, timing: 0.3, landing: 0.35 },
  fall: { drop: 0.35, length: 0.25, fade: 0.15, smooth: 0.1, steady: 0.15 },
  slide: { length: 0.2, arrival: 0.2, smooth: 0.25, landing: 0.35 },
  turn: { neighbour: 0.4, reached: 0.2, landing: 0.2, timing: 0.2 },
  flip: { abrupt: 0.3, size: 0.3, landing: 0.4 },
} as const;

/**
 * Ceiling on the score of a figure that was not done at all (no scoop, no fall, a slide that never travelled or took nothing like the time asked,
 * a neighbour never reached, a turn that never came back, no flip). It sits below the LOWEST inflection.score gate the catalog sets, the easy
 * tier's 0.27, so such a figure fails the shape gate at every tier whatever else was right (a plain note can score landing and smoothness on
 * its own), and it pulls a take of several figures well down (combineInflectionScores). The old ceilings of 0.40-0.45 were above that gate.
 */
const NOT_DONE_CAP = 0.2;
const CAPS = {
  scoopNoScoop: NOT_DONE_CAP,
  scoopNeverArrived: NOT_DONE_CAP,
  fallNoFall: NOT_DONE_CAP,
  slideNeverTravelled: NOT_DONE_CAP,
  slideWrongLength: NOT_DONE_CAP,
  turnMissingNeighbour: NOT_DONE_CAP,
  turnNoReturn: NOT_DONE_CAP,
  flipNoFlip: NOT_DONE_CAP,
} as const;

/** A slide with a break inside loses this share of its score per break, up to MAX_BREAKS_COUNTED of them. */
const SLIDE_BREAK_PENALTY = 0.15;
const MAX_BREAKS_COUNTED = 2;

/** How big an error may grow before a piece of a score reaches 0: an absolute floor and a fraction of the size that was asked for. */
const SCALE = {
  scoopDepth: { minCents: 60, fraction: 0.8 },
  scoopArrival: { minSec: 0.12, fraction: 0.75 },
  /** Fall: with no requested drop, a drop of this many cents earns full marks. */
  fallDropUnknownCents: 300,
  fallLength: { minMs: 150 },
  /** Fall: bounce back up this far is a ragged fall (zero smoothness), and past BOUNCE_NOTE_CENTS it is mentioned. */
  fallBounceZeroCents: 120,
  fallBounceNoteCents: 60,
  slideLength: { minMs: 100, fraction: 0.8 },
  slideArrival: { minSec: 0.12, fraction: 0.6 },
  turnNeighbour: { minCents: 60, fraction: 0.5 },
  /** Turn: a neighbour this far from what was asked (floor / fraction of the asked size) earns a note. */
  turnNeighbourNote: { minCents: 40, fraction: 0.3 },
  flipSize: { minCents: 100, fraction: 0.4 },
} as const;

/** Notes: mentioned when a scoop is this far (fraction) from the requested depth; a slide this far (fraction) from the requested length. */
const NOTE_SCOOP_DEPTH_FRACTION = 0.4;
const NOTE_SLIDE_LENGTH_FRACTION = 0.35;
/** Flip: a jump smaller than this fraction of the requested interval is no flip; a detector confidence below this at the break is worth a remark. */
const FLIP_MIN_JUMP_FRACTION = 0.5;
const FLIP_CONFIDENCE_DIP = 0.85;

function none(note: string): Body {
  return { detected: false, sizeCents: null, timeMs: null, landingAbsCents: null, score: 0, notes: [note] };
}

/** Share of the worst figure in a take's inflection score (the rest is the mean of all the figures). */
const WORST_FIGURE_WEIGHT = 0.5;

/**
 * The take-level inflection score from the scores of its figures (one analyzeInflection(...).score per figure): half the mean, half the worst.
 * A plain mean lets a figure that was never sung hide behind several that were: a Boss Recital whose timed slide was skipped (turn, turn,
 * slide, flip = 1.0, 1.0, 0.2, 0.98) averaged 0.80, comfortably over the 0.57 studio gate. Half the worst keeps such a take at 0.50, under it,
 * unless every figure was done, and leaves a take with one figure (or all alike) exactly at that figure's score. Non-finite scores are ignored;
 * NaN when there are none (callers drop the metric then, as for any measure that could not be made).
 *
 * The aggregation itself lives in score.ts (`metricsFromResults`), which is the one place a take's results become metrics; it should call this.
 */
export function combineInflectionScores(scores: readonly number[]): number {
  let sum = 0;
  let worst = Infinity;
  let n = 0;
  for (const s of scores) {
    if (!Number.isFinite(s)) continue;
    sum += s;
    if (s < worst) worst = s;
    n++;
  }
  if (n === 0) return NaN;
  return clamp01((1 - WORST_FIGURE_WEIGHT) * (sum / n) + WORST_FIGURE_WEIGHT * worst);
}

/** Contour element index range [a, b) with t0 <= t < t1. */
function elems(c: Contour, t0: number, t1: number): { a: number; b: number } {
  const a = lowerBoundTimes(c.t, t0);
  return { a, b: Math.max(a, lowerBoundTimes(c.t, t1)) };
}

/** Median of |smooth - target| (cents) over contour elements [a, b); null if empty. */
function medianAbsError(c: Contour, a: number, b: number, target: number): number | null {
  if (b <= a) return null;
  const d = new Float64Array(b - a);
  for (let k = a; k < b; k++) d[k - a] = Math.abs(c.smooth[k] - target) * 100;
  return medianRange(d, 0, d.length);
}

/** First element >= `from` that starts a contiguous run inside `center` +/- `bandCents` lasting `holdSec`; -1 if none. */
function firstSettle(c: Contour, from: number, center: number, bandCents: number, holdSec: number, dt: number): number {
  for (let k = from; k < c.length; k++) {
    if (Math.abs(c.smooth[k] - center) * 100 > bandCents) continue;
    let e = k;
    while (e + 1 < c.length && c.t[e + 1] - c.t[e] <= CONTIGUOUS_GAP_FRAMES * dt && Math.abs(c.smooth[e + 1] - center) * 100 <= bandCents) e++;
    if (c.t[e] - c.t[k] + dt >= holdSec) return k;
    k = e;
  }
  return -1;
}

function frameSec(c: Contour): number {
  const d = medianSpacing(c.t);
  return Number.isFinite(d) && d > 0 ? d : 512 / 48000;
}

function ms(x: number): string {
  return `${Math.round(x)} ms`;
}
function cents(x: number): string {
  return `${Math.round(x)}c`;
}

// ---------------------------------------------------------------- scoop
function scoop(track: PitchTrack, targets: readonly TargetNote[], ctx: AnalyzeContext): Body {
  const gi = targets.findIndex((t) => t.toMidi !== undefined && Math.abs(t.toMidi - t.midi) >= 0.5);
  let below: number;
  let landing: number;
  let reqStart: number;
  let reqArrive: number;
  let hold: TargetNote | null;
  if (gi >= 0) {
    const g = targets[gi];
    below = g.midi;
    landing = g.toMidi as number;
    reqStart = g.start;
    reqArrive = g.end;
    hold = targets[gi + 1] ?? null;
  } else if (targets.length >= 2) {
    below = targets[0].midi;
    landing = targets[1].midi;
    reqStart = targets[0].start;
    reqArrive = targets[0].end;
    hold = targets[1];
  } else {
    return none('A scoop needs a start-below note and a landing note.');
  }
  const dir = landing >= below ? 1 : -1;
  const reqDepth = Math.abs(landing - below) * 100;
  const holdEnd = hold ? hold.end : reqArrive + 0.6;
  const win = frameRange(track, reqStart - SCOOP_EARLY_SEC, holdEnd + 0.05);
  const c = voicedContour(track, win.lo, win.hi);
  if (c.length < 3) return none('No voiced audio in the scoop window.');
  const dt = frameSec(c);
  const band = Math.max(ctx.toleranceCents, MIN_BAND_CENTS);

  const holdSec = Math.min(CONFIG.onset.settleHoldMs / 1000, hold ? 0.5 * (hold.end - hold.start) : Infinity);
  const kArr = firstSettle(c, 0, landing, band, holdSec, dt);

  // Depth: how far below (above, for a downward scoop) the landing pitch the voice started.
  const kEnd = kArr >= 0 ? kArr : Math.min(c.length - 1, elems(c, c.t[0], c.t[0] + 0.5).b);
  let extreme = c.smooth[0];
  for (let k = 0; k <= kEnd; k++) if (dir * c.smooth[k] < dir * extreme) extreme = c.smooth[k];
  const depth = Math.max(0, dir * (landing - extreme) * 100);

  // Landing accuracy: the held part of the landing note.
  let landingAbs: number | null = null;
  if (hold) {
    const r = elems(c, hold.start + CONFIG.accuracy.holdStartSkipMs / 1000, hold.end);
    landingAbs = medianAbsError(c, r.a, r.b, landing);
  } else if (kArr >= 0) {
    const r = elems(c, c.t[kArr] + 0.1, c.t[kArr] + 0.5);
    landingAbs = medianAbsError(c, r.a, r.b, landing);
  }

  // Arrival is when the scoop ENDED (the glide's linear-equivalent end), not when it first entered the band: a perfect linear scoop
  // is inside +/-tolerance a good while before it finishes.
  const move = measureGlide(track, { midi: below, toMidi: landing, start: reqStart, end: reqArrive });
  const arriveT = move.arriveT ?? (kArr >= 0 ? c.t[kArr] : null);
  const timeMs = arriveT === null ? null : (arriveT - reqStart) * 1000;
  const stepped = move.durationMs !== null && move.durationMs < MIN_SLIDE_MS; // jumped up from the lower note: an interval, not a scoop
  const detected = depth >= Math.max(SCOOP_MIN_DEPTH_CENTS, SCOOP_MIN_DEPTH_FRACTION * reqDepth) && !stepped;

  const depthScore = clamp01(1 - Math.abs(depth - reqDepth) / Math.max(SCALE.scoopDepth.minCents, SCALE.scoopDepth.fraction * reqDepth));
  const timingScale = Math.max(SCALE.scoopArrival.minSec, SCALE.scoopArrival.fraction * (reqArrive - reqStart));
  const timingScore = arriveT === null ? 0 : clamp01(1 - Math.abs(arriveT - reqArrive) / timingScale);
  const landingScore = landingAbs === null ? 0 : clamp01(1 - landingAbs / (LANDING_ZERO_TOLERANCES * Math.max(ctx.toleranceCents, 1)));
  const w = WEIGHTS.scoop;
  let score = w.depth * depthScore + w.timing * timingScore + w.landing * landingScore;
  if (!detected) score = Math.min(score, CAPS.scoopNoScoop);
  if (arriveT === null) score = Math.min(score, CAPS.scoopNeverArrived);

  const notes: string[] = [];
  if (stepped) notes.push('The note was reached by a step from below, not by sliding up into it.');
  else if (!detected) notes.push(`No scoop found: the note started within ${cents(depth)} of the pitch (asked for about ${cents(reqDepth)} below).`);
  else if (Math.abs(depth - reqDepth) > NOTE_SCOOP_DEPTH_FRACTION * reqDepth) notes.push(`Scoop was ${cents(depth)} (asked for about ${cents(reqDepth)}).`);
  if (arriveT === null) notes.push('Never settled on the landing pitch.');
  else if (Math.abs(arriveT - reqArrive) > 0.08) notes.push(`Arrived ${ms(Math.abs(arriveT - reqArrive) * 1000)} ${arriveT > reqArrive ? 'late' : 'early'}.`);
  return { detected, sizeCents: depth, timeMs, landingAbsCents: landingAbs, score, notes };
}

// ---------------------------------------------------------------- fall
function fall(track: PitchTrack, targets: readonly TargetNote[], ctx: AnalyzeContext): Body {
  let fi = targets.findIndex((t) => t.toMidi !== undefined && t.toMidi < t.midi);
  let hold: TargetNote | null;
  let reqDrop: number | null;
  let reqSec: number | null;
  let landingMidi: number | null;
  let tFallStart: number;
  if (fi >= 0) {
    const f = targets[fi];
    hold = fi > 0 ? targets[fi - 1] : null;
    reqDrop = (f.midi - (f.toMidi as number)) * 100;
    reqSec = f.end - f.start;
    landingMidi = f.toMidi as number;
    tFallStart = f.start;
  } else if (targets.length >= 2) {
    fi = 1;
    hold = targets[0];
    reqDrop = (targets[0].midi - targets[1].midi) * 100;
    reqSec = targets[1].end - targets[1].start;
    landingMidi = targets[1].midi;
    tFallStart = targets[1].start;
  } else if (targets.length === 1) {
    hold = targets[0];
    reqDrop = null;
    reqSec = null;
    landingMidi = null;
    tFallStart = targets[0].end;
  } else {
    return none('A fall needs a held note and the fall.');
  }
  const holdStart = hold ? hold.start : tFallStart - 1;
  const holdEnd = hold ? hold.end : tFallStart;
  const tail = (reqSec ?? 1) + 0.5;
  const win = frameRange(track, holdStart - 0.1, tFallStart + tail);
  const c = voicedContour(track, win.lo, win.hi);
  if (c.length < 5) return none('No voiced audio in the fall window.');
  const dt = frameSec(c);
  const band = Math.max(ctx.toleranceCents, 25);

  // The level the voice held: the steady first part of the hold.
  const skip = CONFIG.accuracy.holdStartSkipMs / 1000;
  let r = elems(c, holdStart + skip, holdStart + skip + Math.max(0.2, 0.6 * (holdEnd - holdStart) - skip));
  if (r.b - r.a < 3) r = elems(c, holdStart, holdEnd);
  if (r.b - r.a < 3) return none('No steady hold to fall from.');
  const holdLevel = medianRange(c.smooth, r.a, r.b);

  // The release: first sustained drop below the hold level, then back to the last frame still at the level.
  let kBelow = -1;
  for (let k = r.b; k + 1 < c.length; k++) {
    if ((holdLevel - c.smooth[k]) * 100 > band && (holdLevel - c.smooth[k + 1]) * 100 > band) {
      kBelow = k;
      break;
    }
  }
  if (kBelow < 0) return none('The pitch never fell below the held note.');
  let kRel = kBelow;
  while (kRel > 0 && (holdLevel - c.smooth[kRel - 1]) * 100 > FALL_RELEASE_START_CENTS) kRel--;
  if (kRel > 0) kRel--; // the last frame still on the level

  // The fall ends where voicing is lost or the pitch bounces back off its minimum.
  let runLow = kBelow;
  let kStop = kBelow;
  for (let k = kBelow; k < c.length; k++) {
    if (k > kBelow && c.t[k] - c.t[k - 1] > FALL_GAP_SEC) break;
    if ((c.smooth[k] - c.smooth[runLow]) * 100 > FALL_BOUNCE_CENTS) break;
    if (c.smooth[k] < c.smooth[runLow]) runLow = k;
    kStop = k;
  }
  let bounce = 0;
  let runMin = c.smooth[kBelow];
  for (let k = kBelow; k <= kStop; k++) {
    if (c.smooth[k] < runMin) runMin = c.smooth[k];
    bounce = Math.max(bounce, (c.smooth[k] - runMin) * 100);
  }

  // The bottom: the level the fall settled at (10th percentile, so scatter on a long low note does not set it), and the first
  // frame that got there. The fall's length is the time to GET there, however long the voice then stayed.
  const tailLevels = new Float64Array(kStop - kBelow + 1);
  for (let k = kBelow; k <= kStop; k++) tailLevels[k - kBelow] = c.smooth[k];
  tailLevels.sort();
  const lowLevel = tailLevels[Math.floor(0.1 * (tailLevels.length - 1))];
  let kMin = kStop;
  for (let k = kBelow; k <= kStop; k++) {
    if ((c.smooth[k] - lowLevel) * 100 <= FALL_BOTTOM_CENTS) {
      kMin = k;
      break;
    }
  }

  const dropped = (holdLevel - lowLevel) * 100;
  const durationMs = (c.t[kMin] - c.t[kRel]) * 1000;
  const rmsFrom = elems(c, c.t[kRel] - 0.1, c.t[kRel] + 1e-9);
  const rmsStart = rmsFrom.b > rmsFrom.a ? medianRange(c.rmsDb, rmsFrom.a, rmsFrom.b) : c.rmsDb[kRel];
  const rmsEnd = medianRange(c.rmsDb, Math.max(kRel, kMin - 2), kMin + 1);
  const rmsDrop = rmsStart - rmsEnd;

  // Sag: how far the hold had already drooped just before the fall was due (a drop that starts early is part of the release above).
  const pre = elems(c, tFallStart - 0.2, tFallStart - 0.03);
  const sag = pre.b - pre.a >= 3 ? Math.max(0, (holdLevel - medianRange(c.smooth, pre.a, pre.b)) * 100) : 0;

  // A fall to a real pitch (not to silence) can report how well it landed.
  let landingAbs: number | null = null;
  if (landingMidi !== null) {
    let kk = kMin;
    while (kk + 1 < c.length && c.t[kk + 1] - c.t[kk] <= CONTIGUOUS_GAP_FRAMES * dt && Math.abs(c.smooth[kk + 1] - lowLevel) * 100 <= FALL_LANDING_HOLD_CENTS) kk++;
    if (c.t[kk] - c.t[kMin] + dt >= 0.1) landingAbs = medianAbsError(c, kMin, kk + 1, landingMidi);
  }

  const stepped = durationMs < FALL_MIN_MS; // dropped in one step: not a fall
  const detected = dropped >= Math.max(FALL_MIN_CENTS, FALL_MIN_FRACTION * (reqDrop ?? 0)) && !stepped;
  const dropScore = reqDrop !== null ? clamp01(dropped / reqDrop) : clamp01(dropped / SCALE.fallDropUnknownCents);
  const durScore = reqSec !== null ? clamp01(1 - Math.abs(durationMs - reqSec * 1000) / Math.max(SCALE.fallLength.minMs, reqSec * 1000)) : 1;
  const rmsScore = clamp01(rmsDrop / FALL_RMS_DROP_DB);
  const smoothScore = clamp01(1 - bounce / SCALE.fallBounceZeroCents);
  const sagScore = clamp01(1 - Math.max(0, sag - FALL_SAG_FREE_CENTS) / (FALL_SAG_ZERO_CENTS - FALL_SAG_FREE_CENTS));
  const w = WEIGHTS.fall;
  let score = w.drop * dropScore + w.length * durScore + w.fade * rmsScore + w.smooth * smoothScore + w.steady * sagScore;
  if (!detected) score = Math.min(score, CAPS.fallNoFall);

  const notes: string[] = [];
  if (stepped && dropped >= FALL_MIN_CENTS) notes.push('The pitch dropped in one step; a fall is a smooth glide down.');
  else if (!detected) notes.push(`The fall was only ${cents(dropped)} (asked for about ${cents(reqDrop ?? FALL_MIN_CENTS)}).`);
  if (rmsDrop < FALL_RMS_DROP_DB) notes.push('The level did not clearly die away: this may be a pitch drop rather than a sung fall-off.');
  if (sag > FALL_SAG_FREE_CENTS) notes.push(`The pitch had sagged ${cents(sag)} before the fall was due.`);
  if (bounce > SCALE.fallBounceNoteCents) notes.push('The fall was not one smooth descent.');
  return { detected, sizeCents: dropped, timeMs: durationMs, landingAbsCents: landingAbs, score, notes };
}

// ---------------------------------------------------------------- slide
function slide(track: PitchTrack, targets: readonly TargetNote[], ctx: AnalyzeContext): Body {
  const gi = targets.findIndex((t) => t.toMidi !== undefined && Math.abs(t.toMidi - t.midi) >= 0.5);
  if (gi < 0) return none('A slide needs a glide target between two notes.');
  const g = targets[gi];
  const to = g.toMidi as number;
  const dir = to > g.midi ? 1 : -1;
  const holdB = targets[gi + 1] !== undefined && targets[gi + 1].toMidi === undefined ? targets[gi + 1] : null;
  const m = measureGlide(track, g);
  const reqSec = Math.max(0.001, g.end - g.start);

  // Where the voice ended up: the landing hold if there is one, else just after the requested end.
  const win = frameRange(track, g.start - 0.3, (holdB ? holdB.end : g.end + 0.3) + 0.05);
  const c = voicedContour(track, win.lo, win.hi);
  const r = holdB ? elems(c, holdB.start + CONFIG.accuracy.holdStartSkipMs / 1000, holdB.end) : elems(c, g.end - 0.05, g.end + 0.3);
  const landingAbs = medianAbsError(c, r.a, r.b, to);
  const landingSigned = r.b > r.a ? (medianRange(c.smooth, r.a, r.b) - to) * 100 : null;

  const stepped = m.durationMs !== null && m.durationMs < MIN_SLIDE_MS;
  const travelled = m.travel >= SLIDE_MIN_PROGRESS && !stepped;
  const ratio = m.durationMs === null ? null : m.durationMs / (reqSec * 1000);
  const sizeCents = landingSigned !== null && m.startErrorCents !== null ? dir * (landingSigned - m.startErrorCents) : null;
  const durationScore =
    m.durationMs === null ? 0 : clamp01(1 - Math.abs(m.durationMs - reqSec * 1000) / Math.max(SCALE.slideLength.minMs, SCALE.slideLength.fraction * reqSec * 1000));
  const arriveScore = m.arriveT === null ? 0 : clamp01(1 - Math.abs(m.arriveT - g.end) / Math.max(SCALE.slideArrival.minSec, SCALE.slideArrival.fraction * reqSec));
  const landingScore = landingAbs === null ? 0 : clamp01(1 - landingAbs / (LANDING_ZERO_TOLERANCES * Math.max(ctx.toleranceCents, 1)));
  const w = WEIGHTS.slide;
  let score = w.length * durationScore + w.arrival * arriveScore + w.smooth * m.smoothness + w.landing * landingScore;
  if (m.cracks.length > 0) score *= 1 - SLIDE_BREAK_PENALTY * Math.min(MAX_BREAKS_COUNTED, m.cracks.length);
  if (!travelled) score = Math.min(score, CAPS.slideNeverTravelled);
  else if (ratio !== null && (ratio < SLIDE_MIN_LENGTH_RATIO || ratio > SLIDE_MAX_LENGTH_RATIO)) score = Math.min(score, CAPS.slideWrongLength); // not the requested length at all

  const notes: string[] = [];
  if (stepped) notes.push('The pitch jumped to the end note; a slide is a continuous glide.');
  else if (!travelled) notes.push(`The pitch only travelled ${Math.round(Math.max(0, m.travel) * 100)}% of the way to the end note.`);
  if (m.durationMs !== null && Math.abs(m.durationMs - reqSec * 1000) > NOTE_SLIDE_LENGTH_FRACTION * reqSec * 1000) {
    notes.push(`The slide took about ${ms(m.durationMs)} (asked for ${ms(reqSec * 1000)}).`);
  }
  if (m.arriveT !== null && Math.abs(m.arriveT - g.end) > 0.15) notes.push(`Arrived about ${ms(Math.abs(m.arriveT - g.end) * 1000)} ${m.arriveT > g.end ? 'late' : 'early'}.`);
  if (m.stairSteps > 0) notes.push(`The slide moved in ${m.stairSteps} step${m.stairSteps > 1 ? 's' : ''}; make it one continuous ramp.`);
  if (m.cracks.length > 0) notes.push('A break was detected inside the slide.');
  return { detected: travelled, sizeCents, timeMs: m.durationMs, landingAbsCents: landingAbs, score, notes };
}

// ---------------------------------------------------------------- turn
/** The figure as a note sequence: the full sequence as given, or main + one neighbour expanded to [main before, neighbour, main after]. */
function turnSequence(targets: readonly TargetNote[]): TargetNote[] | null {
  if (targets.length >= 3) return targets.slice();
  if (targets.length !== 2) return null;
  const [main, nb] = targets;
  if (nb.start < main.start - 1e-6 || nb.end > main.end + 1e-6) return null;
  const u = nb.end - nb.start;
  const seq: TargetNote[] = [];
  if (nb.start - Math.max(main.start, nb.start - u) >= 0.04) seq.push({ midi: main.midi, start: Math.max(main.start, nb.start - u), end: nb.start });
  seq.push(nb);
  if (Math.min(main.end, nb.end + u) - nb.end >= 0.04) seq.push({ midi: main.midi, start: nb.end, end: Math.min(main.end, nb.end + u) });
  return seq.length >= 2 ? seq : null;
}

function turn(track: PitchTrack, targets: readonly TargetNote[]): Body {
  const seq = turnSequence(targets);
  if (seq === null) return none('A turn needs the main note and a neighbour note inside it (or the full main, neighbour, main sequence).');
  const mainMidi = targets[0].midi;
  const first = seq[0];
  const last = seq[seq.length - 1];
  const lo = lowerBound(track, first.start - 0.3);
  const hi = lowerBound(track, last.end + 0.3);
  const stats = alignedNoteStats(track.slice(lo, hi), seq, CONFIG.runs.dtwBandMs);
  const minReached = CONFIG.runs.reachedMinMs;
  const isNeighbour = seq.map((t) => Math.abs(t.midi - mainMidi) * 100 >= TURN_NEIGHBOUR_MIN_CENTS);

  let reachedCount = 0;
  const mainLevels: number[] = [];
  for (let j = 0; j < seq.length; j++) {
    if (stats[j].reachedMs >= minReached) {
      reachedCount++;
      if (!isNeighbour[j] && Number.isFinite(stats[j].level)) mainLevels.push(stats[j].level);
    }
  }
  const mainLevel = mainLevels.length > 0 ? medianRange(mainLevels, 0, mainLevels.length) : mainMidi;

  const notes: string[] = [];
  let neighbourScoreSum = 0;
  let neighbourCount = 0;
  let achievedSum = 0;
  let allReached = true;
  let firstNeighbour = -1;
  for (let j = 0; j < seq.length; j++) {
    if (!isNeighbour[j]) continue;
    if (firstNeighbour < 0) firstNeighbour = j;
    neighbourCount++;
    const requested = (seq[j].midi - mainMidi) * 100;
    const side = requested > 0 ? 'upper' : 'lower';
    if (stats[j].reachedMs < minReached || !Number.isFinite(stats[j].level)) {
      allReached = false;
      notes.push(`Never reached the ${side} neighbour (${requested > 0 ? '+' : ''}${cents(requested)}).`);
      continue;
    }
    const achieved = (stats[j].level - mainLevel) * 100;
    achievedSum += Math.abs(achieved);
    neighbourScoreSum += clamp01(1 - Math.abs(achieved - requested) / Math.max(SCALE.turnNeighbour.minCents, SCALE.turnNeighbour.fraction * Math.abs(requested)));
    if (Math.abs(achieved - requested) > Math.max(SCALE.turnNeighbourNote.minCents, SCALE.turnNeighbourNote.fraction * Math.abs(requested))) {
      notes.push(`The ${side} neighbour was ${achieved > 0 ? '+' : ''}${cents(achieved)} (asked for ${requested > 0 ? '+' : ''}${cents(requested)}).`);
    }
  }
  if (neighbourCount === 0) return none('No neighbour note in the turn target.');

  // Timing: how close each reached note's change came to its slot.
  let timingSum = 0;
  let timingCount = 0;
  for (let j = 1; j < seq.length; j++) {
    const off = stats[j].onsetOffsetMs;
    if (stats[j].reachedMs >= minReached && off !== null) {
      timingSum += clamp01(1 - Math.max(0, Math.abs(off) - TURN_TIMING_FREE_MS) / (CONFIG.runs.dtwBandMs - TURN_TIMING_FREE_MS));
      timingCount++;
    }
  }
  const lastStat = stats[seq.length - 1];
  const landingAbs = lastStat.reachedMs >= minReached && lastStat.levelErrorCents !== null && !isNeighbour[seq.length - 1] ? Math.abs(lastStat.levelErrorCents) : null;
  const startA = firstNeighbour >= 0 ? stats[firstNeighbour].startT : null;
  const endA = lastStat.startT;
  const ornamentMs = startA !== null && endA !== null && !isNeighbour[seq.length - 1] ? (endA - startA) * 1000 : null;

  const reachedShare = reachedCount / seq.length;
  const neighbourScore = neighbourScoreSum / neighbourCount;
  const landingScore = landingAbs === null ? 0 : clamp01(1 - landingAbs / (LANDING_ZERO_TOLERANCES * CONFIG.tolerance.default));
  const timingScore = timingCount > 0 ? timingSum / timingCount : 0;
  const w = WEIGHTS.turn;
  let score = w.neighbour * neighbourScore + w.reached * reachedShare + w.landing * landingScore + w.timing * timingScore;
  if (!allReached) score = Math.min(score, CAPS.turnMissingNeighbour);
  if (landingAbs === null) {
    score = Math.min(score, CAPS.turnNoReturn); // a turn goes out AND comes back
    notes.push('Did not land back on the main note.');
  }
  return { detected: allReached, sizeCents: achievedSum / neighbourCount, timeMs: ornamentMs, landingAbsCents: landingAbs, score, notes };
}

// ---------------------------------------------------------------- flip
function flip(track: PitchTrack, targets: readonly TargetNote[], ctx: AnalyzeContext): Body {
  if (targets.length < 2) return none('A flip needs the note before it and the landing note.');
  // Every consecutive pair that moves by a real interval is a flip; the group's result is their average.
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i + 1 < targets.length; i++) if (Math.abs(targets[i + 1].midi - targets[i].midi) >= 1.5) pairs.push([i, i + 1]);
  if (pairs.length === 0) pairs.push([0, 1]);

  const transitions = analyzeTransitions(track, targets, ctx).transitions;
  const skip = CONFIG.accuracy.holdStartSkipMs / 1000;
  let score = 0;
  let landingSum = 0;
  let landingCount = 0;
  let sizeSum = 0;
  let timeSum = 0;
  let timeCount = 0;
  let detectedAll = true;
  const notes: string[] = [];

  for (const [i, j] of pairs) {
    const low = targets[i];
    const high = targets[j];
    const dir = high.midi > low.midi ? 1 : -1;
    const reqCents = Math.abs(high.midi - low.midi) * 100;
    const win = frameRange(track, low.start, high.end + 0.05);
    const c = voicedContour(track, win.lo, win.hi);
    const lowR = elems(c, low.start + skip, low.start + skip + Math.max(0.1, 0.7 * (low.end - low.start - skip)));
    const highR = elems(c, high.start + skip, high.end);
    if (lowR.b - lowR.a < 2 || highR.b - highR.a < 2) {
      detectedAll = false;
      notes.push('No voiced audio on one side of the flip.');
      continue;
    }
    const lowLevel = medianRange(c.smooth, lowR.a, lowR.b);
    const highLevel = medianRange(c.smooth, highR.a, highR.b);
    const achieved = dir * (highLevel - lowLevel) * 100;
    const landingAbs = medianAbsError(c, highR.a, highR.b, high.midi) as number;
    const tr = transitions[i];
    const transMs = tr !== undefined && tr.toIndex === j ? tr.durationMs : null;

    const abruptScore = transMs === null ? 0 : clamp01(1 - Math.max(0, transMs - FLIP_ABRUPT_MS) / (FLIP_SLOW_MS - FLIP_ABRUPT_MS));
    const sizeScore = clamp01(1 - Math.abs(achieved - reqCents) / Math.max(SCALE.flipSize.minCents, SCALE.flipSize.fraction * reqCents));
    const landingScore = clamp01(1 - landingAbs / (LANDING_ZERO_TOLERANCES * Math.max(ctx.toleranceCents, 1)));
    score += WEIGHTS.flip.abrupt * abruptScore + WEIGHTS.flip.size * sizeScore + WEIGHTS.flip.landing * landingScore;
    landingSum += landingAbs;
    landingCount++;
    sizeSum += achieved;
    if (transMs !== null) {
      timeSum += transMs;
      timeCount++;
    }
    if (achieved < FLIP_MIN_JUMP_FRACTION * reqCents) {
      detectedAll = false;
      notes.push(`The jump was only ${cents(achieved)} (asked for ${cents(reqCents)}).`);
    }
    if (transMs !== null && transMs > FLIP_SLOW_MS) notes.push(`The change took ${ms(transMs)}: that is a slide, not a flip.`);
    else if (transMs === null) notes.push('Never settled on the landing note.');

    // A flip usually shows a dip in detector confidence at the break. Reported, never scored: pitch alone cannot prove intent.
    const dip = elems(c, low.end - 0.05, high.start + 0.1);
    let minConf = 1;
    for (let k = dip.a; k < dip.b; k++) if (c.confidence[k] < minConf) minConf = c.confidence[k];
    if (dip.b > dip.a && minConf < FLIP_CONFIDENCE_DIP) notes.push('Confidence dipped at the break, which is typical of a register change. Pitch alone cannot show whether it was intended.');
  }

  if (landingCount === 0) return { ...none(notes[0] ?? 'No voiced audio in the flip window.') };
  const n = pairs.length;
  return {
    detected: detectedAll,
    sizeCents: sizeSum / landingCount,
    timeMs: timeCount > 0 ? timeSum / timeCount : null,
    landingAbsCents: landingSum / landingCount,
    score: detectedAll ? score / n : Math.min(score / n, CAPS.flipNoFlip),
    notes,
  };
}

/** analyzeInflection(track, kind, targets, ctx) - see the module doc for what `targets` holds per kind. */
export const analyzeInflection: AnalyzeInflection = (track, kind, targets, ctx): InflectionResult => {
  let body: Body;
  switch (kind) {
    case 'scoop':
      body = scoop(track, targets, ctx);
      break;
    case 'fall':
      body = fall(track, targets, ctx);
      break;
    case 'slide':
      body = slide(track, targets, ctx);
      break;
    case 'turn':
      body = turn(track, targets);
      break;
    case 'flip':
      body = flip(track, targets, ctx);
      break;
    default: {
      const unreachable: never = kind;
      throw new Error(`Unknown inflection kind: ${String(unreachable)}`);
    }
  }
  return { kind, ...body };
};
