/**
 * Foundations (SPEC §9.1, unlock map §11.2), taught as thirteen small lessons (src/lessons/foundations.ts; owner,
 * 2026-10-23: "I need to know the note before I sing it" and "building blocks"). One new thing per level, in this order
 * (LevelDef.index). Level ids are persisted, so the order no longer follows the numbers and the new levels have new ids:
 *
 *    1 .01 Range finder              2 .02 Match one note            3 .03 Hold it
 *    4 .13 Hold it steady            5 .10 Two notes, one step apart 6 .07 Two notes, a jump apart
 *    7 .08 Bigger jumps              8 .11 Three notes: do-re-mi     9 .09 Five notes in a row
 *   10 .12 Small slides             11 .05 Sirens                   12 .06 Clean starts
 *   13 .boss Boss Recital: a short tune, phrase by phrase
 *
 * A level keeps its id where it still teaches what it did (a pass of it stays a pass). Hold it steady is new (its check
 * judges a wobble, which Sustain II, the old .04, never did), so it has a new id and .04 is gone. Exercise ids mean one
 * exercise: every exercise here is new material with a new id, and the old material keeps its ids, retired
 * (catalog/foundations-retired.ts), so the takes sung against it still read back against it.
 *
 * Every exercise is ECHO-shaped (validate.ts checkEcho): before each sung chunk (one to three notes, or one slide) the app
 * plays exactly that chunk as Listen steps, the singer takes a breath, then sings it back. Nothing sounds while they sing:
 * no guide tone and no metronome, only the count-in before the take. A slide or a siren is played as it is sung (Listen
 * steps that glide, at the speed it is sung); a held note is heard for a moment, not its whole length. The Range finder
 * alone sings past what it plays (the singer finds their own lowest and highest notes): its chunks are heard by their
 * first note.
 *
 * Each level's exercise is its lesson's check. The lessons' practice drills are the short `foundations.drill.*`
 * exercises, sung at their check's tolerance so the in-tune zone on screen is the one the check uses. Tolerance is easy
 * (±50) for the first three levels and default (±25) from Hold it steady on, where a narrower zone makes a wobble
 * visible; nothing in Foundations is studio-strict, its Boss Recital included.
 *
 * Onsets are only scored on attacks from silence: every note whose start is judged follows a breath (the second note of a
 * pair, each short note of Clean starts, each phrase of the tune), because a connected note change is a transition, not
 * an onset (plan.ts).
 */
import { CONFIG } from '../../config';
import type { ToleranceLevel } from '../../core/types';
import { CUE } from '../cues';
import type { AuditionDef, ExerciseDef, LevelDef, PatternStep, WorldDef } from '../types';
import { FORMER_FOUNDATIONS_AUDITION } from './foundations-retired';
import { CORE_POINT, PASS, RANGE_MIN_SPAN, TIERS, gate, gateAt, terms } from './scoring';
import { bossLevel, defineExercise, glide, note, rest } from './steps';

const W = 'foundations' as const;

// ---------------------------------------------------------------- echo turns

/** Shown in the breath after a Listen: the singer's turn to sing it back. */
const YOUR_TURN = 'Your turn';

/**
 * The app plays a chunk (one Listen step per note, `beats` each), then the singer's turn: a one-beat breath, longer than
 * the runner's speaker clearance at every tempo here, so a Listen tone is never cut short on a phone speaker. `turnCue`
 * false leaves the breath unlabelled (the Boss Recital, whose cues name its sections).
 */
function hear(semis: readonly number[], beats = 1, turnCue = true): PatternStep[] {
  return [...semis.map((s) => note(s, beats, { cue: CUE.listen })), turnCue ? { beats: 1, cue: YOUR_TURN } : rest(1)];
}

/** A held note in a slide's Listen is heard for at most this many beats: long enough to hear where it is, no longer. */
const HEARD_HOLD_BEATS = 2;

/**
 * The app plays a slide (or a siren) exactly as it is to be sung: the same notes and slides, at the speed they are sung
 * (a held note heard for at most HEARD_HOLD_BEATS), then the singer's turn. The runner and the demo play a Listen step
 * that glides as one sliding tone, so the singer hears the slide itself, not just where it starts and lands.
 */
function hearAsSung(sung: readonly PatternStep[], turnCue = true): PatternStep[] {
  const heard = sung.map((s): PatternStep => {
    const semis = s.semis as number;
    return s.glideToSemis === undefined
      ? note(semis, Math.min(s.beats, HEARD_HOLD_BEATS), { cue: CUE.listen })
      : glide(semis, s.glideToSemis, s.beats, { cue: CUE.listen });
  });
  return [...heard, turnCue ? { beats: 1, cue: YOUR_TURN } : rest(1)];
}

/** A slide or a siren as an echo turn: heard as it is sung (hearAsSung), then sung. */
function echoSlide(sung: PatternStep[], turnCue = true): PatternStep[] {
  return [...hearAsSung(sung, turnCue), ...sung];
}

/** Echo turns one after another, a one-beat breath between them. */
function turns(...chunks: PatternStep[][]): PatternStep[] {
  return chunks.flatMap((c, i) => (i === 0 ? c : [rest(1), ...c]));
}

/** Hear one note, then hold it for `beats`. */
function holdTurn(semis: number, beats: number, cue: string, syllable = 'ah'): PatternStep[] {
  return [...hear([semis], 2), note(semis, beats, { cue, syllable })];
}

interface Sound {
  beats: number;
  cue: string;
  syllable: string;
}

/** Hear one note, then hold it on one sound that opens into another (a hum into "ah", "oo" into "ah"): one held note, two cues. */
function openTurn(semis: number, first: Sound, then: Sound): PatternStep[] {
  return [...hear([semis], 2), note(semis, first.beats, { cue: first.cue, syllable: first.syllable }), note(semis, then.beats, { cue: then.cue, syllable: then.syllable })];
}

/**
 * Hear two notes, then sing the first, take a breath and land the second as a fresh start (an attack from silence, so how
 * it lands is judged: plan.ts). The breath is a whole beat, twice the onset look-back validate.ts asks for, so a singer
 * who lets the first note ring a little still starts the second from silence.
 */
function pairTurn(a: number, b: number, landCue: string): PatternStep[] {
  return [...hear([a, b]), note(a, 1, { cue: 'First note', syllable: 'ah' }), rest(1), note(b, 2, { cue: landCue, syllable: 'ah' })];
}

/** Hear a few notes, then sing them back joined, the last one a beat longer. */
function lineTurn(semis: readonly number[], cue: string, syllable = 'ah'): PatternStep[] {
  return [...hear(semis), ...semis.map((s, i) => note(s, i === semis.length - 1 ? 2 : 1, i === 0 ? { cue, syllable } : { syllable }))];
}

/** Hear the slide (its first note, the slide, the landing), then hold the first note, slide, and hold the landing. */
function slideTurn(a: number, b: number, cue: string): PatternStep[] {
  return echoSlide([note(a, 1, { cue, syllable: 'oo' }), glide(a, b, 2), note(b, 1)]);
}

