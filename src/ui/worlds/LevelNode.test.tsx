// @vitest-environment happy-dom
/**
 * A level on the map (docs/DESIGN.md 13.2, 13.3): a level with a lesson reads as a lesson ("Lesson 5: Two notes, one step
 * apart"), and the current one says where its practice is ("Up next · Practice 2 of 3"). Fixture lessons stand in for
 * src/lessons; the snapshots, the map model, the router and the route guard are the real ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../state/session', async () => (await import('./test-support')).sessionDouble());
vi.mock('../../lessons', async () => (await import('../lesson/test-support')).lessonsModule());
vi.mock('../../lessons/progress', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lessons/progress')>()),
  ...(await import('../lesson/test-support')).lessonProgressModule(),
}));

import { WORLDS, getLevel, getWorld } from '../../exercises';
import { resetRouterForTests, route, routeOf } from '../../router';
import { attemptLog, snapshot } from '../../state/session';
import { lessonNumber } from '../lesson/model';
import { fixtureLesson, progressOf, resetLessons, setLessons, setProgress } from '../lesson/test-support';
import { LevelNode, nodeLabel } from './LevelNode';
import { orderedLevels } from './levels';
import { buildMapModel, type NodeModel } from './map-model';
import { attempt, byTestId, installGuardOver, mount, snapshotOf, textOf, type Mounted } from './test-support';

const DOT = '·';
const FOUNDATIONS = getWorld('foundations')!;
const ORDER = orderedLevels(FOUNDATIONS);
/** The fourth Foundations lesson: current once the first three are passed. */
const CURRENT = ORDER[3].id;
const BEFORE = ORDER[2].id;
let view: Mounted | null = null;

function nodeOf(levelId: string): NodeModel {
  const world = buildMapModel(snapshot.value, WORLDS).find((w) => w.world.id === getLevel(levelId)!.worldId)!;
  return world.nodes.find((n) => n.level.id === levelId)!;
}

function show(levelId: string): HTMLElement {
  view = mount(
    <ol>
      <LevelNode node={nodeOf(levelId)} world={getWorld(getLevel(levelId)!.worldId)!} poweredOn={false} />
    </ol>,
  );
  return byTestId(view.container, `node-${levelId}`)!;
}

const numberOf = (levelId: string): number => lessonNumber(FOUNDATIONS, getLevel(levelId)!);

beforeEach(() => {
  resetRouterForTests();
  resetLessons();
  snapshot.value = snapshotOf(BEFORE);
  attemptLog.value = [];
  installGuardOver(() => snapshot.peek());
});

afterEach(() => {
  view?.unmount();
  view = null;
});

describe('LevelNode: a level without a lesson', () => {
  it('keeps its level title and wording: "Level 4: …. Up next."', () => {
    const node = show(CURRENT);
    const level = getLevel(CURRENT)!;
    expect(textOf(node.querySelector('.wl-node__title'))).toBe(level.title);
    expect(textOf(node.querySelector('.wl-node__status'))).toBe('Up next');
    expect(node.querySelector('button')!.getAttribute('aria-label')).toBe(`Level ${numberOf(CURRENT)}: ${level.title}. Up next.`);
    expect(node.classList.contains('wl-node--lesson')).toBe(false);
  });
});

describe('LevelNode: the current lesson', () => {
  const lesson = fixtureLesson(CURRENT, { title: 'Hold it steady, the lesson' });
  beforeEach(() => setLessons(lesson));

  it('reads as a lesson, new until its first try', () => {
    const node = show(CURRENT);
    expect(node.classList.contains('wl-node--lesson')).toBe(true);
    expect(textOf(node.querySelector('.wl-node__title'))).toBe(lesson.title);
    expect(textOf(node.querySelector('.wl-node__status'))).toBe(`Up next ${DOT} New lesson`);
    expect(node.querySelector('button')!.getAttribute('aria-label')).toBe(`Lesson ${numberOf(CURRENT)}: ${lesson.title}. Up next. New lesson.`);
  });

  it('says which practice step the singer is on', () => {
    setProgress(progressOf(lesson, [2, 1]));
    const node = show(CURRENT);
    expect(textOf(byTestId(node, 'node-practice'))).toBe(`${DOT} Practice 2 of 3`);
    expect(node.querySelector('button')!.getAttribute('aria-label')).toBe(`Lesson ${numberOf(CURRENT)}: ${lesson.title}. Up next. Practice 2 of 3.`);
  });

  it('says "Ready for the check" once every step is done', () => {
    setProgress(progressOf(lesson, [2, 3, 2]));
    expect(textOf(byTestId(show(CURRENT), 'node-practice'))).toBe(`${DOT} Ready for the check`);
  });

  it('counts a missed take of the check as a try: no longer new, and back to the step that trains what it missed', () => {
    const take = attempt({ levelId: CURRENT, exerciseId: getLevel(CURRENT)!.exerciseId, passed: false, score: 0.4 });
    snapshot.value = snapshotOf(BEFORE, [take]);
    attemptLog.value = [take];
    // The take missed the check's first gate (time in tune), which every step of this lesson practises: the last of them.
    expect(textOf(byTestId(show(CURRENT), 'node-practice'))).toBe(`${DOT} Practice 3 of 3`);
  });

  it('is a new lesson whatever was sung on its place in the world before the rebuild (the old material is not this lesson)', () => {
    const before = attempt({ levelId: 'foundations.04', exerciseId: 'foundations.sustain.2', passed: true, score: 0.9 });
    snapshot.value = snapshotOf(BEFORE, [before]);
    attemptLog.value = [before];
    expect(textOf(byTestId(show(CURRENT), 'node-practice'))).toBe(`${DOT} New lesson`);
  });

  it('opens the lesson screen', () => {
    show(CURRENT).querySelector('button')!.click();
    expect(route.value).toEqual(routeOf('level', { levelId: CURRENT }));
  });
});

