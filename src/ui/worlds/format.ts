/**
 * Small pure formatters shared by Home, the world map and the audition screens (docs/DESIGN.md 11 and 13: numbers
 * over adjectives, scores read "86%", set-list numbers read "04").
 */
import type { LevelDef, WorldDef } from '../../exercises/types';
import type { Mastery } from '../../progress';

/** Middle dot used between status fragments ("Best 86% · Solid"). */
export const DOT = '·';
/** En dash used in level ranges ("Pitch match – Sustain II"). */
export const DASH = '–';

/** A set-list number: 4 -> "04". */
export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** A 0..1 score as "86%" (clamped; a missing or non-finite score reads 0%). */
export function percent(score: number): string {
  const v = Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
  return `${Math.round(v * 100)}%`;
}

const TIER_LABELS: readonly string[] = ['', 'Passed', 'Solid', 'Studio'];

/** The mastery tier behind a tally-light count: 1 "Passed", 2 "Solid", 3 "Studio"; empty before a pass. */
export function tierLabel(mastery: Mastery): string {
  return TIER_LABELS[mastery] ?? '';
}

/** "1 song", "3 songs". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Pitch match – Sustain II", or the one title when both ends are the same level. */
export function rangeLabel(first: string, last: string): string {
  return first === last ? first : `${first} ${DASH} ${last}`;
}

/**
 * Style for an element that wears its world's hue: sets `--wk` to the world's accent token (`--world-vibrato`, ...),
 * which worlds.css uses for rules, rings and the cable. The hue is never the only cue (docs/DESIGN.md 10).
 */
export function hueStyle(world: Pick<WorldDef, 'accent'>): Record<string, string> {
  return { '--wk': `var(${world.accent})` };
}

/** The level a boss or numbered node is shown as: "the Boss Recital" or its title. */
export function levelName(level: Pick<LevelDef, 'kind' | 'title'>): string {
  return level.kind === 'boss' ? 'the Boss Recital' : level.title;
}

/**
 * One or two initials of a profile name for the profile chip: "Daniel" -> "D", "Mary Jane" -> "MJ"
 * (first letters of the first and last word). "?" when the name has no letters.
 */
export function initialsOf(name: string | null | undefined): string {
  const words = (name ?? '')
    .trim()
    .split(/\s+/)
    .map((w) => Array.from(w).find((ch) => /[\p{L}\p{N}]/u.test(ch)))
    .filter((ch): ch is string => ch !== undefined);
  if (words.length === 0) return '?';
  const picked = words.length === 1 ? [words[0]] : [words[0], words[words.length - 1]];
  return picked.join('').toLocaleUpperCase();
}

/** The exercise title of an audition test without its "Audition:" prefix ("Audition: siren" -> "Siren"). */
export function testTitle(exerciseTitle: string): string {
  const bare = exerciseTitle.replace(/^audition\s*:\s*/i, '').trim();
  if (bare.length === 0) return exerciseTitle;
  return bare.charAt(0).toLocaleUpperCase() + bare.slice(1);
}

const NBSP = String.fromCharCode(0xa0);

/**
 * Ties a trailing numeral to the word before it with a no-break space, so a narrow screen wraps "Pitch match - Sustain II"
 * between the words, never as "Sustain" and a lone "II".
 */
export function tieNumerals(text: string): string {
  return text.replace(/ (?=(?:I{1,3}|IV|V|\d{1,2})(?=[\s,.;:]|$))/g, NBSP);
}
