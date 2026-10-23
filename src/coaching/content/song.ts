/**
 * Coaching ladders for song tip ids (src/coaching/song-tips.ts): prefix song. (src/coaching/types.ts CoachLadder; plain
 * words for someone relearning to sing, owner 2026-10-22: "I'd love to be able to practice on a song and get better at
 * it"). The song coach (src/coaching/song.ts) names one of these as a song take's main problem, located by syllable and
 * time, and the help deepens with each miss in a row on the same phrases.
 *
 * What the words stand on (song takes are scored by analysis/phrases.ts, so nothing promises a reading the app cannot make):
 *  - Pitch is scored note by note against the song in the key and at the speed it was sung, ignoring octaves: a tune
 *    sung an octave up or down is not an error, so song.off-notes is a really different note, never an octave away.
 *  - Each note scores for the time it is actually sung, so a skipped word scores nothing and a word cut short scores
 *    part of it (song.unsung, song.breath).
 *  - Timing is the singer's own, with the phone's delay taken out (song.late, song.early); notes of about three quarters
 *    of a second or longer are measured for steadiness (song.unsteady).
 *  - song.high and song.low are the phrase's own highest and lowest notes; song.leap is a big jump, named by its two
 *    syllables; song.cracks a break on a note; song.polish a passed take; song.join the seam between two phrases.
 *
 * The method is how a returning singer learns a real song: the words on their own, the rhythm spoken, the tune on one
 * vowel, the breaths planned, slowed down, sung along with the melody and then alone, and heard back. The steps use only
 * what the song player has (DESIGN.md §13.9): Listen, Play and the loop button, the speed (50 / 75 / 100%), the Key row
 * with "Fits your range", the bars and the singer's line, the amber underline walking the words, the count-in, More ›
 * Melody guide while singing (heard during takes in headphones only) and Metronome, and Play take after a take (only
 * with Settings › Keep take audio on).
 *
 * practiseLevelId names the Foundations level that builds the skill; the coach offers it only once that level is passed:
 * Match one note for the tune, Hold it for breath, Hold it steady for long notes, Sirens for the top and bottom of the
 * range and the gear change, Clean starts for the beat, Bigger jumps for big jumps, Five notes in a row for joining
 * phrases.
 */
import type { SongTipId } from '../song-tips';
import type { CoachLadder } from '../types';

