/**
 * Reading check-ups back from the log (src/checkup/summary.ts) over the real catalog and progression engine: the
 * ratings at their edges, what counts as measured, focus, where to start and what a check-up opened (the engine grants
 * placement tests only in order), the range in note names, "then and now", and when a re-check is due. Every word the
 * singer reads is checked for jargon. Takes are hand-built rows with the metrics a take of each task would carry.
 */
import { describe, expect, it } from 'vitest';
import type { MetricKey, Metrics } from '../analysis/types';
import { jargonIn } from '../coaching/plain';
import { WORLDS, evaluate, getExercise, realize, type ExerciseDef } from '../exercises';
import { computeSnapshot, withRoutines } from '../progress';
import { BASE_MS, DAY_MS, P1, attempt, exerciseDef, pass, passThrough } from '../progress/test-fixtures';
import type { AttemptRecord, VocalRange } from '../storage/schema';
import { CHECKUP_SKILLS, SKILL_LEVELS } from './skills';
import {
  NEAR_PASS,
  RESUME_WITHIN_MS,
  checkupsOf,
  compareCheckups,
  isCheckupFinished,
  isTaskMeasured,
  latestCheckupFocus,
  rateSkill,
  recheckDue,
  unfinishedCheckup,
} from './summary';
import { CHECKUP_TASKS, RECHECK_AFTER_DAYS, type CheckupSkill, type CheckupSummary, type SkillResult } from './types';

/** Effort the voice should never make: never as advice (src/coaching/content/index.test.ts has the same rule). */
const HARD_WORDS = /\b(push|forc|strain)\w*/i;

function plain(text: string): void {
  expect(jargonIn(text), text).toEqual([]);
  expect(HARD_WORDS.test(text), text).toBe(false);
}

const defOf = (taskIndex: number): ExerciseDef => getExercise(CHECKUP_TASKS[taskIndex].exerciseId)!;

/** The value of `metric` that scores `x` (0..1) on `def`'s own band for it. */
function valueAt(def: ExerciseDef, metric: MetricKey, x: number): number {
  const term = def.scoring.find((t) => t.metric === metric)!;
  return term.worst + x * (term.best - term.worst);
}

/** Every metric `def` scores, each at term score `x`, with overrides. */
function metricsAt(def: ExerciseDef, x: number, over: Metrics = {}): Metrics {
  const m: Metrics = {};
  for (const t of def.scoring) m[t.metric] = valueAt(def, t.metric, x);
  return { ...m, ...over };
}

/** Count-in plus material: the length of a whole take (the runner writes it as durationSec). */
function wholeSec(def: ExerciseDef): number {
  const r = realize(def, null, 'unknown', { bpm: def.tempoBpm });
  return r.countInSec + r.totalSec;
}

/** The take of a check-up task as the runner logs it (kind and level per task.logAs), passed as the pass rule says. */
function take(taskIndex: number, checkupId: string | null, metrics: Metrics, over: Partial<AttemptRecord> = {}): AttemptRecord {
  const task = CHECKUP_TASKS[taskIndex];
  const def = defOf(taskIndex);
  const e = evaluate(def, metrics);
  const row = attempt({
    exerciseId: def.id,
    kind: task.logAs.kind === 'practice' ? 'practice' : 'audition',
    levelId: task.logAs.kind === 'practice' ? task.logAs.levelId : null,
    passed: e.passed,
    score: e.score,
    mastery: e.mastery,
    metrics,
    durationSec: wholeSec(def),
    tempoBpm: def.tempoBpm,
    ...over,
  });
  return { ...row, checkupId, ...over };
}

/** A whole check-up, task i sung at term score xs[i] (null = not sung), with per-task metric overrides. */
function checkup(id: string, xs: ReadonlyArray<number | null>, over: Record<number, Metrics> = {}): AttemptRecord[] {
  const rows: AttemptRecord[] = [];
  xs.forEach((x, i) => {
    if (x !== null) rows.push(take(i, id, metricsAt(defOf(i), x, over[i])));
  });
  return rows;
}

const ALL_SOLID = [1, 1, 1, 1, 1] as const;

function only(summaries: CheckupSummary[]): CheckupSummary {
  expect(summaries).toHaveLength(1);
  return summaries[0];
}

const read = (log: AttemptRecord[], range?: VocalRange | null): CheckupSummary[] => checkupsOf(log, () => null, 'sharps', range);

function skillOf(summary: CheckupSummary, skill: CheckupSkill): SkillResult {
  return summary.skills.find((s) => s.skill === skill)!;
}

const ratings = (summary: CheckupSummary): Record<string, string> => Object.fromEntries(summary.skills.map((s) => [s.skill, s.rating]));

// ---------------------------------------------------------------- the battery and the catalog

