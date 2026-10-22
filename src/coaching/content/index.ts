/**
 * Every coaching ladder, keyed by tip id (exercises/tips.ts COACHING_TIPS). Each part is owned by one content builder;
 * this index is the contract that joins them (index.test.ts checks every tip id has exactly one ladder).
 */
import type { CoachLadder } from '../types';
import { LADDERS_ACCURACY } from './accuracy';
import { LADDERS_EXPRESSION } from './expression';
import { LADDERS_ONSET_GLIDE } from './onset-glide';
import { LADDERS_VIBRATO } from './vibrato';

/** Which tip-id prefixes each part covers (the first dot-separated segment of the id). */
export const LADDER_PARTS = [
  { name: 'accuracy', prefixes: ['acc', 'range', 'general'], ladders: LADDERS_ACCURACY },
  { name: 'onset-glide', prefixes: ['onset', 'glide', 'transition'], ladders: LADDERS_ONSET_GLIDE },
  { name: 'vibrato', prefixes: ['vib', 'pulse'], ladders: LADDERS_VIBRATO },
  { name: 'expression', prefixes: ['scoop', 'fall', 'slide', 'turn', 'flip', 'inflection', 'run', 'dyn'], ladders: LADDERS_EXPRESSION },
] as const;

export const LADDERS: Readonly<Record<string, CoachLadder>> = Object.freeze(
  Object.assign({}, ...LADDER_PARTS.map((p) => p.ladders)) as Record<string, CoachLadder>,
);

/** The ladder for a tip id; undefined for an unknown id (the coach then falls back to the tip text alone). */
export function ladderFor(tipId: string): CoachLadder | undefined {
  return Object.prototype.hasOwnProperty.call(LADDERS, tipId) ? LADDERS[tipId] : undefined;
}
