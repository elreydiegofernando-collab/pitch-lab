/**
 * Song-phrase scoring (SPEC 10 / 12): per SongPhrase, a pitch score (optionally
 * octave-agnostic), the share of the phrase spent in tolerance, a timing offset from
 * banded DTW, the stability of long notes, and whether vibrato showed up.
 *
 * `scoreSongPhrases` takes a track that is take-relative AND latency-compensated (t = 0 is
 * song time 0). The DTW runs on it as given, so the timing offset it reports is the singer's
 * own, not the system's. `scoreSongTake` is the one-call path from raw engine frames: it
 * removes the latency with `toTakeRelative` (analysis/track.ts) and then scores. Use one or
 * the other; never compensate twice.
 *
 * Method.
 *  - One DTW over every scorable note of the requested phrases (corridor
 *    CONFIG.song.dtwBandMs), not one per phrase, so a phrase cannot steal the first frames
 *    of the next, and the alignment stays monotone across phrase breaks.
 *  - Octave-agnostic scoring (default CONFIG.song.octaveAgnostic) folds each sung pitch to
 *    the octave nearest its target before measuring cents, in the DTW cost and in the
 *    scores: singing a man's melody an octave up or down is not an error.
 *  - Freestyle and rap notes have no pitch to score and are skipped (see `phraseIsScorable`).
 *  - Scores are COVERAGE-AWARE. Each note's score is the sum of its frames' scores divided
 *    by the number of frames it should have had (its duration less ONSET_ALLOWANCE_MS for
 *    consonants and voicing onset), capped at 1, so a note sung for half its length scores
 *    half, and silence scores zero. A frame scores 1 at 0 cents and falls linearly to 0 at
 *    2.5 tolerances. Notes weigh by duration.
 *  - inTolerancePct is likewise the in-tolerance share of the expected note time.
 *  - Stability is the standard deviation of cents WITHIN each long note (about its own
 *    mean, onset skipped), pooled over the phrase: bias is accuracy's business, and
 *    vibrato, if present, is reported separately rather than hidden inside the SD.
 *  - Vibrato presence comes from the real analyzer (analyzeVibrato) on each long note.
 *
 * Knobs below are PROVISIONAL local stand-ins for CONFIG entries that do not exist yet.
 */
import type { PitchFrame, PitchTrack } from '../core/types';
import type { AnalyzeContext, PhraseScore } from './types';
import type { SongNote, SongPhrase } from '../song/types';
import { CONFIG } from '../config';
import { clamp01 } from '../core/math';
import { frameRange, medianRange, medianSpacing, toTakeRelative } from './track';
import { alignNotesDtw, foldToNearestOctave, octaveFoldedDistance, type DtwNote } from './dtw';
import { analyzeVibrato } from './vibrato';
import { voicedContour } from './segment';

/** Time at the start of each note not counted against coverage: consonants and the detector's voicing onset. */
const ONSET_ALLOWANCE_MS = 50;
/** A frame's pitch score reaches 0 at this many tolerances. */
const ACCURACY_ZERO_TOLERANCES = 2.5;
/** Notes at least this long are measured for stability and vibrato. */
const LONG_NOTE_SEC = 0.75;
/** Fewest frames (after the onset skip) a long note needs to contribute a stability SD. */
const MIN_STABILITY_FRAMES = 8;
/** A note's onset offset only feeds the timing median if its pitch level was within this of the target. */
const TIMING_MAX_LEVEL_ERROR_CENTS = 100;
const FALLBACK_DT_SEC = 512 / 48000;

export interface ScorePhrasesOptions {
  /** Fold the sung pitch to the octave nearest each target before scoring. Default CONFIG.song.octaveAgnostic. */
  octaveAgnostic?: boolean;
  /** DTW corridor half-width, ms. Default CONFIG.song.dtwBandMs. */
  bandMs?: number;
}

function isPitched(n: SongNote): boolean {
  return n.type === 'normal' || n.type === 'golden';
}

/** True if the phrase has at least one pitched (normal or golden) note; rap/freestyle-only phrases cannot be pitch-scored. */
export function phraseIsScorable(notes: readonly SongNote[], phrase: SongPhrase): boolean {
  for (let i = Math.max(0, phrase.from); i < Math.min(phrase.to, notes.length); i++) if (isPitched(notes[i])) return true;
  return false;
}

