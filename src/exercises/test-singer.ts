/**
 * Test helper: a synthetic singer that "sings" a RealizedExercise into a
 * take-relative PitchTrack (analysis/fixtures.ts makeTrack), so tests can run
 * an exercise end to end through the real analyzers. It follows the cues: it
 * scoops into attacks and settles, moves between connected notes in a few
 * tens of ms, follows glides, sings vibrato where vibrato is wanted, pulses
 * pulse trains, shapes loudness for crescendo/decrescendo/swell/step cues,
 * fades falls, and breathes before rests. Not used by the app.
 */
import type { PitchFrame } from '../core/types';
import { centsFromNearest, midiToHz } from '../core/music';
import { makeTrack } from '../analysis/fixtures';
import { loudnessContourOf, type LoudnessContour } from './cues';
import { contourAt } from './loudness';
import { planAnalysis } from './plan';
import type { RealizedExercise, RealizedStep } from './transpose';

export interface SingerModel {
  /** Constant pitch offset, cents (+ sharp). */
  biasCents: number;
  /** Frame-to-frame pitch jitter, cents RMS. */
  jitterCents: number;
  /** An attack starts this many cents below the note ... */
  scoopCents: number;
  /** ... and closes the gap with this time constant (ms). */
  settleTauMs: number;
  /** Connected note changes take this long (ms). */
  transitionMs: number;
  /** Vibrato sung where the cues ask for it (null = always straight). */
  vibrato: { rateHz: number; extentCents: number } | null;
  /** Vibrato on every held note of at least 1 s when the exercise has no vibrato cues (a singer with natural vibrato). */
  vibratoEverywhere?: boolean;
  /** With vibratoEverywhere: keep the vibrato going through Straight cues too. */
  vibratoIgnoresCues?: boolean;
  /** Never change loudness (ignores crescendo, swell and step cues). */
  flatLoudness?: boolean;
  /**
   * Change loudness against the cues, by as much as a good singer follows them: 'invert' sings every cued
   * contour upside down (a crescendo as a decrescendo, a swell loud-soft-loud, soft/loud steps swapped);
   * 'crescendo' / 'decrescendo' ignore the cue and ramp one way on every cued hold.
   */
  loudnessAgainstCues?: 'invert' | 'crescendo' | 'decrescendo';
  /** Take times where the voice breaks: 60 ms of no pitch. */
  breaks?: readonly number[];
  /** Pitch swing of each pulse in a pulse train, cents. */
  pulseCents: number;
  /** Cents per dB of loudness change (0 = steady; + = sharp when loud). */
  centsPerDb: number;
  /** The loudness (dB) at which that singer is in tune (default: a normal level). */
  inTuneAtDb?: number;
  /** Share of a note before a rest that is voiced (the rest is a breath). */
  releaseFraction: number;
  /** Sing everything this many semitones off (a wrong-note singer). */
  offsetSemis?: number;
  /** Sing nothing at all. */
  silent?: boolean;
  seed?: number;
}

export const GOOD_SINGER: SingerModel = {
  biasCents: 2,
  jitterCents: 3,
  scoopCents: 12,
  settleTauMs: 25,
  transitionMs: 40,
  vibrato: { rateHz: 5.8, extentCents: 35 },
  pulseCents: 60,
  centsPerDb: 0,
  releaseFraction: 0.93,
};

export const POOR_SINGER: SingerModel = {
  biasCents: 45,
  jitterCents: 12,
  scoopCents: 120,
  settleTauMs: 250,
  transitionMs: 250,
  vibrato: null,
  pulseCents: 0,
  centsPerDb: 4,
  releaseFraction: 0.6,
};

/** Loudness levels the singer uses (dBFS). */
export const SINGER_DB = { loud: -14, soft: -38, normal: -20 } as const;
const LOUD_DB = SINGER_DB.loud;
const SOFT_DB = SINGER_DB.soft;
const NORMAL_DB = SINGER_DB.normal;
const SILENT_DB = -80;
const ATTACK_RISE_SEC = 0.1;
const BREAK_SEC = 0.06;

/** The contour a singer actually follows on a hold cued with `asked`. */
function sungContour(asked: LoudnessContour, against: SingerModel['loudnessAgainstCues']): LoudnessContour {
  if (against === 'invert') return { ...asked, points: asked.points.map((p) => (p === 'loud' ? 'soft' : 'loud')) };
  if (against === 'crescendo') return { points: ['soft', 'loud'], smooth: true };
  if (against === 'decrescendo') return { points: ['loud', 'soft'], smooth: true };
  return asked;
}

