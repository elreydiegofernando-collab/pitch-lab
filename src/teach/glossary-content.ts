/**
 * The plain explanations of every music word (src/teach/glossary.ts TERMS), for someone relearning to sing (owner,
 * 2026-10-23: "you're using a lot of technical terms in the app that I don't know"). Each one is read in a sheet when the
 * word is tapped (src/ui/teach/Term.tsx) and first taught on the Learn page of the lesson that introduces it.
 *
 * What they stand on: no units or jargon (glossary.test.ts has the banned list, the twin of the coach's), no exclamation
 * marks, and nothing a beginner has to look up: a word used inside an explanation is either one more entry here or said in
 * everyday words on the spot. Each is one or two sentences, then an everyday or on-screen example. The on-screen examples
 * describe what the app really draws: the pitch line, the bars (an in-tune zone around each note), the little gauge.
 */
import type { GlossaryEntry, TermId } from './glossary';

export const GLOSSARY: Readonly<Record<TermId, GlossaryEntry>> = {
  pitch: {
    word: 'pitch',
    plain: 'How high or low a sound is. A bird’s chirp has a high pitch, and a truck’s horn has a low one.',
    example: 'On the Sing and Live screens, the higher your line sits, the higher your pitch.',
  },
  note: {
    word: 'note',
    plain: 'One sound at one pitch, with a letter name such as A, B or C. A note is like one key on a piano.',
    example: 'The big letter at the top of the screen is the note you are singing. The number after the letter says which one: A2 is lower than A3.',
  },
  'in-tune': {
    word: 'in tune',
    plain: 'Singing a note at the right pitch: not too high and not too low. Nobody hits it exactly, so the app gives you a little room.',
    example: '“In tune 72% of the time” means your voice was inside the shaded band for about three quarters of the time you were singing.',
  },
  sharp: {
    word: 'sharp',
    plain: 'A little too high for the note you were aiming at.',
    example: 'Aim for A and sing a hair above it, and you are sharp. In a note name, a sharp sign, as in C♯, means the very next key up on a piano.',
  },
  flat: {
    word: 'flat',
    plain: 'A little too low for the note you were aiming at.',
    example: 'Aim for A and sing a hair below it, and you are flat. In a note name, a flat sign, as in B♭, means the very next key down on a piano.',
  },
  'in-tune-zone': {
    word: 'in-tune zone',
    plain: 'The shaded band around a note. While your voice stays inside it, you are in tune.',
    example: 'On the Sing screen, each note you are asked to sing is a bar, and the bar is the zone; it lights up while you are inside it. On the little gauge, it is the shaded part in the middle: keep the needle there.',
  },
  steady: {
    word: 'steady',
    plain: 'Holding one pitch without it creeping up, sinking down or shaking.',
    example: 'A steady note is a flat, straight line on the screen. An unsteady one looks wavy.',
  },
  wobble: {
    word: 'wobble',
    plain: 'Small, quick ups and downs in your pitch while you try to hold one note.',
    example: 'On the screen your line looks wavy instead of straight. A little wobble is normal when you are starting out, and a smooth, even stream of air usually calms it.',
  },
  drift: {
    word: 'drifting',
    plain: 'Slowly sliding up or down while you hold a note, so the end is not at the same pitch as the start.',
    example: 'Running low on air often makes a note sag. On the screen, your line slants instead of staying level.',
  },
  'breath-support': {
    word: 'breath support',
    plain: 'Letting your air out in a smooth, even stream, so a note keeps going evenly right to the end. It is about an even flow, never pushing.',
    example: 'Imagine slowly fogging up a window with one long, even breath.',
  },
  echo: {
    word: 'echo',
    plain: 'Listening first, then singing back what you heard. The app plays a note, or a few notes, and then it is your turn.',
    example: 'It is like a game of copy-me. The app plays, there is a short rest, and then you sing it back. Nothing plays while you sing, so you only hear your own voice.',
  },
  step: {
    word: 'step',
    plain: 'A small move from one note to its neighbour in a tune.',
    example: 'From “Hap-py” up to “Birth-” in “Happy Birthday” is a step. On a piano, a step is usually two keys along.',
  },
  jump: {
    word: 'jump',
    plain: 'A bigger move between two notes that skips the ones in between, so your voice has to leap to the new note.',
    example: 'In “Twinkle, Twinkle, Little Star”, the first two notes are the same, and then the tune jumps up on the third.',
  },
  'half-step': {
    word: 'half step',
    plain: 'The smallest move between two notes in most songs: from one piano key to the very next key, black or white.',
    example: 'From the white key C to the black key right beside it is one half step. Two half steps make one step.',
  },
  octave: {
    word: 'octave',
    plain: 'The same note again, higher or lower. It has the same letter name but sounds higher or lower, like one C and the next C up on a piano.',
    example: 'The “Some-where” in “Somewhere Over the Rainbow” jumps up an octave. A deep voice and a high voice singing the same tune are often an octave apart.',
  },
  scale: {
    word: 'scale',
    plain: 'A set of notes that climb, or come back down, in order, like a staircase.',
    example: 'Singing up a scale is like walking up stairs, one note on each stair. The scale you know best is do-re-mi-fa-sol-la-ti-do.',
  },
  'do-re-mi': {
    word: 'do-re-mi',
    plain: 'The names people sing for the notes of a scale: do, re, mi, fa, sol, la, ti, and back to do. Sing them in order and you are climbing a scale.',
    example: 'The song “Do-Re-Mi” from The Sound of Music sings exactly these names. Do is the note you start on.',
  },
  slide: {
    word: 'slide',
    plain: 'Moving smoothly from one note to another in one unbroken sound, without stopping on the notes in between.',
    example: 'It is like a slide whistle or a trombone. On the screen, your line draws a smooth ramp up or down.',
  },
  siren: {
    word: 'siren',
    plain: 'A long, smooth slide up and then back down, like an ambulance siren. It is a popular warm-up because it stretches your voice gently.',
    example: 'Start on a low, easy “oo”, slide up as far as feels comfortable, then slide back down. On the screen it draws a hill.',
  },
  'gear-change': {
    word: 'gear change',
    plain: 'The spot where your voice switches from its fuller, lower sound to a lighter, higher one, like a car changing gears.',
    example: 'Everyone has one. You may feel a little catch there, and a siren may crack at that spot. That is normal, and it gets smoother with easy practice.',
  },
  crack: {
    word: 'crack',
    plain: 'A sudden break in your voice, where the sound jumps, cuts out or flips.',
    example: 'Cracks are most common at your gear change and are nothing to worry about. The app marks each one with a small tick on your line, so you can see where it happened.',
  },
  'clean-start': {
    word: 'clean start',
    plain: 'Starting a note right on the pitch, with no swooping up to it from below and no wobbling around first.',
    example: 'Hear the note in your head, then begin singing it right there. Think of pressing a piano key, not of climbing a ramp.',
  },
  scoop: {
    word: 'scoop',
    plain: 'Starting below the note and sliding up into it, like the curve of a scoop.',
    example: 'Singers sometimes scoop on purpose for style, but for now the goal is to start straight on the note. On the screen, a scoop is a line that begins under the bar and curves up into it.',
  },
  beat: {
    word: 'beat',
    plain: 'The steady pulse of music: the part you tap your foot to.',
    example: 'When you hear a steady click, or tap your foot along to a song, each click or tap is one beat.',
  },
  'count-in': {
    word: 'count-in',
    plain: 'A few clicks before a take starts, so you know exactly when it begins.',
    example: 'On the Sing screen a big number counts down with the clicks. Then the app plays the note first, and you sing it back when it is your turn.',
  },
  phrase: {
    word: 'phrase',
    plain: 'A short stretch of a song that belongs together, like one line of the words, usually sung in one breath.',
    example: '“Happy birthday to you” is one phrase. When you learn a song, you practise one phrase at a time before putting them all together.',
  },
  range: {
    word: 'range',
    plain: 'The notes your voice can sing, from your lowest to your highest. The Range finder works out where yours is, so every exercise fits you.',
    example: 'It is saved as two note names, like C3 to A4. Singing outside it is fine; the exercises just stay inside it, so every note stays comfortable.',
  },
  vibrato: {
    word: 'vibrato',
    plain: 'A smooth, even shimmer in the pitch of a long note: about six tiny ups and downs every second. It makes a held note sound warm and alive.',
    example: 'Listen to a choir or an opera singer hold a long note: that shimmer is vibrato. It is different from a wobble, which is uneven and unplanned. Pitch Lab teaches it later, once steady notes are easy.',
  },
  tempo: {
    word: 'tempo',
    plain: 'How fast or slow the music goes.',
    example: 'A lullaby has a slow tempo, and a dance song has a quick one. Some exercises start slowly and speed up as you do well, so you always sing at a pace you can manage.',
  },
};
