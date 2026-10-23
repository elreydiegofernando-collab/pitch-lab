/**
 * Exercise, level and world definitions (Phase 3+). Every exercise is DATA:
 * target notes and timings (relative to a tonic so they auto-transpose to the
 * singer's saved range), tempo, which analyzers score it, tolerance, pass rules.
 */
import type { ToleranceLevel } from '../core/types';
import type { MetricKey } from '../analysis/types';
import type { Timbre, VibratoSpec } from '../audio/synth-types';

export type WorldId = 'foundations' | 'vibrato' | 'inflections' | 'runs' | 'dynamics' | 'song-stage';

export type ExerciseKind =
  // Foundations
  | 'range-finder' | 'pitch-match' | 'sustain' | 'siren' | 'staccato' | 'intervals' | 'legato'
  // Vibrato
  | 'vibrato-meter' | 'pulse-builder' | 'oscillation' | 'straight-to-bloom' | 'vibrato-switch'
  // Inflections
  | 'scoop' | 'fall' | 'slide' | 'turn' | 'flip'
  // Runs & riffs
  | 'run'
  // Dynamics
  | 'swell'
  // Capstones
  | 'boss-recital' | 'audition';

export type AnalyzerId =
  | 'accuracy' | 'onset' | 'vibrato' | 'glide' | 'cracks' | 'transitions' | 'inflection' | 'run' | 'dynamics' | 'range' | 'pulse' | 'switch';

/** One step of material, relative to the tonic (so it transposes). */
export interface PatternStep {
  /** Semitones above (+) or below (-) the tonic. Omit for a rest. */
  semis?: number;
  /** Duration in beats at the exercise tempo. */
  beats: number;
  /** For glides/slides/sirens: arrive at this offset by the end of the step. */
  glideToSemis?: number;
  /** On-screen cue for the singer (e.g. "straight", "bloom", "vibrato on", "swell"). */
  cue?: string;
  /** Sung syllable/vowel hint (e.g. "ah", "nee"). */
  syllable?: string;
}

/** Where to place the tonic inside the saved range before transposing. */
export type TonicPlacement = 'low' | 'mid' | 'high' | 'passaggio' | 'fit-span';

export interface ScoreTerm {
  metric: MetricKey;
  weight: number;
  /** Value that maps to a perfect 1.0 ... */
  best: number;
  /** ... and the value that maps to 0 (linear in between, clamped). best may be < worst. */
  worst: number;
}

export interface PassRule {
  /** Minimum overall score 0..1. */
  score: number;
  /** Hard gates that must also hold. */
  gates?: Array<{ metric: MetricKey; op: '<=' | '>='; value: number }>;
}

export interface ExerciseDef {
  id: string; //                         e.g. "foundations.steady.1" (persisted in attempts: new content takes a new id)
  worldId: WorldId;
  kind: ExerciseKind;
  title: string;
  /** One sentence, shown before singing. */
  goal: string;
  /**
   * Plain-language steps shown on the level screen ("How it goes"), written for someone relearning to sing: no jargon
   * (owner, 2026-10-22). Optional while the catalog is reworded level by level.
   */
  steps?: string[];
  /** The pass rule in plain words, shown on the level screen instead of the generated lines ("Score ≥ 60%"). */
  passPlain?: string;
  pattern: PatternStep[];
  tempoBpm: number;
  tonicPlacement: TonicPlacement;
  /** Repeat the pattern N times, moving the tonic by `stepSemis` each time (e.g. ascending scales). */
  repeats?: { count: number; stepSemis: number };
  /** Count-in beats before singing (metronome clicks). */
  countInBeats: number;
  metronome: boolean;
  /** How the Listen demo is synthesized. 'style' = use the vibrato style zone midpoint. */
  demo: { timbre: Timbre; vibrato?: VibratoSpec | 'style' | null; slowFirst?: boolean };
  analyzers: AnalyzerId[];
  scoring: ScoreTerm[];
  pass: PassRule;
  tolerance: ToleranceLevel;
  /** Score thresholds for mastery tally lights 2 (solid) and 3 (studio). Light 1 = pass. */
  tiers: { solid: number; studio: number };
  /**
   * Tempo ladder (runs): bpm values, slowest first, the last being `tempoBpm`. Practice climbs it one rung after a
   * take that PASSES this exercise's own pass rule at the rung it was sung at (exercises/ladder.ts nextTempo; a
   * fixed run.score mark trapped the studio ladders), and only a take at `tempoBpm` can PASS the level
   * (canPassAtTempo: progress/attempt.ts writes it into the attempt and the progression engine enforces it again).
   */
  tempoLadder?: number[];
  /** Coaching-tip ids relevant to this exercise (see coaching tips table). */
  tipIds?: string[];
  /**
   * Set (to the day it happened) on an exercise that is no longer sung because its world was rebuilt: it stays in the
   * catalog only so the takes sung against it read back against what they were sung against (titles, replays, check-ups,
   * coaching files). No level, audition or lesson plays it, and the registry never opens it (catalog/foundations-retired.ts).
   */
  retired?: string;
}

export interface LevelDef {
  id: string; //                         e.g. "foundations.03" (persisted in attempts: never renamed)
  worldId: WorldId;
  /** Order within the world (1-based in the catalog; only the order matters). */
  index: number;
  title: string;
  exerciseId: string;
  kind: 'level' | 'boss';
}

export interface AuditionDef {
  id: string;
  worldId: WorldId;
  /** Short sung tests drawn from the world's levels, at their pass rules. */
  exerciseIds: string[];
  /**
   * Passing exercise i unlocks the levels past what the earlier tests reach, up to and including unlockThrough[i]
   * (level ids): never beyond the world, never the Boss Recital, never the Range finder (it is always sung). Tests are
   * sung IN ORDER, stopping at the first miss: progress opens only the next test (nextAuditionExercise) and counts a
   * test only once every earlier level is passed (auditionSpans says which levels a test covers).
   */
  unlockThrough: string[];
  /**
   * The audition as it was before its world was rebuilt (Foundations as lessons, 2026-10-23), so a pass of one of its
   * tests, sung then, keeps what it granted (progress/engine.ts): its tests are retired exercises, judged in the order and
   * against the levels they were sung under, and they grant only the levels of the world now that still teach what they
   * judged. Absent for an audition that was never rebuilt.
   */
  former?: {
    /** The world's levels then, in their order then (the ids they had: a level since removed keeps its id here). */
    levelIds: readonly string[];
    /** The tests then, in the order they were sung, with the last level each reached then (as exerciseIds / unlockThrough). */
    exerciseIds: readonly string[];
    unlockThrough: readonly string[];
    /** The levels of the world now that still teach what a former test judged: the only ones a former pass grants. */
    keeps: readonly string[];
  };
}

export interface WorldDef {
  id: WorldId;
  title: string;
  /** Quiet hue accent token name (DESIGN.md §10). */
  accent: string;
  summary: string;
  levels: LevelDef[]; // last one is the Boss Recital (kind 'boss')
  audition: AuditionDef | null;
  /** World unlocked when this level id is passed (null = available at start). */
  unlockedBy: string | null;
}

export interface CoachingTip {
  id: string;
  /** When this tip applies: a metric condition on the attempt. */
  when: { metric: MetricKey; op: '<=' | '>='; value: number };
  text: string; //  coach-like, specific, one or two sentences
  priority: number;
}
