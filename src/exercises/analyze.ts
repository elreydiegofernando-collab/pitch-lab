/**
 * Runs an exercise's analysis plan (plan.ts) with the real analyzers, then
 * aggregates the per-note results into take-level Metrics with
 * analysis/score.ts's metricsFromResults (the one canonical aggregation), so
 * the runner's whole post-take path is:
 *
 *   const a = analyzeTake(def, realized, track, { vibratoStyle });
 *   const e = evaluate(def, a.metrics, a);           // score, pass, mastery
 *   const tip = pickTip(a.metrics, def, a.tipContext);
 *
 * Exercise-side choices on top of the plain aggregation: dynamics.symmetry
 * only counts holds cued as a swell; dynamics.rangeDb counts no range for a
 * hold whose level went against its cue (loudness.ts), and none at all unless
 * most holds followed theirs, so a take sung the opposite way fails the range
 * gate; cracks are detected per phrase, so the breaths between phrases never
 * count as breaks. Passing `a` to evaluate() refuses a pass when the
 * realization had to fold notes by octaves.
 *
 * `track` is the take-relative, latency-compensated PitchTrack (t = 0 at the
 * downbeat). One- and two-frame octave glitches are removed first
 * (analysis/track.ts); nothing is smoothed. The tolerance always comes from
 * the level (CONFIG.tolerance[def.tolerance]). Post-take only, never per frame.
 */
import { CONFIG } from '../config';
import type { PitchTrack, TargetNote, VibratoStyle } from '../core/types';
import type {
  AnalyzeContext, CrackEvent, DynamicsResult, GlideResult, InflectionKind, InflectionResult, Metrics, OnsetResult, RangeResult,
  RunResult, TransitionResult, VibratoResult,
} from '../analysis/types';
import { analyzeAccuracy, type AccuracyDetail } from '../analysis/accuracy';
import { detectCracks } from '../analysis/cracks';
import { analyzeDynamics } from '../analysis/dynamics';
import { analyzeGlide } from '../analysis/glide';
import { analyzeInflection } from '../analysis/inflections';
import { analyzeOnset } from '../analysis/onset';
import { analyzePulse, type PulseResult } from '../analysis/pulse';
import { analyzeRange } from '../analysis/range';
import { analyzeRun } from '../analysis/runs';
import { metricsFromResults, type AnalyzerResults } from '../analysis/score';
import { analyzeSwitch, type SwitchResult } from '../analysis/switch';
import { cleanOctaveSpikes, estimateFrameDt, framesInWindow, median } from '../analysis/track';
import { analyzeTransitions } from '../analysis/transitions';
import { analyzeVibrato } from '../analysis/vibrato';
import type { DynamicShape, LoudnessContour } from './cues';
import type { NoteReach } from './evaluate';
import { FOLLOWS_CUE_SCORE, loudnessShapeScore } from './loudness';
import { planAnalysis, type AnalysisPlan } from './plan';
import type { TipContext } from './tips';
import type { RealizedExercise } from './transpose';
import type { ExerciseDef } from './types';

/** Less voiced audio than this in the whole take means nobody sang (PROPOSED CONFIG.exercises). */
const NO_VOICE_SEC = 0.3;

/**
 * Per-note reach (PROPOSED CONFIG.exercises): was each target note sung at all? Voicing only, never pitch: how well a
 * note was sung is the analyzers' business; this only tells a note that was sung from one that was skipped, so a
 * take whose singer went quiet part way (or tapped Stop) cannot pass on the part it did sing (evaluate.ts reachHolds).
 */
export const REACH = {
  /** A note at least this long is a hold ... */
  holdSec: 1,
  /**
   * ... reached when voiced for at least this share of it, after a late start inside CONFIG.accuracy.lateStartAllowanceSec
   * (a reaction to the cue, as the accuracy analyzer forgives it). A hold stopped 25% early, or come in 25% late, is
   * reached; one sung for little more than half is not, which is what closes a one-swell exercise sung half way.
   */
  holdShare: 0.65,
  /** A shorter note is reached when voiced for this long ... */
  shortSec: 0.15,
  /** ... or for this share of it when the note itself is shorter than that (a fast run's notes). */
  shortShare: 0.5,
} as const;

/** How many of `notes` the singer voiced enough of to count as sung (REACH). `track` is the cleaned take. */
export function noteReach(track: PitchTrack, notes: readonly TargetNote[]): NoteReach {
  const dt = estimateFrameDt(track);
  let reached = 0;
  let lastReachedEnd = 0;
  for (const note of notes) {
    const dur = note.end - note.start;
    const frames = framesInWindow(track, note.start, note.end);
    let voicedSec = 0;
    let firstVoiced: number | null = null;
    if (Number.isFinite(dt)) {
      for (const f of frames) {
        if (!f.voiced) continue;
        voicedSec += dt;
        if (firstVoiced === null) firstVoiced = f.t;
      }
    }
    let need: number;
    if (dur >= REACH.holdSec) {
      const lateStart = firstVoiced === null ? 0 : Math.min(CONFIG.accuracy.lateStartAllowanceSec, Math.max(0, firstVoiced - note.start));
      need = REACH.holdShare * (dur - lateStart);
    } else {
      need = Math.min(REACH.shortSec, REACH.shortShare * dur);
    }
    if (voicedSec > 0 && voicedSec >= need - 1e-9) {
      reached++;
      lastReachedEnd = Math.max(lastReachedEnd, note.end);
    }
  }
  return { reached, total: notes.length, lastReachedEnd };
}

