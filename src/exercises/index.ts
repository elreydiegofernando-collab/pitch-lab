/**
 * Exercise engine: the catalog plus the pure steps around one take.
 *
 *   const realized = realize(def, profile.range, profile.voiceType, { bpm });   // where and when
 *   // ...play the Listen demo (src/audio/demos.ts), record the take...
 *   const take = analyzeTake(def, realized, track, { vibratoStyle });           // what was sung
 *   const result = evaluate(def, take.metrics, take);                           // score, pass, tally
 *   const tip = pickTip(take.metrics, def, take.tipContext);                    // one coaching tip
 *   const bpmNext = nextTempo(def, bpm, take.metrics, take);                    // a Runs ladder's next rung
 *
 * Runs climb a tempo ladder (ladder.ts): a take that passes at its rung moves
 * practice up one rung, and only a take at the pass tempo can pass the level
 * (canPassAtTempo; progress/attempt.ts writes it into the attempt and the
 * progression engine enforces it again). Auditions are sung in order and stop at
 * the first miss (progress nextAuditionExercise says which test is next). Save
 * the range from a PASSED Range finder take only: its span gate is what keeps
 * every exercise from folding by octaves (validate.ts).
 */
export {
  CATALOG, EXERCISES, WORLDS, WORLD_ORDER, bossOf, getAudition, getExercise, getLevel, getWorld, levelForExercise, levelsOf, nextLevel,
  worldsUnlockedBy,
} from './catalog';
export type { Catalog } from './catalog';
export { CUE, DYNAMIC_CUES, INFLECTION_CUES, VIBRATO_CUES, isSemanticCue, loudnessContourOf } from './cues';
export type { DynamicShape, LoudnessContour, LoudnessLevel, SemanticCue } from './cues';
export { FOLLOWS_CUE_SCORE, contourAt, loudnessShapeScore } from './loudness';
export {
  DEFAULT_RANGES, PASSAGGIO_ZONE, effectiveRange, materialSpan, passaggioCentre, rangeFromMeasurement, realize, repeatCount, usesExtendedRange,
} from './transpose';
export type { RealizeOptions, RealizedExercise, RealizedStep, VoiceType } from './transpose';
export { PLAN, planAnalysis } from './plan';
export type { AnalysisPlan, PlannedHold, PlannedPhrase } from './plan';
export { analyzeTake } from './analyze';
export type { TakeAnalysis, TakeDetails } from './analyze';
export { evaluate, gateHolds, isFolded, passRequirements, reportTiles, termScore } from './evaluate';
export type { Evaluation, ReportTile, Requirement, TakeConditions } from './evaluate';
export { COACHING_TIPS, NO_VOICE_TIP, POLISH_TIP, UNFIT_RANGE_TIP, getTip, pickTip, tipIdsFor } from './tips';
export type { PickedTip, TipContext, TipRule } from './tips';
export { canPassAtTempo, isPassTempo, ladderOf, nextTempo, startTempo } from './ladder';
export { ANALYZER_METRICS, METRIC_DIRECTION, METRIC_INFO, formatMetric, metricsProducedBy } from './metrics';
export type { MetricDirection, MetricInfo } from './metrics';
export { RANGE_CASES, WORLD_SEQUENCE, validateCatalog, validateExercise } from './validate';
export type { ValidationIssue } from './validate';
export type * from './types';
