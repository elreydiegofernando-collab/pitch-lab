/**
 * The coach on real judged takes: misses in a row set the depth (1 tip, 2 + why, 3 + steps, 4 + an easier way in and
 * moves), a pass resets it, the moves are gated (practise a level only once it is passed), voice care asks for a rest,
 * and "since last time" compares the same measures. The content ladders are stood in for here, so these tests never
 * depend on the words the content builders write (content/index.test.ts checks those).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoachLadder } from './types';

const fake = vi.hoisted(() => ({ ladders: {} as Record<string, CoachLadder> }));
vi.mock('./content/index', () => ({ ladderFor: (id: string) => fake.ladders[id] }));

import { latestCheckupFocus } from '../checkup/summary';
import { getExercise, getLevel, POLISH_TIP, STOPPED_TIP } from '../exercises';
import { coachFrom, coachTake, depthFor, FOCUS_PRACTISE_DEPTH, missesInARow, progressLines, REST_MISSES, REST_TAKES, tipOnly, type CoachSource } from './coach';
import { attemptOf, checkupWithFocus, outcomeOf, sing, snapshotOf, T0, type SungTake } from './test-takes';

const ladder = (practiseLevelId?: string): CoachLadder => ({
  tip: 'Plain tip.',
  why: 'Why it happens.',
  steps: ['Step one.', 'Step two.', 'Step three.'],
  easier: 'An easier way in.',
  ...(practiseLevelId ? { practiseLevelId } : {}),
});

const MISS = sing('foundations.03', { offsetSemis: 1 });
const PASS = sing('foundations.03');

beforeEach(() => {
  fake.ladders = {};
  fake.ladders[MISS.tip.id] = ladder();
});

/** `n` earlier misses of the take's exercise, a minute apart, then the take itself; its coaching. */
function coachAfter(take: SungTake, misses: number, opts: { earlier?: ReturnType<typeof attemptOf>[]; gapMs?: number } = {}) {
  const gap = opts.gapMs ?? 5 * 60_000;
  const log = [...(opts.earlier ?? [])];
  for (let i = 0; i < misses; i++) log.push(attemptOf(MISS, { createdAt: new Date(T0 + (log.length + 1) * gap).toISOString() }));
  const current = attemptOf(take, { createdAt: new Date(T0 + (log.length + 1) * gap).toISOString() });
  log.push(current);
  return coachTake(outcomeOf(take, current, snapshotOf(log)), log, { notation: 'sharps' });
}

describe('depthFor', () => {
  it('maps misses in a row to the depth of help', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 9].map(depthFor)).toEqual([1, 1, 2, 3, 4, 4, 4, 4]);
  });
});

describe('missesInARow', () => {
  const id = 'foundations.sustain.1';
  const miss = (extra = {}) => attemptOf(null, { exerciseId: id, passed: false, ...extra });
  const pass = (extra = {}) => attemptOf(null, { exerciseId: id, passed: true, ...extra });

  it('counts the non-passing takes of the exercise back to the last pass, any kind that sings it', () => {
    expect(missesInARow(id, [])).toBe(0);
    expect(missesInARow(id, [miss(), miss({ kind: 'workout' }), miss({ kind: 'record' })])).toBe(3);
    expect(missesInARow(id, [miss(), pass(), miss(), miss()])).toBe(2);
    expect(missesInARow(id, [miss(), miss(), pass()])).toBe(0);
  });

  it('skips other exercises and deleted rows', () => {
    const other = attemptOf(null, { exerciseId: 'foundations.siren.1', passed: true });
    expect(missesInARow(id, [pass(), miss(), other, miss()])).toBe(2);
    expect(missesInARow(id, [pass(), miss(), miss({ deletedAt: '2026-10-22T12:00:00.000Z' })])).toBe(1);
  });

  it('counts a lower rung of a tempo ladder that passed its own rule as a pass, not a miss', () => {
    const rung = sing('runs.03', {}, { bpm: getExercise(getLevel('runs.03')!.exerciseId)!.tempoLadder![0] });
    expect(rung.evaluation.passed).toBe(true);
    const climbed = attemptOf(rung);
    expect(climbed.passed).toBe(false); // the log never calls a lower rung a pass of the level
    const missed = attemptOf(sing('runs.03', { offsetSemis: 1 }));
    expect(missesInARow(rung.def.id, [missed, climbed])).toBe(0);
    expect(missesInARow(rung.def.id, [climbed, missed, missed])).toBe(2);
  });
});

