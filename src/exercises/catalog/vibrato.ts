/**
 * Vibrato (SPEC §9.2). Builds vibrato from the outside in: wide, slow
 * alternations (whole tone, then semitone) narrow and speed up; then
 * metronomic pitch pulses on one note speed from 3.5 to 4.5 to 5.5 per second,
 * into the natural 5.5-6.5 Hz (RESEARCH §6); then free vibrato in the style
 * zone, straight-to-bloom on cue, and on/off switching.
 *
 * Rates come from tempo x subdivision: whole-tone eighths at 80 bpm = 1.33
 * cycles/s, semitone sixteenths at 70 = 2.33, pulse eighths at 105 = 3.5,
 * triplets at 90 = 4.5 and at 110 = 5.5. plan.ts reads each pulse train's rate
 * off the realized steps for the pulse analyzer.
 *
 * Demos of free vibrato, bloom and switching use 'style', so the singer hears
 * the zone midpoint (rate and extent) of their vibrato style.
 *
 * Every level that judges vibrato also gates vibrato.inZone (rate and extent
 * inside the style zone, SPEC §8.3), so a slow wide wobble, a fast bleat, a
 * huge or a token vibrato never passes: half way up its band where the zone
 * is the skill (free vibrato and the Boss Recital), a quarter of the way on
 * bloom and switching, whose short windows are mostly about timing. Centring
 * is gated at the level's own tolerance (onTheNote).
 */
import { CUE } from '../cues';
import type { AuditionDef, ExerciseDef, PatternStep, WorldDef } from '../types';
import { CORE_POINT, MOST, PASS, TIERS, gate, gateAt, onTheNote, terms } from './scoring';
import { alternate, bossLevel, defineExercise, level, note, pulses, rest } from './steps';

const W = 'vibrato' as const;
const STYLE_DEMO = { timbre: 'soft', vibrato: 'style' } as const;

/** Straight/vibrato windows on one held pitch: [cue, beats][]. Every window starts with its cue. */
function segments(semis: number, parts: ReadonlyArray<readonly [string, number]>): PatternStep[] {
  return parts.map(([cue, beats], i) => note(semis, beats, i === 0 ? { cue, syllable: 'ah' } : { cue }));
}

// ---------------------------------------------------------------- 01-02 Oscillation drill
/** Each note distinct (run analyzer) and the cycle rate even and on the clicks (pulse analyzer, cycles per second). */
const OSC_TERMS = { 'run.score': 0.45, 'run.definedRate': 0.2, 'pulse.rateErrorHz': 0.2, 'pulse.regularity': 0.15 } as const;

export const oscillation1 = defineExercise({
  id: 'vibrato.oscillation.1',
  worldId: W,
  kind: 'oscillation',
  title: 'Oscillation I',
  goal: 'Alternate a whole tone in even eighths with the sound connected: the slow, wide ancestor of vibrato.',
  pattern: [...alternate(0, 2, 16, 0.5, { cue: 'Whole tone, even and connected', syllable: 'ah' }), rest(2)],
  tempoBpm: 80,
  tonicPlacement: 'fit-span',
  repeats: { count: 2, stepSemis: 2 },
  countInBeats: 4,
  metronome: true,
  demo: { timbre: 'soft', vibrato: null },
  analyzers: ['run', 'pulse'],
  scoring: terms('easy', OSC_TERMS),
  pass: { score: PASS, gates: [gate('run.definedRate', 'easy', CORE_POINT), gate('run.missedRate', 'easy')] },
  tolerance: 'easy',
  tiers: TIERS,
});

export const oscillation2 = defineExercise({
  id: 'vibrato.oscillation.2',
  worldId: W,
  kind: 'oscillation',
  title: 'Oscillation II',
  goal: 'Narrow it to a semitone and speed up to sixteenths, still even and connected.',
  pattern: [...alternate(0, 1, 24, 0.25, { cue: 'Semitone, quicker, still connected', syllable: 'ah' }), rest(2)],
  tempoBpm: 70,
  tonicPlacement: 'fit-span',
  repeats: { count: 3, stepSemis: 2 },
  countInBeats: 4,
  metronome: true,
  demo: { timbre: 'soft', vibrato: null },
  analyzers: ['run', 'pulse'],
  scoring: terms('easy', OSC_TERMS),
  pass: { score: PASS, gates: [gate('run.definedRate', 'easy', CORE_POINT), gate('run.missedRate', 'easy')] },
  tolerance: 'easy',
  tiers: TIERS,
});

