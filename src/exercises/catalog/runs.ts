/**
 * Runs & Riffs (SPEC §9.4): a pattern library of pentatonic and blues
 * fragments (3, 5 and 7 notes, ascending and descending) sung as sixteenths,
 * each landing on a held note, then a breath.
 *
 * Tempo ladders: rungs come from CONFIG.runs.tempoLadderNps (notes per second;
 * bpm = nps x 15 for sixteenths). Practice starts at tempoLadder[0], and the
 * runner moves up one rung after each take that passes the level's own pass
 * rule at the rung it was sung at (ladder.ts nextTempo). `tempoBpm` is the
 * level's PASS tempo, always the top rung: the level passes only when the pass
 * rule holds at that tempo. Auditions test at the pass tempo directly (no
 * ladder).
 *
 * The tier sets how precisely each note must land twice over: the run
 * analyzer scores note accuracy against the level's tolerance (a miss of 2.5
 * tolerances scores 0, analysis/runs.ts), and the tier picks the score bands.
 * Reaching a note (CONFIG.runs.reachedTolCents) and its definition do not
 * depend on the tier; tempo and length carry the rest of the difficulty.
 */
import { CONFIG } from '../../config';
import type { ToleranceLevel } from '../../core/types';
import type { AuditionDef, ExerciseDef, PatternStep, WorldDef } from '../types';
import { CORE_POINT, PASS, TIERS, gate, terms } from './scoring';
import { bossLevel, defineExercise, level, line, note, rest } from './steps';

const W = 'runs' as const;
/** Run notes are sixteenths. */
const RUN_UNIT = 0.25;
const RUN_TERMS = { 'run.score': 0.5, 'run.definedRate': 0.35, 'run.missedRate': 0.15 } as const;
/** Every note distinct is the world's core skill (gated half way up its band), and no note may go missing. */
const runGates = (tol: ToleranceLevel) => [gate('run.definedRate', tol, CORE_POINT), gate('run.missedRate', tol)];

/** bpm for a notes-per-second rung (sixteenths). */
export function npsToBpm(nps: number): number {
  return Math.round(nps * 60 * RUN_UNIT);
}

/** Ladder rungs (bpm) for the CONFIG.runs.tempoLadderNps values between two notes-per-second bounds, inclusive. */
export function ladder(fromNps: number, toNps: number): number[] {
  return CONFIG.runs.tempoLadderNps.filter((n) => n >= fromNps && n <= toNps).map(npsToBpm);
}

/** One run: sixteenths, the last note held a beat, then a breath that rounds the bar to a whole beat. */
function run(semis: readonly number[], cue?: string): PatternStep[] {
  const head = semis.slice(0, -1);
  const runBeats = head.length * RUN_UNIT + 1;
  const breath = Math.ceil(runBeats) - runBeats + 1;
  return [...line(head, RUN_UNIT, cue ? { cue } : undefined, 'ah'), note(semis[semis.length - 1], 1, { syllable: 'ah' }), rest(breath)];
}

interface RunSpec {
  n: number;
  title: string;
  goal: string;
  semis: readonly number[];
  tolerance: ToleranceLevel;
  /** Ladder bounds, notes per second (CONFIG rungs). */
  nps: readonly [number, number];
  repeats: { count: number; stepSemis: number };
  cue: string;
  pass?: number;
}

function runLevel(s: RunSpec): ExerciseDef {
  const rungs = ladder(s.nps[0], s.nps[1]);
  return defineExercise({
    id: `runs.run.${s.n}`,
    worldId: W,
    kind: 'run',
    title: s.title,
    goal: s.goal,
    pattern: run(s.semis, s.cue),
    tempoBpm: rungs[rungs.length - 1],
    tonicPlacement: 'fit-span',
    repeats: s.repeats,
    countInBeats: 4,
    metronome: true,
    demo: { timbre: 'piano', vibrato: null, slowFirst: true },
    analyzers: ['run'],
    scoring: terms(s.tolerance, RUN_TERMS),
    pass: { score: s.pass ?? PASS, gates: runGates(s.tolerance) },
    tolerance: s.tolerance,
    tiers: TIERS,
    tempoLadder: rungs,
  });
}

