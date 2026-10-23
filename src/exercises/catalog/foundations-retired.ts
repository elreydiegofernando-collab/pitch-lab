/**
 * Foundations as it was before it was rebuilt as lessons (2026-10-23): the old levels' exercises and the old placement
 * audition's tests, kept exactly as they were sung (the definitions of commit a6f2a9f) and marked `retired`.
 *
 * Exercise ids are persisted in attempts, and an id means one exercise: when the lessons replaced this material, the new
 * material took new ids (catalog/foundations.ts) and these keep theirs. Nothing sings them any more: no level, audition
 * or lesson plays them and the registry never opens them (validate.ts checks it). They stay in the catalog so every take
 * sung against them reads back against what it was sung against: its title in Recordings, its replay, the check-ups it
 * belonged to (their "then and now", checkup/summary.ts), the coaching files that carry it, and what its placement test
 * granted (WorldDef.audition.former, progress/engine.ts).
 *
 * Frozen history: never edit these, and never reuse their ids.
 */
import { CONFIG } from '../../config';
import { CUE } from '../cues';
import type { ExerciseDef, PatternStep } from '../types';
import { PASS, RANGE_MIN_SPAN, TIERS, crispScoopGate, gate, gateAt, terms } from './scoring';
import { defineExercise, glide, line, note, rest } from './steps';

const W = 'foundations' as const;
/** The day this material was retired. */
const RETIRED = '2026-10-23';

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

const RANGE_TEMPO = 60;
const RANGE_HOLD_BEATS = Math.ceil((3 * CONFIG.range.holdSec * RANGE_TEMPO) / 60);

const rangeFinder = defineExercise({
  id: 'foundations.range-finder.1',
  worldId: W,
  kind: 'range-finder',
  title: 'Range finder',
  goal: 'Find the notes that feel easy for your voice, so every exercise after this one fits you: nothing here is graded.',
  steps: [
    'Tap Listen to hear how it goes. Headphones help.',
    'Tap Sing. After the count of 4, sing the note you hear on “oo”, as in “food”.',
    'Slide your voice down slowly, like a sigh. When it starts to feel like work, stop there and hold that note for a slow count of three.',
    'Take a breath, then sing the starting note again.',
    'Slide up slowly and lightly, like a siren. Stop before it strains, and hold that note for a slow count of three.',
    'Never push or strain. Easy notes are the right answer.',
  ],
  passPlain:
    'Hold one low note and one high note, each for a slow count of three, at least an octave apart: the jump from “Some-” to “-where” in “Somewhere Over the Rainbow”.',
  pattern: [
    note(0, 2, { cue: 'Sing the note you hear on “oo”', syllable: 'oo' }),
    glide(0, -5, 4, { cue: 'Slide down slowly, like a sigh' }),
    note(-5, RANGE_HOLD_BEATS, { cue: 'Hold your lowest easy note' }),
    { beats: 2, cue: 'Take a breath' },
    note(0, 2, { cue: 'Back to the starting note', syllable: 'oo' }),
    glide(0, 7, 4, { cue: 'Slide up slowly and lightly' }),
    note(7, RANGE_HOLD_BEATS, { cue: 'Hold your highest easy note' }),
  ],
  tempoBpm: RANGE_TEMPO,
  tonicPlacement: 'mid',
  countInBeats: 4,
  metronome: false,
  demo: { timbre: 'sine', vibrato: null },
  analyzers: ['range'],
  scoring: terms('easy', { 'range.spanSemitones': 1 }),
  pass: { score: PASS, gates: [gateAt('range.spanSemitones', '>=', RANGE_MIN_SPAN)] },
  tolerance: 'easy',
  tiers: TIERS,
  retired: RETIRED,
});

const pitchMatch = defineExercise({
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
  retired: RETIRED,
});

const sustain1 = defineExercise({
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
  retired: RETIRED,
});

const sustain2 = defineExercise({
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
  retired: RETIRED,
});

const sirens = defineExercise({
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
  retired: RETIRED,
});

const crispness = defineExercise({
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
  retired: RETIRED,
});

const LEAP_TERMS = {
  'onset.scoopCents': 0.3, 'onset.settleMs': 0.2, 'onset.overshootCents': 0.15, 'accuracy.medianAbsCents': 0.2, 'accuracy.inTolerancePct': 0.15,
} as const;

const intervals1 = defineExercise({
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
  retired: RETIRED,
});

const intervals2 = defineExercise({
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
  retired: RETIRED,
});

const LEGATO_LINE = [0, 2, 4, 5, 7, 9, 7, 5, 4, 2] as const;

const legato = defineExercise({
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
  retired: RETIRED,
});

const boss = defineExercise({
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
  retired: RETIRED,
});

const audition1 = defineExercise({
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
  retired: RETIRED,
});

const audition2 = defineExercise({
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
  retired: RETIRED,
});

const audition3 = defineExercise({
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
  retired: RETIRED,
});

const audition4 = defineExercise({
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
  retired: RETIRED,
});

/** Every retired Foundations exercise: the old levels' exercises in their old order, then the old audition's tests. */
export const FOUNDATIONS_RETIRED: readonly ExerciseDef[] = [
  rangeFinder, pitchMatch, sustain1, sustain2, sirens, crispness, intervals1, intervals2, legato, boss,
  audition1, audition2, audition3, audition4,
];

/**
 * The placement audition as it was sung until the rebuild: its tests in their order then, the world's levels then (ids,
 * in order; 'foundations.04' was Sustain II, which never judged a wobble and is gone), and how far each test reached.
 */
export const FORMER_FOUNDATIONS_AUDITION = {
  levelIds: [
    'foundations.01', 'foundations.02', 'foundations.03', 'foundations.04', 'foundations.05', 'foundations.06', 'foundations.07',
    'foundations.08', 'foundations.09', 'foundations.boss',
  ],
  exerciseIds: [audition1.id, audition2.id, audition3.id, audition4.id],
  unlockThrough: ['foundations.04', 'foundations.05', 'foundations.08', 'foundations.09'],
} as const;