// ---------------------------------------------------------------- 03-05 Pulse builder
const PULSE_TERMS = { 'pulse.rateErrorHz': 0.45, 'pulse.regularity': 0.35, 'accuracy.absBiasCents': 0.2 } as const;

function pulseBuilder(n: 1 | 2 | 3, o: { bpm: number; perBeat: 2 | 3; title: string; goal: string; cue: string; pass: number }): ExerciseDef {
  return defineExercise({
    id: `vibrato.pulse.${n}`,
    worldId: W,
    kind: 'pulse-builder',
    title: o.title,
    goal: o.goal,
    pattern: [...pulses(0, o.perBeat * 6, 1 / o.perBeat, { cue: o.cue, syllable: 'ah' }), rest(2)],
    tempoBpm: o.bpm,
    tonicPlacement: 'fit-span',
    repeats: { count: 3, stepSemis: 2 },
    countInBeats: 4,
    metronome: true,
    demo: { timbre: 'soft', vibrato: null },
    analyzers: ['pulse', 'accuracy'],
    scoring: terms('default', PULSE_TERMS),
    pass: { score: o.pass, gates: [gate('pulse.rateErrorHz', 'default'), onTheNote('accuracy.absBiasCents', 'default')] },
    tolerance: 'default',
    tiers: TIERS,
  });
}

/** 3.5 Hz: eighths at 105 bpm. */
export const pulse1 = pulseBuilder(1, {
  bpm: 105, perBeat: 2, title: 'Pulse builder I', pass: PASS, cue: 'Pulse “ha-ha-ha” without stopping the sound',
  goal: 'Pulse the pitch on one note, two pulses per click (3.5 a second), each a small bump centred on the note.',
});
/** 4.5 Hz: triplets at 90 bpm. */
export const pulse2 = pulseBuilder(2, {
  bpm: 90, perBeat: 3, title: 'Pulse builder II', pass: PASS, cue: 'Three pulses per click, even and connected',
  goal: 'Three pulses per click (4.5 a second), each the same size, the sound never stopping.',
});
/** 5.5 Hz: triplets at 110 bpm, the bottom of natural vibrato. */
export const pulse3 = pulseBuilder(3, {
  bpm: 110, perBeat: 3, title: 'Pulse builder III', pass: 0.62, cue: 'Faster: let the pulses start to blur',
  goal: 'Speed the pulses to 5.5 a second, where they start to blur into vibrato.',
});

// ---------------------------------------------------------------- 06 Free vibrato (vibrato meter)
const FREE_TERMS = { 'vibrato.inZone': 0.35, 'vibrato.absCenteringCents': 0.25, 'vibrato.regularity': 0.2, 'vibrato.present': 0.2 } as const;
/** Vibrato on most notes, in the style zone (the skill itself, so gated half way up its band), centred in tolerance. */
const FREE_GATES = [
  gateAt('vibrato.present', '>=', MOST), gate('vibrato.inZone', 'default', CORE_POINT), onTheNote('vibrato.absCenteringCents', 'default'),
];

export const freeVibrato = defineExercise({
  id: 'vibrato.meter.1',
  worldId: W,
  kind: 'vibrato-meter',
  title: 'Free vibrato',
  goal: 'Sustain each note and let the vibrato spin freely inside the shaded zone, centred on the pitch.',
  pattern: [
    note(0, 5, { cue: 'Let the vibrato spin freely', syllable: 'ah' }),
    rest(1),
    note(4, 5, { syllable: 'ah' }),
    rest(1),
    note(7, 5, { syllable: 'ah' }),
  ],
  tempoBpm: 60,
  tonicPlacement: 'mid',
  countInBeats: 2,
  metronome: false,
  demo: STYLE_DEMO,
  analyzers: ['vibrato'],
  scoring: terms('default', FREE_TERMS),
  pass: { score: PASS, gates: FREE_GATES },
  tolerance: 'default',
  tiers: TIERS,
});

// ---------------------------------------------------------------- 07 Straight to bloom
const BLOOM_TERMS = { 'vibrato.bloomOnCue': 0.35, 'vibrato.switchCleanRate': 0.25, 'vibrato.inZone': 0.2, 'vibrato.absCenteringCents': 0.2 } as const;
const BLOOM_GATES = [
  gate('vibrato.bloomOnCue', 'default'), gate('vibrato.switchCleanRate', 'default'), gate('vibrato.inZone', 'default'),
  onTheNote('vibrato.absCenteringCents', 'default'),
];