describe('the battery against the catalog', () => {
  it('every skill metric is scored by its task’s exercise, so every skill can be rated', () => {
    for (const task of CHECKUP_TASKS) {
      const def = getExercise(task.exerciseId);
      expect(def, task.exerciseId).toBeDefined();
      for (const { skill, metrics } of task.skills) {
        for (const m of metrics) expect(def!.scoring.some((t) => t.metric === m), `${skill}: ${m}`).toBe(true);
      }
    }
  });

  it('every skill is measured by exactly one task, and the skills run in catalog order of the levels that train them', () => {
    const measured = CHECKUP_TASKS.flatMap((t) => t.skills.map((s) => s.skill));
    expect([...measured].sort()).toEqual([...CHECKUP_SKILLS].sort());
    const foundations = WORLDS.find((w) => w.id === 'foundations')!;
    const order = (id: string) => foundations.levels.find((l) => l.id === id)!.index;
    for (const skill of CHECKUP_SKILLS) for (const id of SKILL_LEVELS[skill]) expect(foundations.levels.some((l) => l.id === id), id).toBe(true);
    const firsts = CHECKUP_SKILLS.map((s) => order(SKILL_LEVELS[s][0]));
    expect(firsts).toEqual([...firsts].sort((a, b) => a - b));
  });
});

// ---------------------------------------------------------------- rating one skill

describe('rateSkill: against the pass rule and tiers', () => {
  const single = exerciseDef('one', {
    scoring: [{ metric: 'accuracy.inTolerancePct', weight: 1, best: 100, worst: 0 }],
    pass: { score: 0.6 },
    tiers: { solid: 0.8, studio: 0.92 },
  });
  const rate = (pct: number | undefined) => rateSkill(single, pct === undefined ? {} : { 'accuracy.inTolerancePct': pct }, ['accuracy.inTolerancePct']);

  it('solid from the solid tally up, getting there down to NEAR_PASS below the pass mark, focus under that', () => {
    expect(NEAR_PASS).toBe(0.15);
    expect(rate(100)).toBe('solid');
    expect(rate(80)).toBe('solid');
    expect(rate(79.9)).toBe('getting-there');
    expect(rate(60)).toBe('getting-there');
    expect(rate(45)).toBe('getting-there');
    expect(rate(44.9)).toBe('focus');
    expect(rate(0)).toBe('focus');
    expect(rate(undefined)).toBe('not-measured');
  });

  const gated = exerciseDef('two', {
    scoring: [
      { metric: 'accuracy.inTolerancePct', weight: 1, best: 100, worst: 0 },
      { metric: 'glide.cracks', weight: 1, best: 0, worst: 5 },
    ],
    pass: { score: 0.6, gates: [{ metric: 'glide.cracks', op: '<=', value: 1 }] },
    tiers: { solid: 0.8, studio: 0.92 },
  });
  const keys: MetricKey[] = ['accuracy.inTolerancePct', 'glide.cracks'];
  const rateGated = (pct: number | undefined, cracks: number) => rateSkill(gated, pct === undefined ? { 'glide.cracks': cracks } : { 'accuracy.inTolerancePct': pct, 'glide.cracks': cracks }, keys);

  it('a gate on the skill caps it: missed a little, getting there at most; missed by more than NEAR_PASS, focus', () => {
    expect(rateGated(100, 1)).toBe('solid'); // the gate holds
    expect(rateGated(100, 1.5)).toBe('getting-there'); // standing 0.85, but the gate missed by 0.1
    expect(rateGated(100, 1.75)).toBe('getting-there'); // missed by exactly NEAR_PASS
    expect(rateGated(100, 2)).toBe('focus'); // standing 0.8, but the gate missed by 0.2
    expect(rateGated(100, 5)).toBe('focus');
  });

  it('a metric the take could not read scores 0, as in the scorer; a gate on another skill does not count', () => {
    expect(rateGated(undefined, 0)).toBe('getting-there'); // (0 + 1) / 2 = 0.5
    expect(rateSkill(gated, { 'accuracy.inTolerancePct': 90, 'glide.cracks': 4 }, ['accuracy.inTolerancePct'])).toBe('solid');
    expect(rateSkill(gated, { 'accuracy.inTolerancePct': 90 }, ['onset.settleMs'])).toBe('not-measured');
  });

  it('the Range finder: 14 half steps and up solid, an octave enough, a half step short getting there, less focus', () => {
    const def = defOf(0);
    const range = (span: number) => rateSkill(def, { 'range.spanSemitones': span }, ['range.spanSemitones']);
    expect([16, 14, 13, 12, 11, 10, 6].map(range)).toEqual(['solid', 'solid', 'getting-there', 'getting-there', 'getting-there', 'focus', 'focus']);
  });

  it('the siren: no break or one is solid when the rest is clean, two breaks or more need focus', () => {
    const def = defOf(2);
    const slides = (cracks: number) => rateSkill(def, metricsAt(def, 1, { 'glide.cracks': cracks }), ['glide.smoothness', 'glide.cracks', 'glide.endAbsCents']);
    expect([0, 1, 2, 5].map(slides)).toEqual(['solid', 'solid', 'focus', 'focus']);
  });
});

// ---------------------------------------------------------------- reading check-ups back

