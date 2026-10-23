/**
 * The Foundations lessons (src/lessons/types.ts LessonDef), keyed by level id, in level order. Written for someone
 * relearning to sing (owner, 2026-10-23): one new thing per lesson, every music word taught on the Learn page of the lesson
 * that introduces it (`learn.terms`, src/teach/glossary.ts) before any later lesson leans on it, and no units or jargon.
 *
 * Practice comes before the check: two to four short echo drills per lesson (src/exercises/catalog/foundations.ts
 * `foundations.drill.*`), each asking for two or three good tries by a lenient rule, so the singer is ready before the
 * level's own exercise judges them. A good try never passes anything: only the check does.
 */
import type { MetricKey } from '../analysis/types';
import type { GoodTryRule, LessonDef } from './types';

/** A lenient condition on a drill's take: `metric` at least (>=) or at most (<=) `value`. */
const atLeast = (metric: MetricKey, value: number) => ({ metric, op: '>=' as const, value });
const atMost = (metric: MetricKey, value: number) => ({ metric, op: '<=' as const, value });
const rule = (...conditions: GoodTryRule['conditions']): GoodTryRule => ({ conditions });

/** Sung back, roughly in the in-tune zone: the good try of most drills. */
const ROUGHLY_IN_TUNE = rule(atLeast('accuracy.inTolerancePct', 40));

/**
 * Titled as its level is, as every lesson is: the app names it the Range finder everywhere (the map's requirement lines,
 * the default-range banners, the coaching, the check-up), so the lesson does too; its outcome says what it is for.
 */
const RANGE: LessonDef = {
  levelId: 'foundations.01',
  title: 'Range finder',
  outcome: 'You can watch your voice on the screen, and every exercise from here on fits your range.',
  learn: {
    what: 'Your range is the stretch of notes your voice sings comfortably, from your lowest easy note to your highest easy note. In this lesson you meet your voice on the screen, then find your range.',
    why: 'Every exercise after this one is moved to fit your range, so nothing ever asks you to reach for notes that are too low or too high for you.',
    how: [
      'Find a quiet spot, and stand or sit tall and relaxed.',
      'After the count-in, the app plays a note. Sing it back on a soft “oo”, as in “food”.',
      'Let your voice slide down slowly, like a sigh, and stop where it starts to feel like work. Then go up the same way, lightly, like a siren.',
      'Easy is the goal. Never push for a lower or a higher note.',
    ],
    onScreen: [
      'The moving line is your voice: a higher sound draws it higher on the screen, a lower sound lower.',
      'The bars show which note to sing and for how long. Try to keep your line on the bar.',
      'When you stop singing, your line stops too.',
    ],
    terms: ['range', 'count-in'],
  },
  practice: [
    {
      exerciseId: 'foundations.drill.see-your-voice',
      title: 'See your voice',
      ask: 'Hear a note, sing it back on “oo”, and watch your line rise and fall with your voice.',
      goodTries: 2,
      // Nothing to judge yet: any try sung to its end is a good one.
      good: rule(),
    },
    {
      exerciseId: 'foundations.drill.first-slide',
      title: 'One slow slide',
      ask: 'Hear where the slide goes, then let your voice slide slowly down and back up on “oo”.',
      goodTries: 2,
      good: rule(atLeast('glide.smoothness', 0.1)),
    },
  ],
};

