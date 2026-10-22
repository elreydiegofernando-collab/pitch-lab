/**
 * Crack / break detection over a take or a rolling live buffer (SPEC 8.4).
 *
 * A crack is either
 *  - a JUMP: pitch moves by more than `CONFIG.transitions.crackJumpCents` between two
 *    voiced frames less than `crackWithinMs` apart (at ~94 fps that is frames at most
 *    two hops apart, which also catches a jump straddling a one-frame dropout); or
 *  - a DROPOUT: at least `dropoutMinMs` of unvoiced frames strictly inside voiced
 *    audio (the voice cut out mid-glide). Leading/trailing silence is never a dropout.
 *
 * Written for sirens and glides, where the take is meant to be one continuous
 * phonation so any interior dropout is worth flagging. On a whole take or a live ring
 * buffer (the default), a dropout longer than CONFIG.transitions.dropoutMaxMs is read as a deliberate
 * pause (a rest or a breath between glides), not a break. A caller that already knows
 * its audio is continuous (one glide, one phrase) passes `maxDropoutMs: Infinity`: the
 * voice cutting out for half a second in the middle of a siren is a break, and a longer
 * one is not less of one. Leading and trailing silence is never a dropout either way.
 *
 * Detector glitches are not cracks. MPM occasionally locks onto a harmonic for a
 * frame or two (typically an octave, sometimes a twelfth) and then recovers; a human
 * voice cannot jump 9+ semitones and return within ~20 ms, so brief far excursions
 * that come straight back are ignored (and count as voiced, so they never register
 * as a dropout either). Frames that analysis/track.ts `cleanOctaveSpikes` already
 * cleared (voiced = false, yet a real pitch and a confidence that passes the gate) are
 * recognised the same way, so pre-cleaning a take never turns a glitch into a dropout.
 *
 * One physical crack yields one event: a jump that straddles a short dropout is a
 * single 'jump', and events within CLUSTER_MS of each other (a squeak that flips up
 * and straight back, a stutter) merge into the first.
 *
 * Cost: O(n) with one n-byte scratch array and no per-frame allocation, so the Live
 * view can call it on its ring buffer every few hundred ms. glide.ts reuses it on a
 * single glide's frame slice.
 */
import type { PitchFrame, PitchTrack } from '../core/types';
import type { CrackEvent } from './types';
import { centsOff } from '../core/music';
import { CONFIG } from '../config';

export interface CrackOptions {
  /** Interior unvoiced stretches longer than this (ms) are pauses, not dropouts. Default CONFIG.transitions.dropoutMaxMs (300); `Infinity` for audio that is continuous by construction. */
  maxDropoutMs?: number;
}
/** A far excursion of at most GLITCH_MAX_FRAMES voiced frames that returns within GLITCH_RETURN_CENTS is a detector glitch. */
const GLITCH_MIN_CENTS = 900;
const GLITCH_MAX_FRAMES = 2;
const GLITCH_RETURN_CENTS = 100;
/** Events closer together than this are one crack. */
const CLUSTER_SEC = 0.1;

/** An unvoiced frame that nevertheless passes the voicing gate with a real pitch: it was cleared by cleanOctaveSpikes, not by the detector. */
function isCleanedGlitch(f: PitchFrame): boolean {
  return !f.voiced && Number.isFinite(f.midi) && f.confidence >= CONFIG.audio.minConfidence && f.rmsDb >= CONFIG.audio.minRmsDb;
}

/** Median pitch of up to 3 voiced frames starting at `i` (the settled pitch just after a jump). */
function settledAfter(track: PitchTrack, i: number): number {
  const v: number[] = [];
  for (let k = i; k < track.length && v.length < 3; k++) if (track[k].voiced && Number.isFinite(track[k].midi)) v.push(track[k].midi);
  v.sort((a, b) => a - b);
  return v[v.length >> 1];
}

/** Median pitch of up to 3 trustworthy voiced frames ending at `j` (the pitch just before a jump). */
function settledBefore(track: PitchTrack, j: number, ignore: Uint8Array): number {
  const v: number[] = [];
  for (let k = j; k >= 0 && v.length < 3; k--) if (track[k].voiced && ignore[k] === 0 && Number.isFinite(track[k].midi)) v.push(track[k].midi);
  v.sort((a, b) => a - b);
  return v[v.length >> 1];
}