describe('checkupsOf: what counts', () => {
  it('a check-up counts once its last task is sung, and its tasks carry their takes', () => {
    const rows = checkup('c1', [1, 1, 1, 1, null]);
    expect(read(rows)).toEqual([]);
    expect(isCheckupFinished(rows, 'c1')).toBe(false);
    const last = take(4, 'c1', metricsAt(defOf(4), 1));
    const log = [...rows, last];
    expect(isCheckupFinished(log, 'c1')).toBe(true);
    expect(isCheckupFinished(log, 'nope')).toBe(false);
    const s = only(read(log));
    expect(s).toMatchObject({ checkupId: 'c1', profileId: P1, startedAt: rows[0].createdAt, finishedAt: last.createdAt });
    expect(s.tasks.map((t) => [t.exerciseId, t.title, t.attemptId, t.passed])).toEqual(CHECKUP_TASKS.map((task, i) => [task.exerciseId, task.title, log[i].id, true]));
    expect(s.tasks.every((t) => t.score !== null && t.score > 0.99)).toBe(true);
    expect(ratings(s)).toEqual({ range: 'solid', pitch: 'solid', steadiness: 'solid', slides: 'solid', starts: 'solid', connected: 'solid' });
    expect(s.focus).toEqual([]);
  });

  it('a task not sung, a silent take and a take that ended early are not measured, and say why', () => {
    const silent = take(1, 'c1', metricsAt(defOf(1), 1), { durationSec: 0 });
    const stopped = take(2, 'c1', metricsAt(defOf(2), 1), { durationSec: wholeSec(defOf(2)) - 2 });
    const log = [take(0, 'c1', metricsAt(defOf(0), 1)), silent, stopped, take(4, 'c1', metricsAt(defOf(4), 1))];
    const s = only(read(log));
    expect(s.tasks[3]).toEqual({ exerciseId: CHECKUP_TASKS[3].exerciseId, title: CHECKUP_TASKS[3].title, attemptId: null, passed: null, score: null });
    expect(ratings(s)).toEqual({ range: 'solid', pitch: 'not-measured', steadiness: 'not-measured', slides: 'not-measured', starts: 'not-measured', connected: 'solid' });
    expect(skillOf(s, 'pitch').what).toBe('Nothing came through the microphone on this task, so it was not measured.');
    expect(skillOf(s, 'slides').what).toBe('Not all of this task was heard (it stopped early or went quiet), so it was not measured.');
    expect(skillOf(s, 'starts').what).toBe('Not sung in this check-up, so not measured.');
    expect(s.focus).toEqual([]); // nothing measured needs it
  });

  it('a take that ran to its end within the slack is whole; a Range finder that held nothing is not measured', () => {
    const nearlyWhole = take(1, 'c1', metricsAt(defOf(1), 1), { durationSec: wholeSec(defOf(1)) - 0.2 });
    const noHold = take(0, 'c1', {}); // range.spanSemitones missing: no note held long enough
    const s = only(read([noHold, nearlyWhole, take(4, 'c1', metricsAt(defOf(4), 1))]));
    expect(skillOf(s, 'pitch').rating).toBe('solid');
    expect(skillOf(s, 'range')).toMatchObject({ rating: 'not-measured', what: 'No low or high note was held long enough to measure your range.' });
  });

  it('a task sung twice counts its latest take; other check-ups, other profiles and deleted rows stay out', () => {
    const first = take(2, 'c1', metricsAt(defOf(2), 1, { 'glide.cracks': 4 }));
    const again = take(2, 'c1', metricsAt(defOf(2), 1));
    const log = [
      ...checkup('c1', [1, 1, null, 1, null]),
      first,
      take(1, 'c2', metricsAt(defOf(1), 0)), // another check-up, never finished
      again,
      { ...take(3, 'c1', metricsAt(defOf(3), 0)), deletedAt: '2026-03-02T00:00:00.000Z' },
      take(4, 'c1', metricsAt(defOf(4), 1)),
      take(4, 'c3', metricsAt(defOf(4), 1), { profileId: 'someone-else' }),
    ];
    const mine = read(log).filter((s) => s.profileId === P1);
    const s = only(mine);
    expect(s.tasks[2].attemptId).toBe(again.id);
    expect(skillOf(s, 'slides').rating).toBe('solid');
    expect(skillOf(s, 'starts').rating).toBe('solid'); // the deleted take is not the latest
  });

  it('lists finished check-ups oldest first', () => {
    const log = [...checkup('first', ALL_SOLID), pass('foundations.06'), ...checkup('second', ALL_SOLID)];
    expect(read(log).map((s) => s.checkupId)).toEqual(['first', 'second']);
  });
});

