/**
 * Foundations (SPEC §9.1, unlock map §11.2): range finder, pitch match,
 * sustain, sirens & glides, crispness, interval jumps, legato lines, then the
 * Boss Recital. Tolerance tightens easy -> default -> studio; holds lengthen
 * (4 s -> 8 s), intervals widen (3rds, 5ths -> octaves) and the placement
 * climbs from the middle of the range toward its top.
 *
 * Onsets are only scored on attacks from silence: every note whose scoop and
 * settle are judged follows a rest (pitch match, crispness, interval jumps),
 * because a connected note change is a transition, not an onset (plan.ts).
 */
import { CONFIG } from '../../config';
import { CUE } from '../cues';
import type { AuditionDef, ExerciseDef, PatternStep, WorldDef } from '../types';
import { PASS, RANGE_MIN_SPAN, TIERS, crispScoopGate, gate, gateAt, terms } from './scoring';
import { bossLevel, defineExercise, glide, level, line, note, rest } from './steps';

const W = 'foundations' as const;

/** Two-note leaps sung as separate attacks: first note, a breath, then land the second dead centre. */
function leaps(pairs: ReadonlyArray<readonly [number, number]>, cue: string): PatternStep[] {
  return pairs.flatMap(([a, b], i) => [
    note(a, 1, i === 0 ? { cue, syllable: 'ah' } : { syllable: 'ah' }),
    rest(1),
    note(b, 2, { syllable: 'ah' }),
    rest(1),
  ]);
}

/** Short notes on the beat, each its own attack (a beat of silence between). */
function attacks(semis: readonly number[], cue: string, closingRest: number): PatternStep[] {
  return semis.flatMap((s, i) => [
    note(s, 1, i === 0 ? { cue, syllable: 'ah' } : { syllable: 'ah' }),
    rest(i === semis.length - 1 ? closingRest : 1),
  ]);
}

// ---------------------------------------------------------------- 01 Range finder
const RANGE_TEMPO = 60;
/** Each extreme is held about three times CONFIG.range.holdSec so the range analyzer can count it. */
const RANGE_HOLD_BEATS = Math.ceil((3 * CONFIG.range.holdSec * RANGE_TEMPO) / 60);

/**
 * The guide bars span an octave around the middle of the range, so they fit
 * any plausible saved range; the cues invite the singer past them while it
 * stays easy. The range analyzer measures what was held, not the guides.
 */
export const rangeFinder = defineExercise({
  id: 'foundations.range-finder.1',
  worldId: W,
  kind: 'range-finder',
  title: 'Range finder',
  goal: 'Slide down, then up, on “oo” and hold the lowest and highest notes that still feel easy, so every exercise fits your voice.',
  pattern: [
    note(0, 2, { cue: 'Start in the middle', syllable: 'oo' }),
    glide(0, -5, 4, { cue: 'Slide down, past the bar while it’s easy' }),
    note(-5, RANGE_HOLD_BEATS, { cue: 'Hold your lowest easy note' }),
    rest(2),
    note(0, 2, { cue: 'Back to the middle', syllable: 'oo' }),
    glide(0, 7, 4, { cue: 'Slide up lightly, never push' }),
    note(7, RANGE_HOLD_BEATS, { cue: 'Hold your highest easy note' }),
  ],
  tempoBpm: RANGE_TEMPO,
  tonicPlacement: 'mid',
  countInBeats: 4,
  metronome: false,
  demo: { timbre: 'sine', vibrato: null },
  analyzers: ['range'],
  scoring: terms('easy', { 'range.spanSemitones': 1 }),
  // Measuring, not judging: any honest span of an octave passes (holding the guide bars is exactly that), and
  // every exercise fits a range that wide. Never reward straining: 16 semitones is already full marks.
  pass: { score: PASS, gates: [gateAt('range.spanSemitones', '>=', RANGE_MIN_SPAN)] },
  tolerance: 'easy',
  tiers: TIERS,
});