/** detectCracks(track, opts?) - jumps and interior confidence dropouts, time-ordered. Assignable to the contract's DetectCracks. */
export function detectCracks(track: PitchTrack, opts: CrackOptions = {}): CrackEvent[] {
  const { crackJumpCents, crackWithinMs, dropoutMinMs } = CONFIG.transitions;
  const maxDropoutMs = opts.maxDropoutMs ?? CONFIG.transitions.dropoutMaxMs;
  const withinSec = crackWithinMs / 1000;
  const n = track.length;
  const raw: CrackEvent[] = [];
  if (n < 2) return raw;

  /** 1 = voiced frame whose pitch is a detector glitch (excluded from jump comparisons). */
  const ignore = new Uint8Array(n);
  let lastRel = -1; // last voiced frame with a trustworthy pitch
  let lastAny = -1; // last voiced frame of any kind
  let gapStart = -1; // first unvoiced frame since lastAny (-1 = none pending)
  let suppressUntilT = -Infinity;

  for (let i = 0; i < n; i++) {
    const f = track[i];
    if (!f.voiced || !Number.isFinite(f.midi)) {
      if (isCleanedGlitch(f)) {
        // analysis/track.ts cleanOctaveSpikes clears `voiced` but leaves a gate-passing frame behind: that is a glitch, not silence.
        ignore[i] = 1;
        if (lastAny >= 0) {
          const gap = gapStart >= 0 ? (f.t - track[gapStart].t) * 1000 : 0;
          if (gap >= dropoutMinMs && gap <= maxDropoutMs) raw.push({ t: track[gapStart].t, kind: 'dropout', durationMs: gap });
          lastAny = i;
          gapStart = -1;
        }
        continue;
      }
      if (lastAny >= 0 && gapStart < 0) gapStart = i;
      continue;
    }
    const gapMs = gapStart >= 0 ? (f.t - track[gapStart].t) * 1000 : 0;

    // Detector glitch: a brief far excursion from the last trustworthy pitch that straight away returns.
    if (lastRel >= 0) {
      const base = track[lastRel].midi;
      if (Math.abs(centsOff(f.midi, base)) >= GLITCH_MIN_CENTS) {
        let r = 1;
        while (
          r < GLITCH_MAX_FRAMES &&
          i + r < n &&
          track[i + r].voiced &&
          Math.abs(centsOff(track[i + r].midi, base)) >= GLITCH_MIN_CENTS
        ) {
          r++;
        }
        const q = i + r;
        if (q < n && track[q].voiced && Math.abs(centsOff(track[q].midi, base)) <= GLITCH_RETURN_CENTS) {
          if (gapMs >= dropoutMinMs && gapMs <= maxDropoutMs) {
            raw.push({ t: track[gapStart].t, kind: 'dropout', durationMs: gapMs });
          }
          for (let g = 0; g < r; g++) ignore[i + g] = 1;
          i += r - 1;
          lastAny = i;
          gapStart = -1;
          continue;
        }
      }
    }

    // Jump: the largest pitch change versus any trustworthy voiced frame less than crackWithinMs earlier.
    let bestCents = 0;
    let bestJ = -1;
    for (let j = i - 1; j >= 0 && f.t - track[j].t < withinSec; j--) {
      const p = track[j];
      if (!p.voiced || ignore[j] === 1 || !Number.isFinite(p.midi)) continue;
      const cents = Math.abs(centsOff(f.midi, p.midi));
      if (cents > bestCents) {
        bestCents = cents;
        bestJ = j;
      }
    }
    if (bestCents > crackJumpCents && f.t >= suppressUntilT) {
      // Report the whole jump, not just the part inside the 30 ms comparison window: settled pitch after vs before.
      const size = Math.max(bestCents, Math.abs(centsOff(settledAfter(track, i), settledBefore(track, bestJ, ignore))));
      raw.push({ t: track[bestJ].t, kind: 'jump', cents: size, durationMs: (f.t - track[bestJ].t) * 1000 });
      suppressUntilT = f.t + withinSec;
    } else if (lastAny >= 0 && gapMs >= dropoutMinMs && gapMs <= maxDropoutMs) {
      const event: CrackEvent = { t: track[gapStart].t, kind: 'dropout', durationMs: gapMs };
      // A voice that comes back at a different pitch broke rather than just faltered: carry the discontinuity.
      const discontinuity = lastRel >= 0 ? Math.abs(centsOff(f.midi, track[lastRel].midi)) : 0;
      if (discontinuity > crackJumpCents) event.cents = discontinuity;
      raw.push(event);
    }
    lastRel = i;
    lastAny = i;
    gapStart = -1;
  }

  raw.sort((a, b) => a.t - b.t);
  const events: CrackEvent[] = [];
  for (const e of raw) {
    const prev = events[events.length - 1];
    if (prev && e.t - prev.t < CLUSTER_SEC) {
      if (e.cents !== undefined && (prev.cents === undefined || e.cents > prev.cents)) prev.cents = e.cents;
      continue;
    }
    events.push(e);
  }
  return events;
}
