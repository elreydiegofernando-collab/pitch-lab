/**
 * 8.2 Onset crispness: how fast and clean the voice arrives on a target
 * note. Settle time, scoop, overshoot and onset type (an acoustic estimate
 * from RMS rise time, never an EGG measure -- label it that way in the UI).
 *
 * Two situations a note can start in, both handled:
 *  - From silence (staccato, pitch match, the first note of a phrase): the
 *    onset is the first voiced frame after unvoiced ones -- even a slightly
 *    early one, and a previous note's tail inside the lookback is ignored.
 *  - Continuous with the previous note (an interval leap landed legato): there
 *    is no silence to anchor on, so the onset is the moment the pitch leaves
 *    the previous note's tolerance band. Waiting at the old pitch is not a
 *    scoop (late is the metronome's business, not the onset's), and the few
 *    frames a fast leap spends in flight are not a scoop or an overshoot
 *    either; only slower motion (a real slide into the note) counts.
 */
import type { PitchFrame, PitchTrack, TargetNote, ToleranceLevel } from '../core/types';
import type { AnalyzeContext, OnsetResult, OnsetType } from './types';
import { CONFIG } from '../config';
import { centsVsTarget, cleanSpikes, framesInWindow, lowerBound, median } from './track';

/*
 * Tuning with no CONFIG.onset entry (all PROVISIONAL, reported in contractIssues).
 */
/** How far before `note.start` the slice reaches (the previous pitch, and a singer who anticipates the beat). */
const ONSET_LOOKBACK_SEC = 0.25;
/** A voiced run that began earlier than this before the note is the previous note continuing (legato), not an early onset. */
const ANTICIPATION_SEC = 0.12;
/** Unvoiced gaps this short are detector dropouts: they neither end a run nor reset the settle hold. */
const BRIDGE_GAP_SEC = 0.035;
/** A frame moving faster than this to a neighbour is in flight (a leap, or a detector transient), not a scoop or an overshoot. */
const IN_FLIGHT_CENTS_PER_SEC = 5000;
/** Scoop and overshoot ignore frames further than this from the target: a slide-in or overshoot of more than a fifth is a detector fault (an octave error lasting a few frames), not singing. */
const PLAUSIBLE_DEVIATION_CENTS = 700;
/** The previous-pitch reference for a legato landing is the stretch just before the cue. */
const REFERENCE_WINDOW_SEC: readonly [number, number] = [0.12, 0.03];
/** Pre-onset noise floor: the quietest RMS in this long before the onset. */
const FLOOR_LOOKBACK_SEC = 0.2;
/**
 * The framer's RMS is a 2048-sample (~43 ms) window, which blurs an
 * instantaneous attack into a ~0.8 x window rise. The measured rise is
 * deconvolved by this blur (in quadrature) so the hard/balanced/breathy bands,
 * which describe the voice, are not shifted by the tracker. Assumes 48 kHz
 * (44.1 kHz is 8% longer: irrelevant against provisional bands).
 */
const RMS_WINDOW_SEC = CONFIG.audio.windowSize / 48000;
const RMS_BLUR_SEC = 0.8 * RMS_WINDOW_SEC;
const NONE: OnsetResult = { onsetT: null, settleMs: null, scoopCents: 0, overshootCents: 0, onsetType: 'unknown', riseMs: null, crisp: false };

export interface AnalyzeOnsetOptions {
  /**
   * SPEC 8.2 reads "crisp = a fast settle with little scoop and little
   * overshoot, from a balanced onset". The RMS-rise-time bands behind
   * 'hard'/'balanced'/'breathy' are PROVISIONAL (RESEARCH section 6, tune on real
   * voices) and a natural quick sung attack can land in the 'hard' band, which
   * would make the crispness level unpassable on a good voice. So by default
   * only a BREATHY onset vetoes `crisp` (a slow, soft start is not a crisp
   * landing) and a hard one does not; pass `true` for the literal spec reading
   * (the onset must be 'balanced', and an unmeasurable onset fails too).
   * The onset type is reported either way.
   */
  requireBalancedOnset?: boolean;
}

