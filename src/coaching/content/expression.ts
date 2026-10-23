/**
 * Coaching ladders for tip ids starting with: scoop. fall. slide. turn. flip. inflection. run. dyn.
 * (src/coaching/types.ts CoachLadder: plain words for someone relearning to sing, no units or jargon).
 *
 * Every claim matches what the app measures, so keep it that way when editing:
 *  - inflections (analysis/inflections.ts) score a figure against the one asked for: a scoop on how far below it
 *    starts, when it arrives and the held landing; a fall on a level hold, how far and how fast it drops, the sound
 *    fading and no bounce; a slide on its length, arrival, evenness (breaks cost) and landing; a turn on each outer
 *    note's distance, reach and timing and the return home; a flip on a quick jump of the right size and its landing.
 *    Whether a flip changed gears cannot be told from pitch alone, so no ladder promises it.
 *  - run notes (analysis/runs.ts) are defined (on their own pitch for a moment), smeared or missed (the voice never
 *    came near); run.score mixes reach, tuning, definition and timing. These tips also reach the Vibrato oscillation
 *    drills and the turns, so their words fit any quick notes; only run.score (tempo ladders) speaks of "the run".
 *  - dynamics (analysis/dynamics.ts, exercises/loudness.ts) read loudness relative to the take itself: pitch against
 *    loudness, how far the level moves, a swell's two halves, and the level's shape against the cue.
 * Practise levels are earlier than every level that shows the tip.
 */
import type { CoachLadder } from '../types';