/** Hear the siren as it goes (up to `top` and back down), then siren up and back down on "oo". */
function sirenTurn(top: number, cue: string, up: number, down: number, holdTop = 0): PatternStep[] {
  return echoSlide([note(0, 1, { cue, syllable: 'oo' }), glide(0, top, up), ...(holdTop > 0 ? [note(top, holdTop)] : []), glide(top, 0, down)]);
}

/** Short notes on the beat, each its own clean start: a beat of silence between them. */
function shortNotes(semis: readonly number[], cue: string): PatternStep[] {
  return semis.flatMap((s, i) => [...(i > 0 ? [rest(1)] : []), note(s, 1, i === 0 ? { cue, syllable: 'ah' } : { syllable: 'ah' })]);
}

/** Hear the notes, then sing each one short and on the beat, starting it right on its pitch. */
function startsTurn(semis: readonly number[], cue: string): PatternStep[] {
  return [...hear(semis), ...shortNotes(semis, cue)];
}

// ---------------------------------------------------------------- how each skill is judged

type Judged = Pick<ExerciseDef, 'kind' | 'analyzers' | 'scoring' | 'pass' | 'tolerance' | 'tiers'>;

/** 02 Match one note: in tune, and found quickly (settling into the zone). */
function matching(): Judged {
  return {
    kind: 'pitch-match',
    analyzers: ['accuracy', 'onset'],
    scoring: terms('easy', { 'accuracy.inTolerancePct': 0.4, 'accuracy.medianAbsCents': 0.3, 'onset.settleMs': 0.3 }),
    pass: { score: PASS, gates: [gate('accuracy.inTolerancePct', 'easy'), gate('onset.settleMs', 'easy')] },
    tolerance: 'easy',
    tiers: TIERS,
  };
}

/** 03 Hold it: in the zone to the end of each note (in-tune time counts only the part of a note that was sung). */
function holding(tol: ToleranceLevel = 'easy'): Judged {
  return {
    kind: 'sustain',
    analyzers: ['accuracy'],
    scoring: terms(tol, { 'accuracy.inTolerancePct': 0.6, 'accuracy.medianAbsCents': 0.4 }),
    pass: { score: PASS, gates: [gate('accuracy.inTolerancePct', tol)] },
    tolerance: tol,
    tiers: TIERS,
  };
}

/** 04 Hold it steady: no wobble (the spread, gated half way up its band: the skill this level is about) and no drifting. */
function steadiness(): Judged {
  return {
    kind: 'sustain',
    analyzers: ['accuracy'],
    scoring: terms('default', {
      'accuracy.inTolerancePct': 0.3, 'accuracy.sdCents': 0.35, 'accuracy.absDriftCentsPerSec': 0.25, 'accuracy.medianAbsCents': 0.1,
    }),
    pass: {
      score: PASS,
      gates: [gate('accuracy.inTolerancePct', 'default'), gate('accuracy.sdCents', 'default', CORE_POINT), gate('accuracy.absDriftCentsPerSec', 'default')],
    },
    tolerance: 'default',
    tiers: TIERS,
  };
}

/** 05 Two notes, one step apart: both notes in tune; how fast each one lands counts a little. */
function stepping(): Judged {
  return {
    kind: 'intervals',
    analyzers: ['accuracy', 'onset'],
    scoring: terms('default', { 'accuracy.inTolerancePct': 0.45, 'accuracy.medianAbsCents': 0.3, 'onset.settleMs': 0.25 }),
    pass: { score: PASS, gates: [gate('accuracy.inTolerancePct', 'default')] },
    tolerance: 'default',
    tiers: TIERS,
  };
}

/** 06-07 jumps: in tune, and landing straight on the second note (settling in the zone at once, not sliding into it). */
function jumping(): Judged {
  return {
    kind: 'intervals',
    analyzers: ['accuracy', 'onset'],
    scoring: terms('default', { 'accuracy.inTolerancePct': 0.35, 'accuracy.medianAbsCents': 0.25, 'onset.settleMs': 0.4 }),
    pass: { score: PASS, gates: [gate('accuracy.inTolerancePct', 'default'), gate('onset.settleMs', 'default')] },
    tolerance: 'default',
    tiers: TIERS,
  };
}

/** 08-09 connected notes: in tune, and every note change clean (arrive, then hold: no smear between notes). */
function connecting(): Judged {
  return {
    kind: 'legato',
    analyzers: ['accuracy', 'transitions'],
    scoring: terms('default', { 'accuracy.inTolerancePct': 0.4, 'accuracy.medianAbsCents': 0.2, 'transition.cleanRate': 0.4 }),
    pass: { score: PASS, gates: [gate('accuracy.inTolerancePct', 'default'), gate('transition.cleanRate', 'default')] },
    tolerance: 'default',
    tiers: TIERS,
  };
}

/** 10 small slides (and the first slide of lesson 01): smooth, and arriving on the second note. */
function sliding(tol: ToleranceLevel = 'default'): Judged {
  return {
    kind: 'siren',
    analyzers: ['glide', 'cracks'],
    scoring: terms(tol, { 'glide.smoothness': 0.4, 'glide.endAbsCents': 0.4, 'glide.cracks': 0.2 }),
    pass: { score: PASS, gates: [gate('glide.smoothness', tol), gate('glide.endAbsCents', tol)] },
    tolerance: tol,
    tiers: TIERS,
  };
}

/** 11 sirens: unbroken first, then smooth and arriving home. */
function sirening(): Judged {
  return {
    kind: 'siren',
    analyzers: ['glide', 'cracks'],
    scoring: terms('default', { 'glide.smoothness': 0.4, 'glide.cracks': 0.35, 'glide.endAbsCents': 0.25 }),
    pass: { score: PASS, gates: [gate('glide.cracks', 'default'), gate('glide.smoothness', 'default'), gate('glide.endAbsCents', 'default')] },
    tolerance: 'default',
    tiers: TIERS,
  };
}

/** 12 clean starts: no scoop, in the zone at once. */
function starting(): Judged {
  return {
    kind: 'staccato',
    analyzers: ['onset', 'accuracy'],
    scoring: terms('default', {
      'onset.scoopCents': 0.3, 'onset.settleMs': 0.3, 'onset.overshootCents': 0.1, 'onset.crispRate': 0.1, 'accuracy.medianAbsCents': 0.2,
    }),
    pass: { score: PASS, gates: [gate('onset.settleMs', 'default'), gate('onset.scoopCents', 'default')] },
    tolerance: 'default',
    tiers: TIERS,
  };
}

const SILENT_GUIDE = { metronome: false } as const;

// ---------------------------------------------------------------- 01 Range finder (lesson: Your voice and your comfortable notes)
const RANGE_TEMPO = 60;
/** Each extreme is held about three times CONFIG.range.holdSec so the range analyzer can count it. */
const RANGE_HOLD_BEATS = Math.ceil((3 * CONFIG.range.holdSec * RANGE_TEMPO) / 60);

/**
 * The guide bars span an octave around the middle of the range, so they fit any plausible saved range; the cues invite
 * the singer past them while it stays easy. The range analyzer measures what was held, not the guides, so each half is
 * heard by its starting note only.
 */
