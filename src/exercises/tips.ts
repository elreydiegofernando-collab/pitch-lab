/**
 * Coaching tips (SPEC §12): a rule table mapping analyzer findings to one
 * short, specific, coach-like tip. The take report shows exactly ONE tip,
 * chosen by pickTip() for the part of the take that cost the most.
 *
 * Text placeholders: {v} = the rule metric's value (rounded), {pct} = the
 * value x 100 (0..1 rates). Copy rules (DESIGN §11): numbers over adjectives,
 * no exclamation marks, neutral facts stay neutral.
 *
 * Thresholds come from CONFIG where a matching value exists; the rest are
 * tip-trigger points (PROPOSED CONFIG.tips), not pass criteria.
 */
import { CONFIG } from '../config';
import type { DynamicsResult, InflectionKind, MetricKey, Metrics } from '../analysis/types';
import { RANGE_MIN_SPAN } from './catalog/scoring';
import { INFLECTION_CUES } from './cues';
import { evaluate, gateHolds, passRequirements, reachHolds, termScore, type NoteReach } from './evaluate';
import type { CoachingTip, ExerciseDef } from './types';

/** A CoachingTip plus optional qualifiers. The extra fields are optional, so a TipRule IS a CoachingTip. */
export interface TipRule extends CoachingTip {
  /** Judged metrics this tip explains (default [when.metric]); its urgency is the costliest of them. */
  relatesTo?: readonly MetricKey[];
  /** Needs the signed value from TipContext (see SIGNED_CONTEXT): sharp = +, flat = -. */
  direction?: 'sharp' | 'flat';
  /** Needs TipContext.dynamicsVerdict to equal this. */
  verdict?: DynamicsResult['verdict'];
  /** Needs TipContext.loudnessAgainstCue: a held note's level went the opposite way to its cue. */
  againstCue?: true;
  /** Only for exercises containing this inflection; with a TipContext, only when it was the weakest figure. */
  inflection?: InflectionKind;
  /** Only for exercises with a tempo ladder (it talks about the tempo stepping up). */
  tempoLadder?: true;
  /** Applies when when.metric could NOT be measured (op/value ignored). */
  missing?: true;
}

/** Signed or per-figure detail that the (absolute) metrics can't carry; analyze.ts provides it. */
export interface TipContext {
  biasCents?: number | null;
  driftCentsPerSec?: number | null;
  centeringCents?: number | null;
  dynamicsVerdict?: DynamicsResult['verdict'] | null;
  /** Some held note's level went against its cue (the other way, or one way through a swell). */
  loudnessAgainstCue?: boolean;
  /** The inflection kind that scored lowest in the take. */
  worstInflection?: InflectionKind | null;
  /**
   * Nothing (or almost nothing) was sung: analyze.ts measures the voiced time itself, so with a context this, and
   * not an empty Metrics, is what says nobody sang (a sung take can still measure nothing, e.g. a Range finder
   * take that never held a note).
   */
  noVoice?: boolean;
  /** The realization folded notes by octaves (or broke a figure doing so), so the take was not judged. */
  unfitRange?: boolean;
  /** How many of the target notes were sung at all (analyze.ts noteReach): too few, and the tip says so. */
  reach?: NoteReach;
}

const SIGNED_CONTEXT: Partial<Record<MetricKey, 'biasCents' | 'driftCentsPerSec' | 'centeringCents'>> = {
  'accuracy.absBiasCents': 'biasCents',
  'accuracy.absDriftCentsPerSec': 'driftCentsPerSec',
  'vibrato.absCenteringCents': 'centeringCents',
};

const Z = CONFIG.vibrato.styles;
const ZONE_RATE = `${Math.min(Z.pop.rateHz[0], Z.classical.rateHz[0])}–${Math.max(Z.pop.rateHz[1], Z.classical.rateHz[1])}`;
const WIDEST_ZONE = Math.max(Z.pop.extentCents[1], Z.classical.extentCents[1]);
const NARROWEST_ZONE = Math.min(Z.pop.extentCents[0], Z.classical.extentCents[0]);
/** SPEC §12's own example: a scoop above 40¢ gets "start the note on the pitch". */
const BIG_SCOOP_CENTS = 40;

const ACC: readonly MetricKey[] = ['accuracy.absBiasCents', 'accuracy.inTolerancePct', 'accuracy.medianAbsCents'];
const ONSET: readonly MetricKey[] = ['onset.scoopCents', 'onset.settleMs', 'onset.crispRate'];
const SHAPE: readonly MetricKey[] = ['inflection.score'];

