/**
 * Analyzer contract (Phase 2). Analyzers are PURE functions over a take-relative
 * PitchTrack (raw frames, never display-smoothed) plus a target. Thresholds come
 * from CONFIG (src/config.ts); nothing here hard-codes tuning numbers.
 *
 * Every analyzer returns plain JSON-serialisable data so results can be stored
 * in AttemptRecord.metrics and shown in take reports.
 */
import type { PitchTrack, TargetNote, VibratoStyle } from '../core/types';

export interface AnalyzeContext {
  /** +/- cents for "in tune" (comes from the LEVEL, never a user setting). */
  toleranceCents: number;
  vibratoStyle: VibratoStyle;
}

// ---------------------------------------------------------------- 8.1 accuracy & stability
export interface AccuracyResult {
  voicedSec: number;
  /** Signed median cents vs target over the held portion (onset skipped): + = sharp. */
  biasCents: number;
  medianAbsCents: number;
  /** % of held voiced time within +/- tolerance. */
  inTolerancePct: number;
  /** Standard deviation of cents (stability). */
  sdCents: number;
  /** Linear-fit slope over the held portion, cents per second (needs >= CONFIG.accuracy.driftMinHoldSec). */
  driftCentsPerSec: number | null;
}
/** analyzeAccuracy(track, note, ctx) — one sustained target note. */
export type AnalyzeAccuracy = (track: PitchTrack, note: TargetNote, ctx: AnalyzeContext) => AccuracyResult;

// ---------------------------------------------------------------- 8.2 onset crispness
export type OnsetType = 'breathy' | 'balanced' | 'hard' | 'unknown';
export interface OnsetResult {
  /** Take time of voice onset (first voiced frame after silence), null if never voiced. */
  onsetT: number | null;
  /** ms from onset until pitch stays within tolerance for CONFIG.onset.settleHoldMs; null = never settled. */
  settleMs: number | null;
  /** Lowest deviation below target in the first CONFIG.onset.scoopWindowMs (positive number = cents below; 0 = none). */
  scoopCents: number;
  /** Largest excursion beyond target in the approach direction before settling (cents, >= 0). */
  overshootCents: number;
  onsetType: OnsetType;
  /** RMS rise time used for onsetType (ms). An acoustic estimate, not an EGG measure. */
  riseMs: number | null;
  crisp: boolean;
}
export type AnalyzeOnset = (track: PitchTrack, note: TargetNote, ctx: AnalyzeContext) => OnsetResult;

// ---------------------------------------------------------------- 8.3 vibrato
export type VibratoFlag = 'wobble' | 'bleat' | 'straight' | 'irregular' | 'sagging-flat' | 'sharp-centred';
export interface VibratoResult {
  /** True when >= CONFIG.vibrato.minCycles cycles over >= minDurationSec with extent above the straight threshold. */
  present: boolean;
  rateHz: number | null;
  /** Half peak-to-trough, cents (median). */
  extentCents: number | null;
  rateSdHz: number | null;
  extentSdCents: number | null;
  /** 0..1, 1 = perfectly regular (from rate & extent variability, allowing the natural rate ramp). */
  regularity: number | null;
  /** Mean of the oscillation vs target, cents (+ sharp). Null when no target. */
  centeringCents: number | null;
  inZone: boolean;
  /** Neutral and quality flags. 'straight' is NEUTRAL, never an error. */
  flags: VibratoFlag[];
  /** Per-window estimates for live meters and switch drills. */
  windows: Array<{ start: number; end: number; rateHz: number | null; extentCents: number | null; present: boolean }>;
}
export type AnalyzeVibrato = (track: PitchTrack, note: TargetNote | null, ctx: AnalyzeContext) => VibratoResult;

// ---------------------------------------------------------------- 8.4 transitions, glides, cracks
export interface CrackEvent {
  t: number;
  kind: 'jump' | 'dropout';
  /** For jumps: size in cents. */
  cents?: number;
  durationMs: number;
}
export interface GlideResult {
  durationMs: number | null;
  startErrorCents: number | null;
  endErrorCents: number | null;
  monotonic: boolean;
  /** Plateaus >= CONFIG.transitions.stairPlateauMs inside the glide. */
  stairSteps: number;
  /** 0..1 */
  smoothness: number;
  cracks: CrackEvent[];
}
export type AnalyzeGlide = (track: PitchTrack, glide: TargetNote, ctx: AnalyzeContext) => GlideResult;
/** detectCracks(track) — over a whole take (sirens). */
export type DetectCracks = (track: PitchTrack) => CrackEvent[];
export interface TransitionResult {
  /** Per note-to-note change: time from leaving note A's band to settling in note B's. */
  transitions: Array<{ fromIndex: number; toIndex: number; durationMs: number | null; overshootCents: number; clean: boolean }>;
  cleanRate: number;
}
export type AnalyzeTransitions = (track: PitchTrack, notes: readonly TargetNote[], ctx: AnalyzeContext) => TransitionResult;