// ---------------------------------------------------------------- 02 Pitch match
export const pitchMatch = defineExercise({
  id: 'foundations.pitch-match.1',
  worldId: W,
  kind: 'pitch-match',
  title: 'Pitch match',
  goal: 'Hear each note, think it for a beat, then sing it back and settle into the middle of the band.',
  pattern: [0, 4, 7, 2, -3].flatMap((s) => [note(s, 2, { cue: CUE.listen }), rest(1), note(s, 3, { cue: CUE.sing, syllable: 'ah' }), rest(1)]),
  tempoBpm: 72,
  tonicPlacement: 'mid',
  countInBeats: 2,
  metronome: false,
  demo: { timbre: 'piano', vibrato: null },
  analyzers: ['accuracy', 'onset'],
  scoring: terms('easy', { 'accuracy.inTolerancePct': 0.35, 'accuracy.medianAbsCents': 0.3, 'onset.settleMs': 0.35 }),
  pass: { score: PASS, gates: [gate('accuracy.inTolerancePct', 'easy'), gate('onset.settleMs', 'easy')] },
  tolerance: 'easy',
  tiers: TIERS,
});

// ---------------------------------------------------------------- 03-04 Sustain
export const sustain1 = defineExercise({
  id: 'foundations.sustain.1',
  worldId: W,
  kind: 'sustain',
  title: 'Sustain I',
  goal: 'Hold each note for four seconds on a steady, straight “ah”.',
  pattern: [
    note(0, 4, { cue: 'Hold it steady and straight', syllable: 'ah' }),
    rest(2),
    note(2, 4, { syllable: 'ah' }),
    rest(2),
    note(4, 4, { syllable: 'ah' }),
  ],
  tempoBpm: 60,
  tonicPlacement: 'mid',
  countInBeats: 2,
  metronome: false,
  demo: { timbre: 'soft', vibrato: null },
  analyzers: ['accuracy'],
  scoring: terms('easy', {
    'accuracy.inTolerancePct': 0.35, 'accuracy.sdCents': 0.3, 'accuracy.absDriftCentsPerSec': 0.2, 'accuracy.medianAbsCents': 0.15,
  }),
  pass: { score: PASS, gates: [gate('accuracy.inTolerancePct', 'easy')] },
  tolerance: 'easy',
  tiers: TIERS,
});

export const sustain2 = defineExercise({
  id: 'foundations.sustain.2',
  worldId: W,
  kind: 'sustain',
  title: 'Sustain II',
  goal: 'Hold for six, then eight seconds, higher in your range, with no sag at the end.',
  pattern: [
    note(0, 6, { cue: 'Six seconds, steady and straight', syllable: 'ah' }),
    rest(2),
    note(3, 8, { cue: 'Eight seconds: support to the very end', syllable: 'ah' }),
  ],
  tempoBpm: 60,
  tonicPlacement: 'high',
  countInBeats: 2,
  metronome: false,
  demo: { timbre: 'soft', vibrato: null },
  analyzers: ['accuracy'],
  scoring: terms('default', {
    'accuracy.inTolerancePct': 0.35, 'accuracy.sdCents': 0.3, 'accuracy.absDriftCentsPerSec': 0.2, 'accuracy.medianAbsCents': 0.15,
  }),
  pass: { score: PASS, gates: [gate('accuracy.inTolerancePct', 'default'), gate('accuracy.absDriftCentsPerSec', 'default')] },
  tolerance: 'default',
  tiers: TIERS,
});

// ---------------------------------------------------------------- 05 Sirens & glides
export const sirens = defineExercise({
  id: 'foundations.siren.1',
  worldId: W,
  kind: 'siren',
  title: 'Sirens & glides',
  goal: 'Glide smoothly up and down on “oo” with no breaks; any crack is marked on the trace.',
  pattern: [
    note(0, 1, { cue: 'Gentle siren on “oo”', syllable: 'oo' }),
    glide(0, 7, 2),
    glide(7, 0, 2),
    rest(1),
    note(0, 1, { syllable: 'oo' }),
    glide(0, 12, 3, { cue: 'Up the octave, light and smooth' }),
    note(12, 1),
    glide(12, 0, 3, { cue: 'All the way down' }),
    rest(1),
    glide(0, 12, 2, { cue: 'Quicker, still unbroken', syllable: 'oo' }),
    glide(12, 0, 2),
  ],
  tempoBpm: 60,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  metronome: false,
  demo: { timbre: 'sine', vibrato: null },
  analyzers: ['glide', 'cracks'],
  scoring: terms('default', { 'glide.smoothness': 0.4, 'glide.cracks': 0.35, 'glide.endAbsCents': 0.25 }),
  pass: { score: PASS, gates: [gate('glide.cracks', 'default'), gate('glide.smoothness', 'default'), gate('glide.endAbsCents', 'default')] },
  tolerance: 'default',
  tiers: TIERS,
});

