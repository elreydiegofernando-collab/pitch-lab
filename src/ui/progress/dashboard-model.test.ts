import { describe, expect, it } from 'vitest';
import { WORLDS } from '../../exercises';
import { dayIndexOf } from '../../progress';
import {
  buildDashboard,
  completionText,
  momentumView,
  nextLockedWorld,
  personalBests,
  practiceWeeks,
  rangeSpans,
  worldCompletion,
} from './dashboard-model';
import { attemptAt, levelsInOrder, localOffsetMinutes, passWorld, snapshotOf } from './test-fixtures';

const OFFSET = localOffsetMinutes();
const NOW = Date.now();
const TODAY = dayIndexOf(NOW, OFFSET);

describe('momentumView', () => {
  it('is empty before any practice: zero, thirty empty slots, no weekly change', () => {
    const view = momentumView([], NOW, OFFSET);
    expect(view.value).toBe(0);
    expect(view.slots).toHaveLength(30);
    expect(view.slots.every((s) => s === null)).toBe(true);
    expect(view.deltaWeek).toBeNull();
  });

  it('fills the newest slots, leaves the older ones empty, and marks a rest day as zero minutes', () => {
    const attempts = [
      attemptAt('foundations.01', { daysAgo: 4, durationSec: 600 }),
      attemptAt('foundations.01', { daysAgo: 2, durationSec: 600 }),
      attemptAt('foundations.01', { daysAgo: 0, durationSec: 600 }),
    ];
    const view = momentumView(attempts, NOW, OFFSET);
    expect(view.slots.filter((s) => s !== null)).toHaveLength(5);
    expect(view.slots.slice(0, 25).every((s) => s === null)).toBe(true);
    const days = view.slots.slice(25);
    expect(days.map((d) => (d && d.minutes > 0 ? 'sung' : 'rest'))).toEqual(['sung', 'rest', 'sung', 'rest', 'sung']);
    // Rest days keep momentum: it never reads zero once practice has begun.
    expect(days.every((d) => d !== null && d.momentum > 0)).toBe(true);
    expect(view.value).toBeCloseTo(days[4]!.momentum, 6);
    expect(view.deltaWeek).toBeNull();
  });

  it('reports the change since a week ago once there is a week of history', () => {
    const attempts = Array.from({ length: 10 }, (_, i) => attemptAt('foundations.01', { daysAgo: 9 - i, durationSec: 900 }));
    const view = momentumView(attempts, NOW, OFFSET);
    expect(view.deltaWeek).not.toBeNull();
    expect(view.deltaWeek!).toBeGreaterThan(0);
  });
});

describe('level map completion', () => {
  it('counts passed levels and names what is next, for open worlds only', () => {
    const snapshot = snapshotOf(passWorld('foundations', 'foundations.13'));
    const rows = worldCompletion(snapshot, WORLDS);
    expect(rows.map((r) => r.world.id)).toEqual(['foundations']);
    expect(rows[0].passed).toBe(4);
    expect(rows[0].total).toBe(13);
    expect(rows[0].next?.id).toBe('foundations.10');
    expect(completionText(rows[0])).toBe('4 of 13 levels · Next: Two notes, one step apart');
  });

  it('says the Boss Recital is next when it is', () => {
    const order = levelsInOrder('foundations');
    const snapshot = snapshotOf(passWorld('foundations', order[order.length - 2].id));
    expect(completionText(worldCompletion(snapshot, WORLDS)[0])).toBe('12 of 13 levels · Boss Recital next');
  });

  it('opens Vibrato (and still lists Foundations) once the Foundations boss is passed, and says what is still shut', () => {
    const snapshot = snapshotOf(passWorld('foundations'));
    const rows = worldCompletion(snapshot, WORLDS);
    expect(rows.map((r) => r.world.id)).toEqual(['foundations', 'vibrato']);
    expect(completionText(rows[0])).toBe('13 of 13 levels · Complete');
    expect(rows[1].passed).toBe(0);
    expect(nextLockedWorld(snapshot, WORLDS)?.id).toBe('inflections');
  });

  it('has no locked world to show once everything is open', () => {
    expect(nextLockedWorld(snapshotOf([]), WORLDS)?.id).toBe('vibrato');
  });
});

