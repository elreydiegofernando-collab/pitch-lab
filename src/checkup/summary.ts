/**
 * Reading check-ups back from the log, and comparing two (pure).
 *
 * A check-up is the attempts that share a checkupId (runtime/checkup.ts tags the take of every task), so it is read
 * from the log alone and travels with a backup. It counts once its last task was sung; when a task was sung more than
 * once, its latest take counts.
 *
 * Each skill is rated from its task's take against that exercise's own pass rule and tiers, on the 0..1 bands the
 * scorer uses (exercises/evaluate.ts): the skill's standing is the weighted mean of its metrics' terms (a metric the
 * take could not read scores 0, as in the scorer), and the pass gates on its metrics must hold.
 *   solid          at or past the solid tally (tiers.solid) with every gate on the skill holding: comfortably past
 *   getting there  past the pass mark, or within NEAR_PASS below it, and no gate missed by more than NEAR_PASS
 *   focus          clearly short: further below the pass mark, or a gate missed by more than NEAR_PASS
 *   not measured   not sung; nothing came through (the runner writes a silent take as 0 s); not all of it was heard
 *                  (stopped early, or too many notes unvoiced: the runner then writes it shorter than a whole take); or
 *                  none of its metrics could be read
 * A take heard only in part measured only part of its task, so it rates nothing rather than something it did not sing.
 * Singing off pitch is not "unheard": a take voiced to its end is rated, however far off it was.
 *
 * The range is measured, never graded (the Range finder's own goal says "nothing here is graded", and it keeps no
 * personal record: a wider span is never the aim). A span that meets the Range finder's gate (an octave: room for every
 * exercise) is solid however wide; only a span short of it is rated on the finder's bands like any other skill.
 *
 * Words for the singer come from src/coaching/plain.ts: no cents, Hz, semitones or other jargon (plain.test.ts and
 * summary.test.ts check every sentence).
 */
import { valueScore } from '../analysis/score';
import type { MetricKey, Metrics } from '../analysis/types';
import * as P from '../coaching/plain';
import type { ProgressLine } from '../coaching/types';
import { noteName, type Notation } from '../core/music';
import { WORLDS, gateHolds, getExercise, realize, termScore } from '../exercises';
import type { ExerciseDef, LevelDef } from '../exercises/types';
import { computeSnapshot, withRoutines } from '../progress';
import { replayLog } from '../progress/log';
import type { ProgressSnapshot } from '../progress/types';
import type { AttemptRecord, VocalRange } from '../storage/schema';
import { CHECKUP_SKILLS, SKILL_NAMES } from './skills';
import {
  CHECKUP_TASKS,
  RECHECK_AFTER_DAYS,
  type CheckupComparison,
  type CheckupSkill,
  type CheckupSummary,
  type CheckupTask,
  type SkillRating,
  type SkillResult,
} from './types';

/** A skill this far below the pass mark (on the exercise's own 0..1 bands) still reads "getting there", and a gate missed by this much or less. PROVISIONAL. */
export const NEAR_PASS = 0.15;
/** At most this many skills to focus on. */
export const MAX_FOCUS = 2;
/** A take this close to its whole length ran to its end (runtime/runner.ts COMPLETE_SLACK_SEC). */
const WHOLE_TAKE_SLACK_SEC = 0.25;
const EPS = 1e-9;
const DAY_MS = 86_400_000;
const NOT_MEASURED = 'not measured';

/** A SkillResult with the readings it was rated from: checkupsOf returns these, and compareCheckups reads them. */
export interface SkillReading extends SkillResult {
  /** The skill's metrics as its task's take measured them (finite values only); empty when the skill was not measured. */
  values: Partial<Record<MetricKey, number>>;
}

// ---------------------------------------------------------------- rating one skill

