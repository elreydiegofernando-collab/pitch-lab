import { describe, expect, it } from 'vitest';
import { CONFIG, hopSizeFor } from './config';

/**
 * Pins the numbers the owner's SPEC (docs/SPEC.md) states outright, so a tuning edit to src/config.ts cannot move one
 * silently: a deliberate change updates this file and the SPEC together. Values that are proposals or research
 * defaults (marked PROVISIONAL in config.ts) are not pinned here; the behaviour at each boundary is pinned in the
 * tests of the module that applies it (cracks, runs, ladder, midi-phrases, phrases).
 */
describe('the owner\'s SPEC numbers are still the numbers', () => {
  it('8.1 tolerance tiers: easy +/-50, default +/-25, studio +/-10 cents', () => {
    expect(CONFIG.tolerance).toEqual({ easy: 50, default: 25, studio: 10 });
  });

  it('8.2 onset: settle = within tolerance for 100 ms, scoop = lowest deviation in the first 150 ms', () => {
    expect(CONFIG.onset.settleHoldMs).toBe(100);
    expect(CONFIG.onset.scoopWindowMs).toBe(150);
  });

  it('8.3 vibrato: 5-7 Hz, pop +/-20-60 c, classical +/-40-100 c; wobble below 4.5 Hz or above +/-120 c; bleat above 8 Hz; straight below ~10 c', () => {
    expect(CONFIG.vibrato.styles.pop).toEqual({ rateHz: [5, 7], extentCents: [20, 60] });
    expect(CONFIG.vibrato.styles.classical).toEqual({ rateHz: [5, 7], extentCents: [40, 100] });
    expect(CONFIG.vibrato.wobbleBelowHz).toBe(4.5);
    expect(CONFIG.vibrato.wobbleAboveExtentCents).toBe(120);
    expect(CONFIG.vibrato.bleatAboveHz).toBe(8);
    expect(CONFIG.vibrato.straightBelowExtentCents).toBe(10);
    expect(CONFIG.vibrato.detrendWindowSec).toBeGreaterThanOrEqual(0.5); // "a sliding window of 0.5-1 s"
    expect(CONFIG.vibrato.detrendWindowSec).toBeLessThanOrEqual(1);
  });

  it('8.4 a crack is a jump of more than 200 c in under 30 ms', () => {
    expect(CONFIG.transitions.crackJumpCents).toBe(200);
    expect(CONFIG.transitions.crackWithinMs).toBe(30);
  });

  it('8.5 a run note is reached with 40 ms within +/-50 c, and the tempo ladder is 3 / 4.5 / 6 / 9 / 12 notes a second', () => {
    expect(CONFIG.runs.reachedMinMs).toBe(40);
    expect(CONFIG.runs.reachedTolCents).toBe(50);
    expect(CONFIG.runs.tempoLadderNps).toEqual([3, 4.5, 6, 9, 12]);
    const w = CONFIG.runs.weights;
    expect(w.reached + w.accuracy + w.definition + w.timing).toBeCloseTo(1, 12);
  });

  it('the run score still reads 85% as the mark (it triggers the run.score coaching tip; the ladder itself advances on a passing take)', () => {
    expect(CONFIG.runs.tempoAdvanceScore).toBe(0.85);
  });

  it('8.7 a range note is held for at least 1 s', () => {
    expect(CONFIG.range.holdSec).toBe(1);
  });

  it('10 song mode: a phrase starts after a 350 ms rest, the DTW corridor is 200 ms either side, scoring is octave-agnostic', () => {
    expect(CONFIG.song.phraseGapMs).toBe(350);
    expect(CONFIG.song.dtwBandMs).toBe(200);
    expect(CONFIG.song.octaveAgnostic).toBe(true);
  });

  it('12 voice health: a gentle break reminder after about 30 minutes of active singing', () => {
    expect(CONFIG.health.breakReminderMin).toBe(30);
  });

  it('7 audio: about 94 pitch frames a second at 44.1 and 48 kHz, E2 to C6 inside the lag bounds', () => {
    expect(CONFIG.audio.windowSize).toBe(2048);
    expect(hopSizeFor(48000)).toBe(512);
    for (const rate of [44100, 48000]) expect(rate / hopSizeFor(rate)).toBeGreaterThan(90);
    expect(CONFIG.audio.minHz).toBeLessThanOrEqual(82.41); // E2
    expect(CONFIG.audio.maxHz).toBeGreaterThanOrEqual(1046.5); // C6
  });
});

describe('config invariants other modules rely on', () => {
  it('every value a module reads as a share or a window is in range', () => {
    expect(CONFIG.range.holdBandCents).toBeLessThan(100); // narrower than the semitone step it must tell apart
    expect(CONFIG.range.holdBandCents).toBeGreaterThan(CONFIG.tolerance.default);
    expect(CONFIG.dynamics.endDownShare[0]).toBeLessThan(CONFIG.dynamics.endDownShare[1]);
    expect(CONFIG.dynamics.minShapeScore).toBeGreaterThan(0);
    expect(CONFIG.dynamics.minShapeScore).toBeLessThan(1);
    expect(CONFIG.runs.definitionSlideFree).toBeLessThan(CONFIG.runs.definitionSlideZero);
    expect(CONFIG.runs.definitionBandMinCents).toBeLessThan(CONFIG.tolerance.default);
    expect(CONFIG.transitions.dropoutMaxMs).toBeGreaterThan(CONFIG.transitions.dropoutMinMs);
    expect(CONFIG.accuracy.lateStartAllowanceSec).toBeGreaterThan(CONFIG.accuracy.holdStartSkipMs / 1000);
    expect(CONFIG.song.maxPhraseSec).toBeGreaterThan(2 * CONFIG.song.minSplitSideSec); // a piece over the cap always has room for a cut
    expect(CONFIG.song.splitWindowShare).toBeGreaterThan(0);
    expect(CONFIG.song.splitWindowShare).toBeLessThan(0.5);
  });
});
