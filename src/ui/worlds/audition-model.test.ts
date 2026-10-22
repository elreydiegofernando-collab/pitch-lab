import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WORLDS, getWorld } from '../../exercises';
import type { UnlockEvent } from '../../runtime/types';

const flow = vi.hoisted(() => ({ events: [] as UnlockEvent[] }));
vi.mock('../../runtime/flow', () => ({ unlockEvents: () => flow.events }));

import {
  auditionRun,
  beginAuditionRun,
  buildTests,
  claimResults,
  eventLabel,
  openedBetween,
  placementOf,
  reachLabel,
  rememberIntro,
  resetAuditionStateForTests,
  startLabel,
  testsLeft,
} from './audition-model';
import { attempt, fakeOutcome, passAudition, snapshotOf } from './test-support';

const foundations = getWorld('foundations')!;
const vibrato = getWorld('vibrato')!;
/** The singer the runs in these tests belong to. */
const ME = 'profile-1';

beforeEach(() => {
  resetAuditionStateForTests();
  flow.events = [];
});

describe('buildTests', () => {
  it('lists the tests in sung order, the first one next, with what each can open and no Range finder', () => {
    const tests = buildTests(foundations, snapshotOf('foundations.01'), WORLDS);
    expect(tests.map((t) => [t.n, t.exerciseId, t.state, t.caption])).toEqual([
      [1, 'foundations.audition.1', 'next', 'Pitch match – Sustain II'],
      [2, 'foundations.audition.2', 'ahead', 'Sirens & glides'],
      [3, 'foundations.audition.3', 'ahead', 'Crispness – Interval jumps II'],
      [4, 'foundations.audition.4', 'ahead', 'Legato lines'],
    ]);
    expect(tests.map((t) => t.title)).toEqual(['Match and hold', 'Siren', 'Crisp leaps', 'Legato line']);
    expect(tests[0].unlocks?.first.id).toBe('foundations.02');
    expect(tests[0].unlocks?.last.id).toBe('foundations.04');
  });

  it('has no next test before the Range finder is sung, but still describes what the tests will open', () => {
    const tests = buildTests(foundations, snapshotOf(null), WORLDS);
    expect(tests.map((t) => t.state)).toEqual(['ahead', 'ahead', 'ahead', 'ahead']);
    expect(tests[0].caption).toBe('Pitch match – Sustain II');
  });

  it('marks passed tests and moves next along as audition tests are passed', () => {
    const snap = snapshotOf('foundations.01', [passAudition('foundations', 1), passAudition('foundations', 2)]);
    const tests = buildTests(foundations, snap, WORLDS);
    expect(tests.map((t) => t.state)).toEqual(['passed', 'passed', 'next', 'ahead']);
    expect(tests[0].caption).toBeNull();
    expect(tests[0].unlocks).toBeNull();
    expect(testsLeft(tests)).toBe(2);
  });

  it('counts a test as passed once its levels are passed by playing, too', () => {
    const tests = buildTests(foundations, snapshotOf('foundations.05'), WORLDS);
    expect(tests.map((t) => t.state)).toEqual(['passed', 'passed', 'next', 'ahead']);
  });

  it('reports nothing left when every level the tests cover is passed', () => {
    const tests = buildTests(foundations, snapshotOf('foundations.09'), WORLDS);
    expect(tests.every((t) => t.state === 'passed')).toBe(true);
    expect(testsLeft(tests)).toBe(0);
    expect(reachLabel(tests)).toBeNull();
  });

  it('is empty for a world without an audition', () => {
    expect(buildTests(getWorld('song-stage')!, snapshotOf(null), WORLDS)).toEqual([]);
  });

  it('describes the Vibrato audition from its own world', () => {
    const tests = buildTests(vibrato, snapshotOf('foundations.boss'), WORLDS);
    expect(tests.map((t) => t.state)).toEqual(['next', ...Array(tests.length - 1).fill('ahead')]);
    expect(tests[0].caption).toMatch(/^Oscillation I/);
  });
});

describe('reachLabel', () => {
  it('spans from the first level the next test can open to the last level of the last test', () => {
    expect(reachLabel(buildTests(foundations, snapshotOf('foundations.01'), WORLDS))).toBe('Pitch match – Legato lines');
    expect(reachLabel(buildTests(foundations, snapshotOf('foundations.05'), WORLDS))).toBe('Crispness – Legato lines');
  });
});

