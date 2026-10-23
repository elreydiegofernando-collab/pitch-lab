// @vitest-environment happy-dom
/**
 * The placement audition (docs/DESIGN.md 13.6): the intro lists the tests and starts the next one, or shows the one
 * Locked line and no Start button when the audition cannot be taken; opened from the report ("See your placement") the
 * screen shows where the singer placed and what the run opened, computed against the snapshot from before it. Session
 * and runner are doubles; the unlock registry, the router and the route guard are the real ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnlockEvent } from '../../runtime/types';

vi.mock('../../state/session', async () => (await import('../worlds/test-support')).sessionDouble());
vi.mock('../../runtime/runner', async () => ({ lastOutcome: (await import('@preact/signals')).signal(null) }));
const flow = vi.hoisted(() => ({ events: [] as UnlockEvent[] }));
vi.mock('../../runtime/flow', () => ({ unlockEvents: () => flow.events }));

import { getWorld } from '../../exercises';
import { back, replace, resetRouterForTests, route, routeOf } from '../../router';
import { lastOutcome } from '../../runtime/runner';
import { attemptLog, bootPhase, snapshot } from '../../state/session';
import { auditionRun, beginAuditionRun, resetAuditionStateForTests } from '../worlds/audition-model';
import { orderedLevels } from '../worlds/levels';
import {
  attempt,
  byTestId,
  fakeOutcome,
  flush,
  installGuardOver,
  mount,
  snapshotOf,
  textOf,
  type Mounted,
} from '../worlds/test-support';
import { Audition } from './Audition';

/** Foundations' audition as it is today: its tests in sung order, and a passed take of test `n` (1-based). */
const FOUNDATIONS = getWorld('foundations')!;
const TESTS = FOUNDATIONS.audition!.exerciseIds;
const passTest = (n: number) => attempt({ kind: 'audition', exerciseId: TESTS[n - 1], levelId: null, passed: true });
const ORDER = orderedLevels(FOUNDATIONS);
/** The last levels the second and the last test cover (Bigger jumps, Sirens), and the level before the Boss Recital. */
const JUMPS_END = FOUNDATIONS.audition!.unlockThrough[1];
const SIREN_END = FOUNDATIONS.audition!.unlockThrough[3];
const BEFORE_BOSS = ORDER[ORDER.length - 2].id;

let view: Mounted | null = null;

async function showAudition(worldId = 'foundations', stack = [routeOf('home'), routeOf('map'), routeOf('audition', { worldId })]): Promise<HTMLElement> {
  resetRouterForTests(stack);
  installGuardOver(() => snapshot.peek());
  view = mount(<Audition />);
  await flush();
  return view.container;
}

const states = (c: HTMLElement): string[] => [...c.querySelectorAll<HTMLElement>('[data-testid="audition-tests"] li')].map((li) => li.dataset.state ?? '');

beforeEach(() => {
  resetAuditionStateForTests();
  flow.events = [];
  bootPhase.value = 'ready';
  snapshot.value = snapshotOf(null);
  attemptLog.value = [];
  lastOutcome.value = null;
});

afterEach(() => {
  view?.unmount();
  view = null;
});