describe('checkupsOf: what each skill says, in plain words', () => {
  it('one plain sentence per skill, at every rating and reading', () => {
    const texts: string[] = [];
    for (const x of [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.45, 0.3, 0.1, 0]) {
      for (const cracks of [0, 1, 3]) {
        const log = checkup(`c-${x}-${cracks}`, [x, x, x, x, x], { 2: { 'glide.cracks': cracks } });
        for (const s of read(log)[0].skills) texts.push(s.what);
      }
    }
    const partial = only(read([take(0, 'p', { 'range.spanSemitones': 9 }), take(1, 'p', { 'accuracy.inTolerancePct': 40 }), take(3, 'p', { 'onset.scoopCents': 60 }), take(4, 'p', { 'transition.cleanRate': 0.4 })]));
    texts.push(...partial.skills.map((s) => s.what));
    expect(new Set(texts).size).toBeGreaterThan(20);
    for (const t of texts) {
      plain(t);
      expect(t.endsWith('.'), t).toBe(true);
    }
  });

  it('says what the take did with plain numbers', () => {
    const s = only(
      read(
        checkup('c', ALL_SOLID, {
          0: { 'range.spanSemitones': 15 },
          1: { 'accuracy.inTolerancePct': 72, 'accuracy.medianAbsCents': 12, 'accuracy.sdCents': 20, 'accuracy.absDriftCentsPerSec': 2 },
          2: { 'glide.cracks': 3 },
          3: { 'onset.settleMs': 240, 'onset.scoopCents': 25 },
          4: { 'transition.cleanRate': 0.72, 'accuracy.inTolerancePct': 64 },
        }),
      ),
    );
    expect(skillOf(s, 'range').what).toBe('Your easy notes span an octave and 3 half steps, room for every exercise.');
    expect(skillOf(s, 'pitch').what).toBe('You sang in tune 72% of the time, usually off by a little.');
    expect(skillOf(s, 'steadiness').what).toBe('Your held notes were a little wavery and drifted a little.');
    expect(skillOf(s, 'slides').what).toBe('Your voice broke 3 times on the slide, which is common where a voice changes gears.');
    expect(skillOf(s, 'starts').what).toBe('Your notes took about a quarter of a second to settle, sliding up into them by about a quarter of the way to the next note.');
    expect(skillOf(s, 'connected').what).toBe('You changed notes cleanly 72% of the time and were in tune for 64% of the line.');

    const short = only(read(checkup('d', ALL_SOLID, { 0: { 'range.spanSemitones': 10 }, 2: { 'glide.cracks': 0 } })));
    expect(skillOf(short, 'range').what).toBe('Your easy notes span 10 half steps so far; the exercises use an octave.');
    expect(skillOf(short, 'slides').what).toBe('Your slide up and down was smooth, with no breaks.');
  });

  it('names where a slide landed when that is what held it back, never calling a slide that missed its note fine', () => {
    const def = defOf(2);
    expect(def.pass.gates?.find((g) => g.metric === 'glide.endAbsCents')).toMatchObject({ op: '<=', value: 48 });
    const slides = (siren: Metrics) => skillOf(only(read(checkup(`s${JSON.stringify(siren)}`, ALL_SOLID, { 2: siren }))), 'slides');

    // Smooth, unbroken and landing inside its gate: solid, and the sentence says so.
    expect(slides({ 'glide.endAbsCents': 40 })).toMatchObject({ rating: 'solid', what: 'Your slide up and down was smooth, with no breaks.' });
    // Just past the gate: getting there, and the landing is named (the reviewer's 50: same rating, until now the smooth sentence).
    expect(slides({ 'glide.endAbsCents': 50 })).toMatchObject({
      rating: 'getting-there',
      what: 'Your slide had no breaks, but it ended off the note it was heading for, by about half the way to the next note.',
    });
    // Well past it: focus, and only the landing is named.
    expect(slides({ 'glide.endAbsCents': 70 })).toMatchObject({ rating: 'focus', what: 'Your slide had no breaks, but it ended off the note it was heading for, by nearly a half step.' });
    // Breaks and a missed landing: both.
    expect(slides({ 'glide.cracks': 3, 'glide.endAbsCents': 120 }).what).toBe(
      'Your voice broke 3 times on the slide, which is common where a voice changes gears. It also ended off the note it was heading for, by about a half step.',
    );
    // Stepped, unbroken, landing off; breaks not read, landing off.
    expect(slides({ 'glide.smoothness': 0.2, 'glide.endAbsCents': 70 }).what).toBe('Your slide had no breaks, though it moved in steps and ended off the note it was heading for, by nearly a half step.');
    expect(slides({ 'glide.cracks': Number.NaN, 'glide.endAbsCents': 70 }).what).toBe('Your slide moved in one smooth line, but it ended off the note it was heading for, by nearly a half step.');
    expect(slides({ 'glide.cracks': Number.NaN, 'glide.smoothness': 0.2, 'glide.endAbsCents': 70 }).what).toBe('Your slide moved in steps and ended off the note it was heading for, by nearly a half step.');

    // A slide that is focus for its landing is the focus, and never with a sentence that says it was fine.
    const s = only(read(checkup('f', ALL_SOLID, { 2: { 'glide.endAbsCents': 120 } })));
    expect(s.focus[0]).toBe('slides');
    expect(skillOf(s, 'slides').what).toMatch(/ended off the note/);
    for (const end of [30, 49, 60, 90, 120, 300]) plain(slides({ 'glide.endAbsCents': end }).what);
  });
});

