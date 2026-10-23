/**
 * Catalog validator: the structural and pedagogical invariants of SPEC §9 and
 * §11-§11.2, checked on data. validate.test.ts runs it on the real catalog;
 * imported exercise packs (ROADMAP v2) must pass it too, so it never imports
 * the catalog itself: what it needs from the catalog (such as the narrowest
 * range the Range finder can save, its span gate) it reads from the catalog
 * it is given. Returns every problem found (empty = valid).
 *
 * Analyzer -> metrics map: metrics.ts (ANALYZER_METRICS). Scoring semantics:
 * evaluate.ts. Analysis inputs: plan.ts.
 *
 * Lessons (src/lessons): a world taught as lessons (ECHO_WORLDS) obeys the echo rule (checkEcho), its practice drills
 * are catalog exercises named `<world>.drill.<name>` (isDrillId) that no level or audition plays, and validateLessons
 * checks the lessons against the catalog they are given.
 *
 * Retired exercises (ExerciseDef.retired: material a rebuild replaced, kept so old takes read back against it) are
 * frozen history: they are not validated as material to sing, only checked to be sung by nothing (no level, audition or
 * lesson), and a rebuilt audition's `former` tests must be retired tests of its world.
 */
import { CONFIG } from '../config';
import type { ToleranceLevel } from '../core/types';
import type { MetricKey, Metrics } from '../analysis/types';
import type { LessonDef } from '../lessons/types';
import type { VocalRange } from '../storage/schema';
import { TERMS } from '../teach/glossary';
import { cueCollision, CUE, INFLECTION_CUES, VIBRATO_CUES } from './cues';
import { evaluate, gateHolds } from './evaluate';
import { METRIC_INFO, metricsProducedBy } from './metrics';
import { PLAN, planAnalysis } from './plan';
import { getTip } from './tips';
import { effectiveRange, materialSpan, realize, repeatCount, usesExtendedRange, type VoiceType } from './transpose';
import type { AnalyzerId, AuditionDef, ExerciseDef, ExerciseKind, LevelDef, PatternStep, WorldDef, WorldId } from './types';

export interface ValidationIssue {
  /** Where: an exercise, level, audition or world id (plus detail). */
  path: string;
  message: string;
}

export interface CatalogLike {
  worlds: readonly WorldDef[];
  exercises: readonly ExerciseDef[];
}

/** Training worlds in unlock order, then Song Stage (SPEC §11). */
export const WORLD_SEQUENCE: readonly WorldId[] = ['foundations', 'vibrato', 'inflections', 'runs', 'dynamics', 'song-stage'];
const SONG_STAGE: WorldId = 'song-stage';

const TOLERANCES: readonly ToleranceLevel[] = ['easy', 'default', 'studio'];
const STRICTNESS: Readonly<Record<ToleranceLevel, number>> = { easy: 0, default: 1, studio: 2 };
const ANALYZERS: ReadonlySet<AnalyzerId> = new Set<AnalyzerId>([
  'accuracy', 'onset', 'vibrato', 'glide', 'cracks', 'transitions', 'inflection', 'run', 'dynamics', 'range', 'pulse', 'switch',
]);

/** Limits for authored data (validator knobs, not singing thresholds). */
const LIMITS = {
  minLevels: 6,
  /** Foundations is thirteen small lessons, one new thing each. */
  maxLevels: 14,
  tempo: [30, 240] as const,
  takeSec: [4, 60] as const,
  /** Silence before each judged attack, so the singer re-attacks from silence (and the onset look-back stays in the rest). */
  attackGapSec: PLAN.onsetLookbackSec,
  /** Each straight/vibrato window: enough to show vibrato (or its absence) after a switch. */
  switchWindowSec: 1.5,
  /** Shortest pulse train worth measuring. */
  pulseTrainSec: 2,
  /** A practice drill is short: this many seconds of singing (src/lessons/types.ts PracticeStep). */
  drillSingSec: [5, 12] as const,
  /** Practice steps per lesson. */
  lessonSteps: [2, 4] as const,
  /** How-to lines on a Learn page. */
  learnHow: [3, 5] as const,
};

/** Worlds taught as lessons (src/lessons): every sung chunk is heard first (checkEcho). */
export const ECHO_WORLDS: ReadonlySet<WorldId> = new Set<WorldId>(['foundations']);

/** Echo-rule knobs (validator knobs, not singing thresholds). */
const ECHO = {
  /**
   * The singer's turn: the breath between a Listen and the chunk sung back. At least the runner's speaker clearance
   * (runtime/runner.ts SPEAKER_CLEARANCE_SEC), or a phone speaker would cut the Listen tone short.
   */
  turnSec: 0.6,
  /** The most notes one chunk asks for: the five-note line, sung after its halves. */
  maxNotes: 5,
};

/** A lesson's practice drill: a catalog exercise named `<world>.drill.<name>`, sung as practice, never as a level or test. */
export function isDrillId(id: string): boolean {
  return /^[a-z-]+\.drill\.[a-z0-9-]+$/.test(id);
}

/** Analyzers each kind can't do without (its core skill). */
const KIND_NEEDS: Readonly<Record<ExerciseKind, readonly AnalyzerId[]>> = {
  'range-finder': ['range'],
  'pitch-match': ['accuracy', 'onset'],
  sustain: ['accuracy'],
  siren: ['glide', 'cracks'],
  staccato: ['onset'],
  intervals: ['onset'],
  legato: ['transitions'],
  'vibrato-meter': ['vibrato'],
  'pulse-builder': ['pulse'],
  oscillation: ['run'],
  'straight-to-bloom': ['switch', 'vibrato'],
  'vibrato-switch': ['switch', 'vibrato'],
  scoop: ['inflection'],
  fall: ['inflection'],
  slide: ['inflection', 'glide'],
  turn: ['inflection', 'run'],
  flip: ['inflection'],
  run: ['run'],
  swell: ['dynamics'],
  'boss-recital': [],
  audition: [],
};

/** Inflection kinds whose exercises must contain that figure. */
const KIND_FIGURE: Partial<Record<ExerciseKind, string>> = { scoop: CUE.scoop, fall: CUE.fall, slide: CUE.slide, turn: CUE.turn, flip: CUE.flip };

