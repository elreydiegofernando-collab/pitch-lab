// @vitest-environment happy-dom
/**
 * A past check-up read back and set against the one before it (route 'checkup-results'): the same plain results as the
 * end of the run, "Then and now", and the pitch lines of the held notes and the slide from both check-ups drawn from
 * their saved takes. The session, storage and check-up engine are doubles; the catalog, the analyzers, the codec, the
 * replay canvas and the router are the real ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../state/session', async () => (await import('../checkup/test-support')).sessionModule());
vi.mock('../../state/settings', async () => (await import('../checkup/test-support')).settingsDouble());
vi.mock('../../runtime/checkup', async () => (await import('../checkup/test-support')).checkupRuntimeModule());
vi.mock('../../checkup/summary', async () => (await import('../checkup/test-support')).summaryModule());

import { checkupsOf, compareCheckups } from '../../checkup/summary';
import { CHECKUP_TASKS, type CheckupSummary } from '../../checkup/types';
import { getExercise, realize } from '../../exercises';
import { GOOD_SINGER, singTake } from '../../exercises/test-singer';
import { jargonIn } from '../../coaching/plain';
import { installRouteGuard, resetRouterForTests, route, routeOf } from '../../router';
import { activeCheckup } from '../../runtime/checkup';
import { activeProfile, appStorage, attemptLog, snapshot } from '../../state/session';
import type { AppStorage } from '../../storage';
import type { AttemptRecord, TakeRecord, VocalRange } from '../../storage/schema';
import { encodeTrack } from '../../storage/track-codec';
import { attemptAt, takeRecord } from '../progress/test-fixtures';
import { byTestId, comparisonOf, flush, mount, profileRecord, snapshotOf, summaryOf, textOf, waitUntil, type Mounted } from '../checkup/test-support';
import { NOT_SAVED, NOT_SUNG } from '../checkup/saved-take';
import { formatDate } from '../progress/format';
import { CheckupResults } from './CheckupResults';

const RANGE: VocalRange = { comfortable: { low: 47, high: 69 }, extended: { low: 45, high: 72 }, measuredAt: '2026-10-21T09:00:00.000Z' };
const older = summaryOf('older', { daysAgo: 30 });
const newer = summaryOf('newer', { daysAgo: 0 });

let view: Mounted | null = null;
let get: ReturnType<typeof vi.fn<(id: string) => Promise<TakeRecord | undefined>>>;

/** A pitch line for each exercise, sung once by the synthetic singer and shared by every take that needs one. */
const lines = new Map<string, TakeRecord['track']>();
function lineFor(exerciseId: string): TakeRecord['track'] {
  let line = lines.get(exerciseId);
  if (!line) {
    const def = getExercise(exerciseId)!;
    line = encodeTrack(singTake(realize(def, RANGE, 'tenor', { bpm: def.tempoBpm }), GOOD_SINGER));
    lines.set(exerciseId, line);
  }
  return line;
}

/** The attempts a check-up's tasks wrote, each with a take that `get` can return (unless listed in `unsaved`). */
function attemptsOf(summary: CheckupSummary, unsaved: readonly number[] = []): AttemptRecord[] {
  return summary.tasks.flatMap((t, i): AttemptRecord[] => {
    if (!t.attemptId) return [];
    const def = getExercise(t.exerciseId)!;
    const realized = realize(def, RANGE, 'tenor', { bpm: def.tempoBpm });
    return [
      {
        ...attemptAt('foundations.02'),
        id: t.attemptId,
        kind: 'audition',
        exerciseId: t.exerciseId,
        levelId: null,
        takeId: unsaved.includes(i) ? null : `${t.attemptId}-take`,
        tonicMidi: realized.tonicMidi,
        tempoBpm: realized.bpm,
        checkupId: summary.checkupId,
      },
    ];
  });
}

async function show(checkupId = 'newer'): Promise<HTMLElement> {
  resetRouterForTests([routeOf('home'), routeOf('checkup-results', { checkupId })]);
  installRouteGuard(() => ({ ok: true }));
  view = mount(<CheckupResults />);
  await flush();
  return view.container;
}