// ---------------------------------------------------------------- 06 Crispness
export const crispness = defineExercise({
  id: 'foundations.staccato.1',
  worldId: W,
  kind: 'staccato',
  title: 'Crispness',
  goal: 'Sing a short note on each beat that starts dead centre: no scoop, no overshoot.',
  pattern: attacks([0, 4, 7, 4, 0], 'Short and dead centre, on the beat', 2),
  tempoBpm: 84,
  tonicPlacement: 'fit-span',
  repeats: { count: 3, stepSemis: 2 },
  countInBeats: 4,
  metronome: true,
  demo: { timbre: 'piano', vibrato: null },
  analyzers: ['onset', 'accuracy'],
  scoring: terms('default', {
    'onset.settleMs': 0.3, 'onset.scoopCents': 0.25, 'onset.overshootCents': 0.15, 'onset.crispRate': 0.1, 'accuracy.medianAbsCents': 0.2,
  }),
  pass: { score: PASS, gates: [gate('onset.settleMs', 'default'), gate('onset.scoopCents', 'default')] },
  tolerance: 'default',
  tiers: TIERS,
});

// ---------------------------------------------------------------- 07-08 Interval jumps
const LEAP_TERMS = {
  'onset.scoopCents': 0.3, 'onset.settleMs': 0.2, 'onset.overshootCents': 0.15, 'accuracy.medianAbsCents': 0.2, 'accuracy.inTolerancePct': 0.15,
} as const;

export const intervals1 = defineExercise({
  id: 'foundations.intervals.1',
  worldId: W,
  kind: 'intervals',
  title: 'Interval jumps I',
  goal: 'Thirds and fifths, up and down: sing the first note, breathe, and land the second dead centre with no scoop.',
  pattern: leaps([[0, 4], [4, 0], [0, 7], [7, 0], [4, 7], [7, 4]], 'Hear the next note, then land it'),
  tempoBpm: 72,
  tonicPlacement: 'fit-span',
  countInBeats: 4,
  metronome: true,
  demo: { timbre: 'piano', vibrato: null },
  analyzers: ['onset', 'accuracy'],
  scoring: terms('default', LEAP_TERMS),
  pass: { score: PASS, gates: [gate('onset.scoopCents', 'default'), gate('accuracy.inTolerancePct', 'default')] },
  tolerance: 'default',
  tiers: TIERS,
});

export const intervals2 = defineExercise({
  id: 'foundations.intervals.2',
  worldId: W,
  kind: 'intervals',
  title: 'Interval jumps II',
  goal: 'Fifths and octaves: hear the top note before you sing it, then land it centred without sliding in.',
  pattern: leaps([[0, 7], [7, 0], [0, 12], [12, 0], [5, 12], [12, 5]], 'Hear the top note, then land it'),
  tempoBpm: 66,
  tonicPlacement: 'fit-span',
  countInBeats: 4,
  metronome: true,
  demo: { timbre: 'piano', vibrato: null },
  analyzers: ['onset', 'accuracy'],
  scoring: terms('default', LEAP_TERMS),
  pass: { score: 0.65, gates: [gate('onset.scoopCents', 'default'), gate('accuracy.inTolerancePct', 'default')] },
  tolerance: 'default',
  tiers: TIERS,
});

// ---------------------------------------------------------------- 09 Legato lines
const LEGATO_LINE = [0, 2, 4, 5, 7, 9, 7, 5, 4, 2] as const;