function finite(v: number | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * How a skill's metrics (`keys`) stand against an exercise's pass rule and tiers (see the module doc). Exported for its
 * edge tests; checkupsOf is the way in.
 */
export function rateSkill(def: Pick<ExerciseDef, 'scoring' | 'pass' | 'tiers'>, metrics: Metrics, keys: readonly MetricKey[]): SkillRating {
  if (!keys.some((k) => finite(metrics[k]))) return 'not-measured';
  let weighted = 0;
  let total = 0;
  for (const term of def.scoring) {
    if (!keys.includes(term.metric)) continue;
    weighted += term.weight * (termScore(term, metrics[term.metric]) ?? 0);
    total += term.weight;
  }
  if (!(total > 0)) return 'not-measured'; // the exercise does not score these metrics: nothing to rate them against
  const standing = weighted / total;
  let gateMissed = false;
  for (const gate of def.pass.gates ?? []) {
    if (!keys.includes(gate.metric) || gateHolds(gate, metrics)) continue;
    const term = def.scoring.find((t) => t.metric === gate.metric);
    // How far below the gate the take sat, on the same band as its term (an unread metric sits at 0).
    const short = term ? valueScore(gate.value, term.best, term.worst) - (termScore(term, metrics[gate.metric]) ?? 0) : Infinity;
    if (short > NEAR_PASS + EPS) return 'focus';
    gateMissed = true;
  }
  if (standing < def.pass.score - NEAR_PASS - EPS) return 'focus';
  if (!gateMissed && standing >= def.tiers.solid - EPS) return 'solid';
  return 'getting-there';
}

// ---------------------------------------------------------------- one task's take

/** How much of its task a take sang: all of it, nothing (silent), or only part (stopped, or quiet before its end). */
type Sung = 'whole' | 'silent' | 'part';

function howSung(def: ExerciseDef, a: AttemptRecord): Sung {
  if (!(a.durationSec > 0)) return 'silent';
  const bpm = typeof a.tempoBpm === 'number' && Number.isFinite(a.tempoBpm) && a.tempoBpm > 0 ? a.tempoBpm : def.tempoBpm;
  // Count-in plus material at the tempo sung: the timing does not depend on the singer's range.
  const r = realize(def, null, 'unknown', { bpm });
  return a.durationSec >= r.countInSec + r.totalSec - WHOLE_TAKE_SLACK_SEC ? 'whole' : 'part';
}

/** What the Range finder needs to pass: its span gate (an octave). */
function rangeNeeded(def: ExerciseDef | undefined): number {
  return def?.pass.gates?.find((g) => g.metric === 'range.spanSemitones' && g.op === '>=')?.value ?? 12;
}

/** True when `value` misses the exercise's own gate on `metric` (false without such a gate, or without a reading). */
function missesGate(def: ExerciseDef, metric: MetricKey, value: number | undefined): boolean {
  const gate = def.pass.gates?.find((g) => g.metric === metric);
  return gate !== undefined && finite(value) && !gateHolds(gate, { [metric]: value });
}

/** The range, measured not graded (see the module doc): solid once it meets the Range finder's gate. */
function rateRange(def: ExerciseDef, metrics: Metrics, keys: readonly MetricKey[]): SkillRating {
  const span = metrics['range.spanSemitones'];
  if (finite(span) && span >= rangeNeeded(def)) return 'solid';
  return rateSkill(def, metrics, keys);
}

/** One plain sentence about a measured skill, from its readings. */
function measuredWhat(skill: CheckupSkill, def: ExerciseDef, v: Partial<Record<MetricKey, number>>): string {
  switch (skill) {
    case 'range': {
      const span = v['range.spanSemitones'] as number;
      const need = rangeNeeded(def);
      if (span < need) return `Your easy notes span ${P.spanWords(span)} so far; the exercises use ${P.spanWords(need)}.`;
      return `Your easy notes span ${P.spanWords(span)}, room for every exercise.`;
    }
    case 'pitch': {
      const pct = v['accuracy.inTolerancePct'];
      const miss = v['accuracy.medianAbsCents'];
      if (finite(pct) && finite(miss)) return `You sang in tune ${P.percentText(pct)} of the time, usually off by ${P.pitchDistance(miss)}.`;
      if (finite(pct)) return `You sang in tune ${P.percentText(pct)} of the time.`;
      return `You were usually off by ${P.pitchDistance(miss as number)}.`;
    }
    case 'steadiness': {
      const sd = v['accuracy.sdCents'];
      const drift = v['accuracy.absDriftCentsPerSec'];
      if (finite(sd) && finite(drift)) return `Your held notes were ${P.steadiness(sd)} and ${P.driftRate(drift)}.`;
      if (finite(sd)) return `Your held notes were ${P.steadiness(sd)}.`;
      return `Your held notes ${P.driftRate(drift as number)}.`;
    }
    case 'slides': {
      const cracks = v['glide.cracks'];
      const end = v['glide.endAbsCents'];
      const stepped = missesGate(def, 'glide.smoothness', v['glide.smoothness']);
      // Where the slide finished counts too (its own gate): a slide can be smooth and unbroken and still end off its note.
      const landing = missesGate(def, 'glide.endAbsCents', end) ? `ended off the note it was heading for, by ${P.pitchDistance(end as number)}` : null;
      if (finite(cracks) && Math.round(cracks) > 0) {
        const broke = `Your voice broke ${P.times(Math.round(cracks))} on the slide, which is common where a voice changes gears.`;
        return landing ? `${broke} It also ${landing}.` : broke;
      }
      if (!finite(cracks)) {
        if (landing) return stepped ? `Your slide moved in steps and ${landing}.` : `Your slide moved in one smooth line, but it ${landing}.`;
        return stepped ? 'Your slide moved in steps rather than one smooth line.' : 'Your slide moved in one smooth line.';
      }
      if (landing) return stepped ? `Your slide had no breaks, though it moved in steps and ${landing}.` : `Your slide had no breaks, but it ${landing}.`;
      return stepped ? 'Your slide had no breaks, though it moved in steps rather than one smooth line.' : 'Your slide up and down was smooth, with no breaks.';
    }
    case 'starts': {
      const settle = v['onset.settleMs'];
      const scoop = v['onset.scoopCents'];
      const slide = !finite(scoop) ? '' : scoop < 10 ? ', with hardly any slide up into them' : `, sliding up into them by ${P.pitchDistance(scoop)}`;
      if (finite(settle)) return `Your notes took ${P.durationWords(settle / 1000)} to settle${slide}.`;
      if (finite(scoop)) return `Your notes rarely settled on the pitch${slide}.`;
      return `Your notes went past the pitch by ${P.pitchDistance(v['onset.overshootCents'] as number)} as they started.`;
    }
    case 'connected': {
      const clean = v['transition.cleanRate'];
      const pct = v['accuracy.inTolerancePct'];
      if (finite(clean) && finite(pct)) return `You changed notes cleanly ${P.shareText(clean)} of the time and were in tune for ${P.percentText(pct)} of the line.`;
      if (finite(clean)) return `You changed notes cleanly ${P.shareText(clean)} of the time.`;
      return `You were in tune for ${P.percentText(pct as number)} of the line.`;
    }
  }
}

/** Why a skill was not measured, in one plain sentence. */
function unmeasuredWhat(skill: CheckupSkill, why: 'not-sung' | 'silent' | 'part' | 'unread'): string {
  switch (why) {
    case 'not-sung':
      return 'Not sung in this check-up, so not measured.';
    case 'silent':
      return 'Nothing came through the microphone on this task, so it was not measured.';
    case 'part':
      return 'Not all of this task was heard (it stopped early or went quiet), so it was not measured.';
    case 'unread':
      return skill === 'range' ? 'No low or high note was held long enough to measure your range.' : 'This take could not be measured.';
  }
}

/** The skills one task's take measured (its row may be missing: the task was not sung). */
function readTask(task: CheckupTask, take: AttemptRecord | null): SkillReading[] {
  const def = getExercise(task.exerciseId);
  return task.skills.map(({ skill, metrics: keys }): SkillReading => {
    const none = (why: 'not-sung' | 'silent' | 'part' | 'unread'): SkillReading => ({ skill, rating: 'not-measured', what: unmeasuredWhat(skill, why), values: {} });
    if (!take) return none('not-sung');
    if (!def) return none('unread');
    const sung = howSung(def, take);
    if (sung !== 'whole') return none(sung);
    const rating = skill === 'range' ? rateRange(def, take.metrics, keys) : rateSkill(def, take.metrics, keys);
    if (rating === 'not-measured') return none('unread');
    const values: Partial<Record<MetricKey, number>> = {};
    for (const k of keys) {
      const value = take.metrics[k];
      if (finite(value)) values[k] = value;
    }
    return { skill, rating, what: measuredWhat(skill, def, values), values };
  });
}

/**
 * True when a take of check-up task `taskIndex` measured at least one of the task's skills: it was heard in full and
 * read. A take that measured nothing (silent, stopped early, gone quiet before its end) is worth singing again: the
 * report offers that (runtime/flow.ts), and such a take of the last task does not end the check-up (runtime/checkup.ts).
 */
export function isTaskMeasured(taskIndex: number, take: AttemptRecord): boolean {
  const task = Number.isInteger(taskIndex) ? CHECKUP_TASKS[taskIndex] : undefined;
  return task !== undefined && readTask(task, take).some((s) => s.rating !== 'not-measured');
}

/**
 * The one or two skills to work on: the measured ones not yet solid, clearly short before getting there, and between
 * those the one whose level comes first in the catalog (the more basic skill). The range counts only when it is short
 * of what the exercises need (the Range finder then saved nothing): a range is never stretched by practice.
 */
function focusOf(skills: readonly SkillReading[], rangeDef: ExerciseDef | undefined): CheckupSkill[] {
  const tier = (r: SkillRating): number => (r === 'focus' ? 0 : 1);
  return skills
    .filter((s) => {
      if (s.rating === 'solid' || s.rating === 'not-measured') return false;
      if (s.skill !== 'range') return true;
      const span = s.values['range.spanSemitones'];
      return finite(span) && span < rangeNeeded(rangeDef);
    })
    .sort((a, b) => tier(a.rating) - tier(b.rating) || CHECKUP_SKILLS.indexOf(a.skill) - CHECKUP_SKILLS.indexOf(b.skill))
    .slice(0, MAX_FOCUS)
    .map((s) => s.skill);
}

// ---------------------------------------------------------------- the log

function checkupIdOf(a: AttemptRecord): string | null {
  return typeof a.checkupId === 'string' && a.checkupId !== '' && a.deletedAt == null ? a.checkupId : null;
}

/** True when `a` is the take of `task` (its exercise, logged the way the task is). */
function isTakeOf(task: CheckupTask, a: AttemptRecord): boolean {
  if (a.exerciseId !== task.exerciseId) return false;
  return task.logAs.kind === 'practice' ? a.kind === 'practice' && a.levelId === task.logAs.levelId : a.kind === 'audition' && a.levelId == null;
}

interface CheckupGroup {
  checkupId: string;
  profileId: string;
  /** The profile's live log in append order, and where this check-up's first take sits in it. */
  ordered: readonly AttemptRecord[];
  firstIndex: number;
  /** This check-up's takes, in append order. */
  rows: AttemptRecord[];
  /** Per task: its latest take, or null when it was not sung. */
  byTask: Array<AttemptRecord | null>;
}

function compareAppend(x: AttemptRecord, y: AttemptRecord): number {
  if (x.updatedAt !== y.updatedAt) return x.updatedAt < y.updatedAt ? -1 : 1;
  return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
}

/** Every check-up in the log (finished or not), oldest first: by its first take, in the order the log replays. */
function groupsOf(log: readonly AttemptRecord[]): CheckupGroup[] {
  const profiles: string[] = [];
  for (const a of log) if (checkupIdOf(a) !== null && !profiles.includes(a.profileId)) profiles.push(a.profileId);
  const groups: CheckupGroup[] = [];
  for (const profileId of profiles) {
    const ordered = replayLog(profileId, log).map((l) => l.a);
    const byId = new Map<string, CheckupGroup>();
    ordered.forEach((a, index) => {
      const id = checkupIdOf(a);
      if (id === null) return;
      let g = byId.get(id);
      if (!g) {
        g = { checkupId: id, profileId, ordered, firstIndex: index, rows: [], byTask: CHECKUP_TASKS.map(() => null) };
        byId.set(id, g);
        groups.push(g);
      }
      g.rows.push(a);
      CHECKUP_TASKS.forEach((task, i) => {
        if (isTakeOf(task, a)) g.byTask[i] = a; // append order: the latest take of a task wins
      });
    });
  }
  return groups.sort((x, y) => compareAppend(x.rows[0], y.rows[0]));
}

function isFinished(g: CheckupGroup): boolean {
  return g.byTask[CHECKUP_TASKS.length - 1] !== null;
}

/** True when the log holds a finished check-up with this id (its last task was sung). */
export function isCheckupFinished(log: readonly AttemptRecord[], checkupId: string): boolean {
  return groupsOf(log).some((g) => g.checkupId === checkupId && isFinished(g));
}

/** The focus of the latest finished check-up in the log (empty when there is none, or nothing needs it). */
export function latestCheckupFocus(log: readonly AttemptRecord[]): CheckupSkill[] {
  const finished = groupsOf(log).filter(isFinished);
  const latest = finished[finished.length - 1];
  if (!latest) return [];
  const skills = CHECKUP_TASKS.flatMap((task, i) => readTask(task, latest.byTask[i]));
  return focusOf(skills, getExercise(CHECKUP_TASKS[0].exerciseId));
}

/** An unfinished check-up can be picked up again for this long after its first take, even after Pitch Lab closed. */
export const RESUME_WITHIN_MS = DAY_MS;

/** A check-up left part way, as the log holds it: its id, its first take's time, and per task the latest take's id. */
export interface UnfinishedCheckup {
  checkupId: string;
  startedAt: string;
  attemptIds: Array<string | null>;
}

/**
 * The check-up to pick up again when Pitch Lab opens (iOS often closes an app left in the background): the profile's
 * newest check-up, when its last task has not been sung and its first take is less than RESUME_WITHIN_MS before `now`.
 * Null otherwise: no check-up, the newest one is finished, or it is too old to make one sitting with today's tasks.
 */
export function unfinishedCheckup(log: readonly AttemptRecord[], profileId: string, now: number): UnfinishedCheckup | null {
  const mine = groupsOf(log).filter((g) => g.profileId === profileId);
  const newest = mine[mine.length - 1];
  if (!newest || isFinished(newest)) return null;
  const startedAt = newest.rows[0].createdAt;
  const at = Date.parse(startedAt);
  if (!Number.isFinite(at) || at > now + 60_000 || now - at >= RESUME_WITHIN_MS) return null;
  return { checkupId: newest.checkupId, startedAt, attemptIds: newest.byTask.map((a) => a?.id ?? null) };
}

// ---------------------------------------------------------------- progress around a check-up

const SNAPSHOT_OPTIONS = { getExercise: withRoutines(getExercise) };

function snapshotAt(profileId: string, rows: readonly AttemptRecord[], at: string): ProgressSnapshot {
  const ms = Date.parse(at);
  return computeSnapshot(profileId, WORLDS, rows, Number.isFinite(ms) ? ms : 0, SNAPSHOT_OPTIONS);
}

const byIndex = (a: LevelDef, b: LevelDef): number => a.index - b.index;

/** Levels newly passed by a placement-test grant between two snapshots, in catalog order. */
function grantedBetween(before: ProgressSnapshot, after: ProgressSnapshot): string[] {
  const out: string[] = [];
  for (const world of WORLDS) {
    for (const level of [...world.levels].sort(byIndex)) {
      const a = after.levels[level.id];
      if (a?.status === 'passed' && a.viaAudition && before.levels[level.id]?.status !== 'passed') out.push(level.id);
    }
  }
  return out;
}

/** The first Foundations level still to pass; null when Foundations is all passed. */
function firstToPass(after: ProgressSnapshot): string | null {
  const foundations = WORLDS.find((w) => w.id === 'foundations');
  const next = foundations ? [...foundations.levels].sort(byIndex).find((l) => after.levels[l.id]?.status !== 'passed') : undefined;
  return next?.id ?? null;
}

function sameMoment(a: string, b: string): boolean {
  const x = Date.parse(a);
  return Number.isFinite(x) && x === Date.parse(b);
}

/** "B2–A4": the comfortable band of the range a check-up's passed Range finder saved, when it is the one saved now. */
function rangeText(rangeTake: AttemptRecord | null, saved: VocalRange | null | undefined, notation: Notation): string | null {
  if (!rangeTake?.passed || !saved || !sameMoment(saved.measuredAt, rangeTake.createdAt)) return null;
  return `${noteName(saved.comfortable.low, notation)}–${noteName(saved.comfortable.high, notation)}`;
}

/**
 * Every finished check-up of a profile in its log, oldest first. A check-up counts once its last task was sung.
 *
 * `snapshotAfter(checkupId)`: the progress right after that check-up's last task when the caller already has it (the
 * last take's TakeOutcome.after), else null, and the progress engine replays the log: the check-up's own takes on top of
 * everything sung before its first one, so `opened` holds what the check-up itself granted. The progress before its
 * first task is always replayed. Pass `() => null` to have both read from the log.
 *
 * `savedRange` (optional): the profile's saved range. A take keeps only the span of a range, not its notes, so `range`
 * names the notes ("B2–A4") on the check-up whose Range finder take saved that range (its measuredAt), and is null on the
 * others; compareCheckups compares the spans either way.
 */
export function checkupsOf(
  log: readonly AttemptRecord[],
  snapshotAfter: (checkupId: string) => ProgressSnapshot | null,
  notation: Notation,
  savedRange?: VocalRange | null,
): CheckupSummary[] {
  const rangeDef = getExercise(CHECKUP_TASKS[0].exerciseId);
  return groupsOf(log)
    .filter(isFinished)
    .map((g): CheckupSummary => {
      const first = g.rows[0];
      const last = g.rows[g.rows.length - 1];
      const earlier = g.ordered.slice(0, g.firstIndex);
      const before = snapshotAt(g.profileId, earlier, first.createdAt);
      const after = snapshotAfter(g.checkupId) ?? snapshotAt(g.profileId, [...earlier, ...g.rows], last.createdAt);
      const skills = CHECKUP_TASKS.flatMap((task, i) => readTask(task, g.byTask[i]));
      return {
        checkupId: g.checkupId,
        profileId: g.profileId,
        startedAt: first.createdAt,
        finishedAt: last.createdAt,
        tasks: CHECKUP_TASKS.map((task, i) => {
          const take = g.byTask[i];
          return { exerciseId: task.exerciseId, title: task.title, attemptId: take?.id ?? null, passed: take ? take.passed : null, score: take ? take.score : null };
        }),
        skills,
        focus: focusOf(skills, rangeDef),
        startLevelId: firstToPass(after),
        opened: grantedBetween(before, after),
        range: rangeText(g.byTask[0], savedRange, notation),
      };
    });
}

// ---------------------------------------------------------------- then and now

/** The one reading each skill is compared on, in plain words, and which way is better. */
const LINE_MEASURE: Readonly<Record<CheckupSkill, { metric: MetricKey; words: (v: number) => string; better: 'higher' | 'lower' }>> = {
  range: { metric: 'range.spanSemitones', words: P.spanWords, better: 'higher' },
  pitch: { metric: 'accuracy.inTolerancePct', words: (v) => `${P.percentText(v)} in tune`, better: 'higher' },
  steadiness: { metric: 'accuracy.sdCents', words: P.steadiness, better: 'lower' },
  slides: { metric: 'glide.cracks', words: (v) => (Math.round(v) <= 0 ? 'no breaks' : P.count(Math.round(v), 'break')), better: 'lower' },
  starts: { metric: 'onset.settleMs', words: (v) => `${P.durationWords(v / 1000)} to settle`, better: 'lower' },
  connected: { metric: 'transition.cleanRate', words: (v) => `${P.shareText(v)} clean changes`, better: 'higher' },
};

const RATING_WORDS: Readonly<Record<SkillRating, string>> = {
  solid: 'solid',
  'getting-there': 'getting there',
  focus: 'focus here',
  'not-measured': NOT_MEASURED,
};

const RATING_RANK: Readonly<Record<SkillRating, number>> = { focus: 0, 'getting-there': 1, solid: 2, 'not-measured': -1 };

/** The reading a skill is compared on; undefined when the summary carries no readings (built by hand) or lacks it. */
function readingOf(s: SkillResult, metric: MetricKey): number | undefined {
  const values = (s as Partial<SkillReading>).values;
  const v = values?.[metric];
  return finite(v) ? v : undefined;
}

function lineFor(skill: CheckupSkill, b: SkillResult | undefined, a: SkillResult | undefined): (ProgressLine & { skill: CheckupSkill }) | null {
  const label = SKILL_NAMES[skill].label;
  const m = LINE_MEASURE[skill];
  const bMeasured = b !== undefined && b.rating !== 'not-measured';
  const aMeasured = a !== undefined && a.rating !== 'not-measured';
  if (!bMeasured && !aMeasured) return null;
  const bv = bMeasured ? readingOf(b, m.metric) : undefined;
  const av = aMeasured ? readingOf(a, m.metric) : undefined;
  if (bMeasured && aMeasured) {
    if (bv !== undefined && av !== undefined) {
      const before = m.words(bv);
      const now = m.words(av);
      // The words must change for it to read as better or worse (coaching/measures.ts compareMeasure does the same).
      if (before !== now) return { skill, label, before, now, better: m.better === 'higher' ? av > bv : av < bv };
      // The same words and the same rating: about the same. The same words but another rating: another reading moved it
      // (where a slide landed, how far off the notes were), so the line says the ratings rather than "about the same".
      if (b.rating === a.rating) return { skill, label, before, now, better: null };
    }
    const better = b.rating === a.rating ? null : RATING_RANK[a.rating] > RATING_RANK[b.rating];
    return { skill, label, before: RATING_WORDS[b.rating], now: RATING_WORDS[a.rating], better };
  }
  const side = (s: SkillResult | undefined, measured: boolean, v: number | undefined): string =>
    !measured || !s ? NOT_MEASURED : v !== undefined ? m.words(v) : RATING_WORDS[s.rating];
  return { skill, label, before: side(b, bMeasured, bv), now: side(a, aMeasured, av), better: null };
}

function headline(lines: ReadonlyArray<ProgressLine & { skill: CheckupSkill }>): string {
  const names = (better: boolean): string =>
    P.listWords(lines.filter((l) => l.better === better).map((l) => SKILL_NAMES[l.skill].words));
  const up = lines.some((l) => l.better === true);
  const down = lines.some((l) => l.better === false);
  if (up && !down) return `Real progress since last time: your ${names(true)} got better.`;
  if (up) return `Your ${names(true)} got better since last time; your ${names(false)} dipped, which happens from day to day.`;
  if (down) return `Your ${names(false)} dipped since last time, which happens from day to day: rest well and keep practising.`;
  return 'Much the same as last time: steady practice is what moves it.';
}

/** "Then and now" between two check-ups (the older first). */
export function compareCheckups(before: CheckupSummary, after: CheckupSummary): CheckupComparison {
  const lines: Array<ProgressLine & { skill: CheckupSkill }> = [];
  for (const skill of CHECKUP_SKILLS) {
    const line = lineFor(
      skill,
      before.skills.find((s) => s.skill === skill),
      after.skills.find((s) => s.skill === skill),
    );
    if (line) lines.push(line);
  }
  return { before, after, lines, headline: headline(lines) };
}

/** True when a re-check is worth suggesting: no check-up yet, or the last one is RECHECK_AFTER_DAYS old or more. */
export function recheckDue(summaries: readonly CheckupSummary[], now: number): boolean {
  let last = -Infinity;
  for (const s of summaries) {
    const ms = Date.parse(s.finishedAt);
    if (Number.isFinite(ms) && ms > last) last = ms;
  }
  if (summaries.length === 0 || last === -Infinity) return true;
  return now - last >= RECHECK_AFTER_DAYS * DAY_MS;
}