const replays = (c: HTMLElement): number => c.querySelectorAll('figure.pl-replay').length;

beforeEach(() => {
  lines.clear();
  activeCheckup.value = null;
  activeProfile.value = { ...profileRecord('Daniel'), range: RANGE };
  snapshot.value = snapshotOf('foundations.04');
  vi.mocked(checkupsOf).mockReset();
  vi.mocked(checkupsOf).mockReturnValue([older, newer]);
  vi.mocked(compareCheckups).mockClear();
  attemptLog.value = [...attemptsOf(older), ...attemptsOf(newer)];
  get = vi.fn(async (id: string) => {
    const attempt = attemptLog.value.find((a) => a.takeId === id);
    return attempt ? takeRecord({ id, exerciseId: attempt.exerciseId, track: lineFor(attempt.exerciseId) }) : undefined;
  });
  appStorage.value = { takes: { get } } as unknown as AppStorage;
});

afterEach(() => {
  view?.unmount();
  view = null;
  appStorage.value = null;
});

describe('CheckupResults: a check-up and the one before it', () => {
  it('shows the past check-up with its date, range, skills, focus and what it opened', async () => {
    const c = await show();
    expect(byTestId(c, 'checkup-results-screen')!.dataset.view).toBe('results');
    expect(textOf(c.querySelector('.pl-appbar__title'))).toBe('Check-up results');
    expect(byTestId(c, 'checkup-summary')!.dataset.view).toBe('past');
    expect(textOf(byTestId(c, 'checkup-range'))).toContain(`Check-up · ${formatDate(newer.finishedAt)}`);
    expect(textOf(byTestId(c, 'checkup-range-value'))).toBe('B2–A4');
    expect(c.querySelectorAll('[data-testid="checkup-skills"] li')).toHaveLength(6);
    expect(byTestId(c, 'checkup-focus-slides')).not.toBeNull();
    expect(byTestId(c, 'checkup-opened')).not.toBeNull();
  });

  it('does not say where to start: that was true when it was sung, not now', async () => {
    const c = await show();
    expect(byTestId(c, 'checkup-start-level')).toBeNull();
    expect(byTestId(c, 'checkup-continue')).toBeNull();
  });

  it('sets it against the check-up before it with "Then and now"', async () => {
    const c = await show();
    expect(compareCheckups).toHaveBeenCalledWith(older, newer);
    expect(textOf(byTestId(c, 'checkup-headline'))).toBe(comparisonOf(older, newer).headline);
    expect(c.querySelectorAll('[data-testid="checkup-line"]').length).toBe(4);
  });

  it('compares the middle one with the one just before it, not with the newest', async () => {
    const middle = summaryOf('middle', { daysAgo: 10 });
    vi.mocked(checkupsOf).mockReturnValue([older, middle, newer]);
    await show('middle');
    expect(compareCheckups).toHaveBeenCalledWith(older, middle);
  });

  it('offers to practise what to focus on, when it is open', async () => {
    const c = await show();
    byTestId<HTMLButtonElement>(c, 'checkup-practise-slides')!.click();
    expect(route.value).toEqual(routeOf('level', { levelId: 'foundations.05' }));
  });

  it('goes back with Done', async () => {
    const c = await show();
    const done = byTestId<HTMLButtonElement>(c, 'checkup-done')!;
    expect(textOf(done)).toBe('Done');
    expect(done.classList.contains('pl-btn--primary')).toBe(true);
    expect(c.querySelectorAll('.pl-btn--primary')).toHaveLength(1);
    done.click();
    expect(route.value).toEqual(routeOf('home'));
  });
});