/** Ranges every exercise must transpose into: the defaults (no saved range) plus typical saved ranges. */
export interface RangeCase {
  name: string;
  voiceType: VoiceType;
  range: VocalRange | null;
  /** Folding by octaves is tolerated (a range narrower than any the Range finder saves). None of RANGE_CASES allows it. */
  allowFold: boolean;
}

const saved = (low: number, high: number, cLow: number, cHigh: number): VocalRange => ({
  extended: { low, high }, comfortable: { low: cLow, high: cHigh }, measuredAt: '2026-10-21T00:00:00.000Z',
});

export const RANGE_CASES: readonly RangeCase[] = [
  { name: 'tenor default', voiceType: 'tenor', range: null, allowFold: false },
  { name: 'baritone default', voiceType: 'baritone', range: null, allowFold: false },
  { name: 'other default', voiceType: 'other', range: null, allowFold: false },
  { name: 'unknown default', voiceType: 'unknown', range: null, allowFold: false },
  { name: 'tenor B2-C5', voiceType: 'tenor', range: saved(47, 72, 49, 69), allowFold: false },
  { name: 'high baritone G2-G4', voiceType: 'baritone', range: saved(43, 67, 45, 64), allowFold: false },
  { name: 'narrow beginner C3-D4', voiceType: 'unknown', range: saved(48, 62, 50, 59), allowFold: false },
  // The narrowest range a passed Range finder saves: an octave (rangeFromMeasurement(50, 62)). Nothing may fold in it.
  { name: 'narrowest saved octave D3-D4', voiceType: 'unknown', range: saved(50, 62, 52, 59), allowFold: false },
];

type Issues = ValidationIssue[];
const add = (out: Issues, path: string, message: string) => out.push({ path, message });

/** Every issue with one exercise on its own (no catalog context). */
export function validateExercise(def: ExerciseDef): ValidationIssue[] {
  const out: Issues = [];
  const p = def.id || '(no id)';
  if (!def.id || !def.id.startsWith(`${def.worldId}.`)) add(out, p, `id must start with "${def.worldId}."`);
  if (!def.title?.trim()) add(out, p, 'title is empty');
  checkGoal(out, p, def.goal);
  if (!TOLERANCES.includes(def.tolerance)) add(out, p, `unknown tolerance "${def.tolerance}"`);
  if (!(def.tempoBpm >= LIMITS.tempo[0] && def.tempoBpm <= LIMITS.tempo[1])) add(out, p, `tempo ${def.tempoBpm} outside ${LIMITS.tempo.join('-')} bpm`);
  if (!Number.isInteger(def.countInBeats) || def.countInBeats < 0) add(out, p, 'countInBeats must be a whole number >= 0');
  checkPattern(out, p, def);
  checkAnalyzers(out, p, def);
  checkScoring(out, p, def);
  checkPass(out, p, def);
  checkDemoAndLadder(out, p, def);
  checkTips(out, p, def);
  checkPlan(out, p, def);
  checkEcho(out, p, def);
  if (isDrillId(def.id)) checkDrill(out, p, def);
  return out;
}

/** The pitches a chunk moves through, in order: a glide counts its two ends, and a repeated pitch counts once. */
function pitchLine(steps: readonly PatternStep[]): number[] {
  const out: number[] = [];
  const push = (s: number): void => {
    if (out[out.length - 1] !== s) out.push(s);
  };
  for (const s of steps) {
    if (s.semis === undefined) continue;
    push(s.semis);
    if (s.glideToSemis !== undefined) push(s.glideToSemis);
  }
  return out;
}

/**
 * The echo rule (owner, 2026-10-23: "I need to know the note before I sing it"), in a world taught as lessons: the pattern
 * is a run of turns, each one the app playing a chunk (Listen steps), the singer's breath of at least ECHO.turnSec, then
 * the chunk sung back. The Listen plays exactly the notes the chunk asks for, in order (a slide is compared by its two
 * ends, and is heard as a slide: a Listen step may glide); a chunk asks for at most ECHO.maxNotes notes and ends with a
 * breath before the next Listen. Nothing sounds while the singer sings, so there is no metronome. The Range finder sings
 * past what it plays (the singer finds their own lowest and highest notes), so only the first note of each of its chunks
 * is heard.
 */
function checkEcho(out: Issues, p: string, def: ExerciseDef): void {
  if (!ECHO_WORLDS.has(def.worldId) || def.pattern.length === 0) return;
  if (def.metronome) add(out, p, 'an echo exercise sounds nothing while the singer sings: no metronome (the count-in gives the start)');
  const steps = def.pattern;
  if (steps[0].cue !== CUE.listen) add(out, p, 'an echo exercise opens with the app playing the first chunk (a Listen step), never with the singer');
  const spb = 60 / def.tempoBpm;
  const exploring = def.kind === 'range-finder';
  let i = 0;
  while (i < steps.length) {
    const heard: PatternStep[] = [];
    while (i < steps.length && steps[i].cue === CUE.listen) heard.push(steps[i++]);
    const start = i;
    const chunk: PatternStep[] = [];
    while (i < steps.length && steps[i].cue !== CUE.listen) chunk.push(steps[i++]);
    if (heard.length === 0) continue; // material before the first Listen: reported above
    const where = `${p} step ${start}`;
    const sungIdx = chunk.findIndex((s) => s.semis !== undefined);
    if (sungIdx < 0) {
      add(out, where, 'a Listen is followed by nothing to sing back');
      continue;
    }
    const turn = chunk.slice(0, sungIdx).reduce((sum, s) => sum + s.beats, 0) * spb;
    if (turn < ECHO.turnSec - 1e-6) {
      add(out, where, `the singer's turn after a Listen lasts ${turn.toFixed(2)} s; give at least ${ECHO.turnSec} s to breathe (and a phone speaker time to fall silent)`);
    }
    if (i < steps.length && chunk[chunk.length - 1].semis !== undefined) add(out, where, 'a sung chunk ends with a breath before the next Listen');
    const heardLine = pitchLine(heard);
    const sungLine = pitchLine(chunk);
    if (exploring) {
      if (heardLine.length !== 1 || heardLine[0] !== sungLine[0]) add(out, where, `the Range finder plays the one note each half starts on (heard ${heardLine.join(' ')}, starts on ${sungLine[0]})`);
    } else if (heardLine.join() !== sungLine.join()) {
      add(out, where, `the Listen plays ${heardLine.join(' ')} but the chunk asks for ${sungLine.join(' ')}: an echo plays exactly what is sung back`);
    }
    if (sungLine.length > ECHO.maxNotes) add(out, where, `a chunk of ${sungLine.length} notes is more than a beginner can hold in mind (at most ${ECHO.maxNotes})`);
  }
}