export const LADDERS_SONG: Readonly<Record<string, CoachLadder>> = {
  // ---------------------------------------------------------------- where the phrase sits (overall)
  'song.flat': {
    tip: 'Brighten your vowels and keep the air moving to the end of every word, so the notes sit up on the tune instead of just under it.',
    why:
      'A whole phrase sits flat when the energy drops: the breath slows, the vowels turn dark or heavy, and every note settles just under the tune. ' +
      'It’s common while your mind is on the words, when you sing very quietly, or when you’re tired. ' +
      'The one thing to change: a steady flow of air and bright, lifted vowels from the first word to the last.',
    steps: [
      'Tap Listen and hum the phrase quietly along with the melody, matching each note.',
      'Stand tall and take a low, easy breath before the phrase starts.',
      'Sing it once on one bright vowel, like “ee”, with your cheeks lifted as if starting to smile, then put the words back just as bright.',
      'Keep the air flowing to the end of each word, the last word of the phrase most of all.',
      'Watch your line: if it runs along the bottom of the bars, lift it gently to their middle.',
      'Turn on Keep take audio in Settings, then listen back with Play take after the take: hearing the sag helps you feel the fix.',
    ],
    easier:
      'Sing along with the melody at 75% (in headphones, with Melody guide while singing on in More), matching it note for note, then sing it alone. ' +
      'If your voice is tired, rest a few minutes first: tired voices tend to sing flat.',
    practiseLevelId: 'foundations.02',
  },
  'song.sharp': {
    tip: 'Ease off a little so each note settles onto the tune instead of just above it: loosen your jaw and use less breath pressure.',
    why:
      'A whole phrase sits sharp when the effort runs high: a tight jaw or throat, or more breath than the notes need, and the pitch rides up with it. ' +
      'It shows most on loud or high words, and in the parts of a song you feel most. ' +
      'The one thing to change: less effort, so every note can sit where it belongs.',
    steps: [
      'Before the phrase, let your jaw hang loose and your shoulders drop, then take an easy, low breath.',
      'Tap Listen and hum along softly, following the melody rather than leading it.',
      'Sing the phrase a little softer than feels natural, at an easy medium volume.',
      'Use only as much breath as each word needs; extra air drives the pitch up.',
      'Watch your line: if it rides along the top of the bars, relax until it sits on their middle.',
      'Turn on Keep take audio in Settings, then listen back with Play take to hear where it rises.',
    ],
    easier:
      'Sing the phrase on a gentle “oo”, with no words, until it settles on the tune, then add the words at the same easy volume. ' +
      'If anything feels tight or scratchy, stop and rest before you go on.',
    practiseLevelId: 'foundations.02',
  },

  // ---------------------------------------------------------------- the tune itself
  // The coach names the syllables that went to a different note (octaves are never counted as wrong in a song).
  'song.off-notes': {
    tip: 'Learn the tune of the words named above on its own: listen to it slowly and hum along until you can hear each note before you sing it.',
    why:
      'When a word lands on a different note, the tune usually isn’t fixed in your ear yet, so your voice guesses, often following where the last line went or how another song goes. ' +
      'Thinking about the words at the same time makes it slip more. ' +
      'The one thing to change: learn the tune on its own first, then put the words back on it.',
    steps: [
      'Set the speed to 75%, then tap Listen and follow the words on the screen as the tune plays.',
      'Tap the loop button so it stays on, then tap Play and hum along softly each time round until the tune feels sure.',
      'Sing the phrase on one vowel, like “oo”, with no words, watching your line land in each bar.',
      'Put the words back and sing it slowly, giving the words named above extra care.',
      'Once it’s right at 75%, sing it again at 100%.',
    ],
    easier:
      'In headphones, sing a take at 75% with Melody guide while singing on (in More), so the tune plays along with you; on the speaker, sing along with Play and the loop button instead. ' +
      'Then sing it alone, without the guide.',
    practiseLevelId: 'foundations.02',
  },
  // A big jump between two notes, named by its two syllables.
  'song.leap': {
    tip: 'Hear the landing note in your head before you leave the first one, then arrive on it in one clean move instead of sliding to find it.',
    why:
      'A big jump misses when the voice sets off before the ear has the landing note, so it falls short or goes past and then slides to correct. ' +
      'Jumps up tend to land low, and jumps down tend to land heavy and flat. ' +
      'The one thing to change: know the landing note first, then go straight to it.',
    steps: [
      'Tap Listen and hum just the two notes of the jump named above, softly, along with the melody.',
      'Sing those two notes on “oo”, with no words, slowly, until the jump feels sure.',
      'Before each try, take a moment to hear the landing note in your head.',
      'On a jump up, float onto the top note lightly instead of reaching up for it.',
      'On a jump down, keep the low note bright and light instead of dropping heavily onto it.',
      'Put the words back at 75% speed, then sing it at 100%.',
    ],
    easier:
      'Practise the jump as a slow slide first: glide from the first note to the second on “oo”, then make the glide quicker each time until it becomes a clean jump. ' +
      'Stop and rest if anything feels tight or scratchy.',
    practiseLevelId: 'foundations.08',
  },

  // ---------------------------------------------------------------- the top and bottom of the phrase
  'song.high': {
    tip: 'Let the highest notes get lighter, not louder: float onto them with the air flowing. If they still feel hard, move the key down a little.',
    why:
      'High notes go flat, tight or break when you carry your full, heavy speaking voice up to them and work harder the higher you go. ' +
      'A voice needs to get lighter as it rises, and a song set too high for you makes that much harder. ' +
      'The one thing to change: lighter and easier on the way up, in a key that fits.',
    steps: [
      'Check the Key row: if it says notes sit outside your range, tap Fits your range, or the minus button to move the song lower.',
      'Before the take, do two slow sirens on a lip trill (lips buzzing like a motorboat), up past the highest note.',
      'Sing the phrase on “oo” first, letting the sound get lighter and thinner as it rises.',
      'Take a full, low breath before the phrase, so the high notes have air under them.',
      'Keep your chin level and your jaw loose on the high notes, rather than reaching up with your head.',
      'Never strain for a high note: if one takes effort, sing it lighter or move the key down.',
    ],
    easier:
      'Set the speed to 75% and sing the high words on a gentle “oo” or a lip trill first, then add the words at the same light volume. ' +
      'If your throat feels tight, scratchy or hoarse, stop and rest.',
    practiseLevelId: 'foundations.05',
  },
  'song.low': {
    tip: 'Sing the lowest notes in your relaxed, clear speaking voice, with the air still moving, so they don’t fade or turn breathy.',
    why:
      'Low notes fade when the air runs out at the end of a line, or when the chin tucks down and the sound goes dark and airy. ' +
      'They need a clear, easy tone, like talking on the note, not extra weight. ' +
      'The one thing to change: a clear sound and moving air all the way down, in a key that fits.',
    steps: [
      'Check the Key row: if it says notes sit outside your range, tap Fits your range, or the plus button to move the song higher while the top stays easy.',
      'Hum the low notes softly on “mm”, then say their words on those notes in your normal talking voice.',
      'Keep your chin level; tucking it down squeezes the low notes and makes them breathy.',
      'Save some air for the low notes at the end of the phrase, and keep it flowing through them.',
      'Sing them at an easy speaking volume, not a whisper, so they come through clearly.',
    ],
    easier:
      'Sing the phrase on a hum, “mm”, at your normal speaking volume: a hum keeps the low notes clear and easy. ' +
      'Then open to the words at the same volume.',
    practiseLevelId: 'foundations.05',
  },

  // ---------------------------------------------------------------- the beat
  'song.late': {
    tip: 'Come in with the beat, not after it: have your breath in and the next word ready, and start each word as the amber underline reaches it.',
    why:
      'Words come in late when the breath or the words aren’t ready: you breathe on the beat instead of before it, or you’re still finding the next word. ' +
      'The first sound of a word, like the “s” in “sing”, also takes a moment, so the note itself starts after the beat. ' +
      'The one thing to change: be ready before the beat, and start that first sound a touch early so the vowel lands on time.',
    steps: [
      'Say the words of the phrase out loud until you know them without looking.',
      'Tap Listen and speak the words in rhythm along with it, with no tune.',
      'Breathe in the gap before the phrase, so you’re ready when the count-in ends.',
      'Start the first sound of each word a touch early, so its vowel lands right on the beat.',
      'Sing each word as the amber underline reaches it, not after.',
      'Sing it at 75% until you’re on time, then at 100%.',
    ],
    easier:
      'Turn on the Metronome in More and sing the phrase at 75%, tapping the beat with your hand, until each word lands with the click. ' +
      'Then go back to full speed with the same feel.',
    practiseLevelId: 'foundations.06',
  },
  'song.early': {
    tip: 'Let the beat lead: give each note its full length and wait for the next word’s moment instead of moving on early.',
    why:
      'Rushing usually comes from nerves, or from knowing the tune well: you move on before a word has had its full time, so the next one starts ahead of its beat. ' +
      'It shows most after short rests and on long held words. ' +
      'The one thing to change: give every note its full length, and let the beat bring in the next one.',
    steps: [
      'Turn on the Metronome in More, and tap the beat with your foot or finger before you start.',
      'Tap Listen and speak the words in rhythm with it, holding long words for their whole length.',
      'Hold each long note right to the end of its bar before you move on.',
      'In the gaps, breathe calmly and wait; a hurried breath makes the next words start early.',
      'Sing each word as the amber underline reaches it, not before.',
    ],
    easier:
      'Sing the phrase at 75% with the Metronome on, keeping a steady tap with your hand, until each word lands with the click. ' +
      'Then go back to full speed with the same calm feel.',
    practiseLevelId: 'foundations.06',
  },

  // ---------------------------------------------------------------- air and the voice itself
  'song.breath': {
    tip: 'Plan your breaths: breathe low and easy before the phrase, decide where the next breath goes, and keep the sound going until you get there.',
    why:
      'The sound drops out when the air runs short before the end of a line, or when a breath is snatched in the middle of a word or a held note. ' +
      'Shallow breaths, and spending a lot of air on the first words, make it happen sooner. ' +
      'The one thing to change: breathe low, spend the air slowly, and breathe only where you planned to.',
    steps: [
      'Read the words and choose your breath spots, usually at a comma or the end of a line.',
      'Speak the phrase in rhythm with those breaths, so they become part of it.',
      'Before the phrase, breathe in low and slow, letting your belly and lower ribs widen.',
      'Start at a volume you could keep up for longer than the phrase; loud first words use up the air.',
      'Keep your ribs wide as you sing, and let the air out slowly, like a thin stream.',
      'If you can’t reach a breath spot, add a quick breath earlier, between two words, never in the middle of one.',
    ],
    easier:
      'Sing the phrase on a lip trill (lips buzzing like a motorboat): the buzz stops as soon as the air runs short, so you feel where to save it. ' +
      'Keep the speed at 100% for this one, since a slowed phrase needs more air. ' +
      'Stop if you feel light-headed or anything hurts.',
    practiseLevelId: 'foundations.03',
  },
  'song.cracks': {
    tip: 'Let your voice get lighter just before the word where it broke, so it can change gears smoothly instead of snapping, and keep the air flowing through it.',
    why:
      'Every voice has a place where it changes gears, from your fuller speaking voice into a lighter, higher one, and songs often cross it in the middle of a word. ' +
      'Carry the full, heavy sound up to that spot and the voice lets go all at once, which is the crack; get lighter just before it and the change happens smoothly. ' +
      'Cracks are normal for a returning singer, and they fade with light, easy practice.',
    steps: [
      'Sing the notes around the word named above on a lip trill (lips buzzing like a motorboat), slowly and gently.',
      'Then slide through the same notes on “ng”, like the end of “sing”, keeping the sound light.',
      'Sing the phrase on “oo”, letting the sound get lighter and thinner as you reach that word, not louder.',
      'Put the words back at 75% speed, with the same light sound through that word.',
      'Keep your chin level and the air flowing; a snatched breath right before the word makes a break more likely.',
      'If it breaks on the highest note, try the key a little lower with the minus button in the Key row.',
    ],
    easier:
      'Sing the whole phrase on an “ng” hum at a gentle volume, then on “oo”, then with the words: each one carries your voice through the gear change with less effort. ' +
      'If your throat feels tight, scratchy or hoarse, stop and rest.',
    practiseLevelId: 'foundations.05',
  },
  'song.unsteady': {
    tip: 'Hold each long note on one steady stream of air, keeping the vowel the same right to its end, so the note stays level instead of wavering or sinking.',
    why:
      'Long notes waver when the air comes out unevenly or the jaw and tongue move during the hold, and they sink as the breath runs low near the end. ' +
      'In a song it often happens on the last word of a line, while your mind moves on to the next one. ' +
      'The one thing to change: plan the air for the whole note, and keep everything still until it ends.',
    steps: [
      'Find the long notes in the phrase: they’re the longest bars on the screen.',
      'Take a low, easy breath before the phrase, so there’s air left for the last long note.',
      'On each long word, hold the vowel and keep its shape still, saving the word’s last sound for the very end.',
      'Let the air out evenly, as if through a thin straw, right to the end of the note.',
      'Near the end of each long note, think of it lifting slightly, so it doesn’t sink as the air runs low.',
      'Watch your line on the long bars and keep it flat, like drawing along a ruler.',
    ],
    easier:
      'Hold the phrase’s longest note on its own first: hum it through a drinking straw, or on a lip trill, for as long as its bar lasts, then sing it on its word. ' +
      'Sing a little softer; a gentle, medium-soft tone is the easiest to keep level.',
    practiseLevelId: 'foundations.13',
  },

  // ---------------------------------------------------------------- getting through it
  // Each note scores for the time it is sung, so skipped and cut-short words cost; the located problem says which.
  'song.unsung': {
    tip: 'Keep singing through the whole phrase, word after word, at a clear volume: a wrong note costs far less than a skipped one.',
    why:
      'Each note scores for the time you spend singing it, so a skipped word scores nothing and a word cut short scores only part. ' +
      'The usual causes are not knowing the words yet, losing your place, stopping after a slip, or running short of air. ' +
      'The one thing to change: know the words well, and keep going whatever happens.',
    steps: [
      'Learn the words on their own: say the phrase out loud, like reading a poem, until you can say it without looking.',
      'Tap Listen and speak the words in rhythm along with it, with no tune.',
      'During the take, sing each word as the amber underline reaches it.',
      'If you slip, keep going: come back in on the next word instead of stopping.',
      'Sing every word for its full length, at a clear, medium volume, so each note comes through.',
    ],
    easier:
      'Sing the next take softly on “la”, with no words, just to get through every note from start to finish. ' +
      'Then put the words back, at 75% speed if they still trip you up.',
  },

  // ---------------------------------------------------------------- after a pass, and phrases joined
  // A passed take: the coach shows only the tip, so it names the next step without claiming which one this take reached.
  'song.polish': {
    tip: 'You’ve got this one. Sing it once more the same easy way, then take the next step: full speed if you slowed it down, the next phrase, or joining phrases together.',
    why:
      'Nothing in this take cost you much. ' +
      'Repeating what you’ve got is how it becomes automatic, so it holds up when the phrases join into the whole song. ' +
      'The one thing to keep: the same relaxed way of singing as you speed up and join phrases.',
    steps: [
      'If you sang it slowed down, set the speed to 100% and sing it again.',
      'Then move to the next phrase and learn it the same way: listen, slowly, then full speed.',
      'Once two phrases in a row pass, sing them together, so the breath between them becomes part of the line.',
      'Sing a take with Melody guide while singing off (in More), so you know the tune on your own.',
      'Turn on Keep take audio in Settings and listen back with Play take, to hear how far you’ve come.',
    ],
    easier: 'There’s nothing to fix here. If you’re tired, stop on this good take: rest, sip some water, and pick up from here next time.',
  },
  // Two phrases sung as one take: the seam between them.
  'song.join': {
    tip: 'Take a quick, quiet breath at the end of the first phrase and come straight in on the second, so the two sound like one line.',
    why:
      'When two phrases run together, the gap between them is short. ' +
      'A breath that comes late or takes too long makes the second phrase start late, and cutting the first phrase short to make room loses its last word. ' +
      'The one thing to change: plan the breath, keep it quick and low, and go straight on.',
    steps: [
      'Tap Listen and notice how short the gap between the two phrases is.',
      'Speak the end of the first phrase and the start of the second in rhythm, with a quick breath between them.',
      'Sing the last word of the first phrase for its full length, then breathe in quickly through an open mouth.',
      'Let the breath drop low, into your belly, rather than lifting your shoulders, so it’s quick and quiet.',
      'Come in on the first word of the second phrase right on time, as the amber underline reaches it.',
      'Sing the pair at 75% until the change feels easy, then at 100%.',
    ],
    easier:
      'Practise only the seam: sing the last few words of the first phrase and the first few of the second, slowly, until the breath between them feels easy. ' +
      'Then sing both phrases whole.',
    practiseLevelId: 'foundations.09',
  },
} satisfies Record<SongTipId, CoachLadder>;
