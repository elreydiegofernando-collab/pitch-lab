/**
 * The live hint on what the real pitch tracker makes of a voice (the Framer and the MPM detector, fed 128-sample
 * blocks as the worklet would), not on frames written by hand: onset ramps, the detector's own jitter and its voicing
 * gate are all in the way, and the hint still has to say the right thing. The singing is synthesized: a voice-like
 * harmonic tone, on a pitch contour that is steady, flat, sharp, swinging, or corrected half way.
 */
import { describe, expect, it } from 'vitest';
import { Framer } from '../../audio/framer';
import { CONFIG, hopSizeFor } from '../../config';
import { midiToHz } from '../../core/music';
import type { PitchFrame } from '../../core/types';
import { createDetector } from '../../dsp/detector';
import { synthesize } from '../../dsp/test-signals';
import { CUE } from '../../exercises/cues';
import { HINT_TICK_MS, createHintTracker, planHints, type HintKind, type HintPlan } from './live-hint';
import { exercise, note, prepare, rest } from './live-hint-fixtures';

const SAMPLE_RATE = 48000;

/** The pitch frames the engine would deliver for `signal`: window-centre times from the start of the signal. */
function detect(signal: Float32Array): PitchFrame[] {
  const detector = createDetector('mpm', {
    sampleRate: SAMPLE_RATE,
    windowSize: CONFIG.audio.windowSize,
    minHz: CONFIG.audio.minHz,
    maxHz: CONFIG.audio.maxHz,
    mpmK: CONFIG.audio.mpmK,
  });
  const framer = new Framer({
    sampleRate: SAMPLE_RATE,
    windowSize: CONFIG.audio.windowSize,
    hopSize: hopSizeFor(SAMPLE_RATE),
    minHz: CONFIG.audio.minHz,
    maxHz: CONFIG.audio.maxHz,
    minConfidence: CONFIG.audio.minConfidence,
    minRmsDb: CONFIG.audio.minRmsDb,
    rmsFloorDb: CONFIG.audio.rmsFloorDb,
    detector,
  });
  const frames: PitchFrame[] = [];
  for (let pos = 0; pos < signal.length; pos += 128) framer.push(signal.subarray(pos, Math.min(pos + 128, signal.length)), pos, (f) => frames.push(f));
  return frames;
}

/** A sung hold: a voice-like tone on `cents(t)` from the step's note (NaN = silence), seconds from the take's start. */
function sung(midi: number, seconds: number, cents: (t: number) => number): PitchFrame[] {
  const hz = midiToHz(midi);
  return detect(synthesize({ sampleRate: SAMPLE_RATE, duration: seconds, f0: (t) => hz * Math.pow(2, cents(t) / 1200), amp: 0.3 }));
}

/** The hint after each look (every HINT_TICK_MS of the take), the engine's frames arriving as they would. */
function lookEvery(plan: HintPlan, frames: readonly PitchFrame[], seconds: number): HintKind[] {
  const tracker = createHintTracker(plan, 0);
  const seen: HintKind[] = [];
  let next = 0;
  for (let at = HINT_TICK_MS / 1000; at <= seconds + 1e-9; at += HINT_TICK_MS / 1000) {
    while (next < frames.length && frames[next].t <= at) tracker.push(frames[next++]);
    seen.push(tracker.read());
  }
  return seen;
}
const collapse = (kinds: readonly HintKind[]): HintKind[] => kinds.filter((k, i) => i === 0 || k !== kinds[i - 1]);

/** An eight-second hold, in a zone of `tolerance`, and its note. */
function hold(tolerance: 'easy' | 'default' | 'studio'): { plan: HintPlan; midi: number } {
  const { def, realized } = prepare(exercise([note(0, 8)], { tolerance }));
  return { plan: planHints(def, realized), midi: realized.steps[0].midi! };
}

/** The voice comes in half a second after the take starts. */
const IN = 0.5;
const from = (cents: (t: number) => number) => (t: number): number => (t < IN ? NaN : cents(t));

