/**
 * Music words, taught before they are used (owner, 2026-10-23: "you're using a lot of technical terms in the app that I
 * don't know ... why are you using technical terms without teaching me first?").
 *
 * Every music word the app shows is one of these terms: rendered with the Term component (tap to read its plain
 * explanation), and first explained on the Learn page of the lesson that introduces it (LessonDef.learn.terms).
 *
 * Contract file (orchestrator-owned): the ids and words are final; the explanations live in src/teach/glossary-content.ts.
 */
export const TERMS = {
  'pitch': 'pitch',
  'note': 'note',
  'in-tune': 'in tune',
  'sharp': 'sharp',
  'flat': 'flat',
  'in-tune-zone': 'in-tune zone',
  'steady': 'steady',
  'wobble': 'wobble',
  'drift': 'drifting',
  'breath-support': 'breath support',
  'echo': 'echo',
  'step': 'step',
  'jump': 'jump',
  'half-step': 'half step',
  'octave': 'octave',
  'scale': 'scale',
  'do-re-mi': 'do-re-mi',
  'slide': 'slide',
  'siren': 'siren',
  'gear-change': 'gear change',
  'crack': 'crack',
  'clean-start': 'clean start',
  'scoop': 'scoop',
  'beat': 'beat',
  'count-in': 'count-in',
  'phrase': 'phrase',
  'range': 'range',
  'vibrato': 'vibrato',
  'tempo': 'tempo',
} as const;

export type TermId = keyof typeof TERMS;

export const TERM_IDS: readonly TermId[] = Object.keys(TERMS) as TermId[];

export interface GlossaryEntry {
  /** The word as shown ("in-tune zone"). */
  word: string;
  /** One or two plain sentences: what it means. */
  plain: string;
  /** Optional: what it looks like on screen, or an everyday example. */
  example?: string;
}