// ---------------------------------------------------------------- 01-08 Pattern library
export const run1 = runLevel({
  n: 1, title: 'Three-note drop', semis: [4, 2, 0], tolerance: 'easy', nps: [3, 4.5], repeats: { count: 4, stepSemis: 1 },
  cue: 'Mi-re-do, every note distinct',
  goal: 'A three-note pentatonic drop, each note its own tiny landing, moving up a half step each time.',
});
export const run2 = runLevel({
  n: 2, title: 'Three-note lift', semis: [0, 3, 5], tolerance: 'easy', nps: [3, 4.5], repeats: { count: 4, stepSemis: 1 },
  cue: 'Up the minor pentatonic',
  goal: 'Three notes up the minor pentatonic, light and distinct, moving up a half step each time.',
});
export const run3 = runLevel({
  n: 3, title: 'Pentatonic five, down', semis: [9, 7, 4, 2, 0], tolerance: 'default', nps: [3, 6], repeats: { count: 3, stepSemis: 1 },
  cue: 'Five notes down, all distinct',
  goal: 'Five notes down the major pentatonic, every one defined, landing centred on the home note.',
});
export const run4 = runLevel({
  n: 4, title: 'Pentatonic five, up', semis: [0, 3, 5, 7, 10], tolerance: 'default', nps: [3, 6], repeats: { count: 3, stepSemis: 1 },
  cue: 'Five notes up, light at the top',
  goal: 'Five notes up the minor pentatonic, staying light as the run climbs.',
});
export const run5 = runLevel({
  n: 5, title: 'Blues five', semis: [7, 6, 5, 3, 0], tolerance: 'default', nps: [3, 6], repeats: { count: 3, stepSemis: 1 },
  cue: 'Blues: touch the flat five',
  goal: 'A five-note blues descent through the flat five, each chromatic step clear.',
});
export const run6 = runLevel({
  n: 6, title: 'Seven-note riff', semis: [10, 12, 10, 7, 5, 3, 0], tolerance: 'default', nps: [4.5, 6], repeats: { count: 2, stepSemis: 0 },
  cue: 'Turn at the top, then cascade', pass: 0.62,
  goal: 'A seven-note minor pentatonic riff: turn at the top, then cascade home.',
});
export const run7 = runLevel({
  n: 7, title: 'Blues seven, up', semis: [0, 3, 5, 6, 7, 10, 12], tolerance: 'studio', nps: [4.5, 6], repeats: { count: 2, stepSemis: 0 },
  cue: 'Up the blues scale to the octave',
  goal: 'The whole blues scale up to the octave, every note distinct and in tune.',
});
export const run8 = runLevel({
  n: 8, title: 'Blues seven, down', semis: [12, 10, 7, 6, 5, 3, 0], tolerance: 'studio', nps: [4.5, 9], repeats: { count: 3, stepSemis: 0 },
  cue: 'Down the blues scale, fast and clean',
  goal: 'The blues scale down from the octave at speed, still landing every note.',
});