/** The rule table. Priority breaks ties between rules explaining equally costly metrics (specific > generic). */
export const COACHING_TIPS: readonly TipRule[] = [
  // ---------------------------------------------------------------- accuracy & stability
  { id: 'acc.sharp', when: { metric: 'accuracy.absBiasCents', op: '>=', value: 8 }, direction: 'sharp', relatesTo: ACC, priority: 85,
    text: 'You sat {v}¢ sharp on average. Release the jaw, ease the air pressure, and let the note settle a hair lower.' },
  { id: 'acc.flat', when: { metric: 'accuracy.absBiasCents', op: '>=', value: 8 }, direction: 'flat', relatesTo: ACC, priority: 85,
    text: 'You sat {v}¢ flat on average. Keep the breath moving to the end of each note and aim the pitch a hair higher.' },
  { id: 'acc.bias', when: { metric: 'accuracy.absBiasCents', op: '>=', value: 8 }, relatesTo: ACC, priority: 60,
    text: 'Your centre was {v}¢ off the target. Check the cents gauge on the first note and move the whole take by that much.' },
  { id: 'acc.bias-any', when: { metric: 'accuracy.absBiasCents', op: '>=', value: 0 }, priority: 10,
    text: 'Aim for the middle of the band, not its edge. Small centring errors add up over a take.' },
  { id: 'acc.in-tune-low', when: { metric: 'accuracy.inTolerancePct', op: '<=', value: 50 }, priority: 70,
    text: 'You were inside the band {v}% of the time. Hear each note in your head first, then sing into the middle of the band.' },
  { id: 'acc.in-tune-any', when: { metric: 'accuracy.inTolerancePct', op: '<=', value: 100 }, priority: 10,
    text: '{v}% inside the band. Pre-hear every note before you sing it, and keep the tone still once you arrive.' },
  { id: 'acc.missing', when: { metric: 'accuracy.inTolerancePct', op: '>=', value: 0 }, missing: true, relatesTo: ACC, priority: 95,
    text: 'No held note came through clearly. Sing each note for its full length, close enough to the mic for the trace to follow you.' },
  { id: 'acc.median', when: { metric: 'accuracy.medianAbsCents', op: '>=', value: 20 }, priority: 60,
    text: 'Your typical miss was {v}¢. Hum the note quietly once, then match it at full voice.' },
  { id: 'acc.median-any', when: { metric: 'accuracy.medianAbsCents', op: '>=', value: 0 }, priority: 10,
    text: 'Typical miss {v}¢. Listen to the demo again and aim for the centre line of each bar.' },
  { id: 'acc.unstable', when: { metric: 'accuracy.sdCents', op: '>=', value: 20 }, relatesTo: ['accuracy.sdCents', 'accuracy.inTolerancePct'], priority: 75,
    text: 'The pitch wavered ({v}¢ spread). Hold it straight: steady air, a still jaw, and think of the tone as one flat line.' },
  { id: 'acc.stability-any', when: { metric: 'accuracy.sdCents', op: '>=', value: 0 }, priority: 10,
    text: '{v}¢ spread. Keep the airflow even and the jaw relaxed so the pitch line stays flat.' },
  { id: 'acc.drift-flat', when: { metric: 'accuracy.absDriftCentsPerSec', op: '>=', value: 3 }, direction: 'flat',
    relatesTo: ['accuracy.absDriftCentsPerSec', 'accuracy.sdCents'], priority: 85,
    text: 'The note sagged {v}¢ per second. Keep your support to the very end; pitch drops as the air runs low.' },
  { id: 'acc.drift-sharp', when: { metric: 'accuracy.absDriftCentsPerSec', op: '>=', value: 3 }, direction: 'sharp',
    relatesTo: ['accuracy.absDriftCentsPerSec', 'accuracy.sdCents'], priority: 85,
    text: 'The note crept up {v}¢ per second. Ease the breath pressure as you hold; let it float rather than push.' },
  { id: 'acc.drift-any', when: { metric: 'accuracy.absDriftCentsPerSec', op: '>=', value: 0 }, priority: 10,
    text: 'The pitch drifted {v}¢ per second. Keep the breath support constant all the way through the hold.' },

  // ---------------------------------------------------------------- onset crispness
  { id: 'onset.scoop-big', when: { metric: 'onset.scoopCents', op: '>=', value: BIG_SCOOP_CENTS }, relatesTo: ONSET, priority: 80,
    text: 'Start the note on the pitch: hear it before you sing. You scooped up from {v}¢ below.' },
  { id: 'onset.scoop', when: { metric: 'onset.scoopCents', op: '>=', value: CONFIG.onset.crispMaxScoopCents / 2 }, relatesTo: ONSET, priority: 60,
    text: 'A {v}¢ scoop is still there. Aim the very start of the vowel at the target, not below it.' },
  { id: 'onset.scoop-any', when: { metric: 'onset.scoopCents', op: '>=', value: 0 }, priority: 10,
    text: 'Land the start of each note right on the line; even a small scoop blurs the attack.' },
  { id: 'onset.settle-slow', when: { metric: 'onset.settleMs', op: '>=', value: CONFIG.onset.settleTargetMs.default },
    relatesTo: ['onset.settleMs', 'onset.crispRate'], priority: 70,
    text: 'It took {v} ms to settle. Pre-hear the pitch and start with a balanced onset instead of searching for the note.' },
  { id: 'onset.settle-missing', when: { metric: 'onset.settleMs', op: '>=', value: 0 }, missing: true, priority: 90,
    text: 'Most notes never settled inside the band. Hear the pitch first, start gently, then hold it still once you land.' },
  { id: 'onset.settle-any', when: { metric: 'onset.settleMs', op: '>=', value: 0 }, priority: 10,
    text: 'Settled in {v} ms. Hear the note first, then begin it cleanly so it locks in at once.' },
  { id: 'onset.overshoot', when: { metric: 'onset.overshootCents', op: '>=', value: CONFIG.onset.crispMaxOvershootCents },
    relatesTo: ['onset.overshootCents', 'onset.settleMs', 'onset.crispRate'], priority: 70,
    text: 'You overshot by {v}¢ before settling. Aim at the note itself, not past it, especially on upward leaps.' },
  { id: 'onset.overshoot-any', when: { metric: 'onset.overshootCents', op: '>=', value: 0 }, priority: 10,
    text: 'Arrive on the note without overshooting it; think of landing, not throwing.' },
  { id: 'onset.crisp-low', when: { metric: 'onset.crispRate', op: '<=', value: 0.5 }, priority: 65,
    text: '{pct}% of the onsets were crisp. Start each note right on the pitch with a balanced onset, neither breathy nor a hard click.' },
  { id: 'onset.crisp-any', when: { metric: 'onset.crispRate', op: '<=', value: 1 }, priority: 10,
    text: '{pct}% crisp onsets. Same pitch, same clean start, every note.' },

  // ---------------------------------------------------------------- vibrato
  { id: 'vib.none', when: { metric: 'vibrato.present', op: '<=', value: 0.5 },
    relatesTo: ['vibrato.present', 'vibrato.inZone', 'vibrato.regularity', 'vibrato.bloomOnCue', 'vibrato.switchCleanRate'], priority: 90,
    text: 'No vibrato was detected on most notes. Sing the pulse drills again and let the pulses speed up until they blur into a free wobble.' },
  { id: 'vib.slow', when: { metric: 'vibrato.rateHz', op: '<=', value: CONFIG.vibrato.wobbleBelowHz }, relatesTo: ['vibrato.inZone', 'vibrato.regularity'], priority: 75,
    text: 'Your vibrato is slow ({v} Hz) and can sound wobbly. Sing a little lighter and let the cycles come quicker and smaller.' },
  { id: 'vib.fast', when: { metric: 'vibrato.rateHz', op: '>=', value: CONFIG.vibrato.bleatAboveHz }, relatesTo: ['vibrato.inZone', 'vibrato.regularity'], priority: 75,
    text: 'Your vibrato is fast ({v} Hz), close to a bleat. Release throat tension and let it slow down on its own.' },
  { id: 'vib.wide', when: { metric: 'vibrato.extentCents', op: '>=', value: WIDEST_ZONE }, relatesTo: ['vibrato.inZone'], priority: 70,
    text: 'Your vibrato swings wide (±{v}¢). Lighten the tone and narrow the swing toward the shaded zone.' },
  { id: 'vib.narrow', when: { metric: 'vibrato.extentCents', op: '<=', value: NARROWEST_ZONE }, relatesTo: ['vibrato.inZone'], priority: 65,
    text: 'Your vibrato is narrow (±{v}¢). Let it swing a little wider by relaxing, not by pushing.' },
  { id: 'vib.zone', when: { metric: 'vibrato.inZone', op: '<=', value: 0.5 }, priority: 50,
    text: `Rate or width sat outside the target zone. Watch the shaded band and aim for an even ${ZONE_RATE} wobbles per second.` },
  { id: 'vib.zone-any', when: { metric: 'vibrato.inZone', op: '<=', value: 1 }, priority: 10,
    text: 'Keep the vibrato inside the shaded zone from the start of the note to its end.' },
  { id: 'vib.irregular', when: { metric: 'vibrato.regularity', op: '<=', value: 0.5 }, priority: 60,
    text: 'The vibrato was uneven. Keep the airflow steady and let it run by itself; don’t drive each cycle.' },
  { id: 'vib.regularity-any', when: { metric: 'vibrato.regularity', op: '<=', value: 1 }, priority: 10,
    text: 'Let the vibrato settle into one even speed and width; steady air does most of the work.' },
  { id: 'vib.centre-flat', when: { metric: 'vibrato.absCenteringCents', op: '>=', value: 10 }, direction: 'flat', priority: 85,
    text: 'Your vibrato sags {v}¢ flat. Let it swing evenly around the note: think the pitch slightly higher and keep the breath up.' },
  { id: 'vib.centre-sharp', when: { metric: 'vibrato.absCenteringCents', op: '>=', value: 10 }, direction: 'sharp', priority: 85,
    text: 'Your vibrato sits {v}¢ sharp. Let it swing below the note as well as above, and relax the push.' },
  { id: 'vib.centre', when: { metric: 'vibrato.absCenteringCents', op: '>=', value: 10 }, priority: 55,
    text: 'The vibrato’s centre is {v}¢ off the note. It should swing evenly above and below the pitch.' },
  { id: 'vib.centre-any', when: { metric: 'vibrato.absCenteringCents', op: '>=', value: 0 }, priority: 10,
    text: 'Keep the vibrato centred on the note, swinging equally above and below it.' },
  { id: 'vib.switch', when: { metric: 'vibrato.switchCleanRate', op: '<=', value: 0.7 }, priority: 70,
    text: 'Switches were blurry. On “Straight” stop the vibrato at once; on “Vibrato on” let it start right away without re-attacking the note.' },
  { id: 'vib.switch-any', when: { metric: 'vibrato.switchCleanRate', op: '<=', value: 1 }, priority: 10,
    text: 'Make each switch land exactly on the cue, with no re-attack of the note.' },
  { id: 'vib.bloom', when: { metric: 'vibrato.bloomOnCue', op: '<=', value: 0.6 }, priority: 70,
    text: 'The bloom didn’t line up with the cue. Keep the tone completely straight until “Bloom”, then release the vibrato in one go.' },
  { id: 'vib.bloom-any', when: { metric: 'vibrato.bloomOnCue', op: '<=', value: 1 }, priority: 10,
    text: 'Hold the straight tone right up to the cue, then let the vibrato open up without changing the pitch.' },

  // ---------------------------------------------------------------- pulses
  { id: 'pulse.rate', when: { metric: 'pulse.rateErrorHz', op: '>=', value: 0.4 }, priority: 70,
    text: 'Your pulses were {v} Hz off the target rate. Lock each pulse to the metronome subdivisions before trying to speed up.' },
  { id: 'pulse.missing', when: { metric: 'pulse.rateErrorHz', op: '>=', value: 0 }, missing: true, relatesTo: ['pulse.rateErrorHz', 'pulse.regularity'], priority: 90,
    text: 'No clear pulses came through. Keep the sound going and make each pulse a small, distinct bump in pitch, in time with the clicks.' },
  { id: 'pulse.rate-any', when: { metric: 'pulse.rateErrorHz', op: '>=', value: 0 }, priority: 10,
    text: 'Keep every pulse exactly on the metronome subdivisions.' },
  { id: 'pulse.irregular', when: { metric: 'pulse.regularity', op: '<=', value: 0.6 }, priority: 65,
    text: 'The pulses were uneven. Make each one the same size and keep the sound connected between them.' },
  { id: 'pulse.regularity-any', when: { metric: 'pulse.regularity', op: '<=', value: 1 }, priority: 10,
    text: 'Same size, same spacing: let every pulse match the one before it.' },

  // ---------------------------------------------------------------- glides & cracks
  { id: 'glide.cracks', when: { metric: 'glide.cracks', op: '>=', value: 1 }, priority: 80,
    text: 'The voice broke {v} times on the way (marked on the trace). Lighten up as you near the break and let the tone thin out instead of carrying the low weight up.' },
  { id: 'glide.cracks-any', when: { metric: 'glide.cracks', op: '>=', value: 0 }, priority: 10,
    text: 'Keep the tone light through the middle of the range so the slide stays unbroken.' },
  { id: 'glide.stairs', when: { metric: 'glide.smoothness', op: '<=', value: 0.4 }, priority: 70,
    text: 'The slide moved in steps. Make it one continuous ramp, like a siren, and slow it down if you need to.' },
  { id: 'glide.smooth-any', when: { metric: 'glide.smoothness', op: '<=', value: 1 }, priority: 10,
    text: 'Keep the slide one even ramp from start to finish, with no plateaus on the way.' },
  { id: 'glide.end', when: { metric: 'glide.endAbsCents', op: '>=', value: 20 }, priority: 65,
    text: 'You arrived {v}¢ off the destination. Hear the target note before you start the slide.' },
  { id: 'glide.missing', when: { metric: 'glide.endAbsCents', op: '>=', value: 0 }, missing: true, relatesTo: ['glide.endAbsCents', 'glide.smoothness'], priority: 90,
    text: 'The glides didn’t come through. Keep one unbroken sound from the start of each slide to its end.' },
  { id: 'glide.end-any', when: { metric: 'glide.endAbsCents', op: '>=', value: 0 }, priority: 10,
    text: 'Arrived {v}¢ from the destination. Picture the final note before you set off.' },

  // ---------------------------------------------------------------- transitions
  { id: 'transition.smeared', when: { metric: 'transition.cleanRate', op: '<=', value: 0.6 }, priority: 70,
    text: '{pct}% of the note changes were clean. Move on a connected vowel, arrive, then hold; don’t slide into the next note.' },
  { id: 'transition.any', when: { metric: 'transition.cleanRate', op: '<=', value: 1 }, priority: 10,
    text: 'Keep the line connected but let each note arrive cleanly before the next.' },

  // ---------------------------------------------------------------- inflections
  { id: 'scoop.shape', inflection: 'scoop', when: { metric: 'inflection.score', op: '<=', value: 0.7 }, relatesTo: SHAPE, priority: 75,
    text: 'Start clearly below the note, about the size the demo uses, and arrive right on the beat. An intentional scoop is quick and committed.' },
  { id: 'fall.shape', inflection: 'fall', when: { metric: 'inflection.score', op: '<=', value: 0.7 }, relatesTo: SHAPE, priority: 75,
    text: 'Hold the note for its full value, then release downward in one smooth fall as the sound fades. Don’t let the pitch drop before the fall.' },
  { id: 'slide.shape', inflection: 'slide', when: { metric: 'inflection.score', op: '<=', value: 0.7 }, relatesTo: SHAPE, priority: 75,
    text: 'Match the slide’s timing: start moving on the beat and arrive exactly when the bar ends, at an even speed.' },
  { id: 'turn.shape', inflection: 'turn', when: { metric: 'inflection.score', op: '<=', value: 0.7 }, relatesTo: SHAPE, priority: 75,
    text: 'Give the upper and the lower neighbour each its own tiny landing, with the main note between them. Sing it slowly in your head first.' },
  { id: 'flip.shape', inflection: 'flip', when: { metric: 'inflection.score', op: '<=', value: 0.7 }, relatesTo: SHAPE, priority: 75,
    text: 'Flip quickly and lightly into the upper note; let the voice change register instead of carrying the low weight up.' },
  { id: 'inflection.shape', when: { metric: 'inflection.score', op: '<=', value: 0.7 }, priority: 50,
    text: 'The ornament didn’t match the target shape. Listen to the demo again and copy its size and timing.' },
  { id: 'inflection.shape-any', when: { metric: 'inflection.score', op: '<=', value: 1 }, priority: 10,
    text: 'Copy the demo’s ornament exactly: same size, same timing, same landing.' },
  { id: 'inflection.landing', when: { metric: 'inflection.landingAbsCents', op: '>=', value: 20 }, priority: 65,
    text: 'After the ornament you landed {v}¢ off. The landing note matters most; aim it precisely.' },
  { id: 'inflection.landing-any', when: { metric: 'inflection.landingAbsCents', op: '>=', value: 0 }, priority: 10,
    text: 'Landed {v}¢ from the target. Finish every ornament on the centre of the note.' },

  // ---------------------------------------------------------------- runs & riffs
  { id: 'run.missed', when: { metric: 'run.missedRate', op: '>=', value: 0.15 }, relatesTo: ['run.missedRate', 'run.score'], priority: 80,
    text: '{pct}% of the notes were missed. At this tempo, touch every note lightly rather than singing each one full.' },
  { id: 'run.missed-any', when: { metric: 'run.missedRate', op: '>=', value: 0 }, priority: 10,
    text: 'Touch every note of the run, even the passing ones.' },
  { id: 'run.smeared', when: { metric: 'run.definedRate', op: '<=', value: 0.6 }, relatesTo: ['run.definedRate', 'run.score'], priority: 70,
    text: 'Notes blurred together. Give each its own tiny landing; a light “h” inside the vowel helps at first, then take it away.' },
  { id: 'run.defined-any', when: { metric: 'run.definedRate', op: '<=', value: 1 }, priority: 10,
    text: 'Make every note of the run distinct: land, move, land.' },
  { id: 'run.score', when: { metric: 'run.score', op: '<=', value: CONFIG.runs.tempoAdvanceScore }, tempoLadder: true, priority: 40,
    text: 'Run score {pct}%. Keep every note clean at this speed; each take that passes here moves the tempo up a step.' },
  { id: 'run.score-any', when: { metric: 'run.score', op: '<=', value: 1 }, priority: 10,
    text: 'Keep the run relaxed and light; speed comes from clean, small movements.' },

  // ---------------------------------------------------------------- dynamics
  { id: 'dyn.sharp-loud', when: { metric: 'dynamics.absSlopeCentsPerDb', op: '>=', value: 0 }, verdict: 'sharp-when-loud', priority: 90,
    text: 'You went sharp as you got louder. Keep the breath steady as you crescendo; don’t push.' },
  { id: 'dyn.flat-soft', when: { metric: 'dynamics.absSlopeCentsPerDb', op: '>=', value: 0 }, verdict: 'flat-when-soft', priority: 90,
    text: 'You went flat as you got softer. Keep the support as the sound gets quieter; soft isn’t slack.' },
  // Outranks dyn.range-small: a take sung against its cues also shows no range (analyze.ts counts none for it).
  { id: 'dyn.against-cue', when: { metric: 'dynamics.rangeDb', op: '>=', value: 0 }, againstCue: true, relatesTo: ['dynamics.rangeDb'], priority: 88,
    text: 'The loudness moved against the cue. Follow the shape it names, as the demo plays it: grow from soft, fade from full, or step on the clicks.' },
  { id: 'dyn.slope', when: { metric: 'dynamics.absSlopeCentsPerDb', op: '>=', value: CONFIG.dynamics.maxDriftCentsPerDb }, priority: 60,
    text: 'The pitch moved {v}¢ for every dB of volume. Keep the pitch line flat while only the loudness changes.' },
  { id: 'dyn.slope-any', when: { metric: 'dynamics.absSlopeCentsPerDb', op: '>=', value: 0 }, priority: 10,
    text: 'Let only the volume change; the pitch line should stay perfectly flat.' },
  { id: 'dyn.range-small', when: { metric: 'dynamics.rangeDb', op: '<=', value: CONFIG.dynamics.minRangeDb },
    relatesTo: ['dynamics.rangeDb', 'dynamics.absSlopeCentsPerDb'], priority: 85,
    text: 'The volume only changed by {v} dB. Start softer than feels natural and grow more gradually.' },
  { id: 'dyn.range-any', when: { metric: 'dynamics.rangeDb', op: '>=', value: 0 }, priority: 10,
    text: '{v} dB from softest to loudest. Begin a little softer to give the swell more room.' },
  { id: 'dyn.symmetry', when: { metric: 'dynamics.symmetry', op: '<=', value: 0.5 }, priority: 65,
    text: 'The swell was lopsided. Take as long to fade as to grow, and save air for the second half.' },
  { id: 'dyn.symmetry-any', when: { metric: 'dynamics.symmetry', op: '<=', value: 1 }, priority: 10,
    text: 'Match the fade to the growth: peak in the middle, then come down at the same pace.' },

  // ---------------------------------------------------------------- range
  // Spans are whole semitones (analysis/range.ts rounds each held note), so this is "below RANGE_MIN_SPAN".
  { id: 'range.narrow', when: { metric: 'range.spanSemitones', op: '<=', value: RANGE_MIN_SPAN - 1 }, priority: 60,
    text: `Your low and high notes were {v} half steps apart, and the exercises need ${RANGE_MIN_SPAN} (an octave). Slide a little lower and a little higher than the lines on the screen, and hold the last note that still feels easy, never a strained one.` },
  { id: 'range.missing', when: { metric: 'range.spanSemitones', op: '>=', value: 0 }, missing: true, priority: 90,
    text: 'No note was held long enough to measure. Hold your lowest and your highest easy note for a slow count of three each.' },
  { id: 'range.any', when: { metric: 'range.spanSemitones', op: '>=', value: 0 }, priority: 10,
    text: 'Stay in the easy part of your voice. Your range grows with relaxed practice, not by pushing for notes.' },
];