export const rangeFinder = defineExercise({
  id: 'foundations.range.1',
  worldId: W,
  kind: 'range-finder',
  title: 'Range finder',
  goal: 'Find the notes that feel easy for your voice, so every exercise after this one fits you: nothing here is graded.',
  steps: [
    'Tap Listen to hear how it goes.',
    'Tap Sing. After the count-in the app plays a note: sing it back on “oo”, as in “food”.',
    'Let your voice slide down slowly, like a sigh. When it starts to feel like work, stop there and hold that note for a slow count of three.',
    'Take a breath. The app plays the first note again: sing it back.',
    'Now slide up slowly and lightly, like a siren. Stop before it strains, and hold that note for a slow count of three.',
    'Never push or strain. Easy notes are the right answer.',
  ],
  passPlain:
    'Hold one low note and one high note for a slow count of three each, as far apart as “Some-” and “-where” in “Somewhere Over the Rainbow”.',
  pattern: [
    ...hear([0], 2),
    note(0, 2, { cue: 'Sing it on “oo”', syllable: 'oo' }),
    glide(0, -5, 4, { cue: 'Slide down slowly, like a sigh' }),
    note(-5, RANGE_HOLD_BEATS, { cue: 'Hold your lowest easy note' }),
    { beats: 1, cue: 'Take a breath' },
    ...hear([0], 2),
    note(0, 2, { cue: 'Sing it again on “oo”', syllable: 'oo' }),
    glide(0, 7, 4, { cue: 'Slide up slowly and lightly' }),
    note(7, RANGE_HOLD_BEATS, { cue: 'Hold your highest easy note' }),
  ],
  tempoBpm: RANGE_TEMPO,
  tonicPlacement: 'mid',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'sine', vibrato: null },
  analyzers: ['range'],
  scoring: terms('easy', { 'range.spanSemitones': 1 }),
  // Measuring, not judging: any honest span of an octave passes (holding the guide bars is exactly that), and
  // every exercise fits a range that wide. Never reward straining: 16 semitones is already full marks.
  pass: { score: PASS, gates: [gateAt('range.spanSemitones', '>=', RANGE_MIN_SPAN)] },
  tolerance: 'easy',
  tiers: TIERS,
});

export const drillSeeYourVoice = defineExercise({
  id: 'foundations.drill.see-your-voice',
  worldId: W,
  title: 'See your voice',
  goal: 'Hear a note, sing it back on “oo”, and watch your line follow your voice up and back down.',
  pattern: turns(
    holdTurn(0, 3, 'Sing it on “oo”', 'oo'),
    holdTurn(4, 3, 'A higher one: watch your line rise', 'oo'),
    holdTurn(0, 3, 'Back down again', 'oo'),
  ),
  tempoBpm: 60,
  tonicPlacement: 'mid',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'soft', vibrato: null },
  ...holding('easy'),
});

export const drillFirstSlide = defineExercise({
  id: 'foundations.drill.first-slide',
  worldId: W,
  title: 'One slow slide',
  goal: 'Hear the slide, then let your voice slide slowly down and back up on “oo”.',
  pattern: echoSlide([note(0, 1, { cue: 'Slide down slowly, like a sigh', syllable: 'oo' }), glide(0, -5, 3), glide(-5, 0, 3, { cue: 'And slowly back up' }), note(0, 1)]),
  tempoBpm: 60,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'sine', vibrato: null },
  ...sliding('easy'),
});

// ---------------------------------------------------------------- 02 Match one note
export const pitchMatch = defineExercise({
  id: 'foundations.match.1',
  worldId: W,
  title: 'Match one note',
  goal: 'Hear a note, then sing it back on the same pitch: five notes, one at a time.',
  steps: [
    'After the count-in the app plays a note. Just listen.',
    'Hear it again in your head, and take a breath.',
    'Sing it back on “ah” for two seconds, and bring your line into the in-tune zone.',
    'Then the next note: five in all.',
  ],
  passPlain: 'Sing each note back inside the in-tune zone for about two thirds of the note, and find it within about half a second.',
  pattern: turns(...[0, 4, 2, -3, 5].map((s) => holdTurn(s, 2, 'Sing it back'))),
  tempoBpm: 60,
  tonicPlacement: 'mid',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  ...matching(),
});

export const drillEchoOne = defineExercise({
  id: 'foundations.drill.echo-one',
  worldId: W,
  title: 'Echo one note',
  goal: 'Hear a note and sing it back, three times on the same note.',
  pattern: turns(holdTurn(0, 2, 'Sing it back'), holdTurn(0, 2, 'Again'), holdTurn(0, 2, 'Once more')),
  tempoBpm: 60,
  tonicPlacement: 'mid',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  ...matching(),
});

export const drillHumThenSing = defineExercise({
  id: 'foundations.drill.hum-then-sing',
  worldId: W,
  title: 'Hum it, then sing it',
  goal: 'Hear a note, hum it quietly, then open the hum into “ah” on the same note.',
  pattern: turns(
    openTurn(0, { beats: 2, cue: 'Hum it: “mm”', syllable: 'mm' }, { beats: 2, cue: 'Open to “ah”', syllable: 'ah' }),
    openTurn(3, { beats: 2, cue: 'Hum it: “mm”', syllable: 'mm' }, { beats: 2, cue: 'Open to “ah”', syllable: 'ah' }),
  ),
  tempoBpm: 60,
  tonicPlacement: 'mid',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'soft', vibrato: null },
  ...matching(),
});

export const drillEchoNew = defineExercise({
  id: 'foundations.drill.echo-new',
  worldId: W,
  title: 'A new note each time',
  goal: 'Hear a note and sing it back, then a different one: three notes in all.',
  pattern: turns(holdTurn(0, 2, 'Sing it back'), holdTurn(4, 2, 'Sing it back'), holdTurn(-2, 2, 'Sing it back')),
  tempoBpm: 60,
  tonicPlacement: 'mid',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  ...matching(),
});

// ---------------------------------------------------------------- 03 Hold it
export const holdIt = defineExercise({
  id: 'foundations.hold.1',
  worldId: W,
  title: 'Hold it',
  goal: 'Hear a note, then hold it for four seconds on one breath: three notes in all.',
  steps: [
    'Before each note, breathe in low and slow: your belly and lower ribs move out, your shoulders stay still.',
    'The app plays a note. Then sing it back on “ah”.',
    'Keep it going for the whole bar, four seconds, letting the air out slowly and evenly.',
    'At the end of the bar, stop, breathe, and get ready for the next note.',
  ],
  passPlain: 'Hold each note for its full four seconds, inside the in-tune zone for about two thirds of the time.',
  pattern: turns(holdTurn(0, 4, 'Hold it to the end'), holdTurn(3, 4, 'Hold it to the end'), holdTurn(-2, 4, 'Hold it to the end')),
  tempoBpm: 60,
  tonicPlacement: 'mid',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'soft', vibrato: null },
  ...holding(),
});

export const drillHold2 = defineExercise({
  id: 'foundations.drill.hold-2s',
  worldId: W,
  title: 'Hold for 2 seconds',
  goal: 'Hear a note, then hold it for two seconds: three notes in all.',
  pattern: turns(holdTurn(0, 2, 'Hold it'), holdTurn(2, 2, 'Hold it'), holdTurn(-2, 2, 'Hold it')),
  tempoBpm: 60,
  tonicPlacement: 'mid',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'soft', vibrato: null },
  ...holding(),
});

