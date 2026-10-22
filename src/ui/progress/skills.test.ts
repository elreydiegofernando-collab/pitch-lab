import { describe, expect, it } from 'vitest';
import { WORLDS } from '../../exercises';
import { dayIndexOf } from '../../progress';
import { SKILLS, isLowerBetter, skillForKind, skillLevel, skillTrend, sparkCoords, unlockedSkills } from './skills';
import { attemptAt, localNoon, localOffsetMinutes, passWorld, snapshotOf } from './test-fixtures';

const OFFSET = localOffsetMinutes();
const NOW = Date.now();
const TODAY = dayIndexOf(NOW, OFFSET);

const accuracy = SKILLS.find((s) => s.id === 'accuracy')!;
const stability = SKILLS.find((s) => s.id === 'stability')!;

describe('which skills show', () => {
  it('shows only the Foundations skills at the start, in dashboard order', () => {
    const snapshot = snapshotOf([]);
    expect(unlockedSkills(snapshot).map((s) => s.id)).toEqual(['accuracy', 'stability', 'crispness', 'transitions']);
  });

  it('adds Vibrato once the Foundations Boss Recital opens that world, and nothing past it', () => {
    const snapshot = snapshotOf(passWorld('foundations'));
    expect(unlockedSkills(snapshot).map((s) => s.id)).toEqual(['accuracy', 'stability', 'crispness', 'transitions', 'vibrato']);
  });

  it('every skill reads a metric that exists and belongs to a world in the catalog', () => {
    for (const skill of SKILLS) {
      expect(WORLDS.some((w) => w.id === skill.worldId)).toBe(true);
      expect(skill.best).not.toBe(skill.worst);
    }
  });
});

describe('skillLevel and direction', () => {
  it('maps a rate to 0..1 and clamps', () => {
    expect(skillLevel(accuracy, 100)).toBe(1);
    expect(skillLevel(accuracy, 50)).toBe(0.5);
    expect(skillLevel(accuracy, 0)).toBe(0);
    expect(skillLevel(accuracy, 140)).toBe(1);
  });

  it('treats a smaller spread as better', () => {
    expect(isLowerBetter(stability)).toBe(true);
    expect(isLowerBetter(accuracy)).toBe(false);
    expect(skillLevel(stability, 0)).toBe(1);
    expect(skillLevel(stability, 40)).toBe(0);
    expect(skillLevel(stability, 10)).toBeGreaterThan(skillLevel(stability, 30));
  });

  it('is 0 for a value that is not a number', () => {
    expect(skillLevel(accuracy, Number.NaN)).toBe(0);
  });
});

describe('skillTrend', () => {
  it('averages the metric over each day and keeps days apart', () => {
    const attempts = [
      attemptAt('foundations.02', { daysAgo: 2, metrics: { 'accuracy.inTolerancePct': 60 } }),
      attemptAt('foundations.02', { daysAgo: 2, metrics: { 'accuracy.inTolerancePct': 80 } }),
      attemptAt('foundations.02', { daysAgo: 0, metrics: { 'accuracy.inTolerancePct': 90 } }),
    ];
    const trend = skillTrend(accuracy, attempts, TODAY, OFFSET);
    expect(trend.points.map((p) => [p.dayIndex, p.value, p.takes])).toEqual([
      [TODAY - 2, 70, 2],
      [TODAY, 90, 1],
    ]);
    expect(trend.latest?.value).toBe(90);
    expect(trend.points[0].dayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('counts failed takes (a trend that hid misses would flatter), but not deleted ones or takes without the metric', () => {
    const missed = attemptAt('foundations.02', { passed: false, metrics: { 'accuracy.inTolerancePct': 20 } });
    const deleted = { ...attemptAt('foundations.02', { metrics: { 'accuracy.inTolerancePct': 100 } }), deletedAt: localNoon(0) };
    const unrelated = attemptAt('foundations.02', { metrics: { 'onset.crispRate': 0.9 } });
    const trend = skillTrend(accuracy, [missed, deleted, unrelated], TODAY, OFFSET);
    expect(trend.points).toHaveLength(1);
    expect(trend.points[0].value).toBe(20);
  });

  it('looks back 30 days only, and files a future-dated take under today', () => {
    const old = attemptAt('foundations.02', { daysAgo: 31, metrics: { 'accuracy.inTolerancePct': 10 } });
    const edge = attemptAt('foundations.02', { daysAgo: 29, metrics: { 'accuracy.inTolerancePct': 40 } });
    const future = attemptAt('foundations.02', { daysAgo: -3, metrics: { 'accuracy.inTolerancePct': 70 } });
    const trend = skillTrend(accuracy, [old, edge, future], TODAY, OFFSET);
    expect(trend.points.map((p) => p.dayIndex)).toEqual([TODAY - 29, TODAY]);
  });

  it('has no latest value for a skill that was never measured', () => {
    const trend = skillTrend(accuracy, [], TODAY, OFFSET);
    expect(trend.points).toEqual([]);
    expect(trend.latest).toBeNull();
  });
});

describe('sparkCoords', () => {
  it('puts the newest day at the right edge and better values higher', () => {
    const attempts = [
      attemptAt('foundations.03', { daysAgo: 29, metrics: { 'accuracy.sdCents': 30 } }),
      attemptAt('foundations.03', { daysAgo: 0, metrics: { 'accuracy.sdCents': 5 } }),
    ];
    const trend = skillTrend(stability, attempts, TODAY, OFFSET);
    const [first, last] = sparkCoords(trend, TODAY);
    expect(first.x).toBe(0);
    expect(last.x).toBe(1);
    // A spread that fell from 30 to 5 cents is an improvement: the line ends higher (smaller y) than it began.
    expect(last.y).toBeLessThan(first.y);
  });
});

describe('skillForKind', () => {
  it('names the skill an exercise trains, and none for the capstones', () => {
    expect(skillForKind('staccato')?.label).toBe('Crispness');
    expect(skillForKind('sustain')?.label).toBe('Stability');
    expect(skillForKind('swell')?.label).toBe('Dynamics');
    expect(skillForKind('boss-recital')).toBeUndefined();
    expect(skillForKind('range-finder')).toBeUndefined();
  });
});