/** Shown when a passed take lost almost nothing. */
export const POLISH_TIP: CoachingTip = {
  id: 'general.polish',
  when: { metric: 'accuracy.inTolerancePct', op: '>=', value: 0 },
  text: 'Clean take. Replay to light the next tally, or move on when you’re ready.',
  priority: 0,
};

/** Shown when nobody sang: TipContext.noVoice, or, without a context, a take with nothing measured at all. */
export const NO_VOICE_TIP: CoachingTip = {
  id: 'general.no-voice',
  when: { metric: 'accuracy.inTolerancePct', op: '>=', value: 0 },
  text: 'No singing came through. Check that the mic is allowed, then start singing as the count-in ends.',
  priority: 0,
};

/** Shown when the take was not judged because the exercise had to be folded into the saved range (TipContext.unfitRange). */
export const UNFIT_RANGE_TIP: CoachingTip = {
  id: 'general.unfit-range',
  when: { metric: 'range.spanSemitones', op: '>=', value: 0 },
  text: 'This exercise does not fit your saved range, so the take was not judged. Sing the Range finder again and hold the lowest and highest notes that still feel easy.',
  priority: 0,
};

/** Shown when the take left notes unsung, so it could not pass (TipContext.reach short of evaluate.ts reachHolds). */
export const UNSUNG_TIP: CoachingTip = {
  id: 'general.unsung',
  when: { metric: 'accuracy.inTolerancePct', op: '>=', value: 0 },
  text: 'Some notes went unsung, so the take could not pass. Keep singing to the end of the exercise.',
  priority: 0,
};

