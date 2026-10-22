/**
 * Inflections (SPEC §9.3): intentional scoops, falls, timed slides, turns and
 * register flips. "Intentional vs error" can't be certified automatically
 * (RESEARCH §6), so every exercise SAYS what to do: an inflection cue (CUE.*)
 * marks the figure, and plan.ts hands it to the inflection analyzer in that
 * analyzer's per-kind target convention:
 *  - scoop: a glide rising into the note (the cue sits on the glide);
 *  - fall: a held note (cued) and then a downward glide from it;
 *  - slide: a held note (cued, one beat of warning) and then the timed glide;
 *  - turn: main, neighbour, main, other neighbour, main (cue on the first main);
 *  - flip: a note (cued) and directly after it the higher landing note.
 * Flips sit on the passaggio, where the register change actually happens, and
 * may use the extended range.
 */
import { CUE } from '../cues';
import type { ToleranceLevel } from '../../core/types';
import type { AuditionDef, ExerciseDef, PatternStep, WorldDef } from '../types';
import { CORE_POINT, PASS, TIERS, gate, terms } from './scoring';
import { bossLevel, defineExercise, glide, level, note, rest } from './steps';

const W = 'inflections' as const;

/** Scoop up a whole tone into `t`, arriving in `beats`, then hold. */
function scoopInto(t: number, beats: number, hold: number): PatternStep[] {
  return [glide(t - 2, t, beats, { cue: CUE.scoop, syllable: 'ah' }), note(t, hold, { syllable: 'ah' })];
}

/** Hold `t`, then fall `by` semitones over `beats` as the sound fades. */
function fallFrom(t: number, hold: number, by: number, beats: number): PatternStep[] {
  return [note(t, hold, { cue: CUE.fall, syllable: 'ah' }), glide(t, t - by, beats)];
}

/** Slide from `a` to `b`: a beat on `a`, the timed glide, then hold `b`. */
function slide(a: number, b: number, glideBeats: number, holdAfter: number): PatternStep[] {
  return [note(a, 1, { cue: CUE.slide, syllable: 'ah' }), glide(a, b, glideBeats), note(b, holdAfter, { syllable: 'ah' })];
}

/** Turn around `t`: main, first neighbour, main, second neighbour, main. upper = start above (whole step), then below (half step). */
function turn(t: number, unit: number, upper: boolean): PatternStep[] {
  const [n1, n2] = upper ? [t + 2, t - 1] : [t - 1, t + 2];
  return [note(t, 1, { cue: CUE.turn, syllable: 'ah' }), note(n1, unit), note(t, unit), note(n2, unit), note(t, 1 + unit)];
}

/** Flip from `low` (chest) up to `high` (head or light mix). */
function flip(low: number, high: number, lowBeats: number, highBeats: number): PatternStep[] {
  return [note(low, lowBeats, { cue: CUE.flip, syllable: 'ah' }), note(high, highBeats, { syllable: 'oo' })];
}

// ---------------------------------------------------------------- 01 Intentional scoop
export const scoop1 = defineExercise({
  id: 'inflections.scoop.1',
  worldId: W,
  kind: 'scoop',
  title: 'Intentional scoop',
  goal: 'Start a whole tone below each note and slide up to arrive on the beat, then hold it centred.',
  pattern: [0, 4, 7, 2].flatMap((t) => [...scoopInto(t, 0.5, 2.5), rest(1)]),
  tempoBpm: 72,
  tonicPlacement: 'mid',
  countInBeats: 4,
  metronome: true,
  demo: { timbre: 'sine', vibrato: null },
  analyzers: ['inflection', 'accuracy'],
  scoring: terms('easy', { 'inflection.score': 0.5, 'inflection.landingAbsCents': 0.25, 'accuracy.inTolerancePct': 0.25 }),
  pass: { score: PASS, gates: [gate('inflection.score', 'easy'), gate('accuracy.inTolerancePct', 'easy')] },
  tolerance: 'easy',
  tiers: TIERS,
});