// ---------------------------------------------------------------- inflections
export type InflectionKind = 'scoop' | 'fall' | 'slide' | 'turn' | 'flip';
export interface InflectionResult {
  kind: InflectionKind;
  detected: boolean;
  /** Scoop: cents below at start; fall: cents dropped; slide: glide error; turn: neighbour interval; flip: jump size. */
  sizeCents: number | null;
  /** Scoop: arrival time on target; fall: release duration; slide: glide duration; turn: ornament duration; flip: transition time. */
  timeMs: number | null;
  /** Accuracy of the landing/target note after the inflection (cents, abs median). */
  landingAbsCents: number | null;
  /** 0..1 score vs the exercise's requested shape. */
  score: number;
  notes: string[];
}
export type AnalyzeInflection = (track: PitchTrack, kind: InflectionKind, targets: readonly TargetNote[], ctx: AnalyzeContext) => InflectionResult;

// ---------------------------------------------------------------- 8.5 runs & riffs
export type RunNoteVerdict = 'defined' | 'smeared' | 'missed';
export interface RunNoteResult {
  index: number;
  targetMidi: number;
  reached: boolean;
  reachedMs: number; //       longest contiguous time within reachedTolCents
  medianErrorCents: number | null;
  /** Fraction of the note's (DTW-aligned) window spent on pitch, 0..1. */
  definition: number;
  timingErrorMs: number | null; // aligned onset vs metronome slot
  verdict: RunNoteVerdict;
}
export interface RunResult {
  notes: RunNoteResult[];
  /** 0..1 combination per CONFIG.runs.weights. */
  score: number;
  components: { reached: number; accuracy: number; definition: number; timing: number };
}
export type AnalyzeRun = (track: PitchTrack, notes: readonly TargetNote[], ctx: AnalyzeContext) => RunResult;

// ---------------------------------------------------------------- 8.6 dynamics
export interface DynamicsResult {
  /** Relative only (uncalibrated mic): ceiling - floor of the voiced RMS envelope. */
  rangeDb: number;
  /** Slope of signed cents vs relative dB (cents per dB). ~0 is the goal. */
  slopeCentsPerDb: number | null;
  correlation: number | null;
  /** Messa di voce shape: 0..1 symmetry and peak position (0..1 of the note). */
  symmetry: number | null;
  peakPosition: number | null;
  verdict: 'steady' | 'sharp-when-loud' | 'flat-when-soft' | 'drifts' | 'insufficient-range';
}
export type AnalyzeDynamics = (track: PitchTrack, note: TargetNote, ctx: AnalyzeContext) => DynamicsResult;

// ---------------------------------------------------------------- 8.7 range
export interface RangeResult {
  lowestMidi: number | null;
  highestMidi: number | null;
  /** Notes held cleanly >= CONFIG.range.holdSec at/above confidence. */
  heldNotes: Array<{ midi: number; start: number; durationSec: number }>;
}
export type AnalyzeRange = (track: PitchTrack) => RangeResult;

// ---------------------------------------------------------------- song phrases (Phase 6)
export interface PhraseScore {
  phraseIndex: number;
  start: number;
  end: number;
  /** 0..1 pitch score (octave-agnostic if requested). */
  pitchScore: number;
  inTolerancePct: number;
  timingOffsetMs: number | null;
  stabilitySdCents: number | null;
  vibratoPresent: boolean;
}

// ---------------------------------------------------------------- scoring vocabulary
/**
 * Every number an exercise may score or gate on. Stored in AttemptRecord.metrics.
 * Rates/percentages are 0..100 when named *Pct, otherwise 0..1.
 */
export type MetricKey =
  | 'accuracy.inTolerancePct' | 'accuracy.medianAbsCents' | 'accuracy.sdCents' | 'accuracy.absBiasCents' | 'accuracy.absDriftCentsPerSec'
  | 'onset.settleMs' | 'onset.scoopCents' | 'onset.overshootCents' | 'onset.crispRate'
  | 'vibrato.present' | 'vibrato.rateHz' | 'vibrato.extentCents' | 'vibrato.regularity' | 'vibrato.inZone' | 'vibrato.absCenteringCents'
  | 'vibrato.switchCleanRate' | 'vibrato.bloomOnCue'
  | 'pulse.rateErrorHz' | 'pulse.regularity'
  | 'glide.smoothness' | 'glide.endAbsCents' | 'glide.cracks' | 'transition.cleanRate'
  | 'inflection.score' | 'inflection.landingAbsCents'
  | 'run.score' | 'run.definedRate' | 'run.missedRate'
  | 'dynamics.rangeDb' | 'dynamics.absSlopeCentsPerDb' | 'dynamics.symmetry'
  | 'range.spanSemitones'
  | 'song.phraseScore' | 'song.inTolerancePct';

export type Metrics = Partial<Record<MetricKey, number>>;