/** Shown for a take stopped before the end of the exercise: it is practice, and was not judged (the runner picks it). */
export const STOPPED_TIP: CoachingTip = {
  id: 'general.stopped',
  when: { metric: 'accuracy.inTolerancePct', op: '>=', value: 0 },
  text: 'You stopped before the end, so this take counts as practice and was not judged. Sing to the end of the exercise for it to count.',
  priority: 0,
};

/** UNSUNG_TIP with the count: "You sang 6 of the 14 notes. ..." */
function unsungText(def: Pick<ExerciseDef, 'kind'>, reach: NoteReach): string {
  const all = def.kind === 'boss-recital' ? 'every note' : 'nearly every note';
  return `You sang ${reach.reached} of the ${reach.total} notes. Keep singing to the end of the exercise: a take passes only when ${all} is sung.`;
}

/** A passed take that lost less than this share of the score on its costliest metric counts as polished (PROPOSED CONFIG.tips). */
const POLISH_MAX_DEFICIT = 0.03;

const BY_ID = new Map(COACHING_TIPS.map((t) => [t.id, t]));
export function getTip(id: string): TipRule | undefined {
  return BY_ID.get(id);
}

function relatesTo(rule: TipRule): readonly MetricKey[] {
  return rule.relatesTo ?? [rule.when.metric];
}

