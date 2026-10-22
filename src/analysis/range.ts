/**
 * 8.7 Range: the lowest and highest notes held cleanly for at least
 * CONFIG.range.holdSec, over a whole take (sirens, long tones, range-finder
 * takes). No target note: "clean" means voiced at or above the confidence
 * threshold and staying put on one pitch.
 *
 * "Staying put" is about the pitch's CENTRE LINE, not its raw frames. A note
 * sung with vibrato swings up to +/-100 cents (the top of the classical zone)
 * five to seven times a second, so a band wide enough to hold those frames
 * would hold a step to the next semitone too, and a band narrow enough to see
 * the step would cut every wide-vibrato hold. The centre line has no such
 * conflict: a running median (detector glitches cannot move it, and it takes out
 * most of the swing) followed by a running mean over the same window (which takes
 * out what the median leaves) is within ~15 c of the sung note even under a
 * +/-100 c vibrato, while a step to the next semitone is 100 c.
 *
 * A hold is a stretch of that centre line which
 *  - stays inside a band around its own reference pitch (the median of its first
 *    half second), so a note sung 40 cents above a semitone is still one note
 *    and a step to the next semitone leaves the band;
 *  - is not a steady glide: a siren sweeping through a band slowly enough to stay
 *    in it for a second is still not a held note; and
 *  - lasts holdSec.
 * Where a hold begins and ends is known to within the smoothing (~0.05 s).
 */
import type { PitchFrame, PitchTrack } from '../core/types';
import type { RangeResult } from './types';
import { CONFIG } from '../config';
import { cleanSpikes, estimateFrameDt, linearFit, median, medianRange, runningMean, runningMedian, voicedRuns } from './track';

/*
 * The hold band, reference window, centre-line smoothing and glide limit are CONFIG.range.holdBandCents, .referenceSec,
 * .centreSmoothSec and .maxDriftCentsPerSec (all PROVISIONAL: they want the real-voice corpus). The reference pitch is the
 * median of a hold's centre line over its first referenceSec, so a hold is found up to that much late after a change of
 * note with no breath between; the centre line is ~1.8 cycles of a 5.8 Hz vibrato long (29 frames at 94 fps).
 */
/** A pitch excursion that is back inside the band within this many frames cannot be a real note change (a voice cannot step away and back in 30 ms): it is flicker at the edge of the band and the hold goes on. */
const GLITCH_MAX_FRAMES = 3;
/** Detector dropouts up to ~3 frames do not break a hold. */
const BRIDGE_GAP_SEC = 0.045;
/** The drift is read off the middle of the segment only: its ends carry the scoop into the note and the smoothing ramp of the next one, neither of which is the singer drifting. */
const DRIFT_MIDDLE_FRACTION = 0.6;

/** analyzeRange(track) -- a whole take, no target. */
export function analyzeRange(track: PitchTrack): RangeResult {
  const scope = cleanSpikes(track);
  const dt = estimateFrameDt(scope);
  const frameSec = dt > 0 ? dt : CONFIG.audio.hopSeconds; // the nominal hop stands in when the spacing cannot be measured
  const heldNotes: RangeResult['heldNotes'] = [];

  for (const run of voicedRuns(scope, BRIDGE_GAP_SEC)) {
    const frames = scope
      .slice(run.startIndex, run.endIndex)
      .filter((f) => f.voiced && f.confidence >= CONFIG.audio.minConfidence && Number.isFinite(f.midi));
    for (const seg of holdSegments(frames, frameSec)) {
      const durationSec = seg.end.t - seg.start.t + (Number.isFinite(dt) ? dt : 0);
      if (durationSec >= CONFIG.range.holdSec && Math.abs(seg.driftCentsPerSec) <= CONFIG.range.maxDriftCentsPerSec) {
        heldNotes.push({ midi: seg.midi, start: seg.start.t, durationSec });
      }
    }
  }

  let lowestMidi: number | null = null;
  let highestMidi: number | null = null;
  for (const n of heldNotes) {
    if (lowestMidi === null || n.midi < lowestMidi) lowestMidi = n.midi;
    if (highestMidi === null || n.midi > highestMidi) highestMidi = n.midi;
  }
  return { lowestMidi, highestMidi, heldNotes };
}

interface Segment {
  start: PitchFrame;
  end: PitchFrame;
  /** Nearest semitone to the segment's median pitch. */
  midi: number;
  /** Slope of the centre line over the middle of the segment, cents per second (signed). */
  driftCentsPerSec: number;
}

/**
 * Splits one continuous voiced stretch into stable-pitch segments: a frame
 * whose centre line sits outside the band around the segment's reference pitch
 * ends it, unless the line is back inside within GLITCH_MAX_FRAMES (flicker at
 * the edge of the band). Every segment is returned, whatever its length or
 * drift; the caller keeps the ones that are holds.
 */
function holdSegments(frames: readonly PitchFrame[], frameSec: number): Segment[] {
  const out: Segment[] = [];
  const n = frames.length;
  if (n === 0) return out;

  const mids = new Float64Array(n);
  const times = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    mids[i] = frames[i].midi;
    times[i] = frames[i].t;
  }
  const smoothFrames = Math.max(3, Math.round(CONFIG.range.centreSmoothSec / frameSec) | 1); // odd
  const centre = runningMean(runningMedian(mids, smoothFrames), smoothFrames);
  const referenceFrames = Math.max(1, Math.round(CONFIG.range.referenceSec / frameSec));
  const outside = (i: number, ref: number): boolean => Math.abs((centre[i] - ref) * 100) > CONFIG.range.holdBandCents;

  const close = (a: number, b: number): void => {
    if (b < a) return;
    const trim = Math.floor(((b - a + 1) * (1 - DRIFT_MIDDLE_FRACTION)) / 2);
    const fit = linearFit(times, centre, a + trim, b - trim + 1);
    out.push({
      start: frames[a],
      end: frames[b],
      midi: Math.round(median(mids.subarray(a, b + 1))),
      driftCentsPerSec: fit ? fit.slope * 100 : 0,
    });
  };

  let segStart = 0;
  let ref: number | null = null;
  for (let i = 0; i < n; i++) {
    if (ref === null && i - segStart + 1 >= referenceFrames) ref = medianRange(centre, segStart, i + 1);
    if (ref !== null && outside(i, ref)) {
      let back = -1;
      for (let k = i + 1; k < n && k <= i + GLITCH_MAX_FRAMES; k++) {
        if (!outside(k, ref)) {
          back = k;
          break;
        }
      }
      if (back !== -1) {
        i = back - 1; // the flicker stays in the hold; the loop resumes at the first frame back inside
        continue;
      }
      close(segStart, i - 1);
      segStart = i;
      ref = null;
    }
  }
  close(segStart, n - 1);
  return out;
}
