/**
 * Progression contract (SPEC §11). Everything is earned: this module is the
 * SINGLE gate for levels, worlds, features, settings, readouts and songs.
 * Locked items are visible but cannot be opened (router guard + UI).
 */
import type { WorldId } from '../exercises/types';

export type LevelStatus = 'locked' | 'current' | 'passed';
/** 0 = not passed, 1 = pass, 2 = solid, 3 = studio (tally lights). */
export type Mastery = 0 | 1 | 2 | 3;

export interface LevelProgress {
  levelId: string;
  status: LevelStatus;
  bestScore: number; //       0..1
  mastery: Mastery;
  attempts: number;
  passedAt: string | null;
  /** True when unlocked by a placement audition rather than played through. */
  viaAudition: boolean;
}

/** Derived (and cached) per-profile progression snapshot. Source of truth = the attempt log. */
export interface ProgressSnapshot {
  profileId: string;
  computedAt: string;
  levels: Record<string, LevelProgress>;
  worldsUnlocked: WorldId[];
  /** Feature ids currently unlocked (see FEATURES). */
  features: string[];
  /** Momentum: slow decay, never resets to zero, rest days are healthy. */
  momentum: number;
  lastPracticeDay: string | null;
  /**
   * Personal records: "<exerciseId>:<metric>" -> best value + attempt id (progress/records.ts: recordKey,
   * recordsForExercise). From passed attempts only; two-sided metrics (vibrato rate/extent) keep none.
   */
  records: Record<string, { value: number; attemptId: string; at: string }>;
}

/**
 * Feature registry ids. Each maps to a requirement in progress/unlocks.ts.
 * Readouts and settings are features too (progressive disclosure).
 */
export type FeatureId =
  | 'live.basic' //               note, cents, Hz, dB (start)
  | 'live.cracks' //              crack markers (after Sirens & glides)
  | 'live.onset' //               settle/scoop readouts (after Crispness)
  | 'live.vibrato' //             vibrato rate/extent/zone readouts (Vibrato world)
  | 'tool.vibrato-meter' //       free-sing vibrato meter tool (Vibrato world)
  | 'setting.vibratoStyle' //     pop vs classical zone (Vibrato world)
  | 'dashboard' //                progress dashboard (first level passed)
  | 'daily-workout' //            (first level passed)
  | 'song-stage' //               Song Stage (Foundations boss)
  | 'song.import' //              import own MIDI/UltraStar (Foundations boss)
  | 'records' //                  personal-record attempts (per passed exercise)
  | 'export'; //                  backup/export (always; utility)

export interface Requirement {
  kind: 'start' | 'levelPassed' | 'worldUnlocked';
  ref?: string;
  /** One line for locked tiles, e.g. "Pass Sustain II to unlock". */
  hint: string;
}