/** A practice drill is short (LIMITS.drillSingSec of singing) and only ever a lesson step, in a world taught as lessons. */
function checkDrill(out: Issues, p: string, def: ExerciseDef): void {
  if (!ECHO_WORLDS.has(def.worldId)) add(out, p, `practice drills belong to a world taught as lessons, not ${def.worldId}`);
  if (def.kind === 'boss-recital' || def.kind === 'audition' || def.kind === 'range-finder') add(out, p, `a practice drill cannot be a ${def.kind}`);
  const beats = def.pattern.reduce((sum, s) => sum + (s.semis !== undefined && s.cue !== CUE.listen ? s.beats : 0), 0);
  const sec = (beats * 60 * repeatCount(def)) / def.tempoBpm;
  const [lo, hi] = LIMITS.drillSingSec;
  if (sec < lo - 1e-6 || sec > hi + 1e-6) add(out, p, `a practice drill asks for ${sec.toFixed(1)} s of singing; keep it within ${lo}-${hi} s`);
}

function checkGoal(out: Issues, p: string, goal: string): void {
  const g = goal?.trim() ?? '';
  if (!g) return void add(out, p, 'goal is empty');
  if (!g.endsWith('.')) add(out, p, 'goal must be one sentence ending with a full stop');
  if (/[!?]/.test(g) || /\.\s/.test(g.slice(0, -1))) add(out, p, 'goal must be a single plain sentence (no ! or ?, no second sentence)');
}

function checkPattern(out: Issues, p: string, def: ExerciseDef): void {
  if (def.pattern.length === 0) return void add(out, p, 'pattern is empty');
  if (def.pattern[0].semis === undefined) add(out, p, 'pattern starts with a rest (the count-in already gives a lead-in)');
  if (!def.pattern.some((s) => s.semis !== undefined && s.cue !== CUE.listen)) add(out, p, 'pattern has no sung step');
  def.pattern.forEach((s, i) => {
    const where = `${p} step ${i}`;
    if (!(s.beats > 0) || !Number.isFinite(s.beats)) add(out, where, 'beats must be a positive number');
    if (s.semis !== undefined && !Number.isInteger(s.semis)) add(out, where, 'semis must be a whole number of semitones');
    if (s.glideToSemis !== undefined) {
      if (s.semis === undefined) add(out, where, 'glideToSemis needs semis (a rest cannot glide)');
      if (!Number.isInteger(s.glideToSemis)) add(out, where, 'glideToSemis must be a whole number');
      if (s.glideToSemis === s.semis) add(out, where, 'a glide must change pitch');
      // A world taught as lessons plays a slide as it is to be sung (the runner and the demo play a gliding Listen step
      // as one sliding tone); elsewhere a Listen step is a plain note.
      if (s.cue === CUE.listen && !ECHO_WORLDS.has(def.worldId)) add(out, where, 'a Listen step cannot glide');
    }
    if (s.cue !== undefined) {
      const clash = cueCollision(s.cue);
      if (clash) add(out, where, `cue "${s.cue}" looks like the semantic cue "${clash}"; use the CUE constant or other words`);
      if (!s.cue.trim()) add(out, where, 'cue is blank');
    }
  });
  const r = def.repeats;
  if (r) {
    if (!Number.isInteger(r.count) || r.count < 1) add(out, p, 'repeats.count must be a whole number >= 1');
    if (!Number.isInteger(r.stepSemis)) add(out, p, 'repeats.stepSemis must be a whole number');
    if (r.count > 1 && def.pattern[def.pattern.length - 1].semis !== undefined) add(out, p, 'a repeated pattern must end with a rest (a breath, and room to sound the next key)');
  }
}

function checkAnalyzers(out: Issues, p: string, def: ExerciseDef): void {
  if (def.analyzers.length === 0) add(out, p, 'no analyzers');
  if (new Set(def.analyzers).size !== def.analyzers.length) add(out, p, 'duplicate analyzers');
  for (const a of def.analyzers) if (!ANALYZERS.has(a)) add(out, p, `unknown analyzer "${a}"`);
  for (const need of KIND_NEEDS[def.kind] ?? []) if (!def.analyzers.includes(need)) add(out, p, `kind "${def.kind}" needs the "${need}" analyzer`);
  const fig = KIND_FIGURE[def.kind];
  if (fig && !def.pattern.some((s) => s.cue === fig)) add(out, p, `kind "${def.kind}" must contain a "${fig}" figure`);
  if (def.kind === 'pitch-match' && !def.pattern.some((s) => s.cue === CUE.listen)) add(out, p, 'pitch match needs Listen steps');
  if (def.kind === 'straight-to-bloom' && !def.pattern.some((s) => s.cue === CUE.bloom)) add(out, p, 'straight-to-bloom needs a Bloom cue');
  if (def.kind === 'vibrato-switch' && !(def.pattern.some((s) => s.cue === CUE.straight) && def.pattern.some((s) => s.cue === CUE.vibrato))) {
    add(out, p, 'on/off switching needs both Straight and Vibrato on cues');
  }
}

function checkScoring(out: Issues, p: string, def: ExerciseDef): void {
  const produced = metricsProducedBy(def.analyzers);
  if (def.scoring.length === 0) add(out, p, 'no scoring terms');
  const seen = new Set<MetricKey>();
  for (const t of def.scoring) {
    const where = `${p} term ${t.metric}`;
    const info = METRIC_INFO[t.metric];
    if (!info) {
      add(out, where, 'unknown metric');
      continue;
    }
    if (seen.has(t.metric)) add(out, where, 'metric scored twice');
    seen.add(t.metric);
    if (!produced.has(t.metric)) add(out, where, `no listed analyzer (${def.analyzers.join(', ')}) produces this metric`);
    if (!(t.weight > 0) || !Number.isFinite(t.weight)) add(out, where, 'weight must be positive');
    if (!Number.isFinite(t.best) || !Number.isFinite(t.worst) || t.best === t.worst) add(out, where, 'best and worst must be finite and different');
    if (info.direction === 'target') add(out, where, 'two-sided metric: score vibrato.inZone instead');
    if (info.direction === 'higher' && !(t.best > t.worst)) add(out, where, 'higher-is-better metric needs best > worst');
    if (info.direction === 'lower' && !(t.best < t.worst)) add(out, where, 'lower-is-better metric needs best < worst');
    for (const v of [t.best, t.worst]) if (v < info.min || v > info.max) add(out, where, `band value ${v} outside ${info.min}..${info.max}`);
  }
}