const MATCH: LessonDef = {
  levelId: 'foundations.02',
  title: 'Match one note',
  outcome: 'You can hear a note and sing it back in tune.',
  learn: {
    what: 'Pitch is how high or low a sound is. A note is one sound held at one pitch, like one key on a piano. Hearing a note and singing it straight back on the same pitch is an echo.',
    why: 'Every song is made of notes. Once you can hear a note and sing it back, you can learn any tune one note at a time.',
    how: [
      'Listen to the whole note before you sing. Then hear it again in your head for a moment.',
      'Take a breath and sing it back on a relaxed “ah”.',
      'Watch your line. Above the bar means you are sharp: ease down a little. Below the bar means you are flat: lift a little.',
      'Make small changes, and give each one a moment to show on the screen.',
      'If finding the note is hard, hum it first, then open the hum into “ah”.',
    ],
    onScreen: [
      'Each bar is a note to sing. The shaded band around it is the in-tune zone.',
      'Your line inside the in-tune zone means you are in tune.',
      'Above the zone means sharp (a little too high); below it means flat (a little too low).',
      'While you sing, a hint tells you to go a little higher or a little lower, or that you are on it.',
    ],
    terms: ['pitch', 'note', 'in-tune', 'sharp', 'flat', 'in-tune-zone', 'echo'],
  },
  practice: [
    {
      exerciseId: 'foundations.drill.echo-one',
      title: 'Echo one note',
      ask: 'Hear a note and sing it back, three times on the same note, nudging your line into the in-tune zone.',
      goodTries: 2,
      good: ROUGHLY_IN_TUNE,
    },
    {
      exerciseId: 'foundations.drill.hum-then-sing',
      title: 'Hum it, then sing it',
      ask: 'Hear a note, hum it quietly on “mm”, then open the hum into “ah” without changing the note.',
      goodTries: 2,
      good: ROUGHLY_IN_TUNE,
    },
    {
      exerciseId: 'foundations.drill.echo-new',
      title: 'A new note each time',
      ask: 'Hear a note and sing it back, then a different one: three notes in all.',
      goodTries: 3,
      good: ROUGHLY_IN_TUNE,
    },
  ],
};

const HOLD: LessonDef = {
  levelId: 'foundations.03',
  title: 'Hold it',
  outcome: 'You can hold a note for four seconds on one breath.',
  learn: {
    what: 'Holding a note means keeping it going at the same pitch, from its start to its very end, on one breath.',
    why: 'Songs are full of long notes. A note that fades away or runs out of air before its end sounds unfinished.',
    how: [
      'Before you sing, breathe in low and slow: your belly and lower ribs move out, your shoulders stay still.',
      'While you sing, let the air out slowly and evenly, like a gentle stream. That even flow of air is breath support.',
      'Keep the sound the same size from start to finish, with no fading at the end.',
      'Build it up: two seconds, then three, then four.',
    ],
    onScreen: [
      'Each bar is as long as its note: keep your line on it until the bar ends.',
      'If your line stops before the end of the bar, you ran out of air. Breathe in a little deeper next time.',
      'If your line drops away near the end, keep the air flowing a little longer.',
    ],
    terms: ['breath-support'],
  },
  practice: [
    {
      exerciseId: 'foundations.drill.hold-2s',
      title: 'Hold for 2 seconds',
      ask: 'Hear a note, then hold it for two seconds: three notes in all.',
      goodTries: 2,
      good: rule(atLeast('accuracy.inTolerancePct', 50)),
    },
    {
      exerciseId: 'foundations.drill.hold-3s',
      title: 'Hold for 3 seconds',
      ask: 'Hear a note, then hold it for three seconds on one easy breath.',
      goodTries: 2,
      good: rule(atLeast('accuracy.inTolerancePct', 50)),
    },
    {
      exerciseId: 'foundations.drill.hold-4s',
      title: 'Hold for 4 seconds',
      ask: 'Hear a note, then hold it for four seconds, letting the air out slowly so it lasts to the end.',
      goodTries: 2,
      good: rule(atLeast('accuracy.inTolerancePct', 50)),
    },
  ],
};

/**
 * The owner's own takes look wobbly (2026-10-23), so this lesson works on the causes, one at a time: a soft voice, an even
 * stream of air through a narrow opening (a straw-shaped "oo", then a hum), a vowel that opens without moving the note,
 * and finally the full length, watching a level line. The good tries tighten a little at each step, the last one close
 * to what the check asks.
 */