export const drillHold3 = defineExercise({
  id: 'foundations.drill.hold-3s',
  worldId: W,
  title: 'Hold for 3 seconds',
  goal: 'Hear a note, then hold it for three seconds on one easy breath: two notes in all.',
  pattern: turns(holdTurn(0, 3, 'Hold it to the end'), holdTurn(3, 3, 'Hold it to the end')),
  tempoBpm: 60,
  tonicPlacement: 'mid',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'soft', vibrato: null },
  ...holding(),
});

export const drillHold4 = defineExercise({
  id: 'foundations.drill.hold-4s',
  worldId: W,
  title: 'Hold for 4 seconds',
  goal: 'Hear a note, then hold it for four seconds, letting the air out slowly: two notes in all.',
  pattern: turns(holdTurn(0, 4, 'Hold it to the end'), holdTurn(-2, 4, 'Hold it to the end')),
  tempoBpm: 60,
  tonicPlacement: 'mid',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'soft', vibrato: null },
  ...holding(),
});

// ---------------------------------------------------------------- 04 (.13) Hold it steady
export const holdItSteady = defineExercise({
  id: 'foundations.steady.1',
  worldId: W,
  title: 'Hold it steady',
  goal: 'Hear a note, then hold it for four, five and six seconds with your line level: no wobble, no drifting.',
  steps: [
    'Sing softly, on a relaxed “ah”: about as loud as talking to someone across a table.',
    'Let the air out slowly and evenly, as if through a straw.',
    'Keep your jaw, tongue and shoulders loose, and watch your line stay level.',
    'If your line starts to sink, give it a little more breath support, not force.',
  ],
  passPlain: 'Hold each note in the in-tune zone for at least half of it, with your line level: only a small wobble, and no drifting away.',
  pattern: turns(holdTurn(0, 4, 'Hold it steady'), holdTurn(2, 5, 'Keep your line level'), holdTurn(-1, 6, 'Steady to the end')),
  tempoBpm: 60,
  tonicPlacement: 'mid',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'soft', vibrato: null },
  ...steadiness(),
});

export const drillSteadySoft = defineExercise({
  id: 'foundations.drill.steady-soft',
  worldId: W,
  title: 'Soft and steady on “oo”',
  goal: 'Hear a note, then hold it softly on “oo”, lips round as if through a straw, keeping your line level.',
  pattern: turns(holdTurn(0, 3, 'Softly on “oo”', 'oo'), holdTurn(0, 3, 'Softly, keep it level', 'oo')),
  tempoBpm: 60,
  tonicPlacement: 'mid',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'soft', vibrato: null },
  ...steadiness(),
});

export const drillSteadyHum = defineExercise({
  id: 'foundations.drill.steady-hum',
  worldId: W,
  title: 'Hum it level',
  goal: 'Hear a note, then hum it on “mm” for four seconds with an even stream of air and a level line.',
  pattern: turns(holdTurn(0, 4, 'Hum it level: “mm”', 'mm'), holdTurn(2, 4, 'Hum it level: “mm”', 'mm')),
  tempoBpm: 60,
  tonicPlacement: 'mid',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'soft', vibrato: null },
  ...steadiness(),
});

export const drillSteadyOpen = defineExercise({
  id: 'foundations.drill.steady-open',
  worldId: W,
  title: 'Open the vowel, keep it level',
  goal: 'Hear a note, start it on a soft “oo”, then open to “ah” without letting your line move.',
  pattern: turns(
    openTurn(0, { beats: 2, cue: 'Start on a soft “oo”', syllable: 'oo' }, { beats: 3, cue: 'Open to “ah”, keep it level', syllable: 'ah' }),
    openTurn(2, { beats: 2, cue: 'Start on a soft “oo”', syllable: 'oo' }, { beats: 3, cue: 'Open to “ah”, keep it level', syllable: 'ah' }),
  ),
  tempoBpm: 60,
  tonicPlacement: 'mid',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'soft', vibrato: null },
  ...steadiness(),
});

export const drillSteadySix = defineExercise({
  id: 'foundations.drill.steady-6s',
  worldId: W,
  title: 'Six seconds, level to the end',
  goal: 'Hear a note, then hold it for six seconds with your line level, keeping the air flowing so it never sinks.',
  pattern: turns(holdTurn(0, 6, 'Level to the end'), holdTurn(2, 6, 'Level to the end')),
  tempoBpm: 60,
  tonicPlacement: 'mid',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'soft', vibrato: null },
  ...steadiness(),
});

// ---------------------------------------------------------------- 05 (.10) Two notes, one step apart
export const twoNotesStep = defineExercise({
  id: 'foundations.steps.1',
  worldId: W,
  title: 'Two notes, one step apart',
  goal: 'Hear two neighbouring notes, then sing them back one after the other, each one in tune.',
  steps: [
    'The app plays two notes, one step apart. Notice whether the second goes up or down.',
    'Sing the first, take a quick breath, then sing the second.',
    'A step is small: the second note sits just above or just below the first.',
    'Four pairs in all. The last two are half steps: even closer together.',
  ],
  passPlain: 'Sing both notes of each pair inside the in-tune zone for at least half of each note.',
  pattern: turns(pairTurn(0, 2, 'Step up'), pairTurn(2, 0, 'Step down'), pairTurn(4, 5, 'Half step up'), pairTurn(5, 4, 'Half step down')),
  tempoBpm: 60,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  ...stepping(),
});

export const drillStepUp = defineExercise({
  id: 'foundations.drill.step-up',
  worldId: W,
  title: 'One step up',
  goal: 'Hear two notes a step apart, then sing the first and step up to the second.',
  pattern: turns(pairTurn(0, 2, 'Step up'), pairTurn(2, 4, 'Step up')),
  tempoBpm: 60,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  ...stepping(),
});

export const drillStepDown = defineExercise({
  id: 'foundations.drill.step-down',
  worldId: W,
  title: 'One step down',
  goal: 'Hear two notes a step apart, then sing the first and step down to the second.',
  pattern: turns(pairTurn(4, 2, 'Step down'), pairTurn(2, 0, 'Step down')),
  tempoBpm: 60,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  ...stepping(),
});

export const drillHalfStep = defineExercise({
  id: 'foundations.drill.half-step',
  worldId: W,
  title: 'A half step',
  goal: 'Hear two notes a half step apart, the closest two notes can be, then sing them back.',
  pattern: turns(pairTurn(4, 5, 'Half step up'), pairTurn(5, 4, 'Half step down')),
  tempoBpm: 60,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  ...stepping(),
});

// ---------------------------------------------------------------- 06 (.07) Two notes, a jump apart
export const jumpApart = defineExercise({
  id: 'foundations.jumps.1',
  worldId: W,
  title: 'Two notes, a jump apart',
  goal: 'Hear two notes a jump apart, then sing the first and jump straight to the second: small jumps first, then bigger ones.',
  steps: [
    'The app plays two notes. Hear the second one in your head before you sing.',
    'Sing the first, take a quick breath, then start the second right on its pitch.',
    'Do not slide up or down to get there: land, then hold.',
    'The first two jumps are small; the last two are like the start of “Twinkle, Twinkle, Little Star”.',
  ],
  passPlain:
    'Sing both notes of each pair in the in-tune zone for at least half of each note, and land on the second within about a third of a second, without sliding into it.',
  pattern: turns(pairTurn(0, 4, 'Jump up to it'), pairTurn(4, 0, 'Jump down to it'), pairTurn(0, 7, 'Jump up to it'), pairTurn(7, 0, 'Jump down to it')),
  tempoBpm: 60,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  ...jumping(),
});

