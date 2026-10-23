/**
 * The voice check-up side of the offline coaching analysis (offline.ts, scripts/coach.mjs) on synthesized backups.
 *
 * A check-up is the attempts of one backup that share a checkupId. They are read back with checkup/summary.ts (the real one, and
 * fakes that throw "not built yet" or answer with canned summaries, as the coaching engine's are handled), and the numbers behind
 * every rating are read from the log: the singer's check-ups, each skill's rating and the numbers it comes from, what was left
 * unfinished, the then-and-now of each pair, when a re-check is due, and how scripts/coach.mjs prints it.
 */
import { describe, expect, it } from 'vitest';
import type { MetricKey, Metrics } from '../analysis/types';
import { CHECKUP_TASKS, RECHECK_AFTER_DAYS } from '../checkup/types';
import { checkupsOf } from '../checkup/summary';
import { analyzeTake, evaluate, getExercise, realize, type ExerciseDef } from '../exercises';
import { GOOD_SINGER, singTake } from '../exercises/test-singer';
import { buildAttempt } from '../progress/attempt';
import type { AttemptRecord, BackupFile, ProfileRecord } from '../storage/schema';
import { decodeTrack, encodeTrack } from '../storage/track-codec';
import {
  CoachInputError,
  REAL_CHECKUP_ENGINE,
  analyzeInputs,
  analyzeReports,
  diagnoseCheckups,
  formatCheckupDiagnosis,
  formatDiagnosis,
  formatReport,
  isCheckupReport,
  readCoachInput,
  type CheckupDiagnosis,
  type CheckupEngine,
  type CoachInput,
  type Report,
} from './offline';
import type { CoachingFile } from './types';

// The src tsconfig carries no Node types (the app is browser code), so the Node modules the CLI test needs are loaded
// dynamically, with just the signatures used (as offline.test.ts does).
const fs = (await import(/* @vite-ignore */ `node:${'fs'}`)) as {
  mkdirSync(path: string, opts: { recursive: boolean }): void;
  mkdtempSync(prefix: string): string;
  rmSync(path: string, opts: { recursive: boolean; force: boolean }): void;
  writeFileSync(path: string, data: string | Uint8Array): void;
};
const os = (await import(/* @vite-ignore */ `node:${'os'}`)) as { tmpdir(): string };
const path = (await import(/* @vite-ignore */ `node:${'path'}`)) as { join(...parts: string[]): string };
const url = (await import(/* @vite-ignore */ `node:${'url'}`)) as { fileURLToPath(u: URL): string };
const childProcess = (await import(/* @vite-ignore */ `node:${'child_process'}`)) as {
  execFileSync(file: string, args: string[], opts: { cwd: string; encoding: 'utf8'; timeout: number; stdio: string[] }): string;
};
const proc = (globalThis as unknown as { process: { execPath: string; env: Record<string, string | undefined> } }).process;
const ROOT = url.fileURLToPath(new URL('../../', import.meta.url));

// ---------------------------------------------------------------- the takes of a check-up

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1, 18, 0);
const at = (days: number, minutes = 0): string => new Date(T0 + days * DAY + minutes * 60_000).toISOString();

const defOf = (taskIndex: number): ExerciseDef => getExercise(CHECKUP_TASKS[taskIndex].exerciseId) as ExerciseDef;

/** The value of `metric` that scores `x` (0..1) on `def`'s own band for it. */
function valueAt(def: ExerciseDef, metric: MetricKey, x: number): number {
  const term = def.scoring.find((t) => t.metric === metric) as NonNullable<ExerciseDef['scoring'][number]>;
  return term.worst + x * (term.best - term.worst);
}

/** Every metric `def` scores, each at term score `x`, with overrides: the numbers a take of that standing would carry. */
function metricsAt(def: ExerciseDef, x: number, over: Metrics = {}): Metrics {
  const m: Metrics = {};
  for (const t of def.scoring) m[t.metric] = valueAt(def, t.metric, x);
  return { ...m, ...over };
}