describe('rangeSpans', () => {
  it('keeps the widest span of each day, oldest first, and ignores takes with no span', () => {
    const attempts = [
      attemptAt('foundations.01', { daysAgo: 5, metrics: { 'range.spanSemitones': 14 } }),
      attemptAt('foundations.01', { daysAgo: 5, metrics: { 'range.spanSemitones': 16 } }),
      attemptAt('foundations.01', { daysAgo: 1, metrics: { 'range.spanSemitones': 19 } }),
      attemptAt('foundations.02', { daysAgo: 1, metrics: { 'accuracy.inTolerancePct': 80 } }),
    ];
    const points = rangeSpans(attempts, OFFSET);
    expect(points.map((p) => [p.dayIndex, p.span])).toEqual([
      [TODAY - 5, 16],
      [TODAY - 1, 19],
    ]);
  });
});

describe('personalBests', () => {
  it('lists a passed level\'s records with the metric names the singer reads, most recent first', () => {
    const attempts = [
      attemptAt('foundations.01', { daysAgo: 3, metrics: { 'range.spanSemitones': 17 } }),
      attemptAt('foundations.02', { daysAgo: 1, metrics: { 'accuracy.inTolerancePct': 92, 'accuracy.medianAbsCents': 8, 'onset.settleMs': 210 } }),
    ];
    const rows = personalBests(snapshotOf(attempts), WORLDS);
    // The Range finder's span is a measurement, never a personal best (pushing it means straining).
    expect(rows.map((r) => r.level.id)).toEqual(['foundations.02']);
    const pitchMatch = rows[0];
    expect(pitchMatch.level.title).toBe('Match one note');
    expect(pitchMatch.metrics.map((m) => `${m.label} ${m.text}`)).toEqual(expect.arrayContaining(['In tune 92%', 'Typical miss 8¢', 'Time to find the note 210 ms']));
    expect(pitchMatch.bestScore).toBeGreaterThan(0);
  });

  it('has none before anything is passed (a miss sets no record)', () => {
    const missed = [attemptAt('foundations.01', { passed: false, metrics: { 'range.spanSemitones': 30 } })];
    expect(personalBests(snapshotOf(missed), WORLDS)).toEqual([]);
  });
});

describe('practiceWeeks', () => {
  it('compares the last 7 days with the 7 before, rolling, and reports rest days as zero', () => {
    const attempts = [
      attemptAt('foundations.01', { daysAgo: 0, durationSec: 600 }), //   10 min this week
      attemptAt('foundations.01', { daysAgo: 6, durationSec: 300 }), //    5 min this week
      attemptAt('foundations.01', { daysAgo: 7, durationSec: 1200 }), //  20 min the week before
      attemptAt('foundations.01', { daysAgo: 13, durationSec: 600 }), //  10 min the week before
      attemptAt('foundations.01', { daysAgo: 14, durationSec: 6000 }), // outside both
    ];
    const weeks = practiceWeeks(attempts, TODAY, OFFSET);
    expect(weeks.days).toHaveLength(14);
    expect(weeks.recent).toBeCloseTo(15, 6);
    expect(weeks.before).toBeCloseTo(30, 6);
    expect(weeks.days[13].minutes).toBeCloseTo(10, 6);
    expect(weeks.days[12].minutes).toBe(0);
  });
});

describe('buildDashboard', () => {
  it('shows the Foundations skills and withholds Personal bests until records unlock', () => {
    const model = buildDashboard({ attempts: [], snapshot: snapshotOf([]), worlds: WORLDS, now: NOW, utcOffsetMinutes: OFFSET });
    expect(model.skills.map((s) => s.skill.id)).toEqual(['accuracy', 'stability', 'crispness', 'transitions']);
    expect(model.bests).toBeNull();
    expect(model.todayIndex).toBe(TODAY);
  });

  it('opens Personal bests, and the Vibrato skill with its world', () => {
    const attempts = passWorld('foundations');
    const model = buildDashboard({ attempts, snapshot: snapshotOf(attempts), worlds: WORLDS, now: NOW, utcOffsetMinutes: OFFSET });
    expect(model.bests).not.toBeNull();
    expect(model.skills.map((s) => s.skill.id)).toContain('vibrato');
    expect(model.skills.map((s) => s.skill.id)).not.toContain('inflections');
  });
});
