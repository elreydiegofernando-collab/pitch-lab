/**
 * The Foundations rebuild (2026-10-23) against the real catalog: what a singer earned before it stays earned, and only
 * that. A level that still teaches what it did keeps its passes; Hold it steady is new (it judges a wobble, which Sustain
 * II, the old foundations.04, never did), so it is earned now; a pass of a former placement test keeps what it granted,
 * judged by the audition it was sung under (review R2, R3: a check-up sung in the old order must not grant on recompute
 * what it never granted).
 */
import { describe, expect, it } from 'vitest';
import { WORLDS, getExercise } from '../exercises/catalog';
import type { AttemptRecord } from '../storage/schema';
import { computeSnapshot } from './engine';
import { P1, attempt, fail, pass } from './test-fixtures';
import type { ProgressSnapshot } from './types';
import { continueLevel } from './unlocks';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const snap = (log: AttemptRecord[]): ProgressSnapshot => computeSnapshot(P1, WORLDS, log, NOW, { getExercise });
const status = (s: ProgressSnapshot, id: string) => ({ status: s.levels[id]?.status, viaAudition: s.levels[id]?.viaAudition });

/** A take of a level as it was sung before the rebuild: the level's id then, and the exercise it played then (retired now). */
const OLD: Record<string, string> = {
  'foundations.01': 'foundations.range-finder.1',
  'foundations.02': 'foundations.pitch-match.1',
  'foundations.03': 'foundations.sustain.1',
  'foundations.04': 'foundations.sustain.2',
  'foundations.05': 'foundations.siren.1',
};
/** `row` as a take of the voice check-up `checkupId` (the fixtures' attempt() keeps only the common fields). */
const inCheckup = (row: AttemptRecord, checkupId?: string): AttemptRecord => (checkupId ? { ...row, checkupId } : row);
const oldPass = (levelId: string, checkupId?: string) => inCheckup(pass(levelId, { exerciseId: OLD[levelId] }), checkupId);
const oldFail = (levelId: string) => fail(levelId, { exerciseId: OLD[levelId] });
/** A take of a former placement test (`n`: its number then, foundations.audition.1 to .4). */
const oldTest = (n: number, passed: boolean, checkupId?: string) =>
  inCheckup(attempt({ kind: 'audition', levelId: null, exerciseId: `foundations.audition.${n}`, passed }), checkupId);

describe('a singer who passed the old Foundations levels directly', () => {
  it('keeps every level that still teaches what it did, and starts at Hold it steady: Sustain II never judged a wobble', () => {
    const s = snap([oldPass('foundations.01'), oldPass('foundations.02'), oldPass('foundations.03'), oldPass('foundations.04'), oldFail('foundations.05'), oldFail('foundations.05')]);
    for (const id of ['foundations.01', 'foundations.02', 'foundations.03']) expect(status(s, id), id).toEqual({ status: 'passed', viaAudition: false });
    expect(s.levels['foundations.13'].status).toBe('current');
    expect(continueLevel(s, WORLDS)?.title).toBe('Hold it steady');
    expect(s.levels['foundations.04']).toBeUndefined();
    // The level's own attempts on it are its own: the old Sustain II takes are not attempts of Hold it steady.
    expect(s.levels['foundations.13'].attempts).toBe(0);
  });

  it('keeps a later pass waiting for Hold it steady, as any pass recorded further along does', () => {
    const log = [oldPass('foundations.01'), oldPass('foundations.02'), oldPass('foundations.03'), oldPass('foundations.04'), oldPass('foundations.05')];
    expect(snap(log).levels['foundations.05'].status).toBe('locked');
    // Hold it steady passed now: the steps lesson (new) is next; the old Sirens pass still waits for the levels before it.
    const after = snap([...log, pass('foundations.13', { exerciseId: 'foundations.steady.1' })]);
    expect(after.levels['foundations.13'].status).toBe('passed');
    expect(after.levels['foundations.10'].status).toBe('current');
    expect(after.levels['foundations.05'].status).toBe('locked');
  });
});