/** Metric values that score 1 on every term (and sit at the domain's good end otherwise). */
function perfectMetrics(def: ExerciseDef): Metrics {
  const m: Metrics = {};
  for (const a of metricsProducedBy(def.analyzers)) {
    const info = METRIC_INFO[a];
    if (info.direction !== 'target') m[a] = info.direction === 'higher' ? info.max : info.min;
  }
  for (const t of def.scoring) m[t.metric] = t.best;
  for (const g of def.pass.gates ?? []) {
    const cur = m[g.metric];
    if (cur === undefined) m[g.metric] = g.op === '>=' ? METRIC_INFO[g.metric].max : METRIC_INFO[g.metric].min;
  }
  return m;
}

function checkPass(out: Issues, p: string, def: ExerciseDef): void {
  const { score } = def.pass;
  const { solid, studio } = def.tiers;
  if (!(score > 0 && score <= 1)) add(out, p, 'pass.score must be in (0, 1]');
  if (!(solid >= score && studio >= solid && studio <= 1)) add(out, p, `tiers must satisfy pass (${score}) <= solid (${solid}) <= studio (${studio}) <= 1`);
  const gates = def.pass.gates ?? [];
  if (gates.length === 0) add(out, p, 'needs at least one gate on a core metric (an unmeasured take must never pass)');
  const produced = metricsProducedBy(def.analyzers);
  for (const g of gates) {
    const where = `${p} gate ${g.metric}`;
    const info = METRIC_INFO[g.metric];
    if (!info) {
      add(out, where, 'unknown metric');
      continue;
    }
    if (!produced.has(g.metric)) add(out, where, `no listed analyzer (${def.analyzers.join(', ')}) produces this metric`);
    if (info.direction === 'higher' && g.op !== '>=') add(out, where, 'a higher-is-better metric is gated with >=');
    if (info.direction === 'lower' && g.op !== '<=') add(out, where, 'a lower-is-better metric is gated with <=');
    if (!Number.isFinite(g.value) || g.value < info.min || g.value > info.max) add(out, where, `gate value ${g.value} outside ${info.min}..${info.max}`);
    const t = def.scoring.find((x) => x.metric === g.metric);
    if (t && !(g.op === '>=' ? t.best >= g.value : t.best <= g.value)) {
      add(out, where, 'the gate is stricter than the term\'s best value: a perfect take would fail it');
    }
  }
  const perfect = evaluate(def, perfectMetrics(def));
  if (!perfect.passed || perfect.mastery !== 3) add(out, p, `a perfect take scores ${perfect.score.toFixed(2)} and ${perfect.passed ? `reaches tally ${perfect.mastery}` : 'fails'}`);
  if (evaluate(def, {}).passed) add(out, p, 'a take with nothing measured passes');
}

function checkDemoAndLadder(out: Issues, p: string, def: ExerciseDef): void {
  if (!['piano', 'sine', 'soft'].includes(def.demo.timbre)) add(out, p, `unknown demo timbre "${def.demo.timbre}"`);
  const judgesVibrato = def.analyzers.includes('vibrato') || def.analyzers.includes('switch');
  if (judgesVibrato && def.demo.vibrato !== 'style') add(out, p, "vibrato exercises demo with vibrato 'style' so the singer hears the target zone");
  if (!judgesVibrato && def.demo.vibrato === 'style') add(out, p, "only vibrato exercises demo with vibrato 'style'");
  const v = def.demo.vibrato;
  if (v && v !== 'style' && !(v.rateHz > 0 && v.extentCents > 0)) add(out, p, 'demo vibrato needs a positive rate and extent');
  const ladder = def.tempoLadder;
  if (ladder) {
    if (!def.analyzers.includes('run')) add(out, p, 'a tempo ladder needs the run analyzer (it advances on run.score)');
    if (ladder.length < 2) add(out, p, 'a tempo ladder needs at least two rungs');
    for (let i = 1; i < ladder.length; i++) if (!(ladder[i] > ladder[i - 1])) add(out, p, 'tempo ladder must rise strictly');
    if (ladder[ladder.length - 1] !== def.tempoBpm) add(out, p, 'tempoBpm (the pass tempo) must be the ladder\'s top rung');
    for (const b of ladder) if (!(b >= LIMITS.tempo[0] && b <= LIMITS.tempo[1])) add(out, p, `ladder rung ${b} outside ${LIMITS.tempo.join('-')} bpm`);
  }
}

function checkTips(out: Issues, p: string, def: ExerciseDef): void {
  const ids = def.tipIds ?? [];
  if (ids.length === 0) add(out, p, 'no coaching tips');
  const explained = new Set<MetricKey>();
  for (const id of ids) {
    const rule = getTip(id);
    if (!rule) {
      add(out, p, `unknown tip "${id}"`);
      continue;
    }
    for (const m of rule.relatesTo ?? [rule.when.metric]) explained.add(m);
  }
  const judged = [...def.scoring.map((t) => t.metric), ...(def.pass.gates ?? []).map((g) => g.metric)];
  for (const m of judged) if (!explained.has(m)) add(out, p, `no coaching tip explains ${m}`);
}