describe('checkupsOf: the range is measured, never graded', () => {
  const rangeOf = (span: number) => skillOf(only(read(checkup(`r${span}`, ALL_SOLID, { 0: { 'range.spanSemitones': span } }))), 'range');

  it('an octave or more is solid, room for every exercise, however wide; short of an octave is rated on the finder’s bands', () => {
    expect([24, 16, 14, 13, 12].map((span) => rangeOf(span).rating)).toEqual(['solid', 'solid', 'solid', 'solid', 'solid']);
    expect([11, 10, 6].map((span) => rangeOf(span).rating)).toEqual(['getting-there', 'focus', 'focus']);
    // The rating and the sentence agree: "room for every exercise" is solid, "so far" never is.
    for (const span of [6, 10, 11, 12, 13, 14, 16, 24]) {
      const r = rangeOf(span);
      expect(r.what.includes('room for every exercise'), `${span}`).toBe(r.rating === 'solid');
      plain(r.what);
    }
  });

  it('“then and now” still compares the span itself', () => {
    const [before, after] = read([...checkup('a', ALL_SOLID, { 0: { 'range.spanSemitones': 12 } }), ...checkup('b', ALL_SOLID, { 0: { 'range.spanSemitones': 13 } })]);
    expect(compareCheckups(before, after).lines.find((l) => l.skill === 'range')).toEqual({ skill: 'range', label: 'Range', before: 'an octave', now: 'an octave and 1 half step', better: true });
  });
});

describe('isTaskMeasured', () => {
  it('true when the take measured a skill of its task: heard in full and read', () => {
    CHECKUP_TASKS.forEach((_, i) => expect(isTaskMeasured(i, take(i, 'c', metricsAt(defOf(i), 0.5))), `task ${i}`).toBe(true));
    // Sung off pitch to the end is still measured.
    expect(isTaskMeasured(2, take(2, 'c', metricsAt(defOf(2), 0)))).toBe(true);
  });

  it('false for a silent take, one stopped early, one with nothing read, and an index that is no task', () => {
    expect(isTaskMeasured(1, take(1, 'c', metricsAt(defOf(1), 1), { durationSec: 0 }))).toBe(false);
    expect(isTaskMeasured(2, take(2, 'c', metricsAt(defOf(2), 1), { durationSec: wholeSec(defOf(2)) - 2 }))).toBe(false);
    expect(isTaskMeasured(0, take(0, 'c', {}))).toBe(false);
    for (const bad of [-1, 5, 1.5, Number.NaN]) expect(isTaskMeasured(bad, take(1, 'c', metricsAt(defOf(1), 1)))).toBe(false);
  });
});

describe('unfinishedCheckup: picking a check-up up again after Pitch Lab closed', () => {
  const startOf = (rows: AttemptRecord[]): number => Date.parse(rows[0].createdAt);

  it('the newest check-up when its last task is unsung and it began less than a day ago, with each task’s latest take', () => {
    expect(RESUME_WITHIN_MS).toBe(DAY_MS);
    const range = take(0, 'c1', metricsAt(defOf(0), 1));
    const first = take(1, 'c1', metricsAt(defOf(1), 0.2));
    const again = take(1, 'c1', metricsAt(defOf(1), 1));
    const rows = [range, first, again];
    const found = unfinishedCheckup(rows, P1, startOf(rows) + 3_600_000);
    expect(found).toEqual({ checkupId: 'c1', startedAt: rows[0].createdAt, attemptIds: [rows[0].id, again.id, null, null, null] });
  });

  it('none when the newest is finished, too old, another profile’s, or there is none', () => {
    const old = checkup('old', ALL_SOLID); // rows are timed as they are made: this one comes first
    const open = checkup('c1', [1, 1, null, null, null]);
    const at = startOf(open);
    expect(unfinishedCheckup([], P1, at)).toBeNull();
    expect(unfinishedCheckup(open, P1, at + DAY_MS)).toBeNull(); // a day on: it no longer makes one sitting
    expect(unfinishedCheckup(open, P1, at + DAY_MS - 1)).not.toBeNull();
    expect(unfinishedCheckup(open, 'someone-else', at)).toBeNull();
    const finishedAfter = [...open, ...checkup('c2', ALL_SOLID)];
    expect(unfinishedCheckup(finishedAfter, P1, at + 60_000)).toBeNull(); // the newest one is finished: nothing to pick up
    expect(unfinishedCheckup([...old, ...open], P1, at + 60_000)?.checkupId).toBe('c1');
    const deleted = open.map((a) => ({ ...a, deletedAt: '2026-03-02T00:00:00.000Z' }));
    expect(unfinishedCheckup(deleted, P1, at)).toBeNull();
  });
});

