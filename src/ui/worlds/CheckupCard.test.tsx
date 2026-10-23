// @vitest-environment happy-dom
/**
 * Home's voice check-up card in each of its five states (src/ui/checkup/home-card.ts decides which): the first step of
 * a new profile, an invitation for one that has sung, a check-up left part way, a re-check, and the latest results. It
 * only invites: it opens the check-up's own screen, or the results.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../state/session', async () => (await import('../checkup/test-support')).sessionModule());
vi.mock('../../state/settings', async () => (await import('../checkup/test-support')).settingsDouble());
vi.mock('../../runtime/checkup', async () => (await import('../checkup/test-support')).checkupRuntimeModule());
vi.mock('../../checkup/summary', async () => (await import('../checkup/test-support')).summaryModule());

import { CHECKUP_SKILLS } from '../../checkup/skills';
import { jargonIn } from '../../coaching/plain';
import { installRouteGuard, resetRouterForTests, route, routeOf } from '../../router';
import { abandonCheckup, activeCheckup } from '../../runtime/checkup';
import { homeCard, type HomeCardInput } from '../checkup/home-card';
import { PITCH_SHORT } from '../checkup/model';
import { byTestId, flush, mount, sessionOf, skill, summaryOf, textOf, type Mounted } from '../checkup/test-support';
import { formatDate } from '../progress/format';
import { CheckupCard } from './CheckupCard';

const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const none: HomeCardInput = { summaries: [], session: null, hasSung: false, now: NOW };
let view: Mounted | null = null;

async function show(input: Partial<HomeCardInput>): Promise<HTMLElement> {
  view = mount(<CheckupCard card={homeCard({ ...none, ...input })} />);
  await flush();
  return view.container;
}

beforeEach(() => {
  resetRouterForTests([routeOf('home')]);
  installRouteGuard(() => ({ ok: true }));
  activeCheckup.value = null;
  vi.mocked(abandonCheckup).mockClear();
});

afterEach(() => {
  view?.unmount();
  view = null;
});

describe('CheckupCard: a profile that has sung nothing', () => {
  it('starts with a 4-minute voice check-up, as the prominent first step with the amber button', async () => {
    const c = await show({});
    const card = byTestId(c, 'checkup-card')!;
    expect(card.dataset.kind).toBe('first');
    expect(card.tagName).toBe('SECTION');
    expect(textOf(card.querySelector('.pl-label'))).toBe('Start here');
    expect(textOf(card.querySelector('h2'))).toBe('Start with a 4-minute voice check-up');
    expect(textOf(card)).toContain(PITCH_SHORT);
    const button = byTestId<HTMLButtonElement>(c, 'checkup-card-button')!;
    expect(textOf(button)).toBe('Start the check-up');
    expect(button.classList.contains('pl-btn--primary')).toBe(true);
    expect(card.classList.contains('ck-card--prominent')).toBe(true);
  });

  it('opens the check-up\'s intro, where Start is, rather than starting a take', async () => {
    const c = await show({});
    byTestId<HTMLButtonElement>(c, 'checkup-card-button')!.click();
    expect(route.value).toEqual(routeOf('checkup'));
  });
});

describe('CheckupCard: a profile that has sung but never took one', () => {
  it('invites with a secondary button (Continue keeps the amber one)', async () => {
    const c = await show({ hasSung: true });
    const card = byTestId(c, 'checkup-card')!;
    expect(card.dataset.kind).toBe('take');
    expect(textOf(card.querySelector('h2'))).toBe('Take your voice check-up');
    expect(textOf(card)).toContain('About four minutes, five short tasks.');
    const button = byTestId<HTMLButtonElement>(c, 'checkup-card-button')!;
    expect(textOf(button)).toBe('Take the check-up');
    expect(button.classList.contains('pl-btn--secondary')).toBe(true);
    expect(card.classList.contains('ck-card--standard')).toBe(true);
    button.click();
    expect(route.value).toEqual(routeOf('checkup'));
  });
});

describe('CheckupCard: a check-up left part way', () => {
  it('says which task is next and continues it, keeping what was sung', async () => {
    const part = sessionOf(2);
    activeCheckup.value = part;
    const c = await show({ hasSung: true, session: part });
    const card = byTestId(c, 'checkup-card')!;
    expect(card.dataset.kind).toBe('continue');
    expect(textOf(card.querySelector('h2'))).toBe('Finish your voice check-up');
    expect(textOf(card)).toContain('Task 3 of 5 is next. The tasks you have sung are saved.');
    const button = byTestId<HTMLButtonElement>(c, 'checkup-card-button')!;
    expect(textOf(button)).toBe('Continue the check-up');
    expect(button.classList.contains('pl-btn--primary')).toBe(true);
    button.click();
    expect(abandonCheckup).not.toHaveBeenCalled();
    expect(activeCheckup.value).toBe(part);
    expect(route.value).toEqual(routeOf('checkup'));
  });
});

describe('CheckupCard: time for a re-check', () => {
  const old = summaryOf('old', { daysAgo: 24, now: NOW });

  it('says how long it has been and offers the same five tasks again', async () => {
    const c = await show({ hasSung: true, summaries: [old] });
    const card = byTestId(c, 'checkup-card')!;
    expect(card.dataset.kind).toBe('recheck');
    expect(textOf(card.querySelector('h2'))).toBe('Time for a re-check');
    expect(textOf(card)).toContain('It has been 3 weeks since your last check-up. Sing the same five tasks to see how far you have come.');
    const button = byTestId<HTMLButtonElement>(c, 'checkup-card-button')!;
    expect(textOf(button)).toBe('Re-check');
    expect(button.classList.contains('pl-btn--secondary')).toBe(true);
  });

  it('opens the intro, dropping the finished check-up still in memory so the old results do not show', async () => {
    activeCheckup.value = sessionOf(5, { finishedAt: '2026-10-01T14:05:00.000Z' });
    const c = await show({ hasSung: true, summaries: [old] });
    byTestId<HTMLButtonElement>(c, 'checkup-card-button')!.click();
    expect(abandonCheckup).toHaveBeenCalledTimes(1);
    expect(activeCheckup.value).toBeNull();
    expect(route.value).toEqual(routeOf('checkup'));
  });
});

describe('CheckupCard: the latest results', () => {
  const recent = summaryOf('recent', { daysAgo: 4, now: NOW, focus: ['slides', 'starts'] });

  it('is a quiet row with the date and the focus, and no button of its own', async () => {
    const c = await show({ hasSung: true, summaries: [summaryOf('older', { daysAgo: 40, now: NOW }), recent] });
    const card = byTestId(c, 'checkup-card')!;
    expect(card.dataset.kind).toBe('latest');
    expect(card.tagName).toBe('BUTTON');
    expect(card.querySelector('.pl-btn')).toBeNull();
    expect(textOf(card.querySelector('.pl-label'))).toBe('Voice check-up');
    expect(textOf(card.querySelector('.ck-card__row-title'))).toBe(`Last check-up · ${formatDate(recent.finishedAt)}`);
    expect(textOf(card)).toContain('Focus: slides and note starts');
    expect(card.getAttribute('aria-label')).toBe(`Last check-up, ${formatDate(recent.finishedAt)}. Focus: slides and note starts. Open the results.`);
  });

  it('opens the results of the latest check-up', async () => {
    const c = await show({ hasSung: true, summaries: [recent] });
    byTestId<HTMLButtonElement>(c, 'checkup-card')!.click();
    expect(route.value).toEqual(routeOf('checkup-results', { checkupId: 'recent' }));
  });

  it('says everything measured is solid when nothing needs focus', async () => {
    const c = await show({ hasSung: true, summaries: [summaryOf('solid', { daysAgo: 2, now: NOW, focus: [] })] });
    expect(textOf(byTestId(c, 'checkup-card'))).toContain('Everything measured is solid');
  });

  it('says nothing could be measured, never that everything is solid, when no skill came through', async () => {
    const silent = CHECKUP_SKILLS.map((s) => skill(s, 'not-measured'));
    const c = await show({ hasSung: true, summaries: [summaryOf('silent', { daysAgo: 2, now: NOW, focus: [], skills: silent })] });
    expect(textOf(byTestId(c, 'checkup-card'))).toContain('Nothing could be measured');
    expect(textOf(byTestId(c, 'checkup-card'))).not.toContain('solid');
  });
});

describe('CheckupCard: plain words in every state', () => {
  const states: Array<[string, Partial<HomeCardInput>]> = [
    ['first', {}],
    ['take', { hasSung: true }],
    ['continue', { hasSung: true, session: sessionOf(3) }],
    ['recheck', { hasSung: true, summaries: [summaryOf('old', { daysAgo: 70, now: NOW })] }],
    ['latest', { hasSung: true, summaries: [summaryOf('new', { daysAgo: 1, now: NOW })] }],
  ];

  it.each(states)('%s has no jargon, no exclamation mark and no push, force or strain', async (_kind, input) => {
    const c = await show(input);
    const text = textOf(byTestId(c, 'checkup-card'));
    expect(text.length).toBeGreaterThan(20);
    expect(jargonIn(text)).toEqual([]);
    expect(text).not.toMatch(/\b(push|force|strain)\b/i);
  });

  it('puts the amber button on the first step and on a check-up to finish, and nowhere else', async () => {
    const amber = async (input: Partial<HomeCardInput>): Promise<number> => {
      view?.unmount();
      const c = await show(input);
      return c.querySelectorAll('.pl-btn--primary').length;
    };
    expect(await amber({})).toBe(1);
    expect(await amber({ hasSung: true, session: sessionOf(2) })).toBe(1);
    expect(await amber({ hasSung: true })).toBe(0);
    expect(await amber({ hasSung: true, summaries: [summaryOf('old', { daysAgo: 70, now: NOW })] })).toBe(0);
    expect(await amber({ hasSung: true, summaries: [summaryOf('new', { daysAgo: 1, now: NOW })] })).toBe(0);
  });
});