describe('coachTake: help deepens with each miss in a row', () => {
  it('starts with the plain tip on a fresh miss', () => {
    expect(MISS.evaluation.passed).toBe(false);
    const c = coachAfter(MISS, 0);
    expect(c).toMatchObject({ depth: 1, missesInARow: 1, passed: false, tip: 'Plain tip.', why: null, steps: [], easier: null });
    expect(c.moves).toEqual([]);
    expect(c.problem.tipId).toBe(MISS.tip.id);
  });

  it('goes one step deeper with each miss: why at two, the steps at three, an easier way in from four', () => {
    const two = coachAfter(MISS, 1);
    expect(two).toMatchObject({ depth: 2, missesInARow: 2, why: 'Why it happens.', steps: [], easier: null });
    const three = coachAfter(MISS, 2);
    expect(three).toMatchObject({ depth: 3, missesInARow: 3, why: 'Why it happens.', steps: ['Step one.', 'Step two.', 'Step three.'], easier: null });
    for (const n of [3, 4, 7]) {
      const c = coachAfter(MISS, n);
      expect(c).toMatchObject({ depth: 4, missesInARow: n + 1, easier: 'An easier way in.' });
      expect(c.steps).toHaveLength(3);
    }
  });

  it('resets after a pass: the pass gets the polish tip and nothing else, and the next miss starts over', () => {
    expect(PASS.evaluation.passed).toBe(true);
    const passed = coachAfter(PASS, 6);
    expect(passed).toMatchObject({ depth: 1, missesInARow: 0, passed: true, why: null, steps: [], easier: null, tip: PASS.tip.text });
    expect(passed.moves.filter((m) => m.kind !== 'rest')).toEqual([]);
    const earlier = [attemptOf(MISS), attemptOf(MISS), attemptOf(PASS)];
    expect(coachAfter(MISS, 0, { earlier })).toMatchObject({ depth: 1, missesInARow: 1 });
  });

  it('falls back to the take’s own tip text when its ladder is not written yet', () => {
    fake.ladders = {};
    const c = coachAfter(MISS, 2);
    expect(c.tip).toBe(MISS.tip.text);
    expect(c.why).toBeNull();
    expect(c.steps).toEqual([]);
  });

  it('gives the general tips their content ladders, like every other tip', () => {
    const silent = sing('foundations.03', { silent: true });
    expect(silent.tip.id).toBe('general.no-voice');
    fake.ladders['general.no-voice'] = { ...ladder(), tip: 'No singing came through.' };
    const c = coachAfter(silent, 4);
    expect(c.depth).toBe(4);
    expect(c.tip).toBe('No singing came through.');
    expect(c.steps).toEqual(['Step one.', 'Step two.', 'Step three.']);
  });

  it('keeps the runner’s own line for a clean take: it knows what comes next (the next rung, every tally lit)', () => {
    fake.ladders[POLISH_TIP.id] = ladder();
    const line = 'Clean at this speed. The next take is a step faster, on the way to full speed, where the level counts.';
    const current = attemptOf(PASS);
    const c = coachFrom(
      { def: PASS.def, attempt: current, tip: { ...PASS.tip, id: POLISH_TIP.id, text: line }, passed: true, metrics: current.metrics, analysis: PASS.analysis, realized: PASS.realized },
      [current],
      { notation: 'sharps', isLevelPassed: () => false },
    );
    expect(c).toMatchObject({ passed: true, depth: 1, tip: line, why: null, steps: [], easier: null });
    expect(tipOnly({ ...PASS.tip, id: POLISH_TIP.id, text: line }, true).tip).toBe(line);
  });

  it('never coaches a miss as clean: one that measures clean read back was stopped early, and gets the stopped help', () => {
    fake.ladders[STOPPED_TIP.id] = { ...ladder(), tip: 'Sing to the end for it to count.' };
    const current = attemptOf(PASS, { passed: false });
    const c = coachFrom(
      { def: PASS.def, attempt: current, tip: { id: POLISH_TIP.id, text: POLISH_TIP.text, metric: null, value: null }, passed: false, metrics: current.metrics, analysis: PASS.analysis, realized: PASS.realized },
      [attemptOf(MISS), current],
      { notation: 'sharps', isLevelPassed: () => false },
    );
    expect(c.problem.tipId).toBe(STOPPED_TIP.id);
    expect(c).toMatchObject({ passed: false, depth: 2, tip: 'Sing to the end for it to count.', why: 'Why it happens.' });
    expect(tipOnly({ id: POLISH_TIP.id, text: POLISH_TIP.text, metric: null, value: null }, false).problem.tipId).toBe(STOPPED_TIP.id);
  });
});

