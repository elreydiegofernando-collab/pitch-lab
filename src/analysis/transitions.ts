/**
 * Note-to-note transition analysis (SPEC 8.4), for legato lines and interval work.
 * For each pair of adjacent target notes A -> B it reports the time from leaving
 * A's band to settling in B's, how far the voice overshot B on the way, and whether
 * the change was "clean": no overshoot beyond tolerance, inside a tempo-relative time
 * budget.
 *
 * Method.
 *  - Bands. "In A's band" / "in B's band" use max(tolerance, CONFIG.tolerance.default):
 *    at studio level (+/-10 c) a voice's natural scatter would otherwise leave the band
 *    constantly and no transition could ever be timed. Bands are shrunk if two notes are
 *    closer than two band widths.
 *  - Settle. The first run, after A has been established, that stays in B's band for
 *    min(CONFIG.onset.settleHoldMs, half of B) - the same hold as onset settling.
 *  - Leave. The last in-band frame of A before that settle. Walking back from the settle
 *    (rather than forward from A's start) means wobble early in A is not mistaken for the
 *    start of the transition, and a breath or silence between the notes counts as
 *    transition time (a broken legato line is not clean).
 *  - Overshoot. The largest excursion past B in the direction of travel while moving,
 *    measured beyond the pitch the singer actually settled on: landing consistently 15 c
 *    sharp is an accuracy matter (analyzeAccuracy), not an overshoot.
 *  - Budget. docs/RESEARCH.md 6: "no absolute norm exists" -> relative to tempo: a fraction
 *    of the shorter neighbouring note, never below what the ~43 ms detector window can
 *    resolve, plus a per-semitone allowance for RISING intervals only (rising transition
 *    time grows with interval size; falling stays flat).
 *
 * Contract gap: AnalyzeTransitions receives no tempo, so the budget is derived from
 * the notes' own durations (see contractIssues). The three budget knobs and the
 * overshoot limit below are PROVISIONAL local stand-ins for CONFIG entries that do
 * not exist yet.
 */
import type { AnalyzeTransitions, TransitionResult } from './types';
import { CONFIG } from '../config';
import { CONTIGUOUS_GAP_FRAMES, voicedContour, type Contour } from './segment';
import { frameRange, medianRange, medianSpacing } from './track';

/** Budget = this fraction of the shorter neighbouring note ... */
const BUDGET_FRACTION = 0.2;
/** ... but never less than this (the detector cannot resolve faster than ~2 frames of a 43 ms window). */
const BUDGET_FLOOR_MS = 80;
/** Extra budget per semitone of a rising interval (falling intervals get none). */
const RISING_MS_PER_SEMITONE = 8;
/** Two notes' bands never overlap: each band is at most this fraction of the interval between them. */
const BAND_MAX_FRACTION_OF_INTERVAL = 0.45;
/** After B's end, keep looking for a late settle for up to this long (or half of B), but never into the next note. */
const SETTLE_SLACK_SEC = 0.15;

function inBand(c: Contour, k: number, center: number, bandCents: number): boolean {
  return Math.abs(c.smooth[k] - center) * 100 <= bandCents;
}

