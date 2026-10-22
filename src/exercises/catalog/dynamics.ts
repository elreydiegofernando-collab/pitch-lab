/**
 * Dynamics (SPEC §9.5): crescendo, decrescendo, sudden soft/loud steps and
 * messa di voce, each on ONE held note (the dynamics analyzer works per note)
 * with the pitch kept still. Loudness is relative (uncalibrated mic): the
 * scored quantities are the level range, the cents-per-dB slope (target ~0,
 * RESEARCH §6) and, for swells only, the envelope's symmetry (the Swell cue
 * tells plan.ts which holds are swells). The range only counts loudness that
 * moved the way each hold's cue asked (crescendo, decrescendo, swell or the
 * named soft/loud steps; exercises/loudness.ts), and only when most holds
 * did, so the range gate on every level also fails a take sung the opposite
 * way. Pitch steadiness is judged by the centre (bias, gated at the level's
 * own tolerance) and the slope rather than time in the band, because a
 * singer who has passed the Vibrato world may rightly use vibrato on long
 * swells. Holds lengthen 4 -> 8 s and the placement climbs to the passaggio,
 * where pitch slips most.
 */
import { CUE } from '../cues';
import type { ToleranceLevel } from '../../core/types';
import type { AuditionDef, ExerciseDef, WorldDef } from '../types';
import { PASS, TIERS, gate, onTheNote, swellRangeGate, terms } from './scoring';
import { bossLevel, defineExercise, level, note, rest } from './steps';

const W = 'dynamics' as const;
/** Sudden steps on one held note, two clicks each (src/audio/demos.ts reads these words as abrupt steps). */
const STEPS_SLS = 'Soft, loud, soft: change every two clicks';
const STEPS_LSL = 'Loud, soft, loud: change every two clicks';
const STEPS_SLSL = 'Soft, loud, soft, loud: change every two clicks';

const ONE_WAY_TERMS = { 'dynamics.rangeDb': 0.35, 'dynamics.absSlopeCentsPerDb': 0.4, 'accuracy.absBiasCents': 0.25 } as const;
const SWELL_TERMS = {
  'dynamics.rangeDb': 0.25, 'dynamics.absSlopeCentsPerDb': 0.35, 'dynamics.symmetry': 0.15, 'accuracy.absBiasCents': 0.25,
} as const;
const STEP_TERMS = { 'dynamics.rangeDb': 0.3, 'dynamics.absSlopeCentsPerDb': 0.45, 'accuracy.absBiasCents': 0.25 } as const;
/** Every level: enough loudness change, made the way the cues ask; pitch that ignores it; a centre within the level's tolerance. */
const steadyGates = (tol: ToleranceLevel) => [swellRangeGate(), gate('dynamics.absSlopeCentsPerDb', tol), onTheNote('accuracy.absBiasCents', tol)];

// ---------------------------------------------------------------- 01-02 One-way
export const crescendo = defineExercise({
  id: 'dynamics.swell.1',
  worldId: W,
  kind: 'swell',
  title: 'Crescendo',
  goal: 'Grow each note from soft to full while the pitch line stays flat.',
  pattern: [
    note(0, 4, { cue: CUE.crescendo, syllable: 'ah' }), rest(2),
    note(2, 4, { cue: CUE.crescendo, syllable: 'ah' }), rest(2),
    note(4, 4, { cue: CUE.crescendo, syllable: 'ah' }),
  ],
  tempoBpm: 60,
  tonicPlacement: 'mid',
  countInBeats: 2,
  metronome: false,
  demo: { timbre: 'soft', vibrato: null },
  analyzers: ['dynamics', 'accuracy'],
  scoring: terms('easy', ONE_WAY_TERMS),
  pass: { score: PASS, gates: steadyGates('easy') },
  tolerance: 'easy',
  tiers: TIERS,
});

export const decrescendo = defineExercise({
  id: 'dynamics.swell.2',
  worldId: W,
  kind: 'swell',
  title: 'Decrescendo',
  goal: 'Fade each note from full to soft without letting it go flat.',
  pattern: [
    note(4, 4, { cue: CUE.decrescendo, syllable: 'ah' }), rest(2),
    note(2, 4, { cue: CUE.decrescendo, syllable: 'ah' }), rest(2),
    note(0, 4, { cue: CUE.decrescendo, syllable: 'ah' }),
  ],
  tempoBpm: 60,
  tonicPlacement: 'mid',
  countInBeats: 2,
  metronome: false,
  demo: { timbre: 'soft', vibrato: null },
  analyzers: ['dynamics', 'accuracy'],
  scoring: terms('easy', ONE_WAY_TERMS),
  pass: { score: PASS, gates: steadyGates('easy') },
  tolerance: 'easy',
  tiers: TIERS,
});

