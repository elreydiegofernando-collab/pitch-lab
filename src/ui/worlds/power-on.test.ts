import { beforeEach, describe, expect, it } from 'vitest';
import { WORLDS } from '../../exercises';
import { resetPowerOnForTests, takePowerOn } from './power-on';
import { fakeOutcome, snapshotOf } from './test-support';

beforeEach(resetPowerOnForTests);

describe('takePowerOn', () => {
  const snap = snapshotOf('foundations.01');

  it('powers on the levels a take made playable', () => {
    const outcome = fakeOutcome({
      id: 'a',
      unlocked: [
        { kind: 'level-passed', levelId: 'foundations.01', title: 'Range finder', mastery: 3 },
        { kind: 'level-opened', levelId: 'foundations.02', title: 'Pitch match' },
      ],
    });
    expect([...takePowerOn(outcome, snap, WORLDS)]).toEqual(['foundations.02']);
  });

  it('powers on every level an audition test granted', () => {
    const outcome = fakeOutcome({
      id: 'a',
      unlocked: [
        { kind: 'level-opened', levelId: 'foundations.02', title: 'Pitch match' },
        { kind: 'level-opened', levelId: 'foundations.03', title: 'Sustain I' },
      ],
    });
    expect([...takePowerOn(outcome, snap, WORLDS)]).toEqual(['foundations.02', 'foundations.03']);
  });

  it('powers on the first level of a world that opened', () => {
    const after = snapshotOf('foundations.boss');
    const outcome = fakeOutcome({ id: 'a', unlocked: [{ kind: 'world-opened', worldId: 'vibrato', title: 'Vibrato' }] });
    expect([...takePowerOn(outcome, after, WORLDS)]).toEqual(['vibrato.01']);
  });

  it('ignores features, songs and mastery: they are not nodes', () => {
    const outcome = fakeOutcome({
      id: 'a',
      unlocked: [
        { kind: 'feature', featureId: 'dashboard', title: 'Progress dashboard' },
        { kind: 'songs', requiredWorld: 'foundations', count: 3 },
        { kind: 'mastery', levelId: 'foundations.01', title: 'Range finder', mastery: 2 },
      ],
    });
    expect(takePowerOn(outcome, snap, WORLDS).size).toBe(0);
  });

  it('answers once per take: the second call, and any later visit to the map, gets nothing', () => {
    const outcome = fakeOutcome({ id: 'a', unlocked: [{ kind: 'level-opened', levelId: 'foundations.02', title: 'Pitch match' }] });
    expect(takePowerOn(outcome, snap, WORLDS).size).toBe(1);
    expect(takePowerOn(outcome, snap, WORLDS).size).toBe(0);
  });

  it('answers again for the next take', () => {
    const first = fakeOutcome({ id: 'a', unlocked: [{ kind: 'level-opened', levelId: 'foundations.02', title: 'Pitch match' }] });
    const second = fakeOutcome({ id: 'b', unlocked: [{ kind: 'level-opened', levelId: 'foundations.03', title: 'Sustain I' }] });
    takePowerOn(first, snap, WORLDS);
    expect([...takePowerOn(second, snap, WORLDS)]).toEqual(['foundations.03']);
  });

  it('has nothing to power on without a take', () => {
    expect(takePowerOn(null, snap, WORLDS).size).toBe(0);
  });
});