describe('the live hint on the real pitch tracker', () => {
  it('is quiet until the voice is read, then on it, then steady, for a voice on the note', () => {
    const { plan, midi } = hold('default');
    const seen = lookEvery(plan, sung(midi, 6, from(() => 0)), 6);
    expect(collapse(seen)).toEqual(['sing', 'none', 'on-it', 'steady']);
  });

  it('says "a little higher" to a voice 70 cents flat and "a little lower" to one 40 cents sharp, and stays with it', () => {
    const { plan, midi } = hold('default');
    const flat = collapse(lookEvery(plan, sung(midi, 5, from(() => -70)), 5));
    expect(flat).toEqual(['sing', 'none', 'higher']);
    const sharp = collapse(lookEvery(plan, sung(midi, 5, from(() => 40)), 5));
    expect(sharp).toEqual(['sing', 'none', 'lower']);
  });

  it('says "a bit wobbly" to a voice that swings four times a second, and not to a steady one', () => {
    const { plan, midi } = hold('default');
    const swinging = lookEvery(plan, sung(midi, 6, from((t) => 35 * Math.sin(2 * Math.PI * 4 * t))), 6);
    expect(swinging[swinging.length - 1]).toBe('wobbly');
    expect(swinging).not.toContain('steady');
    const calm = lookEvery(plan, sung(midi, 6, from(() => 0)), 6);
    expect(calm).not.toContain('wobbly');
  });

  it('on the wide zone of the first lessons, says only higher, lower or on it: never steady or wobbly, words not taught yet', () => {
    const { plan, midi } = hold('easy');
    const swinging = lookEvery(plan, sung(midi, 6, from((t) => 35 * Math.sin(2 * Math.PI * 4 * t))), 6);
    expect(swinging).not.toContain('wobbly');
    expect(collapse(lookEvery(plan, sung(midi, 6, from(() => 0)), 6))).toEqual(['sing', 'none', 'on-it']);
    expect(collapse(lookEvery(plan, sung(midi, 5, from(() => -80)), 5))).toEqual(['sing', 'none', 'higher']);
  });

  it('lets a singer correct: from 80 cents flat onto the note it is "a little higher", then on it, then steady, and never wobbly', () => {
    const { plan, midi } = hold('default');
    const seen = lookEvery(plan, sung(midi, 6.5, from((t) => (t < 2 ? -80 : 0))), 6.5);
    expect(seen).not.toContain('wobbly');
    expect(collapse(seen)).toEqual(['sing', 'none', 'higher', 'on-it', 'steady']);
  });

  it('says "sing now" again when the voice fades out', () => {
    const { plan, midi } = hold('default');
    const hz = midiToHz(midi);
    const fading = detect(
      synthesize({
        sampleRate: SAMPLE_RATE,
        duration: 6,
        f0: (t) => (t < IN ? NaN : hz),
        amp: (t) => (t < 3 ? 0.3 : Math.max(0, 0.3 * (1 - (t - 3) / 0.6))),
      }),
    );
    const seen = collapse(lookEvery(plan, fading, 6));
    expect(seen[seen.length - 1]).toBe('sing');
    expect(seen).toContain('steady');
  });

  it('runs an echo from listen to rest to the singer\'s turn, then follows the voice', () => {
    const { def, realized } = prepare(exercise([note(0, 1.5, { cue: CUE.listen }), rest(1), note(0, 5.5, { cue: CUE.sing })], { tolerance: 'default' }));
    const plan = planHints(def, realized);
    const midi = realized.steps[2].midi!;
    // Silent through the listen step and the rest, the voice coming in 0.4 s into the singer's turn.
    const frames = sung(midi, 8, (t) => (t < 2.9 ? NaN : 0));
    const seen = collapse(lookEvery(plan, frames, 8));
    expect(seen.slice(0, 5)).toEqual(['listen', 'breathe', 'sing', 'none', 'on-it']);
    expect(seen[seen.length - 1]).toBe('steady');
  });
});