export const drillJumpSmall = defineExercise({
  id: 'foundations.drill.jump-small',
  worldId: W,
  title: 'Small jumps',
  goal: 'Hear two notes a small jump apart, then sing them back, landing the second right on its pitch.',
  pattern: turns(pairTurn(0, 4, 'Jump up to it'), pairTurn(4, 0, 'Jump down to it')),
  tempoBpm: 60,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  ...jumping(),
});

export const drillJumpTwinkle = defineExercise({
  id: 'foundations.drill.jump-twinkle',
  worldId: W,
  title: 'The “Twinkle” jump',
  goal: 'Hear the jump from the start of “Twinkle, Twinkle, Little Star”, then sing it up and back down.',
  pattern: turns(pairTurn(0, 7, 'Jump up to it'), pairTurn(7, 0, 'Jump down to it')),
  tempoBpm: 60,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  ...jumping(),
});

export const drillJumpLand = defineExercise({
  id: 'foundations.drill.jump-land',
  worldId: W,
  title: 'Land it straight away',
  goal: 'Hear two notes a jump apart, then land the second one right on its pitch the moment you start it.',
  pattern: turns(pairTurn(0, 4, 'Land right on it'), pairTurn(0, 7, 'Land right on it')),
  tempoBpm: 60,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  ...jumping(),
});

// ---------------------------------------------------------------- 07 (.08) Bigger jumps
export const biggerJumps = defineExercise({
  id: 'foundations.jumps.2',
  worldId: W,
  title: 'Bigger jumps',
  goal: 'Hear two notes as far as an octave apart, then sing them back, landing the second right on its pitch.',
  steps: [
    'The app plays two notes, far apart. Hear the second in your head before you leave the first.',
    'Sing the first, take a quick breath, then land the second.',
    'Keep the top notes light: less weight, a little more breath support, never force.',
    'Two of the jumps are octaves: the same note, higher or lower, like “Some-where”.',
  ],
  passPlain:
    'Sing both notes of each pair in the in-tune zone for at least half of each note, and land on the second within about a third of a second, without sliding into it.',
  pattern: turns(pairTurn(0, 7, 'Jump up to it'), pairTurn(0, 12, 'Up an octave'), pairTurn(12, 0, 'Down an octave'), pairTurn(12, 5, 'Jump down to it')),
  tempoBpm: 60,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  ...jumping(),
});

export const drillOctaveUp = defineExercise({
  id: 'foundations.drill.octave-up',
  worldId: W,
  title: 'An octave up',
  goal: 'Hear a note and the same note an octave higher, then sing them, keeping the top one light.',
  pattern: turns(pairTurn(0, 12, 'Up an octave'), pairTurn(0, 12, 'Up an octave')),
  tempoBpm: 60,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  ...jumping(),
});

export const drillOctaveDown = defineExercise({
  id: 'foundations.drill.octave-down',
  worldId: W,
  title: 'An octave down',
  goal: 'Hear a note and the same note an octave lower, then sing them, letting the low one land gently.',
  pattern: turns(pairTurn(12, 0, 'Down an octave'), pairTurn(12, 0, 'Down an octave')),
  tempoBpm: 60,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  ...jumping(),
});

export const drillJumpMixed = defineExercise({
  id: 'foundations.drill.jump-mixed',
  worldId: W,
  title: 'Big jumps, up and down',
  goal: 'Hear two notes far apart, one jump up and one jump down, then land each second note right on its pitch.',
  pattern: turns(pairTurn(0, 7, 'Jump up to it'), pairTurn(12, 5, 'Jump down to it')),
  tempoBpm: 60,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  ...jumping(),
});

// ---------------------------------------------------------------- 08 (.11) Three notes: do-re-mi
export const doReMi = defineExercise({
  id: 'foundations.do-re-mi.1',
  worldId: W,
  title: 'Three notes: do-re-mi',
  goal: 'Hear three notes in a row, then sing them back as one joined line: do-re-mi and back, then re-mi-fa and back.',
  steps: [
    'The app plays three notes. Sing them quietly in your head: do, re, mi.',
    'Then sing them back on one breath, joined together, without stopping between them.',
    'Move straight from each note to the next, and give the last one a moment longer.',
    'Four groups of three in all.',
  ],
  passPlain:
    'Sing all three notes of each group in the in-tune zone for at least half of each note, moving cleanly from one note to the next.',
  pattern: turns(lineTurn([0, 2, 4], 'Do-re-mi'), lineTurn([4, 2, 0], 'Mi-re-do'), lineTurn([2, 4, 5], 'Re-mi-fa'), lineTurn([5, 4, 2], 'Fa-mi-re')),
  tempoBpm: 66,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  ...connecting(),
});

export const drillDoReMi = defineExercise({
  id: 'foundations.drill.do-re-mi',
  worldId: W,
  title: 'Do-re-mi',
  goal: 'Hear do-re-mi, then sing it back as one joined line, twice.',
  pattern: turns(lineTurn([0, 2, 4], 'Do-re-mi'), lineTurn([0, 2, 4], 'Do-re-mi')),
  tempoBpm: 66,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  ...connecting(),
});

export const drillMiReDo = defineExercise({
  id: 'foundations.drill.mi-re-do',
  worldId: W,
  title: 'Mi-re-do',
  goal: 'Hear mi-re-do, then sing it back down as one joined line, twice.',
  pattern: turns(lineTurn([4, 2, 0], 'Mi-re-do'), lineTurn([4, 2, 0], 'Mi-re-do')),
  tempoBpm: 66,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  ...connecting(),
});

export const drillReMiFa = defineExercise({
  id: 'foundations.drill.re-mi-fa',
  worldId: W,
  title: 'Re-mi-fa and back',
  goal: 'Hear re-mi-fa, with its half step at the top, then sing it up and back down as joined lines.',
  pattern: turns(lineTurn([2, 4, 5], 'Re-mi-fa'), lineTurn([5, 4, 2], 'Fa-mi-re')),
  tempoBpm: 66,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  ...connecting(),
});

// ---------------------------------------------------------------- 09 Five notes in a row
export const fiveInARow = defineExercise({
  id: 'foundations.five-notes.1',
  worldId: W,
  title: 'Five notes in a row',
  goal: 'Learn five notes in a row in two halves, then sing the whole line up and back down, each time on one breath.',
  steps: [
    'Do-re-mi first, then mi-fa-sol: each one heard, then sung back.',
    'Then the app plays all five: sing them back up as one phrase, on one breath.',
    'Then all five back down.',
    'Keep the sound joined, like one long word, and let every note arrive on its bar.',
  ],
  passPlain:
    'Sing every note in the in-tune zone for at least half of it, moving cleanly from note to note, the whole line up and down.',
  pattern: turns(
    lineTurn([0, 2, 4], 'Do-re-mi'),
    lineTurn([4, 5, 7], 'Mi-fa-sol'),
    lineTurn([0, 2, 4, 5, 7], 'All five, one breath'),
    lineTurn([7, 5, 4, 2, 0], 'And all the way down'),
  ),
  tempoBpm: 72,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  ...connecting(),
});

