/**
 * The pure rules behind the Live and Vibrato meter readouts: given a recent window of frames, what is the vibrato, and how
 * did the last note start. They run a few times a second on a window the controller built (live-analysis.ts), never on
 * the audio thread or per frame, and they call the same analyzers that score a take, so what the singer watches is what
 * the report would say.
 */
import { analyzeOnset } from '../../analysis/onset';
import { median } from '../../analysis/track';
import type { VibratoFlag } from '../../analysis/types';
import { analyzeVibrato } from '../../analysis/vibrato';
import type { PitchFrame, VibratoStyle } from '../../core/types';

/** A vibrato reading needs at least this many voiced frames in its window (about 0.4 s of singing). */
export const MIN_VOICED_FRAMES = 40;
/** The onset analysis looks this far past the onset, and starts this far before it (the analyzer's own lookback). */
const ONSET_SPAN_SEC = 1.2;
/** The note an onset landed on is read from this slice after the onset (the pitch has settled by then). */
const LANDING_FROM_SEC = 0.3;
const LANDING_TO_SEC = 0.9;
const MIN_LANDING_FRAMES = 8;

export interface ReadingContext {
  toleranceCents: number;
  vibratoStyle: VibratoStyle;
}

export interface VibratoReading {
  present: boolean;
  /** Only when a vibrato is present. */
  rateHz: number | null;
  /** Half peak-to-trough; for a straight tone the residual wobble, when measurable. */
  extentCents: number | null;
  /** Mean of the oscillation against the nearest note (+ sharp); null when not measurable. */
  centeringCents: number | null;
  /** Rate and extent both inside the style's zone. */
  inZone: boolean;
  flags: VibratoFlag[];
}

export interface OnsetReading {
  state: 'settling' | 'settled';
  /** ms from onset until the pitch stayed in tolerance; null = it never settled. */
  settleMs: number | null;
  /** Cents below the note in the first 150 ms (0 = none). */
  scoopCents: number;
  /** Where the note began, input timeline. */
  onsetT: number;
}

export function voicedCount(frames: readonly PitchFrame[]): number {
  let n = 0;
  for (const f of frames) if (f.voiced) n++;
  return n;
}

/** The nearest note to the middle of what was sung in [fromT, toT], or null when too little was voiced. */
export function nearestNote(frames: readonly PitchFrame[], fromT: number, toT: number): number | null {
  const midis: number[] = [];
  for (const f of frames) if (f.voiced && Number.isFinite(f.midi) && f.t >= fromT && f.t <= toT) midis.push(f.midi);
  return midis.length >= MIN_LANDING_FRAMES ? Math.round(median(midis)) : null;
}

/**
 * Vibrato over a sliding window of free singing. With no target, the note it is measured against is the nearest one to
 * the sung pitch, so `centeringCents` says how far the oscillation's centre sits from that note. Null when the window
 * holds too little singing to judge.
 */
export function readVibrato(window: readonly PitchFrame[], ctx: ReadingContext): VibratoReading | null {
  if (window.length === 0 || voicedCount(window) < MIN_VOICED_FRAMES) return null;
  const start = window[0].t;
  const end = window[window.length - 1].t;
  const midi = nearestNote(window, start, end);
  if (midi === null) return null;
  const result = analyzeVibrato(window, { midi, start, end: end + 1e-6 }, ctx, { windows: false });
  return {
    present: result.present,
    rateHz: result.rateHz,
    extentCents: result.extentCents,
    centeringCents: result.centeringCents,
    inZone: result.inZone,
    flags: result.flags,
  };
}

/**
 * How a note began. `onsetT` is where the voice started after silence. While the note is younger than the landing slice
 * it is still 'settling'; once there is enough of it, the analyzer reports the settle time and the scoop against the
 * note it landed on (`targetMidi` when the singer picked one, else the nearest note to what they sang). Null when the
 * note was too short to read.
 */
export function readOnset(window: readonly PitchFrame[], onsetT: number, targetMidi: number | null, ctx: ReadingContext, ended: boolean): OnsetReading | null {
  const latest = window.length > 0 ? window[window.length - 1].t : onsetT;
  if (!ended && latest - onsetT < LANDING_TO_SEC) return { state: 'settling', settleMs: null, scoopCents: 0, onsetT };
  const midi = targetMidi ?? nearestNote(window, onsetT + LANDING_FROM_SEC, onsetT + LANDING_TO_SEC);
  if (midi === null) return null;
  const result = analyzeOnset(window, { midi, start: onsetT, end: onsetT + ONSET_SPAN_SEC }, { toleranceCents: ctx.toleranceCents, vibratoStyle: ctx.vibratoStyle });
  if (result.onsetT === null) return null;
  return { state: 'settled', settleMs: result.settleMs, scoopCents: Math.max(0, result.scoopCents), onsetT: result.onsetT };
}

/** The same reading to the precision it is shown at, so a chip is not re-rendered for a change nobody can see. */
export function sameVibrato(a: VibratoReading | null, b: VibratoReading | null): boolean {
  if (a === null || b === null) return a === b;
  const r = (x: number | null, step: number): number | null => (x === null ? null : Math.round(x / step));
  return (
    a.present === b.present &&
    a.inZone === b.inZone &&
    r(a.rateHz, 0.1) === r(b.rateHz, 0.1) &&
    r(a.extentCents, 1) === r(b.extentCents, 1) &&
    r(a.centeringCents, 1) === r(b.centeringCents, 1) &&
    a.flags.length === b.flags.length &&
    a.flags.every((f, i) => f === b.flags[i])
  );
}

export function sameOnset(a: OnsetReading | null, b: OnsetReading | null): boolean {
  if (a === null || b === null) return a === b;
  return a.state === b.state && a.settleMs === b.settleMs && Math.round(a.scoopCents) === Math.round(b.scoopCents) && a.onsetT === b.onsetT;
}