describe('a pass of the old placement audition keeps what it granted, and only the levels that still teach the same', () => {
  it('the first old test granted Pitch match to Sustain II: Match one note and Hold it stay granted, Hold it steady is earned now', () => {
    const s = snap([oldPass('foundations.01'), oldTest(1, true)]);
    expect(status(s, 'foundations.02')).toEqual({ status: 'passed', viaAudition: true });
    expect(status(s, 'foundations.03')).toEqual({ status: 'passed', viaAudition: true });
    expect(s.levels['foundations.13'].status).toBe('current');
  });

  it('the whole old audition keeps each kept level, in the order the lessons go: the new lessons are earned on the way', () => {
    const all = [oldPass('foundations.01'), oldTest(1, true), oldTest(2, true), oldTest(3, true), oldTest(4, true)];
    const s = snap(all);
    expect(s.levels['foundations.13'].status).toBe('current');
    // Past Hold it steady: the steps lesson is new, so it is current; the jump lessons the old crisp leaps vouched for follow.
    const steady = snap([...all, pass('foundations.13', { exerciseId: 'foundations.steady.1' })]);
    expect(steady.levels['foundations.10'].status).toBe('current');
    const steps = snap([...all, pass('foundations.13', { exerciseId: 'foundations.steady.1' }), pass('foundations.10', { exerciseId: 'foundations.steps.1' })]);
    expect(status(steps, 'foundations.07')).toEqual({ status: 'passed', viaAudition: true });
    expect(status(steps, 'foundations.08')).toEqual({ status: 'passed', viaAudition: true });
    expect(steps.levels['foundations.11'].status).toBe('current'); // do-re-mi: new
    // Clean starts (the old Crispness, vouched for by the crisp leaps) is kept; small slides is new.
    expect(steps.levels['foundations.06'].status).toBe('locked');
  });

  it('never grants the Range finder, a level the old tests never reached, or anything before the Range finder was sung', () => {
    const s = snap([oldTest(1, true), oldTest(2, true)]);
    expect(s.levels['foundations.01'].status).toBe('current');
    for (const id of ['foundations.12', 'foundations.11', 'foundations.10']) expect(s.levels[id].status, id).toBe('locked');
  });
});

describe('a voice check-up sung before the rebuild is judged in the order it was sung (review R3)', () => {
  /** The check-up as it was sung then: the Range finder, then the four tests in the old order (match and hold, siren, crisp leaps, legato). */
  const oldCheckup = (passes: [boolean, boolean, boolean, boolean], id = 'c-old'): AttemptRecord[] => [
    oldPass('foundations.01', id),
    ...passes.map((p, i) => oldTest(i + 1, p, id)),
  ];

  it('a siren missed then stopped the grants there: the later tests were out of order and grant nothing, then or now', () => {
    const s = snap(oldCheckup([true, false, true, true]));
    expect(status(s, 'foundations.02')).toEqual({ status: 'passed', viaAudition: true });
    expect(status(s, 'foundations.03')).toEqual({ status: 'passed', viaAudition: true });
    expect(s.levels['foundations.13'].status).toBe('current');
    for (const id of ['foundations.10', 'foundations.07', 'foundations.08', 'foundations.11', 'foundations.09']) expect(s.levels[id].status, id).toBe('locked');
    // Not even once the levels before them are passed: what was out of order when sung stays out of order.
    const later = snap([...oldCheckup([true, false, true, true]), pass('foundations.13', { exerciseId: 'foundations.steady.1' }), pass('foundations.10', { exerciseId: 'foundations.steps.1' })]);
    expect(later.levels['foundations.07'].status).toBe('current');
  });

  it('the review\'s case: direct passes of 01-04 and that check-up start the singer at Hold it steady, not at Small slides', () => {
    const s = snap([oldPass('foundations.01'), oldPass('foundations.02'), oldPass('foundations.03'), oldPass('foundations.04'), ...oldCheckup([true, false, true, true])]);
    expect(continueLevel(s, WORLDS)?.id).toBe('foundations.13');
    expect(s.levels['foundations.12'].status).toBe('locked');
  });

  it('a check-up that passed in order then still grants what it granted (the siren, the crisp leaps), kept levels only', () => {
    const s = snap([...oldCheckup([true, true, true, false]), pass('foundations.13', { exerciseId: 'foundations.steady.1' }), pass('foundations.10', { exerciseId: 'foundations.steps.1' })]);
    expect(status(s, 'foundations.07')).toEqual({ status: 'passed', viaAudition: true });
    expect(status(s, 'foundations.08')).toEqual({ status: 'passed', viaAudition: true });
    expect(s.levels['foundations.11'].status).toBe('current');
  });

  it('a check-up sung today uses today\'s order: the first test grants through Hold it steady, judged on a wobble', () => {
    const today = 'c-new';
    const log = [
      inCheckup(attempt({ kind: 'practice', levelId: 'foundations.01', exerciseId: 'foundations.range.1', passed: true }), today),
      inCheckup(attempt({ kind: 'audition', levelId: null, exerciseId: 'foundations.audition.5', passed: true }), today),
      inCheckup(attempt({ kind: 'audition', levelId: null, exerciseId: 'foundations.audition.6', passed: false }), today),
      inCheckup(attempt({ kind: 'audition', levelId: null, exerciseId: 'foundations.audition.7', passed: true }), today),
    ];
    const s = snap(log);
    expect(status(s, 'foundations.13')).toEqual({ status: 'passed', viaAudition: true });
    expect(s.levels['foundations.10'].status).toBe('current');
    expect(s.levels['foundations.11'].status).toBe('locked'); // the connected line came after a miss: out of order
  });
});
