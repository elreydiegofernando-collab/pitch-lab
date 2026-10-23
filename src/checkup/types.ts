/**
 * The voice check-up (owner, 2026-10-22): "the initial profile building should be like a singing, analyzing, like a test
 * to see where you should start off ... if you can hold a note, but you have voice cracking ... you should maybe practice
 * voice cracking. Then you should have like assessment on where you've been and like how you've gotten better."
 *
 * About four minutes of the app's own sung tasks: the Range finder, then the four Foundations placement tests. It
 * gives a skill profile in plain words, a starting point (levels granted exactly as the placement audition grants them:
 * in order, inside Foundations only, never a later world), one or two things to focus on, and, from the second
 * check-up on, a "then and now" comparison. Every task is a normal attempt in the log tagged with the check-up's id
 * (AttemptRecord.checkupId), so a check-up is read back from the log alone and travels with a backup.
 *
 * Contract file (orchestrator-owned): builders report needed changes.
 */
import type { MetricKey } from '../analysis/types';
import type { ProgressLine } from '../coaching/types';

/** What the check-up rates. */
export type CheckupSkill =
  /** How low and high the voice goes comfortably (the Range finder). */
  | 'range'
  /** Hearing a note and singing it back on pitch. */
  | 'pitch'
  /** Holding a note steady without wavering or sinking. */
  | 'steadiness'
  /** Sliding through the range smoothly, without breaks or steps. */
  | 'slides'
  /** Starting notes cleanly on pitch (no scoop, quick to settle). */
  | 'starts'
  /** Moving note to note in a connected line. */
  | 'connected';

/** In plain words, never a grade: "Solid", "Getting there", "Focus here", or not measured (a task skipped or silent). */
export type SkillRating = 'solid' | 'getting-there' | 'focus' | 'not-measured';

export interface CheckupTask {
  /** The catalog exercise sung for this task. */
  exerciseId: string;
  /** Plain title for the run ("Find your range", "Match and hold a note", ...). */
  title: string;
  /** One plain sentence: what to do. */
  ask: string;
  /** The skills this task measures, and the metrics each is read from. */
  skills: ReadonlyArray<{ skill: CheckupSkill; metrics: readonly MetricKey[] }>;
  /** How the take is logged: the Range finder as a practice take of level 01, the tests as audition takes. */
  logAs: { kind: 'practice'; levelId: string } | { kind: 'audition' };
}

/** The battery, in the order it is sung. */
export const CHECKUP_TASKS: readonly CheckupTask[] = [
  {
    exerciseId: 'foundations.range-finder.1',
    title: 'Find your range',
    ask: 'Slide down and up on “oo” and hold your lowest and highest easy notes.',
    skills: [{ skill: 'range', metrics: ['range.spanSemitones'] }],
    logAs: { kind: 'practice', levelId: 'foundations.01' },
  },
  {
    exerciseId: 'foundations.audition.1',
    title: 'Match and hold a note',
    ask: 'Listen to each note, then sing it back and hold it, steady and centred.',
    skills: [
      { skill: 'pitch', metrics: ['accuracy.inTolerancePct', 'accuracy.medianAbsCents'] },
      { skill: 'steadiness', metrics: ['accuracy.sdCents', 'accuracy.absDriftCentsPerSec'] },
    ],
    logAs: { kind: 'audition' },
  },
  {
    exerciseId: 'foundations.audition.2',
    title: 'Slide up and down',
    ask: 'One smooth siren up and back down on “oo”, with no break.',
    skills: [{ skill: 'slides', metrics: ['glide.smoothness', 'glide.cracks', 'glide.endAbsCents'] }],
    logAs: { kind: 'audition' },
  },
  {
    exerciseId: 'foundations.audition.3',
    title: 'Short, clean notes',
    ask: 'Short notes that jump around, each one starting right on the note.',
    skills: [{ skill: 'starts', metrics: ['onset.settleMs', 'onset.scoopCents', 'onset.overshootCents'] }],
    logAs: { kind: 'audition' },
  },
  {
    exerciseId: 'foundations.audition.4',
    title: 'A connected line',
    ask: 'One smooth line of notes up and back, each note arriving clean.',
    skills: [{ skill: 'connected', metrics: ['transition.cleanRate', 'accuracy.inTolerancePct'] }],
    logAs: { kind: 'audition' },
  },
];

/** Suggest a re-check this many days after the last one (never forced). */
export const RECHECK_AFTER_DAYS = 21;

export interface SkillResult {
  skill: CheckupSkill;
  rating: SkillRating;
  /** One plain sentence with plain numbers: "You held each note steady, wavering only a little." */
  what: string;
}

/** One finished check-up, read back from the log (attempts sharing a checkupId). */
export interface CheckupSummary {
  checkupId: string;
  profileId: string;
  startedAt: string;
  finishedAt: string;
  /** Per task, in battery order: the attempt (null when the task was not sung), and how it went. */
  tasks: Array<{ exerciseId: string; title: string; attemptId: string | null; passed: boolean | null; score: number | null }>;
  skills: SkillResult[];
  /** One or two skills to focus on, most important first (empty when everything is solid). */
  focus: CheckupSkill[];
  /** Where to start: the first level that is still to pass after this check-up (null when Foundations is all passed). */
  startLevelId: string | null;
  /** Levels this check-up opened (granted by its placement tests), in order. */
  opened: string[];
  /** The range measured, as note names ("B2–A4"), when the Range finder passed. */
  range: string | null;
}

/** "Then and now": two check-ups of the same singer, the older first. */
export interface CheckupComparison {
  before: CheckupSummary;
  after: CheckupSummary;
  /** Per skill, plain words: "Slides: 5 breaks then, 1 break now", better / not as good / about the same. */
  lines: Array<ProgressLine & { skill: CheckupSkill }>;
  /** One warm sentence summing it up. */
  headline: string;
}
