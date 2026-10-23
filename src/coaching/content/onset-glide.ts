/**
 * Coaching ladders for tip ids starting with: onset. glide. transition. (src/coaching/types.ts CoachLadder; plain words
 * for someone relearning to sing, owner 2026-10-22).
 *
 * The words stay true to what the app measures:
 *  - onset.*: the start of each note sung after a silence (analysis/onset.ts): how far below the note it began (scoop),
 *    how far past it went (overshoot), how long until it stayed in the band (settle) and whether the sound faded in
 *    (breathy, an estimate from how fast it swells). Match one note, Clean starts, the jumps, the Boss Recital, auditions.
 *  - glide.*: each slide's pitch at the moment it is meant to end (end), its stalls, dips and jitter (smoothness), and
 *    breaks: a sudden jump in pitch, or the sound cutting out anywhere inside a phrase, a breath included
 *    (analysis/glide.ts, cracks.ts). Small slides, Sirens, their audition test, and the Slides levels.
 *  - transition.*: each note change in a connected line, settled on the next note quickly and without going past it;
 *    a gap counts as change time (analysis/transitions.ts). The steps, Five notes in a row, the Boss Recital, the audition.
 *
 * practiseLevelId names the earliest level that trains the skill; the coach offers it only once that level is passed.
 */
import type { CoachLadder } from '../types';