// ---------------------------------------------------------------- 02 Falls & fall-offs
export const fall1 = defineExercise({
  id: 'inflections.fall.1',
  worldId: W,
  kind: 'fall',
  title: 'Falls & fall-offs',
  goal: 'Hold each note its full value, then release it downward in one quick, smooth fall as the sound fades.',
  pattern: [...fallFrom(0, 2, 5, 0.5), rest(1.5), ...fallFrom(4, 2, 5, 0.5), rest(1.5), ...fallFrom(7, 2, 7, 0.5), rest(1.5)],
  tempoBpm: 72,
  tonicPlacement: 'mid',
  countInBeats: 4,
  metronome: true,
  demo: { timbre: 'sine', vibrato: null },
  analyzers: ['inflection', 'accuracy'],
  scoring: terms('easy', { 'inflection.score': 0.5, 'accuracy.inTolerancePct': 0.25, 'accuracy.sdCents': 0.25 }),
  pass: { score: PASS, gates: [gate('inflection.score', 'easy'), gate('accuracy.inTolerancePct', 'easy')] },
  tolerance: 'easy',
  tiers: TIERS,
});

// ---------------------------------------------------------------- 03-04 Slides / portamento
const SLIDE_TERMS = { 'inflection.score': 0.35, 'inflection.landingAbsCents': 0.3, 'glide.smoothness': 0.2, 'glide.cracks': 0.15 } as const;
/** The figure's shape, and a landing centred on the target note (the core skill, gated half way up its band). */
const landed = (tol: ToleranceLevel) => [gate('inflection.score', tol), gate('inflection.landingAbsCents', tol, CORE_POINT)];

export const slide1 = defineExercise({
  id: 'inflections.slide.1',
  worldId: W,
  kind: 'slide',
  title: 'Slides I',
  goal: 'Glide between two notes in exactly one beat, at an even speed, and arrive centred.',
  pattern: [...slide(0, 4, 1, 2), rest(1), ...slide(4, 0, 1, 2), rest(1), ...slide(0, 7, 1, 2)],
  tempoBpm: 60,
  tonicPlacement: 'mid',
  countInBeats: 4,
  metronome: true,
  demo: { timbre: 'sine', vibrato: null },
  analyzers: ['inflection', 'glide'],
  scoring: terms('default', SLIDE_TERMS),
  pass: { score: PASS, gates: landed('default') },
  tolerance: 'default',
  tiers: TIERS,
});

export const slide2 = defineExercise({
  id: 'inflections.slide.2',
  worldId: W,
  kind: 'slide',
  title: 'Slides II',
  goal: 'Wider slides, fifths and sixths, in half a beat each, in both directions.',
  pattern: [
    ...slide(0, 7, 0.5, 1.5), rest(1),
    ...slide(7, 0, 0.5, 1.5), rest(1),
    ...slide(0, 9, 0.5, 1.5), rest(1),
    ...slide(9, 2, 0.5, 1.5),
  ],
  tempoBpm: 72,
  tonicPlacement: 'fit-span',
  countInBeats: 4,
  metronome: true,
  demo: { timbre: 'sine', vibrato: null },
  analyzers: ['inflection', 'glide'],
  scoring: terms('default', SLIDE_TERMS),
  pass: { score: 0.62, gates: landed('default') },
  tolerance: 'default',
  tiers: TIERS,
});

// ---------------------------------------------------------------- 05 Turns I
const TURN_TERMS = { 'inflection.score': 0.4, 'run.score': 0.4, 'run.missedRate': 0.2 } as const;

export const turn1 = defineExercise({
  id: 'inflections.turn.1',
  worldId: W,
  kind: 'turn',
  title: 'Turns I',
  goal: 'Sing the turn in eighths (upper neighbour, main, lower neighbour, main) with every note distinct.',
  pattern: [...turn(0, 0.5, true), rest(1)],
  tempoBpm: 60,
  tonicPlacement: 'fit-span',
  repeats: { count: 3, stepSemis: 2 },
  countInBeats: 4,
  metronome: true,
  demo: { timbre: 'piano', vibrato: null, slowFirst: true },
  analyzers: ['inflection', 'run'],
  scoring: terms('default', TURN_TERMS),
  pass: { score: PASS, gates: [gate('run.missedRate', 'default'), gate('inflection.score', 'default')] },
  tolerance: 'default',
  tiers: TIERS,
});