export const legato = defineExercise({
  id: 'foundations.legato.1',
  worldId: W,
  kind: 'legato',
  title: 'Legato lines',
  goal: 'Sing connected scale lines where every note arrives cleanly in the centre of the band.',
  pattern: [...line(LEGATO_LINE, 1, { cue: 'Connected, every note arriving clean' }, 'ah'), note(0, 2, { syllable: 'ah' }), rest(2)],
  tempoBpm: 72,
  tonicPlacement: 'fit-span',
  repeats: { count: 2, stepSemis: 2 },
  countInBeats: 4,
  metronome: true,
  demo: { timbre: 'piano', vibrato: null },
  analyzers: ['accuracy', 'transitions'],
  scoring: terms('studio', {
    'transition.cleanRate': 0.3, 'accuracy.inTolerancePct': 0.3, 'accuracy.medianAbsCents': 0.25, 'accuracy.sdCents': 0.15,
  }),
  pass: { score: PASS, gates: [gate('accuracy.inTolerancePct', 'studio'), gate('transition.cleanRate', 'studio')] },
  tolerance: 'studio',
  tiers: TIERS,
});

// ---------------------------------------------------------------- 10 Boss Recital
/** One take: a long straight hold, an octave attacked dead centre after a breath, a legato scale home. */
export const foundationsBoss = defineExercise({
  id: 'foundations.boss-recital',
  worldId: W,
  kind: 'boss-recital',
  title: 'Foundations Boss Recital',
  goal: 'In one take: hold a straight note for six seconds, breathe, attack the octave dead centre, then carry a legato scale home.',
  pattern: [
    note(0, 6, { cue: 'Hold it steady and straight', syllable: 'ah' }),
    rest(1),
    note(12, 2, { cue: 'Attack the octave dead centre', syllable: 'ah' }),
    ...line([11, 9, 7, 5, 4, 2], 1, { cue: 'Legato down the scale' }, 'ah'),
    note(0, 3, { syllable: 'ah' }),
  ],
  tempoBpm: 66,
  tonicPlacement: 'fit-span',
  countInBeats: 4,
  metronome: true,
  demo: { timbre: 'piano', vibrato: null },
  analyzers: ['accuracy', 'onset', 'transitions'],
  scoring: terms('studio', {
    'accuracy.inTolerancePct': 0.25, 'accuracy.sdCents': 0.15, 'accuracy.absDriftCentsPerSec': 0.1, 'onset.scoopCents': 0.15,
    'onset.settleMs': 0.1, 'transition.cleanRate': 0.15, 'accuracy.medianAbsCents': 0.1,
  }),
  pass: {
    score: PASS,
    gates: [gate('accuracy.inTolerancePct', 'studio'), crispScoopGate(), gate('transition.cleanRate', 'studio')],
  },
  tolerance: 'studio',
  tiers: TIERS,
});

// ---------------------------------------------------------------- Audition
export const foundationsAudition1 = defineExercise({
  id: 'foundations.audition.1',
  worldId: W,
  kind: 'audition',
  title: 'Audition: match and hold',
  goal: 'Hear each note, then sing it back and hold it for six seconds, steady and centred.',
  pattern: [
    note(0, 2, { cue: CUE.listen }),
    rest(1),
    note(0, 6, { cue: CUE.sing, syllable: 'ah' }),
    rest(1),
    note(3, 2, { cue: CUE.listen }),
    rest(1),
    note(3, 6, { cue: CUE.sing, syllable: 'ah' }),
  ],
  tempoBpm: 60,
  tonicPlacement: 'high',
  countInBeats: 2,
  metronome: false,
  demo: { timbre: 'soft', vibrato: null },
  analyzers: ['accuracy', 'onset'],
  scoring: terms('default', {
    'accuracy.inTolerancePct': 0.3, 'accuracy.sdCents': 0.25, 'accuracy.absDriftCentsPerSec': 0.15, 'accuracy.medianAbsCents': 0.15,
    'onset.settleMs': 0.15,
  }),
  pass: { score: PASS, gates: [gate('accuracy.inTolerancePct', 'default'), gate('accuracy.absDriftCentsPerSec', 'default')] },
  tolerance: 'default',
  tiers: TIERS,
});

export const foundationsAudition2 = defineExercise({
  id: 'foundations.audition.2',
  worldId: W,
  kind: 'audition',
  title: 'Audition: siren',
  goal: 'One smooth octave siren up and down on “oo” with no break.',
  pattern: [note(0, 1, { cue: 'One siren on “oo”, no break', syllable: 'oo' }), glide(0, 12, 3), note(12, 1), glide(12, 0, 3)],
  tempoBpm: 60,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  metronome: false,
  demo: { timbre: 'sine', vibrato: null },
  analyzers: ['glide', 'cracks'],
  scoring: terms('default', { 'glide.smoothness': 0.4, 'glide.cracks': 0.35, 'glide.endAbsCents': 0.25 }),
  pass: { score: PASS, gates: [gateAt('glide.cracks', '<=', 1), gate('glide.smoothness', 'default'), gate('glide.endAbsCents', 'default')] },
  tolerance: 'default',
  tiers: TIERS,
});