/** Count-in plus material: the length of a whole take, which the runner writes as durationSec. */
function wholeSec(def: ExerciseDef): number {
  const r = realize(def, null, 'unknown', { bpm: def.tempoBpm });
  return r.countInSec + r.totalSec;
}

/** The take of one check-up task as the runner logs it: the Range finder a practice rep, the placement tests audition takes. */
function take(taskIndex: number, checkupId: string, when: string, metrics: Metrics, over: Partial<AttemptRecord> = {}): AttemptRecord {
  const task = CHECKUP_TASKS[taskIndex];
  const def = defOf(taskIndex);
  const e = evaluate(def, metrics);
  return {
    id: `${checkupId}-task-${taskIndex + 1}`,
    profileId: 'p1',
    createdAt: when,
    updatedAt: when,
    deletedAt: null,
    exerciseId: def.id,
    levelId: task.logAs.kind === 'practice' ? task.logAs.levelId : null,
    kind: task.logAs.kind === 'practice' ? 'practice' : 'audition',
    score: e.score,
    passed: e.passed,
    mastery: e.mastery,
    metrics,
    durationSec: wholeSec(def),
    tonicMidi: 48,
    tempoBpm: def.tempoBpm,
    takeId: null,
    checkupId,
    ...over,
  };
}

interface TaskSpec {
  /** Term score of every metric the exercise scores (0..1). */
  x: number;
  over?: Metrics;
}

/** A check-up whose tasks are sung one a minute from `day`; null leaves a task unsung. */
function checkup(id: string, day: number, specs: ReadonlyArray<TaskSpec | null>): AttemptRecord[] {
  const rows: AttemptRecord[] = [];
  specs.forEach((s, i) => {
    if (s) rows.push(take(i, id, at(day, i), metricsAt(defOf(i), s.x, s.over)));
  });
  return rows;
}

/**
 * The first check-up (its tasks in the battery's order: the Range finder, match and hold, the two notes near and far, the
 * connected line, the siren): the voice breaks five times on the siren and the range is an octave.
 */
const FIRST = (): AttemptRecord[] =>
  checkup('cu-first', 0, [{ x: 0.7, over: { 'range.spanSemitones': 12 } }, { x: 0.7 }, { x: 0.55 }, { x: 0.85 }, { x: 0.35, over: { 'glide.cracks': 5 } }]);
/** Three weeks on: one break, and the range wider. */
const SECOND = (): AttemptRecord[] =>
  checkup('cu-second', 22, [{ x: 0.9, over: { 'range.spanSemitones': 17 } }, { x: 0.95 }, { x: 0.7 }, { x: 0.9 }, { x: 0.85, over: { 'glide.cracks': 1 } }]);
/** A third one, left after two tasks. */
const THIRD = (): AttemptRecord[] => checkup('cu-third', 30, [{ x: 0.9, over: { 'range.spanSemitones': 17 } }, { x: 0.9 }, null, null, null]);

const profile = (range: ProfileRecord['range'] = null): ProfileRecord => ({
  id: 'p1',
  profileId: 'p1',
  createdAt: at(-5),
  updatedAt: at(-5),
  deletedAt: null,
  name: 'Test Singer',
  voiceType: 'baritone',
  range,
});

/** The range the second check-up's Range finder saved: it is the one saved now. */
const SAVED = (): ProfileRecord['range'] => ({ comfortable: { low: 47, high: 69 }, extended: { low: 43, high: 72 }, measuredAt: at(22, 0) });

const enc = (x: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(x));

function backupOf(attempts: AttemptRecord[], range: ProfileRecord['range'] = SAVED(), exportedAt = at(31)): BackupFile {
  return { format: 'pitch-lab-backup', version: 1, exportedAt, profiles: [profile(range)], attempts, settings: { schemaVersion: 1, profiles: { p1: { notation: 'sharps' } } } };
}

