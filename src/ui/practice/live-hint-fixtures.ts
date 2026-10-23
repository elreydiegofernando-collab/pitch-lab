/**
 * Test support for the live hint (live-hint.test.ts, LiveHint.test.tsx, Sing.test.tsx): hand-written exercises, so no
 * test depends on what a catalog level happens to ask (the Foundations levels are being rebuilt as lessons), and
 * synthesized singing at the engine's real frame rate. Imported only by tests.
 */
import { makeTrack } from '../../analysis/fixtures';
import type { PitchFrame } from '../../core/types';
import { realize } from '../../exercises';
import type { RealizedExercise } from '../../exercises/transpose';
import type { ExerciseDef, PatternStep } from '../../exercises/types';
import type { VocalRange } from '../../storage/schema';

export const TEST_RANGE: VocalRange = { comfortable: { low: 47, high: 69 }, extended: { low: 45, high: 72 }, measuredAt: '2026-10-21T09:00:00.000Z' };

/** A held note `semis` above the tonic for `beats`. */
export const note = (semis: number, beats: number, extra: Pick<PatternStep, 'cue' | 'syllable'> = {}): PatternStep => ({ semis, beats, ...extra });
/** A rest of `beats`. */
export const rest = (beats: number): PatternStep => ({ beats });
/** A slide from `from` to `to` over `beats`. */
export const slide = (from: number, to: number, beats: number): PatternStep => ({ semis: from, beats, glideToSemis: to });

/** A complete exercise around `pattern`: 60 bpm (a beat is a second), an easy zone, accuracy scored. Override what a test needs. */
export function exercise(pattern: PatternStep[], over: Partial<ExerciseDef> = {}): ExerciseDef {
  return {
    id: 'test.exercise',
    worldId: 'foundations',
    kind: 'sustain',
    title: 'Test exercise',
    goal: 'A hand-written exercise for a test.',
    pattern,
    tempoBpm: 60,
    tonicPlacement: 'mid',
    countInBeats: 2,
    metronome: false,
    demo: { timbre: 'sine', vibrato: null },
    analyzers: ['accuracy'],
    scoring: [],
    pass: { score: 0.6 },
    tolerance: 'easy',
    tiers: { solid: 0.8, studio: 0.92 },
    ...over,
  };
}

/** The exercise and where it lands in a tenor's range: what a prepared run carries. */
export function prepare(def: ExerciseDef): { def: ExerciseDef; realized: RealizedExercise } {
  return { def, realized: realize(def, TEST_RANGE, 'tenor') };
}

/**
 * Frames from take time `from` to `to`, on an engine clock whose take time 0 is `origin`: `midi(take)` is the pitch
 * (NaN = silence), with Gaussian-ish jitter of `jitterCents`.
 */
export function voiceFrames(origin: number, from: number, to: number, midi: (take: number) => number, jitterCents = 0, seed = 7): PitchFrame[] {
  return makeTrack({ t0: origin + from, duration: to - from, midi: (t) => midi(t - origin), jitterCents, seed });
}
