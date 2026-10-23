/**
 * Lessons (owner, 2026-10-23): "I feel like this app is more of like a checkpoint slash testing ... versus training and
 * learning ... What about the training? What about the teaching?" and "I don't need the note playing along while I'm
 * singing. I need to know the note before I sing it."
 *
 * So a level is now a LESSON in three parts:
 *   1. Learn: a short teaching page (what, why, how, what you will see on screen), every music word explained the first
 *      time it appears (src/teach/glossary.ts), with a demo to hear.
 *   2. Practise: short guided tries (drills) with no pass or fail. Each drill is ECHO-shaped: the app plays exactly what
 *      to sing (a note, or a few notes), then it is the singer's turn; nothing plays while the singer sings. Each step
 *      asks for a few good tries (a lenient rule); live hints while singing ("a little higher", "on it", "steady").
 *   3. Check: the level's own exercise (its pass rule), once ready. Passing it passes the level, as before.
 * Building blocks: one new thing per lesson, never more notes at once than a beginner can hold in mind.
 *
 * Drill takes are logged as kind 'practice' with levelId null (the progress engine ignores them for level status), so
 * only the check can pass a level. Lesson progress (good tries per step) is read back from the log by drill exercise id.
 *
 * Contract file (orchestrator-owned): builders report needed changes.
 */
import type { MetricKey } from '../analysis/types';
import type { TermId } from '../teach/glossary';

/** The teaching page of a lesson. Plain words for someone relearning to sing (no cents, Hz, semitones or bpm). */
export interface LearnPage {
  /** What the skill is, in one or two plain sentences. */
  what: string;
  /** Why it matters for singing, in one or two sentences. */
  why: string;
  /** How to do it: 3 to 5 short steps. */
  how: readonly string[];
  /** What the singer will see on screen while singing, and what it means (the bars, the shaded band, the line). */
  onScreen: readonly string[];
  /** Music words this lesson teaches (each shown as a tap-to-explain term, and first explained here). */
  terms: readonly TermId[];
}

/** What counts as a good try in practice: lenient, every condition must hold (no condition = any try sung to its end). */
export interface GoodTryRule {
  conditions: ReadonlyArray<{ metric: MetricKey; op: '<=' | '>='; value: number }>;
}

/** One practice step: a short echo-shaped drill, done until it has `goodTries` good tries. */
export interface PracticeStep {
  /** The drill's catalog exercise id (a short exercise, never a level's own exercise). */
  exerciseId: string;
  /** Plain title: "Echo one note, 2 seconds". */
  title: string;
  /** One plain sentence: what to do on this step. */
  ask: string;
  /** Good tries needed before the next step (typically 2 or 3). */
  goodTries: number;
  good: GoodTryRule;
}

export interface LessonDef {
  /** The level this lesson teaches (a catalog level id); its exercise is the check. */
  levelId: string;
  /** Plain title: "Hold it steady". */
  title: string;
  /** One plain line under the title: what you will be able to do after this lesson. */
  outcome: string;
  learn: LearnPage;
  practice: readonly PracticeStep[];
}

/** One lesson's progress for a profile, read back from the log. */
export interface LessonProgress {
  levelId: string;
  /** Per practice step: good tries so far (capped at the step's goodTries) and all tries. */
  steps: ReadonlyArray<{ exerciseId: string; good: number; needed: number; tries: number; done: boolean }>;
  /** The first step not yet done; practice.length when all are done. */
  currentStep: number;
  /** Every practice step done: the check is the suggested next move. */
  ready: boolean;
  /** The level is passed (its check passed, or granted). */
  passed: boolean;
}