describe('Audition: the intro', () => {
  it('shows the world, the placement audition label, and the tests as a numbered list', async () => {
    snapshot.value = snapshotOf('foundations.01');
    const c = await showAudition();
    expect(byTestId(c, 'audition-screen')!.dataset.view).toBe('intro');
    expect(textOf(c.querySelector('.pl-appbar__title'))).toBe('Placement audition');
    expect(textOf(c.querySelector('.wl-world__head'))).toContain('Placement audition');
    expect(textOf(c.querySelector('.wl-world__title'))).toBe('Foundations');
    const rows = [...c.querySelectorAll('[data-testid="audition-tests"] li')];
    expect(rows).toHaveLength(4);
    expect(c.querySelector('[data-testid="audition-tests"]')!.tagName).toBe('OL');
    expect(rows.map((li) => textOf(li.querySelector('.wl-test__title')))).toEqual(['Match and hold', 'Steps and jumps', 'A connected line', 'Siren']);
  });

  it('explains the run in the words of the design', async () => {
    snapshot.value = snapshotOf('foundations.01');
    const c = await showAudition();
    expect(textOf(c.querySelector('p.pl-body'))).toBe(
      "Sing 4 short tests. Each pass unlocks the levels it covers. The run stops at the first miss. Nothing you've earned is ever locked again.",
    );
  });

  it('captions each test with what it unlocks, and marks it next, not reached or passed', async () => {
    snapshot.value = snapshotOf('foundations.01');
    const c = await showAudition();
    const rows = [...c.querySelectorAll('[data-testid="audition-tests"] li')];
    expect(rows.map((li) => textOf(li.querySelector('.pl-body-s')))).toEqual([
      'Unlocks Match one note – Hold it steady',
      'Unlocks Two notes, one step apart – Bigger jumps',
      'Unlocks Three notes: do-re-mi – Five notes in a row',
      'Unlocks Small slides – Sirens',
    ]);
    expect(states(c)).toEqual(['next', 'ahead', 'ahead', 'ahead']);
    expect(rows.map((li) => textOf(li.querySelector('.wl-test__state')))).toEqual(['Next', 'Not reached', 'Not reached', 'Not reached']);
    // Every status has a glyph as well as its word.
    for (const li of rows) expect(li.querySelector('.wl-test__state svg')).not.toBeNull();
  });

  it('marks tests passed as the audition is sung, and says how many are left', async () => {
    snapshot.value = snapshotOf('foundations.01', [passTest(1), passTest(2)]);
    const c = await showAudition();
    expect(states(c)).toEqual(['passed', 'passed', 'next', 'ahead']);
    expect(textOf(c.querySelectorAll('[data-testid="audition-tests"] li')[0].querySelector('.wl-test__state'))).toBe('Passed');
    expect(textOf(c.querySelector('p.pl-body'))).toContain('Sing 2 short tests.');
    expect(textOf(byTestId(c, 'audition-start'))).toBe('Start test 3');
  });
});

describe('Audition: Start', () => {
  beforeEach(() => {
    snapshot.value = snapshotOf('foundations.01');
  });

  it('is the one primary action, in the bottom bar, and says which test comes first', async () => {
    const c = await showAudition();
    const start = byTestId<HTMLButtonElement>(c, 'audition-start')!;
    expect(textOf(start)).toBe('Start test 1');
    expect(start.classList.contains('pl-btn--primary')).toBe(true);
    expect(byTestId(c, 'action-bar')!.contains(start)).toBe(true);
    expect(c.querySelectorAll('.pl-btn--primary')).toHaveLength(1);
  });

  it('opens the Sing screen for this world, and keeps the snapshot from before the run', async () => {
    const c = await showAudition();
    const before = snapshot.value;
    byTestId<HTMLButtonElement>(c, 'audition-start')!.click();
    expect(route.value).toEqual(routeOf('sing', { target: 'audition', worldId: 'foundations' }));
    expect(auditionRun.value?.worldId).toBe('foundations');
    expect(auditionRun.value?.before).toBe(before);
  });

  it('says Retake when the next test was sung and missed', async () => {
    attemptLog.value = [attempt({ kind: 'audition', exerciseId: TESTS[0], levelId: null, passed: false })];
    const c = await showAudition();
    expect(textOf(byTestId(c, 'audition-start'))).toBe('Retake test 1');
  });

  it('works for any world whose audition is open', async () => {
    snapshot.value = snapshotOf('foundations.boss');
    const c = await showAudition('vibrato', [routeOf('home'), routeOf('map'), routeOf('audition', { worldId: 'vibrato' })]);
    expect(textOf(c.querySelector('.wl-world__title'))).toBe('Vibrato');
    expect(textOf(byTestId(c, 'audition-start'))).toBe('Start test 1');
    byTestId<HTMLButtonElement>(c, 'audition-start')!.click();
    expect(route.value).toEqual(routeOf('sing', { target: 'audition', worldId: 'vibrato' }));
  });

  it('goes back with the app bar', async () => {
    const c = await showAudition();
    c.querySelector<HTMLButtonElement>('.pl-appbar__back')!.click();
    expect(route.value).toEqual(routeOf('map'));
  });
});

