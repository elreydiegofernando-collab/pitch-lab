/**
 * The fake-mic signal for a Range finder take: a voice-like loop that passes the Range finder from whichever point of it
 * Chrome's fake capture device happens to be at when the take starts.
 *
 * Chrome plays the file in a loop from the moment the mic opens, and the take only starts after the count-in, so the
 * point of the loop the take opens on is not ours to choose. The Range finder (src/exercises/catalog/foundations.ts) is
 * measured by analyzeRange: the lowest and highest notes held cleanly for CONFIG.range.holdSec, and the span between
 * them must reach RANGE_MIN_SPAN. So the loop alternates a long low hold and a long high hold, with a siren between them
 * as a singer would, and is short enough that every window as long as the take contains BOTH holds in full:
 *
 *   take window (realize().totalSec)  >=  loop period + one hold
 *
 * That inequality is checked here from the exercise's own definition and realize() timings, so changing the exercise
 * fails loudly instead of silently leaving a fixture that can no longer pass it. range-signal.e2e.test.ts then proves
 * the claim by running the production framer, detector and analyzers over the take from every start phase.
 *
 * The tones come from this folder's wav-writer, not from the app's synth: the point of a fake mic is a known signal
 * nothing in the app could have produced.
 */
import { CONFIG } from '../src/config';
import { rangeFinder } from '../src/exercises/catalog/foundations';
import { RANGE_MIN_SPAN } from '../src/exercises/catalog/scoring';
import { realize } from '../src/exercises/transpose';
import { generateVoicedPath, pathDurationSec, type PathSegment } from './wav-writer';

export const RANGE_SAMPLE_RATE = 48000;

/** A2 and D4, 17 semitones: past the 16 that earn full marks, and both notes are natural (no sharps or flats in the labels). */
export const RANGE_LOW_HZ = 110;
export const RANGE_HIGH_HZ = 293.6648;
export const RANGE_LOW_MIDI = 45;
export const RANGE_HIGH_MIDI = 62;

/** The siren between the holds, seconds: 17 semitones in 2.5 s is quick enough never to pass for a hold. */
const SIREN_SEC = 2.5;
/** Silence at the loop seam, so a fade there never lands inside a hold. */
const BREATH_SEC = 0.4;

export interface RangeFinderLoop {
  samples: Float32Array;
  sampleRate: number;
  periodSec: number;
  /** The held notes' length, seconds (the longest hold the exercise asks for). */
  holdSec: number;
  /** The exercise as realized for a fresh profile: the take is this long, after its count-in. */
  takeSec: number;
}

const midiOf = (hz: number): number => 69 + 12 * Math.log2(hz / 440);

/** Build the loop from the Range finder's own timings; throws if it could no longer promise a pass from every start. */
export function buildRangeFinderLoop(): RangeFinderLoop {
  const realized = realize(rangeFinder, null, 'unknown');
  const held = realized.steps.filter((s) => s.role === 'sing' && s.toMidi === undefined);
  const holdSec = Math.max(...held.map((s) => s.end - s.start));

  if (Math.round(midiOf(RANGE_LOW_HZ)) !== RANGE_LOW_MIDI || Math.round(midiOf(RANGE_HIGH_HZ)) !== RANGE_HIGH_MIDI) {
    throw new Error('range-signal: RANGE_LOW_HZ / RANGE_HIGH_HZ no longer match RANGE_LOW_MIDI / RANGE_HIGH_MIDI');
  }
  const span = RANGE_HIGH_MIDI - RANGE_LOW_MIDI;
  if (span < RANGE_MIN_SPAN + 2) throw new Error(`range-signal: a ${span}-semitone span is not clear of the Range finder's ${RANGE_MIN_SPAN}-semitone gate`);
  if (holdSec < 2 * CONFIG.range.holdSec) throw new Error(`range-signal: the holds (${holdSec} s) are no longer well past CONFIG.range.holdSec`);

  const path: PathSegment[] = [
    { kind: 'breath', sec: BREATH_SEC },
    { kind: 'hold', hz: RANGE_LOW_HZ, sec: holdSec },
    { kind: 'siren', fromHz: RANGE_LOW_HZ, toHz: RANGE_HIGH_HZ, sec: SIREN_SEC },
    { kind: 'hold', hz: RANGE_HIGH_HZ, sec: holdSec },
    { kind: 'siren', fromHz: RANGE_HIGH_HZ, toHz: RANGE_LOW_HZ, sec: SIREN_SEC },
    { kind: 'breath', sec: BREATH_SEC },
  ];
  const periodSec = pathDurationSec(path);
  if (periodSec + holdSec > realized.totalSec) {
    throw new Error(
      `range-signal: the ${realized.totalSec} s take no longer always holds a full low hold and a full high hold (loop ${periodSec} s + hold ${holdSec} s)`,
    );
  }
  return { samples: generateVoicedPath(path, { sampleRate: RANGE_SAMPLE_RATE }), sampleRate: RANGE_SAMPLE_RATE, periodSec, holdSec, takeSec: realized.totalSec };
}