export const drillTopHalf = defineExercise({
  id: 'foundations.drill.top-half',
  worldId: W,
  title: 'The top half: mi-fa-sol',
  goal: 'Hear mi-fa-sol, then sing it up and back down as joined lines.',
  pattern: turns(lineTurn([4, 5, 7], 'Mi-fa-sol'), lineTurn([7, 5, 4], 'Sol-fa-mi')),
  tempoBpm: 72,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  ...connecting(),
});

export const drillFiveUp = defineExercise({
  id: 'foundations.drill.five-up',
  worldId: W,
  title: 'Two halves, then all five up',
  goal: 'Sing do-re-mi, then mi-fa-sol, then all five notes up as one phrase.',
  pattern: turns(lineTurn([0, 2, 4], 'Do-re-mi'), lineTurn([4, 5, 7], 'Mi-fa-sol'), lineTurn([0, 2, 4, 5, 7], 'All five, one breath')),
  tempoBpm: 72,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  ...connecting(),
});

export const drillFiveDown = defineExercise({
  id: 'foundations.drill.five-down',
  worldId: W,
  title: 'Two halves, then all five down',
  goal: 'Sing sol-fa-mi, then mi-re-do, then all five notes down as one phrase.',
  pattern: turns(lineTurn([7, 5, 4], 'Sol-fa-mi'), lineTurn([4, 2, 0], 'Mi-re-do'), lineTurn([7, 5, 4, 2, 0], 'All five, down')),
  tempoBpm: 72,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  ...connecting(),
});

// ---------------------------------------------------------------- 10 (.12) Small slides
export const smallSlides = defineExercise({
  id: 'foundations.slides.1',
  worldId: W,
  title: 'Small slides',
  goal: 'Hear where each slide starts and lands, then slide smoothly from one note to the other on “oo”.',
  steps: [
    'The app plays two notes: where the slide starts, and where it lands.',
    'Hold the first note, then move your voice slowly and evenly to the second, through every pitch in between.',
    'Keep the air flowing so the sound never stops, then hold the landing note.',
    'A step up and down first, then a wider slide.',
  ],
  passPlain: 'Make each slide one smooth, even line with no bumps on the way, and end it close to the second note.',
  pattern: turns(slideTurn(0, 2, 'Slide up'), slideTurn(2, 0, 'Slide down'), slideTurn(0, 4, 'A wider slide up'), slideTurn(4, 0, 'And back down')),
  tempoBpm: 60,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'sine', vibrato: null },
  ...sliding(),
});

export const drillSlideUp = defineExercise({
  id: 'foundations.drill.slide-up',
  worldId: W,
  title: 'Slide up a step',
  goal: 'Hear two notes a step apart, then slide smoothly up from the first to the second.',
  pattern: turns(slideTurn(0, 2, 'Slide up'), slideTurn(0, 2, 'Slide up, slowly')),
  tempoBpm: 60,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'sine', vibrato: null },
  ...sliding(),
});

export const drillSlideDown = defineExercise({
  id: 'foundations.drill.slide-down',
  worldId: W,
  title: 'Slide down a step',
  goal: 'Hear two notes a step apart, then slide smoothly down from the first to the second.',
  pattern: turns(slideTurn(2, 0, 'Slide down'), slideTurn(2, 0, 'Slide down, slowly')),
  tempoBpm: 60,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'sine', vibrato: null },
  ...sliding(),
});

export const drillSlideWider = defineExercise({
  id: 'foundations.drill.slide-wider',
  worldId: W,
  title: 'A wider slide',
  goal: 'Hear two notes a little further apart, then slide up between them and back down, smoothly both ways.',
  pattern: turns(slideTurn(0, 4, 'A wider slide up'), slideTurn(4, 0, 'And back down')),
  tempoBpm: 60,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'sine', vibrato: null },
  ...sliding(),
});

// ---------------------------------------------------------------- 11 (.05) Sirens
export const sirens = defineExercise({
  id: 'foundations.sirens.1',
  worldId: W,
  title: 'Sirens',
  goal: 'Hear where each siren goes, then slide up and down smoothly on “oo”, without a crack.',
  steps: [
    'The app plays the bottom, the top and the bottom again: that is the siren’s path.',
    'Slide up and back down on a light, easy “oo”, like an ambulance going by.',
    'Let the sound get thinner and lighter as you go up, through the gear change.',
    'A small siren, then a full octave, then a quicker one.',
  ],
  passPlain: 'Siren up and down smoothly on “oo”, ending close to the note you started on, with no more than three cracks.',
  pattern: turns(
    sirenTurn(7, 'Gentle siren on “oo”', 2, 2),
    sirenTurn(12, 'Up the octave, light and smooth', 3, 3, 1),
    sirenTurn(12, 'Quicker, still unbroken', 2, 2),
  ),
  tempoBpm: 60,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'sine', vibrato: null },
  ...sirening(),
});

export const drillSirenSmall = defineExercise({
  id: 'foundations.drill.siren-small',
  worldId: W,
  title: 'A small siren',
  goal: 'Hear a small siren’s path, then slide up and back down on a light “oo”, twice.',
  pattern: turns(sirenTurn(7, 'Small siren on “oo”', 2, 2), sirenTurn(7, 'Again, a little lighter', 2, 2)),
  tempoBpm: 60,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'sine', vibrato: null },
  ...sirening(),
});

export const drillSirenOctave = defineExercise({
  id: 'foundations.drill.siren-octave',
  worldId: W,
  title: 'Through the gear change',
  goal: 'Hear an octave siren’s path, then slide up and back down, letting the sound lighten through the gear change.',
  pattern: sirenTurn(12, 'Light and smooth, all the way up', 3, 3, 1),
  tempoBpm: 60,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'sine', vibrato: null },
  ...sirening(),
});

// ---------------------------------------------------------------- 12 (.06) Clean starts
export const cleanStarts = defineExercise({
  id: 'foundations.clean-starts.1',
  worldId: W,
  title: 'Clean starts',
  goal: 'Hear three notes, then sing each one short and on the beat, starting it right on its pitch.',
  steps: [
    'The count-in sets the beat. After that, nothing plays while you sing.',
    'The app plays three notes. Hear each one in your head.',
    'Sing them back one at a time, short and on the beat, each starting right on its pitch.',
    'No scoop: start the sound already on the note, never below it.',
  ],
  passPlain: 'Start each short note right on its pitch: no scoop up from below, and in the in-tune zone within about a third of a second.',
  pattern: turns(startsTurn([0, 4, 7], 'Short, right on the note'), startsTurn([7, 4, 0], 'Short, right on the note'), startsTurn([2, 5, 9], 'Short, right on the note')),
  tempoBpm: 72,
  tonicPlacement: 'fit-span',
  countInBeats: 4,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  ...starting(),
});