const STEADY: LessonDef = {
  levelId: 'foundations.13',
  title: 'Hold it steady',
  outcome: 'You can hold a note for six seconds with your line level, without a wobble.',
  learn: {
    what: 'A steady note stays at one pitch for its whole length, so your line on the screen stays level. A wobble is the line shaking up and down; drifting is the line slowly sinking or rising.',
    why: 'A steady note sounds calm, sure and in tune. A wobble almost always comes from uneven air or tight muscles, not from your ear, so it is something you can train away.',
    how: [
      'Sing softly, about as loud as talking to someone across a table. A soft note is easier to hold level than a loud one.',
      'Round your lips into a small “oo”, as if blowing through a straw, and let the air out slowly and evenly. A hum (“mm”) works the same way.',
      'Keep your jaw, tongue and shoulders loose. Tension is what makes the line shake.',
      'Watch your line and keep it level. If it starts to sink, give a little more breath support, never more force.',
      'Stop before you run out of air: a short, level note is better than a long, shaky one.',
    ],
    onScreen: [
      'A level line inside the in-tune zone means you are steady.',
      'Waves in your line are a wobble: the smaller the waves, the steadier you are.',
      'A line that slowly slopes down (or up) is drifting.',
      'From this lesson on, the in-tune zone is half as wide as before, so even a small wobble shows.',
    ],
    terms: ['steady', 'wobble', 'drift'],
  },
  practice: [
    {
      exerciseId: 'foundations.drill.steady-soft',
      title: 'Soft and steady on “oo”',
      ask: 'Hear a note, then hold it softly on “oo”, lips round as if through a straw, keeping your line level.',
      goodTries: 3,
      good: rule(atMost('accuracy.sdCents', 30), atLeast('accuracy.inTolerancePct', 30)),
    },
    {
      exerciseId: 'foundations.drill.steady-hum',
      title: 'Hum it level',
      ask: 'Hear a note, then hum it on “mm” for four seconds with an even stream of air.',
      goodTries: 2,
      good: rule(atMost('accuracy.sdCents', 28), atLeast('accuracy.inTolerancePct', 30)),
    },
    {
      exerciseId: 'foundations.drill.steady-open',
      title: 'Open the vowel, keep it level',
      ask: 'Start the note on a soft “oo”, then open to “ah” without letting your line move.',
      goodTries: 2,
      good: rule(atMost('accuracy.sdCents', 26), atLeast('accuracy.inTolerancePct', 35)),
    },
    {
      exerciseId: 'foundations.drill.steady-6s',
      title: 'Six seconds, level to the end',
      ask: 'Hold the note for six seconds with your line level, keeping the air flowing so it never sinks at the end.',
      goodTries: 3,
      good: rule(atMost('accuracy.sdCents', 25), atMost('accuracy.absDriftCentsPerSec', 7), atLeast('accuracy.inTolerancePct', 40)),
    },
  ],
};

const STEP: LessonDef = {
  levelId: 'foundations.10',
  title: 'Two notes, one step apart',
  outcome: 'You can sing two neighbouring notes, a step or a half step apart.',
  learn: {
    what: 'A step is the usual small move from one note to its neighbour, like “Hap-py” up to “Birth-” in “Happy Birthday”. A half step is half of that, the very next key on a piano, black or white: the two notes of the “Jaws” theme.',
    why: 'Most tunes move by steps. If you can sing a step cleanly, you can sing most of a melody.',
    how: [
      'Listen to both notes, and notice whether the second one goes up or down.',
      'Sing the first note, take a quick breath, then sing the second.',
      'Think small: the second note is just a little higher or a little lower than the first.',
      'A half step is tiny. Aim just above or just below the first note, not far away.',
    ],
    onScreen: [
      'Two bars, one just above or just below the other: the gap between them is a step.',
      'For a half step the two bars sit even closer together.',
      'Keep your line inside the in-tune zone on both bars.',
    ],
    terms: ['step', 'half-step'],
  },
  practice: [
    {
      exerciseId: 'foundations.drill.step-up',
      title: 'One step up',
      ask: 'Hear two notes a step apart, then sing the first and step up to the second.',
      goodTries: 2,
      good: ROUGHLY_IN_TUNE,
    },
    {
      exerciseId: 'foundations.drill.step-down',
      title: 'One step down',
      ask: 'Hear two notes a step apart, then sing the first and step down to the second.',
      goodTries: 2,
      good: ROUGHLY_IN_TUNE,
    },
    {
      exerciseId: 'foundations.drill.half-step',
      title: 'A half step',
      ask: 'Hear two notes a half step apart, the closest two notes can be, then sing them back.',
      goodTries: 3,
      good: ROUGHLY_IN_TUNE,
    },
  ],
};