describe('checkupsOf: focus', () => {
  const steadyButCracks = () => checkup('c', ALL_SOLID, { 2: { 'glide.cracks': 3 } });

  it('“you can hold a note, but your voice cracks”: focus on slides', () => {
    const s = only(read(steadyButCracks()));
    expect(ratings(s)).toMatchObject({ pitch: 'solid', steadiness: 'solid', slides: 'focus' });
    expect(s.focus).toEqual(['slides']);
    expect(latestCheckupFocus(steadyButCracks())).toEqual(['slides']);
  });

  it('clearly short before getting there, then the skill whose level comes first; two at most', () => {
    // Steadiness getting there (Sustain, level 03), slides and connected lines need focus (05, 09), starts too (06).
    const s = only(read(checkup('c', [1, 1, 1, 0.3, 0.3], { 1: { 'accuracy.sdCents': valueAt(defOf(1), 'accuracy.sdCents', 0.6), 'accuracy.absDriftCentsPerSec': valueAt(defOf(1), 'accuracy.absDriftCentsPerSec', 0.6) }, 2: { 'glide.cracks': 3 } })));
    expect(ratings(s)).toMatchObject({ steadiness: 'getting-there', slides: 'focus', starts: 'focus', connected: 'focus' });
    expect(s.focus).toEqual(['slides', 'starts']);
    // Only "getting there" left: it is still the thing to work on.
    const t = only(read(checkup('d', ALL_SOLID, { 1: { 'accuracy.sdCents': valueAt(defOf(1), 'accuracy.sdCents', 0.6), 'accuracy.absDriftCentsPerSec': valueAt(defOf(1), 'accuracy.absDriftCentsPerSec', 0.6) } })));
    expect(t.focus).toEqual(['steadiness']);
  });

  it('the range is a focus only when it is short of what the exercises need, and then it comes first', () => {
    const passed = only(read(checkup('c', ALL_SOLID, { 0: { 'range.spanSemitones': 13 }, 4: { 'transition.cleanRate': 0 } })));
    expect(skillOf(passed, 'range').rating).toBe('solid'); // measured, not graded: an octave and up is room for every exercise
    expect(passed.focus).toEqual(['connected']);
    const short = only(read(checkup('d', ALL_SOLID, { 0: { 'range.spanSemitones': 10 }, 4: { 'transition.cleanRate': 0 } })));
    expect(short.focus).toEqual(['range', 'connected']);
  });

  it('the latest finished check-up sets the focus; an unfinished one after it does not', () => {
    const log = [...checkup('old', ALL_SOLID, { 2: { 'glide.cracks': 3 } }), ...checkup('new', [1, 1, 1, 1, 0])];
    expect(latestCheckupFocus(log)).toEqual(['connected']);
    expect(latestCheckupFocus([...log, ...checkup('later', [1, 0, null, null, null])])).toEqual(['connected']);
    expect(latestCheckupFocus([])).toEqual([]);
  });
});

describe('checkupsOf: where to start and what opened (the engine grants placement tests in order only)', () => {
  const snap = (log: AttemptRecord[]) => computeSnapshot(P1, WORLDS, log, BASE_MS, { getExercise: withRoutines(getExercise) });

  it('a new singer: the Range finder is passed, each test passed in order opens its levels, a miss stops the grants there', () => {
    const log = checkup('c', [1, 1, 1, 0.1, 1]);
    const s = only(read(log));
    expect(s.tasks.map((t) => t.passed)).toEqual([true, true, true, false, true]);
    expect(s.opened).toEqual(['foundations.02', 'foundations.03', 'foundations.04', 'foundations.05']);
    expect(s.startLevelId).toBe('foundations.06');
    // The last test passed, but its level waits behind the ones the missed test covers.
    expect(snap(log).levels['foundations.09'].status).toBe('locked');
  });

  it('a placement test passed out of order grants nothing', () => {
    const log = checkup('c', [1, 0.1, 1, 1, 1]);
    const s = only(read(log));
    expect(s.tasks.map((t) => t.passed)).toEqual([true, false, true, true, true]);
    expect(s.opened).toEqual([]);
    expect(s.startLevelId).toBe('foundations.02');
    const after = snap(log);
    expect(after.levels['foundations.01']).toMatchObject({ status: 'passed', viaAudition: false });
    expect(['foundations.02', 'foundations.05', 'foundations.06', 'foundations.09'].map((id) => after.levels[id].status)).toEqual(['current', 'locked', 'locked', 'locked']);
  });

  it('never grants the Range finder: a missed Range finder holds every grant back', () => {
    const log = checkup('c', [0.2, 1, 1, 1, 1]);
    const s = only(read(log));
    expect(s.tasks[0].passed).toBe(false);
    expect(s.opened).toEqual([]);
    expect(s.startLevelId).toBe('foundations.01');
  });

  it('a test it passed out of the audition’s order never grants later either, once the levels before it are passed', () => {
    // The siren missed, the tests after it passed: passing Sirens & glides later opens Crispness, and nothing past it.
    const cracked = checkup('c', [1, 1, 0.1, 1, 1]);
    expect(only(read(cracked)).opened).toEqual(['foundations.02', 'foundations.03', 'foundations.04']);
    const later = snap([...cracked, pass('foundations.05')]);
    expect(['foundations.05', 'foundations.06', 'foundations.07', 'foundations.08', 'foundations.09'].map((id) => later.levels[id].status)).toEqual(['passed', 'current', 'locked', 'locked', 'locked']);

    // The Range finder missed, every test passed in the default range: passing the Range finder later opens Pitch match only.
    const noRange = checkup('d', [0.2, 1, 1, 1, 1]);
    const ranged = snap([...noRange, pass('foundations.01')]);
    expect(['foundations.01', 'foundations.02', 'foundations.03'].map((id) => ranged.levels[id].status)).toEqual(['passed', 'current', 'locked']);
    expect(Object.values(ranged.levels).some((l) => l.viaAudition)).toBe(false);
  });

  it('counts only what the check-up opened: levels passed before it are not "opened"', () => {
    const before = passThrough(WORLDS, 'foundations.03');
    const s = only(read([...before, ...checkup('c', [1, 1, 0.1, 0.1, 0.1])]));
    expect(s.opened).toEqual(['foundations.04']);
    expect(s.startLevelId).toBe('foundations.05');
    const done = only(read([...passThrough(WORLDS, 'foundations.boss'), ...checkup('d', ALL_SOLID)]));
    expect(done).toMatchObject({ opened: [], startLevelId: null });
    expect(only(read([...passThrough(WORLDS, 'foundations.09'), ...checkup('e', ALL_SOLID)])).startLevelId).toBe('foundations.boss');
  });

  it('uses the caller’s snapshot after the check-up when it has one', () => {
    const log = checkup('c', [1, 1, 1, 1, 1]);
    const later = snap([...passThrough(WORLDS, 'foundations.07')]);
    const s = only(checkupsOf(log, (id) => (id === 'c' ? later : null), 'sharps'));
    expect(s.startLevelId).toBe('foundations.08');
  });
});

