/**
 * Coaching ladders for tip ids starting with: acc. range. general.
 *
 * What the words stand on (checked against the analyzers, so nothing promises a reading the app cannot make):
 *  - acc.*: analysis/accuracy.ts measures the held part of each note, after its first moment (the onset analyzer owns
 *    that): where it sat against the middle of the bar (bias, sharp or flat by the signed average), the share of it
 *    inside the bar times the share actually sung (a late start or an early stop counts), the typical miss, the spread
 *    and, on holds of a second or more, the drift. Targets are never octave-folded, so a note sung an octave away is a
 *    miss (and its line leaves the Sing screen's window).
 *  - range.*: analysis/range.ts keeps the lowest and highest notes held still for at least a second, anywhere in the take.
 *  - general.*: the takes no rule explains (exercises/tips.ts GENERAL_TIP_IDS): nothing heard (analyze.ts noVoice),
 *    an exercise folded into a too-narrow saved range (not judged), notes left unsung (a take needs every note, or
 *    nearly every note of a long exercise: evaluate.ts notesNeeded, counted by analyze.ts noteReach whatever the
 *    pitch), a take stopped early (practice, not judged), a clean take (the polish line; the coach shows the runner's
 *    own words for it, runtime/polish.ts) and a miss no rule explains (pickTip's retry).
 *  - The steps use only what the app has: Listen, the bars and their middle line (a bar fills in while you are inside
 *    it), the replay on the report, Live pitch with a target note picked under More, and Setup & calibration.
 *
 * Plain words for a singer relearning music (src/coaching/types.ts CoachLadder): no units or jargon, no exclamation
 * marks, never "push" or "force", and rest when anything hurts, scratches or goes hoarse. practiseLevelId names the
 * level that trains the skill (Pitch match: hear a note and centre it; Sustain I: hold one steady and level).
 */
import type { CoachLadder } from '../types';

