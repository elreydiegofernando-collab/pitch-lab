/**
 * Realize an ExerciseDef for one singer: pick the tonic inside their saved
 * range (or a voice-type default), then lay the pattern out on the take
 * timeline, where t = 0 is the downbeat after the count-in. Pure; called once
 * per take (and once more for a slowed demo).
 *
 * Range policy: material sits in the COMFORTABLE range. Range and top-end
 * exercises (range finder, sirens, flips) use the EXTENDED range. Material
 * wider than the comfortable range moves to the extended range (fit
 * 'extended'). Material wider than that too has its out-of-range notes folded
 * by octaves (fit 'folded', a last resort the UI should flag). No note is ever
 * placed outside the extended range.
 */
import type { InflectionKind } from '../analysis/types';
import type { MidiRange } from '../core/music';
import type { TargetNote } from '../core/types';
import type { ProfileRecord, VocalRange } from '../storage/schema';
import { CUE } from './cues';
import { planAnalysis } from './plan';
import type { ExerciseDef, ExerciseKind, TonicPlacement } from './types';

export type VoiceType = ProfileRecord['voiceType'];

/**
 * Ranges used until the range finder has run (PROPOSED CONFIG.voice.defaultRanges).
 * Beginner-safe: tenor C3-A4, baritone A2-F4, other/unknown C3-E4, the untrained
 * male comfortable span, which centres exercises near F3-G3 (RESEARCH §6).
 * With no saved range these are both the comfortable and the extended range.
 */
export const DEFAULT_RANGES: Readonly<Record<VoiceType, MidiRange>> = {
  tenor: { low: 48, high: 69 },
  baritone: { low: 45, high: 65 },
  other: { low: 48, high: 64 },
  unknown: { low: 48, high: 64 },
};

/**
 * Zona di passaggio, primo to secondo passaggio (PROPOSED CONFIG.voice.passaggio; RESEARCH §6):
 * tenor ~D4-G4 (primo C♯4-E4, secondo ~G4), baritone ~B♭3-E4 (primo B♭3-B3, secondo E♭4-E4).
 * Other voices: estimated from the top of the comfortable range.
 */
export const PASSAGGIO_ZONE: Readonly<Partial<Record<VoiceType, MidiRange>>> = {
  tenor: { low: 62, high: 67 },
  baritone: { low: 58, high: 64 },
};
/** Unknown voices: the passaggio centre sits this far below the top of the comfortable range. */
const PASSAGGIO_BELOW_COMFORT_TOP = 2;

/**
 * Where the material goes, as a fraction of the range: 'mid' puts the TONIC
 * there, the others put the material's centre there. Lower-middle rather than
 * the arithmetic middle, because effort rises toward the top of a range.
 */
const PLACEMENT_FRACTION: Readonly<Record<Exclude<TonicPlacement, 'passaggio'>, number>> = {
  low: 0.3,
  mid: 0.45,
  high: 0.7,
  'fit-span': 0.45,
};

/** Range finder -> saved range: comfortable = measured extremes trimmed (PROPOSED CONFIG.range knobs). */
const COMFORT_TRIM_LOW = 2;
const COMFORT_TRIM_HIGH = 3;
const MIN_COMFORT_SPAN = 7;
/** Supported pitch range (SPEC §7: at least E2-C6); measurements are clamped to it. */
const SUPPORTED: MidiRange = { low: 40, high: 84 };

/** Kinds that live at the edges of the voice and may use the extended range. */
const TOP_END_KINDS: ReadonlySet<ExerciseKind> = new Set<ExerciseKind>(['range-finder', 'siren', 'flip']);

const EPS = 1e-9;

/** One pattern step placed on the take timeline. */
export interface RealizedStep {
  /** Index into def.pattern. */
  index: number;
  /** Repetition, 0-based. */
  rep: number;
  /** 'listen' = reference tone only (CUE.listen); 'rest' = silence. */
  role: 'sing' | 'listen' | 'rest';
  start: number;
  end: number;
  /** MIDI of the step; absent for rests. */
  midi?: number;
  /** Glide/slide arrival pitch. */
  toMidi?: number;
  cue?: string;
  syllable?: string;
}