// ---------------------------------------------------------------- 03 Messa di voce I
export const messa1 = defineExercise({
  id: 'dynamics.swell.3',
  worldId: W,
  kind: 'swell',
  title: 'Messa di voce I',
  goal: 'Six seconds per note: soft, grow to full, fade back to soft, with the pitch perfectly still.',
  pattern: [note(0, 6, { cue: CUE.swell, syllable: 'ah' }), rest(2), note(3, 6, { cue: CUE.swell, syllable: 'ah' })],
  tempoBpm: 60,
  tonicPlacement: 'mid',
  countInBeats: 2,
  metronome: false,
  demo: { timbre: 'soft', vibrato: null },
  analyzers: ['dynamics', 'accuracy'],
  scoring: terms('default', SWELL_TERMS),
  pass: { score: PASS, gates: steadyGates('default') },
  tolerance: 'default',
  tiers: TIERS,
});

// ---------------------------------------------------------------- 04 Dynamic steps
export const dynamicSteps = defineExercise({
  id: 'dynamics.swell.4',
  worldId: W,
  kind: 'swell',
  title: 'Dynamic steps',
  goal: 'Switch suddenly between soft and loud on the clicks while the pitch does not move at all.',
  pattern: [note(0, 6, { cue: STEPS_SLS, syllable: 'ah' }), rest(2), note(2, 6, { cue: STEPS_LSL, syllable: 'ah' })],
  tempoBpm: 60,
  tonicPlacement: 'mid',
  countInBeats: 4,
  metronome: true,
  demo: { timbre: 'soft', vibrato: null },
  analyzers: ['dynamics', 'accuracy'],
  scoring: terms('default', STEP_TERMS),
  pass: { score: PASS, gates: steadyGates('default') },
  tolerance: 'default',
  tiers: TIERS,
});

// ---------------------------------------------------------------- 05-06 Messa di voce II-III
export const messa2 = defineExercise({
  id: 'dynamics.swell.5',
  worldId: W,
  kind: 'swell',
  title: 'Messa di voce II',
  goal: 'Eight-second swells higher in your range, taking as long to fade as to grow.',
  pattern: [note(0, 8, { cue: CUE.swell, syllable: 'ah' }), rest(2), note(2, 8, { cue: CUE.swell, syllable: 'ah' })],
  tempoBpm: 60,
  tonicPlacement: 'high',
  countInBeats: 2,
  metronome: false,
  demo: { timbre: 'soft', vibrato: null },
  analyzers: ['dynamics', 'accuracy'],
  scoring: terms('default', SWELL_TERMS),
  pass: { score: 0.62, gates: steadyGates('default') },
  tolerance: 'default',
  tiers: TIERS,
});

export const messa3 = defineExercise({
  id: 'dynamics.swell.6',
  worldId: W,
  kind: 'swell',
  title: 'Messa di voce III',
  goal: 'Eight-second swells right on your passaggio, where pitch slips most, centred within a few cents.',
  pattern: [note(0, 8, { cue: CUE.swell, syllable: 'ah' }), rest(2), note(1, 8, { cue: CUE.swell, syllable: 'ah' })],
  tempoBpm: 60,
  tonicPlacement: 'passaggio',
  countInBeats: 2,
  metronome: false,
  demo: { timbre: 'soft', vibrato: null },
  analyzers: ['dynamics', 'accuracy'],
  scoring: terms('studio', SWELL_TERMS),
  pass: { score: PASS, gates: steadyGates('studio') },
  tolerance: 'studio',
  tiers: TIERS,
});

// ---------------------------------------------------------------- 07 Boss Recital
/** One take: a passaggio messa di voce, sudden soft/loud steps a tone higher, then a long fade home. */
export const dynamicsBoss = defineExercise({
  id: 'dynamics.boss-recital',
  worldId: W,
  kind: 'boss-recital',
  title: 'Dynamics Boss Recital',
  goal: 'In one take: a messa di voce on the passaggio, sudden soft and loud steps a tone higher, then a long fade home.',
  pattern: [
    note(0, 8, { cue: CUE.swell, syllable: 'ah' }),
    rest(1),
    note(2, 8, { cue: STEPS_SLSL, syllable: 'ah' }),
    rest(1),
    note(0, 6, { cue: CUE.decrescendo, syllable: 'ah' }),
  ],
  tempoBpm: 60,
  tonicPlacement: 'passaggio',
  countInBeats: 4,
  metronome: true,
  demo: { timbre: 'soft', vibrato: null },
  analyzers: ['dynamics', 'accuracy'],
  scoring: terms('studio', SWELL_TERMS),
  pass: { score: PASS, gates: steadyGates('studio') },
  tolerance: 'studio',
  tiers: TIERS,
});