export const straightToBloom = defineExercise({
  id: 'vibrato.bloom.1',
  worldId: W,
  kind: 'straight-to-bloom',
  title: 'Straight to bloom',
  goal: 'Start each note perfectly straight, then let the vibrato bloom exactly on the cue.',
  pattern: [
    ...segments(0, [[CUE.straight, 3], [CUE.bloom, 3]]),
    rest(2),
    ...segments(2, [[CUE.straight, 2], [CUE.bloom, 4]]),
    rest(2),
    ...segments(4, [[CUE.straight, 4], [CUE.bloom, 2]]),
  ],
  tempoBpm: 60,
  tonicPlacement: 'mid',
  countInBeats: 4,
  metronome: true,
  demo: STYLE_DEMO,
  analyzers: ['switch', 'vibrato'],
  scoring: terms('default', BLOOM_TERMS),
  pass: { score: PASS, gates: BLOOM_GATES },
  tolerance: 'default',
  tiers: TIERS,
});

// ---------------------------------------------------------------- 08 On/off switching
const SWITCH_TERMS = {
  'vibrato.switchCleanRate': 0.45, 'vibrato.inZone': 0.2, 'vibrato.absCenteringCents': 0.2, 'vibrato.regularity': 0.15,
} as const;
const SWITCH_GATES = [gate('vibrato.switchCleanRate', 'studio'), gate('vibrato.inZone', 'studio'), onTheNote('vibrato.absCenteringCents', 'studio')];

export const vibratoSwitch = defineExercise({
  id: 'vibrato.switch.1',
  worldId: W,
  kind: 'vibrato-switch',
  title: 'On/off switching',
  goal: 'Switch between straight tone and vibrato on each cue without re-attacking the note.',
  pattern: [
    ...segments(0, [[CUE.straight, 2], [CUE.vibrato, 2], [CUE.straight, 2], [CUE.vibrato, 2], [CUE.straight, 2]]),
    rest(2),
    ...segments(3, [[CUE.vibrato, 2], [CUE.straight, 2], [CUE.vibrato, 2], [CUE.straight, 2]]),
  ],
  tempoBpm: 60,
  tonicPlacement: 'mid',
  countInBeats: 4,
  metronome: true,
  demo: STYLE_DEMO,
  analyzers: ['switch', 'vibrato'],
  scoring: terms('studio', SWITCH_TERMS),
  pass: { score: PASS, gates: SWITCH_GATES },
  tolerance: 'studio',
  tiers: TIERS,
});

// ---------------------------------------------------------------- 09 Boss Recital
/** One take: bloom on cue, switch off and on as the line moves, then bloom the top note. A breath between notes. */
export const vibratoBoss = defineExercise({
  id: 'vibrato.boss-recital',
  worldId: W,
  kind: 'boss-recital',
  title: 'Vibrato Boss Recital',
  goal: 'In one take: bloom on cue, switch the vibrato off and on as the line climbs, then bloom the top note.',
  pattern: [
    ...segments(0, [[CUE.straight, 3], [CUE.bloom, 3]]),
    rest(1),
    ...segments(4, [[CUE.vibrato, 2], [CUE.straight, 2], [CUE.vibrato, 2]]),
    rest(1),
    ...segments(7, [[CUE.straight, 2], [CUE.bloom, 4]]),
  ],
  tempoBpm: 60,
  tonicPlacement: 'fit-span',
  countInBeats: 4,
  metronome: true,
  demo: STYLE_DEMO,
  analyzers: ['switch', 'vibrato'],
  scoring: terms('studio', {
    'vibrato.switchCleanRate': 0.3, 'vibrato.bloomOnCue': 0.2, 'vibrato.inZone': 0.2, 'vibrato.absCenteringCents': 0.15,
    'vibrato.regularity': 0.15,
  }),
  pass: {
    score: PASS,
    gates: [
      gate('vibrato.switchCleanRate', 'studio'), gate('vibrato.bloomOnCue', 'studio'), gate('vibrato.inZone', 'studio', CORE_POINT),
      onTheNote('vibrato.absCenteringCents', 'studio'),
    ],
  },
  tolerance: 'studio',
  tiers: TIERS,
});

