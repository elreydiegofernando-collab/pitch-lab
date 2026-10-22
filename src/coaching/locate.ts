/**
 * Where a take's main problem shows, in plain words with plain numbers (coach.ts locateProblem). The problem is the one
 * the take's tip names (exercises/tips.ts): its rule's metric picks the family, and the analyzers' per-note detail
 * (exercises/analyze.ts TakeDetails) places it: the furthest-off notes, the slowest start, each break with its time and
 * nearest note, the run notes that were missed, the moment the vibrato stopped. Every sentence reads what the analyzers
 * measured, never more: a take without detail (its pitch line was not saved) gets the measure in words and no spots.
 */
import { CONFIG } from '../config';
import type { DynamicsResult, InflectionKind, InflectionResult, MetricKey, Metrics, RunNoteVerdict } from '../analysis/types';
import type { DynamicsDetail } from '../analysis/dynamics';
import { cleanOctaveSpikes, framesInWindow, median, targetMidiAt } from '../analysis/track';
import type { Notation } from '../core/music';
import type { PitchFrame, PitchTrack, TargetNote, VibratoStyle } from '../core/types';
import { noteReach, type TakeDetails } from '../exercises/analyze';
import { RANGE_MIN_SPAN } from '../exercises/catalog/scoring';
import { gateHolds, notesNeeded, type NoteReach } from '../exercises/evaluate';
import { FOLLOWS_CUE_SCORE } from '../exercises/loudness';
import { getTip, type PickedTip, type TipContext, type TipRule } from '../exercises/tips';
import type { RealizedExercise } from '../exercises/transpose';
import type { ExerciseDef } from '../exercises/types';
import { MEASURES, gateOn, requirementWords, vibratoZone } from './measures';
import * as P from './plain';
import type { ProblemSpot, TakeProblem } from './types';

/** At most this many spots (TakeProblem.spots). */
export const MAX_SPOTS = 4;

export interface LocateInput {
  def: ExerciseDef;
  realized: Pick<RealizedExercise, 'notes' | 'totalSec' | 'tonicMidi'>;
  /** The take's metrics (TakeAnalysis.metrics, or the attempt's when the take was not re-analyzed). */
  metrics: Metrics;
  /** The analysis detail; null when only the metrics are known (the problem is then said, not placed). */
  analysis: { details: TakeDetails; tipContext: TipContext; reach?: NoteReach } | null;
  tip: PickedTip;
  notation: Notation;
  /** The take's pitch line, for what only it can place (where a slide stalled, which notes went unsung, where the singing stopped). */
  track?: PitchTrack | null;
  /** The singer's vibrato style (its zone); without it, the span both styles share. */
  vibratoStyle?: VibratoStyle;
}

interface Ctx {
  def: ExerciseDef;
  notes: readonly TargetNote[];
  totalSec: number;
  metrics: Metrics;
  details: TakeDetails | null;
  tipContext: TipContext;
  reach: NoteReach | null;
  track: PitchFrame[] | null;
  notation: Notation;
  style: VibratoStyle | undefined;
  rule: TipRule | undefined;
  tip: PickedTip;
}

interface Found {
  what: string;
  spots: ProblemSpot[];
}

const finite = (x: number | null | undefined): x is number => x !== null && x !== undefined && Number.isFinite(x);
const spot = (t: number, label: string): ProblemSpot => ({ t, label });
/** Exercises with more bars than this name a note with its time too ("note 12 (A3) at 0:14"). */
const LONG_EXERCISE_NOTES = 12;
const EPS = 1e-6;

/**
 * What the level asks of `metric`, to end a clause: " (this level asks for 68%)", ", more than this level allows" (a
 * pitch distance the take went past), or "" when the exercise does not gate it (or a distance gate held).
 */
const req = (ctx: Ctx, metric: MetricKey): string => {
  const g = gateOn(ctx.def, metric);
  if (!g) return '';
  const words = requirementWords(ctx.def, metric);
  if (words) return ` (${words})`;
  return gateHolds({ metric, ...g }, ctx.metrics) ? '' : ', more than this level allows';
};

/** The take's main problem, located (see the module doc). */
export function locate(input: LocateInput): TakeProblem {
  const ctx: Ctx = {
    def: input.def,
    notes: input.realized.notes,
    totalSec: input.realized.totalSec,
    metrics: input.metrics,
    details: input.analysis?.details ?? null,
    tipContext: input.analysis?.tipContext ?? {},
    reach: input.analysis?.reach ?? input.analysis?.tipContext.reach ?? null,
    track: input.track && input.track.length > 0 ? cleanOctaveSpikes(input.track) : null,
    notation: input.notation,
    style: input.vibratoStyle,
    rule: getTip(input.tip.id),
    tip: input.tip,
  };
  const found = find(ctx);
  return { tipId: input.tip.id, metric: input.tip.metric, what: found.what, spots: found.spots.slice(0, MAX_SPOTS) };
}

function find(ctx: Ctx): Found {
  switch (ctx.tip.id) {
    case 'general.no-voice':
      return { what: 'The app heard nothing it could follow for the whole take.', spots: [] };
    case 'general.unfit-range':
      return { what: 'Some of this exercise’s notes fall outside your saved range, so they had to be moved and the take was not judged.', spots: [] };
    case 'general.unsung':
      return unsung(ctx);
    case 'general.stopped':
      return stopped(ctx);
    case 'general.polish':
      return { what: 'Nothing stood out to fix in this take.', spots: [] };
    default:
      break;
  }
  const metric = ctx.rule?.when.metric ?? ctx.tip.metric;
  if (!metric) return { what: `The overall score fell short of the ${P.shareText(ctx.def.pass.score)} this level asks for.`, spots: [] };
  const missing = ctx.rule?.missing === true || !finite(ctx.metrics[metric]);
  const locator = LOCATORS[metric];
  if (missing && !MISSING_AWARE.has(metric)) return unmeasured(metric);
  return locator ? locator(ctx, missing) : plainMeasure(ctx, metric);
}

/** A measure the take could not read. */
function unmeasured(metric: MetricKey): Found {
  return { what: `The app could not measure “${MEASURES[metric].label}” in this take.`, spots: [] };
}

/** The measure in words, with what the level asks for: the fallback when there is no detail to place it. */
function plainMeasure(ctx: Ctx, metric: MetricKey): Found {
  const v = ctx.metrics[metric];
  if (!finite(v)) return unmeasured(metric);
  return { what: `${MEASURES[metric].label}: ${MEASURES[metric].words(v)}${req(ctx, metric)}.`, spots: [] };
}

// ---------------------------------------------------------------- notes, times, pitches

