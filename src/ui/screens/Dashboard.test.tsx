// @vitest-environment happy-dom
/**
 * The progress dashboard against the real catalog and the real progress engine: what it shows is derived from the
 * attempt log, skills appear only with their world, and every chart has its table.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'preact/test-utils';
import { render } from 'preact';
import type { KVStore } from '../../storage/kv-types';

vi.mock('../../storage/kv', () => ({
  openKV: async (): Promise<KVStore> => ({ persistent: true, get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] }),
}));
// The check-up engine and its session belong to other builders: the dashboard is tested against the contract's doubles.
vi.mock('../../runtime/checkup', async () => (await import('../checkup/test-support')).checkupRuntimeModule());
vi.mock('../../checkup/summary', async () => (await import('../checkup/test-support')).summaryModule());

import { CHECKUP_SKILLS } from '../../checkup/skills';
import { checkupsOf } from '../../checkup/summary';
import { installRouteGuard, resetRouterForTests, route, routeOf } from '../../router';
import { abandonCheckup, activeCheckup } from '../../runtime/checkup';
import { activeProfile, attemptLog, snapshot } from '../../state/session';
import type { AttemptRecord } from '../../storage/schema';
import { sessionOf, skill, summaryOf } from '../checkup/test-support';
import { formatDate } from '../progress/format';
import { attemptAt, passWorld, profileRecord, snapshotOf } from '../progress/test-fixtures';
import { Dashboard } from './Dashboard';

let container: HTMLElement;

function show(attempts: AttemptRecord[], range: Parameters<typeof profileRecord>[0]['range'] = null): void {
  attemptLog.value = attempts;
  snapshot.value = snapshotOf(attempts);
  activeProfile.value = profileRecord({ id: 'profile-1', name: 'Daniel', voiceType: 'tenor', range });
}

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(() => {
    render(<Dashboard />, container);
  });
}

const skillLabels = (): string[] => Array.from(container.querySelectorAll('.pl-dash-skill__label')).map((n) => n.textContent ?? '');
const text = (): string => container.textContent ?? '';

beforeEach(() => {
  resetRouterForTests();
  activeCheckup.value = null;
  vi.mocked(checkupsOf).mockReset();
  vi.mocked(checkupsOf).mockReturnValue([]);
  vi.mocked(abandonCheckup).mockClear();
});

afterEach(() => {
  render(null, container);
  container.remove();
  attemptLog.value = [];
  snapshot.value = snapshotOf([]);
  activeProfile.value = null;
});

describe('Dashboard: gating', () => {
  it('is a locked line, and nothing else, before the first level is passed', async () => {
    show([]);
    await mount();
    expect(container.querySelector('[data-testid="dashboard-screen"]')).not.toBeNull();
    expect(text()).toContain('Pass your first level to see the progress dashboard.');
    expect(container.querySelector('.pl-dash-card')).toBeNull();
    expect(container.querySelector('[data-testid="momentum-value"]')).toBeNull();
  });
});

describe('Dashboard: skills show only with their world', () => {
  it('lists the four Foundations skills early on, and none of the later ones', async () => {
    show([attemptAt('foundations.01', { daysAgo: 1, metrics: { 'range.spanSemitones': 17 } }), attemptAt('foundations.02', { metrics: { 'accuracy.inTolerancePct': 88, 'accuracy.sdCents': 11 } })]);
    await mount();
    expect(skillLabels()).toEqual(['Accuracy', 'Stability', 'Crispness', 'Transitions']);
    for (const locked of ['Vibrato', 'Inflections', 'Runs', 'Dynamics']) expect(skillLabels()).not.toContain(locked);
  });

  it('adds Vibrato with the Vibrato world, but not the worlds beyond it', async () => {
    show(passWorld('foundations'));
    await mount();
    expect(skillLabels()).toEqual(['Accuracy', 'Stability', 'Crispness', 'Transitions', 'Vibrato']);
  });

  it('shows the latest value and says when a skill has no takes yet', async () => {
    show([attemptAt('foundations.01'), attemptAt('foundations.02', { metrics: { 'accuracy.medianAbsCents': 9, 'accuracy.inTolerancePct': 88 } })]);
    await mount();
    const rows = Array.from(container.querySelectorAll('.pl-dash-skill'));
    const accuracy = rows.find((r) => r.textContent?.includes('Accuracy'))!;
    expect(accuracy.textContent).toContain('9¢'); // the typical miss: the same at every tolerance
    expect(accuracy.textContent).toContain('lower is better');
    const crispness = rows.find((r) => r.textContent?.includes('Crispness'))!;
    expect(crispness.textContent).toContain('No takes in 30 days');
  });

  it('says which tolerance a Transitions line follows, since its figure is judged against one', async () => {
    show([attemptAt('foundations.01'), attemptAt('foundations.09', { metrics: { 'transition.cleanRate': 0.75 } })]);
    await mount();
    const rows = Array.from(container.querySelectorAll('.pl-dash-skill'));
    const transitions = rows.find((r) => r.textContent?.includes('Transitions'))!;
    expect(transitions.textContent).toContain('Clean changes at ±10¢');
    expect(transitions.textContent).toContain('75%');
  });
});

describe('Dashboard: the numbers behind the charts', () => {
  it('expands a skill into a table of its last values', async () => {
    show([
      attemptAt('foundations.01'),
      attemptAt('foundations.02', { daysAgo: 2, metrics: { 'accuracy.medianAbsCents': 17 } }),
      attemptAt('foundations.02', { daysAgo: 0, metrics: { 'accuracy.medianAbsCents': 8 } }),
    ]);
    await mount();
    const head = Array.from(container.querySelectorAll<HTMLButtonElement>('.pl-dash-skill__head')).find((b) => b.textContent?.includes('Accuracy'))!;
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(head.getAttribute('aria-label')).toContain('Show as table');
    await act(() => {
      head.click();
    });
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(head.getAttribute('aria-label')).toContain('Hide the table');
    const rows = Array.from(container.querySelectorAll('#dash-skill-accuracy tbody tr')).map((tr) => tr.textContent);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('8¢'); // newest first
    expect(rows[1]).toContain('17¢');
  });

  it('gives Momentum a "Show as table" toggle that swaps the bars for the days', async () => {
    show([attemptAt('foundations.01', { daysAgo: 2, durationSec: 600 }), attemptAt('foundations.02', { daysAgo: 0, durationSec: 600 })]);
    await mount();
    const card = container.querySelector('[data-testid="dash-momentum"]')!;
    expect(card.querySelector('svg.pl-dash-bars')).not.toBeNull();
    expect(card.querySelectorAll('.pl-dash-bar--sung')).toHaveLength(3); // two sung days + the legend swatch
    expect(card.querySelectorAll('.pl-dash-bar--rest').length).toBeGreaterThanOrEqual(1);
    const toggle = card.querySelector<HTMLButtonElement>('.pl-dash-toggle')!;
    expect(toggle.textContent).toContain('Show as table');
    await act(() => {
      toggle.click();
    });
    expect(card.querySelector('svg.pl-dash-bars')).toBeNull();
    expect(Array.from(card.querySelectorAll('tbody tr')).map((tr) => tr.lastElementChild?.textContent)).toEqual(['10 min', 'Rest day', '10 min']);
    expect(toggle.textContent).toContain('Show chart');
  });

  it('shows Momentum as a whole number with the sentence that rest days keep it', async () => {
    show(Array.from({ length: 3 }, (_, i) => attemptAt('foundations.01', { daysAgo: 2 - i, durationSec: 600 })));
    await mount();
    const value = container.querySelector('[data-testid="momentum-value"]')!.textContent ?? '';
    expect(value).toMatch(/^\d+$/);
    expect(Number(value)).toBeGreaterThan(0);
    expect(text()).toContain('Rest days keep it. It never drops to zero.');
  });
});

describe('Dashboard: level map, range, bests, practice', () => {
  it('counts the levels of each open world and names what unlocks the next', async () => {
    show(passWorld('foundations', 'foundations.04'));
    await mount();
    const levels = container.querySelector('[data-testid="dash-levels"]')!;
    expect(levels.textContent).toContain('4 of 10 levels · Next: Sirens & glides');
    const fill = levels.querySelector<HTMLElement>('.pl-dash-meter__fill')!;
    expect(fill.style.width).toBe('40%');
    expect(levels.querySelector('button')!.getAttribute('aria-label')).toContain('4 of 10 levels');
    expect(levels.textContent).toContain('Pass the Foundations Boss Recital to unlock Vibrato.');
  });

  it('shows the saved range in note names, with the Range finder spans as a chart and a table', async () => {
    show(
      [
        attemptAt('foundations.01', { daysAgo: 20, metrics: { 'range.spanSemitones': 14 } }),
        attemptAt('foundations.01', { daysAgo: 1, metrics: { 'range.spanSemitones': 19 } }),
      ],
      { comfortable: { low: 48, high: 69 }, extended: { low: 45, high: 72 }, measuredAt: '2026-10-01T10:00:00.000Z' },
    );
    await mount();
    const card = container.querySelector('[data-testid="dash-range"]')!;
    expect(card.textContent).toContain('C3 to A4');
    expect(card.textContent).toContain('A2 to C5');
    expect(card.querySelectorAll('.pl-dash-range__dot')).toHaveLength(2);
    await act(() => {
      card.querySelector<HTMLButtonElement>('.pl-dash-toggle')!.click();
    });
    const rows = Array.from(card.querySelectorAll('tbody tr')).map((tr) => tr.lastElementChild?.textContent);
    expect(rows).toEqual(['19 semitones', '14 semitones']);
  });

  it('lists personal bests once records are open', async () => {
    show([
      attemptAt('foundations.01', { daysAgo: 3, metrics: { 'range.spanSemitones': 17 } }),
      attemptAt('foundations.02', { daysAgo: 0, metrics: { 'accuracy.inTolerancePct': 92, 'accuracy.medianAbsCents': 8, 'onset.settleMs': 210 } }),
    ]);
    await mount();
    const bests = container.querySelector('[data-testid="dash-bests"]')!;
    expect(bests.textContent).toContain('Pitch match');
    expect(bests.textContent).toContain('In tune 92%');
    expect(bests.textContent).toContain('Settle 210 ms');
  });

  it('draws a single Range finder measurement as one dot with no line', async () => {
    show([attemptAt('foundations.01', { daysAgo: 2, metrics: { 'range.spanSemitones': 15 } })]);
    await mount();
    const card = container.querySelector('[data-testid="dash-range"]')!;
    expect(card.querySelectorAll('.pl-dash-range__dot')).toHaveLength(1);
    expect(card.querySelector('.pl-dash-range__line')).toBeNull();
    expect(card.textContent).toContain('Your range is not measured yet'); // no saved range on this profile
  });

  it('shows six personal bests, and all of them on request', async () => {
    // One set of metrics that every Foundations level scores at least one of, so each passed level has a record.
    const metrics = { 'range.spanSemitones': 16, 'accuracy.inTolerancePct': 90, 'accuracy.sdCents': 10, 'accuracy.medianAbsCents': 9, 'glide.smoothness': 0.8, 'glide.cracks': 0, 'glide.endAbsCents': 12 };
    const attempts = passWorld('foundations', 'foundations.09', { metrics });
    show(attempts);
    await mount();
    const card = container.querySelector('[data-testid="dash-bests"]')!;
    const rows = (): number => card.querySelectorAll('.pl-dash-best').length;
    expect(rows()).toBe(6);
    const more = Array.from(card.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.startsWith('Show all'))!;
    await act(() => {
      more.click();
    });
    expect(rows()).toBe(8); // every passed level but the Range finder, whose span is a measurement, not a record
    expect(more.textContent).toBe('Show fewer');
  });

  it('compares the last 7 days of practice with the 7 before', async () => {
    show([
      attemptAt('foundations.01', { daysAgo: 0, durationSec: 600 }),
      attemptAt('foundations.01', { daysAgo: 8, durationSec: 1200 }),
    ]);
    await mount();
    expect(container.querySelector('[data-testid="practice-recent"]')!.textContent).toBe('10 min');
    expect(container.querySelector('[data-testid="practice-before"]')!.textContent).toBe('20 min');
    expect(container.querySelector('[data-testid="dash-practice"]')!.textContent).toContain('Down 10 min from the week before');
  });
});

describe('Dashboard: check-ups', () => {
  const card = (): Element | null => container.querySelector('[data-testid="dash-checkups"]');
  const rows = (): HTMLButtonElement[] => Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="dash-checkup-row"]'));
  const open = (): void => {
    show([attemptAt('foundations.01', { daysAgo: 1 }), attemptAt('foundations.02', { daysAgo: 0 })]);
    installRouteGuard(() => ({ ok: true }));
  };

  it('is a card of the dashboard, after the skills, only once the dashboard is open', async () => {
    show([]);
    await mount();
    expect(card()).toBeNull();
    render(null, container);
    container.remove();
    open();
    await mount();
    const ids = Array.from(container.querySelectorAll('.pl-dash-card')).map((c) => c.getAttribute('data-testid'));
    expect(ids).toContain('dash-checkups');
    expect(ids.indexOf('dash-checkups')).toBe(ids.indexOf('dash-skills') + 1);
    expect(card()!.classList.contains('pl-card')).toBe(true);
    expect(card()!.querySelector('h2')!.textContent).toBe('Check-ups');
  });

  it('offers to take the first check-up before there is one', async () => {
    open();
    await mount();
    expect(card()!.textContent).toContain('A voice check-up takes about four minutes.');
    expect(rows()).toHaveLength(0);
    expect(container.querySelector('[data-testid="dash-checkup-recheck"]')).toBeNull();
    container.querySelector<HTMLButtonElement>('[data-testid="dash-checkup-take"]')!.click();
    expect(route.value).toEqual(routeOf('checkup'));
  });

  it('lists each check-up newest first with its date and its focus, each opening its results', async () => {
    open();
    const older = summaryOf('older', { daysAgo: 12, focus: ['slides'] });
    const newer = summaryOf('newer', { daysAgo: 2, focus: [] });
    vi.mocked(checkupsOf).mockReturnValue([older, newer]);
    await mount();
    expect(rows().map((r) => r.querySelector('.ck-dash__date')!.textContent)).toEqual([formatDate(newer.finishedAt), formatDate(older.finishedAt)]);
    expect(rows().map((r) => r.querySelector('.pl-body-s')!.textContent)).toEqual(['Everything measured is solid', 'Focus: slides']);
    expect(rows()[1].getAttribute('aria-label')).toBe(`Check-up of ${formatDate(older.finishedAt)}. Focus: slides. Open the results.`);
    rows()[1].click();
    expect(route.value).toEqual(routeOf('checkup-results', { checkupId: 'older' }));
  });

  it('says nothing could be measured for a check-up that measured nothing, not that everything is solid', async () => {
    open();
    const silent = CHECKUP_SKILLS.map((s) => skill(s, 'not-measured'));
    vi.mocked(checkupsOf).mockReturnValue([summaryOf('silent', { daysAgo: 2, focus: [], skills: silent })]);
    await mount();
    expect(rows()[0].querySelector('.pl-body-s')!.textContent).toBe('Nothing could be measured');
  });

  it('keeps every row a touch target of its own', async () => {
    open();
    vi.mocked(checkupsOf).mockReturnValue([summaryOf('a', { daysAgo: 30 }), summaryOf('b', { daysAgo: 1 })]);
    await mount();
    expect(rows()).toHaveLength(2);
    for (const row of rows()) expect(row.tagName).toBe('BUTTON');
  });

  it('offers a Re-check once the last check-up is three weeks old, and not before', async () => {
    open();
    vi.mocked(checkupsOf).mockReturnValue([summaryOf('recent', { daysAgo: 20 })]);
    await mount();
    expect(container.querySelector('[data-testid="dash-checkup-recheck"]')).toBeNull();
    render(null, container);
    container.remove();
    open();
    vi.mocked(checkupsOf).mockReturnValue([summaryOf('old', { daysAgo: 21 })]);
    await mount();
    const recheck = container.querySelector<HTMLButtonElement>('[data-testid="dash-checkup-recheck"]')!;
    expect(recheck.textContent).toBe('Re-check');
    recheck.click();
    expect(route.value).toEqual(routeOf('checkup'));
  });

  it('drops a finished check-up still in memory before a re-check, so the intro shows and not the old results', async () => {
    open();
    vi.mocked(checkupsOf).mockReturnValue([summaryOf('old', { daysAgo: 30 })]);
    activeCheckup.value = sessionOf(5, { finishedAt: '2026-09-22T14:05:00.000Z' });
    await mount();
    container.querySelector<HTMLButtonElement>('[data-testid="dash-checkup-recheck"]')!.click();
    expect(abandonCheckup).toHaveBeenCalledTimes(1);
    expect(activeCheckup.value).toBeNull();
  });

  it('keeps a check-up left part way when a re-check is due', async () => {
    open();
    vi.mocked(checkupsOf).mockReturnValue([summaryOf('old', { daysAgo: 30 })]);
    const part = sessionOf(2);
    activeCheckup.value = part;
    await mount();
    container.querySelector<HTMLButtonElement>('[data-testid="dash-checkup-recheck"]')!.click();
    expect(abandonCheckup).not.toHaveBeenCalled();
    expect(activeCheckup.value).toBe(part);
  });
});