const backupInput = (file: BackupFile, name = 'pitch-lab-backup-2026-11-01.json'): CoachInput => readCoachInput(enc(file), name);

function backupOfAll(): CoachInput {
  return backupInput(backupOf([...FIRST(), ...SECOND(), ...THIRD()]));
}

function read(input: CoachInput, engine?: CheckupEngine, now?: Date): CheckupDiagnosis {
  if (input.kind !== 'backup') throw new Error('not a backup');
  const d = diagnoseCheckups(input.backup, { engine, now });
  if (!d) throw new Error('no check-ups');
  return d;
}

/** Engines that answer with nothing built yet, as the stubs did. */
const NOT_BUILT: CheckupEngine = {
  checkupsOf: () => {
    throw new Error('checkupsOf: not built yet');
  },
  compareCheckups: () => {
    throw new Error('compareCheckups: not built yet');
  },
  recheckDue: () => {
    throw new Error('recheckDue: not built yet');
  },
};

// ---------------------------------------------------------------- the check-ups of a backup

describe('the check-ups of a backup', () => {
  const d = read(backupOfAll());
  const [first, second, third] = d.checkups;

  it('lists them oldest first: the two finished, then the one left unfinished', () => {
    expect(d.source).toBe('checkups');
    expect(d.engine).toEqual({ status: 'ok', message: null });
    expect(d.checkups.map((c) => c.checkupId)).toEqual(['cu-first', 'cu-second', 'cu-third']);
    expect(d.checkups.map((c) => c.finished)).toEqual([true, true, false]);
    expect(first.tasks.map((t) => t.attemptId)).toEqual(['cu-first-task-1', 'cu-first-task-2', 'cu-first-task-3', 'cu-first-task-4', 'cu-first-task-5']);
    expect(third.tasks.map((t) => t.attemptId !== null)).toEqual([true, true, false, false, false]);
    expect(first.tasks.map((t) => t.title)).toEqual(CHECKUP_TASKS.map((t) => t.title));
    expect(first.startedAt).toBe(at(0, 0));
    expect(first.finishedAt).toBe(at(0, 4));
    expect(third.finishedAt).toBeNull();
    expect(third.summary).toBeNull();
  });

  it('rates each skill as the app does, with the numbers behind the rating read from the log', () => {
    const slides1 = first.skills.find((s) => s.skill === 'slides');
    const slides2 = second.skills.find((s) => s.skill === 'slides');
    expect(slides1?.rating).toBe('focus');
    expect(slides1?.what).toMatch(/Your voice broke 5 times on the slide/);
    expect(slides1?.numbers.find((m) => m.label === 'Breaks')).toMatchObject({ metric: 'glide.cracks', value: 5, shown: '5' });
    expect(slides2?.rating).toBe('solid');
    expect(slides2?.numbers.find((m) => m.label === 'Breaks')?.shown).toBe('1');
    expect(first.skills.map((s) => s.skill)).toEqual(['range', 'pitch', 'steadiness', 'starts', 'connected', 'slides']);
    expect(first.skills.find((s) => s.skill === 'range')?.numbers).toEqual([{ metric: 'range.spanSemitones', label: 'Low to high', value: 12, shown: '12 half steps' }]);
    // a measure the take could not read is said so, never a number
    expect(third.skills.find((s) => s.skill === 'slides')?.numbers.every((m) => m.shown === 'not measured')).toBe(true);
  });

  it('says what to focus on, where to start and what each check-up opened', () => {
    expect(first.focus[0]).toBe('slides');
    expect(first.focus.length).toBeLessThanOrEqual(2);
    expect(first.startLevelId).toBe('foundations.10');
    expect(first.startLevelTitle).toBe('Two notes, one step apart');
    expect(first.opened).toEqual(['foundations.02', 'foundations.03', 'foundations.13']);
    expect(second.opened.length).toBeGreaterThan(0);
    // the second check-up's Range finder saved the range the profile has now, so it is named in notes; the first one's was replaced
    expect(second.range).toMatch(/^B2.A4$/);
    expect(first.range).toBeNull();
  });

  it('compares each finished pair, from the app\'s lines and from the numbers', () => {
    expect(d.thenNow).toHaveLength(1);
    const t = d.thenNow[0];
    expect([t.beforeId, t.afterId]).toEqual(['cu-first', 'cu-second']);
    expect(t.daysApart).toBeGreaterThan(21);
    expect(t.daysApart).toBeLessThan(22);
    expect(t.comparison?.headline).toMatch(/got better/);
    expect(t.comparison?.lines.find((l) => l.skill === 'slides')).toMatchObject({ before: '5 breaks', now: '1 break', better: true });
    expect(t.skills.find((s) => s.skill === 'slides')).toMatchObject({ before: 'focus', after: 'solid', verdict: 'better' });
    const change = (metric: MetricKey) => t.changes.find((c) => c.metric === metric);
    expect(change('glide.cracks')).toMatchObject({ before: '5', after: '1', verdict: 'better' });
    expect(change('range.spanSemitones')).toMatchObject({ before: '12 half steps', after: '17 half steps', verdict: 'better' });
    // a move smaller than the usual noise is "same", whichever way it went
    expect(change('onset.settleMs')?.verdict).toBe('same');
  });

  it('says whether a re-check is due, three weeks after the last finished one', () => {
    expect(d.recheck.afterDays).toBe(RECHECK_AFTER_DAYS);
    expect(d.recheck.due).toBe(false); // exported 9 days after the second check-up
    expect(d.recheck.daysSinceLast).toBeGreaterThan(8.9);
    expect(d.recheck.daysSinceLast).toBeLessThan(9.1);
    const later = read(backupOfAll(), undefined, new Date(T0 + 50 * DAY));
    expect(later.recheck.due).toBe(true);
    expect(later.recheck.daysSinceLast).toBeGreaterThan(27);
    const text = formatCheckupDiagnosis(later);
    expect(text).toMatch(/A re-check is due: the last check-up was 2\d(\.\d)? days ago \(one is suggested after 21\)/);
  });

  it('says which skill could not be measured: a task skipped, or one where nothing came through the microphone', () => {
    const rows = checkup('cu-quiet', 0, [{ x: 0.8, over: { 'range.spanSemitones': 14 } }, { x: 0.8 }, null, { x: 0.8 }, { x: 0.8 }]);
    // the two notes near and far were never sung; the connected line is a silent take (the runner writes one as 0 s)
    const silent = rows.map((a) => (a.exerciseId === CHECKUP_TASKS[3].exerciseId ? { ...a, durationSec: 0 } : a));
    const q = read(backupInput(backupOf(silent)));
    expect(q.checkups[0].finished).toBe(true);
    const ratings = Object.fromEntries(q.checkups[0].skills.map((s) => [s.skill, s.rating]));
    expect(ratings.starts).toBe('not-measured');
    expect(ratings.connected).toBe('not-measured');
    expect(q.checkups[0].skills.find((s) => s.skill === 'starts')?.what).toMatch(/Not sung in this check-up/);
    expect(q.checkups[0].skills.find((s) => s.skill === 'connected')?.what).toMatch(/Nothing came through the microphone/);
    expect(q.summary[0]).toMatch(/Not measured: Note starts, Connected lines/);
    expect(formatCheckupDiagnosis(q)).toMatch(/Note starts +not measured +Not sung in this check-up/);
  });

  it('reads the same check-ups whatever order the rows came in', () => {
    const shuffled = [...THIRD(), ...SECOND(), ...FIRST()].reverse();
    const again = read(backupInput(backupOf(shuffled)));
    expect(again.checkups.map((c) => [c.checkupId, c.finished])).toEqual([['cu-first', true], ['cu-second', true], ['cu-third', false]]);
  });
});