// ---------------------------------------------------------------- 06 Flips I
export const flip1 = defineExercise({
  id: 'inflections.flip.1',
  worldId: W,
  kind: 'flip',
  title: 'Flips I',
  goal: 'Flip quickly up a fourth or fifth across your break, yodel style, and land the top note centred.',
  pattern: [...flip(0, 5, 2, 2), rest(2), ...flip(0, 7, 2, 2), rest(2), ...flip(-2, 5, 2, 2)],
  tempoBpm: 66,
  tonicPlacement: 'passaggio',
  countInBeats: 4,
  metronome: true,
  demo: { timbre: 'soft', vibrato: null },
  analyzers: ['inflection', 'accuracy'],
  scoring: terms('default', { 'inflection.landingAbsCents': 0.4, 'inflection.score': 0.35, 'accuracy.inTolerancePct': 0.25 }),
  pass: { score: PASS, gates: landed('default') },
  tolerance: 'default',
  tiers: TIERS,
});

// ---------------------------------------------------------------- 07 Turns II
export const turn2 = defineExercise({
  id: 'inflections.turn.2',
  worldId: W,
  kind: 'turn',
  title: 'Turns II',
  goal: 'Fast turns in sixteenths, upper and inverted, every note still distinct.',
  pattern: [...turn(0, 0.25, true), rest(1), ...turn(0, 0.25, false), rest(1)],
  tempoBpm: 72,
  tonicPlacement: 'fit-span',
  repeats: { count: 2, stepSemis: 2 },
  countInBeats: 4,
  metronome: true,
  demo: { timbre: 'piano', vibrato: null, slowFirst: true },
  analyzers: ['inflection', 'run'],
  scoring: terms('studio', TURN_TERMS),
  pass: { score: PASS, gates: [gate('run.missedRate', 'studio'), gate('inflection.score', 'studio')] },
  tolerance: 'studio',
  tiers: TIERS,
});

// ---------------------------------------------------------------- 08 Flips II
export const flip2 = defineExercise({
  id: 'inflections.flip.2',
  worldId: W,
  kind: 'flip',
  title: 'Flips II',
  goal: 'Flip up a sixth and an octave into a light top note and land it within a few cents.',
  pattern: [...flip(0, 9, 2, 2), rest(2), ...flip(0, 12, 2, 2), rest(2), ...flip(3, 12, 2, 2)],
  tempoBpm: 60,
  tonicPlacement: 'passaggio',
  countInBeats: 4,
  metronome: true,
  demo: { timbre: 'soft', vibrato: null },
  analyzers: ['inflection', 'accuracy'],
  scoring: terms('studio', { 'inflection.landingAbsCents': 0.4, 'inflection.score': 0.35, 'accuracy.inTolerancePct': 0.25 }),
  pass: { score: PASS, gates: landed('studio') },
  tolerance: 'studio',
  tiers: TIERS,
});

// ---------------------------------------------------------------- 09 Boss Recital
/**
 * One phrase: a fast turn on the second degree, a timed slide up a fourth, then a flip up a fourth to the octave.
 * The figures span 1..12, inside an octave, so the narrowest range the Range finder saves holds every one of them.
 */
export const inflectionsBoss = defineExercise({
  id: 'inflections.boss-recital',
  worldId: W,
  kind: 'boss-recital',
  title: 'Inflections Boss Recital',
  goal: 'In one phrase: a quick turn, a timed slide up a fourth, then a clean flip up to the octave.',
  pattern: [...turn(2, 0.25, true), ...slide(2, 7, 0.5, 1.5), ...flip(7, 12, 1, 3)],
  tempoBpm: 60,
  tonicPlacement: 'passaggio',
  countInBeats: 4,
  metronome: true,
  demo: { timbre: 'soft', vibrato: null, slowFirst: true },
  analyzers: ['inflection', 'glide', 'run'],
  scoring: terms('studio', { 'inflection.score': 0.4, 'inflection.landingAbsCents': 0.25, 'run.score': 0.2, 'glide.smoothness': 0.15 }),
  pass: { score: PASS, gates: landed('studio') },
  tolerance: 'studio',
  tiers: TIERS,
});

// ---------------------------------------------------------------- Audition
export const inflectionsAudition1 = defineExercise({
  id: 'inflections.audition.1',
  worldId: W,
  kind: 'audition',
  title: 'Audition: scoop and fall',
  goal: 'Scoop into one note, then hold another and let it fall away.',
  pattern: [...scoopInto(0, 0.5, 2.5), rest(1), ...fallFrom(4, 2, 5, 0.5), rest(1.5)],
  tempoBpm: 72,
  tonicPlacement: 'mid',
  countInBeats: 4,
  metronome: true,
  demo: { timbre: 'sine', vibrato: null },
  analyzers: ['inflection', 'accuracy'],
  scoring: terms('easy', { 'inflection.score': 0.5, 'accuracy.inTolerancePct': 0.25, 'accuracy.sdCents': 0.25 }),
  pass: { score: PASS, gates: [gate('inflection.score', 'easy'), gate('accuracy.inTolerancePct', 'easy')] },
  tolerance: 'easy',
  tiers: TIERS,
});