export interface RealizedExercise {
  exerciseId: string;
  tonicMidi: number;
  bpm: number;
  /** Count-in length; the count-in runs from -countInSec to 0. */
  countInSec: number;
  /** Sung targets, take-relative seconds from the downbeat. Glides carry toMidi. */
  notes: TargetNote[];
  /** Tones the synth plays (never sung): Listen steps, the starting pitch during the count-in, new-key pitches. */
  reference: TargetNote[];
  cues: Array<{ t: number; text: string }>;
  /** From the downbeat to the end of the last step. */
  totalSec: number;
  /** The range the material was placed in. */
  range: MidiRange;
  fit: 'fits' | 'extended' | 'folded';
  /** Every step in time order (plan.ts reads these). */
  steps: RealizedStep[];
  /** Wanted vibrato over the take (straight/bloom/switch drills): analyzeSwitch's cue plan. Empty when the exercise has none. */
  vibratoPlan: Array<{ start: number; end: number; vibrato: boolean }>;
  /** Inflection figures in the inflection analyzer's target convention: analyzeInflection(track, kind, notes, ctx). */
  inflections: Array<{ kind: InflectionKind; notes: TargetNote[] }>;
  /** Pulse/oscillation target in cycles per second for analyzePulse; null when the exercise doesn't score pulses. */
  pulseHz: number | null;
}

export interface RealizeOptions {
  /** Tempo override (a runs tempo-ladder rung, a slowed demo). Default def.tempoBpm. */
  bpm?: number;
}

function validRange(r: { low: number; high: number } | null | undefined): r is MidiRange {
  return !!r && Number.isFinite(r.low) && Number.isFinite(r.high) && r.low <= r.high;
}

/** Integer range inside the given (possibly fractional) bounds, or null if empty. */
function inner(r: MidiRange): MidiRange | null {
  const low = Math.ceil(r.low - EPS);
  const high = Math.floor(r.high + EPS);
  return low <= high ? { low, high } : null;
}

/** The ranges actually used: the saved range when valid (comfortable kept inside extended), else the voice default. */
export function effectiveRange(range: VocalRange | null, voiceType: VoiceType): { comfortable: MidiRange; extended: MidiRange; saved: boolean } {
  const d = DEFAULT_RANGES[voiceType] ?? DEFAULT_RANGES.unknown;
  const com = range && validRange(range.comfortable) ? inner(range.comfortable) : null;
  const ext = range && validRange(range.extended) ? inner(range.extended) : null;
  if (!com && !ext) return { comfortable: { ...d }, extended: { ...d }, saved: false };
  const c = com ?? ext!;
  const e = ext ?? com!;
  return { comfortable: c, extended: { low: Math.min(e.low, c.low), high: Math.max(e.high, c.high) }, saved: true };
}

/**
 * Saved range from a range-finder measurement (lowest/highest notes held
 * cleanly, RangeResult). Extended = the measured extremes (clamped to the
 * supported E2-C6); comfortable = trimmed inside them. Null if unusable.
 */
export function rangeFromMeasurement(lowestMidi: number | null, highestMidi: number | null, measuredAt: string): VocalRange | null {
  if (lowestMidi === null || highestMidi === null || !Number.isFinite(lowestMidi) || !Number.isFinite(highestMidi)) return null;
  const clamp = (m: number) => Math.min(SUPPORTED.high, Math.max(SUPPORTED.low, Math.round(m)));
  const low = clamp(Math.min(lowestMidi, highestMidi));
  const high = clamp(Math.max(lowestMidi, highestMidi));
  let cl = low + COMFORT_TRIM_LOW;
  let ch = high - COMFORT_TRIM_HIGH;
  if (ch - cl < MIN_COMFORT_SPAN) {
    const width = high - low;
    if (width <= MIN_COMFORT_SPAN) {
      cl = low;
      ch = high;
    } else {
      // Keep the 2:3 trim ratio but leave at least MIN_COMFORT_SPAN.
      cl = low + Math.floor(((width - MIN_COMFORT_SPAN) * COMFORT_TRIM_LOW) / (COMFORT_TRIM_LOW + COMFORT_TRIM_HIGH));
      ch = cl + MIN_COMFORT_SPAN;
    }
  }
  return { comfortable: { low: cl, high: ch }, extended: { low, high }, measuredAt };
}