// ---------------------------------------------------------------- 09 Boss Recital
/** One phrase: up the major pentatonic, down the blues scale, a three-note tag home; climbs to the fastest rung. */
const BOSS_LADDER = ladder(4.5, 9);
export const runsBoss = defineExercise({
  id: 'runs.boss-recital',
  worldId: W,
  kind: 'boss-recital',
  title: 'Runs & Riffs Boss Recital',
  goal: 'In one phrase: up the pentatonic, down the blues scale and a short tag home, every note distinct, at full speed.',
  pattern: [
    ...line([0, 2, 4, 7, 9], RUN_UNIT, { cue: 'Up the pentatonic' }, 'ah'),
    note(12, 0.75, { syllable: 'ah' }),
    ...line([10, 7, 6, 5, 3], RUN_UNIT, { cue: 'Blues down' }, 'ah'),
    note(0, 0.75, { syllable: 'ah' }),
    ...line([4, 2], RUN_UNIT, { cue: 'Tag home' }, 'ah'),
    note(0, 1.5, { syllable: 'ah' }),
    rest(2),
  ],
  tempoBpm: BOSS_LADDER[BOSS_LADDER.length - 1],
  tonicPlacement: 'fit-span',
  repeats: { count: 2, stepSemis: 0 },
  countInBeats: 4,
  metronome: true,
  demo: { timbre: 'piano', vibrato: null, slowFirst: true },
  analyzers: ['run'],
  scoring: terms('studio', RUN_TERMS),
  pass: { score: PASS, gates: runGates('studio') },
  tolerance: 'studio',
  tiers: TIERS,
  tempoLadder: BOSS_LADDER,
});

// ---------------------------------------------------------------- Audition (fixed tempo = the level's pass tempo)
function runAudition(n: number, title: string, goal: string, runs: ReadonlyArray<readonly number[]>, tolerance: ToleranceLevel, bpm: number): ExerciseDef {
  return defineExercise({
    id: `runs.audition.${n}`,
    worldId: W,
    kind: 'audition',
    title,
    goal,
    pattern: runs.flatMap((r, i) => run(r, i === 0 ? 'Every note distinct' : undefined)),
    tempoBpm: bpm,
    tonicPlacement: 'fit-span',
    countInBeats: 4,
    metronome: true,
    demo: { timbre: 'piano', vibrato: null, slowFirst: true },
    analyzers: ['run'],
    scoring: terms(tolerance, RUN_TERMS),
    pass: { score: PASS, gates: runGates(tolerance) },
    tolerance,
    tiers: TIERS,
  });
}

export const runsAudition1 = runAudition(1, 'Audition: three-note riffs', 'Two three-note riffs, down and then up.',
  [[4, 2, 0], [0, 3, 5]], 'easy', run2.tempoBpm);
export const runsAudition2 = runAudition(2, 'Audition: five-note riffs', 'Pentatonic down, pentatonic up, then the blues five.',
  [[9, 7, 4, 2, 0], [0, 3, 5, 7, 10], [7, 6, 5, 3, 0]], 'default', run5.tempoBpm);
export const runsAudition3 = runAudition(3, 'Audition: seven-note runs', 'The blues scale up to the octave and back down, then the seven-note riff, at speed.',
  [[0, 3, 5, 6, 7, 10, 12], [12, 10, 7, 6, 5, 3, 0], [10, 12, 10, 7, 5, 3, 0]], 'studio', run8.tempoBpm);

export const RUNS_EXERCISES: readonly ExerciseDef[] = [
  run1, run2, run3, run4, run5, run6, run7, run8, runsBoss, runsAudition1, runsAudition2, runsAudition3,
];

const audition: AuditionDef = {
  id: 'runs.audition',
  worldId: W,
  exerciseIds: [runsAudition1.id, runsAudition2.id, runsAudition3.id],
  unlockThrough: ['runs.02', 'runs.05', 'runs.08'],
};

export const RUNS: WorldDef = {
  id: W,
  title: 'Runs & Riffs',
  accent: '--world-runs',
  summary: 'Pentatonic and blues runs with every note distinct, climbing from slow to fast.',
  levels: [
    level(W, 1, run1.title, run1.id),
    level(W, 2, run2.title, run2.id),
    level(W, 3, run3.title, run3.id),
    level(W, 4, run4.title, run4.id),
    level(W, 5, run5.title, run5.id),
    level(W, 6, run6.title, run6.id),
    level(W, 7, run7.title, run7.id),
    level(W, 8, run8.title, run8.id),
    bossLevel(W, 9, runsBoss.id),
  ],
  audition,
  unlockedBy: 'inflections.boss',
};