describe('checkupsOf: the range in note names', () => {
  const RANGE = (measuredAt: string): VocalRange => ({ comfortable: { low: 48, high: 69 }, extended: { low: 45, high: 72 }, measuredAt });

  it('names the comfortable range the check-up’s Range finder saved, in the singer’s notation', () => {
    const log = checkup('c', ALL_SOLID);
    const measuredAt = log[0].createdAt;
    expect(only(read(log, RANGE(measuredAt))).range).toBe('C3–A4');
    const flats = only(checkupsOf(checkup('d', ALL_SOLID).map((a) => ({ ...a })), () => null, 'flats', { ...RANGE(''), comfortable: { low: 49, high: 70 } }));
    expect(flats.range).toBeNull(); // not the take that saved it
    const own = checkup('e', ALL_SOLID);
    expect(only(checkupsOf(own, () => null, 'flats', { ...RANGE(own[0].createdAt), comfortable: { low: 49, high: 70 } })).range).toBe('D♭3–B♭4');
  });

  it('is null without the saved range, when a later take saved it, or when the Range finder did not pass', () => {
    const log = checkup('c', ALL_SOLID);
    expect(only(read(log)).range).toBeNull();
    expect(only(read(log, RANGE('2026-12-01T00:00:00.000Z'))).range).toBeNull();
    const missed = checkup('d', [0.2, 1, 1, 1, 1]);
    expect(only(read(missed, RANGE(missed[0].createdAt))).range).toBeNull();
  });
});

// ---------------------------------------------------------------- then and now