/** True for range/top-end material: the kind lives at the voice's edges, or the pattern contains a register flip. */
export function usesExtendedRange(def: Pick<ExerciseDef, 'kind' | 'pattern'>): boolean {
  return TOP_END_KINDS.has(def.kind) || def.pattern.some((s) => s.cue === CUE.flip);
}

/** Number of pattern repetitions (>= 1). */
export function repeatCount(def: Pick<ExerciseDef, 'repeats'>): number {
  return Math.max(1, Math.floor(def.repeats?.count ?? 1));
}

/** Lowest and highest semitone offsets from the tonic over all repeats (glide targets and Listen steps included). */
export function materialSpan(def: Pick<ExerciseDef, 'pattern' | 'repeats'>): { lo: number; hi: number } {
  const count = repeatCount(def);
  const stepSemis = def.repeats?.stepSemis ?? 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let r = 0; r < count; r++) {
    const shift = r * stepSemis;
    for (const s of def.pattern) {
      if (s.semis === undefined) continue;
      const a = s.semis + shift;
      if (a < lo) lo = a;
      if (a > hi) hi = a;
      if (s.glideToSemis !== undefined) {
        const b = s.glideToSemis + shift;
        if (b < lo) lo = b;
        if (b > hi) hi = b;
      }
    }
  }
  return lo === Infinity ? { lo: 0, hi: 0 } : { lo, hi };
}

/** Centre of the passaggio for this voice (MIDI, may be fractional). */
export function passaggioCentre(voiceType: VoiceType, comfortable: MidiRange): number {
  const z = PASSAGGIO_ZONE[voiceType];
  return z ? (z.low + z.high) / 2 : comfortable.high - PASSAGGIO_BELOW_COMFORT_TOP;
}

function desiredTonic(p: TonicPlacement, r: MidiRange, voiceType: VoiceType, comfortable: MidiRange, lo: number, hi: number): number {
  const matCentre = (lo + hi) / 2;
  if (p === 'passaggio') return passaggioCentre(voiceType, comfortable) - matCentre;
  const at = r.low + PLACEMENT_FRACTION[p] * (r.high - r.low);
  return p === 'mid' ? at : at - matCentre;
}

/** Integer tonic nearest `desired` that keeps [lo, hi] inside `r`, or null if it can't fit. */
function placeIn(r: MidiRange, lo: number, hi: number, desired: number): number | null {
  const tMin = Math.ceil(r.low - lo - EPS);
  const tMax = Math.floor(r.high - hi + EPS);
  if (tMin > tMax) return null;
  const t = Math.round(desired);
  return t < tMin ? tMin : t > tMax ? tMax : t;
}

/** Octave-fold a pitch into `r`; clamp when `r` is narrower than an octave. */
function fold(m: number, r: MidiRange): number {
  let x = m;
  while (x > r.high) x -= 12;
  while (x < r.low) x += 12;
  return x > r.high ? r.high : x;
}

/**
 * Lay out `def` for a singer. `range` null = not measured yet (voice-type
 * default). `opts.bpm` overrides the tempo (tempo ladders, slowed demos).
 */