describe('startLabel', () => {
  const tests = buildTests(foundations, snapshotOf('foundations.01'), WORLDS);

  it('says Start for a test that was never sung', () => {
    expect(startLabel(tests, [])).toBe('Start test 1');
  });

  it('says Retake for a test that was sung and missed', () => {
    const missed = attempt({ kind: 'audition', exerciseId: 'foundations.audition.1', levelId: null, passed: false });
    expect(startLabel(tests, [missed])).toBe('Retake test 1');
  });

  it('ignores deleted attempts and other tests', () => {
    const deleted = attempt({ kind: 'audition', exerciseId: 'foundations.audition.1', levelId: null, passed: false, deletedAt: '2026-10-22T00:00:00.000Z' });
    const other = attempt({ kind: 'audition', exerciseId: 'foundations.audition.2', levelId: null, passed: false });
    expect(startLabel(tests, [deleted, other])).toBe('Start test 1');
  });

  it('is null when there is no test to sing', () => {
    expect(startLabel(buildTests(foundations, snapshotOf('foundations.09'), WORLDS), [])).toBeNull();
    expect(startLabel(buildTests(foundations, snapshotOf(null), WORLDS), [])).toBeNull();
  });
});

describe('placementOf', () => {
  it('is the level in progress, with its place in the world', () => {
    const p = placementOf(foundations, snapshotOf('foundations.04'), WORLDS);
    expect(p?.level.id).toBe('foundations.05');
    expect([p?.number, p?.total]).toEqual([5, 10]);
  });

  it('can be the Boss Recital', () => {
    expect(placementOf(foundations, snapshotOf('foundations.09'), WORLDS)?.level.kind).toBe('boss');
  });

  it('is null once the whole world is passed', () => {
    expect(placementOf(foundations, snapshotOf('foundations.boss'), WORLDS)).toBeNull();
  });
});

describe('openedBetween', () => {
  const before = snapshotOf('foundations.01');
  const after = snapshotOf('foundations.01', [passAudition('foundations', 1)]);

  it('lists the levels the run passed, in catalog order, from the snapshot before it', () => {
    expect(openedBetween(before, after, foundations, WORLDS).levels.map((l) => l.id)).toEqual(['foundations.02', 'foundations.03', 'foundations.04']);
  });

  it('lists nothing when nothing changed', () => {
    expect(openedBetween(after, after, foundations, WORLDS)).toEqual({ levels: [], events: [] });
  });

  it('keeps worlds, features and songs from the unlock events, and drops the rest', () => {
    flow.events = [
      { kind: 'level-passed', levelId: 'foundations.02', title: 'Pitch match', mastery: 1 },
      { kind: 'level-opened', levelId: 'foundations.05', title: 'Sirens & glides' },
      { kind: 'feature', featureId: 'live.cracks', title: 'Crack markers on the Live trace' },
      { kind: 'world-opened', worldId: 'vibrato', title: 'Vibrato' },
      { kind: 'songs', requiredWorld: 'foundations', count: 3 },
      { kind: 'mastery', levelId: 'foundations.02', title: 'Pitch match', mastery: 2 },
    ];
    const { events } = openedBetween(before, after, foundations, WORLDS);
    expect(events.map((e) => e.kind)).toEqual(['feature', 'world-opened', 'songs']);
  });
});

describe('eventLabel', () => {
  it('writes one line per kind of event it keeps', () => {
    expect(eventLabel({ kind: 'feature', featureId: 'live.cracks', title: 'Crack markers on the Live trace' })).toBe('Crack markers on the Live trace');
    expect(eventLabel({ kind: 'world-opened', worldId: 'vibrato', title: 'Vibrato' })).toBe('Vibrato world');
    expect(eventLabel({ kind: 'songs', requiredWorld: 'foundations', count: 3 })).toBe('3 songs in Song Stage');
    expect(eventLabel({ kind: 'songs', requiredWorld: 'foundations', count: 1 })).toBe('1 song in Song Stage');
  });

  it('has no line for the kinds the results do not list', () => {
    expect(eventLabel({ kind: 'level-opened', levelId: 'foundations.02', title: 'Pitch match' })).toBeNull();
  });
});