/** Analyzer inputs exist and are long enough, on a realization at the default range. */
function checkPlan(out: Issues, p: string, def: ExerciseDef): void {
  let realized;
  try {
    realized = realize(def, null, 'unknown');
  } catch (e) {
    return void add(out, p, `cannot be realized: ${(e as Error).message}`);
  }
  const plan = planAnalysis(realized);
  for (const issue of plan.issues) add(out, p, issue);
  const lowRung = def.tempoLadder?.[0] ?? def.tempoBpm;
  const slowest = (realized.totalSec * def.tempoBpm) / lowRung;
  if (realized.totalSec < LIMITS.takeSec[0] || slowest > LIMITS.takeSec[1]) {
    add(out, p, `take lasts ${realized.totalSec.toFixed(1)} s (${slowest.toFixed(1)} s at the slowest rung); keep it within ${LIMITS.takeSec.join('-')} s`);
  }
  const has = (a: AnalyzerId) => def.analyzers.includes(a);
  const judged = new Set<MetricKey>([...def.scoring.map((t) => t.metric), ...(def.pass.gates ?? []).map((g) => g.metric)]);
  const need = (cond: boolean, msg: string) => {
    if (!cond) add(out, p, msg);
  };
  if (has('accuracy')) need(plan.accuracy.length > 0, `accuracy needs a held note of at least ${PLAN.accuracyMinHoldSec} s`);
  if (judged.has('accuracy.absDriftCentsPerSec')) {
    const minHold = CONFIG.accuracy.driftMinHoldSec + CONFIG.accuracy.holdStartSkipMs / 1000;
    need(plan.accuracy.some((n) => n.end - n.start >= minHold), `drift needs a hold of at least ${minHold} s`);
  }
  if (has('onset')) {
    need(plan.attacks.length > 0, 'onset needs at least one attack from silence');
    for (const a of plan.attacks) {
      const gap = gapBefore(realized.steps, a.note.start);
      if (gap !== null && gap < LIMITS.attackGapSec - 1e-6) add(out, p, `the attack at ${a.note.start.toFixed(2)} s follows only ${gap.toFixed(2)} s of silence (needs ${LIMITS.attackGapSec} s)`);
    }
  }
  if (has('vibrato')) {
    need(plan.vibrato.length > 0, 'vibrato needs notes to analyze');
    for (const n of plan.vibrato) need(n.end - n.start >= PLAN.vibratoMinNoteSec - 1e-6, `a vibrato note of ${(n.end - n.start).toFixed(2)} s is shorter than ${PLAN.vibratoMinNoteSec} s`);
  }
  if (has('switch')) {
    const vp = plan.vibratoPlan;
    need(vp.length > 0, 'switch needs held notes with Straight/Bloom/Vibrato on cues');
    for (const c of vp) need(c.end - c.start >= LIMITS.switchWindowSec - 1e-6, `a ${c.vibrato ? 'vibrato' : 'straight'} window of ${(c.end - c.start).toFixed(2)} s is shorter than ${LIMITS.switchWindowSec} s`);
    for (const h of plan.holds) {
      const first = h.steps[0].cue;
      need(first !== undefined && VIBRATO_CUES.has(first), `every held note of a switch drill starts with a vibrato cue (the note at ${h.note.start.toFixed(2)} s does not)`);
    }
    const switches = vp.some((c, i) => i > 0 && Math.abs(vp[i - 1].end - c.start) < 1e-6 && vp[i - 1].vibrato !== c.vibrato);
    need(switches, 'switch needs at least one cue change inside a held note');
    if (judged.has('vibrato.bloomOnCue')) {
      need(vp.some((c, i) => i > 0 && c.vibrato && !vp[i - 1].vibrato && Math.abs(vp[i - 1].end - c.start) < 1e-6), 'bloomOnCue needs a straight window followed directly by a vibrato window');
    }
  }
  if (has('pulse')) {
    need(plan.pulses.length > 0, `pulse needs a train of ${PLAN.pulseMinSteps}+ repeated steps on one pitch, or an alternation of two pitches`);
    for (const t of plan.pulses) {
      const span = t.notes[t.notes.length - 1].end - t.notes[0].start;
      need(span >= LIMITS.pulseTrainSec - 1e-6, `a pulse train must last at least ${LIMITS.pulseTrainSec} s (one lasts ${span.toFixed(2)} s)`);
    }
  }
  if (has('glide')) need(plan.glides.length > 0, 'glide needs a glide step');
  if (has('transitions')) need(plan.transitions.length > 0, 'transitions needs two or more connected notes');
  if (has('inflection')) need(plan.inflections.length > 0, 'inflection needs a cued figure (Scoop in, Fall off, Slide, Turn, Flip up)');
  if (has('run')) need(plan.runs.length > 0, `run needs ${PLAN.runMinNotes}+ distinct consecutive notes`);
  if (has('dynamics')) {
    need(plan.dynamics.length > 0, `dynamics needs a hold of at least ${PLAN.dynamicsMinHoldSec} s`);
    for (const d of plan.dynamics) {
      need(d.contour !== null, `the dynamics hold at ${d.note.start.toFixed(2)} s needs a loudness cue (crescendo, decrescendo, swell, or soft/loud steps) to be judged against`);
    }
  }
  if (judged.has('dynamics.symmetry')) need(plan.dynamics.some((d) => d.shape === 'swell'), `symmetry needs a note cued as a swell ("${CUE.swell}")`);
  if (has('range')) need(def.kind === 'range-finder', 'only the range finder measures range');
  if (has('inflection') && !def.pattern.some((s) => s.cue !== undefined && INFLECTION_CUES.has(s.cue))) add(out, p, 'inflection needs an inflection cue');
}

/** Seconds of silence (rest or Listen) before `t`, back to the previous sung step; null for the first phrase. */
function gapBefore(steps: ReturnType<typeof realize>['steps'], t: number): number | null {
  let prevEnd: number | null = null;
  for (const s of steps) {
    if (s.role === 'sing' && s.end <= t + 1e-9 && (prevEnd === null || s.end > prevEnd)) prevEnd = s.end;
  }
  return prevEnd === null ? null : t - prevEnd;
}