/** analyzeOnset(track, note, ctx) -- one sustained target note. */
export function analyzeOnset(track: PitchTrack, note: TargetNote, ctx: AnalyzeContext, opts: AnalyzeOnsetOptions = {}): OnsetResult {
  const win = cleanSpikes(framesInWindow(track, note.start - ONSET_LOOKBACK_SEC, note.end));
  const point = findOnset(win, note, ctx.toleranceCents);
  if (point === null) return NONE;
  const oi = point.index;

  const after = win.slice(oi);
  const onsetT = after[0].t;
  const settleMs = settleTime(after, note, ctx.toleranceCents);
  const settleT = settleMs !== null ? onsetT + settleMs / 1000 : note.end;
  const flight = inFlightFlags(after);
  // Scoop and overshoot read only steady, plausible frames: not the few frames of a fast leap in flight (see the module comment), and not
  // frames further from the target than a voice slides in from (a multi-frame octave error at an onset is a detector fault, not a 1200 c scoop).
  const steady = after.filter((f, i) => !flight[i] && Math.abs(centsVsTarget(f, note)) <= PLAUSIBLE_DEVIATION_CENTS);
  const scoopCents = scoop(steady, note, onsetT);
  const overshootCents = overshoot(steady, note, onsetT, settleT, point.travel);
  const { riseMs, onsetType } = classifyOnset(win, oi, note);

  const tier = toleranceTier(ctx.toleranceCents);
  const typeOk = opts.requireBalancedOnset ? onsetType === 'balanced' : onsetType !== 'breathy';
  const crisp =
    settleMs !== null &&
    settleMs <= CONFIG.onset.settleTargetMs[tier] &&
    scoopCents <= CONFIG.onset.crispMaxScoopCents &&
    overshootCents <= CONFIG.onset.crispMaxOvershootCents &&
    typeOk;

  return { onsetT, settleMs, scoopCents, overshootCents, onsetType, riseMs, crisp };
}

// ---------------------------------------------------------------- finding the onset

/** Where a note's onset is measured from. */
interface OnsetPoint {
  /** Index into the cleaned window of the onset frame. */
  index: number;
  /** Which way the pitch has to travel to reach the target from the previous note: +1 up, -1 down; 0 when unknown (an onset from silence has no previous pitch). */
  travel: -1 | 0 | 1;
}

/** The frame the note's onset is measured from; null when the note is never voiced. */
function findOnset(win: readonly PitchFrame[], note: TargetNote, toleranceCents: number): OnsetPoint | null {
  const n = win.length;
  const startIdx = lowerBound(win, note.start);
  if (startIdx >= n) return null;

  if (win[startIdx].voiced) {
    // Singing at the cue: either it began from silence (maybe a hair early), or it is the previous note continuing.
    const r = runStartIndex(win, startIdx);
    if (r > 0 && win[r].t >= note.start - ANTICIPATION_SEC) return { index: r, travel: 0 }; // began from silence at, or just before, the cue
    return departure(win, startIdx, note, toleranceCents); // the previous note continuing
  }
  // Silent at the cue: the onset is the next voiced frame.
  for (let j = startIdx; j < n; j++) if (win[j].voiced) return { index: j, travel: 0 };
  return null;
}

/** First frame of the voiced run containing `idx`, bridging dropouts up to BRIDGE_GAP_SEC. */
function runStartIndex(win: readonly PitchFrame[], idx: number): number {
  let r = idx;
  let lastVoicedT = win[idx].t;
  for (let k = idx - 1; k >= 0; k--) {
    if (win[k].voiced) {
      if (lastVoicedT - win[k].t > BRIDGE_GAP_SEC) break;
      r = k;
      lastVoicedT = win[k].t;
    } else if (lastVoicedT - win[k].t > BRIDGE_GAP_SEC) {
      break;
    }
  }
  return r;
}

/**
 * Continuous landing: the first voiced frame that has left the previous
 * note's band, or the frame at the cue when the pitch never left it (a
 * repeated note) or there is no previous pitch to leave.
 */