describe('coachTake: the moves', () => {
  it('offers Send to Claude from depth 3 and a slow listen at depth 4', () => {
    expect(coachAfter(MISS, 1).moves.map((m) => m.kind)).toEqual([]);
    expect(coachAfter(MISS, 2).moves.map((m) => m.kind)).toEqual(['send-to-claude']);
    expect(coachAfter(MISS, 4).moves.map((m) => m.kind)).toEqual(['listen-slow', 'send-to-claude']);
  });

  it('offers to practise an earlier level only when the ladder names one and it is passed', () => {
    fake.ladders[MISS.tip.id] = ladder('foundations.02');
    const passedEarlier = [attemptOf(null, { exerciseId: 'foundations.range-finder.1', levelId: 'foundations.01', passed: true }), attemptOf(null, { exerciseId: 'foundations.pitch-match.1', levelId: 'foundations.02', passed: true })];
    const open = coachAfter(MISS, 4, { earlier: passedEarlier });
    expect(open.moves).toContainEqual({ kind: 'practise-level', levelId: 'foundations.02', title: 'Pitch match' });
    const notYet = coachAfter(MISS, 4);
    expect(notYet.moves.some((m) => m.kind === 'practise-level')).toBe(false);
    const tooSoon = coachAfter(MISS, 2, { earlier: passedEarlier });
    expect(tooSoon.moves.some((m) => m.kind === 'practise-level')).toBe(false);
    // Never the level being sung.
    fake.ladders[MISS.tip.id] = ladder('foundations.03');
    expect(coachAfter(MISS, 4, { earlier: passedEarlier }).moves.some((m) => m.kind === 'practise-level')).toBe(false);
  });

  it('offers only a level strictly earlier in the catalog, and never the Range finder (passing it saves the range again)', () => {
    const misses = [0, 1, 2, 3].map(() => attemptOf(MISS));
    const current = attemptOf(MISS);
    const src: CoachSource = { def: MISS.def, attempt: current, tip: MISS.tip, passed: false, metrics: current.metrics, analysis: MISS.analysis, realized: MISS.realized };
    const practise = (levelId: string) => {
      fake.ladders[MISS.tip.id] = ladder(levelId);
      const c = coachFrom(src, [...misses, current], { notation: 'sharps', isLevelPassed: () => true });
      expect(c.depth).toBe(4);
      return c.moves.find((m) => m.kind === 'practise-level');
    };
    expect(MISS.level.id).toBe('foundations.03');
    expect(practise('foundations.02')).toEqual({ kind: 'practise-level', levelId: 'foundations.02', title: 'Pitch match' });
    // A tip shared by several levels names one practise level: on an earlier level than it, it is not offered.
    expect(practise('foundations.05')).toBeUndefined();
    expect(practise('vibrato.03')).toBeUndefined();
    expect(practise('foundations.01')).toBeUndefined();
  });

  it('leans on the latest voice check-up: a level that trains one of its focus skills is offered from the second miss', () => {
    fake.ladders[MISS.tip.id] = ladder('foundations.02');
    const practises = (c: ReturnType<typeof coachAfter>): boolean => c.moves.some((m) => m.kind === 'practise-level');
    const passedEarlier = [attemptOf(null, { exerciseId: 'foundations.range-finder.1', levelId: 'foundations.01', passed: true }), attemptOf(null, { exerciseId: 'foundations.pitch-match.1', levelId: 'foundations.02', passed: true })];
    const pitch = checkupWithFocus(1); // match and hold sung poorly
    expect(latestCheckupFocus(pitch)).toEqual(['pitch', 'steadiness']);

    expect(practises(coachAfter(MISS, 0, { earlier: [...passedEarlier, ...pitch] }))).toBe(false); // the first miss: the tip alone
    const second = coachAfter(MISS, 1, { earlier: [...passedEarlier, ...pitch] });
    expect(second.depth).toBe(FOCUS_PRACTISE_DEPTH);
    expect(second.moves).toEqual([{ kind: 'practise-level', levelId: 'foundations.02', title: 'Pitch match' }]);
    expect(coachAfter(MISS, 2, { earlier: [...passedEarlier, ...pitch] }).moves.map((m) => m.kind)).toEqual(['practise-level', 'send-to-claude']);

    // A check-up that found another focus leaves the usual fourth miss; so does none at all.
    const slides = checkupWithFocus(2);
    expect(latestCheckupFocus(slides)).toEqual(['slides']);
    expect(practises(coachAfter(MISS, 1, { earlier: [...passedEarlier, ...slides] }))).toBe(false);
    expect(practises(coachAfter(MISS, 1, { earlier: passedEarlier }))).toBe(false);
    // The same gates: a focus level not passed yet is never offered.
    expect(practises(coachAfter(MISS, 3, { earlier: pitch }))).toBe(false);
    // A pass gets no moves, focus or not.
    expect(coachAfter(PASS, 1, { earlier: [...passedEarlier, ...pitch] }).moves.filter((m) => m.kind !== 'rest')).toEqual([]);
  });

  it('asks for a rest after many takes in a short time, or a long run of misses', () => {
    const quick = coachAfter(PASS, REST_TAKES - 1, { gapMs: 60_000 });
    expect(quick.moves).toContainEqual({ kind: 'rest' });
    const spread = coachAfter(PASS, REST_TAKES - 1, { gapMs: 4 * 60_000 });
    expect(spread.moves).not.toContainEqual({ kind: 'rest' });
    const missing = coachAfter(MISS, REST_MISSES - 1, { gapMs: 10 * 60_000 });
    expect(missing.missesInARow).toBe(REST_MISSES);
    expect(missing.moves).toContainEqual({ kind: 'rest' });
    expect(coachAfter(MISS, REST_MISSES - 2, { gapMs: 10 * 60_000 }).moves).not.toContainEqual({ kind: 'rest' });
  });
});