export interface TakeDetails {
  accuracy: Array<{ note: TargetNote; result: AccuracyDetail }>;
  onset: Array<{ note: TargetNote; result: OnsetResult }>;
  vibrato: Array<{ note: TargetNote; result: VibratoResult }>;
  /** One result over the take's whole vibrato plan (null when the exercise has no switch cues). */
  switch: SwitchResult | null;
  pulses: Array<{ notes: TargetNote[]; rateHz: number; result: PulseResult }>;
  glides: Array<{ note: TargetNote; result: GlideResult }>;
  /** Every crack or break found, take-relative, for the trace markers. */
  cracks: CrackEvent[];
  transitions: Array<{ notes: TargetNote[]; result: TransitionResult }>;
  inflections: Array<{ kind: InflectionKind; targets: TargetNote[]; result: InflectionResult }>;
  /** Per run: note-by-note verdicts for the defined/smeared/missed feedback. */
  runs: Array<{ notes: TargetNote[]; result: RunResult }>;
  /**
   * Per dynamics hold: what its cue asked (plan.ts), the analyzer's result as measured, and how closely the level
   * followed the asked contour (loudness.ts; null = too little change or audio to tell).
   */
  dynamics: Array<{ note: TargetNote; shape: DynamicShape | null; contour: LoudnessContour | null; shapeScore: number | null; result: DynamicsResult }>;
  range: RangeResult | null;
}

export interface TakeAnalysis {
  metrics: Metrics;
  /** Signed and per-figure detail for pickTip(). */
  tipContext: TipContext;
  plan: AnalysisPlan;
  details: TakeDetails;
  /** Seconds of voiced audio in the take. */
  voicedSec: number;
  /** RealizedExercise.fit of the realization that was sung: evaluate(def, metrics, analysis) refuses a 'folded' one. */
  fit: RealizedExercise['fit'];
  /**
   * How many of the realized notes were sung at all (noteReach): evaluate(def, metrics, analysis) refuses a pass when
   * too few were (reachHolds), so a take whose singer went quiet part way never passes on the part that was sung.
   */
  reach: NoteReach;
}

const finite = (x: number | null | undefined): x is number => x !== null && x !== undefined && Number.isFinite(x);

