/**
 * Coaching ladders for tip ids starting with: vib. pulse. (exercises/tips.ts COACHING_TIPS, the Vibrato world).
 *
 * The pedagogy, for a singer relearning to sing: vibrato comes from relaxation and steady breath, never from making a
 * wobble; pulses ("ha-ha-ha") build toward it; a straight tone is never a fault; a bloom lets the wobble arrive late on
 * the note (here, right on the cue). The words stay true to what the analyzers measure:
 *  - vibrato counts only as at least two even cycles that swing at least CONFIG.vibrato.straightBelowExtentCents (a
 *    tiny shimmer reads as straight); the zone is the style's rate and extent, drawn on the Sing screen as two shaded
 *    strips above and below the note (PitchView.setVibratoZone); the demo sways at the zone's midpoint; a natural
 *    speed-up across a long note is allowed (CONFIG.vibrato.rateRampAllowance);
 *  - pulses are pitch bumps on one continuous sound (analysis/pulse.ts): a stop or a breathy "h" splits the train and
 *    loudness alone is no pulse; pulse.regularity is how evenly they are spaced in time. The oscillation drills
 *    (vibrato.01-02) share these tips, so the words say "pulses (or note changes)" where it matters;
 *  - a switch is clean within a moment of its cue and without a break in the sound, and a bloom scores fully within a
 *    quarter second of the cue (analysis/switch.ts). Every level with switch or bloom cues has the clicks on; the
 *    Vibrato meter (open with the world) shows Rate/Extent/Centring live over its last 2.5 s.
 * Plain words throughout (src/coaching/types.ts CoachLadder). practiseLevelId is the earlier level that builds the
 * skill; the pulse tips are shared by vibrato.01-05 and vib.switch is used on vibrato.07 itself, so it can name the
 * level being sung, which the coach should not offer.
 */
import type { CoachLadder } from '../types';