const JUMP: LessonDef = {
  levelId: 'foundations.07',
  title: 'Two notes, a jump apart',
  outcome: 'You can jump from one note to another and land right on it.',
  learn: {
    what: 'A jump moves from one note to another that is further away, skipping the notes in between. You leave the first note and arrive right on the second, with no sliding on the way.',
    why: 'Tunes are not all steps. Jumps give a melody its shape, like the leap near the start of “Twinkle, Twinkle, Little Star”.',
    how: [
      'Listen to both notes, and hear the second one in your head before you sing.',
      'Sing the first note, take a quick breath, then start the second one right on its pitch.',
      'Do not slide up or down to get there: land, then hold.',
      'Small jumps first, then bigger ones.',
    ],
    onScreen: [
      'The second bar sits further from the first than a step.',
      'A good jump shows your line starting right on the second bar, not climbing or sinking into it.',
    ],
    terms: ['jump'],
  },
  practice: [
    {
      exerciseId: 'foundations.drill.jump-small',
      title: 'Small jumps',
      ask: 'Hear two notes a small jump apart, then sing them back, up and then down.',
      goodTries: 2,
      good: ROUGHLY_IN_TUNE,
    },
    {
      exerciseId: 'foundations.drill.jump-twinkle',
      title: 'The “Twinkle” jump',
      ask: 'Hear the jump from the start of “Twinkle, Twinkle, Little Star”, then sing it up and back down.',
      goodTries: 2,
      good: ROUGHLY_IN_TUNE,
    },
    {
      exerciseId: 'foundations.drill.jump-land',
      title: 'Land it straight away',
      ask: 'Land the second note right on its pitch the moment you start it, without searching for it.',
      goodTries: 2,
      good: rule(atLeast('accuracy.inTolerancePct', 40), atMost('onset.settleMs', 500)),
    },
  ],
};

const OCTAVE: LessonDef = {
  levelId: 'foundations.08',
  title: 'Bigger jumps',
  outcome: 'You can jump as far as an octave and still land right on the note.',
  learn: {
    what: 'An octave is the biggest jump in these lessons: the same note, higher or lower. Think of “Some-where” in “Somewhere Over the Rainbow”: “-where” is an octave above “Some-”.',
    why: 'Big jumps teach your voice to move quickly and land surely. The octave is the easiest big jump to hear, because its two notes sound alike.',
    how: [
      'Hear the top note in your head before you leave the bottom one.',
      'Keep the top note light: a little less weight and a little more breath support, never more force.',
      'Going down, let the low note fall gently into place, without dropping your chin.',
      'Warm up with a small jump first if the big ones feel far.',
    ],
    onScreen: [
      'The two bars are far apart: the top one may sit near the top of your range.',
      'Watch the start of the second note: aim for your line to begin right on its bar.',
    ],
    terms: ['octave'],
  },
  practice: [
    {
      exerciseId: 'foundations.drill.octave-up',
      title: 'An octave up',
      ask: 'Hear a note and the same note an octave higher, then sing them, keeping the top one light.',
      goodTries: 2,
      good: rule(atLeast('accuracy.inTolerancePct', 35)),
    },
    {
      exerciseId: 'foundations.drill.octave-down',
      title: 'An octave down',
      ask: 'Hear a note and the same note an octave lower, then sing them, letting the low one land gently.',
      goodTries: 2,
      good: rule(atLeast('accuracy.inTolerancePct', 35)),
    },
    {
      exerciseId: 'foundations.drill.jump-mixed',
      title: 'Big jumps, up and down',
      ask: 'One big jump up and one big jump down: land each second note right on its pitch.',
      goodTries: 2,
      good: rule(atLeast('accuracy.inTolerancePct', 40), atMost('onset.settleMs', 500)),
    },
  ],
};

