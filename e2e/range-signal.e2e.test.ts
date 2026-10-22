/**
 * The Range finder fake-mic loop (e2e/range-signal.ts) passes the Range finder whichever point of the loop the take
 * opens on. Chrome loops the file from the moment the mic opens, so the phase at the downbeat is not ours to choose;
 * this runs the production pipeline (the Framer, the McLeod detector, analyzeTake, evaluate) over the take taken from
 * every start phase of the loop, with no browser, and holds the loop to a clean pass each time.
 */
import { describe, expect, it } from 'vitest';
import { Framer } from '../src/audio/framer';
import { TAKE_PRE_ROLL_SEC } from '../src/audio/take-recorder';
import { CONFIG, hopSizeFor } from '../src/config';
import type { PitchFrame } from '../src/core/types';
import { createDetector } from '../src/dsp/detector';
import { rangeFinder } from '../src/exercises/catalog/foundations';
import { analyzeTake } from '../src/exercises/analyze';
import { evaluate } from '../src/exercises/evaluate';
import { realize } from '../src/exercises/transpose';
import { RANGE_HIGH_MIDI, RANGE_LOW_MIDI, buildRangeFinderLoop } from './range-signal';

/** The runner records this long past the end of the material (src/runtime/runner.ts TAKE_TAIL_SEC). */
const TAKE_TAIL_SEC = 0.4;
/** The worklet hands the framer one render quantum at a time. */
const BLOCK = 128;
/** How far apart the start phases tried are, seconds. Odd on purpose, so no phase lands on a segment boundary by luck. */
const PHASE_STEP_SEC = 0.31;

/** What the app's framer and detector make of `audio`, with take time 0 `preRollSec` into it. */
function takeTrack(audio: Float32Array, sampleRate: number, preRollSec: number): PitchFrame[] {
  const { windowSize, minHz, maxHz, mpmK, yinThreshold, minConfidence, minRmsDb, rmsFloorDb } = CONFIG.audio;
  const detector = createDetector('mpm', { sampleRate, windowSize, minHz, maxHz, mpmK, yinThreshold });
  const framer = new Framer({ sampleRate, windowSize, hopSize: hopSizeFor(sampleRate), minHz, maxHz, minConfidence, minRmsDb, rmsFloorDb, detector });
  const frames: PitchFrame[] = [];
  for (let i = 0; i < audio.length; i += BLOCK) {
    framer.push(audio.subarray(i, Math.min(audio.length, i + BLOCK)), i, (f) => frames.push({ ...f, t: f.t - preRollSec }));
  }
  return frames;
}

describe('the Range finder fake-mic loop', () => {
  const loop = buildRangeFinderLoop();
  const realized = realize(rangeFinder, null, 'unknown');

  it('is a loop short enough that every take window holds a full low hold and a full high hold', () => {
    expect(loop.periodSec + loop.holdSec).toBeLessThanOrEqual(realized.totalSec);
    expect(loop.samples.length / loop.sampleRate).toBeCloseTo(loop.periodSec, 3);
    let peak = 0;
    for (const s of loop.samples) peak = Math.max(peak, Math.abs(s));
    expect(peak).toBeGreaterThan(0.1);
    expect(peak).toBeLessThanOrEqual(0.35);
  });

  it('passes the Range finder from every start phase of the loop, with the full 17-semitone span', () => {
    const takeSamples = Math.round((TAKE_PRE_ROLL_SEC + realized.totalSec + TAKE_TAIL_SEC) * loop.sampleRate);
    const copies = Math.ceil(takeSamples / loop.samples.length) + 1;
    const looped = new Float32Array(loop.samples.length * copies);
    for (let c = 0; c < copies; c++) looped.set(loop.samples, c * loop.samples.length);

    const problems: string[] = [];
    let phases = 0;
    for (let start = 0; start < loop.periodSec; start += PHASE_STEP_SEC) {
      phases++;
      const from = Math.round(start * loop.sampleRate);
      const track = takeTrack(looped.subarray(from, from + takeSamples), loop.sampleRate, TAKE_PRE_ROLL_SEC);
      const analysis = analyzeTake(rangeFinder, realized, track, { vibratoStyle: 'pop' });
      const verdict = evaluate(rangeFinder, analysis.metrics, analysis);
      const range = analysis.details.range;
      const where = `phase ${start.toFixed(2)} s`;
      if (!verdict.passed) problems.push(`${where}: not passed (score ${verdict.score.toFixed(2)}, failed gates ${verdict.failedGates.join(',') || 'none'})`);
      if (range?.lowestMidi !== RANGE_LOW_MIDI) problems.push(`${where}: lowest held note ${range?.lowestMidi ?? 'none'}, want ${RANGE_LOW_MIDI}`);
      if (range?.highestMidi !== RANGE_HIGH_MIDI) problems.push(`${where}: highest held note ${range?.highestMidi ?? 'none'}, want ${RANGE_HIGH_MIDI}`);
      if (verdict.score < 0.99) problems.push(`${where}: score ${verdict.score.toFixed(2)}, want full marks`);
    }
    expect(phases).toBeGreaterThanOrEqual(30);
    expect(problems).toEqual([]);
  }, 120_000);

  it('is not a vacuous check: a take too short to hold both extremes does not pass', () => {
    // 5 s from the start of the loop reaches the low hold and the siren, never the high hold.
    const short = loop.samples.subarray(0, Math.round(5 * loop.sampleRate));
    const analysis = analyzeTake(rangeFinder, realized, takeTrack(short, loop.sampleRate, 0), { vibratoStyle: 'pop' });
    expect(analysis.details.range?.highestMidi).not.toBe(RANGE_HIGH_MIDI);
    expect(evaluate(rangeFinder, analysis.metrics, analysis).passed).toBe(false);
  });
});