/** Analyze one take of `def` (as realized for this singer) and aggregate it into Metrics. */
export function analyzeTake(def: ExerciseDef, realized: RealizedExercise, track: PitchTrack, opts: { vibratoStyle: VibratoStyle }): TakeAnalysis {
  const ctx: AnalyzeContext = { toleranceCents: CONFIG.tolerance[def.tolerance], vibratoStyle: opts.vibratoStyle };
  const plan = planAnalysis(realized);
  const clean = cleanOctaveSpikes(track);
  const want = new Set(def.analyzers);
  const results: AnalyzerResults = {};
  const tipContext: TipContext = {};
  const details: TakeDetails = {
    accuracy: [], onset: [], vibrato: [], switch: null, pulses: [], glides: [], cracks: [], transitions: [], inflections: [], runs: [],
    dynamics: [], range: null,
  };

  let voicedSec = 0;
  for (let i = 1; i < clean.length; i++) if (clean[i].voiced) voicedSec += clean[i].t - clean[i - 1].t;

  if (want.has('accuracy')) {
    details.accuracy = plan.accuracy.map((note) => ({ note, result: analyzeAccuracy(clean, note, ctx) }));
    results.accuracy = details.accuracy.map((a) => a.result);
    let w = 0;
    let bias = 0;
    let wd = 0;
    let drift = 0;
    for (const { result: r } of details.accuracy) {
      if (!(r.voicedSec > 0) || !finite(r.biasCents)) continue;
      w += r.voicedSec;
      bias += r.voicedSec * r.biasCents;
      if (finite(r.driftCentsPerSec)) {
        wd += r.voicedSec;
        drift += r.voicedSec * r.driftCentsPerSec;
      }
    }
    if (w > 0) tipContext.biasCents = bias / w;
    if (wd > 0) tipContext.driftCentsPerSec = drift / wd;
  }

  if (want.has('onset')) {
    details.onset = plan.attacks.map((a) => ({ note: a.note, result: analyzeOnset(framesInWindow(clean, a.from, a.note.end), a.note, ctx) }));
    results.onset = details.onset.map((o) => o.result);
  }

  if (want.has('vibrato')) {
    details.vibrato = plan.vibrato.map((note) => ({ note, result: analyzeVibrato(clean, note, ctx) }));
    results.vibrato = details.vibrato.map((v) => v.result);
    const centring = median(details.vibrato.filter((v) => v.result.present).map((v) => v.result.centeringCents).filter(finite));
    tipContext.centeringCents = Number.isNaN(centring) ? null : centring; // no vibrato anywhere: nothing to centre
  }

  if (want.has('switch') && plan.vibratoPlan.length > 0) {
    details.switch = analyzeSwitch(clean, plan.vibratoPlan);
    results.switch = details.switch;
  }

  if (want.has('pulse')) {
    details.pulses = plan.pulses.map((p) => ({ ...p, result: analyzePulse(clean, p.notes, p.rateHz) }));
    results.pulse = details.pulses.map((p) => p.result);
  }

  if (want.has('glide')) {
    details.glides = plan.glides.map((note) => ({ note, result: analyzeGlide(clean, note, ctx) }));
    results.glide = details.glides.map((g) => g.result);
    details.cracks = details.glides.flatMap((g) => g.result.cracks);
  }

  if (want.has('cracks')) {
    // A phrase span is continuous by construction (the breaths sit between the spans), so a hole of any length inside one is a break.
    details.cracks = plan.crackSpans.flatMap((s) => detectCracks(framesInWindow(clean, s.start, s.end), { maxDropoutMs: Infinity }));
    results.cracks = details.cracks;
  }

  if (want.has('transitions')) {
    details.transitions = plan.transitions.map((notes) => ({ notes, result: analyzeTransitions(clean, notes, ctx) }));
    results.transitions = details.transitions.map((t) => t.result);
  }

  if (want.has('inflection')) {
    details.inflections = plan.inflections.map((g) => ({ ...g, result: analyzeInflection(clean, g.kind, g.targets, ctx) }));
    results.inflection = details.inflections.map((i) => i.result);
    let worst: (typeof details.inflections)[number] | null = null;
    for (const i of details.inflections) if (!worst || i.result.score < worst.result.score) worst = i;
    if (worst) tipContext.worstInflection = worst.kind;
  }

  if (want.has('run')) {
    const band = CONFIG.runs.dtwBandMs / 1000;
    details.runs = plan.runs.map((notes) => ({ notes, result: analyzeRun(framesInWindow(clean, notes[0].start - band, notes[notes.length - 1].end + band), notes, ctx) }));
    results.run = details.runs.map((r) => r.result);
  }

  if (want.has('dynamics')) {
    details.dynamics = plan.dynamics.map((d) => ({
      ...d,
      shapeScore: d.contour ? loudnessShapeScore(clean, d.note, d.contour) : null,
      result: analyzeDynamics(clean, d.note, ctx),
    }));
    // A hold whose level went against its cue (the other way, or one way through a swell) made none of the change
    // that was asked, so it counts no range; and unless most of the judged holds followed their cue, none counts
    // (one crescendo sung for "a crescendo, then a decrescendo" is not the exercise). The dynamics.rangeDb gate then
    // fails a take sung against its cues.
    let against = 0;
    let followed = 0;
    for (const d of details.dynamics) {
      if (againstCue(d.shapeScore)) against++;
      else if (d.shapeScore !== null) followed++;
    }
    const noneCount = against > 0 && against >= followed;
    results.dynamics = details.dynamics.map((d) => (noneCount || againstCue(d.shapeScore) ? { ...d.result, rangeDb: 0 } : d.result));
    tipContext.dynamicsVerdict = dominantVerdict(details.dynamics.map((d) => d.result.verdict));
    if (against > 0) tipContext.loudnessAgainstCue = true;
  }

  if (want.has('range')) {
    details.range = analyzeRange(clean);
    results.range = details.range;
  }

  const metrics = metricsFromResults(results);
  if (want.has('dynamics')) {
    // Symmetry describes a swell; a crescendo or a soft/loud step is lopsided on purpose.
    const swells = details.dynamics.filter((d) => d.shape === 'swell').map((d) => d.result);
    const sym = swells.length > 0 ? metricsFromResults({ dynamics: swells })['dynamics.symmetry'] : undefined;
    if (sym === undefined) delete metrics['dynamics.symmetry'];
    else metrics['dynamics.symmetry'] = sym;
  }
  if (voicedSec < NO_VOICE_SEC) tipContext.noVoice = true;
  if (realized.fit === 'folded' || plan.issues.length > 0) tipContext.unfitRange = true;
  const reach = noteReach(clean, realized.notes);
  tipContext.reach = reach;

  return { metrics, tipContext, plan, details, voicedSec, fit: realized.fit, reach };
}

const againstCue = (shapeScore: number | null): boolean => shapeScore !== null && shapeScore < FOLLOWS_CUE_SCORE;

/** The verdict worth coaching: the commonest named fault, else drift, else not enough range, else steady. */
function dominantVerdict(vs: ReadonlyArray<DynamicsResult['verdict']>): DynamicsResult['verdict'] | null {
  if (vs.length === 0) return null;
  const n = (v: DynamicsResult['verdict']) => vs.filter((x) => x === v).length;
  const loud = n('sharp-when-loud');
  const soft = n('flat-when-soft');
  if (loud > 0 || soft > 0) return loud >= soft ? 'sharp-when-loud' : 'flat-when-soft';
  if (n('drifts') > 0) return 'drifts';
  if (n('insufficient-range') > vs.length / 2) return 'insufficient-range';
  return 'steady';
}