/** Inflection kinds an exercise contains (from its cues). */
function inflectionsOf(def: Pick<ExerciseDef, 'pattern'>): Set<InflectionKind> {
  const out = new Set<InflectionKind>();
  for (const s of def.pattern) {
    const k = s.cue !== undefined ? INFLECTION_CUES.get(s.cue) : undefined;
    if (k) out.add(k);
  }
  return out;
}

/** Metrics an exercise scores or gates on. */
function judgedMetrics(def: Pick<ExerciseDef, 'scoring' | 'pass'>): Set<MetricKey> {
  const s = new Set<MetricKey>();
  for (const t of def.scoring) s.add(t.metric);
  for (const g of def.pass.gates ?? []) s.add(g.metric);
  return s;
}

const hasLadder = (def: Pick<ExerciseDef, 'tempoLadder'>): boolean => (def.tempoLadder?.length ?? 0) > 0;

/** Tip ids relevant to `def`: rules that explain something it scores or gates on. Fills ExerciseDef.tipIds. */
export function tipIdsFor(def: Pick<ExerciseDef, 'scoring' | 'pass' | 'pattern' | 'tempoLadder'>): string[] {
  const judged = judgedMetrics(def);
  const kinds = inflectionsOf(def);
  const out: string[] = [];
  for (const r of COACHING_TIPS) {
    if (r.inflection && !kinds.has(r.inflection)) continue;
    if (r.tempoLadder && !hasLadder(def)) continue;
    if (relatesTo(r).some((m) => judged.has(m))) out.push(r.id);
  }
  return out;
}