const DO_RE_MI: LessonDef = {
  levelId: 'foundations.11',
  title: 'Three notes: do-re-mi',
  outcome: 'You can sing do-re-mi as one smooth, joined line.',
  learn: {
    what: 'A scale is a ladder of notes going up or down by steps. Its first three notes are called do, re and mi, so do-re-mi is three notes in a row, each a step above the last.',
    why: 'Singing a few notes in a row, smoothly, is what turns single notes into a tune.',
    how: [
      'Listen to all three notes, then sing them quietly in your head: do, re, mi.',
      'Sing them on one breath, joined together, without stopping between them.',
      'Move straight from each note to the next: no sliding through the space between them.',
      'Give the last note a moment longer.',
    ],
    onScreen: [
      'Three bars like a small staircase: climbing for do-re-mi, coming down for mi-re-do.',
      'Your line should sit on each bar, then move to the next one quickly.',
      'From mi to fa the stair is shorter: a half step.',
    ],
    terms: ['scale', 'do-re-mi'],
  },
  practice: [
    {
      exerciseId: 'foundations.drill.do-re-mi',
      title: 'Do-re-mi',
      ask: 'Hear do-re-mi, then sing it back as one joined line.',
      goodTries: 2,
      good: ROUGHLY_IN_TUNE,
    },
    {
      exerciseId: 'foundations.drill.mi-re-do',
      title: 'Mi-re-do',
      ask: 'Hear mi-re-do, then sing it back down as one joined line.',
      goodTries: 2,
      good: ROUGHLY_IN_TUNE,
    },
    {
      exerciseId: 'foundations.drill.re-mi-fa',
      title: 'Re-mi-fa and back',
      ask: 'Hear re-mi-fa, with its half step at the top, then sing it up and back down.',
      goodTries: 2,
      good: rule(atLeast('accuracy.inTolerancePct', 40), atLeast('transition.cleanRate', 0.3)),
    },
  ],
};

const FIVE: LessonDef = {
  levelId: 'foundations.09',
  title: 'Five notes in a row',
  outcome: 'You can sing five notes in a row as one phrase, up and back down.',
  learn: {
    what: 'Five notes in a row, do-re-mi-fa-sol, sung on one breath make a phrase: a group of notes sung together, like a short sentence.',
    why: 'Songs are sung in phrases. Holding five notes in your head and singing them as one line is how you will learn whole tunes.',
    how: [
      'Learn it in halves: do-re-mi, then mi-fa-sol.',
      'Then put the halves together and sing all five on one breath.',
      'Keep the sound joined, like one long word, but let every note arrive cleanly on its bar.',
      'Take a full breath before each phrase.',
    ],
    onScreen: [
      'Five bars climbing like stairs, with a shorter stair from mi to fa.',
      'Your line should flow from bar to bar without gaps.',
    ],
    terms: ['phrase'],
  },
  practice: [
    {
      exerciseId: 'foundations.drill.top-half',
      title: 'The top half: mi-fa-sol',
      ask: 'Hear mi-fa-sol, then sing it up and back down as joined lines.',
      goodTries: 2,
      good: ROUGHLY_IN_TUNE,
    },
    {
      exerciseId: 'foundations.drill.five-up',
      title: 'Two halves, then all five up',
      ask: 'Sing do-re-mi, then mi-fa-sol, then all five notes up as one phrase.',
      goodTries: 2,
      good: rule(atLeast('accuracy.inTolerancePct', 40), atLeast('transition.cleanRate', 0.3)),
    },
    {
      exerciseId: 'foundations.drill.five-down',
      title: 'Two halves, then all five down',
      ask: 'Sing sol-fa-mi, then mi-re-do, then all five notes down as one phrase.',
      goodTries: 2,
      good: rule(atLeast('accuracy.inTolerancePct', 40), atLeast('transition.cleanRate', 0.3)),
    },
  ],
};