// ---------------------------------------------------------------- Audition
export const dynamicsAudition1 = defineExercise({
  id: 'dynamics.audition.1',
  worldId: W,
  kind: 'audition',
  title: 'Audition: grow and fade',
  goal: 'One crescendo and one decrescendo, pitch steady throughout.',
  pattern: [note(0, 4, { cue: CUE.crescendo, syllable: 'ah' }), rest(2), note(2, 4, { cue: CUE.decrescendo, syllable: 'ah' })],
  tempoBpm: 60,
  tonicPlacement: 'mid',
  countInBeats: 2,
  metronome: false,
  demo: { timbre: 'soft', vibrato: null },
  analyzers: ['dynamics', 'accuracy'],
  scoring: terms('easy', ONE_WAY_TERMS),
  pass: { score: PASS, gates: steadyGates('easy') },
  tolerance: 'easy',
  tiers: TIERS,
});

export const dynamicsAudition2 = defineExercise({
  id: 'dynamics.audition.2',
  worldId: W,
  kind: 'audition',
  title: 'Audition: swell and steps',
  goal: 'One eight-second swell high in your range, then soft-loud-soft steps, pitch still throughout.',
  pattern: [note(0, 8, { cue: CUE.swell, syllable: 'ah' }), rest(2), note(2, 6, { cue: STEPS_SLS, syllable: 'ah' })],
  tempoBpm: 60,
  tonicPlacement: 'high',
  countInBeats: 4,
  metronome: true,
  demo: { timbre: 'soft', vibrato: null },
  analyzers: ['dynamics', 'accuracy'],
  scoring: terms('default', SWELL_TERMS),
  pass: { score: 0.62, gates: steadyGates('default') },
  tolerance: 'default',
  tiers: TIERS,
});

export const dynamicsAudition3 = defineExercise({
  id: 'dynamics.audition.3',
  worldId: W,
  kind: 'audition',
  title: 'Audition: passaggio swell',
  goal: 'One eight-second swell on your passaggio, centred within a few cents.',
  pattern: [note(0, 8, { cue: CUE.swell, syllable: 'ah' })],
  tempoBpm: 60,
  tonicPlacement: 'passaggio',
  countInBeats: 2,
  metronome: false,
  demo: { timbre: 'soft', vibrato: null },
  analyzers: ['dynamics', 'accuracy'],
  scoring: terms('studio', SWELL_TERMS),
  pass: { score: PASS, gates: steadyGates('studio') },
  tolerance: 'studio',
  tiers: TIERS,
});

export const DYNAMICS_EXERCISES: readonly ExerciseDef[] = [
  crescendo, decrescendo, messa1, dynamicSteps, messa2, messa3, dynamicsBoss,
  dynamicsAudition1, dynamicsAudition2, dynamicsAudition3,
];

const audition: AuditionDef = {
  id: 'dynamics.audition',
  worldId: W,
  exerciseIds: [dynamicsAudition1.id, dynamicsAudition2.id, dynamicsAudition3.id],
  unlockThrough: ['dynamics.02', 'dynamics.05', 'dynamics.06'],
};

export const DYNAMICS: WorldDef = {
  id: W,
  title: 'Dynamics',
  accent: '--world-dynamics',
  summary: 'Grow and fade on one note while the pitch stays put: crescendo, decrescendo, sudden steps and messa di voce.',
  levels: [
    level(W, 1, 'Crescendo', crescendo.id),
    level(W, 2, 'Decrescendo', decrescendo.id),
    level(W, 3, 'Messa di voce I', messa1.id),
    level(W, 4, 'Dynamic steps', dynamicSteps.id),
    level(W, 5, 'Messa di voce II', messa2.id),
    level(W, 6, 'Messa di voce III', messa3.id),
    bossLevel(W, 7, dynamicsBoss.id),
  ],
  audition,
  unlockedBy: 'runs.boss',
};