describe('Audition: when it cannot be taken', () => {
  it('shows no Start button, only the Locked line with the requirement', async () => {
    const c = await showAudition();
    const locked = byTestId(c, 'audition-locked')!;
    expect(textOf(locked)).toContain('Locked.');
    expect(textOf(locked)).toContain('Pass Range finder to unlock the audition.');
    expect(locked.getAttribute('data-locked')).toBe('true');
    expect(locked.querySelector('button')).toBeNull();
    expect(byTestId(c, 'audition-start')).toBeNull();
    expect(byTestId(c, 'action-bar')).toBeNull();
    expect([...c.querySelectorAll('button')].some((b) => /test \d/i.test(textOf(b)))).toBe(false);
    expect(c.querySelector('.pl-btn--primary')).toBeNull();
  });

  it('still lists the tests, none of them next', async () => {
    const c = await showAudition();
    expect(states(c)).toEqual(['ahead', 'ahead', 'ahead', 'ahead']);
  });

  it('shows no Start, and says so, when every test is passed', async () => {
    snapshot.value = snapshotOf(SIREN_END);
    const c = await showAudition();
    expect(byTestId(c, 'audition-start')).toBeNull();
    expect(byTestId(c, 'audition-locked')).toBeNull();
    expect(textOf(byTestId(c, 'audition-done'))).toContain('Every test is passed');
    expect(states(c)).toEqual(['passed', 'passed', 'passed', 'passed']);
  });

  it('shows an empty state for a world with no audition', async () => {
    const c = await showAudition('song-stage', [routeOf('home'), routeOf('audition', { worldId: 'song-stage' })]);
    expect(textOf(c)).toContain('This world has no placement audition.');
    expect(byTestId(c, 'audition-start')).toBeNull();
  });

  it('shows an empty state for a world that does not exist', async () => {
    const c = await showAudition('nowhere', [routeOf('home'), routeOf('audition', { worldId: 'nowhere' })]);
    expect(byTestId(c, 'audition-start')).toBeNull();
    expect(textOf(c)).toContain('No audition here');
  });
});