/** Every issue in a catalog (each exercise, plus worlds, levels, auditions, unlocks and transposition). */
export function validateCatalog(catalog: CatalogLike, rangeCases: readonly RangeCase[] = RANGE_CASES): ValidationIssue[] {
  const out: Issues = [];
  const exById = new Map<string, ExerciseDef>();
  for (const e of catalog.exercises) {
    if (exById.has(e.id)) add(out, e.id, 'duplicate exercise id');
    exById.set(e.id, e);
    // A retired exercise is frozen history, read back but never sung: it is not judged as material to sing.
    if (e.retired === undefined) out.push(...validateExercise(e));
    else if (!e.id.startsWith(`${e.worldId}.`) || !e.retired.trim()) add(out, e.id, 'a retired exercise keeps its world prefix and says when it was retired');
  }
  const live = catalog.exercises.filter((e) => e.retired === undefined);

  const ids = new Set<string>();
  const uniq = (id: string, what: string) => {
    if (ids.has(id)) add(out, id, `duplicate ${what} id`);
    ids.add(id);
  };
  const worldIds = catalog.worlds.map((w) => w.id);
  if (worldIds.join() !== WORLD_SEQUENCE.join()) add(out, 'worlds', `world order must be ${WORLD_SEQUENCE.join(' -> ')}`);

  const levelById = new Map<string, LevelDef>();
  const usedByLevel = new Map<string, string>();
  const bossOf = new Map<WorldId, LevelDef>();
  for (const w of catalog.worlds) {
    uniq(w.id, 'world');
    if (!w.accent?.startsWith('--')) add(out, w.id, 'accent must be a CSS token name');
    if (!w.title?.trim() || !w.summary?.trim()) add(out, w.id, 'world needs a title and summary');
    if (w.id === SONG_STAGE) {
      if (w.levels.length > 0 || w.audition) add(out, w.id, 'Song Stage has no levels or audition (songs unlock by rated world)');
      continue;
    }
    if (w.levels.length < LIMITS.minLevels || w.levels.length > LIMITS.maxLevels) add(out, w.id, `has ${w.levels.length} levels; expected ${LIMITS.minLevels}-${LIMITS.maxLevels} including the boss`);
    const bosses = w.levels.filter((l) => l.kind === 'boss');
    if (bosses.length !== 1) add(out, w.id, `needs exactly one Boss Recital (found ${bosses.length})`);
    else bossOf.set(w.id, bosses[0]);
    if (w.levels.length > 0 && w.levels[w.levels.length - 1].kind !== 'boss') add(out, w.id, 'the Boss Recital must be the last level');
    let prevTol = -1;
    const isLevelNumber = (id: string): boolean => id.startsWith(`${w.id}.`) && /^\d{2}$/.test(id.slice(w.id.length + 1));
    w.levels.forEach((l, i) => {
      uniq(l.id, 'level');
      levelById.set(l.id, l);
      if (l.worldId !== w.id) add(out, l.id, `level belongs to ${l.worldId}, listed in ${w.id}`);
      if (l.index !== i + 1) add(out, l.id, `index ${l.index} should be ${i + 1} (levels are numbered in order from 1)`);
      // The id is persisted identity and the index the order (a level added later takes a new number wherever it goes).
      if (l.kind === 'boss' ? l.id !== `${w.id}.boss` : !isLevelNumber(l.id)) {
        add(out, l.id, l.kind === 'boss' ? `a Boss Recital's id is ${w.id}.boss` : `a level id is ${w.id}.NN, a two-digit number`);
      }
      if (!l.title?.trim()) add(out, l.id, 'level title is empty');
      const ex = exById.get(l.exerciseId);
      if (!ex) return void add(out, l.id, `references missing exercise ${l.exerciseId}`);
      if (ex.retired !== undefined) add(out, l.id, `plays ${ex.id}, which is retired (never sung again)`);
      const prevUse = usedByLevel.get(ex.id);
      if (prevUse) add(out, l.id, `exercise ${ex.id} is already used by ${prevUse}`);
      usedByLevel.set(ex.id, l.id);
      if (ex.worldId !== w.id) add(out, l.id, `exercise ${ex.id} belongs to ${ex.worldId}`);
      if (l.kind === 'boss' && ex.kind !== 'boss-recital') add(out, l.id, 'a boss level plays a boss-recital exercise');
      if (l.kind !== 'boss' && (ex.kind === 'boss-recital' || ex.kind === 'audition')) add(out, l.id, `a regular level cannot play a ${ex.kind}`);
      const tol = STRICTNESS[ex.tolerance];
      if (tol < prevTol) add(out, l.id, `tolerance ${ex.tolerance} is looser than an earlier level's (strictness must never decrease)`);
      // The hardest take of its world, but not stricter than the world itself: Foundations, for beginners, never reaches studio.
      if (l.kind === 'boss' && tol < prevTol) add(out, l.id, "the Boss Recital is sung at its world's strictest tolerance");
      prevTol = Math.max(prevTol, tol);
      if (i === 0 && ex.tolerance === 'studio') add(out, l.id, 'a world cannot open at studio tolerance');
    });
  }

  // Unlocks: each training world opens with the previous one's boss; Song Stage with Foundations'.
  catalog.worlds.forEach((w, i) => {
    if (w.id === 'foundations') {
      if (w.unlockedBy !== null) add(out, w.id, 'Foundations is open from the start (unlockedBy null)');
      return;
    }
    const expectFrom: WorldId = w.id === SONG_STAGE ? 'foundations' : catalog.worlds[i - 1]?.id;
    const boss = bossOf.get(expectFrom);
    if (!boss || w.unlockedBy !== boss.id) add(out, w.id, `must be unlocked by ${expectFrom}'s Boss Recital${boss ? ` (${boss.id})` : ''}`);
  });

  // Auditions: own world only, never the boss, rising, at least as strict as what they skip.
  const usedByAudition = new Set<string>();
  for (const w of catalog.worlds) {
    if (w.id === SONG_STAGE) continue;
    const a = w.audition;
    if (!a) {
      add(out, w.id, 'every training world has one placement audition');
      continue;
    }
    checkAudition(out, w, a, exById, levelById, usedByLevel, usedByAudition, uniq);
    checkFormerAudition(out, w, a, exById, levelById);
  }

  for (const e of catalog.exercises) {
    if (e.retired !== undefined) {
      if (isDrillId(e.id)) add(out, e.id, 'a practice drill is never retired: a lesson that drops it drops the drill');
      continue; // sung by nothing (the levels and auditions above refuse it); kept only to read old takes back
    }
    const drill = isDrillId(e.id);
    // A drill is sung only as a lesson's practice step (validateLessons checks that some lesson uses it).
    if (!drill && !usedByLevel.has(e.id) && !usedByAudition.has(e.id)) add(out, e.id, 'exercise is not used by any level or audition');
    if (drill && (usedByLevel.has(e.id) || usedByAudition.has(e.id))) add(out, e.id, 'a practice drill is never a level or an audition test');
    if (e.kind === 'audition' && !usedByAudition.has(e.id)) add(out, e.id, 'audition exercise is not in its world\'s audition');
  }

  checkSavedRangeFit(out, live);
  for (const e of live) checkTransposition(out, e, rangeCases);
  return out;
}

