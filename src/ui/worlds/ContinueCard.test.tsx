// @vitest-environment happy-dom
/**
 * The Continue card (docs/DESIGN.md 13.1, 13.3): the current level as a lesson ("Next up · Lesson 4", the lesson title,
 * what it teaches, where its practice is), or as a classic level when it has no lesson. Fixture lessons stand in for
 * src/lessons; the snapshots, the router and the route guard are the real ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../state/session', async () => (await import('./test-support')).sessionDouble());
vi.mock('../../lessons', async () => (await import('../lesson/test-support')).lessonsModule());
vi.mock('../../lessons/progress', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lessons/progress')>()),
  ...(await import('../lesson/test-support')).lessonProgressModule(),
}));

import { getLevel, getWorld } from '../../exercises';
import { resetRouterForTests, route, routeOf } from '../../router';
import { attemptLog, snapshot } from '../../state/session';
import { lessonNumber } from '../lesson/model';
import { fixtureLesson, progressOf, resetLessons, setLessons, setProgress } from '../lesson/test-support';
import { ContinueCard } from './ContinueCard';
import { pad2 } from './format';
import { orderedLevels } from './levels';
import { attempt, byTestId, installGuardOver, mount, snapshotOf, textOf, type Mounted } from './test-support';

const DOT = '·';
const FOUNDATIONS = getWorld('foundations')!;
const ORDER = orderedLevels(FOUNDATIONS);
const CURRENT = ORDER[3].id;
const BEFORE = ORDER[2].id;
let view: Mounted | null = null;

function show(quiet = false): HTMLElement {
  view = mount(<ContinueCard quiet={quiet} />);
  return byTestId(view.container, 'continue-card')!;
}

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

describe('ContinueCard: a level without a lesson', () => {
  it('keeps "Next up · 04", the level title and its tally lights', () => {
    const card = show();
    expect(textOf(card.querySelector('.pl-label'))).toBe(`Next up ${DOT} ${pad2(4)}`);
    expect(textOf(card.querySelector('.wl-continue__title'))).toBe(getLevel(CURRENT)!.title);
    expect(card.querySelector('.pl-tally-lights')).not.toBeNull();
    expect(byTestId(card, 'continue-practice')).toBeNull();
  });
});

describe('ContinueCard: the current lesson', () => {
  const lesson = fixtureLesson(CURRENT, { title: 'Hold it steady, the lesson' });
  beforeEach(() => setLessons(lesson));

  it('reads as the next lesson: its number and title, what it teaches, and that it is new', () => {
    const card = show();
    expect(card.dataset.lesson).toBe(CURRENT);
    expect(textOf(card.querySelector('.pl-label'))).toBe(`Next up ${DOT} Lesson ${lessonNumber(FOUNDATIONS, getLevel(CURRENT)!)}`);
    expect(textOf(card.querySelector('.wl-continue__world'))).toBe('Foundations');
    expect(textOf(card.querySelector('.wl-continue__title'))).toBe(lesson.title);
    expect(card.textContent).toContain(lesson.outcome);
    expect(textOf(byTestId(card, 'continue-practice'))).toBe('New lesson');
    // A lesson in progress has no tally lights to show: the practice line says where it is.
    expect(card.querySelector('.pl-tally-lights')).toBeNull();
  });

  it('makes the music words in what it teaches tappable', () => {
    const card = show();
    for (const id of ['note', 'step', 'in-tune']) expect(card.querySelector(`[data-term="${id}"]`), id).not.toBeNull();
  });

  it('says which practice step the singer is on, with a mark for each step done', () => {
    setProgress(progressOf(lesson, [2, 1]));
    const card = show();
    expect(textOf(byTestId(card, 'continue-practice'))).toBe('Practice 2 of 3');
    expect(card.querySelectorAll('.pl-lesson-marks__mark')).toHaveLength(3);
    expect(card.querySelectorAll('.pl-lesson-marks__mark--done')).toHaveLength(1);
  });

  it('says "Ready for the check" once every step is done', () => {
    setProgress(progressOf(lesson, [2, 3, 2]));
    expect(textOf(byTestId(show(), 'continue-practice'))).toBe('Ready for the check');
  });

  it('shows the best on the check once there is one', () => {
    const take = attempt({ levelId: CURRENT, exerciseId: getLevel(CURRENT)!.exerciseId, passed: false, score: 0.42 });
    snapshot.value = snapshotOf(BEFORE, [take]);
    attemptLog.value = [take];
    const card = show();
    expect(card.textContent).toContain('Best on the check 42%');
    // A missed check sends the singer back to the step that trains what it missed (time in tune: every step; the last).
    expect(textOf(byTestId(card, 'continue-practice'))).toBe('Practice 3 of 3');
  });

  it('names a Boss Recital lesson titled just "Boss Recital" in full', () => {
    const boss = ORDER[ORDER.length - 1].id;
    snapshot.value = snapshotOf(ORDER[ORDER.length - 2].id);
    setLessons(fixtureLesson(boss, { title: 'Boss Recital' }));
    expect(textOf(show().querySelector('.wl-continue__title'))).toBe('Foundations Boss Recital');
  });

  it('opens the lesson from Continue, the amber button unless another card leads', () => {
    const card = show();
    const button = byTestId<HTMLButtonElement>(card, 'continue-button')!;
    expect(button.classList.contains('pl-btn--primary')).toBe(true);
    button.click();
    expect(route.value).toEqual(routeOf('level', { levelId: CURRENT }));
    view!.unmount();
    expect(byTestId<HTMLButtonElement>(show(true), 'continue-button')!.classList.contains('pl-btn--secondary')).toBe(true);
  });
});