describe('LevelNode: passed, locked and Boss Recital lessons', () => {
  it('a passed lesson keeps its best, tier and lights, under its lesson title', () => {
    const lesson = fixtureLesson(BEFORE, { title: 'Hold it, the lesson' });
    setLessons(lesson);
    const node = show(BEFORE);
    const model = nodeOf(BEFORE);
    expect(textOf(node.querySelector('.wl-node__title'))).toBe(lesson.title);
    expect(node.querySelector('.pl-tally-lights')).not.toBeNull();
    expect(byTestId(node, 'node-practice')).toBeNull();
    expect(node.querySelector('button')!.getAttribute('aria-label')).toBe(nodeLabel(model, FOUNDATIONS, lesson));
    expect(node.querySelector('button')!.getAttribute('aria-label')).toMatch(new RegExp(`^Lesson ${numberOf(BEFORE)}: ${lesson.title}\\. Passed`));
  });

  it('a locked lesson shows its title and requirement, and is no control', () => {
    const later = ORDER[6].id;
    setLessons(fixtureLesson(later, { title: 'Bigger jumps, the lesson' }));
    const node = show(later);
    expect(textOf(node.querySelector('.wl-node__title'))).toBe('Bigger jumps, the lesson');
    expect(node.querySelector('.pl-locked')).not.toBeNull();
    expect(node.querySelector('button')).toBeNull();
  });

  it('a Boss Recital lesson keeps its kicker and says it is the Boss Recital', () => {
    const boss = ORDER[ORDER.length - 1].id;
    snapshot.value = snapshotOf(ORDER[ORDER.length - 2].id);
    const lesson = fixtureLesson(boss, { title: 'A short tune' });
    setLessons(lesson);
    const node = show(boss);
    expect(textOf(node.querySelector('.wl-node__kicker'))).toBe('Boss Recital');
    expect(textOf(node.querySelector('.wl-node__title'))).toBe('A short tune');
    expect(node.querySelector('button')!.getAttribute('aria-label')).toBe(`Lesson ${numberOf(boss)}: A short tune, the Foundations Boss Recital. Up next. New lesson.`);
  });

  it('a Boss Recital lesson titled just "Boss Recital" shows its world, and is heard in full', () => {
    const boss = ORDER[ORDER.length - 1].id;
    snapshot.value = snapshotOf(ORDER[ORDER.length - 2].id);
    setLessons(fixtureLesson(boss, { title: 'Boss Recital' }));
    const node = show(boss);
    expect(textOf(node.querySelector('.wl-node__title'))).toBe('Foundations');
    expect(node.querySelector('button')!.getAttribute('aria-label')).toBe(`Lesson ${numberOf(boss)}: Foundations Boss Recital. Up next. New lesson.`);
  });
});

describe('nodeLabel', () => {
  it('names a lesson by its number and title, a level by its number and level title', () => {
    const model = nodeOf(CURRENT);
    expect(nodeLabel(model, FOUNDATIONS)).toBe(`Level ${model.number}: ${model.level.title}. Up next.`);
    expect(nodeLabel(model, FOUNDATIONS, { title: 'Steady' }, 'Practice 2 of 3')).toBe(`Lesson ${model.number}: Steady. Up next. Practice 2 of 3.`);
    expect(nodeLabel(model, FOUNDATIONS, { title: 'Steady' }, null)).toBe(`Lesson ${model.number}: Steady. Up next.`);
  });
});