describe('Audition: the results', () => {
  const missedTwo = () => fakeOutcome({ id: 'miss-2', target: { kind: 'audition', worldId: 'foundations' }, passed: false, exerciseId: TESTS[1] });

  /**
   * What the app does around a run: the intro is shown on its own route entry, the singer taps Start and sings, and the
   * report's "See your placement" opens this screen again with `replace`, which puts a NEW entry on the stack.
   */
  async function arriveFromReport(sing: () => void, worldId = 'foundations'): Promise<HTMLElement> {
    const intro = routeOf('audition', { worldId });
    resetRouterForTests([routeOf('home'), routeOf('map'), intro]);
    installGuardOver(() => snapshot.peek());
    mount(<Audition />).unmount();
    sing();
    // Start put the Sing screen above the intro, and the take turned it into the report.
    resetRouterForTests([routeOf('home'), routeOf('map'), intro, routeOf('report')]);
    installGuardOver(() => snapshot.peek(), () => lastOutcome.peek() !== null);
    replace('audition', { worldId });
    view = mount(<Audition />);
    await flush();
    return view.container;
  }

  /** A run that began with the Range finder sung, passed test 1 (three levels granted) and missed test 2. */
  function sungAndMissed(): void {
    const before = snapshotOf('foundations.01');
    snapshot.value = before;
    beginAuditionRun({ worldId: 'foundations', profileId: 'profile-1', before, attempts: [], testIds: [TESTS[0], TESTS[1]] });
    const passed = passTest(1);
    snapshot.value = snapshotOf('foundations.01', [passed]);
    attemptLog.value = [passed, attempt({ kind: 'audition', exerciseId: TESTS[1], levelId: null, passed: false })];
    lastOutcome.value = missedTwo();
  }

  beforeEach(() => {
    snapshot.value = snapshotOf('foundations.01');
  });

  it('shows where the singer placed, after a miss', async () => {
    const c = await arriveFromReport(sungAndMissed);
    expect(byTestId(c, 'audition-screen')!.dataset.view).toBe('results');
    expect(textOf(c.querySelector('.wl-world__head .pl-label'))).toBe('You placed at');
    expect(textOf(byTestId(c, 'audition-placement'))).toBe('Two notes, one step apart');
    expect(textOf(c.querySelector('.wl-world__head'))).toContain(`Foundations · level 5 of ${ORDER.length}`);
    expect(byTestId(c, 'audition-start')).toBeNull();
  });

  it('reports the tests passed and the one that is not yet', async () => {
    const c = await arriveFromReport(sungAndMissed);
    const summary = textOf(byTestId(c, 'audition-results')!.querySelector('p.pl-body'));
    expect(summary).toContain('1 of 4 tests passed.');
    expect(summary).toContain('Test 2: not yet.');
    expect(summary).toContain('Retake it whenever you like.');
  });

  it('lists what opened against the snapshot from before the run', async () => {
    flow.events = [
      { kind: 'feature', featureId: 'live.cracks', title: 'Cracks marked on your Live line' },
      { kind: 'level-opened', levelId: 'foundations.10', title: 'Two notes, one step apart' },
    ];
    const c = await arriveFromReport(sungAndMissed);
    const items = [...byTestId(c, 'audition-opened')!.querySelectorAll('li')];
    expect(items.map((li) => textOf(li))).toEqual(['Match one note – Hold it steady3 levels passed by audition', 'Cracks marked on your Live line']);
    expect(textOf(c.querySelector('#audition-opened'))).toBe('Opened');
    for (const li of items) expect(li.querySelector('svg')).not.toBeNull();
  });

  it('says nothing new opened, never an alarm, when the run opened nothing', async () => {
    const c = await arriveFromReport(() => {
      const before = snapshotOf('foundations.01');
      snapshot.value = before;
      beginAuditionRun({ worldId: 'foundations', profileId: 'profile-1', before, attempts: [], testIds: [TESTS[0]] });
      lastOutcome.value = fakeOutcome({ id: 'miss-1', target: { kind: 'audition', worldId: 'foundations' }, passed: false, exerciseId: TESTS[0] });
    });
    expect(textOf(byTestId(c, 'audition-placement'))).toBe('Match one note');
    expect(textOf(byTestId(c, 'audition-nothing'))).toBe('Nothing new opened this time. Everything you have earned stays open.');
    expect(byTestId(c, 'audition-opened')).toBeNull();
  });

  it('leaves the opened list out when the start of the run was not recorded', async () => {
    const c = await arriveFromReport(() => {
      snapshot.value = snapshotOf('foundations.01', [passTest(1)]);
      lastOutcome.value = missedTwo();
    });
    expect(byTestId(c, 'audition-screen')!.dataset.view).toBe('results');
    expect(byTestId(c, 'audition-opened')).toBeNull();
    expect(byTestId(c, 'audition-nothing')).toBeNull();
  });

  it('has one primary action, "Go to <level>", which opens that level above the map', async () => {
    const c = await arriveFromReport(sungAndMissed);
    const go = byTestId<HTMLButtonElement>(c, 'audition-go')!;
    expect(textOf(go)).toBe('Go to Two notes, one step apart');
    expect(c.querySelectorAll('.pl-btn--primary')).toHaveLength(1);
    expect(byTestId(c, 'action-bar')!.contains(go)).toBe(true);
    go.click();
    expect(route.value).toEqual(routeOf('level', { levelId: 'foundations.10' }));
    // Back from the level lands on the map at this world, not on the audition again.
    expect(back()).toBe(true);
    expect(route.value).toEqual(routeOf('map', { worldId: 'foundations' }));
    expect(back()).toBe(true);
    expect(route.value).toEqual(routeOf('home'));
  });

  it('offers a quiet secondary button to retake the missed test, which opens the Sing screen again', async () => {
    const c = await arriveFromReport(sungAndMissed);
    const next = byTestId<HTMLButtonElement>(c, 'audition-next')!;
    expect(textOf(next)).toBe('Retake test 2');
    expect(next.classList.contains('pl-btn--secondary')).toBe(true);
    next.click();
    expect(route.value).toEqual(routeOf('sing', { target: 'audition', worldId: 'foundations' }));
    expect(auditionRun.value?.worldId).toBe('foundations');
  });

  it('leaves for the map at this world from the app bar', async () => {
    const c = await arriveFromReport(sungAndMissed);
    c.querySelector<HTMLButtonElement>('.pl-appbar__back')!.click();
    expect(route.value).toEqual(routeOf('map', { worldId: 'foundations' }));
  });

  it('shows the results once: opening the audition again from the map shows the intro', async () => {
    await arriveFromReport(sungAndMissed);
    view!.unmount();
    resetRouterForTests([routeOf('home'), routeOf('map'), routeOf('audition', { worldId: 'foundations' })]);
    view = mount(<Audition />);
    await flush();
    expect(byTestId(view.container, 'audition-screen')!.dataset.view).toBe('intro');
    expect(auditionRun.value).toBeNull();
  });

  it('shows the intro on the same screen when Back is pressed from the results', async () => {
    const c = await arriveFromReport(sungAndMissed);
    expect(byTestId(c, 'audition-screen')!.dataset.view).toBe('results');
    back();
    await flush();
    expect(byTestId(c, 'audition-screen')!.dataset.view).toBe('intro');
    expect(textOf(byTestId(c, 'audition-start'))).toBe('Retake test 2');
  });

  it('shows the placement when the singer stops early with "See your placement" after a pass, and offers to go on', async () => {
    const c = await arriveFromReport(() => {
      const before = snapshotOf('foundations.01');
      snapshot.value = before;
      beginAuditionRun({ worldId: 'foundations', profileId: 'profile-1', before, attempts: [], testIds: [TESTS[0]] });
      const passed = passTest(1);
      snapshot.value = snapshotOf('foundations.01', [passed]);
      attemptLog.value = [passed];
      lastOutcome.value = fakeOutcome({ id: 'pass-1', target: { kind: 'audition', worldId: 'foundations' }, passed: true, exerciseId: TESTS[0] });
    });
    expect(byTestId(c, 'audition-screen')!.dataset.view).toBe('results');
    expect(textOf(byTestId(c, 'audition-placement'))).toBe('Two notes, one step apart');
    expect(textOf(byTestId(c, 'audition-results')!.querySelector('p.pl-body'))).toBe('1 of 4 tests passed.');
    expect(textOf(byTestId(c, 'audition-opened')!)).toContain('Match one note');
    expect(textOf(byTestId(c, 'audition-next'))).toBe('Start test 2');
  });

  it('ends on the last test too, once nothing is left to open, with nothing more to sing', async () => {
    const c = await arriveFromReport(() => {
      const before = snapshotOf(JUMPS_END);
      snapshot.value = before;
      beginAuditionRun({ worldId: 'foundations', profileId: 'profile-1', before, attempts: [], testIds: [TESTS[2], TESTS[3]] });
      snapshot.value = snapshotOf(SIREN_END);
      lastOutcome.value = fakeOutcome({ id: 'last', target: { kind: 'audition', worldId: 'foundations' }, passed: true, exerciseId: TESTS[3] });
    });
    expect(byTestId(c, 'audition-screen')!.dataset.view).toBe('results');
    // No test covers Clean starts: the run leaves the singer there, the lesson before the Boss Recital.
    expect(textOf(byTestId(c, 'audition-placement'))).toBe('Clean starts');
    expect(textOf(c.querySelector('.wl-world__head'))).toContain(`Foundations · level ${ORDER.length - 1} of ${ORDER.length}`);
    expect(textOf(byTestId(c, 'audition-go'))).toBe('Go to Clean starts');
    expect(textOf(byTestId(c, 'audition-results')!.querySelector('p.pl-body'))).toContain('4 of 4 tests passed.');
    expect(textOf(byTestId(c, 'audition-opened')!)).toContain('Three notes: do-re-mi');
    expect(byTestId(c, 'audition-next')).toBeNull();
  });

  it('places the singer at the Boss Recital when everything before it is passed', async () => {
    const c = await arriveFromReport(() => {
      const before = snapshotOf(JUMPS_END);
      snapshot.value = before;
      beginAuditionRun({ worldId: 'foundations', profileId: 'profile-1', before, attempts: [], testIds: [TESTS[2], TESTS[3]] });
      snapshot.value = snapshotOf(BEFORE_BOSS);
      lastOutcome.value = fakeOutcome({ id: 'last', target: { kind: 'audition', worldId: 'foundations' }, passed: true, exerciseId: TESTS[3] });
    });
    expect(textOf(byTestId(c, 'audition-placement'))).toBe('Boss Recital');
    expect(textOf(c.querySelector('.wl-world__head'))).toContain('Foundations · Boss Recital');
    expect(textOf(byTestId(c, 'audition-go'))).toBe('Go to the Boss Recital');
  });

  it('shows the intro, not the results, when Back from the report returns to the intro entry', async () => {
    const intro = routeOf('audition', { worldId: 'foundations' });
    resetRouterForTests([routeOf('home'), routeOf('map'), intro]);
    installGuardOver(() => snapshot.peek());
    mount(<Audition />).unmount();
    const before = snapshotOf('foundations.01');
    beginAuditionRun({ worldId: 'foundations', profileId: 'profile-1', before, attempts: [], testIds: [TESTS[0]] });
    snapshot.value = snapshotOf('foundations.01', [passTest(1)]);
    lastOutcome.value = fakeOutcome({ id: 'pass-1', target: { kind: 'audition', worldId: 'foundations' }, passed: true, exerciseId: TESTS[0] });
    // The Sing screen and the report sit above the intro; Back from the report pops to the intro's own entry.
    resetRouterForTests([routeOf('home'), routeOf('map'), intro, routeOf('report')]);
    back();
    view = mount(<Audition />);
    await flush();
    expect(byTestId(view.container, 'audition-screen')!.dataset.view).toBe('intro');
    expect(textOf(byTestId(view.container, 'audition-start'))).toBe('Start test 2');
    // The run is still open: the next Start keeps its baseline.
    expect(auditionRun.value?.before).toBe(before);
  });

  it('ignores the last take when it was not an audition of this world', async () => {
    const c = await arriveFromReport(() => {
      lastOutcome.value = fakeOutcome({ id: 'level-take', passed: false });
    });
    expect(byTestId(c, 'audition-screen')!.dataset.view).toBe('intro');
  });

  it('says the whole world is passed when the audition leaves nothing in front of the singer', async () => {
    const c = await arriveFromReport(() => {
      const before = snapshotOf(BEFORE_BOSS);
      snapshot.value = before;
      beginAuditionRun({ worldId: 'foundations', profileId: 'profile-1', before, attempts: [], testIds: [] });
      snapshot.value = snapshotOf('foundations.boss');
      lastOutcome.value = fakeOutcome({ id: 'done', target: { kind: 'audition', worldId: 'foundations' }, passed: true, exerciseId: TESTS[3] });
    });
    expect(textOf(byTestId(c, 'audition-placement'))).toBe('Every Foundations level');
    expect(textOf(byTestId(c, 'audition-go'))).toBe('Back to the world map');
    byTestId<HTMLButtonElement>(c, 'audition-go')!.click();
    expect(route.value).toEqual(routeOf('map', { worldId: 'foundations' }));
  });
});
