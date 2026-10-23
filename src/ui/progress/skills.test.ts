import { describe, expect, it } from 'vitest';
import { WORLDS, getExercise } from '../../exercises';
import { dayIndexOf } from '../../progress';
import { SKILLS, isLowerBetter, skillForKind, skillLevel, skillTrend, sparkCoords, unlockedSkills } from './skills';
import { attemptAt, localNoon, localOffsetMinutes, passWorld, snapshotOf } from './test-fixtures';

const OFFSET = localOffsetMinutes();
const NOW = Date.now();
const TODAY = dayIndexOf(NOW, OFFSET);

const accuracy = SKILLS.find((s) => s.id === 'accuracy')!;
const stability = SKILLS.find((s) => s.id === 'stability')!;
const transitions = SKILLS.find((s) => s.id === 'transitions')!;
const crispness = SKILLS.find((s) => s.id === 'crispness')!;
/** The Accuracy skill's metric: the typical miss in cents (lower is better, the same at every tolerance). */
const MISS = 'accuracy.medianAbsCents';
/** A level judged on the narrow (studio) zone, held notes and no deliberate pitch motion: none in Foundations since the rebuild. */
const STUDIO = WORLDS.flatMap((w) => w.levels).find((l) => {
  const def = getExercise(l.exerciseId);
  return def?.tolerance === 'studio' && !def.analyzers.some((a) => a === 'pulse' || a === 'vibrato' || a === 'switch');
})!.id;

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
    expect(skillLevel(transitions, 1)).toBe(1);
    expect(skillLevel(transitions, 0.5)).toBe(0.5);
    expect(skillLevel(transitions, 0)).toBe(0);
    expect(skillLevel(transitions, 1.4)).toBe(1);
  });

  it('treats a smaller spread, miss or scoop as better', () => {
    expect(isLowerBetter(stability)).toBe(true);
    expect(isLowerBetter(accuracy)).toBe(true);
    expect(isLowerBetter(crispness)).toBe(true);
    expect(isLowerBetter(transitions)).toBe(false);
    expect(skillLevel(stability, 0)).toBe(1);
    expect(skillLevel(stability, 40)).toBe(0);
    expect(skillLevel(stability, 10)).toBeGreaterThan(skillLevel(stability, 30));
    expect(skillLevel(accuracy, 8)).toBeGreaterThan(skillLevel(accuracy, 25));
  });

  it('is 0 for a value that is not a number', () => {
    expect(skillLevel(accuracy, Number.NaN)).toBe(0);
  });
});

describe('skillTrend', () => {
  it('averages the metric over each day and keeps days apart', () => {
    const attempts = [
      attemptAt('foundations.02', { daysAgo: 2, metrics: { [MISS]: 12 } }),
      attemptAt('foundations.02', { daysAgo: 2, metrics: { [MISS]: 8 } }),
      attemptAt('foundations.02', { daysAgo: 0, metrics: { [MISS]: 6 } }),
    ];
    const trend = skillTrend(accuracy, attempts, TODAY, OFFSET);
    expect(trend.points.map((p) => [p.dayIndex, p.value, p.takes])).toEqual([
      [TODAY - 2, 10, 2],
      [TODAY, 6, 1],
    ]);
    expect(trend.latest?.value).toBe(6);
    expect(trend.points[0].dayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('counts failed takes (a trend that hid misses would flatter), but not deleted ones or takes without the metric', () => {
    const missed = attemptAt('foundations.02', { passed: false, metrics: { [MISS]: 40 } });
    const deleted = { ...attemptAt('foundations.02', { metrics: { [MISS]: 1 } }), deletedAt: localNoon(0) };
    const unrelated = attemptAt('foundations.02', { metrics: { 'onset.crispRate': 0.9 } });
    const trend = skillTrend(accuracy, [missed, deleted, unrelated], TODAY, OFFSET);
    expect(trend.points).toHaveLength(1);
    expect(trend.points[0].value).toBe(40);
  });

  it('looks back 30 days only, and files a future-dated take under today', () => {
    const old = attemptAt('foundations.02', { daysAgo: 31, metrics: { [MISS]: 30 } });
    const edge = attemptAt('foundations.02', { daysAgo: 29, metrics: { [MISS]: 20 } });
    const future = attemptAt('foundations.02', { daysAgo: -3, metrics: { [MISS]: 10 } });
    const trend = skillTrend(accuracy, [old, edge, future], TODAY, OFFSET);
    expect(trend.points.map((p) => p.dayIndex)).toEqual([TODAY - 29, TODAY]);
  });

  it('follows the voice, not the curriculum: an unchanged singer moving from easy to studio levels keeps a flat Accuracy and Crispness line', () => {
    // Match one note (easy) -> Hold it steady (default) -> a studio level: the same 14-cent typical miss and 20-cent
    // scoop every day. A share "in tolerance" would have fallen 91 -> 68 -> 32 for no change in the voice.
    const attempts = [
      attemptAt('foundations.02', { daysAgo: 6, metrics: { [MISS]: 14, 'onset.scoopCents': 20, 'accuracy.inTolerancePct': 91, 'onset.crispRate': 1 } }),
      attemptAt('foundations.13', { daysAgo: 3, metrics: { [MISS]: 14, 'accuracy.inTolerancePct': 68 } }),
      attemptAt(STUDIO, { daysAgo: 0, metrics: { [MISS]: 14, 'onset.scoopCents': 20, 'accuracy.inTolerancePct': 32, 'onset.crispRate': 0.2 } }),
    ];
    expect(skillTrend(accuracy, attempts, TODAY, OFFSET).points.map((p) => p.value)).toEqual([14, 14, 14]);
    expect(skillTrend(crispness, attempts, TODAY, OFFSET).points.map((p) => p.value)).toEqual([20, 20]);
  });

  it('leaves out takes whose pitch moves on purpose (the pulse drills) from Accuracy and Stability', () => {
    const pulses = attemptAt('vibrato.03', { daysAgo: 1, metrics: { [MISS]: 45, 'accuracy.sdCents': 38 } });
    const held = attemptAt('foundations.03', { daysAgo: 1, metrics: { [MISS]: 9, 'accuracy.sdCents': 8 } });
    expect(skillTrend(accuracy, [pulses, held], TODAY, OFFSET).latest?.value).toBe(9);
    expect(skillTrend(stability, [pulses, held], TODAY, OFFSET).latest?.value).toBe(8);
  });

  it('follows Transitions on one tolerance tier, the one sung most recently, and says which', () => {
    const studio = attemptAt(STUDIO, { daysAgo: 2, metrics: { 'transition.cleanRate': 0.5 } });
    const trend = skillTrend(transitions, [studio], TODAY, OFFSET);
    expect(trend.tier).toEqual({ tolerance: 'studio', label: 'at ±10¢' });
    expect(trend.points.map((p) => p.value)).toEqual([0.5]);
    expect(skillTrend(accuracy, [studio], TODAY, OFFSET).tier).toBeNull();
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
