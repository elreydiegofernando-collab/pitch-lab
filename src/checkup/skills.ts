/**
 * The check-up's skills as the app trains them: the Foundations levels behind each one (the levels its placement test
 * covers, so "focus on slides" means Sirens & glides), and plain names for labels and sentences. Pure data.
 */
import type { CheckupSkill } from './types';

/** Every skill, in catalog order: the order of the first level that trains it (Range finder 01 ... Legato lines 09). */
export const CHECKUP_SKILLS: readonly CheckupSkill[] = ['range', 'pitch', 'steadiness', 'slides', 'starts', 'connected'];

/**
 * The Foundations levels that train each skill (catalog level ids, in order). They are the audition spans of the test
 * that measures the skill: Match and hold covers Pitch match to Sustain II, the siren Sirens & glides, the short notes
 * Crispness to Interval jumps II, the connected line Legato lines. The Range finder measures rather than trains, so the
 * daily workout never offers it (progress/workout.ts), whatever the focus.
 */
export const SKILL_LEVELS: Readonly<Record<CheckupSkill, readonly string[]>> = {
  range: ['foundations.01'],
  pitch: ['foundations.02'],
  steadiness: ['foundations.03', 'foundations.04'],
  slides: ['foundations.05'],
  starts: ['foundations.06', 'foundations.07', 'foundations.08'],
  connected: ['foundations.09'],
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