// ---------------------------------------------------------------- Audition
export const vibratoAudition1 = defineExercise({
  id: 'vibrato.audition.1',
  worldId: W,
  kind: 'audition',
  title: 'Audition: pulses',
  goal: 'Three even pulses per click on one note, then a step higher.',
  pattern: [
    ...pulses(0, 18, 1 / 3, { cue: 'Three pulses per click, even and connected', syllable: 'ah' }),
    rest(1),
    ...pulses(2, 18, 1 / 3, { syllable: 'ah' }),
  ],
  tempoBpm: 90,
  tonicPlacement: 'fit-span',
  countInBeats: 4,
  metronome: true,
  demo: { timbre: 'soft', vibrato: null },
  analyzers: ['pulse', 'accuracy'],
  scoring: terms('default', PULSE_TERMS),
  pass: { score: PASS, gates: [gate('pulse.rateErrorHz', 'default'), onTheNote('accuracy.absBiasCents', 'default')] },
  tolerance: 'default',
  tiers: TIERS,
});

export const vibratoAudition2 = defineExercise({
  id: 'vibrato.audition.2',
  worldId: W,
  kind: 'audition',
  title: 'Audition: free vibrato',
  goal: 'Two sustained notes with free, even vibrato inside the zone.',
  pattern: [note(0, 5, { cue: 'Let the vibrato spin freely', syllable: 'ah' }), rest(1), note(4, 5, { syllable: 'ah' })],
  tempoBpm: 60,
  tonicPlacement: 'mid',
  countInBeats: 2,
  metronome: false,
  demo: STYLE_DEMO,
  analyzers: ['vibrato'],
  scoring: terms('default', FREE_TERMS),
  pass: { score: PASS, gates: FREE_GATES },
  tolerance: 'default',
  tiers: TIERS,
});

export const vibratoAudition3 = defineExercise({
  id: 'vibrato.audition.3',
  worldId: W,
  kind: 'audition',
  title: 'Audition: bloom',
  goal: 'A straight tone, then vibrato that blooms exactly on the cue, twice.',
  pattern: [...segments(0, [[CUE.straight, 3], [CUE.bloom, 3]]), rest(2), ...segments(2, [[CUE.straight, 2], [CUE.bloom, 3]])],
  tempoBpm: 60,
  tonicPlacement: 'mid',
  countInBeats: 4,
  metronome: true,
  demo: STYLE_DEMO,
  analyzers: ['switch', 'vibrato'],
  scoring: terms('default', BLOOM_TERMS),
  pass: { score: PASS, gates: BLOOM_GATES },
  tolerance: 'default',
  tiers: TIERS,
});

export const vibratoAudition4 = defineExercise({
  id: 'vibrato.audition.4',
  worldId: W,
  kind: 'audition',
  title: 'Audition: switching',
  goal: 'Straight, vibrato, straight, vibrato, straight on one held note.',
  pattern: segments(0, [[CUE.straight, 2], [CUE.vibrato, 2], [CUE.straight, 2], [CUE.vibrato, 2], [CUE.straight, 2]]),
  tempoBpm: 60,
  tonicPlacement: 'mid',
  countInBeats: 4,
  metronome: true,
  demo: STYLE_DEMO,
  analyzers: ['switch', 'vibrato'],
  scoring: terms('studio', SWITCH_TERMS),
  pass: { score: PASS, gates: SWITCH_GATES },
  tolerance: 'studio',
  tiers: TIERS,
});

export const VIBRATO_EXERCISES: readonly ExerciseDef[] = [
  oscillation1, oscillation2, pulse1, pulse2, pulse3, freeVibrato, straightToBloom, vibratoSwitch, vibratoBoss,
  vibratoAudition1, vibratoAudition2, vibratoAudition3, vibratoAudition4,
];

const audition: AuditionDef = {
  id: 'vibrato.audition',
  worldId: W,
  exerciseIds: [vibratoAudition1.id, vibratoAudition2.id, vibratoAudition3.id, vibratoAudition4.id],
  unlockThrough: ['vibrato.04', 'vibrato.06', 'vibrato.07', 'vibrato.08'],
};

export const VIBRATO: WorldDef = {
  id: W,
  title: 'Vibrato',
  accent: '--world-vibrato',
  summary: 'Build vibrato from slow alternations and pulses, then bloom it on cue and switch it on and off at will.',
  levels: [
    level(W, 1, 'Oscillation I', oscillation1.id),
    level(W, 2, 'Oscillation II', oscillation2.id),
    level(W, 3, 'Pulse builder I', pulse1.id),
    level(W, 4, 'Pulse builder II', pulse2.id),
    level(W, 5, 'Pulse builder III', pulse3.id),
    level(W, 6, 'Free vibrato', freeVibrato.id),
    level(W, 7, 'Straight to bloom', straightToBloom.id),
    level(W, 8, 'On/off switching', vibratoSwitch.id),
    bossLevel(W, 9, vibratoBoss.id),
  ],
  audition,
  unlockedBy: 'foundations.boss',
};