function departure(win: readonly PitchFrame[], startIdx: number, note: TargetNote, toleranceCents: number): OnsetPoint {
  const refFrom = note.start - REFERENCE_WINDOW_SEC[0];
  const refTo = note.start - REFERENCE_WINDOW_SEC[1];
  const ref: number[] = [];
  let first = -1;
  for (let k = 0; k < win.length; k++) {
    const f = win[k];
    if (f.t < refFrom) continue;
    if (first === -1) first = k;
    if (f.t >= refTo) break;
    if (f.voiced) ref.push(f.midi);
  }
  if (ref.length === 0 || first === -1) return { index: startIdx, travel: 0 };
  const prev = median(ref);
  const travel: -1 | 0 | 1 = Math.abs((note.midi - prev) * 100) > toleranceCents ? (note.midi > prev ? 1 : -1) : 0;
  for (let k = first; k < win.length; k++) {
    const f = win[k];
    if (f.voiced && Math.abs((f.midi - prev) * 100) > toleranceCents) return { index: k, travel };
  }
  return { index: startIdx, travel: 0 };
}

// ---------------------------------------------------------------- settle, scoop, overshoot

/** ms from the onset until cents-vs-target stays within tolerance, continuously, for settleHoldMs. Null if it never does. */
function settleTime(after: readonly PitchFrame[], note: TargetNote, toleranceCents: number): number | null {
  const onsetT = after[0].t;
  let inTolSinceT: number | null = null;
  let lastVoicedT = onsetT;
  for (const f of after) {
    if (!f.voiced) {
      if (f.t - lastVoicedT > BRIDGE_GAP_SEC) inTolSinceT = null;
      continue;
    }
    lastVoicedT = f.t;
    const c = centsVsTarget(f, note);
    if (Number.isFinite(c) && Math.abs(c) <= toleranceCents) {
      if (inTolSinceT === null) inTolSinceT = f.t;
      if ((f.t - inTolSinceT) * 1000 >= CONFIG.onset.settleHoldMs) return (inTolSinceT - onsetT) * 1000;
    } else {
      inTolSinceT = null;
    }
  }
  return null;
}

/**
 * Per frame: true when it is moving faster than IN_FLIGHT_CENTS_PER_SEC
 * toward or away from the previous/next voiced frame (looking at most 3
 * frames either way). One pass, no per-frame search.
 */
function inFlightFlags(frames: readonly PitchFrame[]): boolean[] {
  const n = frames.length;
  const flags = new Array<boolean>(n).fill(false);
  const speed = (a: PitchFrame, b: PitchFrame): number => Math.abs((a.midi - b.midi) * 100) / Math.max(1e-6, Math.abs(a.t - b.t));
  let prevVoiced = -1; // index of the latest voiced frame seen
  for (let i = 0; i < n; i++) {
    if (!frames[i].voiced) continue;
    if (prevVoiced >= 0 && i - prevVoiced <= 3 && speed(frames[i], frames[prevVoiced]) > IN_FLIGHT_CENTS_PER_SEC) {
      flags[i] = true;
      flags[prevVoiced] = true; // a fast step moves both of the frames it joins
    }
    prevVoiced = i;
  }
  return flags;
}

/** Lowest deviation below the target in the first scoopWindowMs after onset (cents, >= 0; 0 = no scoop). `steady` excludes in-flight frames. */
function scoop(steady: readonly PitchFrame[], note: TargetNote, onsetT: number): number {
  const windowEnd = onsetT + CONFIG.onset.scoopWindowMs / 1000;
  let lowest = 0;
  for (const f of steady) {
    if (f.t >= windowEnd) break;
    const c = centsVsTarget(f, note);
    if (Number.isFinite(c) && -c > lowest) lowest = -c;
  }
  return lowest;
}

/**
 * Largest excursion, in the approach direction, past the target before
 * settling (cents, >= 0). For a legato landing the approach direction is the
 * direction of travel from the previous note (known). From silence it is away
 * from where the pitch started (median of the first steady frames): starting
 * flat, overshoot is landing sharp; starting sharp, overshoot is landing
 * flat. A pitch that starts dead on has no approach and scores 0.
 */