describe('beginAuditionRun', () => {
  const before = snapshotOf('foundations.01');
  const testIds = foundations.audition!.exerciseIds;

  it('records the snapshot from before the run', () => {
    beginAuditionRun({ worldId: 'foundations', profileId: ME,before, attempts: [], testIds, now: 1000 });
    expect(auditionRun.value).toEqual({ worldId: 'foundations', profileId: ME, before, since: 1000 });
  });

  it('keeps the baseline of a run that was left unfinished while only audition tests were sung', () => {
    beginAuditionRun({ worldId: 'foundations', profileId: ME,before, attempts: [], testIds, now: Date.parse('2026-10-22T12:00:00Z') });
    const later = snapshotOf('foundations.01', [passAudition('foundations', 1)]);
    const sung = [attempt({ kind: 'audition', exerciseId: 'foundations.audition.1', levelId: null, createdAt: '2026-10-22T12:05:00.000Z' })];
    beginAuditionRun({ worldId: 'foundations', profileId: ME,before: later, attempts: sung, testIds, now: Date.parse('2026-10-22T12:10:00Z') });
    expect(auditionRun.value?.before).toBe(before);
    expect(auditionRun.value?.since).toBe(Date.parse('2026-10-22T12:00:00Z'));
  });

  it('starts over once the singer has done anything else since', () => {
    beginAuditionRun({ worldId: 'foundations', profileId: ME,before, attempts: [], testIds, now: Date.parse('2026-10-22T12:00:00Z') });
    const later = snapshotOf('foundations.02');
    const played = [attempt({ kind: 'practice', levelId: 'foundations.02', createdAt: '2026-10-22T12:05:00.000Z' })];
    beginAuditionRun({ worldId: 'foundations', profileId: ME,before: later, attempts: played, testIds, now: Date.parse('2026-10-22T12:10:00Z') });
    expect(auditionRun.value?.before).toBe(later);
  });

  it('ignores attempts from before the run and deleted ones', () => {
    beginAuditionRun({ worldId: 'foundations', profileId: ME,before, attempts: [], testIds, now: Date.parse('2026-10-22T12:00:00Z') });
    const old = attempt({ kind: 'practice', levelId: 'foundations.01', createdAt: '2026-10-22T11:00:00.000Z' });
    const gone = attempt({ kind: 'practice', levelId: 'foundations.02', createdAt: '2026-10-22T12:05:00.000Z', deletedAt: '2026-10-22T12:06:00.000Z' });
    beginAuditionRun({ worldId: 'foundations', profileId: ME,before: snapshotOf(null), attempts: [old, gone], testIds, now: Date.parse('2026-10-22T12:10:00Z') });
    expect(auditionRun.value?.before).toBe(before);
  });

  it("never carries a baseline over from another world's run", () => {
    beginAuditionRun({ worldId: 'foundations', profileId: ME,before, attempts: [], testIds, now: 1 });
    const other = snapshotOf('foundations.boss');
    beginAuditionRun({ worldId: 'vibrato', profileId: ME,before: other, attempts: [], testIds: vibrato.audition!.exerciseIds, now: 2 });
    expect(auditionRun.value).toEqual({ worldId: 'vibrato', profileId: ME, before: other, since: 2 });
  });

  it("never keeps another singer's unfinished run: a profile switch starts a fresh baseline", () => {
    // Singer A starts the Foundations audition and leaves mid-run.
    const theirs = snapshotOf('foundations.01');
    beginAuditionRun({ worldId: 'foundations', profileId: 'singer-a', before: theirs, attempts: [], testIds, now: Date.parse('2026-10-22T12:00:00Z') });
    // Singer B (who passed 01-04 long ago, nothing sung since A's start) taps Start on the same audition.
    const mine = snapshotOf('foundations.04');
    beginAuditionRun({ worldId: 'foundations', profileId: ME, before: mine, attempts: [], testIds, now: Date.parse('2026-10-22T12:10:00Z') });
    expect(auditionRun.value).toEqual({ worldId: 'foundations', profileId: ME, before: mine, since: Date.parse('2026-10-22T12:10:00Z') });
  });
});