export interface PickedTip {
  id: string;
  /** Final text with placeholders filled. */
  text: string;
  metric: MetricKey | null;
  value: number | null;
}

function fmt(v: number): string {
  return Math.abs(v) >= 10 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1);
}

function fill(text: string, v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return text;
  return text.replace(/\{v\}/g, fmt(v)).replace(/\{pct\}/g, String(Math.round(v * 100)));
}

const measured = (metrics: Metrics, m: MetricKey) => {
  const v = metrics[m];
  return v !== undefined && Number.isFinite(v);
};

function applies(rule: TipRule, metrics: Metrics, ctx: TipContext | undefined, kinds: Set<InflectionKind>): boolean {
  if (rule.missing) return !measured(metrics, rule.when.metric);
  if (!gateHolds(rule.when, metrics)) return false;
  if (rule.verdict && ctx?.dynamicsVerdict !== rule.verdict) return false;
  if (rule.againstCue && !ctx?.loudnessAgainstCue) return false;
  if (rule.direction) {
    const key = SIGNED_CONTEXT[rule.when.metric];
    const signed = key ? ctx?.[key] : undefined;
    if (signed === undefined || signed === null || !Number.isFinite(signed) || signed === 0) return false;
    if ((signed > 0) !== (rule.direction === 'sharp')) return false;
  }
  if (rule.inflection) {
    if (!kinds.has(rule.inflection)) return false;
    const worst = ctx?.worstInflection;
    if (worst) return worst === rule.inflection;
    return kinds.size === 1;
  }
  return true;
}