export const LADDERS_EXPRESSION: Readonly<Record<string, CoachLadder>> = {
  // ---------------------------------------------------------------- inflections, one figure each
  'scoop.shape': {
    tip: 'Start clearly below the note, as low as the demo starts, and slide up quickly so you arrive on time. Then hold the note still in the middle of the band.',
    why: 'A scoop usually happens by accident, so a scoop on purpose tends to come out too small or too late. Here it is a planned move: start a set distance below, slide up quickly to arrive on time, then hold the note in tune, and the app checks all three.',
    steps: [
      'Tap Listen and hum along with the first scoop: a low start, a quick slide up, then a steady note.',
      'Find the low start: sing the main note as “re”, then the “do” just below it. That “do” is where each scoop begins.',
      'Begin on that low note right on the click, and slide up on “ah” in one quick, smooth move.',
      'Arrive halfway to the next click, then stop moving and hold the note in the middle of the band.',
      'Breathe in the rest, then give the next scoop the same low start and the same quick slide.',
    ],
    easier: 'Try the scoop on a hum or a lip trill (lips bubbling, like a motorboat) first: low start, quick slide, steady note. Once that feels easy, sing the same move on “ah”.',
    practiseLevelId: 'foundations.05',
  },
  'fall.shape': {
    tip: 'Hold the note level for its full length, then let it fall away in one smooth slide down as the sound fades, like a sigh.',
    why: 'It is natural to let the pitch sag early, or to drop it in one step instead of a slide. The app checks that the note stays level until the fall, then falls far enough, at the demo’s speed, in one smooth slide as the sound fades. So hold first, then let go.',
    steps: [
      'Say “ahhh” out loud with a sigh at the end, then sing it the same way: a held note that sighs away.',
      'Hold the note level for its two clicks, with steady air right to the end.',
      'Then let go: slide down smoothly and let the sound get quieter as it falls.',
      'Fall as far as the demo does; a small droop does not count as a fall.',
      'Keep the fall quick, about half a click long, with no bump back up at the bottom.',
    ],
    easier: 'Try it on a hum with your lips closed: hold the hum, then let it sigh down and fade. Sing the held part gently, so letting go is easy.',
    practiseLevelId: 'foundations.05',
  },
  'slide.shape': {
    tip: 'Leave the first note right on the click and slide at one even speed, so you arrive exactly when the demo does. Then hold the new note still.',
    why: 'Most voices wait on the first note and then rush, or jump most of the way and creep in at the end. The app checks how long the slide takes, when it arrives, how even and unbroken it is, and where it lands, so think of one even ramp from the click to the arrival.',
    steps: [
      'Tap Listen and trace the slide in the air with your hand: start on the click, then move at one steady speed.',
      'Slide on an “ng” hum, as at the end of “sing”, keeping it smooth with no break. Then sing the same slide on “ah”.',
      'Start moving exactly on the click; don’t linger on the first note.',
      'Spread the slide across all the time it is given, so you arrive neither early nor late.',
      'When you arrive, stop moving and hold the new note in the middle of the band.',
    ],
    easier: 'Practise the slide through a drinking straw or on a lip trill, a little slower than asked, until it is smooth. Then match the demo’s speed on “ah”.',
    practiseLevelId: 'foundations.05',
  },
  'turn.shape': {
    tip: 'Give the note above and the note below each their own small landing, with the main note between them, and finish back on the main note.',
    why: 'In a quick turn the voice tends to cut corners, so the outer notes shrink toward the main note or blur into it. The app checks that you reach each outer note at the right distance and on time, then come home in tune, so slow it down until every note is clear.',
    steps: [
      'Say the pattern in time with the clicks, “up, home, down, home” (or down first), tapping each note on your leg.',
      'Sing it slowly on “ah”, at half speed, one clean note per tap.',
      'The note above is like going from “do” up to “re”; the note below is just a half step, the next key down on a piano.',
      'Now sing it at the demo’s speed, light and small, letting each note sit still for an instant.',
      'Finish on the main note and hold it still in the middle of the band.',
    ],
    easier: 'Sing the turn on a lip trill at half speed until every note is clear, then on “ah”. Clean first, quick later.',
    practiseLevelId: 'vibrato.02',
  },
  'flip.shape': {
    tip: 'Jump straight to the top note in one quick, light flip, and let your voice switch into its lighter gear instead of sliding up.',
    why: 'Near the place where your voice changes gears, the heavy low sound gets tight if you carry it up, so voices tend to slide up slowly or stop short of the top note. A flip is a quick switch into your light upper voice, like a yodel, and the app listens for a quick jump that lands right on the top note.',
    steps: [
      'Find your light upper voice first: a soft, high “hoo”, like an owl.',
      'Hear the top note in your head before you leave the low one.',
      'Sing the low note on “ah”, then jump to the top note on “oo” in one quick move, with no slide in between.',
      'Let the top note be lighter and quieter than the low one, rather than carrying the heavy low sound up.',
      'Hold the top note still for its full length, right in the middle of the band.',
    ],
    easier: 'Practise just the jump on a quiet “hoo”, like a gentle yodel, until the switch feels easy. Stop and rest if anything feels tight, scratchy or hoarse.',
    practiseLevelId: 'foundations.08',
  },

  // ---------------------------------------------------------------- inflections, any figure
  'inflection.shape': {
    tip: 'Copy the demo’s move exactly: how far it goes, how fast it goes, and the note it lands on.',
    why: 'Each move in this world, a scoop, fall, slide, turn or flip, is graded against the one the exercise asks for. A move that is far too small, too slow or too rushed may not count as that move at all, so match the demo’s size and timing before adding your own style.',
    steps: [
      'Tap Listen and hum along quietly with just the move, twice.',
      'Describe it to yourself in plain words, like “start low, slide up, hold”.',
      'Sing it on a hum or a lip trill first, slowly, then at the demo’s speed.',
      'Make the move as big and as clear as the demo’s; a timid one may not count.',
      'Finish on the landing note and hold it still in the middle of the band.',
    ],
    easier: 'Sing the move softly and slower than asked, on a hum, until its shape feels natural. Then bring it up to the demo’s speed.',
    practiseLevelId: 'foundations.05',
  },
  'inflection.shape-any': {
    tip: 'The shape is close. Now match the demo’s size and timing exactly, and land right in the middle of the note.',
    why: 'When a move is nearly right, the last points come from precision: starting and arriving exactly on time, and a landing that sits still. Small, relaxed movements are more precise than big efforts.',
    steps: [
      'Listen once more and notice exactly where the move starts and ends against the clicks.',
      'Sing along quietly with the demo, matching its speed and size.',
      'Keep your jaw and tongue loose, so the move stays light.',
      'After each move, hold the landing note still with steady air.',
    ],
    easier: 'Sing it a little softer for a take or two: a lighter voice moves more precisely. Rest a minute between takes so each one is fresh.',
  },
  'inflection.landing': {
    tip: 'After the move, aim right at the middle of the landing note and hold it there.',
    why: 'After a move, the voice often stops a little short or goes past the note, then stays there because all the attention went into the move. Hear the landing note before you start, so the move has an exact place to go.',
    steps: [
      'Tap Listen, then hum just the note each move lands on, by itself, until you can find it easily.',
      'Hear that note in your head before you start the move.',
      'As you land, watch your line on the screen and ease it gently into the middle of the band.',
      'Then keep the air steady and the jaw still for the rest of the note.',
      'Sing the move and the landing together slowly, then at the demo’s speed.',
    ],
    easier: 'Do the move slower and softer, so you have time to find the middle of the landing note. Then build back up to speed.',
    practiseLevelId: 'foundations.02',
  },
  'inflection.landing-any': {
    tip: 'Your landings are close. Finish every move right in the middle of the note, and keep it there.',
    why: 'The landing note is what a listener remembers. Once the move is in shape, a still, centred landing is what makes it sound finished.',
    steps: [
      'Hear each landing note in your head before the move starts.',
      'As you arrive, relax, so the note settles instead of bouncing.',
      'Watch your line as you land and ease it into the middle of the band.',
      'Keep steady air to the very end of the landing note.',
    ],
    easier: 'Sing a little softer for a take or two: a lighter sound is easier to centre.',
  },

  // ---------------------------------------------------------------- quick notes: runs, turns, oscillation drills
  'run.missed': {
    tip: 'Touch every note lightly instead of singing each one full. A small, quick touch is enough, as long as no note gets skipped.',
    why: 'At speed, a heavy, full voice can’t change notes fast enough, so some notes get skipped or land on the wrong pitch. The app marks a note missed when your voice never came near it, so learn the notes first, then sing them lighter.',
    steps: [
      'Say the rhythm first: speak “da” for every note, in time with the clicks.',
      'Sing the notes slowly on your own, one clean note per tap, counting them so none gets skipped.',
      'Hear each note in your head before you sing it; tap Listen again for any you’re unsure of.',
      'Then sing at the take’s speed, lighter and quieter, just touching each note.',
      'After the take, check the replay: a cross marks a note your voice never came near.',
    ],
    easier: 'Sing the notes at half speed on a lip trill or a light “ee” before the take, until none goes missing. Clean and slow comes before fast.',
    practiseLevelId: 'foundations.09',
  },
  'run.missed-any': {
    tip: 'Nearly every note is there. Touch each one, including the quick notes in the middle, however lightly.',
    why: 'The quick notes in the middle are the easiest to drop, because the voice hurries toward where it is going. A light touch on each one keeps every note in place.',
    steps: [
      'Sing the notes slowly once, counting them on your fingers.',
      'Notice which note you tend to skip, and think of it clearly as you pass it.',
      'Then sing at speed, light and relaxed, touching every note.',
      'Keep a steady pace with the clicks; don’t hurry toward the last note.',
    ],
    easier: 'Sing a touch softer for a take or two: a lighter voice reaches every note more easily.',
  },
  'run.smeared': {
    tip: 'Give every note its own tiny landing so it doesn’t blur into the next: land, move, land.',
    why: 'When notes move fast, the voice tends to slide between them, and they blur together. The app checks that each note sits on its own pitch for a moment, so practise one clean note per beat, slowly, and then speed up.',
    steps: [
      'Speak the rhythm first: say “da” for each note, in time with the clicks.',
      'Sing it slowly, one clean note per tap, letting each note sit still for a moment before you move.',
      'Add a light “h” before each note, “ha-ha-ha”, to keep the notes apart.',
      'Then take the “h” away and sing a plain “ah”, keeping the same clean steps.',
      'Where two notes sit right next to each other on a piano, keep the move tiny but still land on each one.',
      'Play your take with “Slow + target” and listen for the notes that ran together.',
    ],
    easier: 'Sing it at half speed on “ha-ha-ha”, softly, a few times before the take. Light and slow first: speed comes once every note is clear.',
    practiseLevelId: 'foundations.09',
  },
  'run.defined-any': {
    tip: 'Most notes are clear. Keep every one distinct right to the last note: land, move, land.',
    why: 'Quick notes often start clean and blur toward the end, as the voice speeds up or gets heavier. The same light, even touch all the way through keeps every note distinct.',
    steps: [
      'Keep the voice light and the jaw loose from the first note to the last.',
      'Think of each note as a small step, not a slide.',
      'Keep a steady pace with the clicks; don’t hurry the end.',
      'Play your take with “Slow + target” to hear which notes still run together.',
    ],
    easier: 'Sing a little softer for a take or two: a lighter voice changes notes more cleanly.',
  },
  'run.score': {
    tip: 'Make the run clean at this speed before going faster. A take that passes here is what moves you on.',
    why: 'Your run score mixes four things: reaching every note, singing it in tune, keeping it separate from the notes around it, and changing notes on time. Rushing costs all four, so clean comes before fast.',
    steps: [
      'Tap Listen and sing along under your breath to learn the order of the notes.',
      'Tap the beat on your leg and speak the rhythm on “da”, in time with the clicks.',
      'Sing it slowly on your own, one clean note per tap, then at the take’s speed.',
      'Change notes right with the clicks: not early, not late.',
      'Keep it light and quiet; a smaller voice moves faster and lands more cleanly.',
      'Rest for a minute between takes, and stop if your throat feels scratchy or hoarse.',
    ],
    easier: 'Sing it on a lip trill at half speed, then on “ah”. A clean pass at this speed is real progress, and it is what moves you on.',
    practiseLevelId: 'vibrato.02',
  },
  // The only run-score rule off the tempo ladders (Turns, the Inflections Boss, the turn and flip auditions), where it
  // can be the main fault of a failed take: so it makes no claim about how well the notes went.
  'run.score-any': {
    tip: 'Keep every quick note light, on its pitch and right with the clicks: speed comes from small, clean movements, not effort.',
    why: 'The score mixes reaching every note, singing it in tune, keeping it separate and changing on time. A relaxed jaw and a light voice help all four.',
    steps: [
      'Keep the sound light and the jaw loose all the way through.',
      'Keep the notes evenly spaced against the clicks.',
      'Hold the last note still, in the middle of the band, to finish.',
    ],
    easier: 'Sing a little softer for a take or two, and let clean notes carry the speed.',
  },

  // ---------------------------------------------------------------- dynamics: louder is more steady air, never a higher note
  'dyn.sharp-loud': {
    tip: 'As you get louder, keep the note exactly where it is. Louder means more steady air, not a higher note.',
    why: 'When you get louder by squeezing your throat, the pitch creeps up along with the volume. Let the extra loudness come from steady breath and a slightly more open mouth, while the note stays put.',
    steps: [
      'Find the note at a medium level first and settle it in the middle of the band.',
      'As the sound gets louder, let the extra air come from your belly and ribs, not from your throat.',
      'Open your mouth a little more for the loud part, instead of tightening.',
      'Think of the note staying level, or even a hair lower, when it is loud.',
      'Watch your line on the screen: it should stay flat whether the sound is soft or full.',
      'Keep your loud comfortable, well short of your loudest.',
    ],
    easier: 'Make the loud part only medium loud for now, and change more slowly. A smaller change that stays on the note beats a big one that rises.',
    practiseLevelId: 'foundations.13',
  },
  'dyn.flat-soft': {
    tip: 'As you get softer, keep the note up where it was. Soft still needs a steady stream of air.',
    why: 'When the sound gets quieter, the breath often slows and the body sags, and the pitch drops with it. Keep the air moving and think of the note staying up as the volume comes down.',
    steps: [
      'Stand or sit tall, and keep your ribs open right to the end of the note.',
      'Keep a slow, steady stream of air going even when the sound is very soft.',
      'Think of the note a hair higher when it is soft, so it stays level.',
      'Go soft but clear, never all the way to a whisper.',
      'Watch your line on the screen: it should stay level as the sound gets softer.',
    ],
    easier: 'Go only to medium soft at first, slowly, and keep the sound clear. A gentle hum on “mm” is a good way to feel soft but steady.',
    practiseLevelId: 'foundations.13',
  },
  'dyn.against-cue': {
    tip: 'Follow the loudness shape the cue names, the way the demo plays it: start where it says, then grow, fade or switch on time.',
    why: 'It is easy to start loud out of habit, or to fade early as the air runs out, so the loudness moves against the cue. The app compares the shape of your loudness with the shape the cue asks for, so plan the shape and your breath before you start.',
    steps: [
      'Read the cue before you sing and say the shape out loud, like “soft, grow, fade”.',
      'Tap Listen and notice where the demo is soft and where it is full.',
      'Take a full, easy breath, and if the cue starts soft, start softer than feels natural.',
      'For soft and loud switches, change right on the clicks and keep each part steady until the next change.',
      'Spend your air slowly, so the end of the note is your choice, not the air running out.',
    ],
    easier: 'Sing the shape on a gentle hum first, to feel the change in loudness. Then open the hum into “ah” and do the same.',
  },
  'dyn.slope': {
    tip: 'Let only the loudness change. Keep the note exactly where it is, whether the sound is soft or full.',
    why: 'As your voice gets louder or softer, it works harder or eases off, and the pitch tends to wander along with it, up or down. The app compares your pitch at every loudness, so aim for a pitch line that stays flat while only the volume moves.',
    steps: [
      'Settle each note in the middle of the band before the loudness starts to change.',
      'Change the loudness slowly, with steady breath, keeping your jaw and tongue still.',
      'Keep the same “ah” from start to finish; a changing vowel can pull the pitch.',
      'Watch your line on the screen: if it bends as the sound changes, change the loudness more gently.',
      'Rest between notes, so each one starts fresh and relaxed.',
    ],
    easier: 'Make the change smaller and slower for now, going only to medium loud. A small, steady change is the way in.',
    practiseLevelId: 'foundations.13',
  },
  'dyn.slope-any': {
    tip: 'Your pitch is holding well. Keep the line flat from soft to full while only the loudness changes.',
    why: 'Good singers let the volume move like a dimmer switch while the note stays put. Small habits, like a jaw that tightens on the loud part, can still nudge the pitch.',
    steps: [
      'Keep your jaw loose and still, even at the loudest point.',
      'Keep the breath steady as the sound grows and fades.',
      'Watch your line on the screen and keep it level the whole way.',
    ],
    easier: 'Try one take a little softer overall, to feel how still the note can stay.',
  },
  'dyn.range-small': {
    tip: 'Make a bigger difference between soft and full: make the soft parts softer than feels natural, and let the full parts bloom.',
    why: 'Most voices stay near one comfortable loudness, so the change is smaller than it feels from the inside. The app measures how far your loudness moves on each note, so make the soft really soft and the full rich, without changing the note.',
    steps: [
      'Make your soft really soft, like singing to someone asleep in the next room.',
      'Make your full rich and easy, adding breath and opening your mouth a little more.',
      'Move between them slowly and evenly, or right on the clicks when the cue says to switch.',
      'Keep the phone or mic the same distance from your mouth, so the change it hears is your voice.',
      'Never strain for loudness: full means rich and easy, not shouting.',
    ],
    easier: 'Practise the soft sound on a hum, then let the hum open into “ah” and grow. A softer soft is easier than a louder loud.',
  },
  'dyn.range-any': {
    tip: 'Good change in loudness. Make the soft parts a little softer still, so there is more room between soft and full.',
    why: 'A wider gap between soft and full makes the shape easy to hear. It comes most easily from a softer soft, not a louder loud.',
    steps: [
      'Let the soft parts drop to a gentle, clear thread of sound.',
      'Keep the full parts easy and rich, never shouted.',
      'Keep the note in the middle of the band all the way through.',
    ],
    easier: 'Practise the softest part on a hum, to feel how soft you can go while staying clear.',
  },
  'dyn.symmetry': {
    tip: 'Shape the swell evenly: take as long to fade as you took to grow, with the loudest point in the middle.',
    why: 'Voices tend to grow quickly and then run short of air, so the fade is rushed or never comes. The app compares the growing half with the fading half, so plan your breath for the whole note and peak in the middle.',
    steps: [
      'Take a full, easy breath before the note, without lifting your shoulders.',
      'Count slow seconds in your head: grow for the first half of the note, fade for the second half.',
      'Grow slowly; if you are full too early, the fade has to rush.',
      'Spend the air slowly on the way down, like letting air out of a balloon.',
      'End as soft as you began, still on the note.',
    ],
    easier: 'Make the swell smaller: grow only to medium loud, so the fade is easy to control. Widen it once the two halves match.',
    practiseLevelId: 'dynamics.02',
  },
  'dyn.symmetry-any': {
    tip: 'The swell is nearly even. Peak right in the middle, and come down at the same pace you went up.',
    why: 'A swell sounds finished when its two halves mirror each other. That usually comes down to saving a little more air for the fade.',
    steps: [
      'Count slow seconds in your head and reach the peak exactly halfway.',
      'Fade at the same pace you grew.',
      'Finish as soft as you started, still on the note.',
    ],
    easier: 'Try one take a little less loud at the peak, so the fade has air to spare.',
  },
};