export const inflectionsAudition2 = defineExercise({
  id: 'inflections.audition.2',
  worldId: W,
  kind: 'audition',
  title: 'Audition: slides',
  goal: 'Two wide slides in half a beat each, arriving centred.',
  pattern: [...slide(0, 7, 0.5, 1.5), rest(1), ...slide(9, 2, 0.5, 1.5)],
  tempoBpm: 72,
  tonicPlacement: 'fit-span',
  countInBeats: 4,
  metronome: true,
  demo: { timbre: 'sine', vibrato: null },
  analyzers: ['inflection', 'glide'],
  scoring: terms('default', SLIDE_TERMS),
  pass: { score: 0.62, gates: landed('default') },
  tolerance: 'default',
  tiers: TIERS,
});

export const inflectionsAudition3 = defineExercise({
  id: 'inflections.audition.3',
  worldId: W,
  kind: 'audition',
  title: 'Audition: turn and flip',
  goal: 'A clear turn in eighths, then a flip up a fifth that lands centred.',
  pattern: [...turn(0, 0.5, true), rest(1), ...flip(0, 7, 2, 2)],
  tempoBpm: 60,
  tonicPlacement: 'passaggio',
  countInBeats: 4,
  metronome: true,
  demo: { timbre: 'soft', vibrato: null },
  analyzers: ['inflection', 'run', 'accuracy'],
  scoring: terms('default', { 'inflection.score': 0.4, 'inflection.landingAbsCents': 0.3, 'run.score': 0.3 }),
  pass: { score: PASS, gates: landed('default') },
  tolerance: 'default',
  tiers: TIERS,
});

export const inflectionsAudition4 = defineExercise({
  id: 'inflections.audition.4',
  worldId: W,
  kind: 'audition',
  title: 'Audition: fast turn, octave flip',
  goal: 'A sixteenth-note turn, then an octave flip landed within a few cents.',
  // The turn sits on the second degree so the whole test spans exactly the octave flip (0..12).
  pattern: [...turn(2, 0.25, true), rest(1), ...flip(0, 12, 2, 2)],
  tempoBpm: 66,
  tonicPlacement: 'passaggio',
  countInBeats: 4,
  metronome: true,
  demo: { timbre: 'soft', vibrato: null },
  analyzers: ['inflection', 'run', 'accuracy'],
  scoring: terms('studio', { 'inflection.score': 0.4, 'inflection.landingAbsCents': 0.3, 'run.score': 0.3 }),
  pass: { score: PASS, gates: landed('studio') },
  tolerance: 'studio',
  tiers: TIERS,
});

export const INFLECTIONS_EXERCISES: readonly ExerciseDef[] = [
  scoop1, fall1, slide1, slide2, turn1, flip1, turn2, flip2, inflectionsBoss,
  inflectionsAudition1, inflectionsAudition2, inflectionsAudition3, inflectionsAudition4,
];

const audition: AuditionDef = {
  id: 'inflections.audition',
  worldId: W,
  exerciseIds: [inflectionsAudition1.id, inflectionsAudition2.id, inflectionsAudition3.id, inflectionsAudition4.id],
  unlockThrough: ['inflections.02', 'inflections.04', 'inflections.06', 'inflections.08'],
};

export const INFLECTIONS: WorldDef = {
  id: W,
  title: 'Inflections',
  accent: '--world-inflections',
  summary: 'Style on purpose: scoops, falls, timed slides, turns and register flips.',
  levels: [
    level(W, 1, 'Intentional scoop', scoop1.id),
    level(W, 2, 'Falls & fall-offs', fall1.id),
    level(W, 3, 'Slides I', slide1.id),
    level(W, 4, 'Slides II', slide2.id),
    level(W, 5, 'Turns I', turn1.id),
    level(W, 6, 'Flips I', flip1.id),
    level(W, 7, 'Turns II', turn2.id),
    level(W, 8, 'Flips II', flip2.id),
    bossLevel(W, 9, inflectionsBoss.id),
  ],
  audition,
  unlockedBy: 'vibrato.boss',
};