describe('coachTake: since last time', () => {
  it('compares the problem’s measure with the previous take of the exercise', () => {
    const first = coachAfter(MISS, 0);
    expect(first.progress).toEqual([]);
    const better = sing('foundations.03', { offsetSemis: 0, biasCents: 30 });
    const c = coachAfter(better, 1);
    expect(c.progress.length).toBeGreaterThan(0);
    const line = c.progress[0];
    expect(line.before).not.toBe(line.now);
    expect(line.better).toBe(true);
  });

  it('reads the same lines from progressLines', () => {
    const prev = attemptOf(MISS);
    const cur = attemptOf(PASS);
    const lines = progressLines(PASS.def, prev, cur, { tipId: 'acc.flat', metric: 'accuracy.absBiasCents', what: '', spots: [] });
    expect(lines[0]).toMatchObject({ label: 'Off the middle by', better: true });
    expect(progressLines(PASS.def, null, cur, { tipId: 'acc.flat', metric: 'accuracy.absBiasCents', what: '', spots: [] })).toEqual([]);
  });
});

describe('tipOnly', () => {
  it('is the take’s own tip at depth 1 with nothing placed: what a screen falls back to', () => {
    const c = tipOnly(MISS.tip, false);
    expect(c).toMatchObject({ depth: 1, missesInARow: 1, passed: false, tip: 'Plain tip.', why: null, steps: [], easier: null, progress: [], moves: [] });
    expect(c.problem).toEqual({ tipId: MISS.tip.id, metric: MISS.tip.metric, what: '', spots: [] });
    fake.ladders = {};
    expect(tipOnly(PASS.tip, true)).toMatchObject({ passed: true, missesInARow: 0, tip: PASS.tip.text });
  });
});

describe('coachFrom: a saved take read back', () => {
  it('coaches from the attempt’s metrics alone when the pitch line was not saved', () => {
    const current = attemptOf(MISS);
    const c = coachFrom(
      { def: MISS.def, attempt: current, tip: MISS.tip, passed: false, metrics: current.metrics, analysis: null, realized: MISS.realized },
      [attemptOf(MISS), current],
      { notation: 'sharps', isLevelPassed: () => false },
    );
    expect(c.depth).toBe(2);
    expect(c.problem.spots).toEqual([]);
    expect(c.problem.what.length).toBeGreaterThan(0);
  });
});