export const LADDERS_ONSET_GLIDE: Readonly<Record<string, CoachLadder>> = {
  // ---------------------------------------------------------------- the start of the note
  'onset.scoop-big': {
    tip: 'Start each note right on its pitch instead of sliding up into it from below. Hear the note in your head first, then begin the sound exactly there.',
    why: 'A scoop happens when the voice starts before your ear has the note, so it begins low and slides up to find it. It’s one of the most common habits, and one of the easiest to fix. Have the note clearly in your head before you start, and begin the sound already on it.',
    steps: [
      'On the replay, look at the start of each note: a little hook up from below is the scoop.',
      'In the pause before each note, hear it in your head, as if you were about to hum it.',
      'Breathe in with your mouth already open for “ah”, so the sound starts right on the vowel.',
      'Aim the very first moment a hair higher than feels natural; scoops come from aiming low.',
      'If it still scoops, start each note with a short hum, like “mah”: the hum finds the pitch before the vowel opens.',
    ],
    easier: 'Sing a little softer, and hum each note on “mm” first, right on the pitch, before opening to “ah”. Take the whole pause to hear the note; there’s no rush.',
    practiseLevelId: 'foundations.02',
  },
  'onset.scoop': {
    tip: 'There’s a small slide up at the start of your notes. Aim the very first moment of the sound at the note itself, not just below it.',
    why: 'A small scoop is a habit: the voice starts a little low, then corrects. A timid start with too little breath makes it worse. Have the note ready in your head, then start with a calm, full breath.',
    steps: [
      'In each pause, hear the next note in your head and feel where it sits.',
      'Take a calm, full breath, then start the note with confidence, at an easy speaking volume.',
      'Think of placing the note from slightly above, like setting a cup down gently.',
      'Once you’re on the note, stay there instead of nudging it up.',
    ],
    easier: 'Hum each note on “mm” first, right on the pitch, then open to “ah”. Softer starts make it easier to hear exactly where you begin.',
    practiseLevelId: 'foundations.02',
  },
  'onset.scoop-any': {
    tip: 'Your notes start close to the pitch. Land the very start of each one right on the line, with no slide at all.',
    why: 'Even a tiny slide blurs the start of a note. Hearing the note first, and starting with your mouth already shaped for the vowel, lets the sound begin exactly on pitch.',
    steps: [
      'Hear each note before you sing it, even the easy ones.',
      'Start with your mouth already shaped for “ah”.',
      'Begin at an easy, confident volume rather than a timid one.',
    ],
    easier: 'Take your time in each pause: a calm, unhurried start lands cleaner than a rushed one.',
  },
  'onset.settle-slow': {
    tip: 'Your notes took a while to lock in. Hear each note in your head before you start, then begin right on it instead of searching for it with your voice.',
    why: 'When the voice starts before the ear has the note, it hunts: it lands near the note, wavers, and only then settles. The app times that search. With the note in your head first, your voice starts close enough to lock in almost at once.',
    steps: [
      'In the pause before each note, hear it silently, as if you were about to hum it.',
      'Take a calm breath and start gently, at an easy speaking volume: not breathy, and not a hard click.',
      'Start right on the note, then hold it still instead of sliding around it.',
      'Watch the bar on the screen: it lights up while you’re inside it. Aim to light it in the first instant.',
    ],
    easier: 'Hum each note softly on “mm” first, then open to “ah”: the hum helps your voice find the note before the vowel starts. Sing a little softer while you practise this.',
    practiseLevelId: 'foundations.02',
  },
  'onset.settle-missing': {
    tip: 'Many of your notes never settled inside the band. Hear each note first, start it gently, then hold it still once you land.',
    why: 'To count as settled, a note has to sit inside its band and stay there for a moment. A note that starts too far away, keeps wandering, or ends too soon never counts. Hearing the note first and holding it still once you arrive fixes most of this.',
    steps: [
      'Tap Listen and sing along softly with the demo once, to feel where the notes sit in your voice.',
      'In the pause before each note, hear it in your head first.',
      'Start gently, then hold the note completely still, like a flat line on the screen.',
      'Keep each note going for its full length; a note cut very short can end before it settles.',
      'Check the replay: if your line runs well above or below the bars, you’re singing a different note from the demo. Hum along with Listen to find it.',
    ],
    easier: 'Sing along with the Listen demo first, matching it softly, then sing the take on your own straight after. A softer, unhurried start makes it easier to land and stay.',
    practiseLevelId: 'foundations.02',
  },
  'onset.settle-any': {
    tip: 'Aim to lock onto each note in the first instant: hear it first, then start it cleanly so it sits still right away.',
    why: 'Your notes do settle; the last bit of speed comes from having the note ready before you sing. A clean start and a still note make the lock almost instant.',
    steps: [
      'Hear each note in your head during the pause before it.',
      'Start right on the pitch, at an easy volume, neither breathy nor hard.',
      'Once you land, keep the note perfectly still.',
    ],
    easier: 'Hum each note softly first, then open to “ah”; the hum finds the pitch for you.',
  },
  'onset.overshoot': {
    tip: 'You’re going past the note and then coming back to it. Aim at the note itself and land on it gently, especially when you leap up.',
    why: 'Overshooting happens when you throw your voice at a note, usually a high one, with a burst of effort, so it flies past and has to come back. Think of landing, not throwing: less effort, and a clear target in your ear.',
    steps: [
      'Hear each note in your head before you sing it, especially the high ones.',
      'Start high notes softly and lightly; extra effort is what carries you past them.',
      'Picture stepping onto the note, like setting a glass down, not jumping over it.',
      'Keep your chin level and your jaw loose on high notes; reaching up adds tension.',
      'Once you arrive, let the note sit still; there’s nothing more to reach for.',
    ],
    easier: 'Sing the leaps more softly, and use the whole pause to hear each note before you place it. If high notes feel tight, scratchy or hoarse, stop and rest.',
    practiseLevelId: 'foundations.07',
  },
  'onset.overshoot-any': {
    tip: 'You’re barely going past your notes. Keep arriving gently, like setting something down, so the pitch stops right on the note.',
    why: 'A small overshoot comes from a little too much energy at the start of a note. Hearing the note first and starting lightly lets the pitch arrive and stop.',
    steps: [
      'Hear each note in your head before you sing it.',
      'Start each note lightly, then let it settle on its own.',
      'On high notes, keep the same easy volume as on the low ones.',
    ],
    easier: 'Sing the take a little softer; gentle starts rarely go past the note.',
  },
  'onset.crisp-low': {
    tip: 'Many of your notes didn’t start cleanly. Begin each one right on the pitch with a clear, gentle start: not breathy, and not a hard click in the throat.',
    why: 'A clean start begins right on the pitch, settles at once without going past the note, and doesn’t fade in on a breath. Miss any one of those and the start doesn’t count as clean. Hearing the note first, then starting with breath and sound together, fixes most of them.',
    steps: [
      'In the pause before each note, hear it in your head.',
      'Start with breath and sound together: no puff of air before the note, and no cough-like click.',
      'Use your easy speaking volume from the very first moment; a slow fade-in reads as a breathy start.',
      'Keep each note short but not clipped, landing dead centre.',
      'Keep the same “ah” shape for every note, with your jaw loose between them.',
    ],
    easier: 'Practise single notes first: hear it, breathe, and start one clean “ah”, then rest. Once the starts feel clean, sing the full take.',
    practiseLevelId: 'foundations.02',
  },
  'onset.crisp-any': {
    tip: 'Most of your notes start cleanly. Give every note the same start: right on the pitch, clear sound, no slide.',
    why: 'The notes that slip are usually the ones you rush, or the highest ones. Treat every note the same way: hear it, then start it.',
    steps: [
      'Hear each note before it, even the repeated ones.',
      'Keep the same easy volume and the same “ah” shape for every note.',
      'Give the high notes the same calm start as the low ones.',
    ],
    easier: 'Sing a little softer and get the first note clean; the rest tend to follow.',
  },

  // ---------------------------------------------------------------- sirens and slides
  'glide.cracks': {
    tip: 'Let your voice get lighter and a little softer as you near the spot where it breaks, so it can change gears smoothly instead of snapping. Keep one unbroken sound through each slide.',
    why: 'Every voice has a place where it changes gears, from your fuller speaking voice into a lighter, higher one. If you carry the full, heavy sound up to that spot, it has to let go all at once, and it cracks. Get lighter just before you reach it, and the change happens smoothly.',
    steps: [
      'Find the marked break on the replay. It’s usually your gear change: the spot to keep light and easy.',
      'Before the take, do two slow sirens on a lip trill, lips loose and buzzing like a motorboat, right through that spot.',
      'Then do two on “ng”, like the end of “sing”, or on “oo” through a drinking straw, sliding gently through that spot.',
      'Sing the take at an easy speaking volume, chin level, and let the sound get lighter and thinner as you rise, not louder.',
      'On the way down, stay light through the same spot instead of dropping heavily into your speaking voice.',
      'Breathe only in the gaps, with a full breath before the long slides: a breath or a fade-out mid-slide counts as a break.',
    ],
    easier: 'Breaks at the gear change are normal at first, and they fade with light, easy practice. Sing the whole take on an “ng” hum at a gentle, clear volume: it carries your voice through that spot with far less effort. If your throat feels tight, scratchy or hoarse, stop and rest.',
    practiseLevelId: 'foundations.05',
  },
  'glide.cracks-any': {
    tip: 'Your slides are holding together. Keep it that way: the same light, easy sound from bottom to top, with the air flowing the whole way.',
    why: 'Breaks creep back when you get louder or heavier on the way up, or when your voice is tired. Staying light near the place where your voice changes gears keeps the switch smooth, so you never have to think about it.',
    steps: [
      'Warm up with one slow siren on a lip trill, lips loose and buzzing like a motorboat, to loosen the gear change.',
      'Keep the volume the same from the bottom of each slide to the top.',
      'Let the “oo” get a little lighter as you rise, like an owl’s hoot, rather than fuller.',
      'Breathe only in the gaps, with a calm, full breath before each long slide.',
    ],
    easier: 'If your voice feels tired, rest for a few minutes before the next take; a fresh voice slides through the gear change more easily.',
  },
  'glide.stairs': {
    tip: 'Make each slide one smooth line, like a siren or a long sigh, with no stops or dips on the way. Keep the air flowing evenly and let your voice glide past the notes in between.',
    why: 'Steps happen when your ear grabs the notes it knows on the way, so your voice stops on each one, like stairs instead of a ramp. Often the air pauses for a moment too. Steady air and an even speed, aimed only at the last note, turn the stairs into a smooth slope.',
    steps: [
      'Tap Listen and trace the demo’s slides in the air with your hand: one smooth sweep up, one smooth sweep down.',
      'Before the take, sigh out loud on “oo” from high to low, like a relieved sigh. That easy slide is the feeling you want.',
      'On the take, move your hand with your voice. Keep the hand moving, and your voice tends to follow.',
      'Follow the sloped band on the screen at its own steady pace: no rushing ahead, no waiting halfway.',
      'Keep the same easy volume all the way up and down; getting louder as you climb makes the voice catch.',
      'If it still steps, do one slow siren on a lip trill (lips loose, buzzing like a motorboat) before the next take.',
    ],
    easier: 'Between takes, practise one slow siren on a lip trill or on “ng” (the end of “sing”), only as high as feels easy, then sing the take on “oo” at that same easy volume. Slow practice is how the smooth line gets into your voice.',
    practiseLevelId: 'foundations.12',
  },
  'glide.smooth-any': {
    tip: 'Your slides are mostly smooth. Keep the speed even from start to finish, with no little pauses on the way.',
    why: 'Small pauses creep in where the voice hesitates, often near the place where it changes gears or just before the top. Even air and an even speed carry you through those spots without a stop.',
    steps: [
      'Trace each slide with your hand while you sing it, in one even sweep.',
      'Follow the sloped band at its own steady pace, neither ahead of it nor behind.',
      'Keep the air flowing at the same steady rate through the whole slide.',
      'On the replay, find the flattest spot on your slide; on the next take, keep moving through it.',
    ],
    easier: 'Sing the slides a little softer: at an easy volume the voice moves more evenly.',
  },
  'glide.end': {
    tip: 'Hear the end note in your head before you set off, then aim the whole slide at it so you arrive right on that note, on time.',
    why: 'The app checks your pitch at the moment each slide is meant to end, at the top and back at the bottom. Stopping short, going past the note, or still sliding when time runs out all count as a miss. Knowing the end note by ear gives your voice something to steer toward.',
    steps: [
      'Tap Listen, and each time the demo reaches the top, hum that note softly along with it.',
      'Hum the jumps first: the small slide is the jump between the two “twinkles” in “Twinkle, twinkle”; the big ones are “Some-where” in “Somewhere Over the Rainbow”.',
      'Follow the sloped band so you reach its end exactly as it does, not after.',
      'At the top, float onto the note lightly, as if it were easy, instead of reaching up for it.',
      'On the way down, keep the sound going until you’ve landed on the note you started on.',
      'Check the replay: the end of each slide should finish inside its band.',
    ],
    easier: 'Before the take, play the demo and sing only its end notes, softly, holding each one until it feels sure. Then sing the slides thinking only of where they land. If a top note feels tight, scratchy or hoarse, stop and rest.',
    practiseLevelId: 'foundations.02',
  },
  'glide.missing': {
    tip: 'The app couldn’t hear your slides clearly. Keep one clear, steady sound going from the start of each slide to its end, close to the mic.',
    why: 'The app can only measure a slide it can hear as a clear note. A whisper, a very breathy or very quiet sound, a long pause, or singing far from the mic leaves nothing to measure. A gentle but clear “oo”, started as soon as the count ends, fixes most of this.',
    steps: [
      'Keep the phone or mic close, in a quiet room, and sing toward it.',
      'Start singing as soon as the count ends; the first slide begins almost straight away.',
      'Use a clear “oo”, like a gentle owl’s hoot: not a whisper, and not an airy breath.',
      'Watch your line on the screen as you sing; if it keeps vanishing, sing a little more fully or move closer.',
      'Keep the sound going through each whole slide, and breathe only in the gaps between them.',
    ],
    easier: 'Sing the take on a gentle hum, “mm” or “ng”, at your normal speaking volume: a steady hum is easy for the app to follow and easy on your voice. Once your line shows up clearly, go back to “oo”.',
  },
  'glide.end-any': {
    tip: 'You’re arriving close to the end notes. Hear each one before you set off, then land right on it, on time.',
    why: 'The app checks your pitch at the moment each slide is meant to end. Hearing the end note first, and pacing the slide to reach it just in time, makes that landing exact.',
    steps: [
      'Before the take, hum the top and bottom notes softly, so they’re in your ear.',
      'Follow the sloped band so you reach its end exactly as it does.',
      'At the top, float onto the note lightly instead of reaching up for it.',
      'Let each slide finish on its note before you turn around and slide back.',
    ],
    easier: 'Listen to the demo once more and hum along with only its end notes, softly.',
  },

  // ---------------------------------------------------------------- connected lines
  'transition.smeared': {
    tip: 'Keep one connected line of sound, but change each note quickly and cleanly, like stepping from stone to stone, instead of sliding between them.',
    why: 'Notes blur when the voice slides from one to the next, goes past the new note, or wobbles before it settles, so each one arrives late. A connected line comes from steady air, not from sliding. Keep the air and the vowel steady, and let only the pitch change, quickly.',
    steps: [
      'Tap Listen and notice how each piano note changes in an instant while the line keeps flowing.',
      'Before the take, sing the line once on “dah, dah, dah”, then sing it on “ah” with the same clean changes.',
      'Hear each next note in your head just before you move to it.',
      'Move to each new note right on its click, quickly, then sit still on it until the next click.',
      'Keep the sound going between notes; a gap or a breath counts as a slow change.',
      'Aim at the middle of each new note, not past it, especially on the steps up.',
    ],
    easier: 'Sing just the first few notes on your own, slowly and softly, until each change feels clean, then add the rest. A softer sound makes quick, clean changes easier.',
    practiseLevelId: 'foundations.10',
  },
  'transition.any': {
    tip: 'Most of your note changes are clean. Keep the line connected, and let each note arrive cleanly before the next.',
    why: 'The changes that slip are usually where your attention drifts, often on the way back down or as your breath runs low. Steady air, and hearing each note just before you move, keep every change clean.',
    steps: [
      'Keep the “ah” the same shape on every note, so only the pitch changes.',
      'Change notes right on the click, then hold each one still.',
      'On the way down, think each note a little higher; falling notes tend to land low.',
      'Take a full, easy breath before the line, so you have air left for the last notes.',
    ],
    easier: 'Sing the line a little softer; quick, clean changes are easier at an easy volume.',
  },
};
