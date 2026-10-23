// @vitest-environment happy-dom
/**
 * The voice check-up screen (docs/DESIGN.md 11-13), in its three states and the one error: the intro (two plain
 * sentences, the five tasks, Start), a check-up left part way ("Task 3 of 5", Continue), and the results once the last
 * task was sung (the range, each skill with its rating as a word and a glyph, what to focus on and where to practise it,
 * where you start, what opened, and from the second check-up on "Then and now"). The session, the check-up session and
 * the check-up engine are doubles; the catalog, the unlock registry, the router and the route guard rules are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../state/session', async () => (await import('../checkup/test-support')).sessionModule());
vi.mock('../../state/settings', async () => (await import('../checkup/test-support')).settingsDouble());
vi.mock('../../runtime/checkup', async () => (await import('../checkup/test-support')).checkupRuntimeModule());
vi.mock('../../checkup/summary', async () => (await import('../checkup/test-support')).summaryModule());

import { CHECKUP_SKILLS } from '../../checkup/skills';
import { checkupsOf, compareCheckups } from '../../checkup/summary';
import { CHECKUP_TASKS } from '../../checkup/types';
import { jargonIn } from '../../coaching/plain';
import { WORLDS } from '../../exercises';
import { levelRequirementHint } from '../../progress';
import { back, canGoBack, installRouteGuard, resetRouterForTests, route, routeOf } from '../../router';
import { activeCheckup, startCheckup } from '../../runtime/checkup';
import { attemptLog, snapshot } from '../../state/session';
import { FOCUS_PRACTISE } from '../checkup/model';
import { byTestId, comparisonOf, flush, mount, sessionOf, skill, snapshotOf, summaryOf, textOf, typicalSkills, type Mounted } from '../checkup/test-support';
import { formatDate } from '../progress/format';
import { Checkup } from './Checkup';

let view: Mounted | null = null;

async function show(): Promise<HTMLElement> {
  view = mount(<Checkup />);
  await flush();
  return view.container;
}

const skillRows = (c: HTMLElement): string[] => [...c.querySelectorAll('[data-testid="checkup-skills"] li')].map((li) => li.getAttribute('data-skill') ?? '');

beforeEach(() => {
  resetRouterForTests([routeOf('home'), routeOf('checkup')]);
  installRouteGuard(() => ({ ok: true }));
  activeCheckup.value = null;
  attemptLog.value = [];
  // Where a typical first check-up leaves a singer: every lesson up to Five notes in a row passed, Small slides next.
  snapshot.value = snapshotOf('foundations.09');
  vi.mocked(checkupsOf).mockReset();
  vi.mocked(checkupsOf).mockReturnValue([]);
  vi.mocked(compareCheckups).mockClear();
  vi.mocked(startCheckup).mockClear();
});

afterEach(() => {
  view?.unmount();
  view = null;
});

describe('Checkup: the intro', () => {
  it('says what it is in two plain sentences, as a check-up and not a test', async () => {
    const c = await show();
    expect(byTestId(c, 'checkup-screen')!.dataset.view).toBe('intro');
    expect(textOf(c.querySelector('.pl-appbar__title'))).toBe('Voice check-up');
    expect(textOf(c.querySelector('.ck-title'))).toBe('A check-up, not a test');
    expect(textOf(byTestId(c, 'checkup-intro'))).toBe(
      'About four minutes: five short tasks so Pitch Lab can find where to start you and what to focus on. Nothing here can lower your progress.',
    );
    expect(textOf(byTestId(c, 'checkup-care'))).toContain('Stop if anything hurts');
  });

  it('lists the five tasks in order with their plain titles and what to do, and no status yet', async () => {
    const c = await show();
    const rows = [...byTestId(c, 'checkup-tasks')!.querySelectorAll('li')];
    expect(byTestId(c, 'checkup-tasks')!.tagName).toBe('OL');
    expect(rows).toHaveLength(5);
    rows.forEach((li, i) => {
      expect(textOf(li.querySelector('.ck-task__n'))).toBe(String(i + 1));
      expect(textOf(li.querySelector('.ck-task__title'))).toBe(CHECKUP_TASKS[i].title);
      expect(textOf(li.querySelector('.ck-task__ask'))).toBe(CHECKUP_TASKS[i].ask);
      expect(li.querySelector('.ck-task__state')).toBeNull();
    });
  });

  it('starts the check-up and opens the first task', async () => {
    const c = await show();
    const start = byTestId<HTMLButtonElement>(c, 'checkup-start')!;
    expect(textOf(start)).toBe('Start');
    expect(start.classList.contains('pl-btn--primary')).toBe(true);
    start.click();
    await flush();
    expect(startCheckup).toHaveBeenCalledTimes(1);
    expect(route.value).toEqual(routeOf('sing', { target: 'checkup', itemIndex: '0' }));
  });

  it('says so, next to the button, when the check-up could not start, and stays here', async () => {
    vi.mocked(startCheckup).mockImplementationOnce(() => {
      throw new Error('Your progress is still loading.');
    });
    const c = await show();
    byTestId<HTMLButtonElement>(c, 'checkup-start')!.click();
    await flush();
    expect(textOf(c.querySelector('[role="alert"]'))).toBe('Could not start the check-up. Your progress is still loading.');
    expect(route.value).toEqual(routeOf('checkup'));
  });

  it('says so when the first task would not open', async () => {
    installRouteGuard(() => ({ ok: false, redirect: routeOf('checkup'), hint: 'Start the check-up first.' }));
    const c = await show();
    byTestId<HTMLButtonElement>(c, 'checkup-start')!.click();
    await flush();
    expect(textOf(c.querySelector('[role="alert"]'))).toBe('The check-up could not open. Go back to Home and try again.');
  });

  it('for a re-check, names the last check-up and links to its results', async () => {
    const last = summaryOf('last', { daysAgo: 30 });
    vi.mocked(checkupsOf).mockReturnValue([summaryOf('older', { daysAgo: 70 }), last]);
    const c = await show();
    expect(textOf(c.querySelector('.ck-head .pl-label'))).toBe('Re-check');
    expect(textOf(byTestId(c, 'checkup-last'))).toBe(
      `These are the same five tasks as your last check-up on ${formatDate(last.finishedAt)}, so Pitch Lab can show how far you have come.`,
    );
    byTestId<HTMLButtonElement>(c, 'checkup-last-results')!.click();
    expect(route.value).toEqual(routeOf('checkup-results', { checkupId: 'last' }));
  });

  it('goes back one screen from the app bar', async () => {
    const c = await show();
    c.querySelector<HTMLButtonElement>('.pl-appbar__back')!.click();
    expect(route.value).toEqual(routeOf('home'));
  });

  it('uses plain words only', async () => {
    const c = await show();
    expect(jargonIn(textOf(c))).toEqual([]);
    expect(textOf(c)).not.toMatch(/\b(push|force|strain)\b/i);
  });
});

describe('Checkup: part way', () => {
  it('shows which task is next, with Continue', async () => {
    activeCheckup.value = sessionOf(2);
    const c = await show();
    expect(byTestId(c, 'checkup-screen')!.dataset.view).toBe('progress');
    expect(textOf(byTestId(c, 'checkup-progress-title'))).toBe('Task 3 of 5');
    expect(textOf(c.querySelector('.ck-head'))).toContain(`${CHECKUP_TASKS[2].title}: ${CHECKUP_TASKS[2].ask}`);
    expect(textOf(c.querySelector('.ck-head'))).toContain('The tasks you have sung are saved.');
    // It promises only what resumeCheckup keeps: a day, even when Pitch Lab is closed (never "whenever you are ready").
    expect(textOf(byTestId(c, 'checkup-resume'))).toBe('The tasks you have sung are saved. Pick up within a day, even after closing Pitch Lab.');
  });

  it('marks each task sung, next or still to come, in words and a glyph', async () => {
    activeCheckup.value = sessionOf(2);
    const c = await show();
    const rows = [...byTestId(c, 'checkup-tasks')!.querySelectorAll('li')];
    expect(rows.map((li) => li.dataset.state)).toEqual(['done', 'done', 'next', 'ahead', 'ahead']);
    expect(rows.map((li) => textOf(li.querySelector('.ck-task__state')))).toEqual(['Sung', 'Sung', 'Next', 'To come', 'To come']);
    for (const li of rows) expect(li.querySelector('.ck-task__state svg')).not.toBeNull();
  });

  it('continues at the next task that was not sung', async () => {
    activeCheckup.value = sessionOf(5, { attemptIds: ['a', null, 'c', 'd', null] });
    const c = await show();
    expect(textOf(byTestId(c, 'checkup-progress-title'))).toBe('Task 2 of 5');
    byTestId<HTMLButtonElement>(c, 'checkup-continue')!.click();
    expect(route.value).toEqual(routeOf('sing', { target: 'checkup', itemIndex: '1' }));
    expect(startCheckup).not.toHaveBeenCalled();
  });

  it('starts over from the first task, dropping what was left', async () => {
    activeCheckup.value = sessionOf(3);
    const c = await show();
    const restart = byTestId<HTMLButtonElement>(c, 'checkup-restart')!;
    expect(textOf(restart)).toBe('Start over');
    expect(restart.classList.contains('pl-btn--ghost')).toBe(true);
    restart.click();
    await flush();
    expect(startCheckup).toHaveBeenCalledTimes(1);
    expect(route.value).toEqual(routeOf('sing', { target: 'checkup', itemIndex: '0' }));
  });

  it('keeps one amber button', async () => {
    activeCheckup.value = sessionOf(1);
    const c = await show();
    expect(c.querySelectorAll('.pl-btn--primary')).toHaveLength(1);
  });

  it('shows the intro, not part way, when nothing was sung yet', async () => {
    activeCheckup.value = sessionOf(0);
    const c = await show();
    expect(byTestId(c, 'checkup-screen')!.dataset.view).toBe('intro');
  });
});

describe('Checkup: the results', () => {
  const first = summaryOf('run-1', { daysAgo: 0 });

  beforeEach(() => {
    vi.mocked(checkupsOf).mockReturnValue([first]);
    activeCheckup.value = sessionOf(5, { finishedAt: '2026-10-22T14:05:00.000Z' });
  });

  it('shows the range in note names', async () => {
    const c = await show();
    expect(byTestId(c, 'checkup-screen')!.dataset.view).toBe('results');
    expect(textOf(c.querySelector('.pl-appbar__title'))).toBe('Check-up results');
    expect(textOf(byTestId(c, 'checkup-range-value'))).toBe('B2–A4');
    expect(textOf(byTestId(c, 'checkup-range'))).toContain(formatDate(first.finishedAt));
  });

  it('says plainly when the range was not measured', async () => {
    const skills = typicalSkills().map((s) => (s.skill === 'range' ? skill('range', 'not-measured', 'No low or high note was held long enough to measure your range.') : s));
    vi.mocked(checkupsOf).mockReturnValue([summaryOf('run-1', { range: null, skills })]);
    const c = await show();
    expect(textOf(byTestId(c, 'checkup-range-value'))).toBe('Not measured');
    expect(textOf(byTestId(c, 'checkup-range'))).toContain('Sing the Range finder again when you are ready.');
    expect(byTestId(c, 'checkup-range-words')).toBeNull();
  });

  it('says the span in the engine\'s words when it has no note names for the range (it kept only the span)', async () => {
    vi.mocked(checkupsOf).mockReturnValue([summaryOf('run-1', { range: null })]);
    const c = await show();
    expect(byTestId(c, 'checkup-range-value')).toBeNull();
    expect(textOf(byTestId(c, 'checkup-range-words'))).toBe('You can sing about an octave and a half comfortably.');
  });

  it('rates every skill as a word and a glyph with its sentence, in the battery order, and never as a grade', async () => {
    const c = await show();
    expect(skillRows(c)).toEqual(['range', 'pitch', 'steadiness', 'starts', 'connected', 'slides']);
    const row = (skill: string): HTMLElement => byTestId(c, `checkup-skill-${skill}`)!;
    const parts = (skill: string): string[] => [row(skill).querySelector('.ck-skill__name'), row(skill).querySelector('.ck-rating'), row(skill).querySelector('.ck-skill__what')].map((el) => textOf(el));
    expect(parts('range')).toEqual(['Range', 'Solid', 'You can sing about an octave and a half comfortably.']);
    expect(parts('steadiness')[1]).toBe('Getting there');
    expect(parts('slides')).toEqual(['Slides', 'Focus here', 'Your voice broke 5 times on the way up and back.']);
    expect(parts('connected')[1]).toBe('Not measured');
    for (const li of c.querySelectorAll('[data-testid="checkup-skills"] li')) {
      expect(li.querySelector('.ck-rating svg'), li.getAttribute('data-skill') ?? '').not.toBeNull();
    }
    expect(textOf(byTestId(c, 'checkup-skills'))).not.toMatch(/fail|wrong|bad|score|%/i);
  });

  it('says what to focus on, what to practise, and offers the level that trains it when it is openable', async () => {
    const c = await show();
    const slides = byTestId(c, 'checkup-focus-slides')!;
    expect(textOf(slides.querySelector('.ck-focus__title'))).toBe('Slides');
    expect(textOf(slides)).toContain(FOCUS_PRACTISE.slides);
    const practise = byTestId<HTMLButtonElement>(c, 'checkup-practise-slides')!;
    expect(textOf(practise)).toBe('Practise Small slides');
    expect(practise.classList.contains('pl-btn--secondary')).toBe(true);
    practise.click();
    expect(route.value).toEqual(routeOf('level', { levelId: 'foundations.12' }));
  });

  it('shows a focus level that is not open yet as a static Locked line, never a button', async () => {
    snapshot.value = snapshotOf(null);
    const c = await show();
    const slides = byTestId(c, 'checkup-focus-slides')!;
    expect(slides.querySelector('button')).toBeNull();
    expect(textOf(slides.querySelector('.pl-locked'))).toContain(levelRequirementHint('foundations.12', snapshot.value, WORLDS)!);
    expect(textOf(slides.querySelector('.pl-locked'))).toContain('Locked.');
  });

  it('offers the level of the skill\'s family the singer is on now, not always the first of it', async () => {
    snapshot.value = snapshotOf('foundations.03');
    vi.mocked(checkupsOf).mockReturnValue([summaryOf('run-1', { focus: ['steadiness'] })]);
    const c = await show();
    expect(byTestId(c, 'checkup-focus-steadiness')!.dataset.level).toBe('foundations.13');
    const practise = byTestId<HTMLButtonElement>(c, 'checkup-practise-steadiness')!;
    expect(textOf(practise)).toBe('Practise Hold it steady');
    practise.click();
    expect(route.value).toEqual(routeOf('level', { levelId: 'foundations.13' }));
  });

  it('names up to two skills to focus on, most important first', async () => {
    vi.mocked(checkupsOf).mockReturnValue([summaryOf('run-1', { focus: ['starts', 'slides'] })]);
    const c = await show();
    expect([...byTestId(c, 'checkup-focus')!.querySelectorAll('.ck-focus__item')].map((li) => li.getAttribute('data-skill'))).toEqual(['starts', 'slides']);
  });

  it('says nothing needs focus when everything measured is solid', async () => {
    vi.mocked(checkupsOf).mockReturnValue([summaryOf('run-1', { focus: [] })]);
    const c = await show();
    expect(textOf(byTestId(c, 'checkup-focus-none'))).toBe('Nothing stands out. Everything measured is solid, so carry on from where you start.');
    expect(byTestId(c, 'checkup-focus')!.querySelector('button')).toBeNull();
  });

  it('says nothing could be measured, rather than everything is solid, when no skill was measured', async () => {
    const silent = CHECKUP_SKILLS.map((s) => skill(s, 'not-measured', 'Nothing came through the microphone on this task, so it was not measured.'));
    vi.mocked(checkupsOf).mockReturnValue([summaryOf('run-1', { focus: [], skills: silent, range: null })]);
    const c = await show();
    expect(textOf(byTestId(c, 'checkup-focus-none'))).toBe(
      'Nothing could be measured this time. Check that the microphone is on, then take the check-up again when you are ready.',
    );
    expect(textOf(byTestId(c, 'checkup-focus'))).not.toMatch(/solid/i);
    expect([...c.querySelectorAll('[data-testid="checkup-skills"] .ck-rating')].map((el) => textOf(el))).toEqual(Array(6).fill('Not measured'));
  });

  it('says where you start, and continues there', async () => {
    const c = await show();
    const start = byTestId(c, 'checkup-start-level')!;
    expect(textOf(start.querySelector('.ck-start__title'))).toBe('Small slides');
    // Named as the map names it: a lesson, by its place in the order.
    expect(textOf(start)).toContain('Lesson 10 of 13 in Foundations. Everything before it is open.');
    const go = byTestId<HTMLButtonElement>(c, 'checkup-continue')!;
    expect(textOf(go)).toBe('Continue');
    expect(go.getAttribute('aria-label')).toBe('Continue to where you start');
    expect(go.classList.contains('pl-btn--primary')).toBe(true);
    go.click();
    // Home sits beneath the level, so Back from the level lands on Home, not on the results.
    expect(route.value).toEqual(routeOf('level', { levelId: 'foundations.12' }));
    expect(back()).toBe(true);
    expect(route.value).toEqual(routeOf('home'));
    expect(canGoBack.value).toBe(false);
  });

  it('does not say everything before it is open when you start at the very first level', async () => {
    vi.mocked(checkupsOf).mockReturnValue([summaryOf('run-1', { startLevelId: 'foundations.01', opened: [] })]);
    snapshot.value = snapshotOf(null);
    const c = await show();
    const start = byTestId(c, 'checkup-start-level')!;
    expect(textOf(start.querySelector('.ck-start__title'))).toBe('Range finder');
    expect(textOf(start)).toContain('Lesson 1 of 13 in Foundations.');
    expect(textOf(start)).not.toContain('Everything before it is open');
    expect(textOf(byTestId(c, 'checkup-continue'))).toBe('Continue');
  });

  it('names the Boss Recital by its world when that is where you start', async () => {
    vi.mocked(checkupsOf).mockReturnValue([summaryOf('run-1', { startLevelId: 'foundations.boss' })]);
    snapshot.value = snapshotOf('foundations.06');
    const c = await show();
    expect(textOf(byTestId(c, 'checkup-start-level')!.querySelector('.ck-start__title'))).toBe('Foundations Boss Recital');
  });

  it('goes back to Home when every Foundations level is already passed', async () => {
    vi.mocked(checkupsOf).mockReturnValue([summaryOf('run-1', { startLevelId: null })]);
    const c = await show();
    expect(textOf(byTestId(c, 'checkup-start-level'))).toContain('You have already passed every Foundations level.');
    const go = byTestId<HTMLButtonElement>(c, 'checkup-continue')!;
    expect(textOf(go)).toBe('Back to Home');
    go.click();
    expect(route.value).toEqual(routeOf('home'));
  });

  it('does not offer a start level that is not open', async () => {
    snapshot.value = snapshotOf(null);
    const c = await show();
    expect(textOf(byTestId(c, 'checkup-continue'))).toBe('Back to Home');
  });

  it('lists what opened as a range of levels', async () => {
    const c = await show();
    expect(textOf(byTestId(c, 'checkup-opened-levels'))).toBe('Match one note – Five notes in a row');
    expect(textOf(byTestId(c, 'checkup-opened'))).toContain('8 levels you showed you can already sing');
    expect(byTestId(c, 'checkup-nothing-opened')).toBeNull();
  });

  it('says nothing new opened when the check-up opened nothing', async () => {
    vi.mocked(checkupsOf).mockReturnValue([summaryOf('run-1', { opened: [] })]);
    const c = await show();
    expect(textOf(byTestId(c, 'checkup-nothing-opened'))).toBe('Nothing new opened this time. Everything you have earned stays open.');
    expect(byTestId(c, 'checkup-opened-levels')).toBeNull();
  });

  it('has no "Then and now" for a first check-up, and offers no pitch lines to compare', async () => {
    const c = await show();
    expect(byTestId(c, 'checkup-compare')).toBeNull();
    expect(byTestId(c, 'checkup-see-lines')).toBeNull();
    expect(compareCheckups).not.toHaveBeenCalled();
  });

  it('keeps one amber button, in the bottom bar', async () => {
    const c = await show();
    expect(c.querySelectorAll('.pl-btn--primary')).toHaveLength(1);
    expect(byTestId(c, 'action-bar')!.contains(byTestId(c, 'checkup-continue'))).toBe(true);
  });

  it('uses plain words only', async () => {
    const c = await show();
    expect(jargonIn(textOf(c))).toEqual([]);
    expect(textOf(c)).not.toMatch(/\b(push|force|strain)\b/i);
  });

  it('leaves to Home from the app bar, not to the run it ends', async () => {
    resetRouterForTests([routeOf('home'), routeOf('checkup'), routeOf('checkup')]);
    installRouteGuard(() => ({ ok: true }));
    const c = await show();
    c.querySelector<HTMLButtonElement>('.pl-appbar__back')!.click();
    expect(route.value).toEqual(routeOf('home'));
    expect(canGoBack.value).toBe(false);
  });
});

describe('Checkup: from the second check-up on', () => {
  const older = summaryOf('older', { daysAgo: 30 });
  const newer = summaryOf('run-1', { daysAgo: 0 });

  beforeEach(() => {
    vi.mocked(checkupsOf).mockReturnValue([older, newer]);
    activeCheckup.value = sessionOf(5, { finishedAt: '2026-10-22T14:05:00.000Z' });
  });

  it('sets it against the one before, with the engine headline and a line per skill', async () => {
    const c = await show();
    expect(compareCheckups).toHaveBeenCalledWith(older, newer);
    const compare = byTestId(c, 'checkup-compare')!;
    expect(textOf(compare.querySelector('h2'))).toBe('Then and now');
    expect(textOf(byTestId(c, 'checkup-headline'))).toBe(comparisonOf(older, newer).headline);
    expect(textOf(compare)).toContain(`Then ${formatDate(older.finishedAt)}. Now ${formatDate(newer.finishedAt)}.`);
    expect(compare.querySelectorAll('[data-testid="checkup-line"]')).toHaveLength(4);
  });

  it('reads each line as old then new, with a verdict in words and a glyph, and a worse line is calm', async () => {
    const c = await show();
    const lines = [...c.querySelectorAll('[data-testid="checkup-line"]')];
    expect(lines.map((li) => textOf(li.querySelector('.ck-line__mark')))).toEqual(['better', 'better', 'not as good', 'about the same']);
    for (const li of lines) expect(li.querySelector('.ck-line__mark svg')).not.toBeNull();
    expect(textOf(lines[0])).toContain('Slides');
    expect(textOf(lines[0])).toContain('Then 5 breaks');
    expect(textOf(lines[0])).toContain('now 1 break');
    expect(lines.map((li) => li.className)).toEqual([
      'ck-line ck-line--better',
      'ck-line ck-line--better',
      'ck-line ck-line--worse',
      'ck-line ck-line--same',
    ]);
  });

  it('puts "Then and now" right after the range, before the skills', async () => {
    const c = await show();
    const order = [...c.querySelectorAll('.ck-summary > *')].map((el) => el.getAttribute('data-testid') ?? el.getAttribute('aria-labelledby'));
    expect(order.indexOf('checkup-compare')).toBe(1);
    expect(order.indexOf('checkup-skills-heading')).toBeGreaterThan(order.indexOf('checkup-compare'));
  });

  it('offers the pitch lines, then and now, on the results screen of this check-up', async () => {
    const c = await show();
    byTestId<HTMLButtonElement>(c, 'checkup-see-lines')!.click();
    expect(route.value).toEqual(routeOf('checkup-results', { checkupId: 'run-1' }));
  });

  it('shows the results without the comparison when the engine cannot make one', async () => {
    vi.mocked(compareCheckups).mockImplementationOnce(() => {
      throw new Error('cannot compare');
    });
    const c = await show();
    expect(byTestId(c, 'checkup-compare')).toBeNull();
    expect(byTestId(c, 'checkup-skills')).not.toBeNull();
  });
});

describe('Checkup: results that cannot be read', () => {
  it('says so, rather than start a second check-up on top, when the last task was sung but no check-up is in the log', async () => {
    activeCheckup.value = sessionOf(5, { finishedAt: '2026-10-22T14:05:00.000Z' });
    const c = await show();
    expect(byTestId(c, 'checkup-screen')!.dataset.view).toBe('unreadable');
    expect(textOf(c.querySelector('[role="alert"]'))).toContain('Your check-up was saved, but its results could not be put together.');
    expect(byTestId(c, 'checkup-start')).toBeNull();
    byTestId<HTMLButtonElement>(c, 'checkup-home')!.click();
    expect(route.value).toEqual(routeOf('home'));
  });

  it('shows the intro when a finished check-up in the log belongs to no running session (a relaunch)', async () => {
    vi.mocked(checkupsOf).mockReturnValue([summaryOf('some-old-one', { daysAgo: 3 })]);
    const c = await show();
    expect(byTestId(c, 'checkup-screen')!.dataset.view).toBe('intro');
  });
});
