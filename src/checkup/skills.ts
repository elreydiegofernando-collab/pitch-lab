/**
 * The check-up's skills as the app trains them: the Foundations levels behind each one (the levels its placement test
 * covers, so "focus on slides" means Small slides and Sirens), and plain names for labels and sentences. Pure data.
 */
import type { CheckupSkill } from './types';

/**
 * Every skill, in catalog order: the order of the first level that trains it (Range finder, Match one note, Hold it, Two
 * notes one step apart, Three notes: do-re-mi, Small slides). checkup/summary.test.ts holds it to the catalog.
 */
export const CHECKUP_SKILLS: readonly CheckupSkill[] = ['range', 'pitch', 'steadiness', 'starts', 'connected', 'slides'];

/**
 * The Foundations levels that train each skill (catalog level ids, in level order). They are the audition spans of the
 * test that measures the skill: Match and hold covers Match one note to Hold it steady (pitch, then steadiness), the two
 * notes near and far the step and jump lessons, the connected line do-re-mi and Five notes in a row, the siren Small
 * slides and Sirens. The Range finder measures rather than trains, so the daily workout never offers it
 * (progress/workout.ts), whatever the focus.
 */
export const SKILL_LEVELS: Readonly<Record<CheckupSkill, readonly string[]>> = {
  range: ['foundations.01'],
  pitch: ['foundations.02'],
  steadiness: ['foundations.03', 'foundations.13'],
  starts: ['foundations.10', 'foundations.07', 'foundations.08'],
  connected: ['foundations.11', 'foundations.09'],
  slides: ['foundations.12', 'foundations.05'],
};

/** Plain names: `label` for a list or a line ("Slides"), `words` inside a sentence ("your slides got better"). */
export const SKILL_NAMES: Readonly<Record<CheckupSkill, { label: string; words: string }>> = {
  range: { label: 'Range', words: 'range' },
  pitch: { label: 'Pitch', words: 'pitch' },
  steadiness: { label: 'Steadiness', words: 'steadiness' },
  slides: { label: 'Slides', words: 'slides' },
  starts: { label: 'Note starts', words: 'note starts' },
  connected: { label: 'Connected lines', words: 'connected lines' },
};