export const foundationsAudition3 = defineExercise({
  id: 'foundations.audition.3',
  worldId: W,
  kind: 'audition',
  title: 'Audition: crisp leaps',
  goal: 'Short notes that leap fifths and octaves, each one starting dead centre.',
  pattern: [...attacks([0, 7, 0, 12, 5, 12], 'Short, clean landings', 1), note(0, 2, { syllable: 'ah' })],
  tempoBpm: 72,
  tonicPlacement: 'fit-span',
  countInBeats: 4,
  metronome: true,
  demo: { timbre: 'piano', vibrato: null },
  analyzers: ['onset', 'accuracy'],
  scoring: terms('default', {
    'onset.settleMs': 0.25, 'onset.scoopCents': 0.25, 'onset.overshootCents': 0.15, 'onset.crispRate': 0.1, 'accuracy.medianAbsCents': 0.25,
  }),
  pass: { score: 0.65, gates: [gate('onset.settleMs', 'default'), gate('onset.scoopCents', 'default')] },
  tolerance: 'default',
  tiers: TIERS,
});

export const foundationsAudition4 = defineExercise({
  id: 'foundations.audition.4',
  worldId: W,
  kind: 'audition',
  title: 'Audition: legato line',
  goal: 'One connected scale line up a sixth and back, with clean, centred arrivals.',
  pattern: [...line(LEGATO_LINE, 1, { cue: 'Connected, every note arriving clean' }, 'ah'), note(0, 2, { syllable: 'ah' })],
  tempoBpm: 72,
  tonicPlacement: 'fit-span',
  countInBeats: 4,
  metronome: true,
  demo: { timbre: 'piano', vibrato: null },
  analyzers: ['accuracy', 'transitions'],
  scoring: terms('studio', {
    'transition.cleanRate': 0.3, 'accuracy.inTolerancePct': 0.3, 'accuracy.medianAbsCents': 0.25, 'accuracy.sdCents': 0.15,
  }),
  pass: { score: PASS, gates: [gate('accuracy.inTolerancePct', 'studio'), gate('transition.cleanRate', 'studio')] },
  tolerance: 'studio',
  tiers: TIERS,
});

export const FOUNDATIONS_EXERCISES: readonly ExerciseDef[] = [
  rangeFinder, pitchMatch, sustain1, sustain2, sirens, crispness, intervals1, intervals2, legato, foundationsBoss,
  foundationsAudition1, foundationsAudition2, foundationsAudition3, foundationsAudition4,
];

/**
 * Sung in order; the runner stops at the first miss. The Range finder (01) is never skipped: it sets the range
 * (progress withholds this audition until it is sung, and the engine never grants it).
 */
const audition: AuditionDef = {
  id: 'foundations.audition',
  worldId: W,
  exerciseIds: [foundationsAudition1.id, foundationsAudition2.id, foundationsAudition3.id, foundationsAudition4.id],
  unlockThrough: ['foundations.04', 'foundations.05', 'foundations.08', 'foundations.09'],
};

export const FOUNDATIONS: WorldDef = {
  id: W,
  title: 'Foundations',
  accent: '--world-foundations',
  summary: 'Find your range, match pitch, hold notes steady and land every note clean.',
  levels: [
    level(W, 1, 'Range finder', rangeFinder.id),
    level(W, 2, 'Pitch match', pitchMatch.id),
    level(W, 3, 'Sustain I', sustain1.id),
    level(W, 4, 'Sustain II', sustain2.id),
    level(W, 5, 'Sirens & glides', sirens.id),
    level(W, 6, 'Crispness', crispness.id),
    level(W, 7, 'Interval jumps I', intervals1.id),
    level(W, 8, 'Interval jumps II', intervals2.id),
    level(W, 9, 'Legato lines', legato.id),
    bossLevel(W, 10, foundationsBoss.id),
  ],
  audition,
  unlockedBy: null,
};