export function realize(def: ExerciseDef, range: VocalRange | null, voiceType: VoiceType, opts?: RealizeOptions): RealizedExercise {
  const bpm = opts?.bpm !== undefined && opts.bpm > 0 ? opts.bpm : def.tempoBpm;
  const spb = 60 / bpm;
  const count = repeatCount(def);
  const stepSemis = def.repeats?.stepSemis ?? 0;
  const { lo, hi } = materialSpan(def);
  const ranges = effectiveRange(range, voiceType);
  const topEnd = usesExtendedRange(def);
  const primary = topEnd ? ranges.extended : ranges.comfortable;

  let fit: RealizedExercise['fit'] = 'fits';
  let used = primary;
  let tonic = placeIn(primary, lo, hi, desiredTonic(def.tonicPlacement, primary, voiceType, ranges.comfortable, lo, hi));
  if (tonic === null && !topEnd) {
    used = ranges.extended;
    tonic = placeIn(used, lo, hi, desiredTonic(def.tonicPlacement, used, voiceType, ranges.comfortable, lo, hi));
    if (tonic !== null) fit = 'extended';
  }
  if (tonic === null) {
    used = ranges.extended;
    fit = 'folded';
  }
  const tonicMidi = tonic ?? Math.round((used.low + used.high) / 2 - (lo + hi) / 2);
  const into = used;
  const folded = fit === 'folded';
  const place = (semis: number) => (folded ? fold(tonicMidi + semis, into) : tonicMidi + semis);

  const steps: RealizedStep[] = [];
  const notes: TargetNote[] = [];
  const reference: TargetNote[] = [];
  const cues: Array<{ t: number; text: string }> = [];
  let t = 0;
  for (let r = 0; r < count; r++) {
    const shift = r * stepSemis;
    for (let i = 0; i < def.pattern.length; i++) {
      const s = def.pattern[i];
      const start = t;
      const end = t + s.beats * spb;
      t = end;
      const step: RealizedStep = {
        index: i,
        rep: r,
        role: s.semis === undefined ? 'rest' : s.cue === CUE.listen ? 'listen' : 'sing',
        start,
        end,
      };
      if (s.semis !== undefined) step.midi = place(s.semis + shift);
      if (s.semis !== undefined && s.glideToSemis !== undefined) step.toMidi = place(s.glideToSemis + shift);
      if (s.cue !== undefined) {
        step.cue = s.cue;
        cues.push({ t: start, text: s.cue });
      }
      if (s.syllable !== undefined) step.syllable = s.syllable;
      steps.push(step);
      if (step.role === 'rest') continue;
      const n: TargetNote = { midi: step.midi!, start, end };
      if (step.toMidi !== undefined) n.toMidi = step.toMidi;
      if (step.syllable !== undefined) n.lyric = step.syllable;
      (step.role === 'listen' ? reference : notes).push(n);
    }
  }

  // Starting pitches: during the count-in, and in the closing rest before each new key.
  const hasListen = steps.some((s) => s.role === 'listen');
  const countInSec = Math.max(0, def.countInBeats) * spb;
  if (!hasListen) {
    const perRep = def.pattern.length;
    const lastIsRest = perRep > 0 && def.pattern[perRep - 1].semis === undefined;
    for (let r = 0; r < count; r++) {
      const first = steps.slice(r * perRep, (r + 1) * perRep).find((s) => s.role === 'sing');
      if (!first) continue;
      // Aim at the note itself: a scoop's landing, not its start.
      const midi = first.cue === CUE.scoop && first.toMidi !== undefined ? first.toMidi : first.midi!;
      if (r === 0 && countInSec > 0) reference.push({ midi, start: -countInSec, end: 0 });
      else if (r > 0 && stepSemis !== 0 && lastIsRest) {
        const restStep = steps[r * perRep - 1];
        reference.push({ midi, start: restStep.start, end: restStep.end });
      }
    }
    reference.sort((a, b) => a.start - b.start);
  }

  const plan = planAnalysis({ steps });
  return {
    exerciseId: def.id,
    tonicMidi,
    bpm,
    countInSec,
    notes,
    reference,
    cues,
    totalSec: t,
    range: { ...used },
    fit,
    steps,
    vibratoPlan: plan.vibratoPlan,
    inflections: plan.inflections.map((g) => ({ kind: g.kind, notes: g.targets })),
    pulseHz: def.analyzers.includes('pulse') && plan.pulses.length > 0 ? plan.pulses[0].rateHz : null,
  };
}