/**
 * A rebuilt audition's former tests (AuditionDef.former): retired audition exercises of its world, paired with how far
 * each reached among the world's levels then, granting only levels of the world now, never its Range finder (its first
 * level: always sung) or its Boss Recital.
 */
function checkFormerAudition(out: Issues, w: WorldDef, a: AuditionDef, exById: Map<string, ExerciseDef>, levelById: Map<string, LevelDef>): void {
  const f = a.former;
  if (!f) return;
  const where = `${a.id} former`;
  if (f.exerciseIds.length === 0 || f.exerciseIds.length !== f.unlockThrough.length) add(out, where, 'former exerciseIds and unlockThrough must pair up');
  if (new Set(f.levelIds).size !== f.levelIds.length) add(out, where, 'former levels are listed once each');
  for (const id of f.exerciseIds) {
    const ex = exById.get(id);
    if (!ex) add(out, where, `references missing exercise ${id}`);
    else if (ex.retired === undefined || ex.kind !== 'audition' || ex.worldId !== w.id) add(out, where, `${id} must be a retired audition test of ${w.id}`);
    if (a.exerciseIds.includes(id)) add(out, where, `${id} is both a former and a current test`);
  }
  for (const id of f.unlockThrough) if (!f.levelIds.includes(id)) add(out, where, `reaches ${id}, which is not one of the former levels`);
  for (const id of f.keeps) {
    const level = levelById.get(id);
    if (!level || level.worldId !== w.id) add(out, where, `keeps ${id}, which is not a level of ${w.id}`);
    else if (level.kind === 'boss' || exById.get(level.exerciseId)?.kind === 'range-finder') {
      add(out, where, `can never grant ${id} (a Range finder is always sung, a Boss Recital always passed)`);
    }
    if (!f.levelIds.includes(id)) add(out, where, `keeps ${id}, which no former test could have reached`);
  }
}

const widthOf = (s: { lo: number; hi: number }): number => s.hi - s.lo;

/**
 * Nothing folds for a singer who passed the Range finder: every exercise's material fits the narrowest range it
 * saves (its range.spanSemitones gate), and its guide bars reach that gate, so holding exactly the guides passes.
 */
function checkSavedRangeFit(out: Issues, exercises: readonly ExerciseDef[]): void {
  const finder = exercises.find((e) => e.kind === 'range-finder');
  if (!finder) return;
  const gate = (finder.pass.gates ?? []).find((g) => g.metric === 'range.spanSemitones' && g.op === '>=');
  if (!gate) return void add(out, finder.id, 'the Range finder must gate range.spanSemitones (>=): it sets the narrowest range a singer can save');
  const minSpan = gate.value;
  const guide = widthOf(materialSpan(finder));
  if (guide < minSpan) add(out, finder.id, `the guide bars span ${guide} semitones but a pass needs ${minSpan}: holding exactly the guides must pass`);
  for (const e of exercises) {
    const w = widthOf(materialSpan(e));
    if (w > minSpan) add(out, e.id, `material spans ${w} semitones, wider than the narrowest range the Range finder saves (${minSpan}): it would be folded by octaves`);
  }
}

function checkAudition(
  out: Issues, w: WorldDef, a: AuditionDef, exById: Map<string, ExerciseDef>, levelById: Map<string, LevelDef>,
  usedByLevel: Map<string, string>, usedByAudition: Set<string>, uniq: (id: string, what: string) => void,
): void {
  uniq(a.id, 'audition');
  if (a.worldId !== w.id) add(out, a.id, `audition belongs to ${a.worldId}, listed in ${w.id}`);
  if (a.exerciseIds.length === 0) add(out, a.id, 'audition has no tests');
  if (a.exerciseIds.length !== a.unlockThrough.length) add(out, a.id, 'exerciseIds and unlockThrough must pair up');
  let prevIndex = 0;
  a.exerciseIds.forEach((id, i) => {
    const ex = exById.get(id);
    if (!ex) return void add(out, a.id, `references missing exercise ${id}`);
    if (usedByAudition.has(id)) add(out, a.id, `exercise ${id} is used twice`);
    usedByAudition.add(id);
    if (ex.retired !== undefined) add(out, id, 'a retired exercise is never sung: an audition cannot test with it');
    if (ex.kind !== 'audition') add(out, id, 'audition tests have kind "audition"');
    if (ex.worldId !== w.id) add(out, id, `audition test belongs to ${ex.worldId}, not ${w.id}`);
    if (usedByLevel.has(id)) add(out, id, 'an audition test cannot also be a level');
    const throughId = a.unlockThrough[i];
    const through = throughId !== undefined ? levelById.get(throughId) : undefined;
    if (!through || through.worldId !== w.id) return void add(out, a.id, `unlockThrough "${throughId}" is not a level of ${w.id} (auditions never open another world)`);
    if (through.kind === 'boss') add(out, a.id, 'an audition can never skip the Boss Recital');
    if (through.index <= prevIndex) add(out, a.id, 'unlockThrough must rise level by level');
    prevIndex = through.index;
    const target = exById.get(through.exerciseId);
    if (!target) return;
    if (STRICTNESS[ex.tolerance] < STRICTNESS[target.tolerance]) add(out, id, `sung at ${ex.tolerance} but skips up to ${through.id} at ${target.tolerance}`);
    for (const an of target.analyzers) if (!ex.analyzers.includes(an)) add(out, id, `skips ${through.id} without testing its "${an}" skill`);
  });
}

function checkTransposition(out: Issues, def: ExerciseDef, cases: readonly RangeCase[]): void {
  for (const c of cases) {
    const r = realize(def, c.range, c.voiceType);
    const { extended, comfortable, saved: isSaved } = effectiveRange(c.range, c.voiceType);
    const where = `${def.id} @ ${c.name}`;
    const pitches = [...r.notes.flatMap((n) => (n.toMidi === undefined ? [n.midi] : [n.midi, n.toMidi])), ...r.reference.map((n) => n.midi)];
    for (const m of pitches) {
      if (m < extended.low || m > extended.high) {
        add(out, where, `places MIDI ${m} outside the extended range ${extended.low}-${extended.high}`);
        break;
      }
    }
    if (!c.allowFold && r.fit === 'folded') add(out, where, 'material is wider than the extended range and had to be folded');
    if (!isSaved && !usesExtendedRange(def) && r.fit !== 'fits') add(out, where, `does not fit the default comfortable range ${comfortable.low}-${comfortable.high}`);
  }
}

