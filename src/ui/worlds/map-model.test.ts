import { describe, expect, it } from 'vitest';
import { WORLDS } from '../../exercises';
import { auditionRequirementHint, levelRequirementHint, requirementHint, worldRequirementHint } from '../../progress';
import { buildMapModel } from './map-model';
import { attempt, attemptsThrough, passAudition, snapshotOf } from './test-support';

const model = (levelId: string | null, extra: Parameters<typeof snapshotOf>[1] = []) => buildMapModel(snapshotOf(levelId, extra), WORLDS);
const world = (m: ReturnType<typeof model>, id: string) => m.find((w) => w.world.id === id)!;

describe('buildMapModel: a fresh profile', () => {
  const m = model(null);
  const foundations = world(m, 'foundations');

  it('lists every world in catalog order, numbered from 1', () => {
    expect(m.map((w) => [w.number, w.world.id])).toEqual([
      [1, 'foundations'],
      [2, 'vibrato'],
      [3, 'inflections'],
      [4, 'runs'],
      [5, 'dynamics'],
      [6, 'song-stage'],
    ]);
  });

  it('opens only Foundations; every other world is closed with its requirement line and no nodes', () => {
    expect(m.filter((w) => w.open).map((w) => w.world.id)).toEqual(['foundations']);
    for (const w of m.slice(1)) {
      expect(w.nodes, w.world.id).toEqual([]);
      expect(w.audition, w.world.id).toBeNull();
      expect(w.current, w.world.id).toBeNull();
    }
    const snap = snapshotOf(null);
    expect(world(m, 'vibrato').hint).toBe(worldRequirementHint('vibrato', snap, WORLDS));
    expect(world(m, 'vibrato').hint).toBe('Pass the Foundations Boss Recital to unlock Vibrato.');
    expect(world(m, 'dynamics').hint).toBe('Pass the Runs & Riffs Boss Recital to unlock Dynamics.');
    expect(world(m, 'song-stage').hint).toBe(requirementHint('song-stage'));
  });

  it('keeps the level titles of a closed world, in order, for its compact list', () => {
    expect(world(m, 'vibrato').titles).toEqual(WORLDS.find((w) => w.id === 'vibrato')!.levels.map((l) => l.title));
    expect(world(m, 'vibrato').titles).toHaveLength(9);
    expect(world(m, 'song-stage').titles).toEqual([]);
    expect(world(m, 'song-stage').ladder).toBe(false);
  });

  it('makes the first level current and every other level a locked node with a requirement line', () => {
    expect(foundations.nodes).toHaveLength(10);
    expect(foundations.nodes.map((n) => n.state)).toEqual(['current', ...Array(9).fill('locked')]);
    expect(foundations.current?.id).toBe('foundations.01');
    const snap = snapshotOf(null);
    for (const node of foundations.nodes.slice(1)) {
      expect(node.hint, node.level.id).toBe(levelRequirementHint(node.level.id, snap, WORLDS));
    }
    expect(foundations.nodes[1].hint).toBe('Pass Range finder to unlock.');
    expect(foundations.nodes[2].hint).toBe('Pass Pitch match to unlock.');
    expect(foundations.nodes[0].hint).toBeNull();
  });

  it('numbers the nodes from 1 and flags the Boss Recital as the last one', () => {
    expect(foundations.nodes.map((n) => n.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(foundations.nodes.filter((n) => n.boss).map((n) => n.level.id)).toEqual(['foundations.boss']);
    expect(foundations.nodes[9].boss).toBe(true);
  });

  it('has nothing to light yet: the cable starts at the first node, which is the one the singer is on', () => {
    expect(foundations.nodes.some((n) => n.litAbove || n.litBelow)).toBe(false);
  });

  it('shows the Foundations audition as locked until the Range finder is sung, with its requirement', () => {
    expect(foundations.audition).toEqual({ kind: 'locked', hint: auditionRequirementHint('foundations', snapshotOf(null), WORLDS) });
    expect(foundations.audition).toEqual({ kind: 'locked', hint: 'Pass Range finder to unlock the audition.' });
  });

  it('counts passed levels', () => {
    expect([foundations.passed, foundations.total]).toEqual([0, 10]);
    expect([world(m, 'vibrato').passed, world(m, 'vibrato').total]).toEqual([0, 9]);
  });
});

describe('buildMapModel: partway through Foundations', () => {
  const m = model('foundations.03');
  const nodes = world(m, 'foundations').nodes;

  it('marks passed, current and locked nodes in order, and only passed and current ones as openable', () => {
    expect(nodes.map((n) => n.state)).toEqual(['passed', 'passed', 'passed', 'current', ...Array(6).fill('locked')]);
    expect(nodes.map((n) => n.openable)).toEqual([true, true, true, true, ...Array(6).fill(false)]);
    expect(world(m, 'foundations').passed).toBe(3);
    expect(world(m, 'foundations').current?.id).toBe('foundations.04');
  });

  it('lights the cable from the first node through the current one', () => {
    expect(nodes.map((n) => n.litAbove)).toEqual([false, true, true, true, false, false, false, false, false, false]);
    expect(nodes.map((n) => n.litBelow)).toEqual([true, true, true, false, false, false, false, false, false, false]);
  });

  it('carries the best score and mastery of a passed node, and null for one never scored', () => {
    expect(nodes[0].best).toBeCloseTo(0.85);
    expect(nodes[0].mastery).toBe(1);
    expect(nodes[3].best).toBeNull();
    expect(nodes[3].attempts).toBe(0);
  });

  it('keeps the current level in progress as current after a failed attempt, with its best score', () => {
    const failed = attempt({ levelId: 'foundations.04', passed: false, score: 0.42 });
    const again = buildMapModel(snapshotOf('foundations.03', [failed]), WORLDS);
    const current = world(again, 'foundations').nodes[3];
    expect(current.state).toBe('current');
    expect(current.best).toBeCloseTo(0.42);
    expect(current.attempts).toBe(1);
  });

  it('offers the audition from the first level it can still open (the first test is still next while Sustain II is open)', () => {
    expect(world(m, 'foundations').audition).toEqual({ kind: 'available', tests: 4, reach: 'Sustain II – Legato lines' });
  });
});

describe('buildMapModel: audition rows', () => {
  it('offers the whole audition once the Range finder is sung', () => {
    const row = world(model('foundations.01'), 'foundations').audition;
    expect(row).toEqual({ kind: 'available', tests: 4, reach: 'Pitch match – Legato lines' });
  });

  it('hides the row when nothing is left to open', () => {
    expect(world(model('foundations.09'), 'foundations').audition).toBeNull();
  });

  it('marks levels an audition passed, and keeps offering the tests that are left', () => {
    const m = model('foundations.01', [passAudition('foundations', 1)]);
    const nodes = world(m, 'foundations').nodes;
    expect(nodes.slice(0, 4).map((n) => n.state)).toEqual(['passed', 'passed', 'passed', 'passed']);
    expect(nodes.slice(1, 4).every((n) => n.viaAudition)).toBe(true);
    expect(nodes[0].viaAudition).toBe(false);
    expect(nodes[4].state).toBe('current');
    expect(world(m, 'foundations').audition).toEqual({ kind: 'available', tests: 3, reach: 'Sirens & glides – Legato lines' });
  });
});

describe('buildMapModel: after the Foundations Boss Recital', () => {
  const m = model('foundations.boss');

  it('opens Vibrato and Song Stage, and leaves the later worlds closed', () => {
    expect(m.filter((w) => w.open).map((w) => w.world.id)).toEqual(['foundations', 'vibrato', 'song-stage']);
    expect(world(m, 'vibrato').current?.id).toBe('vibrato.01');
    expect(world(m, 'song-stage').hint).toBeNull();
    expect(world(m, 'inflections').hint).toBe('Pass the Vibrato Boss Recital to unlock Inflections.');
  });

  it('shows every Foundations node as passed with the cable lit end to end', () => {
    const nodes = world(m, 'foundations').nodes;
    expect(nodes.every((n) => n.state === 'passed')).toBe(true);
    expect(nodes.slice(1).every((n) => n.litAbove)).toBe(true);
    expect(nodes.slice(0, -1).every((n) => n.litBelow)).toBe(true);
    expect(world(m, 'foundations').current).toBeNull();
  });

  it('offers the Vibrato audition', () => {
    expect(world(m, 'vibrato').audition?.kind).toBe('available');
  });
});

describe('buildMapModel: the log is the only input', () => {
  it('does not depend on how the attempts were ordered', () => {
    const log = attemptsThrough('foundations.05');
    const forward = buildMapModel(snapshotOf(null, log), WORLDS);
    const backward = buildMapModel(snapshotOf(null, [...log].reverse()), WORLDS);
    expect(backward.map((w) => w.nodes.map((n) => n.state))).toEqual(forward.map((w) => w.nodes.map((n) => n.state)));
  });
});
