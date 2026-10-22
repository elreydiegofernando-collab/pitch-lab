/** A saved take's targets, rebuilt from its attempt: its tempo, and its key even after the saved range moved. */
import { describe, expect, it } from 'vitest';
import { getExercise, realize } from '../exercises';
import { realizeAttempt, shiftRealized } from './replay';
import { TEST_RANGE } from './test-takes';

describe('realizeAttempt', () => {
  const sustain = getExercise('foundations.sustain.1')!;
  const run = getExercise('runs.run.3')!;

  it('realizes at the tempo the take was sung, a ladder rung included', () => {
    const rung = run.tempoLadder![0];
    const r = realizeAttempt(run, { tempoBpm: rung, tonicMidi: null }, TEST_RANGE, 'tenor');
    expect(r.bpm).toBe(rung);
    expect(r.totalSec).toBeCloseTo(realize(run, TEST_RANGE, 'tenor', { bpm: rung }).totalSec, 9);
    expect(realizeAttempt(run, { tempoBpm: null, tonicMidi: null }, TEST_RANGE, 'tenor').bpm).toBe(run.tempoBpm);
  });

  it('moves every pitch to the key the take was sung in', () => {
    const now = realize(sustain, TEST_RANGE, 'tenor');
    const r = realizeAttempt(sustain, { tempoBpm: sustain.tempoBpm, tonicMidi: now.tonicMidi - 3 }, TEST_RANGE, 'tenor');
    expect(r.tonicMidi).toBe(now.tonicMidi - 3);
    expect(r.notes.map((n) => n.midi)).toEqual(now.notes.map((n) => n.midi - 3));
    expect(r.notes.map((n) => n.start)).toEqual(now.notes.map((n) => n.start));
    expect(r.steps.filter((s) => s.midi !== undefined).map((s) => s.midi)).toEqual(now.steps.filter((s) => s.midi !== undefined).map((s) => (s.midi as number) - 3));
  });

  it('moves glide ends and figures too, and leaves a take in the same key alone', () => {
    const sirens = getExercise('foundations.siren.1')!;
    const now = realize(sirens, TEST_RANGE, 'tenor');
    const moved = shiftRealized(now, 2);
    const glide = now.notes.findIndex((n) => n.toMidi !== undefined);
    expect(moved.notes[glide].toMidi).toBe((now.notes[glide].toMidi as number) + 2);
    expect(shiftRealized(now, 0)).toBe(now);
    expect(realizeAttempt(sirens, { tempoBpm: null, tonicMidi: now.tonicMidi }, TEST_RANGE, 'tenor').notes).toEqual(now.notes);
  });
});