const SLIDE: LessonDef = {
  levelId: 'foundations.12',
  title: 'Small slides',
  outcome: 'You can slide smoothly from one note to another and land on it.',
  learn: {
    what: 'A slide moves your voice smoothly from one note to another through every pitch in between, without stopping, a little like a siren that stops on a note.',
    why: 'Slides join notes gracefully and turn up in all kinds of songs. They also teach your voice to move without bumps.',
    how: [
      'Hear both notes first: where you start, and where you land.',
      'Hold the first note, then move your voice slowly and evenly to the second.',
      'Keep the air flowing the whole way, so the sound never stops.',
      'Arrive on the second note, and hold it.',
    ],
    onScreen: [
      'A slanted bar joins the two notes: follow it with your line.',
      'A smooth slide draws an even ramp. Little stairs in your line mean the voice moved in bumps.',
    ],
    terms: ['slide'],
  },
  practice: [
    {
      exerciseId: 'foundations.drill.slide-up',
      title: 'Slide up a step',
      ask: 'Hear two notes a step apart, then slide smoothly up from the first to the second.',
      goodTries: 2,
      good: rule(atLeast('glide.smoothness', 0.15)),
    },
    {
      exerciseId: 'foundations.drill.slide-down',
      title: 'Slide down a step',
      ask: 'Hear two notes a step apart, then slide smoothly down from the first to the second.',
      goodTries: 2,
      good: rule(atLeast('glide.smoothness', 0.15)),
    },
    {
      exerciseId: 'foundations.drill.slide-wider',
      title: 'A wider slide',
      ask: 'Slide up between two notes a little further apart, then back down, smoothly both ways.',
      goodTries: 2,
      good: rule(atLeast('glide.smoothness', 0.15), atMost('glide.endAbsCents', 80)),
    },
  ],
};

const SIREN: LessonDef = {
  levelId: 'foundations.05',
  title: 'Sirens',
  outcome: 'You can siren from low to high and back without a crack.',
  learn: {
    what: 'A siren is a slide from low to high and back down, smooth and unbroken, like an ambulance going by.',
    why: 'Sirens stretch and connect your whole voice. On the way up most voices pass a gear change, where the sound switches from fuller to lighter, and sirens teach you to pass it smoothly.',
    how: [
      'Use a light, easy “oo”, not a big voice.',
      'As you go up, let the sound get thinner and lighter. Do not carry the heavy low sound up with you.',
      'A crack is normal while you learn: go back, sing a little softer, and try again.',
      'Keep the air flowing the whole time, up and down.',
    ],
    onScreen: [
      'Slanted bars climb and come back down: follow them with your line.',
      'A crack shows as a gap or a sudden jump in your line, and it is marked when you look back at the take.',
    ],
    terms: ['siren', 'gear-change', 'crack'],
  },
  practice: [
    {
      exerciseId: 'foundations.drill.siren-small',
      title: 'A small siren',
      ask: 'Hear a small siren’s path, then slide up and back down on a light “oo”, twice.',
      goodTries: 2,
      good: rule(atLeast('glide.smoothness', 0.1), atMost('glide.cracks', 4)),
    },
    {
      exerciseId: 'foundations.drill.siren-octave',
      title: 'Through the gear change',
      ask: 'A full octave siren: let the sound lighten as it climbs through the gear change.',
      goodTries: 3,
      good: rule(atLeast('glide.smoothness', 0.15), atMost('glide.cracks', 4)),
    },
  ],
};