export const drillCleanOne = defineExercise({
  id: 'foundations.drill.clean-one',
  worldId: W,
  title: 'One note, three clean starts',
  goal: 'Hear a note, then start it three times, short and on the beat, right on its pitch each time.',
  pattern: turns([...hear([0], 2), ...shortNotes([0, 0, 0], 'Short, right on the note')], [...hear([4], 2), ...shortNotes([4, 4, 4], 'Short, right on the note')]),
  tempoBpm: 72,
  tonicPlacement: 'fit-span',
  countInBeats: 4,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  ...starting(),
});

export const drillCleanThree = defineExercise({
  id: 'foundations.drill.clean-three',
  worldId: W,
  title: 'Three notes, three clean starts',
  goal: 'Hear three notes, then sing each one short and on the beat, starting it right on its pitch.',
  pattern: turns(startsTurn([0, 4, 7], 'Short, right on the note'), startsTurn([7, 4, 0], 'Short, right on the note')),
  tempoBpm: 72,
  tonicPlacement: 'fit-span',
  countInBeats: 4,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  ...starting(),
});

// ---------------------------------------------------------------- 13 Boss Recital: a short tune
/**
 * The tune, phrase by phrase: a long do held steady; do-re-mi; a jump up to sol; sol-fa-mi back down; re sliding home to
 * do. Every phrase is heard, then sung, and starts from silence (a clean start each time).
 */
const TUNE = {
  hold: () => [...hear([0], 2, false), note(0, 4, { cue: 'Hold it steady', syllable: 'la' })],
  climb: () => [...hear([0, 2, 4], 1, false), note(0, 1, { cue: 'Do-re-mi', syllable: 'la' }), note(2, 1, { syllable: 'la' }), note(4, 2, { syllable: 'la' })],
  jump: () => [...hear([4, 7], 1, false), note(4, 1, { cue: 'Jump up to sol', syllable: 'la' }), note(7, 2, { syllable: 'la' })],
  descend: () => [...hear([7, 5, 4], 1, false), note(7, 1, { cue: 'Step back down', syllable: 'la' }), note(5, 1, { syllable: 'la' }), note(4, 2, { syllable: 'la' })],
  home: () => echoSlide([note(2, 1, { cue: 'Slide home', syllable: 'la' }), glide(2, 0, 1), note(0, 3, { syllable: 'la' })], false),
} as const;

/** The same phrases in a practice drill, each breath labelled as the singer's turn. */
function tunePractice(...phrases: Array<() => PatternStep[]>): PatternStep[] {
  return turns(...phrases.map((p) => p().map((s) => (s.semis === undefined && s.cue === undefined ? { ...s, cue: YOUR_TURN } : s))));
}

export const foundationsBoss = defineExercise({
  id: 'foundations.boss-tune',
  worldId: W,
  kind: 'boss-recital',
  title: 'Foundations Boss Recital',
  goal: 'Sing a short tune, phrase by phrase, that puts together everything Foundations taught you.',
  steps: [
    'The app plays each phrase first; then you sing it back.',
    'Hold the first note level, keep do-re-mi joined, land the jump, step back down, and slide home.',
    'Start every phrase right on its first note, and sing every note to the end.',
  ],
  passPlain:
    'Sing every note of the tune in the in-tune zone for at least half of it, starting each phrase without a scoop and moving cleanly from note to note.',
  pattern: turns(TUNE.hold(), TUNE.climb(), TUNE.jump(), TUNE.descend(), TUNE.home()),
  tempoBpm: 66,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  analyzers: ['accuracy', 'onset', 'transitions'],
  scoring: terms('default', {
    'accuracy.inTolerancePct': 0.3, 'accuracy.sdCents': 0.15, 'accuracy.medianAbsCents': 0.1, 'onset.scoopCents': 0.15, 'onset.settleMs': 0.1,
    'transition.cleanRate': 0.2,
  }),
  pass: {
    score: PASS,
    gates: [gate('accuracy.inTolerancePct', 'default'), gate('onset.scoopCents', 'default'), gate('transition.cleanRate', 'default')],
  },
  tolerance: 'default',
  tiers: TIERS,
});

export const drillTuneStart = defineExercise({
  id: 'foundations.drill.tune-start',
  worldId: W,
  title: 'The tune: how it starts',
  goal: 'Hear and sing the first two phrases of the tune: a long, level do, then do-re-mi.',
  pattern: tunePractice(TUNE.hold, TUNE.climb),
  tempoBpm: 66,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  ...connecting(),
});

export const drillTuneMiddle = defineExercise({
  id: 'foundations.drill.tune-middle',
  worldId: W,
  title: 'The tune: the middle',
  goal: 'Hear and sing the middle of the tune: the jump up to sol, then sol-fa-mi.',
  pattern: tunePractice(TUNE.jump, TUNE.descend),
  tempoBpm: 66,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  ...connecting(),
});

/** The ending is its slide: judged as a small slide (smooth, arriving on do). */
export const drillTuneEnd = defineExercise({
  id: 'foundations.drill.tune-end',
  worldId: W,
  title: 'The tune: how it ends',
  goal: 'Hear and sing the end of the tune twice: re, sliding home to do, then holding it.',
  pattern: tunePractice(TUNE.home, TUNE.home),
  tempoBpm: 66,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  ...sliding(),
});

// ---------------------------------------------------------------- Audition
// Sung in level order, each test covering the levels past the one before it (progress/auditions.ts): match and hold
// through Hold it steady, steps and jumps through Bigger jumps, the connected line through Five notes in a row, the
// siren through Sirens. Clean starts and the Boss Recital are always sung. The tests are new material with new ids
// (.5 to .8, in the order they are sung); the old audition's tests (.1 to .4) are retired, and what a pass of one
// granted when it was sung stays granted (AuditionDef.former).

export const foundationsAudition1 = defineExercise({
  id: 'foundations.audition.5',
  worldId: W,
  kind: 'audition',
  title: 'Audition: match and hold',
  goal: 'Hear each note, then sing it back and hold it for five seconds, level and in tune.',
  pattern: turns(holdTurn(0, 5, 'Hold it steady'), holdTurn(3, 5, 'Hold it steady')),
  tempoBpm: 60,
  tonicPlacement: 'mid',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'soft', vibrato: null },
  analyzers: ['accuracy', 'onset'],
  scoring: terms('default', {
    'accuracy.inTolerancePct': 0.3, 'accuracy.sdCents': 0.25, 'accuracy.absDriftCentsPerSec': 0.15, 'accuracy.medianAbsCents': 0.15,
    'onset.settleMs': 0.15,
  }),
  pass: {
    score: PASS,
    gates: [gate('accuracy.inTolerancePct', 'default'), gate('accuracy.sdCents', 'default', CORE_POINT), gate('accuracy.absDriftCentsPerSec', 'default')],
  },
  tolerance: 'default',
  tiers: TIERS,
});

/**
 * How each landing starts counts as well as how fast it finds the note (no scoop up into it, no going past it): the voice
 * check-up rates "note starts" from this take (checkup/types.ts), so the take scores all three.
 */