/** analyzeTransitions(track, notes, ctx) - one result per adjacent pair in `notes`. */
export const analyzeTransitions: AnalyzeTransitions = (track, notes, ctx) => {
  const transitions: TransitionResult['transitions'] = [];
  const overshootLimit = Math.max(ctx.toleranceCents, CONFIG.onset.crispMaxOvershootCents);
  const baseBand = Math.max(ctx.toleranceCents, CONFIG.tolerance.default);

  for (let i = 0; i + 1 < notes.length; i++) {
    const a = notes[i];
    const b = notes[i + 1];
    const next = notes[i + 2];
    const aSec = a.end - a.start;
    const bSec = b.end - b.start;
    const intervalCents = Math.abs(b.midi - a.midi) * 100;
    const dir = Math.sign(b.midi - a.midi);

    let winEnd = b.end + Math.min(SETTLE_SLACK_SEC, 0.5 * bSec);
    if (next !== undefined && next.start > b.start) winEnd = Math.min(winEnd, Math.max(next.start, b.end));
    const win = frameRange(track, a.start, winEnd);
    const c = voicedContour(track, win.lo, win.hi);
    const unmeasured = { fromIndex: i, toIndex: i + 1, durationMs: null, overshootCents: 0, clean: false };

    if (c.length < 2) {
      transitions.push(unmeasured);
      continue;
    }
    const dt = medianSpacing(c.t);
    const frameSec = Number.isFinite(dt) ? dt : 0.0107;
    const band = dir === 0 ? baseBand : Math.min(baseBand, BAND_MAX_FRACTION_OF_INTERVAL * intervalCents);

    // A must have been established before there is anything to leave.
    let a0 = -1;
    for (let k = 0; k < c.length; k++) {
      if (inBand(c, k, a.midi, band)) {
        a0 = k;
        break;
      }
    }
    if (a0 < 0) {
      transitions.push(unmeasured);
      continue;
    }

    if (dir === 0) {
      // Same pitch twice: nothing moves. Clean as long as the second note was actually sung on that pitch.
      let sungB = false;
      for (let k = a0; k < c.length && !sungB; k++) sungB = c.t[k] >= b.start && inBand(c, k, b.midi, band);
      transitions.push({ fromIndex: i, toIndex: i + 1, durationMs: sungB ? 0 : null, overshootCents: 0, clean: sungB });
      continue;
    }

    // Settle on B: first run (after A) that holds B's band long enough.
    const holdSec = Math.max(2 * frameSec, Math.min(CONFIG.onset.settleHoldMs / 1000, 0.5 * bSec));
    let s = -1;
    let sEnd = -1;
    for (let k = a0; k < c.length; k++) {
      if (!inBand(c, k, b.midi, band)) continue;
      let e = k;
      while (e + 1 < c.length && c.t[e + 1] - c.t[e] <= CONTIGUOUS_GAP_FRAMES * frameSec && inBand(c, e + 1, b.midi, band)) e++;
      if (c.t[e] - c.t[k] + frameSec >= holdSec) {
        s = k;
        sEnd = e;
        break;
      }
      k = e;
    }

    // Excursion frames run from the last in-A frame before the settle (or the end of the window if it never settled).
    const stop = s >= 0 ? s : c.length;
    let l = a0;
    for (let k = stop - 1; k >= a0; k--) {
      if (inBand(c, k, a.midi, band)) {
        l = k;
        break;
      }
    }
    let peak = 0;
    for (let k = l + 1; k < stop; k++) {
      const exc = dir * (c.smooth[k] - b.midi) * 100;
      if (exc > peak) peak = exc;
    }
    let settledExc = 0;
    if (s >= 0) {
      const settled = medianRange(c.smooth, s, Math.min(sEnd + 1, s + 24));
      settledExc = Math.max(0, dir * (settled - b.midi) * 100);
    }
    const overshootCents = Math.max(0, peak - settledExc);

    if (s < 0) {
      transitions.push({ fromIndex: i, toIndex: i + 1, durationMs: null, overshootCents, clean: false });
      continue;
    }
    const durationMs = (c.t[s] - c.t[l]) * 1000;
    const budgetMs =
      Math.max(BUDGET_FLOOR_MS, BUDGET_FRACTION * 1000 * Math.min(aSec, bSec)) + (dir > 0 ? RISING_MS_PER_SEMITONE * (intervalCents / 100) : 0);
    transitions.push({ fromIndex: i, toIndex: i + 1, durationMs, overshootCents, clean: durationMs <= budgetMs && overshootCents <= overshootLimit });
  }

  let clean = 0;
  for (const t of transitions) if (t.clean) clean++;
  return { transitions, cleanRate: transitions.length === 0 ? 0 : clean / transitions.length };
};