const CLEAN: LessonDef = {
  levelId: 'foundations.06',
  title: 'Clean starts',
  outcome: 'You can start every note right on its pitch, on the beat.',
  learn: {
    what: 'A clean start begins a note right on its pitch. A scoop is the opposite: starting below the note and sliding up into it.',
    why: 'Scoops make singing sound unsure, even when the rest of the note is in tune. Clean starts make every note sound confident.',
    how: [
      'Hear the note in your head before you make a sound.',
      'Breathe in, then start the sound gently, already on the note, as if carrying on a note you were thinking.',
      'Keep each note short and even, on the beat the count-in sets.',
      'If you scoop, sing the next one a little softer and think of it slightly higher.',
    ],
    onScreen: [
      'A clean start shows as your line beginning right on the bar.',
      'A scoop shows as a little hook climbing into the bar at the start.',
      'Only the count-in gives the beat; after it, the bars show when each note starts.',
    ],
    terms: ['clean-start', 'scoop', 'beat'],
  },
  practice: [
    {
      exerciseId: 'foundations.drill.clean-one',
      title: 'One note, three clean starts',
      ask: 'Hear a note, then start it three times, short and on the beat, right on its pitch each time.',
      goodTries: 3,
      good: rule(atMost('onset.scoopCents', 60)),
    },
    {
      exerciseId: 'foundations.drill.clean-three',
      title: 'Three notes, three clean starts',
      ask: 'Hear three notes, then sing each one short and on the beat, starting it right on its pitch.',
      goodTries: 2,
      good: rule(atMost('onset.scoopCents', 55), atMost('onset.settleMs', 500)),
    },
  ],
};

const BOSS: LessonDef = {
  levelId: 'foundations.boss',
  title: 'Boss Recital',
  outcome: 'You can sing a whole little tune, phrase by phrase, putting every Foundations skill to work.',
  learn: {
    what: 'A short tune in five phrases that puts together everything in Foundations: a held note, do-re-mi, a jump, a few steps down and a small slide home.',
    why: 'Singing it all in one go shows you can use each skill inside real music, which is what songs ask of you.',
    how: [
      'The app plays each phrase first, then you sing it back, just like every lesson.',
      'Take a full breath before each phrase, and start it right on its first note.',
      'Hold the first note level, keep do-re-mi joined, land the jump, step back down, and slide home.',
      'If a phrase slips, keep going. You can practise any part of the tune on its own first.',
    ],
    onScreen: [
      'The bars show the whole tune; the app plays each phrase just before you sing it.',
      'Every note counts here, so sing each one to its end, even after a slip.',
    ],
    terms: [],
  },
  practice: [
    {
      exerciseId: 'foundations.drill.tune-start',
      title: 'How the tune starts',
      ask: 'The first two phrases: a long, level do, then do-re-mi.',
      goodTries: 2,
      good: ROUGHLY_IN_TUNE,
    },
    {
      exerciseId: 'foundations.drill.tune-middle',
      title: 'The middle of the tune',
      ask: 'The jump up to sol, then sol-fa-mi back down.',
      goodTries: 2,
      good: ROUGHLY_IN_TUNE,
    },
    {
      exerciseId: 'foundations.drill.tune-end',
      title: 'How the tune ends',
      ask: 'Re, sliding smoothly home to do, then holding it.',
      goodTries: 2,
      good: rule(atLeast('glide.smoothness', 0.15), atMost('glide.endAbsCents', 80)),
    },
  ],
};

/** In level order (LevelDef.index): the order the lessons are taught in. */
export const FOUNDATIONS_LESSON_ORDER: readonly LessonDef[] = [RANGE, MATCH, HOLD, STEADY, STEP, JUMP, OCTAVE, DO_RE_MI, FIVE, SLIDE, SIREN, CLEAN, BOSS];

export const FOUNDATIONS_LESSONS: Readonly<Record<string, LessonDef>> = Object.fromEntries(FOUNDATIONS_LESSON_ORDER.map((l) => [l.levelId, l]));
