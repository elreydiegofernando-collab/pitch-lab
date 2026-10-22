/**
 * Vibrato on/off switching and straight-to-bloom (9.2). Given the cue plan
 * (which vibrato state the singer is asked for over time), finds where vibrato
 * was actually being sung (vibrato.ts's episodes: chains of whole cycles with
 * sub-frame start and end times) and scores how cleanly the singer switched at
 * each cue change.
 *
 * Why episodes and not "is vibrato present in this window": detecting vibrato
 * needs two cycles, so a window test inherently reports a bloom ~0.4 s after
 * it began and a switch-off ~0.4 s after it ended, no matter how crisply the
 * singer moved. An episode's first and last zero crossings are where the
 * oscillation actually started and stopped, so latency here is the singer's
 * reaction time to the cue, not the detector's.
 *
 * The cue shape is exactly `RealizedExercise.vibratoPlan`
 * (`{ start, end, vibrato }`, take-relative seconds), so the runner passes it
 * straight through.
 *
 * `SwitchResult` isn't in src/analysis/types.ts (only its two scored facets,
 * `vibrato.switchCleanRate` and `vibrato.bloomOnCue`, are named there as
 * MetricKeys) -- it is defined here instead.
 */
import type { PitchTrack } from '../core/types';
import { estimateFrameDt, framesInWindow } from './track';
import { findVibratoEpisodes, type VibratoEpisode } from './vibrato';

/** One instruction window: "be vibrato (true) or straight (false) from `start` to `end`". Same shape as RealizedExercise.vibratoPlan entries. */
export interface VibratoCue {
  start: number;
  end: number;
  vibrato: boolean;
}

export type VibratoState = 'straight' | 'vibrato';

export interface SwitchWindowResult {
  start: number;
  end: number;
  cue: VibratoState;
  /** What the singer mostly did in the window: 'silent' when (almost) nothing was voiced. */
  actual: VibratoState | 'silent';
  /** Share of the window's voiced time that was inside a vibrato episode, 0..1. */
  vibratoFraction: number;
}

export interface SwitchBoundary {
  /** Take time of the cue change. */
  t: number;
  /** The state the cue asked for from here on. */
  toVibrato: boolean;
  /** Signed ms from the cue to the singer's state actually changing (+ = late, - = early). Null when it never did. */
  latencyMs: number | null;
  /** Switched within the early/late tolerance and without the voice breaking. */
  clean: boolean;
  /** The voice broke (an unvoiced gap of re-attack length) around the switch. */
  reattacked: boolean;
}

export interface SwitchResult {
  /** What the singer actually did in each cue window, in cue order. */
  windows: SwitchWindowResult[];
  /** Every cue change between two CONTIGUOUS cue windows with different states, in time order. A rest between windows is not a switch. */
  boundaries: SwitchBoundary[];
  /** Clean boundaries / all boundaries, 0..1. Null when the plan has no boundary to judge. */
  switchCleanRate: number | null;
  /** Mean signed latency (ms) of the straight -> vibrato boundaries where vibrato did arrive. Null when none did or there were none. */
  bloomOnCueLatencyMs: number | null;
  /** 0..1 mean score over the straight -> vibrato boundaries (1 = on the cue, 0 = never or far off). Null when the plan has none. */
  bloomOnCueScore: number | null;
}

/*
 * Tuning with no CONFIG.vibrato entry (all PROVISIONAL, reported in
 * contractIssues as proposed CONFIG.vibrato.switch knobs).
 */
/** A singer may anticipate a visual cue slightly; starting or stopping more than this early is "jumping the gun", not switching on the cue. */
const EARLY_TOLERANCE_SEC = 0.3;
/** Reaction time: a state change later than this after the cue is not a clean switch. */
const LATE_TOLERANCE_SEC = 0.7;
/** An unvoiced stretch this long inside the switch means the note was re-attacked, not switched. Detector dropouts are shorter. */
const REATTACK_GAP_SEC = 0.08;
/** A bloom within this long after the cue scores 1 (human reaction time); the score then falls linearly to 0 at BLOOM_ZERO_SEC. */
const BLOOM_FULL_SEC = 0.25;
const BLOOM_ZERO_SEC = 1.5;
/** Blooming this much earlier than the tolerance allows scores 0 (the score falls linearly across it). */
const BLOOM_EARLY_ZERO_SEC = 0.6;
/** Cue windows closer than this are contiguous (same sustained note / legato line). */
const CONTIGUOUS_TOLERANCE_SEC = 0.001;
/** A window with less voiced time than this is 'silent'. */
const MIN_VOICED_SEC = 0.2;

/**
 * analyzeSwitch(track, cues) -- an on/off-switching, straight-to-bloom or
 * recital take. `cues` is the realized vibrato plan; the track is
 * take-relative.
 */