describe('claimResults', () => {
  const miss = (id = 't1') =>
    fakeOutcome({ id, target: { kind: 'audition', worldId: 'foundations' }, passed: false, exerciseId: 'foundations.audition.2' });
  const passedOne = (id = 'p1') =>
    fakeOutcome({ id, target: { kind: 'audition', worldId: 'foundations' }, passed: true, exerciseId: 'foundations.audition.1' });
  /** A route entry: the intro's own, or a new one that `replace` put on the stack. */
  const entry = (): object => ({});

  it('hands out the results of a take opened on a new route entry, with the snapshot from before the run, and ends the run', () => {
    const before = snapshotOf('foundations.01');
    beginAuditionRun({ worldId: 'foundations', profileId: ME,before, attempts: [], testIds: foundations.audition!.exerciseIds });
    const claimed = claimResults({ worldId: 'foundations', profileId: ME, outcome: miss(), entry: entry() });
    expect(claimed?.outcome.id).toBe('t1');
    expect(claimed?.before).toBe(before);
    expect(auditionRun.value).toBeNull();
  });

  it('hands them out once per take only', () => {
    expect(claimResults({ worldId: 'foundations', profileId: ME, outcome: miss('same'), entry: entry() })).not.toBeNull();
    expect(claimResults({ worldId: 'foundations', profileId: ME, outcome: miss('same'), entry: entry() })).toBeNull();
    expect(claimResults({ worldId: 'foundations', profileId: ME, outcome: miss('another'), entry: entry() })).not.toBeNull();
  });

  it("offers no baseline from another singer's run (the results never credit them with someone else's levels)", () => {
    beginAuditionRun({ worldId: 'foundations', profileId: 'singer-a', before: snapshotOf('foundations.01'), attempts: [], testIds: foundations.audition!.exerciseIds });
    const claimed = claimResults({ worldId: 'foundations', profileId: ME, outcome: miss('b-take'), entry: entry() });
    expect(claimed?.outcome.id).toBe('b-take');
    expect(claimed?.before).toBeNull();
    expect(auditionRun.value).toBeNull();
  });

  it('has no baseline to offer when the run start was not recorded', () => {
    expect(claimResults({ worldId: 'foundations', profileId: ME, outcome: miss(), entry: entry() })?.before).toBeNull();
  });

  it('gives the results of a passed test too: the report offers "See your placement" to stop early, and after the last test', () => {
    expect(claimResults({ worldId: 'foundations', profileId: ME, outcome: passedOne(), entry: entry() })?.outcome.id).toBe('p1');
  });

  it("shows the intro again when Back from the report returns to the intro's own entry, and keeps the run open", () => {
    const before = snapshotOf('foundations.01');
    beginAuditionRun({ worldId: 'foundations', profileId: ME,before, attempts: [], testIds: foundations.audition!.exerciseIds });
    const intro = entry();
    rememberIntro(intro);
    expect(claimResults({ worldId: 'foundations', profileId: ME, outcome: passedOne(), entry: intro })).toBeNull();
    // The take counts as seen, and the run goes on: the next Start keeps its baseline.
    expect(claimResults({ worldId: 'foundations', profileId: ME, outcome: passedOne(), entry: entry() })).toBeNull();
    expect(auditionRun.value?.before).toBe(before);
  });

  it('remembers only the latest intro entry', () => {
    const first = entry();
    const second = entry();
    rememberIntro(first);
    rememberIntro(second);
    expect(claimResults({ worldId: 'foundations', profileId: ME, outcome: miss('x'), entry: first })).not.toBeNull();
  });

  it('ignores takes that are not an audition of this world', () => {
    expect(claimResults({ worldId: 'foundations', profileId: ME, outcome: null, entry: entry() })).toBeNull();
    expect(claimResults({ worldId: 'foundations', profileId: ME, outcome: fakeOutcome({ id: 'lvl', passed: false }), entry: entry() })).toBeNull();
    expect(claimResults({ worldId: 'vibrato', profileId: ME, outcome: miss('wrong-world'), entry: entry() })).toBeNull();
    // A take of another world is not used up: its own world can still claim it.
    expect(claimResults({ worldId: 'foundations', profileId: ME, outcome: miss('wrong-world'), entry: entry() })).not.toBeNull();
  });
});