/**
 * Every issue with the lessons (src/lessons/types.ts), keyed by level id, against `catalog`: each teaches a level of a
 * world taught as lessons; its Learn page has what, why, 3-5 how-to lines and what the screen shows, and the music words
 * it introduces (each taught by one lesson only); its 2-4 practice steps are that world's drills (none shared, none a
 * level's exercise or a test), sung at the check's tolerance so the in-tune zone on screen is the one the check uses, with
 * a good-try rule on metrics the drill measures that a perfect take meets and that never asks more than the check's own
 * gate on the same metric. And every drill in the catalog is some lesson's step.
 */
export function validateLessons(lessons: Readonly<Record<string, LessonDef>>, catalog: CatalogLike): ValidationIssue[] {
  const out: Issues = [];
  const exById = new Map(catalog.exercises.map((e) => [e.id, e] as const));
  const levelById = new Map(catalog.worlds.flatMap((w) => w.levels.map((l) => [l.id, l] as const)));
  const played = new Set(catalog.worlds.flatMap((w) => [...w.levels.map((l) => l.exerciseId), ...(w.audition?.exerciseIds ?? [])]));
  const drillOwner = new Map<string, string>();
  const termOwner = new Map<string, string>();
  for (const [key, lesson] of Object.entries(lessons)) {
    const p = `lesson ${key}`;
    if (lesson.levelId !== key) add(out, p, `is keyed ${key} but teaches ${lesson.levelId}`);
    const level = levelById.get(lesson.levelId);
    if (!level) {
      add(out, p, `teaches ${lesson.levelId}, which is not a level`);
      continue;
    }
    if (!ECHO_WORLDS.has(level.worldId)) add(out, p, `${level.worldId} is not taught as lessons (ECHO_WORLDS): its exercises are not echo-shaped`);
    const check = exById.get(level.exerciseId);
    if (!lesson.title?.trim() || !lesson.outcome?.trim()) add(out, p, 'needs a title and an outcome');
    const { learn } = lesson;
    if (!learn.what?.trim() || !learn.why?.trim()) add(out, p, 'the Learn page says what the skill is and why it matters');
    if (learn.how.length < LIMITS.learnHow[0] || learn.how.length > LIMITS.learnHow[1] || learn.how.some((h) => !h.trim())) {
      add(out, p, `the Learn page has ${learn.how.length} how-to lines; expected ${LIMITS.learnHow.join('-')}`);
    }
    if (learn.onScreen.length === 0 || learn.onScreen.some((s) => !s.trim())) add(out, p, 'the Learn page says what the screen shows');
    for (const t of learn.terms) {
      if (!Object.prototype.hasOwnProperty.call(TERMS, t)) add(out, p, `unknown term "${t}"`);
      const prev = termOwner.get(t);
      if (prev) add(out, p, `term "${t}" is already taught by ${prev}`);
      else termOwner.set(t, lesson.levelId);
    }
    if (lesson.practice.length < LIMITS.lessonSteps[0] || lesson.practice.length > LIMITS.lessonSteps[1]) {
      add(out, p, `has ${lesson.practice.length} practice steps; expected ${LIMITS.lessonSteps.join('-')}`);
    }
    lesson.practice.forEach((step, i) => {
      const where = `${p} practice ${i}`;
      const drill = exById.get(step.exerciseId);
      if (!drill) return void add(out, where, `references missing exercise ${step.exerciseId}`);
      if (drill.retired !== undefined) add(out, where, `${drill.id} is retired: practice never sings it`);
      if (!isDrillId(drill.id)) add(out, where, `${drill.id} is not a practice drill (${level.worldId}.drill.<name>)`);
      if (played.has(drill.id)) add(out, where, `${drill.id} is a level's exercise or an audition test, never a drill`);
      if (drill.worldId !== level.worldId) add(out, where, `${drill.id} belongs to ${drill.worldId}, not ${level.worldId}`);
      const owner = drillOwner.get(drill.id);
      if (owner) add(out, where, `${drill.id} is already a practice step of ${owner}`);
      else drillOwner.set(drill.id, lesson.levelId);
      if (check && drill.tolerance !== check.tolerance) add(out, where, `${drill.id} is sung at ${drill.tolerance}, its check at ${check.tolerance}: practise in the zone the check uses`);
      if (!step.title?.trim() || !step.ask?.trim()) add(out, where, 'needs a title and an ask');
      if (!Number.isInteger(step.goodTries) || step.goodTries < 1) add(out, where, 'goodTries must be a whole number >= 1');
      const produced = metricsProducedBy(drill.analyzers);
      const perfect = perfectMetrics(drill);
      for (const c of step.good.conditions) {
        const info = METRIC_INFO[c.metric];
        if (!info) {
          add(out, where, `unknown metric ${c.metric}`);
          continue;
        }
        if (!produced.has(c.metric)) add(out, where, `the good-try rule reads ${c.metric}, which ${drill.id} does not measure`);
        if (info.direction === 'higher' && c.op !== '>=') add(out, where, `${c.metric} is better higher: hold it to >=`);
        if (info.direction === 'lower' && c.op !== '<=') add(out, where, `${c.metric} is better lower: hold it to <=`);
        if (!Number.isFinite(c.value) || c.value < info.min || c.value > info.max) add(out, where, `${c.metric} ${c.value} is outside ${info.min}..${info.max}`);
        else if (!gateHolds(c, perfect)) add(out, where, `a perfect take misses the good-try condition on ${c.metric}`);
        const gate = check && check.tolerance === drill.tolerance ? (check.pass.gates ?? []).find((g) => g.metric === c.metric) : undefined;
        if (gate && (c.op === '>=' ? c.value > gate.value : c.value < gate.value)) {
          add(out, where, `a good try asks ${c.metric} ${c.op} ${c.value}, more than the check's own gate (${gate.value}): practice is the lenient part`);
        }
      }
    });
  }
  for (const e of catalog.exercises) if (isDrillId(e.id) && !drillOwner.has(e.id)) add(out, e.id, 'a practice drill that no lesson uses');
  return out;
}