/**
 * The single most useful tip for an attempt: the rule explaining the metric
 * that cost the most score (an unmeasured scored metric costs its full
 * weight; a failed gate costs a whole point), ties broken by priority
 * (specific beats generic). Restricted to def.tipIds when present. A passed
 * take that lost almost nothing gets POLISH_TIP; a failed take always gets
 * advice, falling back to its first failed requirement. NO_VOICE_TIP needs
 * ctx.noVoice when a context is given (a sung take may measure nothing),
 * UNFIT_RANGE_TIP answers a take that was not judged (ctx.unfitRange), and
 * UNSUNG_TIP a take that left too many notes unsung to pass (ctx.reach).
 */
export function pickTip(metrics: Metrics, def: ExerciseDef, ctx?: TipContext): PickedTip {
  if (ctx?.noVoice || (ctx === undefined && !Object.values(metrics).some((v) => v !== undefined && Number.isFinite(v)))) {
    return { id: NO_VOICE_TIP.id, text: NO_VOICE_TIP.text, metric: null, value: null };
  }
  if (ctx?.unfitRange) return { id: UNFIT_RANGE_TIP.id, text: UNFIT_RANGE_TIP.text, metric: null, value: null };
  if (ctx?.reach && !reachHolds(def, ctx.reach)) return { id: UNSUNG_TIP.id, text: unsungText(def, ctx.reach), metric: null, value: null };
  const lost = new Map<MetricKey, number>();
  let w = 0;
  for (const t of def.scoring) w += t.weight;
  for (const t of def.scoring) {
    const s = termScore(t, metrics[t.metric]);
    const d = w > 0 ? ((1 - (s ?? 0)) * t.weight) / w : 0;
    lost.set(t.metric, Math.max(lost.get(t.metric) ?? 0, d));
  }
  for (const g of def.pass.gates ?? []) {
    if (!gateHolds(g, metrics)) lost.set(g.metric, (lost.get(g.metric) ?? 0) + 1);
    else if (!lost.has(g.metric)) lost.set(g.metric, 0);
  }

  const kinds = inflectionsOf(def);
  const allowed = def.tipIds && def.tipIds.length > 0 ? new Set(def.tipIds) : null;
  let best: TipRule | null = null;
  let bestLoss = -1;
  for (const rule of COACHING_TIPS) {
    if (allowed && !allowed.has(rule.id)) continue;
    if (rule.tempoLadder && !hasLadder(def)) continue;
    let loss = -1;
    for (const m of relatesTo(rule)) {
      const l = lost.get(m);
      if (l !== undefined && l > loss) loss = l;
    }
    if (loss < 0 || !applies(rule, metrics, ctx, kinds)) continue;
    if (loss > bestLoss + 1e-9 || (Math.abs(loss - bestLoss) <= 1e-9 && best !== null && rule.priority > best.priority)) {
      best = rule;
      bestLoss = loss;
    }
  }

  const { passed, failedGates } = evaluate(def, metrics);
  if (passed && (!best || bestLoss < POLISH_MAX_DEFICIT)) {
    return { id: POLISH_TIP.id, text: POLISH_TIP.text, metric: null, value: null };
  }
  if (!best) {
    const reqs = passRequirements(def);
    const req = failedGates.length > 0 ? reqs[failedGates[0] + 1] : reqs[0];
    return {
      id: 'general.retry',
      text: `Not there yet: ${req.text}. Listen to the demo once more, then aim for that.`,
      metric: req.metric,
      value: req.metric ? (metrics[req.metric] ?? null) : null,
    };
  }
  const value = metrics[best.when.metric];
  return { id: best.id, text: fill(best.text, value), metric: best.when.metric, value: value !== undefined && Number.isFinite(value) ? value : null };
}