describe('compareCheckups', () => {
  it('per skill, the same reading then and now in plain words: “Slides: 5 breaks then, 1 break now”', () => {
    const log = [
      ...checkup('then', ALL_SOLID, { 0: { 'range.spanSemitones': 12 }, 2: { 'glide.cracks': 5 }, 3: { 'onset.settleMs': 450 } }),
      ...checkup('now', ALL_SOLID, { 0: { 'range.spanSemitones': 14 }, 2: { 'glide.cracks': 1 }, 3: { 'onset.settleMs': 240 } }),
    ];
    const [before, after] = read(log);
    const c = compareCheckups(before, after);
    expect(c.before).toBe(before);
    expect(c.after).toBe(after);
    expect(c.lines.map((l) => l.skill)).toEqual(CHECKUP_SKILLS);
    const line = (skill: CheckupSkill) => c.lines.find((l) => l.skill === skill)!;
    expect(line('slides')).toEqual({ skill: 'slides', label: 'Slides', before: '5 breaks', now: '1 break', better: true });
    expect(line('range')).toEqual({ skill: 'range', label: 'Range', before: 'an octave', now: 'an octave and 2 half steps', better: true });
    expect(line('starts')).toMatchObject({ before: 'about half a second to settle', now: 'about a quarter of a second to settle', better: true });
    expect(line('pitch')).toMatchObject({ before: line('pitch').now, better: null }); // the same words: about the same
    expect(c.headline).toBe('Real progress since last time: your range, slides and note starts got better.');
    for (const l of c.lines) [l.label, l.before, l.now].forEach(plain);
    plain(c.headline);
  });

  it('a skill measured on one side only reads “not measured” there and calls nothing better; on neither side it is left out', () => {
    const log = [...checkup('then', [1, null, 1, 1, 1]), ...checkup('now', [1, 1, null, 1, 1])];
    const c = compareCheckups(...(read(log) as [CheckupSummary, CheckupSummary]));
    const inTune = Math.round(valueAt(defOf(1), 'accuracy.inTolerancePct', 1));
    expect(c.lines.find((l) => l.skill === 'pitch')).toMatchObject({ before: 'not measured', now: `${inTune}% in tune`, better: null });
    expect(c.lines.find((l) => l.skill === 'slides')).toMatchObject({ before: 'no breaks', now: 'not measured', better: null });
    const neither = [...checkup('a', [1, null, 1, 1, 1]), ...checkup('b', [1, null, 1, 1, 1])];
    expect(compareCheckups(...(read(neither) as [CheckupSummary, CheckupSummary])).lines.map((l) => l.skill)).toEqual(['range', 'slides', 'starts', 'connected']);
  });

  it('a warm headline for every mix: better, worse, both, or the same', () => {
    const pair = (thenOver: Record<number, Metrics>, nowOver: Record<number, Metrics>) =>
      compareCheckups(...(read([...checkup('a', ALL_SOLID, thenOver), ...checkup('b', ALL_SOLID, nowOver)]) as [CheckupSummary, CheckupSummary]));
    const mixed = pair({ 2: { 'glide.cracks': 4 } }, { 1: { 'accuracy.inTolerancePct': 50 } });
    expect(mixed.lines.filter((l) => l.better !== null).map((l) => [l.skill, l.better])).toEqual([
      ['pitch', false],
      ['slides', true],
    ]);
    expect(mixed.headline).toBe('Your slides got better since last time; your pitch dipped, which happens from day to day.');
    expect(pair({}, { 2: { 'glide.cracks': 2 } }).headline).toBe('Your slides dipped since last time, which happens from day to day: rest well and keep practising.');
    expect(pair({}, {}).headline).toBe('Much the same as last time: steady practice is what moves it.');
    for (const c of [mixed, pair({}, { 2: { 'glide.cracks': 2 } }), pair({}, {})]) plain(c.headline);
  });

  it('says the ratings when the compared reading reads the same but the rating moved (where the slide landed)', () => {
    const [before, after] = read([...checkup('a', ALL_SOLID, { 2: { 'glide.endAbsCents': 120 } }), ...checkup('b', ALL_SOLID, { 2: { 'glide.endAbsCents': 30 } })]);
    expect([before, after].map((s) => skillOf(s, 'slides').rating)).toEqual(['focus', 'solid']);
    const c = compareCheckups(before, after);
    expect(c.lines.find((l) => l.skill === 'slides')).toEqual({ skill: 'slides', label: 'Slides', before: 'focus here', now: 'solid', better: true });
    expect(c.headline).toBe('Real progress since last time: your slides got better.');
    // The same words and the same rating are about the same, as before.
    const [x, y] = read([...checkup('x', ALL_SOLID), ...checkup('y', ALL_SOLID)]);
    expect(compareCheckups(x, y).lines.find((l) => l.skill === 'slides')).toEqual({ skill: 'slides', label: 'Slides', before: 'no breaks', now: 'no breaks', better: null });
  });

  it('summaries without readings (built by hand) compare their ratings', () => {
    const summary = (rating: SkillResult['rating']): CheckupSummary => ({
      checkupId: rating,
      profileId: P1,
      startedAt: '2026-03-01T12:00:00.000Z',
      finishedAt: '2026-03-01T12:04:00.000Z',
      tasks: [],
      skills: [{ skill: 'slides', rating, what: 'x' }],
      focus: [],
      startLevelId: null,
      opened: [],
      range: null,
    });
    const c = compareCheckups(summary('focus'), summary('getting-there'));
    expect(c.lines).toEqual([{ skill: 'slides', label: 'Slides', before: 'focus here', now: 'getting there', better: true }]);
    expect(compareCheckups(summary('solid'), summary('solid')).lines[0].better).toBeNull();
  });
});

// ---------------------------------------------------------------- re-check

describe('recheckDue', () => {
  const at = (ms: number): CheckupSummary => ({ finishedAt: new Date(ms).toISOString() }) as CheckupSummary;

  it('with no check-up yet, and from RECHECK_AFTER_DAYS after the latest one', () => {
    expect(RECHECK_AFTER_DAYS).toBe(21);
    expect(recheckDue([], BASE_MS)).toBe(true);
    expect(recheckDue([at(BASE_MS)], BASE_MS + 20 * DAY_MS)).toBe(false);
    expect(recheckDue([at(BASE_MS)], BASE_MS + 21 * DAY_MS - 1)).toBe(false);
    expect(recheckDue([at(BASE_MS)], BASE_MS + 21 * DAY_MS)).toBe(true);
    expect(recheckDue([at(BASE_MS - 40 * DAY_MS), at(BASE_MS)], BASE_MS + 5 * DAY_MS)).toBe(false); // the latest decides
    expect(recheckDue([at(BASE_MS)], BASE_MS - DAY_MS)).toBe(false); // a clock set back
    expect(recheckDue([{ finishedAt: 'not a date' } as CheckupSummary], BASE_MS)).toBe(true);
  });
});