describe('CheckupResults: the pitch lines, then and now', () => {
  it('draws the held notes and the slide from both check-ups, the older one first, with plain labels', async () => {
    const c = await show();
    const takes = byTestId(c, 'checkup-takes')!;
    expect(textOf(takes.querySelector('h2'))).toBe('Your pitch lines');
    expect(textOf(takes)).toContain('The line is your voice and the bars are the notes you were asked to sing. Your older check-up comes first, then this one.');
    expect([...takes.querySelectorAll('.ck-take__title')].map((el) => textOf(el))).toEqual([CHECKUP_TASKS[1].title, CHECKUP_TASKS[2].title]);
    expect([...takes.querySelectorAll('.ck-pair__label')].map((el) => textOf(el))).toEqual([
      `Then · ${formatDate(older.finishedAt)}`,
      `Now · ${formatDate(newer.finishedAt)}`,
      `Then · ${formatDate(older.finishedAt)}`,
      `Now · ${formatDate(newer.finishedAt)}`,
    ]);
    expect(takes.querySelectorAll('.ck-pair--two')).toHaveLength(2);
    expect(jargonIn(textOf(takes))).toEqual([]);
  });

  it('holds each line\'s place while it loads, then draws it with the take report\'s replay', async () => {
    const readTake = get.getMockImplementation()!;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    get.mockImplementation(async (id: string) => {
      await gate;
      return readTake(id);
    });
    const c = await show();
    expect(c.querySelectorAll('[data-testid="checkup-line-loading"]')).toHaveLength(4);
    expect(replays(c)).toBe(0);
    release();
    await waitUntil(() => replays(c) === 4);
    expect(c.querySelectorAll('[data-testid="checkup-line-loading"]')).toHaveLength(0);
    const labels = [...c.querySelectorAll('figure.pl-replay canvas')].map((el) => el.getAttribute('aria-label'));
    expect(labels).toHaveLength(4);
    for (const label of labels) expect(label).toMatch(/^Replay of your take against \d+ target notes?$/);
  });

  it('reads the saved take of the held-note and slide task of each check-up, and no other', async () => {
    const c = await show();
    await waitUntil(() => replays(c) === 4);
    const asked = get.mock.calls.map((call) => call[0]).sort();
    expect(asked).toEqual(
      [older, newer].flatMap((s) => [1, 2].map((i) => `${s.tasks[i].attemptId}-take`)).sort(),
    );
  });

  it('says in a sentence when a take was not saved or a task was not sung, and draws the rest', async () => {
    attemptLog.value = [...attemptsOf(older, [2]), ...attemptsOf({ ...newer, tasks: newer.tasks.map((t, i) => (i === 1 ? { ...t, attemptId: null } : t)) })];
    const c = await show();
    await waitUntil(() => c.querySelectorAll('[data-testid="checkup-line-col"][data-status="loading"]').length === 0);
    const messages = [...c.querySelectorAll('[data-testid="checkup-line-missing"]')].map((el) => textOf(el)).sort();
    expect(messages).toEqual([NOT_SAVED, NOT_SUNG].sort());
    expect(replays(c)).toBe(2);
  });

  it('shows a first check-up\'s own lines alone, with no then and now', async () => {
    vi.mocked(checkupsOf).mockReturnValue([newer]);
    attemptLog.value = attemptsOf(newer);
    const c = await show();
    expect(byTestId(c, 'checkup-compare')).toBeNull();
    expect(compareCheckups).not.toHaveBeenCalled();
    const takes = byTestId(c, 'checkup-takes')!;
    expect(textOf(takes)).not.toContain('Your older check-up comes first');
    expect(takes.querySelectorAll('.ck-pair--two')).toHaveLength(0);
    expect([...takes.querySelectorAll('.ck-pair__label')].map((el) => textOf(el))).toEqual([formatDate(newer.finishedAt), formatDate(newer.finishedAt)]);
    await waitUntil(() => replays(c) === 2);
  });
});

describe('CheckupResults: a check-up that is not here', () => {
  it('says so, and opens the check-up instead of a blank screen', async () => {
    const c = await show('nobody');
    expect(byTestId(c, 'checkup-results-screen')!.dataset.view).toBe('missing');
    expect(textOf(c.querySelector('.pl-empty__title'))).toBe('That check-up is not on this device');
    expect(byTestId(c, 'checkup-summary')).toBeNull();
    byTestId<HTMLButtonElement>(c, 'checkup-results-open')!.click();
    expect(route.value).toEqual(routeOf('checkup'));
  });
});