function overshoot(steady: readonly PitchFrame[], note: TargetNote, onsetT: number, settleT: number, travel: -1 | 0 | 1): number {
  let approachSign: number = travel;
  if (approachSign === 0) {
    const first: number[] = [];
    for (const f of steady) {
      const c = centsVsTarget(f, note);
      if (Number.isFinite(c)) first.push(c);
      if (first.length === 3) break;
    }
    if (first.length === 0) return 0;
    const c0 = median(first);
    approachSign = c0 < 0 ? 1 : c0 > 0 ? -1 : 0;
  }
  if (approachSign === 0) return 0;
  let peak = 0;
  for (const f of steady) {
    if (f.t < onsetT) continue;
    if (f.t > settleT) break;
    const c = centsVsTarget(f, note);
    if (!Number.isFinite(c)) continue;
    const excursion = approachSign * c;
    if (excursion > peak) peak = excursion;
  }
  return peak;
}

// ---------------------------------------------------------------- onset type

/**
 * Onset type from the RMS envelope's 10%-90% rise time between the pre-onset
 * floor and the note's steady-state level (converted to linear amplitude so
 * "10%/90%" means amplitude, not dB), deconvolved from the tracker's window
 * blur. An acoustic estimate -- UI copy should label it that, per
 * docs/RESEARCH.md section 6. A continuous landing has no pre-onset floor, so it is
 * 'unknown' and never vetoes crisp.
 */
function classifyOnset(win: readonly PitchFrame[], onsetIndex: number, note: TargetNote): { riseMs: number | null; onsetType: OnsetType } {
  const unknown = { riseMs: null, onsetType: 'unknown' as OnsetType };
  const onsetT = win[onsetIndex].t;

  // Pre-onset floor: the quietest frame shortly before the onset. None (or no actual silence) -> not measurable.
  let floorIdx = -1;
  for (let k = onsetIndex - 1; k >= 0 && onsetT - win[k].t <= FLOOR_LOOKBACK_SEC; k--) {
    if (win[k].voiced) break; // the previous note's voice: no silence to measure the attack from
    if (floorIdx === -1 || win[k].rmsDb < win[floorIdx].rmsDb) floorIdx = k;
  }
  if (floorIdx === -1) return unknown;

  const steadyFrames = win.slice(onsetIndex).filter((f) => f.voiced && f.t < note.end);
  if (steadyFrames.length === 0) return unknown;
  const floorLin = Math.pow(10, win[floorIdx].rmsDb / 20);
  const steadyLin = Math.pow(10, median(steadyFrames.map((f) => f.rmsDb)) / 20);
  if (steadyLin <= floorLin) return unknown;

  const lo = floorLin + 0.1 * (steadyLin - floorLin);
  const hi = floorLin + 0.9 * (steadyLin - floorLin);
  let t10: number | null = null;
  let t90: number | null = null;
  for (let i = floorIdx; i < win.length; i++) {
    const amp = Math.pow(10, win[i].rmsDb / 20);
    if (t10 === null && amp >= lo) t10 = win[i].t;
    if (t10 !== null && amp >= hi) {
      t90 = win[i].t;
      break;
    }
  }
  if (t10 === null || t90 === null) return unknown;
  const measured = Math.max(0, t90 - t10);
  const riseMs = 1000 * Math.sqrt(Math.max(0, measured * measured - RMS_BLUR_SEC * RMS_BLUR_SEC));
  const onsetType: OnsetType =
    riseMs <= CONFIG.onset.hardMaxRiseMs ? 'hard' : riseMs >= CONFIG.onset.breathyMinRiseMs ? 'breathy' : 'balanced';
  return { riseMs, onsetType };
}

function toleranceTier(toleranceCents: number): ToleranceLevel {
  let best: ToleranceLevel = 'default';
  let bestDiff = Infinity;
  for (const key of Object.keys(CONFIG.tolerance) as ToleranceLevel[]) {
    const diff = Math.abs(CONFIG.tolerance[key] - toleranceCents);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = key;
    }
  }
  return best;
}