export const LADDERS_ACCURACY: Readonly<Record<string, CoachLadder>> = {
  // ---------------------------------------------------------------- where held notes sit (bias)
  'acc.sharp': {
    tip: 'Ease off a little so each note settles onto the middle line of the bar: loosen your jaw and use a little less breath pressure.',
    why:
      'Singing sharp usually comes from extra effort: a tight jaw or throat, or more breath pressure than the note needs, and the pitch rides up with it. ' +
      'It shows most on higher or louder notes, where it’s tempting to work harder. ' +
      'The one thing to change: less effort, so the note can sit where it belongs.',
    steps: [
      'Before you sing, let your jaw hang loose and your shoulders drop, then take an easy, low breath.',
      'Hear the note in your head first, and think of it as sitting slightly lower than you expect.',
      'Use only as much breath as each note needs; extra air drives the pitch up.',
      'Watch your line: if it rides along the top of the bar, relax until it sits on the middle line.',
      'On higher notes, think lighter rather than harder.',
    ],
    easier:
      'Try the next take a little softer, on “oo”, which settles more easily than a bright “ah”. ' +
      'If anything feels tight or scratchy, stop and rest before you go on.',
    practiseLevelId: 'foundations.02',
  },
  'acc.flat': {
    tip: 'Keep the air moving right to the end of each note, and aim a hair higher, onto the middle line of the bar.',
    why:
      'Singing flat usually comes from too little energy behind the note: the breath slows down, the sound turns heavy or dark, and the pitch sinks. ' +
      'It’s common when you’re tired, singing very quietly, or reaching for higher notes. ' +
      'The one thing to change: a steady flow of air and a bright, lifted sound.',
    steps: [
      'Stand tall, chest comfortably high, and take a low, easy breath before each note.',
      'Hear the note in your head first, and think of it as slightly higher than you expect.',
      'Lift your cheeks a little, as if starting to smile, so the vowel stays bright.',
      'Keep the air flowing to the very end of the note, like a steady stream.',
      'Watch your line: if it sits along the bottom of the bar, lift it gently to the middle line.',
    ],
    easier:
      'Before the next take, buzz your lips on each note like a motorboat (a lip trill) to get the air moving, then sing it the same way. ' +
      'If your voice feels tired, rest a few minutes first; tired voices tend to sing flat.',
    practiseLevelId: 'foundations.02',
  },
  // Direction unknown (no signed context): coach the check, not a direction.
  'acc.bias': {
    tip: 'Check each note against the middle line of the bar as it starts, and move your voice up or down onto it before you hold.',
    why:
      'Your held notes settled away from the middle of the bar. ' +
      'That usually means the note in your head isn’t locked in yet, so your voice lands near it and stays there. ' +
      'The one thing to change: check each note against the middle line as it starts, and move onto it before you hold.',
    steps: [
      'Tap Listen, then hum quietly along with the demo, matching each note.',
      'As each note starts, look at your line: above the middle line is high, below it is low.',
      'If you’re high, relax and use a little less breath; if you’re low, brighten the vowel and keep the air moving.',
      'Once you’re on the middle line, hold still there to the end of the note.',
    ],
    easier:
      'Practise one note without the clock: on Live pitch (from Home), pick a comfortable target note under More, tap Listen, then tap Sing and match it until the bar fills in. ' +
      'Move your line onto the middle line and hold it there, then come back to the exercise.',
    practiseLevelId: 'foundations.02',
  },
  // Pulse builders and the Dynamics levels: the centre of a pulsing or swelling note.
  'acc.bias-any': {
    tip: 'Aim for the very middle of each bar, not just inside it. Small offsets add up over a take.',
    why:
      'Your notes are landing close to their centre; what’s left is a small, steady lean above or below it. ' +
      'Sitting right on the middle line sounds settled, and it keeps you in tune when later levels narrow the bar. ' +
      'The one thing to change: aim for the middle line itself.',
    steps: [
      'Hear the note in your head before you sing it.',
      'As the note starts, find the thin line through the middle of the bar and aim right at it.',
      'If your line leans high, relax a little; if it leans low, keep the air moving and brighten the vowel.',
      'Whether you’re pulsing or growing louder and softer, keep the middle of the sound on that line.',
    ],
    easier:
      'Hold one easy note on Live pitch (from Home), with a target note picked under More, and practise sitting on the middle line. ' +
      'Then bring that feeling back to the exercise.',
    practiseLevelId: 'foundations.03',
  },

  // ---------------------------------------------------------------- time inside the bar (in tune)
  'acc.in-tune-low': {
    tip: 'Hear each note in your head before you sing it, then sing straight into the middle of the bar and stay there until the bar ends.',
    why:
      'The app counts the time your voice spends inside each bar, from just after the note starts to its end, so wandering outside it and time you don’t sing (coming in late, stopping early) both lower it. ' +
      'On later levels the bar gets narrower, so the same small miss counts for more. ' +
      'The one thing to change: know the note before you sing it, so you arrive in the bar instead of searching for it.',
    steps: [
      'Tap Listen and let the demo play once while you just listen.',
      'Before each note, hear it in your head for a moment, as if you were already singing it.',
      'Start the note gently, at an easy volume, aiming at the middle line of the bar.',
      'If your line lands outside the bar, slide slowly toward it until the bar fills in, then hold still.',
      'Keep singing until the bar ends, then breathe in the gap.',
      'If your line drops off the top or bottom of the screen, you may be an octave away from the demo: try the note higher or lower.',
    ],
    easier:
      'Practise without the clock first: on Live pitch (from Home), pick a comfortable target note under More, tap Listen, then tap Sing and match it until the bar fills in. ' +
      'Then sing the next take a little softer, on “oo”, which is easier to tune.',
    practiseLevelId: 'foundations.02',
  },
  'acc.in-tune-any': {
    tip: 'Hear every note before you sing it, and keep the sound still once you arrive in the bar.',
    why:
      'You’re inside the bar most of the time; what’s left is usually the first moment of a note, while your voice is still finding it, or a little wandering later on. ' +
      'Arriving straight on the note and staying put closes the gap. ' +
      'The one thing to change: hear it first, then hold it still.',
    steps: [
      'Before each note, hear it in your head for a moment.',
      'Land on the middle line of the bar and let the bar fill in.',
      'Once it fills, keep your jaw, tongue and breath steady until the bar ends.',
      'Breathe in the gaps, so the last note gets as much air as the first.',
    ],
    easier:
      'Sing the next take at a gentle, medium-soft volume; a relaxed sound is easier to keep still. ' +
      'If one note keeps slipping, practise it on Live pitch (from Home) with that note set as the target under More.',
    practiseLevelId: 'foundations.02',
  },
  // Only when no held note could be measured at all.
  'acc.missing': {
    tip: 'Sing each note for its whole bar in a clear, steady voice, close enough to the phone for your line to follow you.',
    why:
      'The app can only measure a note it hears clearly: a steady tone held for the length of the bar. ' +
      'A whisper, a breathy sigh, a noisy room or a phone too far away can make your line break up or vanish. ' +
      'The one thing to change: a clear tone at a medium volume, held to the end of each bar.',
    steps: [
      'Prop the phone about an arm’s length away, with nothing covering its mic, in a quiet room.',
      'Use wired headphones if you have them; Bluetooth headsets are poor microphones for singing.',
      'Sing on a clear “ah” at a medium volume, not a whisper.',
      'Watch your line as you sing; if it keeps breaking up, sing a little louder or move closer.',
      'Hold each note until its bar ends, then breathe in the gap.',
      'If no line appears at all, open Setup & calibration from Home and check the microphone step.',
    ],
    easier:
      'Check the sound on its own first: on Live pitch (from Home), tap Sing, sing an easy “ah”, and watch for a steady line and a note name. ' +
      'Once they show clearly, the exercise can hear you too.',
  },

  // ---------------------------------------------------------------- the typical miss
  'acc.median': {
    tip: 'Hum along quietly with the demo before the take, then hear each note in your head and sing right onto the middle line of the bar.',
    why:
      'A typical note landed some way from its centre, which is normal while your ear and voice are learning to work together. ' +
      'The ear learns where a note is by matching it and seeing it land, again and again. ' +
      'The one thing to change: be sure of the note before you sing it, then correct it as soon as you see your line.',
    steps: [
      'Tap Listen and hum quietly along with the demo, matching each note.',
      'On the take, hear each note in your head in the moment before it starts.',
      'Start softly and watch your line; slide up or down until the bar fills in.',
      'When it fills, notice how that note feels, and hold still to the end of the bar.',
      'If your line drops off the top or bottom of the screen, you may be an octave away from the demo: try the note higher or lower.',
    ],
    easier:
      'Between takes, open Live pitch (from Home), pick the note named above as the target under More, and slide gently into it on “oo” until the bar fills, a few times, so your ear learns where it is. ' +
      'On the take itself, start each note on the pitch.',
    practiseLevelId: 'foundations.02',
  },
  'acc.median-any': {
    tip: 'Listen to the demo once more, then aim for the thin middle line of each bar, not just the inside of it.',
    why:
      'You’re landing close to each note, so the gain now is in the last little bit. ' +
      'A note sitting on the middle line sounds sure and settled; one near the edge can sound slightly off, even when it counts. ' +
      'The one thing to change: aim for the middle line from the moment each note starts.',
    steps: [
      'Tap Listen and follow the demo in your head, note by note.',
      'As each bar arrives, picture its middle line and aim your voice right at it.',
      'Keep your line on the middle line, like tracing a ruler, to the end of the note.',
      'After the take, find any note in the replay that sat off the middle, and give it extra care next time.',
    ],
    easier:
      'Sing the next take a little softer and calmer; a relaxed voice lands closer to the middle. ' +
      'Small, steady gains are how accuracy grows.',
    practiseLevelId: 'foundations.02',
  },

  // ---------------------------------------------------------------- steadiness (spread)
  'acc.unstable': {
    tip: 'Hold each note straight: steady air, a still jaw, and think of the sound as one flat line.',
    why:
      'The pitch moved around while you held the note, and uneven breath is the usual cause: the air comes out in bursts, or the jaw and tongue shift, and the pitch follows them. ' +
      'A wobble counts as movement here too, so keep the tone straight for now. ' +
      'The one thing to change: a slow, even stream of air.',
    steps: [
      'Breathe in low and slow, letting your belly and lower ribs widen.',
      'Let the air out evenly, as if through a thin straw, for the whole note.',
      'Keep your jaw loose and still, and keep the same vowel shape until the note ends.',
      'Sing at a medium volume; very soft and very loud are both harder to hold steady.',
      'Watch your line and keep it flat, like drawing along a ruler.',
    ],
    easier:
      'Before the next take, hum each note through a drinking straw, or on a lip trill (lips buzzing like a motorboat), for a few seconds: both even out the air for you. ' +
      'Then sing the take with the same steady flow.',
    practiseLevelId: 'foundations.03',
  },
  'acc.stability-any': {
    tip: 'Keep the air flowing evenly and your jaw relaxed, so your line stays flat from start to finish.',
    why:
      'Your notes are mostly steady; the little movement left usually comes near the end of a breath or when the vowel shifts. ' +
      'Even air and a still mouth smooth it out. ' +
      'The one thing to change: keep everything the same from the start of each note to its end.',
    steps: [
      'Take a full, quiet breath before each long note.',
      'Keep the vowel shape exactly the same until the note ends.',
      'Let your jaw rest loose, and keep your head and shoulders still.',
      'Spend the air slowly, so there’s some left at the end.',
    ],
    easier: 'If the ends of long notes shake, breathe a moment earlier and sing a touch softer; a relaxed, medium-soft tone is the easiest to hold still.',
    practiseLevelId: 'foundations.03',
  },

  // ---------------------------------------------------------------- drift over a hold (holds of a second or more)
  'acc.drift-flat': {
    tip: 'Keep the air going steadily to the very end of each long note, so the pitch doesn’t sink as your breath runs low.',
    why:
      'As your breath runs low, the air pressure drops and the pitch slides down with it, which is why it shows at the end of long notes. ' +
      'Letting your chest and ribs sink early makes it happen sooner. ' +
      'The one thing to change: keep your ribs wide and spend the air slowly, so the end of the note gets as much as the start.',
    steps: [
      'Before each long note, breathe in low and slow, letting your waist and lower ribs widen.',
      'As you sing, keep your ribs wide instead of letting your chest drop.',
      'Spend the air slowly, as if it has to last longer than the note.',
      'Near the end, think of the note lifting slightly, and keep the vowel bright.',
      'Watch the end of your line: if it starts to slope down, keep the air moving rather than letting it fade.',
    ],
    easier:
      'Before the next take, do two or three long lip trills (lips buzzing like a motorboat) on an easy note, keeping the buzz even to the very end. ' +
      'Then sing the take a little softer, with the same steady air; a clear, gentle tone uses less breath.',
    practiseLevelId: 'foundations.03',
  },
  'acc.drift-sharp': {
    tip: 'Keep the effort level as you hold: ease off the breath pressure and let each note float instead of tightening as it goes.',
    why:
      'When a note creeps up, the effort is usually building as you hold: the throat tightens or the breath presses harder toward the end, and the pitch rises with it. ' +
      'Worrying about running out of air makes it worse. ' +
      'The one thing to change: the same easy effort from the start of the note to the end.',
    steps: [
      'Breathe in low and easy before each note, so you’re not worried about running out.',
      'Start at a comfortable volume and keep it level, without letting it grow.',
      'Keep your jaw loose and your throat open, like the start of a yawn.',
      'Near the end of the note, think of it settling down softly, like a landing.',
      'Watch the end of your line: if it starts to slope up, relax your shoulders and ease the breath.',
    ],
    easier:
      'Sing the next take a little softer than feels natural; a gentle tone rarely creeps up. ' +
      'If the end of a note feels tight or scratchy, rest for a few minutes before the next take.',
    practiseLevelId: 'foundations.03',
  },
  // Also the drift tip when the notes drift both ways (no direction to name), so the words claim no size or direction.
  'acc.drift-any': {
    tip: 'Keep the air steady all the way through each hold, so the end of the note sits where the start did.',
    why:
      'Long notes drift when the effort changes while you hold them: the breath fades and the pitch sinks, or the throat tightens and it creeps up. ' +
      'Planning the air so the last moment gets as much as the first keeps the line level. ' +
      'The one thing to change: pace your breath across the whole note.',
    steps: [
      'Take a full, low breath before each long note.',
      'Start at a volume you could keep up for twice as long.',
      'Keep your ribs wide and the vowel the same as the note goes on.',
      'After the take, check the replay: the goal is a level line to the end of each bar.',
    ],
    easier:
      'If the drift comes at the end of the longest notes, breathe a little deeper before them and sing them a touch softer. ' +
      'On long holds, steady matters more than loud.',
    practiseLevelId: 'foundations.03',
  },

  // ---------------------------------------------------------------- Range finder (the first level: nothing earlier to practise)
  'range.narrow': {
    tip: 'Go a little lower and a little higher than the lines on the screen while it still feels easy, and hold each end still on one note.',
    why:
      'The app measures the lowest and highest notes you held still for at least a second, so a note you only slide through doesn’t count. ' +
      'Most often the slide stops early, or the end note wobbles or fades before it settles. ' +
      'The one thing to change: at each end, stop sliding and sit on one steady note for a slow count of three.',
    steps: [
      'Warm up first with a few gentle sirens on “oo”, low to high and back.',
      'On the way down, keep sliding past the bottom line while it feels easy, then stop and hold that note.',
      'Hold the low note clearly for a slow count of three; don’t let it fade into a croak.',
      'Breathe, then slide up lightly, like a siren, past the top line while it still feels easy.',
      'Let the top note get lighter rather than louder, and hold it still for a slow count of three.',
      'Never strain: if a note takes effort, the one just before it is your answer.',
    ],
    easier:
      'Measure your range when you’re warmed up and rested, at an easy volume. ' +
      'If anything scratches or feels tight, stop and rest; your range will be there tomorrow.',
  },
  'range.missing': {
    tip: 'When you reach each end, stop sliding and hold one note still for a slow count of three.',
    why:
      'The app found no note held still for a full second, so it had nothing to measure. ' +
      'That happens when the voice keeps sliding, wavers a lot, or gets too quiet or breathy to follow at the ends. ' +
      'The one thing to change: at each end, stop moving and sit on one clear note.',
    steps: [
      'Tap Listen to hear the shape: a slide down and a held note, then a slide up and a held note.',
      'Slide down slowly; when it starts to feel like work, stop there on one note.',
      'Hold that note in a clear voice, not a whisper, while you count three slow beats in your head.',
      'Take a breath, sing the starting note again, then slide up lightly.',
      'Stop where it still feels easy, and hold that note still for three slow beats.',
    ],
    easier:
      'For one take, skip the slides: sing a comfortable low note and hold it, breathe, then a comfortable high note and hold it, each for a slow count of three. ' +
      'The app counts any note you hold still, wherever you sing it.',
  },
  // A passed Range finder whose span is short of full marks: polish, and voice care.
  'range.any': {
    tip: 'Stay in the easy part of your voice. Your range grows with relaxed, regular practice, not by reaching for hard notes.',
    why:
      'Your low and high notes are far enough apart for every exercise. ' +
      'Range widens on its own as your voice gets used to regular, easy singing, while reaching for hard notes only tires it. ' +
      'The one thing to keep: gentle practice, a little at a time, often.',
    steps: [
      'Start each session with a few easy sirens and hums.',
      'Keep top notes light and bottom notes clear, never pressed.',
      'Sing the Range finder again in a few weeks; your easy notes may reach a little further by then.',
      'Stop and rest if anything hurts, scratches or goes hoarse.',
    ],
    easier: 'There’s nothing to fix here. If your voice feels tired, rest for the day; a rested voice reaches further.',
  },

  // ---------------------------------------------------------------- the general tips (no rule explains the take)
  // A clean take: on a pass the coach shows only the tip, worded by the runner for that take (the next rung, every tally lit).
  'general.polish': {
    tip: 'Clean take. Sing it again the same easy way, or move on when you’re ready.',
    why:
      'Nothing in this take cost you much. ' +
      'Repeating a clean take is how it becomes automatic, so the next one feels easier. ' +
      'The one thing to keep: the same relaxed, easy way of singing.',
    steps: [
      'Sing it once more the same way, without trying harder.',
      'Notice what made it easy, such as your breath or how you stood, and keep it.',
      'Move on when you’re ready.',
    ],
    easier: 'If you’re tired, stop here: a clean take is a good place to end a session. Rest, sip some water, and come back fresh.',
  },
  // Almost nothing voiced in the whole take (analyze.ts noVoice). A blocked microphone stops the take before it starts,
  // so this is mostly a covered or distant microphone, the wrong input, or very quiet singing.
  'general.no-voice': {
    tip: 'No singing came through. Check that the microphone is allowed and uncovered, then start singing as soon as the count-in ends.',
    why:
      'The app can only judge what the microphone hears. ' +
      'If it is covered, too far away or set to the wrong input, or the singing is very quiet, the take comes through empty.',
    steps: [
      'Hold or prop the phone about an arm’s length away, with nothing covering its bottom edge, where the microphone is.',
      'Open Setup & calibration from Home and check the Microphone step: the phone’s own mic or wired headphones work best.',
      'If the phone asks about the microphone, choose Allow.',
      'Tap Sing, wait for the count-in, then sing at a clear, comfortable volume until the last bar has passed.',
      'Watch the line on the screen: it moves while the app hears you.',
    ],
    easier: 'Open Live pitch from Home and sing one easy note. If the line moves there, the microphone works and you can come back to this level.',
  },
  // The exercise had to be folded into a saved range too narrow for it, so the take was not judged.
  'general.unfit-range': {
    tip: 'This exercise does not fit your saved range, so the take was not judged. Sing the Range finder again and hold the lowest and highest notes that still feel easy.',
    why:
      'Each exercise is placed inside the range you saved with the Range finder. ' +
      'When that range is narrower than the exercise needs, some notes would have to move, and the take would not be the real exercise.',
    steps: [
      'Warm up with a few easy sirens on “oo”, low to high and back.',
      'Open the Range finder, the first level of Foundations, and sing it again.',
      'Slide down past the bottom line while it’s easy, and hold that note for a slow count of three.',
      'Slide up past the top line while it’s easy, and hold that note for a slow count of three.',
      'Come back to this exercise: it is then placed in your new range.',
    ],
    easier:
      'Sing the Range finder when your voice is warmed up and rested, on a gentle “oo”. ' +
      'Easy notes held still are all it needs, so never strain for a higher or lower one.',
  },
  // Too few of the target notes were sung for the take to pass (evaluate.ts reachHolds); the located problem says how many.
  'general.unsung': {
    tip: 'Keep singing to the end of the exercise, one bar after another: a take can pass only when every note is sung, or nearly every note in a long one.',
    why:
      'The app checks that you sang the notes you were asked to sing, whatever their pitch. ' +
      'If the singing stops part way, or notes are skipped, the take cannot pass, however good the rest was. ' +
      'The usual causes are stopping after a slip, running short of breath, or losing your place.',
    steps: [
      'Tap Listen first, so you know how long the exercise lasts.',
      'Take a breath in each gap between notes, so you have air for the next one.',
      'Follow the bars on the screen and sing each one as it arrives.',
      'If a note goes wrong, keep going: a wrong note costs far less than a skipped one.',
      'Sing at a clear, medium volume, so every note is loud enough to count.',
    ],
    easier:
      'Sing the next take softly on an easy “oo”, without worrying about pitch, just to get through every note from start to finish. ' +
      'Stop if anything hurts or feels scratchy, and rest.',
  },
  // Stopped before the end: practice, never judged.
  'general.stopped': {
    tip: 'You stopped before the end, so this take counts as practice and was not judged. Sing to the end of the exercise for it to count.',
    why:
      'A take is judged only when it is sung to the end. ' +
      'Stopping early is fine for practice, but it never counts toward passing.',
    steps: [
      'If you stopped because something hurt or felt scratchy, rest first: that was the right call.',
      'Tap Listen to hear the whole exercise once, start to finish.',
      'Tap Sing and keep going through any slips: a wrong note costs less than stopping.',
      'Breathe in the gaps between the notes.',
      'Let the take run until the bars end; the report opens by itself.',
    ],
    easier:
      'Treat the next take as a run-through: sing it softly, all the way to the end, without aiming for a score. ' +
      'Stop if anything hurts or feels scratchy, and rest.',
  },
  // A miss no rule explains (pickTip's fallback): the located problem names what the level asks for.
  'general.retry': {
    tip: 'Not there yet. Listen to the demo once more, then aim for what the level asks, named above.',
    why:
      'This take missed what the level asks without one clear fault the app could point to. ' +
      'Hearing the demo again, then singing calmly and clearly, is the surest next step.',
    steps: [
      'Tap Listen and hear the demo once, all the way through.',
      'Read the goal on the level screen again: it says what this level listens for.',
      'Pick one thing from the goal to focus on in the next take.',
      'Take a relaxed breath and sing at a clear, medium volume, close enough to the phone for your line to follow you.',
    ],
    easier: 'Rest for a minute, then sing the next take a little softer and calmer than the last. Easing off often lands more notes than trying harder.',
  },
};