/** scoreSongPhrases(track, notes, phrases, ctx, opts?) - one PhraseScore per `phrases` entry, in order. */
export function scoreSongPhrases(
  track: PitchTrack,
  notes: readonly SongNote[],
  phrases: readonly SongPhrase[],
  ctx: AnalyzeContext,
  opts: ScorePhrasesOptions = {},
): PhraseScore[] {
  const octaveAgnostic = opts.octaveAgnostic ?? CONFIG.song.octaveAgnostic;
  const bandMs = opts.bandMs ?? CONFIG.song.dtwBandMs;
  const tol = ctx.toleranceCents > 0 ? ctx.toleranceCents : CONFIG.tolerance.default;

  // The notes to align: every pitched note of every requested phrase, once, in song order.
  const needed = new Uint8Array(notes.length);
  for (const ph of phrases) {
    for (let i = Math.max(0, ph.from); i < Math.min(ph.to, notes.length); i++) if (isPitched(notes[i])) needed[i] = 1;
  }
  const dtwIndex = new Int32Array(notes.length).fill(-1);
  const dtwNotes: DtwNote[] = [];
  for (let i = 0; i < notes.length; i++) {
    if (needed[i] === 0) continue;
    dtwIndex[i] = dtwNotes.length;
    dtwNotes.push({ midi: notes[i].midi, start: notes[i].start, end: notes[i].start + notes[i].duration });
  }

  const alignment = alignNotesDtw(track, dtwNotes, { bandMs, pitchDistanceCents: octaveAgnostic ? octaveFoldedDistance : undefined });
  const c = voicedContour(track);
  const dtRaw = medianSpacing(c.t);
  const dt = Number.isFinite(dtRaw) && dtRaw > 0 ? dtRaw : FALLBACK_DT_SEC;
  const m = dtwNotes.length;
  const first = new Int32Array(m).fill(-1);
  const last = new Int32Array(m).fill(-1);
  for (let k = 0; k < c.length; k++) {
    const j = alignment.frameToNote[c.index[k]];
    if (j < 0) continue;
    if (first[j] < 0) first[j] = k;
    last[j] = k;
  }

  const signedCents = (smooth: number, target: number): number =>
    ((octaveAgnostic ? foldToNearestOctave(smooth, target) : smooth) - target) * 100;

  // Per-note results, computed lazily as phrases ask for them (a note belongs to one phrase, but be safe if phrases overlap).
  interface NoteScore {
    score: number;
    inTol: number;
    offsetMs: number | null;
    weight: number;
  }
  const cache = new Map<number, NoteScore>();
  const scoreNote = (i: number): NoteScore => {
    const hit = cache.get(i);
    if (hit) return hit;
    const note = notes[i];
    const j = dtwIndex[i];
    const expected = Math.max(1, (note.duration - ONSET_ALLOWANCE_MS / 1000) / dt);
    let sumScore = 0;
    let inTol = 0;
    const levelError: number[] = [];
    if (first[j] >= 0) {
      for (let k = first[j]; k <= last[j]; k++) {
        const e = signedCents(c.smooth[k], note.midi);
        sumScore += clamp01(1 - Math.abs(e) / (ACCURACY_ZERO_TOLERANCES * tol));
        if (Math.abs(e) <= tol) inTol++;
        levelError.push(e);
      }
    }
    const frames = levelError.length;
    const level = frames > 0 ? medianRange(levelError, 0, frames) : NaN;
    const offset = alignment.onsetOffsetMs[j];
    const usableOffset = frames >= 3 && Number.isFinite(level) && Math.abs(level) <= TIMING_MAX_LEVEL_ERROR_CENTS ? offset : null;
    const result = {
      score: Math.min(1, sumScore / expected),
      inTol: Math.min(1, inTol / expected),
      offsetMs: usableOffset,
      weight: note.duration,
    };
    cache.set(i, result);
    return result;
  };

  return phrases.map((ph, phraseIndex): PhraseScore => {
    const empty: PhraseScore = { phraseIndex, start: ph.start, end: ph.end, pitchScore: 0, inTolerancePct: 0, timingOffsetMs: null, stabilitySdCents: null, vibratoPresent: false };
    let weightSum = 0;
    let scoreSum = 0;
    let inTolSum = 0;
    const offsets: number[] = [];
    let varNumerator = 0;
    let varFrames = 0;
    let vibrato = false;

    for (let i = Math.max(0, ph.from); i < Math.min(ph.to, notes.length); i++) {
      if (dtwIndex[i] < 0) continue;
      const ns = scoreNote(i);
      weightSum += ns.weight;
      scoreSum += ns.weight * ns.score;
      inTolSum += ns.weight * ns.inTol;
      if (ns.offsetMs !== null) offsets.push(ns.offsetMs);

      const note = notes[i];
      if (note.duration < LONG_NOTE_SEC) continue;
      const win = frameRange(track, note.start, note.start + note.duration);
      const slice: PitchTrack = track.slice(win.lo, win.hi);
      if (!vibrato) vibrato = analyzeVibrato(slice, { midi: note.midi, start: note.start, end: note.start + note.duration }, ctx).present;
      const skipUntil = note.start + CONFIG.accuracy.holdStartSkipMs / 1000;
      const errs: number[] = [];
      for (const f of slice as readonly PitchFrame[]) {
        if (f.voiced && Number.isFinite(f.midi) && f.t >= skipUntil) errs.push(signedCents(f.midi, note.midi));
      }
      if (errs.length >= MIN_STABILITY_FRAMES) {
        let mean = 0;
        for (const e of errs) mean += e;
        mean /= errs.length;
        let ss = 0;
        for (const e of errs) ss += (e - mean) * (e - mean);
        varNumerator += ss; // sum of squares about the note's own mean = n * variance
        varFrames += errs.length;
      }
    }
    if (weightSum === 0) return empty;
    return {
      phraseIndex,
      start: ph.start,
      end: ph.end,
      pitchScore: clamp01(scoreSum / weightSum),
      inTolerancePct: (100 * inTolSum) / weightSum,
      timingOffsetMs: offsets.length > 0 ? medianRange(offsets, 0, offsets.length) : null,
      stabilitySdCents: varFrames > 0 ? Math.sqrt(varNumerator / varFrames) : null,
      vibratoPresent: vibrato,
    };
  });
}

/**
 * scoreSongTake(frames, songStartT, latencyMs, notes, phrases, ctx, opts?) - scores raw engine frames
 * (AudioContext time): the song started at `songStartT`, and `latencyMs` is the round trip from
 * LatencyCalibration. Latency is removed first, so the timing offset reported is the singer's own.
 */
export function scoreSongTake(
  frames: readonly PitchFrame[],
  songStartT: number,
  latencyMs: number,
  notes: readonly SongNote[],
  phrases: readonly SongPhrase[],
  ctx: AnalyzeContext,
  opts: ScorePhrasesOptions = {},
): PhraseScore[] {
  return scoreSongPhrases(toTakeRelative(frames, songStartT, latencyMs), notes, phrases, ctx, opts);
}