export const foundationsAudition3 = defineExercise({
  id: 'foundations.audition.6',
  worldId: W,
  kind: 'audition',
  title: 'Audition: steps and jumps',
  goal: 'Hear two notes, then sing them back, landing the second right on its pitch: a step, a jump down, then an octave up.',
  pattern: turns(pairTurn(0, 2, 'Step up'), pairTurn(7, 0, 'Jump down to it'), pairTurn(0, 12, 'Up an octave')),
  tempoBpm: 60,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  analyzers: ['accuracy', 'onset'],
  scoring: terms('default', {
    'accuracy.inTolerancePct': 0.3, 'accuracy.medianAbsCents': 0.2, 'onset.settleMs': 0.3, 'onset.scoopCents': 0.12, 'onset.overshootCents': 0.08,
  }),
  pass: { score: PASS, gates: [gate('accuracy.inTolerancePct', 'default'), gate('onset.settleMs', 'default')] },
  tolerance: 'default',
  tiers: TIERS,
});

export const foundationsAudition4 = defineExercise({
  id: 'foundations.audition.7',
  worldId: W,
  kind: 'audition',
  title: 'Audition: a connected line',
  goal: 'Hear a few notes in a row, then sing them back as one smooth line: two halves up, then all five down.',
  pattern: turns(lineTurn([0, 2, 4], 'Do-re-mi'), lineTurn([4, 5, 7], 'Mi-fa-sol'), lineTurn([7, 5, 4, 2, 0], 'All five, down')),
  tempoBpm: 72,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'piano', vibrato: null },
  analyzers: ['accuracy', 'transitions'],
  scoring: terms('default', { 'accuracy.inTolerancePct': 0.4, 'accuracy.medianAbsCents': 0.2, 'transition.cleanRate': 0.4 }),
  pass: { score: PASS, gates: [gate('accuracy.inTolerancePct', 'default'), gate('transition.cleanRate', 'default')] },
  tolerance: 'default',
  tiers: TIERS,
});

export const foundationsAudition2 = defineExercise({
  id: 'foundations.audition.8',
  worldId: W,
  kind: 'audition',
  title: 'Audition: siren',
  goal: 'Hear where the siren goes, then slide up an octave and back down on “oo” with no break.',
  pattern: sirenTurn(12, 'One siren on “oo”, no break', 3, 3, 1),
  tempoBpm: 60,
  tonicPlacement: 'fit-span',
  countInBeats: 2,
  ...SILENT_GUIDE,
  demo: { timbre: 'sine', vibrato: null },
  analyzers: ['glide', 'cracks'],
  scoring: terms('default', { 'glide.smoothness': 0.4, 'glide.cracks': 0.35, 'glide.endAbsCents': 0.25 }),
  pass: { score: PASS, gates: [gateAt('glide.cracks', '<=', 1), gate('glide.smoothness', 'default'), gate('glide.endAbsCents', 'default')] },
  tolerance: 'default',
  tiers: TIERS,
});

/** The lesson checks, in level order. */
const CHECKS: readonly ExerciseDef[] = [
  rangeFinder, pitchMatch, holdIt, holdItSteady, twoNotesStep, jumpApart, biggerJumps, doReMi, fiveInARow, smallSlides, sirens, cleanStarts,
  foundationsBoss,
];

/** The lessons' practice drills (src/lessons/foundations.ts), lesson by lesson. */
export const FOUNDATIONS_DRILLS: readonly ExerciseDef[] = [
  drillSeeYourVoice, drillFirstSlide,
  drillEchoOne, drillHumThenSing, drillEchoNew,
  drillHold2, drillHold3, drillHold4,
  drillSteadySoft, drillSteadyHum, drillSteadyOpen, drillSteadySix,
  drillStepUp, drillStepDown, drillHalfStep,
  drillJumpSmall, drillJumpTwinkle, drillJumpLand,
  drillOctaveUp, drillOctaveDown, drillJumpMixed,
  drillDoReMi, drillMiReDo, drillReMiFa,
  drillTopHalf, drillFiveUp, drillFiveDown,
  drillSlideUp, drillSlideDown, drillSlideWider,
  drillSirenSmall, drillSirenOctave,
  drillCleanOne, drillCleanThree,
  drillTuneStart, drillTuneMiddle, drillTuneEnd,
];

/** The world's exercises sung today: the checks, the drills and the placement tests (the retired ones are apart). */
export const FOUNDATIONS_EXERCISES: readonly ExerciseDef[] = [
  ...CHECKS, ...FOUNDATIONS_DRILLS, foundationsAudition1, foundationsAudition3, foundationsAudition4, foundationsAudition2,
];

/**
 * Sung in order; the runner stops at the first miss. The Range finder (01) is never skipped: it sets the range
 * (progress withholds this audition until it is sung, and the engine never grants it).
 *
 * `former`: the audition before the rebuild. A pass of one of its tests keeps what it granted then, judged in the order
 * it was sung then, but only the levels that still teach what it judged: Match one note, Hold it, Sirens, Clean starts,
 * the two jump lessons and Five notes in a row. Hold it steady and the new lessons (steps, do-re-mi, small slides) are
 * earned now.
 */
const audition: AuditionDef = {
  id: 'foundations.audition',
  worldId: W,
  exerciseIds: [foundationsAudition1.id, foundationsAudition3.id, foundationsAudition4.id, foundationsAudition2.id],
  unlockThrough: ['foundations.13', 'foundations.08', 'foundations.09', 'foundations.05'],
  former: {
    ...FORMER_FOUNDATIONS_AUDITION,
    keeps: ['foundations.02', 'foundations.03', 'foundations.05', 'foundations.06', 'foundations.07', 'foundations.08', 'foundations.09'],
  },
};

/** A Foundations level: `id` is its persisted number, `index` its place in the order (the two differ since the rebuild). */
function lessonLevel(index: number, idNumber: number, title: string, exerciseId: string): LevelDef {
  return { id: `${W}.${String(idNumber).padStart(2, '0')}`, worldId: W, index, title, exerciseId, kind: 'level' };
}

export const FOUNDATIONS: WorldDef = {
  id: W,
  title: 'Foundations',
  accent: '--world-foundations',
  summary: 'Thirteen small lessons: find your range, match a note and hold it steady, then steps, jumps, slides and clean starts.',
  levels: [
    lessonLevel(1, 1, 'Range finder', rangeFinder.id),
    lessonLevel(2, 2, 'Match one note', pitchMatch.id),
    lessonLevel(3, 3, 'Hold it', holdIt.id),
    lessonLevel(4, 13, 'Hold it steady', holdItSteady.id),
    lessonLevel(5, 10, 'Two notes, one step apart', twoNotesStep.id),
    lessonLevel(6, 7, 'Two notes, a jump apart', jumpApart.id),
    lessonLevel(7, 8, 'Bigger jumps', biggerJumps.id),
    lessonLevel(8, 11, 'Three notes: do-re-mi', doReMi.id),
    lessonLevel(9, 9, 'Five notes in a row', fiveInARow.id),
    lessonLevel(10, 12, 'Small slides', smallSlides.id),
    lessonLevel(11, 5, 'Sirens', sirens.id),
    lessonLevel(12, 6, 'Clean starts', cleanStarts.id),
    bossLevel(W, 13, foundationsBoss.id),
  ],
  audition,
  unlockedBy: null,
};