/** A take of `realized` sung by `singer`, from 0.5 s before the downbeat to 0.5 s after the end. */
export function singTake(realized: RealizedExercise, singer: SingerModel): PitchFrame[] {
  const t0 = -0.5;
  const duration = realized.totalSec + 1;
  if (singer.silent) return makeTrack({ duration, t0, midi: () => NaN, seed: singer.seed });
  const plan = planAnalysis(realized);
  const sung = realized.steps.filter((s) => s.role === 'sing');
  const offset = (singer.offsetSemis ?? 0) + singer.biasCents / 100;

  // Per sung step: its hold (for loudness shapes and vibrato), and whether it starts a phrase or ends one before a rest.
  const holdOf = new Map<RealizedStep, (typeof plan.holds)[number]>();
  for (const h of plan.holds) for (const s of h.steps) holdOf.set(s, h);
  const opens = new Set(plan.phrases.map((p) => p.steps[0]));
  const closes = new Set(plan.phrases.map((p) => p.steps[p.steps.length - 1]));
  const prevOf = new Map<RealizedStep, RealizedStep>();
  for (const p of plan.phrases) for (let i = 1; i < p.steps.length; i++) prevOf.set(p.steps[i], p.steps[i - 1]);
  const pulseTrains = plan.pulses.filter((p) => p.notes.length === 1);
  const wantVibrato = (t: number) => plan.vibratoPlan.some((w) => w.vibrato && t >= w.start && t < w.end);
  const vibratoStart = (t: number) => plan.vibratoPlan.find((w) => w.vibrato && t >= w.start && t < w.end)?.start ?? 0;

  const stepAt = (t: number): RealizedStep | undefined => {
    let lo = 0;
    let hi = sung.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (sung[m].end <= t) lo = m + 1;
      else if (sung[m].start > t) hi = m - 1;
      else return sung[m];
    }
    return undefined;
  };

  const levelAt = (s: RealizedStep, t: number): number => {
    const h = holdOf.get(s);
    const span = h ? h.note : { start: s.start, end: s.end };
    const u = (t - span.start) / Math.max(1e-6, span.end - span.start);
    let db: number = NORMAL_DB;
    if (singer.flatLoudness) return db;
    const asked = loudnessContourOf(h?.steps.find((x) => x.cue !== undefined)?.cue);
    if (asked) db = SOFT_DB + (LOUD_DB - SOFT_DB) * contourAt(sungContour(asked, singer.loudnessAgainstCues), u);
    if (s.toMidi !== undefined && s.toMidi < s.midi! && prevOf.get(s)?.cue !== undefined && /fall/i.test(prevOf.get(s)!.cue!)) {
      db = NORMAL_DB + (SOFT_DB - 10 - NORMAL_DB) * ((t - s.start) / (s.end - s.start)); // a fall fades as it drops
    }
    if (opens.has(h?.steps[0] ?? s) && t - span.start < ATTACK_RISE_SEC) db = SILENT_DB + (db - SILENT_DB) * Math.max(0.05, (t - span.start) / ATTACK_RISE_SEC);
    return db;
  };

  const midiAt = (t: number): number => {
    const s = stepAt(t);
    if (!s) return NaN;
    if (singer.breaks?.some((b) => t >= b && t < b + BREAK_SEC)) return NaN;
    // Breathe before a rest: release a plain note early (a glide is always completed).
    if (s.toMidi === undefined && closes.has(s) && t > s.start + (s.end - s.start) * singer.releaseFraction && sung[sung.indexOf(s) + 1]?.start !== s.end) return NaN;
    let m: number;
    if (s.toMidi !== undefined) {
      m = s.midi! + (s.toMidi - s.midi!) * ((t - s.start) / (s.end - s.start));
    } else {
      m = s.midi!;
      const h = holdOf.get(s);
      const holdStart = h ? h.note.start : s.start;
      const prev = h ? prevOf.get(h.steps[0]) : prevOf.get(s);
      const since = t - holdStart;
      if (!prev && since >= 0) {
        m -= (singer.scoopCents / 100) * Math.exp(-(since * 1000) / singer.settleTauMs); // attack: scoop in and settle
      } else if (prev && since * 1000 < singer.transitionMs) {
        const from = prev.toMidi ?? prev.midi!;
        m = from + (m - from) * ((since * 1000) / singer.transitionMs); // connected change
      }
      const train = pulseTrains.find((p) => t >= p.notes[0].start && t < p.notes[0].end);
      if (train && singer.pulseCents > 0) m += (singer.pulseCents / 100) * Math.max(0, Math.sin(2 * Math.PI * train.rateHz * (t - train.notes[0].start)));
      const longHold = h !== undefined && h.note.end - h.note.start >= 1;
      const cued = plan.vibratoPlan.length > 0 && !singer.vibratoIgnoresCues;
      const vib = cued ? wantVibrato(t) : !!singer.vibratoEverywhere && longHold && !train;
      if (vib && singer.vibrato) {
        const from = cued ? vibratoStart(t) : holdStart;
        m += (singer.vibrato.extentCents / 100) * Math.sin(2 * Math.PI * singer.vibrato.rateHz * (t - from));
      }
    }
    const db = levelAt(s, t);
    return m + offset + (singer.centsPerDb * (db - (singer.inTuneAtDb ?? NORMAL_DB))) / 100;
  };

  return makeTrack({
    duration,
    t0,
    midi: midiAt,
    rmsDb: (t) => {
      const s = stepAt(t);
      return s && Number.isFinite(midiAt(t)) ? levelAt(s, t) : SILENT_DB;
    },
    jitterCents: singer.jitterCents,
    seed: singer.seed ?? 4242,
  });
}

/**
 * Lazy-singer strategies on a finished take (negative controls: each must fail what it skips). `unvoiced` is a singer who
 * was not singing in [from, to): came in late, stopped early, never sang that figure. Frames are replaced, not removed, so
 * the track keeps its frame grid.
 */
export function unvoiced(track: readonly PitchFrame[], from: number, to: number): PitchFrame[] {
  return track.map((f) => (f.t >= from && f.t < to ? { ...f, voiced: false, midi: NaN, f0Hz: NaN, centsFromNearest: NaN, confidence: 0.1, rmsDb: -80 } : f));
}

/** A singer who sang a plain note at `midi` in [from, to) instead of what was asked there (a scoop, fall, slide, turn or flip skipped). */
export function flattened(track: readonly PitchFrame[], from: number, to: number, midi: number): PitchFrame[] {
  return track.map((f) => (f.t >= from && f.t < to && f.voiced ? { ...f, midi, f0Hz: midiToHz(midi), centsFromNearest: centsFromNearest(midi) } : f));
}