export const LADDERS_VIBRATO: Readonly<Record<string, CoachLadder>> = {
  // ---------------------------------------------------------------- vibrato: there at all, speed and width
  'vib.none': {
    tip: 'Let the note sway on its own: keep the air flowing, loosen your jaw and throat, and let a gentle wobble come in once the note feels steady. It comes from letting go, never from shaking the note.',
    why: 'Vibrato is the natural, even sway a free voice makes on a held note, and it appears when the breath is steady and nothing holds the sound still. A straight tone is not a fault, but this level listens for at least two even swings in a row, and a tiny shimmer still counts as straight. The one thing to change: stop holding the note still, and let it move.',
    steps: [
      'Listen to the demo and notice how its note sways evenly up and down once it has started.',
      'Before the take, do a gentle lip trill (lips buzzing like a motorboat) on a comfortable note for a few seconds.',
      'Sing at a comfortable medium volume; a very soft or very careful sound tends to stay straight.',
      'Start each note steady, then relax your jaw and tongue and let the sway arrive a moment later.',
      'If nothing comes, sing slow “ha-ha-ha” bumps on the note without stopping the sound, speed them up, then let go.',
      'Keep the air moving to the end of each note; the sway rides on steady breath.',
    ],
    easier: 'Warm up on an “ng” hum (as at the end of “sing”) or a lip trill, where the sway often comes more easily, then open to “ah”. Let it come late in the note; it doesn’t have to start at once. If anything hurts, scratches or goes hoarse, stop and rest.',
    practiseLevelId: 'vibrato.05',
  },
  'vib.slow': {
    tip: 'Lighten the sound a little and let the wobble get quicker and smaller, like the demo’s.',
    why: 'A slow, wide sway usually comes from a heavy or tired sound, so each swing has more weight to carry. A natural vibrato runs at about six wobbles a second in every style. The one thing to change: a lighter, brighter sound, so the sway can speed up by itself.',
    steps: [
      'Listen to the demo and notice how quick and small its sway is; it sits at the speed you are aiming for.',
      'Sing a little softer than last time, closer to your speaking volume.',
      'Use a bright, forward “ah”, with a hint of a smile, so the sound stays light.',
      'Keep the air flowing evenly; don’t let the note get heavier as it goes on.',
      'Think of the sway as a quick shimmer on the note rather than a slow wave.',
    ],
    easier: 'Before the take, sing a few “ha-ha-ha” pulses on one note and let them speed up until they blur, then sing with that quicker feeling. A slow wobble can also mean a tired voice, so rest first. If anything hurts, scratches or goes hoarse, stop for today.',
    practiseLevelId: 'vibrato.05',
  },
  'vib.fast': {
    tip: 'Release the tightness in your throat, jaw and tongue, and let the wobble slow down on its own.',
    why: 'A very fast, fluttery wobble usually comes from tension around the throat or from squeezing the air out too hard. A free voice sways at about six wobbles a second, so the speed settles once the tension goes. The one thing to change: less effort, with an easy, steady flow of air.',
    steps: [
      'Before the take, sigh gently from a high note down to a low one on “ah” to loosen your throat.',
      'Let your jaw hang loose and rest the tip of your tongue behind your bottom front teeth.',
      'Sing a little softer than last time, with an easy flow of air and no squeeze.',
      'Listen to the demo and copy its calm, even speed.',
      'Don’t try to make the wobble; hold the note loosely and let the sway find its own pace.',
    ],
    easier: 'Sing through a drinking straw for a few seconds before the take to ease the effort, then sing the take softly. A gentle yawn before you start also opens the throat. If your throat feels tight, scratchy or hoarse, stop and rest.',
    practiseLevelId: 'vibrato.05',
  },
  'vib.wide': {
    tip: 'Make the wobble smaller: sing a little lighter and keep each swing close to the note, inside the shaded strips.',
    why: 'A very wide sway usually comes from a heavy sound or from making the wobble on purpose, so each swing travels too far from the note. A tired voice can do it too. The one thing to change: a lighter sound on steady air, letting the sway happen instead of making it.',
    steps: [
      'Listen to the demo and notice how little its pitch moves: a gentle shimmer around the note.',
      'Sing a little softer than last time; less weight means a smaller swing.',
      'Keep the breath steady and let the sway happen by itself; don’t make each swing.',
      'Watch the shaded strips above and below the note, and keep the tips of each wobble inside them.',
      'Keep your jaw and tongue still; check in a mirror that only the sound sways.',
    ],
    easier: 'Sing the next take softer, at about speaking volume, and think of a small shimmer rather than a swing. If your voice feels tired, rest first, since a wide wobble can be a sign it needs a break. If anything hurts, scratches or goes hoarse, stop for today.',
    practiseLevelId: 'foundations.13',
  },
  'vib.narrow': {
    tip: 'Let the wobble swing a little wider by relaxing, so the tips of each swing reach into the shaded strips.',
    why: 'A very small wobble usually means something is still holding the voice in place, often the jaw, the tongue or a very careful, quiet sound. The sway is there, but it can’t open up. The one thing to change: loosen up and give the note a little more easy air, so the sway grows by itself.',
    steps: [
      'Listen to the demo and notice how far its sway reaches above and below the note.',
      'Sing at a comfortable medium volume rather than softly.',
      'Let your jaw drop loose and keep your tongue soft and forward.',
      'Watch the shaded strips and let the tips of each wobble reach into them, not past them.',
      'Keep the air moving through the whole note so the sway has the energy to swing.',
    ],
    easier: 'Before the take, slide slowly between your note and the next note up a few times, then let it quicken into a small wobble and keep that size. Never strain for a bigger swing. If it feels tight or scratchy, rest and try again later.',
    practiseLevelId: 'vibrato.02',
  },
  'vib.zone': {
    tip: 'Copy the demo’s wobble: the same easy speed and the same size, with the tips of each swing landing in the shaded strips.',
    why: 'This level listens for a wobble at about six a second whose swings reach into the shaded strips, not past them and not short of them. Yours missed it on at least half the notes, by speed, by size, or by not swaying at all. The one thing to change: match the demo, which sways right in the middle of your target.',
    steps: [
      'Listen to the demo twice: once for the speed of the sway, once for its size.',
      'Sing along very quietly with the demo once, matching its sway, before you sing the take.',
      'If your wobble felt slow or wide, sing a little lighter; if it felt quick or tight, relax your jaw and throat.',
      'During the take, glance at the shaded strips: the tips of each wobble belong inside them.',
      'Keep the breath steady so the sway keeps the same speed and size to the end of the note.',
    ],
    easier: 'Open the Vibrato meter from Home and sing one long, comfortable note: the Rate and Extent readings show a check mark when you are in the zone. Find that feeling there, then come back to this level.',
    practiseLevelId: 'vibrato.05',
  },
  'vib.zone-any': {
    tip: 'Your wobble is in the zone on most notes. Keep it there on every note, from the start to the end.',
    why: 'On the notes that slipped, the sway ran a little too quick, slow, wide or narrow, or never got going. Small slips usually follow small changes in breath or effort from note to note. The one thing to change: give every note the same easy breath and the same relaxed sound.',
    steps: [
      'Listen to the demo once more and keep its speed and size in your ear.',
      'Take the same calm breath before every note, so each one starts the same way.',
      'Give the higher notes the same light, easy sound as the lower ones.',
      'Glance at the shaded strips and keep the tips of each wobble inside them.',
    ],
    easier: 'Sing the next take a little softer and stay relaxed on the higher notes. Rest between takes so your voice stays fresh.',
  },

  // ---------------------------------------------------------------- vibrato: evenness
  'vib.irregular': {
    tip: 'Keep the air steady and let the wobble run by itself, at one even speed and size, without steering each swing.',
    why: 'An uneven wobble usually comes from breath that arrives in bursts, or from making each swing with the throat or jaw. A natural vibrato runs by itself on steady air, so every swing matches the one before (it may quicken a little toward the end of a long note, which is fine). The one thing to change: smooth, steady breath, and let the wobble run without help.',
    steps: [
      'Stand tall with loose shoulders and take a full, easy breath before each note.',
      'Let the air flow out at the same gentle rate through the whole note, like a long, slow sigh.',
      'Check in a mirror: your jaw and tongue should stay still while the sound sways.',
      'Listen to the demo and notice that every swing matches the one before it.',
      'If the sway keeps changing, sing a little softer and let it settle into its own rhythm.',
    ],
    easier: 'Practise even “ha-ha-ha” pulses on one note first, then let them speed up into a wobble while you keep them even. Singing through a straw for a few seconds before the take also steadies the air. Rest if your voice feels tired, and stop if anything hurts, scratches or goes hoarse.',
    practiseLevelId: 'vibrato.04',
  },
  'vib.regularity-any': {
    tip: 'Your wobble is fairly even. Let it settle into one speed and one size, and let steady air do the work.',
    why: 'Small changes in the sway usually follow small changes in the breath. The steadier the air, the more even the wobble. The one thing to change: keep the breath flowing at the same gentle rate to the very end of each note.',
    steps: [
      'Breathe in calmly before each note, so the start of the note isn’t rushed.',
      'Keep the air flowing evenly to the very end of each note.',
      'Keep your jaw and tongue still; let the sound sway, not your mouth.',
      'Picture the wobble as a steady ripple, every swing the same as the last.',
    ],
    easier: 'Sing the next take a little softer and stay relaxed. Rest between takes so your voice stays fresh.',
    practiseLevelId: 'vibrato.04',
  },

  // ---------------------------------------------------------------- vibrato: centred on the note
  'vib.centre-flat': {
    tip: 'Let the wobble swing evenly above and below the note: think the note a hair higher and keep the breath moving to the end.',
    why: 'When the sway hangs below the note, the middle of the sound sits flat even if the top of each swing touches the note. It often happens when the breath fades or the sound turns heavy and dark. The one thing to change: aim the middle of the wobble at the note, with steady air behind it.',
    steps: [
      'Listen to the demo’s first note, then hum it quietly to fix the pitch in your ear.',
      'Find the pitch first, then let the wobble open around it.',
      'Picture the note as a line and let the wobble cross it evenly, as far above as below.',
      'Use a slightly brighter “ah”, with a hint of a smile, so the sound doesn’t sink.',
      'Keep the air flowing to the very end of each note; the pitch sinks as the air runs low.',
    ],
    easier: 'Practise on the Vibrato meter (on Home): hold one note and keep the Centring number close to zero. Then sing the take softly, with the same feeling. Rest first if your voice feels tired.',
    practiseLevelId: 'foundations.03',
  },
  'vib.centre-sharp': {
    tip: 'Let the wobble swing below the note as well as above it, and ease the breath a little so the note floats.',
    why: 'When the sway rides above the note, the middle of the sound sits sharp. It often comes from reaching up for the note or from blowing harder as the wobble starts. The one thing to change: let the bottom of each swing dip below the note, on relaxed, steady air.',
    steps: [
      'Listen to the demo and hum the first note quietly to fix it in your ear.',
      'Find the pitch first, then let the wobble open around it, not above it.',
      'Ease the breath a little as the wobble starts; let the note float rather than climb.',
      'Keep your chin level and your neck long; reaching up with your head tends to lift the pitch.',
      'Picture the wobble crossing the note evenly, as far below as above.',
    ],
    easier: 'Practise on the Vibrato meter (on Home): hold one note and keep the Centring number close to zero. Then sing the take a little softer, with the same easy feeling.',
    practiseLevelId: 'foundations.03',
  },
  'vib.centre': {
    tip: 'Centre the wobble on the note: find the pitch first, then let it swing as far above the note as below.',
    why: 'The middle of your sway landed off the note. That usually means the pitch under the wobble wasn’t settled before the sway began. The one thing to change: find the note first, then let the wobble open evenly around it.',
    steps: [
      'Listen to the demo and hum the first note quietly to set it in your ear.',
      'Start each note on the pitch, then let the wobble open once the note has settled.',
      'Picture the wobble crossing the note evenly, as far above as below.',
      'Keep the breath steady to the end, so the middle of the sway neither sinks nor climbs.',
    ],
    easier: 'Practise on the Vibrato meter (on Home): hold one note and keep the Centring number close to zero. Then come back and sing the take with that feeling.',
    practiseLevelId: 'foundations.03',
  },
  'vib.centre-any': {
    tip: 'Your wobble is close to the note. Keep it centred, swinging as far above the note as below it.',
    why: 'Small slips usually come from a pitch that isn’t settled before the sway begins, or from breath that fades near the end. The one thing to change: find the note before the wobble begins, and keep the air steady to the end.',
    steps: [
      'Hum the first note quietly before the take to set it in your ear.',
      'Let the wobble open only once the note has settled.',
      'Keep the breath flowing steadily right to the end of each note.',
    ],
    easier: 'Practise on the Vibrato meter (on Home) and keep the Centring number close to zero for a whole long note. Rest between takes so your voice stays fresh.',
    practiseLevelId: 'foundations.03',
  },

  // ---------------------------------------------------------------- switching and bloom, on the cue
  'vib.switch': {
    tip: 'Change only the wobble, right on each cue, and keep the sound going. On “Straight”, still it at once; on “Bloom” or “Vibrato on”, let it start at once.',
    why: 'A clean switch lands within a moment of the cue, with no break in the sound. Switches go blurry when the wobble carries on into the straight part, starts early or late, or when the note stops and starts again. The one thing to change: keep the breath flowing through each change, and change nothing but the wobble.',
    steps: [
      'Listen to the demo and notice that the sound never stops; only the wobble turns on and off.',
      'Count the clicks in each part, so you know when the next cue is coming.',
      'On “Straight”, hold the note as still as an organ note; on “Bloom” or “Vibrato on”, relax and let it sway.',
      'Keep the air flowing right through each change; don’t stop or restart the note.',
      'Before the take, practise one slow switch in your own time: four counts still, four counts swaying, four counts still.',
    ],
    easier: 'On the Vibrato meter (on Home), sing one long, comfortable note and switch between still and swaying in your own time. The meter shows “Straight tone” a couple of seconds after the wobble stops, so hold each part a little longer there. When you can switch both ways easily, come back to this level.',
    practiseLevelId: 'vibrato.07',
  },
  'vib.switch-any': {
    tip: 'Your switches are mostly clean. Make each one land right on the cue, with no break in the sound.',
    why: 'The last few switches usually slip because the change comes a little late or the note restarts. The one thing to change: count the clicks so you are ready for each cue, and keep the breath flowing through it.',
    steps: [
      'Count the clicks in each part, so every cue arrives when you expect it.',
      'Keep the breath flowing through every change; the note should never stop.',
      'On “Straight”, still the wobble at once; on “Bloom” or “Vibrato on”, let it start at once.',
    ],
    easier: 'Listen to the demo again just before you sing and copy the timing of each change. Rest between takes so your voice stays fresh.',
    practiseLevelId: 'vibrato.07',
  },
  'vib.bloom': {
    tip: 'Keep the start of the note completely straight, then let the wobble open as soon as “Bloom” appears.',
    why: 'A bloom is a straight start that opens into a wobble later in the note, and here it should open right on the cue. Blooms miss when the wobble creeps in early, arrives a second or more late, or never comes. The one thing to change: hold the note still until the cue, then simply let go.',
    steps: [
      'Listen to the demo and notice the still start and the wobble opening right on the cue.',
      'Count the clicks during the straight part, so you know exactly when the cue comes.',
      'Hold the straight part like an organ note: steady air, still jaw, no sway.',
      'On the cue, relax your jaw and throat and let the sway start fully, rather than letting it creep in.',
      'Keep the breath flowing through the change; the note shouldn’t stop.',
    ],
    easier: 'First practise a bloom in your own time on one long, comfortable note: straight for a few seconds, then let the wobble come. When it comes easily, try it on the cue. If the wobble won’t come at all, rest and try again later, since it can’t be made to happen.',
    practiseLevelId: 'vibrato.06',
  },
  'vib.bloom-any': {
    tip: 'Your blooms are close to the cue. Hold the straight tone right up to it, then let the wobble open on the same pitch.',
    why: 'The last bit of timing comes from being ready for the cue: a wobble that starts a little early or late costs points. The one thing to change: count the clicks so the release lands right on the cue.',
    steps: [
      'Count the clicks in the straight part, so the cue never takes you by surprise.',
      'Keep the straight part completely still, right up to the cue.',
      'Let the wobble open around the same pitch; the note itself shouldn’t move up or down.',
    ],
    easier: 'Listen to the demo just before you sing and copy the moment its wobble opens. Rest between takes so your voice stays fresh.',
  },

  // ---------------------------------------------------------------- pulses (and the two-note oscillation drills)
  'pulse.rate': {
    tip: 'Lock your pulses (or note changes) to the clicks: the same number in every click, evenly spaced, no faster and no slower.',
    why: 'The speed of your pulses drifted from the clicks, either rushing ahead or falling behind. That usually happens when you start singing before the rhythm is settled in your body. The one thing to change: feel the rhythm first, by tapping or speaking it, then sing it.',
    steps: [
      'Listen to the demo and count how many pulses or notes fit in each click.',
      'During the count-in, tap that many times on your leg for each click.',
      'Speak the rhythm first in time with the clicks, one “ha” per pulse or note, then sing it.',
      'Keep each pulse small and light; small movements are easier to keep in time.',
      'Keep the sound going between pulses so the rhythm never breaks.',
    ],
    easier: 'Sing the next take softer, with very small pulses, and count the clicks in your head. If you keep losing the rhythm, tap it with your hand while you sing.',
    practiseLevelId: 'vibrato.03',
  },
  'pulse.missing': {
    tip: 'Keep one unbroken sound and make each pulse a small bump up and back in pitch, in time with the clicks.',
    why: 'The app hears pulses as rises and falls in pitch on one continuous sound. If the sound stops between pulses, or the pulses only get louder without moving the pitch, there is nothing for it to count. The one thing to change: keep the sound going, with a tiny pitch bump on every pulse.',
    steps: [
      'Listen to the demo and notice that the sound never stops between pulses or notes.',
      'Start with a long, easy “ah” and keep it going while you add the pulses.',
      'Make each pulse a tiny lift in pitch and back, like a gentle laugh on one note.',
      'Keep the “h” of “ha” very light, or leave it out, so no breathy gap opens between pulses.',
      'On the two-note drills, move from note to note with no gap in the sound, each note still clear.',
      'Sing close enough to the mic for the trace to follow you, at a comfortable medium volume.',
    ],
    easier: 'Start slower: hold one long note and lift the pitch a little on each click, then two lifts per click. When the bumps come easily without stopping the sound, sing the take. If your throat feels tight, scratchy or tired, stop and rest.',
    practiseLevelId: 'vibrato.02',
  },
  'pulse.rate-any': {
    tip: 'Your pulses are close to the clicks. Keep every one exactly on the rhythm, from the first to the last.',
    why: 'Small timing slips usually come at the start, before the rhythm settles, or near the end, as the air runs low. The one thing to change: count the clicks in your head and keep the pulses locked to them right to the end.',
    steps: [
      'Breathe in on the last click of the count-in, so the first pulse starts on time.',
      'Count the clicks in your head and keep the pulses locked to them.',
      'Save enough air for the last pulses, so they neither rush nor fade.',
    ],
    easier: 'Tap the rhythm on your leg while you sing to keep the pulses steady. Keep the bumps small, since small bumps stay in time more easily.',
    practiseLevelId: 'vibrato.03',
  },
  'pulse.irregular': {
    tip: 'Space your pulses (or note changes) evenly, like the ticks of a clock, and keep each one about the same size.',
    why: 'Uneven pulses usually come from rushing some and lingering on others, often because some bumps are bigger than the rest. The app checks how evenly your pulses are spaced in time. The one thing to change: the same small bump at the same steady spacing, every time.',
    steps: [
      'Listen to the demo and tap the pulses on your leg to feel the even spacing.',
      'Speak the rhythm in time with the clicks first, one “ha” per pulse, every syllable the same length.',
      'Sing it with small bumps of the same size; a bump that is too small may not count and leaves a hole in the rhythm.',
      'Keep the air flowing steadily under the pulses, with no little stops between them.',
      'Count the clicks in your head and place the pulses evenly between them.',
    ],
    easier: 'Sing the next take softer, with smaller pulses, and think only about the spacing. If it still feels uneven, speak “ha-ha-ha” with the clicks until the rhythm feels automatic, then sing it.',
    practiseLevelId: 'vibrato.03',
  },
  'pulse.regularity-any': {
    tip: 'Your pulses are fairly even. Let every pulse match the one before it: same size, same spacing.',
    why: 'The last bit of evenness comes from a steady count and steady air. The one thing to change: keep the rhythm in your head and let every pulse copy the one before it.',
    steps: [
      'Count the clicks in your head as you sing.',
      'Keep each pulse the same small size.',
      'Keep the sound flowing between pulses, with no little stops.',
    ],
    easier: 'Sing the next take a little softer, since small, light pulses are easier to keep even. Rest between takes if your voice gets tired.',
    practiseLevelId: 'vibrato.03',
  },
};