// ---------------------------------------------------------------- what it prints

describe('the check-ups as text', () => {
  const d = read(backupOfAll());
  const text = formatCheckupDiagnosis(d);

  it('prints plain ASCII, with every section an analyst looks for', () => {
    expect(text).toMatch(/^[\x00-\x7F]*$/);
    expect(text).not.toMatch(/undefined|NaN|\[object|Infinity/);
    expect(text).toContain('PITCH LAB CHECK-UPS: Test Singer: check-ups');
    expect(text).toContain('Check-ups: 2 finished check-ups, 1 not finished');
    expect(text).toContain('Engine:   checkup/summary.ts answered');
    expect(text).toContain('CHECK-UP 1 of 3: finished: ');
    expect(text).toContain('CHECK-UP 3 of 3: NOT FINISHED: ');
    expect(text).toContain("Skills (the app's rating and plain sentence, then the numbers it is read from):");
    expect(text).toMatch(/Slides +Focus here +Your voice broke 5 times on the slide/);
    expect(text).toMatch(/numbers: Smoothness \d+(\.\d+)?%; Breaks 5; Slide ending off by \d+(\.\d+)? cents/);
    expect(text).toContain('Focus, most important first: Slides');
    expect(text).toContain('Starting point: Two notes, one step apart (foundations.10); this check-up opened foundations.02, foundations.03, foundations.13');
    expect(text).toContain('Range measured: B2-A4');
    expect(text).toMatch(/THEN AND NOW 1: \d{4}-\d\d-\d\d to \d{4}-\d\d-\d\d \(22 days apart; id cu-first -> cu-secon/);
    expect(text).toContain("The app's headline: Real progress since last time");
    expect(text).toMatch(/Slides +Focus here +-> Solid +better/);
    expect(text).toMatch(/Slides +Breaks +5 -> 1 +better/);
    expect(text).toMatch(/Range +Low to high +12 half steps -> 17 half steps +better/);
  });

  it('leaves an unfinished check-up unrated, and says what its sung tasks measured', () => {
    const block = text.slice(text.indexOf('CHECK-UP 3 of 3'), text.indexOf('THEN AND NOW'));
    expect(block).toContain('2 of 5 tasks sung: this was started and left, so it counts for nothing yet');
    expect(block).toContain('What the sung tasks measured:');
    expect(block).toMatch(/Find your range: Low to high 17 half steps/);
    expect(block).not.toContain('Skills (the');
    expect(block).not.toContain('Focus here');
  });

  it('leads with the newest check-up, the focus, the starting point, the then-and-now and the re-check', () => {
    expect(d.summary[0]).toMatch(/^2 check-ups finished and 1 started and left unfinished\. The newest \(.*\): Solid: /);
    expect(d.summary[0]).toContain('Getting there: Note starts');
    expect(d.summary[1]).toBe('Focus, most important first: Note starts.');
    expect(d.summary[2]).toMatch(/^Starting point: .* \(foundations\./);
    expect(d.summary[3]).toMatch(/^Then and now \(\d{4}-\d\d-\d\d to \d{4}-\d\d-\d\d, 22 days\): Real progress since last time.* Breaks 5 -> 1 \(better\)/);
    expect(d.summary[4]).toMatch(/^No re-check due yet: the last check-up was 9 days ago \(one is suggested after 21\)\.$/);
  });
});

// ---------------------------------------------------------------- when the engine is not there

describe('when the check-up engine is not built, or fails', () => {
  it('still lists the check-ups from the log, with the numbers, and says what is missing', () => {
    const d = read(backupOfAll(), NOT_BUILT);
    expect(d.engine.status).toBe('not-built');
    expect(d.engine.message).toMatch(/checkup\/summary\.ts still throws "not built yet"/);
    // a check-up counts once its last task was sung, which the log shows by itself
    expect(d.checkups.map((c) => c.finished)).toEqual([true, true, false]);
    expect(d.checkups[0].skills.every((s) => s.rating === null && s.what === null)).toBe(true);
    expect(d.checkups[0].skills.find((s) => s.skill === 'slides')?.numbers.find((m) => m.label === 'Breaks')?.shown).toBe('5');
    expect(d.checkups[0].focus).toEqual([]);
    expect(d.thenNow).toHaveLength(1);
    expect(d.thenNow[0].comparison).toBeNull();
    expect(d.thenNow[0].changes.find((c) => c.metric === 'glide.cracks')).toMatchObject({ before: '5', after: '1', verdict: 'better' });
    expect(d.recheck.due).toBe(false); // this tool's own rule: 9 days since the last
    const text = formatCheckupDiagnosis(d);
    expect(text).toContain('Engine:   not-built: checkup/summary.ts still throws "not built yet"');
    expect(text).toMatch(/Slides +no rating/);
    expect(text).toContain("The app's own lines are missing here (the check-up engine is not built)");
    expect(text).toMatch(/Slides +Breaks +5 -> 1 +better/);
    expect(d.summary[0]).toContain('no ratings (the check-up engine is not built here)');
  });

  it('keeps the ratings when only the then-and-now fails', () => {
    const d = read(backupOfAll(), { ...REAL_CHECKUP_ENGINE, compareCheckups: () => { throw new Error('boom'); } });
    expect(d.engine.status).toBe('ok');
    expect(d.checkups[0].skills.find((s) => s.skill === 'slides')?.rating).toBe('focus');
    expect(d.thenNow[0].comparison).toBeNull();
    expect(d.thenNow[0].changes.length).toBeGreaterThan(8);
  });

  it('reports an engine that fails for another reason, by its message', () => {
    const d = read(backupOfAll(), { ...NOT_BUILT, checkupsOf: () => { throw new Error('the log is on fire'); } });
    expect(d.engine).toEqual({ status: 'error', message: 'the log is on fire' });
    expect(formatCheckupDiagnosis(d)).toContain('Engine:   error: the log is on fire');
  });

  it('hands the engine the singer\'s log, the notation and the saved range', () => {
    const seen: Array<{ attempts: number; notation: string; rangeAt: string | null | undefined; snapshotOk: boolean }> = [];
    read(backupOfAll(), {
      ...REAL_CHECKUP_ENGINE,
      checkupsOf: (log, snapshotAfter, notation, savedRange) => {
        seen.push({ attempts: log.length, notation, rangeAt: savedRange?.measuredAt, snapshotOk: snapshotAfter('cu-second')?.profileId === 'p1' && snapshotAfter('nope') === null });
        return checkupsOf(log, snapshotAfter, notation, savedRange);
      },
    });
    expect(seen).toEqual([{ attempts: 12, notation: 'sharps', rangeAt: at(22, 0), snapshotOk: true }]);
  });
});

// ---------------------------------------------------------------- the reads of a backup, and the flag

describe('reading a backup', () => {
  it('gives its exercise read and then its check-ups, and counts the check-ups in the overview', () => {
    const reports = analyzeReports([backupOfAll()], {});
    expect(reports.map((r) => r.source)).toEqual(['backup', 'checkups']);
    const overview = reports[0].source === 'backup' ? reports[0].overview : null;
    expect(overview?.checkups).toBe(3);
    const text = reports.map((r) => formatReport(r)).join('\n');
    expect(text).toContain('3 voice check-ups in this backup: the check-up read below has them (--checkup for that alone).');
    expect(text.indexOf('PITCH LAB COACHING READ')).toBeLessThan(text.indexOf('PITCH LAB CHECK-UPS'));
  });

  it('reads only the check-ups when asked, and says when there are none', () => {
    const only = analyzeReports([backupOfAll()], { checkup: true });
    expect(only.map((r) => r.source)).toEqual(['checkups']);
    expect(isCheckupReport(only[0])).toBe(true);
    const none = backupInput(backupOf(FIRST().map((a) => ({ ...a, checkupId: undefined }))));
    expect(() => analyzeReports([none], { checkup: true })).toThrow(CoachInputError);
    expect(() => analyzeReports([none], { checkup: true })).toThrow(/no check-up in this backup \(no attempt carries a check-up id\)/);
    const plain: Report[] = analyzeReports([none], {});
    expect(plain.map((r) => r.source)).toEqual(['backup']);
  });

  it('reads the profile asked for, and the one that sang last by default', () => {
    const other: ProfileRecord = { ...profile(null), id: 'p2', profileId: 'p2', name: 'Sam' };
    const samRows = checkup('cu-sam', 40, [{ x: 0.8 }, { x: 0.8 }, { x: 0.8 }, { x: 0.8 }, { x: 0.8 }]).map((a) => ({ ...a, profileId: 'p2', id: `sam-${a.id}` }));
    const file: BackupFile = { ...backupOf([...FIRST(), ...samRows]), profiles: [profile(null), other] };
    const input = backupInput(file);
    const byDefault = analyzeReports([input], { checkup: true })[0];
    expect(byDefault.source === 'checkups' && byDefault.singer.name).toBe('Sam'); // sang most recently
    const chosen = analyzeReports([input], { checkup: true, profile: 'test singer' })[0];
    expect(chosen.source === 'checkups' && chosen.checkups.map((c) => c.checkupId)).toEqual(['cu-first']);
  });

  it('keeps the check-up id and the other new fields on the attempts it reads', () => {
    const input = backupOfAll();
    if (input.kind !== 'backup') throw new Error('not a backup');
    expect(input.backup.attempts.filter((a) => a.checkupId === 'cu-first')).toHaveLength(5);
    expect(input.backup.attempts.filter((a) => a.checkupId).length).toBe(12);
  });

  it('says a take of an exercise was part of a check-up', () => {
    // an audition test sung by the test singer through the real analyzers, logged as the check-up logs it
    const def = getExercise('foundations.audition.2') as ExerciseDef;
    const realized = realize(def, null, 'baritone');
    const frames = singTake(realized, GOOD_SINGER);
    const analysis = analyzeTake(def, realized, decodeTrack(encodeTrack(frames)), { vibratoStyle: 'pop' });
    const evaluation = evaluate(def, analysis.metrics, analysis);
    const fields = buildAttempt({ profileId: 'p1', def, source: { type: 'audition' }, realized, evaluation, metrics: analysis.metrics, checkupId: 'cu-abcdef12-3456' });
    const attempt: AttemptRecord = { ...fields, id: 'a-1', createdAt: at(0), updatedAt: at(0), deletedAt: null };
    const file: CoachingFile = {
      app: 'pitch-lab',
      kind: 'coaching',
      version: 1,
      exportedAt: at(1),
      appVersion: '0.1.0+checkup-test',
      level: { id: null, title: def.title, worldId: def.worldId },
      exercise: JSON.parse(JSON.stringify(def)) as ExerciseDef,
      profile: { name: 'Test Singer', voiceType: 'baritone', range: null },
      settings: { vibratoStyle: 'pop', notation: 'sharps', keepTakeAudio: false },
      device: { route: 'wired', latencyMs: 40, userAgent: 'vitest' },
      takes: [{ attempt, realized: { tonicMidi: realized.tonicMidi, bpm: realized.bpm, countInSec: realized.countInSec, totalSec: realized.totalSec, notes: realized.notes }, track: encodeTrack(frames), audioWavBase64: null }],
    };
    const [diagnosis] = analyzeInputs([readCoachInput(enc(file), 'pitch-lab-coach-audition.json')], {});
    expect(diagnosis.takes[0].checkupId).toBe('cu-abcdef12-3456');
    expect(formatDiagnosis(diagnosis)).toContain('part of the voice check-up cu-abcde');
  }, 60_000);
});

// ---------------------------------------------------------------- scripts/coach.mjs

describe('scripts/coach.mjs on a backup with check-ups', () => {
  const run = (args: string[]): { status: number; out: string; err: string } => {
    try {
      const out = childProcess.execFileSync(proc.execPath, [path.join(ROOT, 'scripts/coach.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] });
      return { status: 0, out, err: '' };
    } catch (e) {
      const x = e as { status?: number; stdout?: string; stderr?: string };
      return { status: x.status ?? -1, out: x.stdout ?? '', err: x.stderr ?? '' };
    }
  };

  it('prints the exercise read and the check-ups, only the check-ups, or JSON, and refuses a backup that has none', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitch-lab-coach-checkup-'));
    try {
      const file = path.join(dir, 'pitch-lab-backup-2026-11-01.json');
      fs.writeFileSync(file, JSON.stringify(backupOf([...FIRST(), ...SECOND(), ...THIRD()])));
      const both = run([file]);
      expect(both.status).toBe(0);
      expect(both.out).toContain('PITCH LAB COACHING READ');
      expect(both.out).toContain('PITCH LAB CHECK-UPS: Test Singer: check-ups');
      expect(both.out).toContain('THEN AND NOW 1:');
      expect(both.out).toMatch(/^[\x00-\x7F]*$/);

      const only = run([file, '--checkup']);
      expect(only.status).toBe(0);
      expect(only.out).toContain('PITCH LAB CHECK-UPS');
      expect(only.out).not.toContain('PITCH LAB COACHING READ');

      const json = run([file, '--checkup', '--json']);
      expect(json.status).toBe(0);
      // plain ASCII like the text: the en dash of "B2-A4" is written as its escape, and reads back as itself
      expect(json.out).toMatch(/^[\x00-\x7F]*$/);
      const enDash = String.fromCharCode(0x2013);
      const backslash = String.fromCharCode(92);
      expect(json.out).toContain(`B2${backslash}u2013A4`);
      const parsed = JSON.parse(json.out) as Array<{ source: string; checkups: Array<{ checkupId: string; finished: boolean; range: string | null }>; thenNow: unknown[] }>;
      expect(parsed[0].source).toBe('checkups');
      expect(parsed[0].checkups[1].range).toBe(`B2${enDash}A4`);
      expect(parsed[0].checkups.map((c) => [c.checkupId, c.finished])).toEqual([['cu-first', true], ['cu-second', true], ['cu-third', false]]);
      expect(parsed[0].thenNow).toHaveLength(1);
      // --take narrows reads that have takes, and leaves a check-up read whole
      expect(JSON.parse(run([file, '--checkup', '--json', '--take', '2']).out)).toEqual(parsed);

      const bare = path.join(dir, 'pitch-lab-backup-bare.json');
      fs.writeFileSync(bare, JSON.stringify(backupOf(FIRST().map((a) => ({ ...a, checkupId: undefined })))));
      const none = run([bare, '--checkup']);
      expect(none.status).toBe(1);
      expect(none.err).toContain('pitch-lab-backup-bare.json: no check-up in this backup');
      expect(none.out).toBe('');
      expect(run([bare]).status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('describes --checkup and --phrase in its usage', () => {
    const help = run(['--help']);
    expect(help.out).toContain('--checkup');
    expect(help.out).toContain('--phrase N');
    expect(help.out).toContain('song coaching file');
  }, 90_000);
});

// ---------------------------------------------------------------- a sample for the docs (only when asked for)

describe('samples', () => {
  it.runIf(proc.env.COACH_SAMPLE_DIR !== undefined)('writes a sample backup with check-ups into COACH_SAMPLE_DIR', () => {
    const out = proc.env.COACH_SAMPLE_DIR as string;
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'pitch-lab-backup-checkups-2026-11-01.json'), JSON.stringify(backupOf([...FIRST(), ...SECOND(), ...THIRD()])));
  });
});