/** Index of `n` among the take's target notes (the bars on the replay): the one starting at the same moment. */
function indexOf(ctx: Ctx, n: TargetNote): number {
  let best = -1;
  let bestD = Infinity;
  ctx.notes.forEach((m, i) => {
    const d = Math.abs(m.start - n.start) + (m.midi === n.midi ? 0 : 1e-3);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/**
 * A target as the singer finds it on the replay: "note 3 (G3)" by its bar; "note 12 (A3) at 0:14" in a long exercise;
 * "the A3 at 0:05" for one held note drawn as several bars (a pulse train, a switch drill).
 */
function ref(ctx: Ctx, n: TargetNote): string {
  const i = indexOf(ctx, n);
  const bars = ctx.notes.filter((m) => m.start >= n.start - EPS && m.start < n.end - EPS).length;
  if (i < 0 || bars > 1) return `the ${P.nameOf(n.midi, ctx.notation)} at ${P.clock(n.start)}`;
  const r = P.noteRef(i, n.midi, ctx.notation);
  return ctx.notes.length > LONG_EXERCISE_NOTES ? `${r} at ${P.clock(n.start)}` : r;
}

const name = (ctx: Ctx, midi: number): string => P.nameOf(midi, ctx.notation);

/** The note sounding at take time `t`: what was sung there (the pitch line), else the target there. */
function pitchAt(ctx: Ctx, t: number): number {
  if (ctx.track) {
    const near = framesInWindow(ctx.track, t - 0.12, t + 0.12).filter((f) => f.voiced && Number.isFinite(f.midi));
    if (near.length > 0) return median(near.map((f) => f.midi));
  }
  const n = targetAt(ctx, t);
  return n ? targetMidiAt(n, t) : NaN;
}

/** The target note at take time `t` (the nearest when `t` falls between notes). */
function targetAt(ctx: Ctx, t: number): TargetNote | undefined {
  let best: TargetNote | undefined;
  let bestD = Infinity;
  for (const n of ctx.notes) {
    const d = t < n.start ? n.start - t : t > n.end ? t - n.end : 0;
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

/** "the slide up from C3 to C4". */
function slideName(ctx: Ctx, g: TargetNote): string {
  const to = g.toMidi ?? g.midi;
  return `the slide ${to >= g.midi ? 'up' : 'down'} from ${name(ctx, g.midi)} to ${name(ctx, to)}`;
}

/** `items` worst first by `badness` (higher = worse), without those `keep` rejects (locate keeps the first MAX_SPOTS). */
function worstFirst<T>(items: readonly T[], badness: (x: T) => number, keep: (x: T) => boolean = () => true): T[] {
  return items.filter(keep).sort((a, b) => badness(b) - badness(a));
}

/** The share of the clearly-off readings that must lean one way before a sentence names that way. */
const LEAN_SHARE = 2 / 3;

interface Lean {
  /** The way to name, or null: the readings went both ways (or none was clearly off, and nothing says which way). */
  dir: 'sharp' | 'flat' | null;
  /** Readings off by `min` or more, by the way they went. */
  sharp: number;
  flat: number;
  /** True when the clearly-off readings went both ways: no one way to name (an average of misses both ways hides them). */
  mixed: boolean;
}

/**
 * Which way per-note readings (signed, + sharp) lean, counting those off by `min` or more: the way at least LEAN_SHARE
 * of them went (`want`, the tip rule's direction, first), else mixed: both ways, with neither enough to name. With no
 * reading clearly off, `want` or the sign of `average` names the way.
 */
function leaning(values: readonly number[], min: number, want: 'sharp' | 'flat' | undefined, average: number | null | undefined): Lean {
  const off = values.filter((v) => finite(v) && Math.abs(v) >= min);
  const sharp = off.filter((v) => v > 0).length;
  const flat = off.length - sharp;
  if (off.length === 0) {
    const dir = want ?? (finite(average) && average !== 0 ? P.sharpOrFlat(average) : null);
    return { dir, sharp, flat, mixed: false };
  }
  const first = want ?? (sharp >= flat ? 'sharp' : 'flat');
  for (const way of [first, first === 'sharp' ? 'flat' : 'sharp'] as const) {
    if ((way === 'sharp' ? sharp : flat) >= LEAN_SHARE * off.length - EPS) return { dir: way, sharp, flat, mixed: false };
  }
  return { dir: null, sharp, flat, mixed: true };
}

/** The signed average says the same way as the lean (or is too small to say a way): it may be quoted. */
const averageAgrees = (average: number, lean: Lean, min: number): boolean =>
  lean.dir === null || Math.abs(average) < min || P.sharpOrFlat(average) === lean.dir;

/** "4 sharp and 3 flat": how many went each way, for a take whose notes missed both ways. */
const bothWays = (lean: Lean): string => `${lean.sharp} sharp and ${lean.flat} flat`;

// ---------------------------------------------------------------- the general tips

function unsung(ctx: Ctx): Found {
  const reach = ctx.reach;
  if (!reach || reach.total <= 0) return { what: 'Some notes went unsung, so the take could not pass.', spots: [] };
  const stop = reach.reached > 0 && finite(reach.lastReachedEnd) && reach.lastReachedEnd < ctx.totalSec - 0.5 ? reach.lastReachedEnd : null;
  const needed = notesNeeded(ctx.def, reach.total);
  const asks = needed >= reach.total ? `this level needs all ${reach.total}` : `this level needs ${needed}`;
  const what = `You sang ${reach.reached} of the ${reach.total} notes, and ${asks}${stop !== null ? `; the singing stopped at ${P.clock(stop)}` : ''}.`;
  const spots: ProblemSpot[] = [];
  if (ctx.track) {
    for (const n of ctx.notes) {
      if (noteReach(ctx.track, [n]).reached === 0) spots.push(spot(n.start, `${ref(ctx, n)}, not sung`));
      if (spots.length >= MAX_SPOTS) break;
    }
  }
  if (spots.length === 0 && stop !== null) spots.push(spot(stop, `${P.clock(stop)}, the singing stopped`));
  return { what, spots };
}

function stopped(ctx: Ctx): Found {
  let at: number | null = null;
  if (ctx.track) {
    for (let i = ctx.track.length - 1; i >= 0; i--) {
      if (ctx.track[i].voiced) {
        at = ctx.track[i].t;
        break;
      }
    }
  }
  if (at === null && ctx.reach && ctx.reach.reached > 0 && finite(ctx.reach.lastReachedEnd)) at = ctx.reach.lastReachedEnd;
  if (at === null || at >= ctx.totalSec) return { what: 'You stopped before the end, so this take was practice and was not judged.', spots: [] };
  return {
    what: `You stopped at ${P.clock(at)}, before the end of the exercise at ${P.clock(ctx.totalSec)}.`,
    spots: [spot(at, `${P.clock(at)}, where the singing stopped`)],
  };
}

// ---------------------------------------------------------------- accuracy

type AccNote = TakeDetails['accuracy'][number];
const accSung = (ctx: Ctx): AccNote[] => (ctx.details?.accuracy ?? []).filter((a) => a.result.voicedSec > 0 && finite(a.result.biasCents));

/** Per-note offsets of at least this much count when saying which way the notes leaned (and get a spot). */
const BIAS_OFF_CENTS = 5;

function bias(ctx: Ctx): Found {
  const signed = ctx.tipContext.biasCents;
  const sung = accSung(ctx);
  const lean = leaning(sung.map((a) => a.result.biasCents), BIAS_OFF_CENTS, ctx.rule?.direction, signed);
  const sameWay = (a: AccNote) => lean.dir === null || P.sharpOrFlat(a.result.biasCents) === lean.dir;
  const ranked = worstFirst(sung, (a) => Math.abs(a.result.biasCents), (a) => sameWay(a) && Math.abs(a.result.biasCents) >= BIAS_OFF_CENTS);
  const spots = ranked.map((a) => spot(a.note.start, `${ref(ctx, a.note)}, ${P.offWords(a.result.biasCents)}`));
  const metric: MetricKey = 'accuracy.absBiasCents';
  const v = ctx.metrics[metric];
  const worst = ranked[0] ? `; ${ref(ctx, ranked[0].note)} was the furthest off` : '';
  // Notes off both ways average out near the middle: say what happened instead of an average that hides it.
  if (lean.mixed) {
    const typically = finite(v) ? `, typically by ${P.pitchDistance(v)}` : '';
    return { what: `Your notes landed off the middle both ways (${bothWays(lean)})${typically}${req(ctx, metric)}${worst}.`, spots };
  }
  if (finite(signed) && averageAgrees(signed, lean, BIAS_OFF_CENTS)) {
    return { what: `On average you sang ${P.offWords(signed)}${req(ctx, metric)}${worst}.`, spots };
  }
  if (!finite(v)) return unmeasured(metric);
  if (lean.dir !== null) return { what: `Most of your notes landed ${lean.dir}, typically by ${P.pitchDistance(v)}${req(ctx, metric)}${worst}.`, spots };
  return { what: `Your notes sat ${P.pitchDistance(v)} away from the middle of the note${req(ctx, metric)}${worst}.`, spots };
}

function inTune(ctx: Ctx, missing: boolean): Found {
  const tol = CONFIG.tolerance[ctx.def.tolerance];
  const all = ctx.details?.accuracy ?? [];
  if (missing) {
    const silent = all.filter((a) => !(a.result.voicedSec > 0));
    return {
      what: 'None of the held notes came through clearly enough to measure.',
      spots: silent.map((a) => spot(a.note.start, `${ref(ctx, a.note)}, not heard`)),
    };
  }
  const effective = (a: AccNote) => (Number.isFinite(a.result.inTolerancePct) ? a.result.inTolerancePct * Math.max(0, Math.min(1, a.result.coverage)) : 0);
  const reason = (a: AccNote): string => {
    const r = a.result;
    if (!(r.voicedSec > 0)) return 'not heard';
    if (r.coverage < 0.6) return 'only partly sung';
    if (finite(r.biasCents) && Math.abs(r.biasCents) >= 0.6 * tol) return P.offWords(r.biasCents);
    if (finite(r.sdCents) && r.sdCents >= 0.6 * tol) return 'wavered';
    return `in tune ${P.percentText(effective(a))} of the time`;
  };
  const ranked = worstFirst(all, (a) => 100 - effective(a), (a) => effective(a) < 90);
  const metric: MetricKey = 'accuracy.inTolerancePct';
  const v = ctx.metrics[metric];
  const hardest = ranked[0] ? `; ${ref(ctx, ranked[0].note)} was the hardest` : '';
  return {
    what: finite(v) ? `You were in tune ${P.percentText(v)} of the time${req(ctx, metric)}${hardest}.` : unmeasured(metric).what,
    spots: ranked.map((a) => spot(a.note.start, `${ref(ctx, a.note)}, ${reason(a)}`)),
  };
}

function typicalMiss(ctx: Ctx): Found {
  const ranked = worstFirst(accSung(ctx), (a) => a.result.medianAbsCents, (a) => finite(a.result.medianAbsCents) && a.result.medianAbsCents >= 5);
  const metric: MetricKey = 'accuracy.medianAbsCents';
  const v = ctx.metrics[metric];
  if (!finite(v)) return unmeasured(metric);
  const worst = ranked[0] ? `; ${ref(ctx, ranked[0].note)} was the furthest, ${P.offWords(ranked[0].result.biasCents)}` : '';
  return {
    what: `Your notes were typically off by ${P.pitchDistance(v)}${req(ctx, metric)}${worst}.`,
    spots: ranked.map((a) => spot(a.note.start, `${ref(ctx, a.note)}, ${P.offWords(a.result.biasCents)}`)),
  };
}

function wobble(ctx: Ctx): Found {
  const ranked = worstFirst(accSung(ctx), (a) => a.result.sdCents, (a) => finite(a.result.sdCents) && a.result.sdCents >= 8);
  const metric: MetricKey = 'accuracy.sdCents';
  const v = ctx.metrics[metric];
  if (!finite(v)) return unmeasured(metric);
  const most = ranked[0] && ranked[0].result.sdCents >= 15 ? `; it wavered most on ${ref(ctx, ranked[0].note)}` : '';
  return {
    what: `The pitch was ${P.steadiness(v)} as you held the notes${most}.`,
    spots: ranked.map((a) => spot(a.note.start, `${ref(ctx, a.note)}, ${P.steadiness(a.result.sdCents)}`)),
  };
}

/** A hold's drift counts (and gets a spot) when it moved at least this much by its end. */
const DRIFT_OFF_CENTS = 10;

function drift(ctx: Ctx): Found {
  const signed = ctx.tipContext.driftCentsPerSec;
  const total = (a: AccNote): number => {
    const held = Math.max(0, a.note.end - a.note.start - CONFIG.accuracy.holdStartSkipMs / 1000);
    return (a.result.driftCentsPerSec ?? 0) * held;
  };
  const held = (ctx.details?.accuracy ?? []).filter((a) => finite(a.result.driftCentsPerSec));
  const lean = leaning(held.map(total), DRIFT_OFF_CENTS, ctx.rule?.direction, signed);
  const dir = lean.dir;
  const moved = (cents: number) => `${cents < 0 ? 'sank' : 'rose'} ${P.pitchDistance(cents)}`;
  const ranked = worstFirst(held, (a) => Math.abs(total(a)), (a) => Math.abs(total(a)) >= DRIFT_OFF_CENTS && (dir === null || P.sharpOrFlat(total(a)) === dir));
  const metric: MetricKey = 'accuracy.absDriftCentsPerSec';
  if (!finite(ctx.metrics[metric])) return unmeasured(metric);
  const verb = lean.mixed ? 'drifted both ways' : dir === 'flat' ? 'sank' : dir === 'sharp' ? 'crept up' : 'drifted';
  const counts = lean.mixed ? ` (${lean.flat} sank, ${lean.sharp} rose)` : '';
  const worst = ranked[0] ? `: on ${ref(ctx, ranked[0].note)} it ${moved(total(ranked[0]))} by the end` : '';
  return {
    what: `The pitch ${verb} as you held the notes${counts}${worst}${req(ctx, metric)}.`,
    spots: ranked.map((a) => spot(a.note.start, `${ref(ctx, a.note)}, ${moved(total(a))}`)),
  };
}

// ---------------------------------------------------------------- the start of the note

type OnsetNote = TakeDetails['onset'][number];
const started = (ctx: Ctx): OnsetNote[] => (ctx.details?.onset ?? []).filter((o) => o.result.onsetT !== null);

function scoop(ctx: Ctx): Found {
  const ranked = worstFirst(started(ctx), (o) => o.result.scoopCents, (o) => o.result.scoopCents >= 10);
  const metric: MetricKey = 'onset.scoopCents';
  if (!finite(ctx.metrics[metric])) return unmeasured(metric);
  const w = ranked[0];
  const what = w
    ? `Your notes started below the pitch and slid up into it${req(ctx, metric)}; the biggest was ${ref(ctx, w.note)}, from ${P.pitchDistance(w.result.scoopCents)} below.`
    : `Your notes started close to the pitch${req(ctx, metric)}.`;
  return { what, spots: ranked.map((o) => spot(o.note.start, `${ref(ctx, o.note)}, from ${P.pitchDistance(o.result.scoopCents)} below`)) };
}

function settle(ctx: Ctx, missing: boolean): Found {
  const all = started(ctx);
  const never = all.filter((o) => o.result.settleMs === null);
  const metric: MetricKey = 'onset.settleMs';
  if (missing) {
    const n = (ctx.details?.onset ?? []).length;
    const sat = accSung(ctx).map((a) => a.result.biasCents);
    const where = sat.length > 0 && Math.abs(median(sat)) >= 18 ? `; most sat ${P.offWords(median(sat))}` : '';
    return {
      what: n > 0 ? `Most notes never settled in tune: ${never.length} of the ${n} stayed off the pitch${where}.` : 'Most notes never settled in tune.',
      spots: never.map((o) => spot(o.note.start, `${ref(ctx, o.note)}, never settled in tune`)),
    };
  }
  const slow = (o: OnsetNote) => (o.result.settleMs === null ? Infinity : o.result.settleMs);
  const ranked = worstFirst(all, slow, (o) => slow(o) >= 100);
  const label = (o: OnsetNote) => (o.result.settleMs === null ? 'never settled' : `took ${P.durationWords(o.result.settleMs / 1000)}`);
  const v = ctx.metrics[metric];
  if (!finite(v)) return unmeasured(metric);
  const w = ranked[0];
  const worst = w ? `; ${ref(ctx, w.note)} ${w.result.settleMs === null ? 'never settled' : `took ${P.durationWords(w.result.settleMs / 1000)}`}` : '';
  return {
    what: `Your notes typically took ${P.durationWords(v / 1000)} to settle on the pitch${req(ctx, metric)}${worst}.`,
    spots: ranked.map((o) => spot(o.note.start, `${ref(ctx, o.note)}, ${label(o)}`)),
  };
}

function overshoot(ctx: Ctx): Found {
  const ranked = worstFirst(started(ctx), (o) => o.result.overshootCents, (o) => o.result.overshootCents >= 10);
  const metric: MetricKey = 'onset.overshootCents';
  if (!finite(ctx.metrics[metric])) return unmeasured(metric);
  const w = ranked[0];
  return {
    what: w
      ? `Your notes went past the pitch before settling${req(ctx, metric)}; the furthest was ${ref(ctx, w.note)}, ${P.pitchDistance(w.result.overshootCents)} past it.`
      : `Your notes hardly went past the pitch${req(ctx, metric)}.`,
    spots: ranked.map((o) => spot(o.note.start, `${ref(ctx, o.note)}, ${P.pitchDistance(o.result.overshootCents)} past`)),
  };
}

function crisp(ctx: Ctx): Found {
  const all = ctx.details?.onset ?? [];
  const target = CONFIG.onset.settleTargetMs[ctx.def.tolerance];
  const reason = (o: OnsetNote): string => {
    const r = o.result;
    if (r.onsetT === null) return 'not heard';
    if (r.settleMs === null) return 'never settled';
    if (r.scoopCents > CONFIG.onset.crispMaxScoopCents) return 'slid up from below';
    if (r.overshootCents > CONFIG.onset.crispMaxOvershootCents) return 'went past the pitch';
    if (r.settleMs > target) return 'slow to settle';
    if (r.onsetType === 'breathy') return 'a breathy start';
    return 'not quite clean';
  };
  const badness = (o: OnsetNote) =>
    o.result.onsetT === null ? 4 : o.result.settleMs === null ? 3 : o.result.scoopCents / 100 + o.result.overshootCents / 100 + o.result.settleMs / 1000;
  const ranked = worstFirst(all, badness, (o) => !o.result.crisp);
  const metric: MetricKey = 'onset.crispRate';
  const clean = all.filter((o) => o.result.crisp).length;
  const v = ctx.metrics[metric];
  const what =
    all.length > 0
      ? `${clean} of your ${all.length} note starts were clean${req(ctx, metric)}${ranked[0] ? `; ${ref(ctx, ranked[0].note)} ${verbOf(reason(ranked[0]))}` : ''}.`
      : finite(v)
        ? `${P.shareText(v)} of your note starts were clean${req(ctx, metric)}.`
        : unmeasured(metric).what;
  return { what, spots: ranked.map((o) => spot(o.note.start, `${ref(ctx, o.note)}, ${reason(o)}`)) };
}

/** "slid up from below" as the end of a sentence about a note ("note 3 (G3) slid up from below"). */
function verbOf(reason: string): string {
  if (reason === 'not heard') return 'was not heard';
  if (reason === 'slow to settle') return 'was slow to settle';
  if (reason === 'a breathy start') return 'had a breathy start';
  if (reason === 'not quite clean') return 'was not quite clean';
  return reason;
}

// ---------------------------------------------------------------- vibrato

type VibNote = TakeDetails['vibrato'][number];
const vibs = (ctx: Ctx): VibNote[] => ctx.details?.vibrato ?? [];

/** Moments a note's vibrato stopped part way (a window without it after one with it), in time order. */
function dropouts(ctx: Ctx): ProblemSpot[] {
  const out: ProblemSpot[] = [];
  for (const v of vibs(ctx)) {
    const w = v.result.windows;
    for (let i = 1; i < w.length; i++) {
      if (w[i - 1].present && !w[i].present) {
        out.push(spot(w[i].start, `${P.clock(w[i].start)}, the vibrato stopped`));
        break;
      }
    }
  }
  return out;
}

function noVibrato(ctx: Ctx): Found {
  const all = vibs(ctx);
  const without = all.filter((v) => !v.result.present);
  const metric: MetricKey = 'vibrato.present';
  const v = ctx.metrics[metric];
  const what =
    all.length > 0
      ? `No vibrato came through on ${P.ofThe(without.length, all.length, 'note')}${req(ctx, metric)}.`
      : finite(v)
        ? `Vibrato came through on ${P.shareText(v)} of the notes${req(ctx, metric)}.`
        : 'No vibrato came through.';
  return { what, spots: without.map((x) => spot(x.note.start, `${ref(ctx, x.note)}, no vibrato`)) };
}

function vibratoRate(ctx: Ctx): Found {
  const zone = vibratoZone(ctx.style).rateHz;
  const slow = ctx.rule?.id === 'vib.slow' || (ctx.rule?.id !== 'vib.fast' && (ctx.metrics['vibrato.rateHz'] ?? zone[0]) < zone[0]);
  const off = (r: number) => (slow ? zone[0] - r : r - zone[1]);
  const ranked = worstFirst(
    vibs(ctx).filter((v) => v.result.present && finite(v.result.rateHz)),
    (v) => off(v.result.rateHz as number),
    (v) => off(v.result.rateHz as number) > 0,
  );
  const v = ctx.metrics['vibrato.rateHz'];
  if (!finite(v)) return unmeasured('vibrato.rateHz');
  const limit = slow ? zone[0] : zone[1];
  return {
    what: `Your vibrato ran at ${P.wobbles(v)}, ${P.howFar(v, limit)} too ${slow ? 'slow' : 'fast'}; aim for ${P.wobbleZone()}.`,
    spots: ranked.map((x) => spot(x.note.start, `${ref(ctx, x.note)}, ${P.wobbles(x.result.rateHz as number)}`)),
  };
}

function vibratoWidth(ctx: Ctx): Found {
  const zone = vibratoZone(ctx.style).extentCents;
  const v = ctx.metrics['vibrato.extentCents'];
  if (!finite(v)) return unmeasured('vibrato.extentCents');
  const wide = ctx.rule?.id === 'vib.wide' || (ctx.rule?.id !== 'vib.narrow' && v > zone[1]);
  const limit = wide ? zone[1] : zone[0];
  const off = (e: number) => (wide ? e - limit : limit - e);
  const ranked = worstFirst(
    vibs(ctx).filter((x) => x.result.present && finite(x.result.extentCents)),
    (x) => off(x.result.extentCents as number),
    (x) => off(x.result.extentCents as number) > 0,
  );
  return {
    what: wide
      ? `Your vibrato swung ${P.howFar(v, limit)} too wide: ${P.pitchDistance(v)} each way.`
      : `Your vibrato was ${P.howFar(v, limit)} too narrow: it swung only ${P.pitchDistance(v)} each way.`,
    spots: ranked.map((x) => spot(x.note.start, `${ref(ctx, x.note)}, ${P.howFar(x.result.extentCents as number, limit)} too ${wide ? 'wide' : 'narrow'}`)),
  };
}

function vibratoZoneMiss(ctx: Ctx): Found {
  const zone = vibratoZone(ctx.style);
  const all = vibs(ctx);
  const reason = (x: VibNote): string => {
    const r = x.result;
    if (!r.present) return 'no vibrato';
    if (finite(r.rateHz) && r.rateHz < zone.rateHz[0]) return 'too slow';
    if (finite(r.rateHz) && r.rateHz > zone.rateHz[1]) return 'too fast';
    if (finite(r.extentCents) && r.extentCents > zone.extentCents[1]) return 'too wide';
    if (finite(r.extentCents) && r.extentCents < zone.extentCents[0]) return 'too narrow';
    return 'outside the zone';
  };
  const out = all.filter((x) => !x.result.inZone);
  const metric: MetricKey = 'vibrato.inZone';
  const v = ctx.metrics[metric];
  const what =
    all.length > 0
      ? `${all.length - out.length} of the ${all.length} notes had vibrato inside the zone${req(ctx, metric)}${out[0] ? `; ${ref(ctx, out[0].note)} was ${reason(out[0])}` : ''}.`
      : finite(v)
        ? `${P.shareText(v)} of the notes had vibrato inside the zone${req(ctx, metric)}.`
        : unmeasured(metric).what;
  return { what, spots: [...out.map((x) => spot(x.note.start, `${ref(ctx, x.note)}, ${reason(x)}`)), ...dropouts(ctx)] };
}

function vibratoEvenness(ctx: Ctx): Found {
  const drops = dropouts(ctx);
  const ranked = worstFirst(
    vibs(ctx).filter((x) => x.result.present && finite(x.result.regularity)),
    (x) => 1 - (x.result.regularity as number),
    (x) => (x.result.regularity as number) < 0.85,
  );
  const metric: MetricKey = 'vibrato.regularity';
  if (!finite(ctx.metrics[metric]) && ranked.length === 0) return unmeasured(metric);
  const stoppedAt = drops[0] ? `, and it stopped at ${P.clock(drops[0].t)}` : '';
  const most = ranked[0] ? `; ${ref(ctx, ranked[0].note)} was the most uneven` : '';
  return {
    what: `Your vibrato changed speed or size as you held the notes${stoppedAt}${most}.`,
    spots: [...drops, ...ranked.map((x) => spot(x.note.start, `${ref(ctx, x.note)}, uneven`))],
  };
}

function vibratoCentre(ctx: Ctx): Found {
  const signed = ctx.tipContext.centeringCents;
  const swung = vibs(ctx).filter((x) => x.result.present && finite(x.result.centeringCents));
  const lean = leaning(swung.map((x) => x.result.centeringCents as number), BIAS_OFF_CENTS, ctx.rule?.direction, signed);
  const dir = lean.dir;
  const ranked = worstFirst(
    swung,
    (x) => Math.abs(x.result.centeringCents as number),
    (x) => Math.abs(x.result.centeringCents as number) >= BIAS_OFF_CENTS && (dir === null || P.sharpOrFlat(x.result.centeringCents as number) === dir),
  );
  const metric: MetricKey = 'vibrato.absCenteringCents';
  const v = ctx.metrics[metric];
  if (!finite(v)) return unmeasured(metric);
  const spots = ranked.map((x) => spot(x.note.start, `${ref(ctx, x.note)}, ${P.offWords(x.result.centeringCents as number)}`));
  if (lean.mixed) {
    return { what: `Your vibrato swung off the middle of the note both ways (${bothWays(lean)}), typically by ${P.pitchDistance(v)}${req(ctx, metric)}.`, spots };
  }
  const side = dir === 'flat' ? 'more below the note than above it' : dir === 'sharp' ? 'more above the note than below it' : 'off the middle of the note';
  const amount = finite(signed) && averageAgrees(signed, lean, BIAS_OFF_CENTS) ? `on average it sat ${P.offWords(signed)}` : `typically ${P.pitchDistance(v)} off`;
  return { what: `Your vibrato swung ${side}: ${amount}${req(ctx, metric)}.`, spots };
}

type Boundary = NonNullable<TakeDetails['switch']>['boundaries'][number];

function boundaryReason(b: Boundary): string {
  if (b.reattacked) return 'the note restarted';
  if (b.latencyMs === null) return 'it never switched';
  if (b.latencyMs >= 0) return `${P.durationWords(b.latencyMs / 1000)} late`;
  return `${P.durationWords(-b.latencyMs / 1000)} early`;
}

const boundaryBadness = (b: Boundary): number => (b.latencyMs === null ? 1e6 : b.reattacked ? 1e5 : Math.abs(b.latencyMs));

function switches(ctx: Ctx): Found {
  const all = ctx.details?.switch?.boundaries ?? [];
  const ranked = worstFirst(all, boundaryBadness, (b) => !b.clean);
  const metric: MetricKey = 'vibrato.switchCleanRate';
  const v = ctx.metrics[metric];
  const what =
    all.length > 0
      ? `${all.length - ranked.length} of your ${all.length} switches landed cleanly on the cue${req(ctx, metric)}.`
      : finite(v)
        ? `${P.shareText(v)} of your switches landed cleanly on the cue${req(ctx, metric)}.`
        : unmeasured(metric).what;
  return {
    what,
    spots: ranked.map((b) => spot(b.t, `${P.clock(b.t)}, ${b.toVibrato ? 'into vibrato' : 'back to straight'}: ${boundaryReason(b)}`)),
  };
}

function bloom(ctx: Ctx): Found {
  const blooms = (ctx.details?.switch?.boundaries ?? []).filter((b) => b.toVibrato);
  const ranked = worstFirst(blooms, boundaryBadness, (b) => !b.clean);
  const metric: MetricKey = 'vibrato.bloomOnCue';
  const never = blooms.filter((b) => b.latencyMs === null).length;
  const late = blooms.filter((b) => finite(b.latencyMs)).map((b) => b.latencyMs as number);
  let what: string;
  if (blooms.length === 0) what = plainMeasure(ctx, metric).what;
  else if (never > 0) what = `The vibrato never bloomed on ${never} of the ${blooms.length} cues.`;
  else {
    const typical = median(late);
    what = `The vibrato typically bloomed ${typical >= 0 ? `${P.durationWords(typical / 1000)} after` : `${P.durationWords(-typical / 1000)} before`} the cue.`;
  }
  return { what, spots: ranked.map((b) => spot(b.t, `${P.clock(b.t)}, bloom: ${boundaryReason(b)}`)) };
}

// ---------------------------------------------------------------- pulses

type PulseTrain = TakeDetails['pulses'][number];

function pulseNoun(ctx: Ctx): string {
  return ctx.def.kind === 'oscillation' ? 'back-and-forth' : 'pulse';
}

/** Where a pulse run sits: "0:05, A3" for pulses on one note, "0:05" for a back-and-forth between two. */
function trainAt(ctx: Ctx, p: PulseTrain): string {
  return p.notes.length === 1 ? `${P.clock(p.notes[0].start)}, ${name(ctx, p.notes[0].midi)}` : P.clock(p.notes[0].start);
}

/** "on the A3 at 0:05", "at 0:05". */
function trainIn(ctx: Ctx, p: PulseTrain): string {
  return p.notes.length === 1 ? `on the ${name(ctx, p.notes[0].midi)} at ${P.clock(p.notes[0].start)}` : `at ${P.clock(p.notes[0].start)}`;
}

function pulseRate(ctx: Ctx, missing: boolean): Found {
  const trains = (ctx.details?.pulses ?? []).filter((p) => p.notes.length > 0);
  const noun = pulseNoun(ctx);
  const metric: MetricKey = 'pulse.rateErrorHz';
  if (missing) {
    const none = trains.filter((p) => p.result.measuredRateHz === null);
    return {
      what:
        trains.length > 0 && none.length < trains.length
          ? `No clear ${noun}s came through on ${P.ofThe(none.length, trains.length, 'note')}.`
          : `No clear ${noun}s came through.`,
      spots: none.map((p) => spot(p.notes[0].start, `${trainAt(ctx, p)}, no clear ${noun}s`)),
    };
  }
  const err = (p: PulseTrain) => (p.result.rateErrorHz === null ? Infinity : Math.abs(p.result.rateErrorHz));
  const ranked = worstFirst(trains, err, (p) => err(p) >= 0.25);
  const label = (p: PulseTrain) => (p.result.measuredRateHz === null ? `no clear ${noun}s` : P.perSecond(p.result.measuredRateHz, noun));
  const spots = ranked.map((p) => spot(p.notes[0].start, `${trainAt(ctx, p)}, ${label(p)}`));
  const w = ranked[0];
  if (!w || w.result.measuredRateHz === null) {
    const v = ctx.metrics[metric];
    return finite(v) ? { what: `Your ${noun}s were off the clicks by ${P.perSecond(v, noun)}${req(ctx, metric)}.`, spots } : unmeasured(metric);
  }
  // Say which way: rounded to the nearest half, the two rates can read alike.
  const way = w.result.measuredRateHz > w.rateHz ? 'fast' : 'slow';
  return {
    what: `Your ${noun}s ran too ${way} ${trainIn(ctx, w)}: ${P.perSecond(w.result.measuredRateHz, noun)}, where the clicks asked for ${P.perSecond(w.rateHz, noun)}.`,
    spots,
  };
}

function pulseEvenness(ctx: Ctx): Found {
  const trains = (ctx.details?.pulses ?? []).filter((p) => p.notes.length > 0);
  const noun = pulseNoun(ctx);
  const reg = (p: PulseTrain) => p.result.regularity ?? 0;
  const ranked = worstFirst(trains, (p) => 1 - reg(p), (p) => reg(p) < 0.85);
  const metric: MetricKey = 'pulse.regularity';
  if (!finite(ctx.metrics[metric]) && ranked.length === 0) return unmeasured(metric);
  const w = ranked[0];
  return {
    what: `Your ${noun}s were uneven${req(ctx, metric)}${w ? `; the most uneven were ${trainIn(ctx, w)}` : ''}.`,
    spots: ranked.map((p) => spot(p.notes[0].start, `${trainAt(ctx, p)}, ${p.result.regularity === null ? 'no steady rhythm' : 'uneven'}`)),
  };
}

// ---------------------------------------------------------------- slides and breaks

function cracks(ctx: Ctx): Found {
  const metric: MetricKey = 'glide.cracks';
  const list = ctx.details?.cracks ?? [];
  const n = Math.round(ctx.metrics[metric] ?? list.length);
  if (n === 0 && list.length === 0) return { what: `Your voice stayed unbroken the whole way${req(ctx, metric)}.`, spots: [] };
  const dirs = new Set(
    list.map((c) => {
      const g = targetAt(ctx, c.t);
      return g && g.toMidi !== undefined && g.toMidi !== g.midi ? (g.toMidi > g.midi ? 'up' : 'down') : 'held';
    }),
  );
  const where = dirs.size === 1 && dirs.has('up') ? ' on the way up' : dirs.size === 1 && dirs.has('down') ? ' on the way down' : '';
  const size = (c: (typeof list)[number]) => (c.kind === 'jump' ? (c.cents ?? 200) / 100 : c.durationMs / 50);
  const ranked = worstFirst(list, size);
  // A dropout is the sound cutting out inside a phrase (a breath mid-slide counts): say so, it is not a voice flip.
  const cutOut = list.some((c) => c.kind === 'dropout');
  return {
    what: `Your voice ${cutOut ? 'broke or cut out' : 'broke'} ${P.times(Math.max(n, list.length))}${where}${req(ctx, metric)}.`,
    spots: ranked.map((c) => {
      const m = pitchAt(ctx, c.t);
      const at = Number.isFinite(m) ? `${P.clock(c.t)}, near ${name(ctx, m)}` : P.clock(c.t);
      return spot(c.t, c.kind === 'dropout' ? `${at}, the sound cut out` : at);
    }),
  };
}

type GlideNote = TakeDetails['glides'][number];

/**
 * Where a slide stalled: stretches inside it (between 10% and 90% of the way) that held one pitch for at least
 * CONFIG.transitions.stairPlateauMs, longest first. A reading of the pitch line in the analyzer's own terms (a stair is
 * a flat stretch inside the slide); the analyzer's count says how many to report.
 */
export function stalls(track: readonly PitchFrame[], g: TargetNote, max: number): Array<{ t: number; midi: number; progress: number }> {
  const to = g.toMidi ?? g.midi;
  const span = to - g.midi;
  if (max <= 0 || Math.abs(span) < 0.5) return [];
  const frames = framesInWindow(track, g.start, g.end).filter((f) => f.voiced && Number.isFinite(f.midi));
  const progress = (m: number) => (m - g.midi) / span;
  const inside = frames.filter((f) => progress(f.midi) >= 0.1 && progress(f.midi) <= 0.9);
  const minSec = CONFIG.transitions.stairPlateauMs / 1000;
  const runs: Array<{ start: number; end: number; frames: PitchFrame[] }> = [];
  let i = 0;
  while (i < inside.length) {
    let j = i;
    let lo = inside[i].midi;
    let hi = inside[i].midi;
    while (j + 1 < inside.length && inside[j + 1].t - inside[j].t < 0.03) {
      const m = inside[j + 1].midi;
      if (Math.max(hi, m) - Math.min(lo, m) > 0.25) break;
      lo = Math.min(lo, m);
      hi = Math.max(hi, m);
      j++;
    }
    if (inside[j].t - inside[i].t >= minSec) runs.push({ start: inside[i].t, end: inside[j].t, frames: inside.slice(i, j + 1) });
    i = j + 1;
  }
  return runs
    .sort((a, b) => b.end - b.start - (a.end - a.start))
    .slice(0, max)
    .map((r) => {
      const midi = median(r.frames.map((f) => f.midi));
      return { t: (r.start + r.end) / 2, midi, progress: progress(midi) };
    })
    .sort((a, b) => a.t - b.t);
}

/** How far along a slide a stall was, 0..1 of the way: "half way along". */
function alongSlide(progress: number): string {
  if (progress < 0.15) return 'near the start of';
  if (progress < 0.35) return 'a quarter of the way along';
  if (progress < 0.65) return 'half way along';
  if (progress < 0.85) return 'three quarters of the way along';
  return 'near the end of';
}

function stairs(ctx: Ctx): Found {
  const glides = ctx.details?.glides ?? [];
  const ranked = worstFirst(glides, (g) => g.result.stairSteps + (1 - g.result.smoothness), (g) => g.result.stairSteps > 0 || g.result.smoothness < 0.6);
  const metric: MetricKey = 'glide.smoothness';
  if (ranked.length === 0) {
    const v = ctx.metrics[metric];
    return finite(v) ? { what: `Your slides were ${P.shareText(v)} smooth${req(ctx, metric)}.`, spots: [] } : unmeasured(metric);
  }
  const stepped = glides.filter((g) => g.result.stairSteps > 0);
  const w = ranked[0];
  const what =
    stepped.length > 1
      ? `${stepped.length} of your ${glides.length} slides moved in steps instead of one smooth line; the bumpiest was ${slideName(ctx, w.note)} at ${P.clock(w.note.start)}.`
      : w.result.stairSteps > 0
        ? `${P.sentence(slideName(ctx, w.note))} at ${P.clock(w.note.start)} moved in steps instead of one smooth line.`
        : `${P.sentence(slideName(ctx, w.note))} at ${P.clock(w.note.start)} was the bumpiest.`;
  const spots: ProblemSpot[] = [];
  for (const g of ranked) {
    const up = (g.note.toMidi ?? g.note.midi) >= g.note.midi;
    const found = ctx.track ? stalls(ctx.track, g.note, Math.max(1, g.result.stairSteps)) : [];
    if (found.length === 0) spots.push(spot(g.note.start, `${P.clock(g.note.start)}, ${slideName(ctx, g.note)}`));
    for (const s of found) spots.push(spot(s.t, `${P.clock(s.t)}, stalled ${alongSlide(s.progress)} the slide ${up ? 'up' : 'down'}, near ${name(ctx, s.midi)}`));
  }
  return { what, spots };
}

function glideEnd(ctx: Ctx, missing: boolean): Found {
  const glides = ctx.details?.glides ?? [];
  if (missing) {
    const lost = glides.filter((g) => g.result.durationMs === null);
    return {
      what: glides.length > 0 ? `The slides did not come through: ${lost.length} of the ${glides.length} had no clear slide from one note to the other.` : 'The slides did not come through.',
      spots: lost.map((g) => spot(g.note.start, `${P.clock(g.note.start)}, ${slideName(ctx, g.note)}, not heard`)),
    };
  }
  const err = (g: GlideNote) => (finite(g.result.endErrorCents) ? Math.abs(g.result.endErrorCents) : -1);
  const ranked = worstFirst(glides, err, (g) => err(g) >= 10);
  const metric: MetricKey = 'glide.endAbsCents';
  const v = ctx.metrics[metric];
  if (!finite(v)) return unmeasured(metric);
  const w = ranked[0];
  const toName = (g: GlideNote) => name(ctx, g.note.toMidi ?? g.note.midi);
  return {
    what: `The ends of your slides were typically off by ${P.pitchDistance(v)}${req(ctx, metric)}${
      w ? `; ${slideName(ctx, w.note)} at ${P.clock(w.note.start)} ended ${P.offWords(w.result.endErrorCents as number)}` : ''
    }.`,
    spots: ranked.map((g) => spot(g.note.end, `${P.clock(g.note.end)}, the slide to ${toName(g)} ended ${P.offWords(g.result.endErrorCents as number)}`)),
  };
}

// ---------------------------------------------------------------- note changes

function transitions(ctx: Ctx): Found {
  const overshootLimit = Math.max(CONFIG.tolerance[ctx.def.tolerance], CONFIG.onset.crispMaxOvershootCents);
  const all = (ctx.details?.transitions ?? []).flatMap((seq) =>
    seq.result.transitions.map((tr) => ({ ...tr, a: seq.notes[tr.fromIndex], b: seq.notes[tr.toIndex] })),
  );
  const reason = (tr: (typeof all)[number]): string => {
    if (tr.durationMs === null) return 'never settled';
    if (tr.overshootCents > overshootLimit) return 'went past the note';
    return `took ${P.durationWords(tr.durationMs / 1000)}`;
  };
  const ranked = worstFirst(
    all.filter((tr) => tr.a && tr.b),
    (tr) => (tr.durationMs === null ? 1e6 : tr.durationMs + tr.overshootCents),
    (tr) => !tr.clean,
  );
  const metric: MetricKey = 'transition.cleanRate';
  const v = ctx.metrics[metric];
  const w = ranked[0];
  const what =
    all.length > 0
      ? `${all.length - all.filter((t) => !t.clean).length} of your ${all.length} note changes were clean${req(ctx, metric)}${
          w ? `; the change from ${ref(ctx, w.a)} to ${name(ctx, w.b.midi)} ${reason(w)}` : ''
        }.`
      : finite(v)
        ? `${P.shareText(v)} of your note changes were clean${req(ctx, metric)}.`
        : unmeasured(metric).what;
  return { what, spots: ranked.map((tr) => spot(tr.b.start, `${P.clock(tr.b.start)}, ${name(ctx, tr.a.midi)} to ${name(ctx, tr.b.midi)}, ${reason(tr)}`)) };
}

// ---------------------------------------------------------------- inflections

type Figure = TakeDetails['inflections'][number];

const KIND_WORD: Readonly<Record<InflectionKind, string>> = { scoop: 'scoop', fall: 'fall', slide: 'slide', turn: 'turn', flip: 'flip' };
/** A flip slower than this is a slide: the inflection analyzer's own line (analysis/inflections.ts FLIP_SLOW_MS). */
const FLIP_SLIDE_MS = 300;

/** The figure by name: "the scoop into E3", "the turn around G3 (upper note)". */
function figureName(ctx: Ctx, f: Figure): string {
  const t = f.targets;
  const glide = t.find((n) => n.toMidi !== undefined);
  switch (f.kind) {
    case 'scoop':
      return `the scoop into ${name(ctx, glide?.toMidi ?? t[0].midi)}`;
    case 'fall':
      return `the fall from ${name(ctx, t[0].midi)}`;
    case 'slide':
      return glide ? `the slide from ${name(ctx, glide.midi)} to ${name(ctx, glide.toMidi ?? glide.midi)}` : 'the slide';
    case 'turn':
      return `the turn around ${name(ctx, t[0].midi)}${t[1] ? ` (${t[1].midi > t[0].midi ? 'upper' : 'lower'} note)` : ''}`;
    case 'flip':
      return `the flip from ${name(ctx, t[0].midi)}${t[1] ? ` to ${name(ctx, t[1].midi)}` : ''}`;
  }
}

/** What was off in a figure, read from its result against what the targets asked for. */
function figureFault(f: Figure): string {
  const r: InflectionResult = f.result;
  const t = f.targets;
  const glide = t.find((n) => n.toMidi !== undefined);
  if (!r.detected) {
    return f.kind === 'turn' ? 'its notes were not clear' : f.kind === 'flip' ? 'no clear jump was heard' : `no ${KIND_WORD[f.kind]} was heard`;
  }
  const size = r.sizeCents;
  switch (f.kind) {
    case 'scoop': {
      const asked = glide ? Math.abs((glide.toMidi ?? glide.midi) - glide.midi) * 100 : null;
      if (finite(size) && asked && size < 0.6 * asked) return `it started only ${P.pitchDistance(size)} below; the demo starts ${P.pitchDistance(asked)} below`;
      if (finite(size) && asked && size > 1.4 * asked) return `it started ${P.pitchDistance(size)} below; the demo starts only ${P.pitchDistance(asked)} below`;
      break;
    }
    case 'fall': {
      const fall = t[1];
      const asked = fall && fall.toMidi !== undefined ? Math.abs(fall.midi - fall.toMidi) * 100 : null;
      if (finite(size) && asked && size < 0.6 * asked) return `it fell only ${P.pitchDistance(size)}; the demo falls ${P.pitchDistance(asked)}`;
      break;
    }
    case 'slide': {
      if (finite(size) && size < -25) return `it fell short by ${P.pitchDistance(size)}`;
      if (finite(size) && size > 25) return `it went past the end note by ${P.pitchDistance(size)}`;
      const asked = glide ? (glide.end - glide.start) * 1000 : null;
      if (finite(r.timeMs) && asked && r.timeMs > 1.5 * asked) return 'it moved more slowly than the demo';
      if (finite(r.timeMs) && asked && r.timeMs < 0.5 * asked) return 'it moved faster than the demo';
      break;
    }
    case 'turn': {
      const asked = t[1] ? Math.abs(t[1].midi - t[0].midi) * 100 : null;
      if (finite(size) && asked && Math.abs(size) < 0.5 * asked) return 'the neighbour note was too close to the main note';
      break;
    }
    case 'flip': {
      const asked = t[1] ? Math.abs(t[1].midi - t[0].midi) * 100 : null;
      if (finite(size) && asked && size < 0.7 * asked) return `the jump was only ${P.pitchDistance(size)}`;
      if (finite(r.timeMs) && r.timeMs > FLIP_SLIDE_MS) return 'it slid up instead of flipping';
      break;
    }
  }
  if (finite(r.landingAbsCents) && r.landingAbsCents >= 20) return `it landed ${P.pitchDistance(r.landingAbsCents)} off the note`;
  return 'its shape did not quite match the demo';
}

function figures(ctx: Ctx): Found {
  const kind = ctx.rule?.inflection;
  const all = (ctx.details?.inflections ?? []).filter((f) => !kind || f.kind === kind);
  const ranked = worstFirst(all, (f) => 1 - f.result.score, (f) => f.result.score < 0.85);
  const metric: MetricKey = 'inflection.score';
  const w = ranked[0];
  if (!w) return plainMeasure(ctx, metric);
  const t0 = (f: Figure) => f.targets[0].start;
  return {
    what: `${P.sentence(figureName(ctx, w))} at ${P.clock(t0(w))} was the weakest${req(ctx, metric)}: ${figureFault(w)}.`,
    spots: ranked.map((f) => spot(t0(f), `${P.clock(t0(f))}, ${figureName(ctx, f).replace(/^the /, '')}`)),
  };
}

function figureLanding(ctx: Ctx): Found {
  const all = (ctx.details?.inflections ?? []).filter((f) => finite(f.result.landingAbsCents));
  const ranked = worstFirst(all, (f) => f.result.landingAbsCents as number, (f) => (f.result.landingAbsCents as number) >= 10);
  const metric: MetricKey = 'inflection.landingAbsCents';
  const v = ctx.metrics[metric];
  if (!finite(v)) return unmeasured(metric);
  const w = ranked[0];
  const t0 = (f: Figure) => f.targets[0].start;
  return {
    what: `Your landings after each figure were typically off by ${P.pitchDistance(v)}${req(ctx, metric)}${
      w ? `; the furthest was ${figureName(ctx, w)} at ${P.clock(t0(w))}` : ''
    }.`,
    spots: ranked.map((f) => spot(t0(f), `${P.clock(t0(f))}, ${figureName(ctx, f).replace(/^the /, '')}, off by ${P.pitchDistance(f.result.landingAbsCents as number)}`)),
  };
}

// ---------------------------------------------------------------- runs

interface RunNoteAt {
  run: number;
  index: number;
  note: TargetNote | undefined;
  midi: number;
  verdict: RunNoteVerdict;
}

function runNotes(ctx: Ctx): RunNoteAt[] {
  return (ctx.details?.runs ?? []).flatMap((r, run) =>
    r.result.notes.map((n) => ({ run, index: n.index, note: r.notes[n.index], midi: n.targetMidi, verdict: n.verdict })),
  );
}

/**
 * What the run analyzer's groups are called in this exercise: runs in the Runs world, turns in a turn figure, rounds of
 * the back-and-forth in the oscillation drills.
 */
function runWords(ctx: Ctx): { group: string; groups: string; notes: string } {
  if (ctx.def.worldId === 'runs') return { group: 'run', groups: 'run', notes: 'run notes' };
  if (ctx.def.kind === 'oscillation') return { group: 'round', groups: 'back-and-forth', notes: 'notes' };
  return { group: 'turn', groups: 'turns', notes: 'notes of the turns' };
}

function runRef(ctx: Ctx, n: RunNoteAt): string {
  const several = (ctx.details?.runs.length ?? 0) > 1;
  return `${several ? `${runWords(ctx).group} ${n.run + 1}, ` : ''}note ${n.index + 1} (${name(ctx, n.midi)})`;
}

/** "notes 3 and 5" of a single run; "most of them in run 2" of several. */
function whichRunNotes(ctx: Ctx, picked: readonly RunNoteAt[]): string {
  if (picked.length === 0) return '';
  if ((ctx.details?.runs.length ?? 0) <= 1) {
    const nums = picked.map((n) => String(n.index + 1));
    return `: ${nums.length === 1 ? 'note' : 'notes'} ${P.listWords(nums)}`;
  }
  const byRun = new Map<number, number>();
  for (const n of picked) byRun.set(n.run, (byRun.get(n.run) ?? 0) + 1);
  const [run, k] = [...byRun.entries()].sort((a, b) => b[1] - a[1])[0];
  const group = runWords(ctx).group;
  return k === picked.length ? `, all in ${group} ${run + 1}` : `, most of them in ${group} ${run + 1}`;
}

function runVerdicts(ctx: Ctx, verdict: RunNoteVerdict, metric: MetricKey): Found {
  const all = runNotes(ctx);
  const picked = all.filter((n) => n.verdict === verdict);
  const word = verdict === 'missed' ? 'missed' : 'blurred';
  const spots = picked.filter((n) => n.note).map((n) => spot((n.note as TargetNote).start, `${runRef(ctx, n)}, ${word}`));
  if (all.length === 0) return plainMeasure(ctx, metric);
  const { notes } = runWords(ctx);
  if (verdict === 'missed') return { what: `You missed ${picked.length} of the ${all.length} ${notes}${req(ctx, metric)}${whichRunNotes(ctx, picked)}.`, spots };
  const clear = all.filter((n) => n.verdict === 'defined').length;
  return {
    what: `${clear === 0 ? 'None' : clear} of the ${all.length} ${notes} came out clear${req(ctx, metric)}; ${picked.length} blurred into their neighbours${whichRunNotes(ctx, picked)}.`,
    spots,
  };
}

function runWorst(ctx: Ctx): Found {
  const all = runNotes(ctx);
  const missed = all.filter((n) => n.verdict === 'missed');
  const smeared = all.filter((n) => n.verdict === 'smeared');
  const metric: MetricKey = 'run.score';
  const v = ctx.metrics[metric];
  if (!finite(v)) return unmeasured(metric);
  const parts = [missed.length > 0 ? `${missed.length} missed` : '', smeared.length > 0 ? `${smeared.length} blurred` : ''].filter(Boolean);
  return {
    what: `Your ${runWords(ctx).groups} scored ${P.shareText(v)}${req(ctx, metric)}${
      parts.length > 0 ? `; ${P.listWords(parts)} ${missed.length + smeared.length === 1 ? 'note cost' : 'notes cost'} the most` : ''
    }.`,
    spots: [...missed, ...smeared].filter((n) => n.note).map((n) => spot((n.note as TargetNote).start, `${runRef(ctx, n)}, ${n.verdict === 'missed' ? 'missed' : 'blurred'}`)),
  };
}

// ---------------------------------------------------------------- loudness

type Hold = TakeDetails['dynamics'][number];
const holds = (ctx: Ctx): Hold[] => ctx.details?.dynamics ?? [];

/** What the cue asked of the hold, as an action: "grow from soft to full". */
function askedOf(h: Hold): string {
  if (h.shape === 'crescendo') return 'grow from soft to full';
  if (h.shape === 'decrescendo') return 'fade from full to soft';
  if (h.shape === 'swell') return 'grow and then fade';
  if (h.contour) return `go ${h.contour.points.join(', then ')}`;
  return 'follow the loudness cue';
}

/** What the loudness did on the hold (analysis/dynamics.ts DynamicsDetail.shape, when the result carries it). */
function didOf(h: Hold): string {
  const shape = (h.result as Partial<DynamicsDetail>).shape;
  if (shape === 'crescendo') return 'grew from soft to loud';
  if (shape === 'decrescendo') return 'faded from loud to soft';
  if (shape === 'swell') return 'grew and faded';
  if (shape === 'inverted') return 'went loud, soft, then loud';
  if (shape === 'uneven') return 'did not follow it';
  return h.result.verdict === 'insufficient-range' ? 'barely changed' : 'did not follow it';
}

function againstCue(ctx: Ctx): Found {
  const off = holds(ctx).filter((h) => h.shapeScore !== null && h.shapeScore < FOLLOWS_CUE_SCORE);
  const w = off[0];
  return {
    what: w ? `On ${ref(ctx, w.note)} the cue asked you to ${askedOf(w)}, but your loudness ${didOf(w)}.` : 'Your loudness moved against the cue.',
    spots: off.map((h) => spot(h.note.start, `${ref(ctx, h.note)}, against the cue`)),
  };
}

const VERDICT_WORDS: Partial<Record<DynamicsResult['verdict'], string>> = {
  'sharp-when-loud': 'sharp as you got louder',
  'flat-when-soft': 'flat as you got softer',
};

function loudPitch(ctx: Ctx): Found {
  const verdict = ctx.rule?.verdict;
  const slope = (h: Hold) => (finite(h.result.slopeCentsPerDb) ? Math.abs(h.result.slopeCentsPerDb) : 0);
  if (verdict && VERDICT_WORDS[verdict]) {
    const hit = worstFirst(holds(ctx), slope, (h) => h.result.verdict === verdict);
    const words = VERDICT_WORDS[verdict];
    const n = holds(ctx).length;
    const what =
      hit.length > 1
        ? `Your pitch went ${words} on ${hit.length === n ? `all ${n}` : `${hit.length} of the ${n}`} notes${req(ctx, 'dynamics.absSlopeCentsPerDb')}.`
        : hit[0]
          ? `Your pitch went ${words} on ${ref(ctx, hit[0].note)}${req(ctx, 'dynamics.absSlopeCentsPerDb')}.`
          : `Your pitch went ${words}.`;
    return { what, spots: hit.map((h) => spot(h.note.start, `${ref(ctx, h.note)}, ${words}`)) };
  }
  const metric: MetricKey = 'dynamics.absSlopeCentsPerDb';
  const v = ctx.metrics[metric];
  if (!finite(v)) return unmeasured(metric);
  const ranked = worstFirst(holds(ctx), slope, (h) => slope(h) >= 0.5);
  const way = (h: Hold) => ((h.result.slopeCentsPerDb ?? 0) > 0 ? 'rose as you got louder' : 'fell as you got louder');
  return {
    what: `Your pitch ${P.pitchWithLoudness(v)} as the loudness changed${req(ctx, metric)}${ranked[0] ? `; on ${ref(ctx, ranked[0].note)} it ${way(ranked[0])}` : ''}.`,
    spots: ranked.map((h) => spot(h.note.start, `${ref(ctx, h.note)}, pitch ${way(h)}`)),
  };
}

function loudRange(ctx: Ctx): Found {
  if (ctx.rule?.againstCue) return againstCue(ctx);
  const metric: MetricKey = 'dynamics.rangeDb';
  const v = ctx.metrics[metric];
  if (!finite(v)) return unmeasured(metric);
  const ranked = worstFirst(holds(ctx), (h) => -h.result.rangeDb, (h) => h.result.rangeDb < 16);
  return {
    what: `From softest to loudest, your loudness ${P.loudnessChange(v)}${req(ctx, metric)}${ranked[0] ? `; it changed least on ${ref(ctx, ranked[0].note)}` : ''}.`,
    spots: ranked.map((h) => spot(h.note.start, `${ref(ctx, h.note)}, ${P.loudnessChange(h.result.rangeDb)}`)),
  };
}

function symmetry(ctx: Ctx): Found {
  const swells = holds(ctx).filter((h) => h.shape === 'swell' && finite(h.result.symmetry));
  const ranked = worstFirst(swells, (h) => 1 - (h.result.symmetry as number), (h) => (h.result.symmetry as number) < 0.85);
  const metric: MetricKey = 'dynamics.symmetry';
  const w = ranked[0];
  const peak = (h: Hold) => h.result.peakPosition;
  const shapeWords = (h: Hold): string => {
    const p = peak(h);
    if (!finite(p)) return 'one side was quicker than the other';
    if (p < 0.35) return 'you reached your loudest early, then faded for the rest of the note';
    if (p > 0.65) return 'you grew for most of the note and had little time left to fade';
    return 'it did not come back down as far as it started';
  };
  if (!w) return finite(ctx.metrics[metric]) ? plainMeasure(ctx, metric) : unmeasured(metric);
  return {
    what: `Your swell on ${ref(ctx, w.note)} was lopsided: ${shapeWords(w)}.`,
    spots: ranked.map((h) => spot(h.note.start, finite(peak(h)) ? `${ref(ctx, h.note)}, loudest ${P.whereIn(peak(h) as number)}` : `${ref(ctx, h.note)}, lopsided`)),
  };
}

// ---------------------------------------------------------------- range

function range(ctx: Ctx, missing: boolean): Found {
  const r = ctx.details?.range ?? null;
  if (missing || !r || r.lowestMidi === null || r.highestMidi === null) {
    return { what: 'No note was held long enough to measure, so the app could not find your range.', spots: [] };
  }
  const span = r.highestMidi - r.lowestMidi;
  const lowName = name(ctx, r.lowestMidi);
  const highName = name(ctx, r.highestMidi);
  const narrow = ctx.rule?.id === 'range.narrow' || span < RANGE_MIN_SPAN;
  const what = narrow
    ? `You held ${lowName} and ${highName}, ${P.spanWords(span)} apart; the exercises need ${P.spanWords(RANGE_MIN_SPAN)}.`
    : `You held notes from ${lowName} to ${highName}, ${P.spanWords(span)} apart.`;
  const lowest = r.heldNotes.find((h) => Math.round(h.midi) === Math.round(r.lowestMidi as number));
  const highest = r.heldNotes.find((h) => Math.round(h.midi) === Math.round(r.highestMidi as number));
  const spots: ProblemSpot[] = [];
  if (lowest) spots.push(spot(lowest.start, `${P.clock(lowest.start)}, your lowest held note, ${lowName}`));
  if (highest && highest !== lowest) spots.push(spot(highest.start, `${P.clock(highest.start)}, your highest held note, ${highName}`));
  return { what, spots };
}

// ---------------------------------------------------------------- the table

type Locator = (ctx: Ctx, missing: boolean) => Found;

/** Locators that read a missing metric themselves (a 'missing' tip has its own words). */
const MISSING_AWARE: ReadonlySet<MetricKey> = new Set<MetricKey>([
  'accuracy.inTolerancePct', 'onset.settleMs', 'pulse.rateErrorHz', 'glide.endAbsCents', 'range.spanSemitones', 'dynamics.rangeDb',
]);

const LOCATORS: Partial<Record<MetricKey, Locator>> = {
  'accuracy.absBiasCents': (c) => bias(c),
  'accuracy.inTolerancePct': inTune,
  'accuracy.medianAbsCents': (c) => typicalMiss(c),
  'accuracy.sdCents': (c) => wobble(c),
  'accuracy.absDriftCentsPerSec': (c) => drift(c),
  'onset.scoopCents': (c) => scoop(c),
  'onset.settleMs': settle,
  'onset.overshootCents': (c) => overshoot(c),
  'onset.crispRate': (c) => crisp(c),
  'vibrato.present': (c) => noVibrato(c),
  'vibrato.rateHz': (c) => vibratoRate(c),
  'vibrato.extentCents': (c) => vibratoWidth(c),
  'vibrato.inZone': (c) => vibratoZoneMiss(c),
  'vibrato.regularity': (c) => vibratoEvenness(c),
  'vibrato.absCenteringCents': (c) => vibratoCentre(c),
  'vibrato.switchCleanRate': (c) => switches(c),
  'vibrato.bloomOnCue': (c) => bloom(c),
  'pulse.rateErrorHz': pulseRate,
  'pulse.regularity': (c) => pulseEvenness(c),
  'glide.cracks': (c) => cracks(c),
  'glide.smoothness': (c) => stairs(c),
  'glide.endAbsCents': glideEnd,
  'transition.cleanRate': (c) => transitions(c),
  'inflection.score': (c) => figures(c),
  'inflection.landingAbsCents': (c) => figureLanding(c),
  'run.missedRate': (c) => runVerdicts(c, 'missed', 'run.missedRate'),
  'run.definedRate': (c) => runVerdicts(c, 'smeared', 'run.definedRate'),
  'run.score': (c) => runWorst(c),
  'dynamics.absSlopeCentsPerDb': (c) => loudPitch(c),
  'dynamics.rangeDb': (c) => loudRange(c),
  'dynamics.symmetry': (c) => symmetry(c),
  'range.spanSemitones': range,
};
