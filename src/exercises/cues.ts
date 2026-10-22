/**
 * Cue vocabulary. PatternStep.cue is free on-screen text, but a few cues also
 * carry MEANING that the realizer and the analysis plan read (the contract has
 * no structured per-step intent field):
 *  - listen: a reference-only step. The synth plays it, the singer listens;
 *    it is not a sung target (pitch match, auditions).
 *  - straight / bloom / vibrato: start a vibrato-state window that lasts over
 *    the following uncued steps of the same held note (switch drills).
 *  - scoop / fall / slide / turn / flip: mark an inflection; plan.ts turns the
 *    cued step (plus the steps the figure needs) into the analyzer's targets.
 *    A flip also lets the exercise use the extended range.
 *  - crescendo / decrescendo / swell: the dynamic shape of the held note they
 *    start (dynamics.symmetry is only meaningful for a swell). These read as
 *    plain instructions, and src/audio/demos.ts parses the same words
 *    (soft/full, grow/fade) to shape the demo's loudness; free-text cues such
 *    as "Soft, loud, soft: change on the clicks" give it sudden steps, one
 *    equal part of the note per word. loudnessContourOf() reads both into the
 *    contour the take is judged against (exercises/loudness.ts).
 * Compare with these constants, never with literals. Free-text cues must not
 * collide with them, ignoring case (validate.ts checks).
 */
import type { InflectionKind } from '../analysis/types';

export const CUE = {
  listen: 'Listen',
  sing: 'Sing',
  straight: 'Straight',
  bloom: 'Bloom',
  vibrato: 'Vibrato on',
  scoop: 'Scoop in',
  fall: 'Fall off',
  slide: 'Slide',
  turn: 'Turn',
  flip: 'Flip up',
  crescendo: 'Start soft, grow to full',
  decrescendo: 'Start full, fade to soft',
  swell: 'Soft, grow, then fade',
} as const;

export type SemanticCue = (typeof CUE)[keyof typeof CUE];

/** Cue -> inflection kind for the inflection analyzer. */
export const INFLECTION_CUES: ReadonlyMap<string, InflectionKind> = new Map<string, InflectionKind>([
  [CUE.scoop, 'scoop'],
  [CUE.fall, 'fall'],
  [CUE.slide, 'slide'],
  [CUE.turn, 'turn'],
  [CUE.flip, 'flip'],
]);

/** Cue -> vibrato wanted (true) or straight tone (false). */
export const VIBRATO_CUES: ReadonlyMap<string, boolean> = new Map<string, boolean>([
  [CUE.straight, false],
  [CUE.bloom, true],
  [CUE.vibrato, true],
]);

export type DynamicShape = 'crescendo' | 'decrescendo' | 'swell';

/** Cue -> the dynamic shape asked of the held note it starts. */
export const DYNAMIC_CUES: ReadonlyMap<string, DynamicShape> = new Map<string, DynamicShape>([
  [CUE.crescendo, 'crescendo'],
  [CUE.decrescendo, 'decrescendo'],
  [CUE.swell, 'swell'],
]);

export type LoudnessLevel = 'soft' | 'loud';

/**
 * The loudness a cue asks of the held note it starts: stops in time order,
 * joined by smooth ramps (crescendo, decrescendo, swell) or taken as abrupt
 * steps on equal parts of the note (a soft/loud step cue). The same reading
 * src/audio/demos.ts plays in the Listen demo.
 */
export interface LoudnessContour {
  points: readonly LoudnessLevel[];
  smooth: boolean;
}

const SHAPE_CONTOURS: Readonly<Record<DynamicShape, LoudnessContour>> = {
  crescendo: { points: ['soft', 'loud'], smooth: true },
  decrescendo: { points: ['loud', 'soft'], smooth: true },
  swell: { points: ['soft', 'loud', 'soft'], smooth: true },
};

/**
 * The contour `cue` asks for: the shape cues above, or a free-text step cue
 * naming "soft" and "loud" in order ("Soft, loud, soft: change every two
 * clicks" = soft, loud, soft). Null for any other cue, and for a step cue
 * that never changes level (nothing to follow).
 */
export function loudnessContourOf(cue: string | undefined): LoudnessContour | null {
  if (cue === undefined) return null;
  const shape = DYNAMIC_CUES.get(cue);
  if (shape) return SHAPE_CONTOURS[shape];
  const words: string[] = cue.toLowerCase().match(/[a-z]+/g) ?? [];
  const points = words.filter((w): w is LoudnessLevel => w === 'soft' || w === 'loud');
  return points.length >= 2 && points.includes('soft') && points.includes('loud') ? { points, smooth: false } : null;
}

/** Cues that only label a step (no analysis meaning). */
const LABEL_ONLY: ReadonlySet<string> = new Set<string>([CUE.sing]);

const SEMANTIC = new Set<string>(Object.values(CUE).filter((c) => !LABEL_ONLY.has(c)));
const ALL_LOWER = new Map<string, string>(Object.values(CUE).map((c) => [c.toLowerCase(), c]));

/** True when `cue` is one of the meaningful constants above (not just a label). */
export function isSemanticCue(cue: string | undefined): boolean {
  return cue !== undefined && SEMANTIC.has(cue);
}

/**
 * The CUE constant that `cue` would be confused with: same text ignoring case
 * and surrounding space, but not the exact constant. Null when there's no clash.
 */
export function cueCollision(cue: string): string | null {
  const hit = ALL_LOWER.get(cue.trim().toLowerCase());
  return hit !== undefined && hit !== cue ? hit : null;
}