export function analyzeSwitch(track: PitchTrack, cues: readonly VibratoCue[]): SwitchResult {
  const plan = cues.filter((c) => c.end > c.start).slice().sort((a, b) => a.start - b.start);
  const dt = estimateFrameDt(track);

  // Episodes per contiguous group of cue windows (one sustained note or legato line), so the oscillation is never measured across a rest.
  const episodes: VibratoEpisode[] = [];
  let g = 0;
  while (g < plan.length) {
    let h = g;
    while (h + 1 < plan.length && Math.abs(plan[h + 1].start - plan[h].end) <= CONTIGUOUS_TOLERANCE_SEC) h++;
    episodes.push(...findVibratoEpisodes(framesInWindow(track, plan[g].start, plan[h].end)));
    g = h + 1;
  }

  const windows = plan.map((cue) => windowResult(track, cue, episodes, dt));

  const boundaries: SwitchBoundary[] = [];
  for (let i = 1; i < plan.length; i++) {
    const prev = plan[i - 1];
    const cue = plan[i];
    if (Math.abs(cue.start - prev.end) > CONTIGUOUS_TOLERANCE_SEC || cue.vibrato === prev.vibrato) continue;
    boundaries.push(boundaryResult(track, prev, cue, episodes));
  }

  const switchCleanRate = boundaries.length > 0 ? boundaries.filter((b) => b.clean).length / boundaries.length : null;

  const blooms = boundaries.filter((b) => b.toVibrato);
  let bloomOnCueLatencyMs: number | null = null;
  let bloomOnCueScore: number | null = null;
  if (blooms.length > 0) {
    bloomOnCueScore = blooms.reduce((sum, b) => sum + bloomScore(b.latencyMs), 0) / blooms.length;
    const arrived = blooms.filter((b) => b.latencyMs !== null).map((b) => b.latencyMs as number);
    if (arrived.length > 0) bloomOnCueLatencyMs = arrived.reduce((a, b) => a + b, 0) / arrived.length;
  }

  return { windows, boundaries, switchCleanRate, bloomOnCueLatencyMs, bloomOnCueScore };
}

function windowResult(track: PitchTrack, cue: VibratoCue, episodes: readonly VibratoEpisode[], dt: number): SwitchWindowResult {
  const frames = framesInWindow(track, cue.start, cue.end);
  const voicedFrames = frames.reduce((n, f) => (f.voiced ? n + 1 : n), 0);
  const voicedSec = Number.isFinite(dt) ? voicedFrames * dt : 0;
  let vibratoSec = 0;
  for (const e of episodes) {
    const overlap = Math.min(e.endT, cue.end) - Math.max(e.startT, cue.start);
    if (overlap > 0) vibratoSec += overlap;
  }
  const vibratoFraction = voicedSec > 0 ? Math.min(1, vibratoSec / voicedSec) : 0;
  const actual: SwitchWindowResult['actual'] = voicedSec < MIN_VOICED_SEC ? 'silent' : vibratoFraction >= 0.5 ? 'vibrato' : 'straight';
  return { start: cue.start, end: cue.end, cue: cue.vibrato ? 'vibrato' : 'straight', actual, vibratoFraction };
}

function boundaryResult(track: PitchTrack, prev: VibratoCue, cue: VibratoCue, episodes: readonly VibratoEpisode[]): SwitchBoundary {
  const t = cue.start;
  let latencySec: number | null = null;
  if (cue.vibrato) {
    // Vibrato wanted: the first episode still running after the cue, if it starts inside this window.
    const e = episodes.find((x) => x.endT > t);
    if (e && e.startT < cue.end) latencySec = e.startT - t;
  } else {
    // Straight wanted: the episode the singer was in during the previous window; it must end inside this one.
    let e: VibratoEpisode | undefined;
    for (const x of episodes) if (x.startT < t && x.endT > prev.start) e = x;
    if (e && e.endT < cue.end) latencySec = e.endT - t;
  }

  const reattacked = brokeVoice(track, t - 0.1, t + Math.max(0, latencySec ?? 0) + 0.1);
  const clean = latencySec !== null && latencySec >= -EARLY_TOLERANCE_SEC && latencySec <= LATE_TOLERANCE_SEC && !reattacked;
  return { t, toVibrato: cue.vibrato, latencyMs: latencySec === null ? null : latencySec * 1000, clean, reattacked };
}

/** True when voiced frames inside [from, to] are separated by an unvoiced stretch of re-attack length, or nothing is voiced at all. */
function brokeVoice(track: PitchTrack, from: number, to: number): boolean {
  let lastVoiced: number | null = null;
  for (const f of framesInWindow(track, from, to)) {
    if (!f.voiced) continue;
    if (lastVoiced !== null && f.t - lastVoiced > REATTACK_GAP_SEC) return true;
    lastVoiced = f.t;
  }
  return lastVoiced === null;
}

/** 1 within BLOOM_FULL_SEC after the cue (and inside the early tolerance before it), falling linearly to 0 at BLOOM_ZERO_SEC late or BLOOM_EARLY_ZERO_SEC beyond the early tolerance. 0 when vibrato never arrived. */
function bloomScore(latencyMs: number | null): number {
  if (latencyMs === null) return 0;
  const s = latencyMs / 1000;
  if (s < -EARLY_TOLERANCE_SEC) return Math.max(0, 1 - (-s - EARLY_TOLERANCE_SEC) / BLOOM_EARLY_ZERO_SEC);
  if (s <= BLOOM_FULL_SEC) return 1;
  return Math.max(0, 1 - (s - BLOOM_FULL_SEC) / (BLOOM_ZERO_SEC - BLOOM_FULL_SEC));
}
