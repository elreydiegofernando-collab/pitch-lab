// @vitest-environment happy-dom
/**
 * The check-up screens against the REAL check-up engine (src/checkup) and the REAL check-up session (runtime/checkup.ts),
 * end to end the way the runner drives them: Home invites, the intro starts a check-up, each task's take is written to the
 * log and recorded in the session, and the screens read it all back. Only the session's signals and the settings are
 * doubles. It is the contract test for what the screens ask of the engine: the saved range (so the range reads in note
 * names), `() => null` for the progress around a check-up, the focus levels, "Then and now", when a re-check is due.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../state/session', async () => (await import('./test-support')).sessionModule());
vi.mock('../../state/settings', async () => (await import('./test-support')).settingsDouble());

import type { JSX } from 'preact';
import type { Metrics } from '../../analysis/types';
import { jargonIn } from '../../coaching/plain';
import { CHECKUP_TASKS } from '../../checkup/types';
import { WORLDS, evaluate, getExercise, realize, type ExerciseDef } from '../../exercises';
import { computeSnapshot, withRoutines } from '../../progress';
import { BASE_MS, DAY_MS, attempt } from '../../progress/test-fixtures';
import { installRouteGuard, resetRouterForTests, route, routeOf } from '../../router';
import { abandonCheckup, activeCheckup, recordCheckupTake } from '../../runtime/checkup';
import type { TakeOutcome } from '../../runtime/types';
import { activeProfile, attemptLog, bootPhase, snapshot } from '../../state/session';
import { settings, deviceSettings } from '../../state/settings';
import { DEFAULT_DEVICE_SETTINGS, DEFAULT_SETTINGS } from '../../state/settings-types';
import type { AttemptRecord } from '../../storage/schema';
import { Checkup } from '../screens/Checkup';
import { CheckupResults } from '../screens/CheckupResults';
import { Dashboard } from '../screens/Dashboard';
import { Home } from '../screens/Home';
import { byTestId, flush, mount, profileRecord, textOf, type Mounted } from './test-support';

let view: Mounted | null = null;

const defOf = (taskIndex: number): ExerciseDef => getExercise(CHECKUP_TASKS[taskIndex].exerciseId)!;

/** Every metric the exercise scores, each at term score `x` (0 = as bad as the band goes, 1 = best), with overrides. */
function metricsAt(def: ExerciseDef, x: number, over: Metrics = {}): Metrics {
  const m: Metrics = {};
  for (const t of def.scoring) m[t.metric] = t.worst + x * (t.best - t.worst);
  return { ...m, ...over };
}

/** Count-in plus material at the tempo sung: how long a whole take is (the runner writes it as durationSec). */
function wholeSec(def: ExerciseDef): number {
  const r = realize(def, null, 'unknown', { bpm: def.tempoBpm });
  return r.countInSec + r.totalSec;
}

/** The take of one check-up task as the runner logs it, at `at` ms, with how well each task went (term score). */
function take(taskIndex: number, checkupId: string, x: number, at: number): AttemptRecord {
  const task = CHECKUP_TASKS[taskIndex];
  const def = defOf(taskIndex);
  const metrics = metricsAt(def, x);
  const e = evaluate(def, metrics);
  return {
    ...attempt({
      exerciseId: def.id,
      kind: task.logAs.kind === 'practice' ? 'practice' : 'audition',
      levelId: task.logAs.kind === 'practice' ? task.logAs.levelId : null,
      passed: e.passed,
      score: e.score,
      mastery: e.mastery,
      metrics,
      durationSec: wholeSec(def),
      tempoBpm: def.tempoBpm,
      createdAt: new Date(at).toISOString(),
    }),
    checkupId,
  };
}

/** What the runner does after a check-up take: the attempt goes to the log, then the session counts the task sung. */
function sing(taskIndex: number, x: number, at: number): AttemptRecord {
  const session = activeCheckup.value!;
  const row = take(taskIndex, session.checkupId, x, at);
  attemptLog.value = [...attemptLog.value, row];
  snapshot.value = computeSnapshot('singer-1', WORLDS, attemptLog.value, at, { getExercise: withRoutines(getExercise) });
  recordCheckupTake(taskIndex, { attempt: row } as unknown as TakeOutcome);
  return row;
}

/** The range finder measured B2 to A4 comfortably: the profile's range, saved by the take at `savedAt`. */
function saveRange(savedAt: string): void {
  activeProfile.value = {
    ...profileRecord('Daniel'),
    range: { comfortable: { low: 47, high: 69 }, extended: { low: 45, high: 72 }, measuredAt: savedAt },
  };
}

const T1 = BASE_MS;
const T2 = BASE_MS + 30 * DAY_MS;

async function show(node: JSX.Element): Promise<HTMLElement> {
  view?.unmount();
  view = mount(node);
  await flush();
  return view.container;
}

beforeEach(() => {
  resetRouterForTests([routeOf('home')]);
  installRouteGuard(() => ({ ok: true }));
  bootPhase.value = 'ready';
  activeProfile.value = profileRecord('Daniel');
  attemptLog.value = [];
  snapshot.value = computeSnapshot('singer-1', WORLDS, [], T1, { getExercise: withRoutines(getExercise) });
  settings.value = { ...DEFAULT_SETTINGS, voiceCareSeen: true };
  deviceSettings.value = { ...DEFAULT_DEVICE_SETTINGS, headphoneGuideSeen: true };
  abandonCheckup();
});

afterEach(() => {
  view?.unmount();
  view = null;
  abandonCheckup();
});

describe('a first check-up, from Home to its results, on the real engine', () => {
  it('invites on Home, starts from the intro, comes back part way, and reads the finished check-up from the log', async () => {
    // Home: a profile that has sung nothing starts with the check-up.
    let c = await show(<Home />);
    expect(byTestId(c, 'checkup-card')!.dataset.kind).toBe('first');
    byTestId<HTMLButtonElement>(c, 'checkup-card-button')!.click();
    expect(route.value).toEqual(routeOf('checkup'));

    // The intro: Start begins a real session and opens the first task.
    c = await show(<Checkup />);
    expect(byTestId(c, 'checkup-screen')!.dataset.view).toBe('intro');
    byTestId<HTMLButtonElement>(c, 'checkup-start')!.click();
    await flush();
    expect(activeCheckup.value).not.toBeNull();
    expect(route.value).toEqual(routeOf('sing', { target: 'checkup', itemIndex: '0' }));

    // Two tasks sung, then the singer leaves: the screen says where they are, and Home offers to finish it.
    const range = sing(0, 1, T1 + 1000);
    sing(1, 1, T1 + 60_000);
    c = await show(<Checkup />);
    expect(byTestId(c, 'checkup-screen')!.dataset.view).toBe('progress');
    expect(textOf(byTestId(c, 'checkup-progress-title'))).toBe('Task 3 of 5');
    c = await show(<Home />);
    expect(byTestId(c, 'checkup-card')!.dataset.kind).toBe('continue');
    expect(textOf(byTestId(c, 'checkup-card'))).toContain('Task 3 of 5 is next.');

    // The two notes and the connected line go well; the slide, sung last, breaks (the voice cracks all the way up).
    sing(2, 1, T1 + 120_000);
    sing(3, 1, T1 + 180_000);
    sing(4, 0.1, T1 + 240_000);
    saveRange(range.createdAt);

    c = await show(<Checkup />);
    expect(byTestId(c, 'checkup-screen')!.dataset.view).toBe('results');
    // The range reads in note names: the screen handed the engine the profile's saved range.
    expect(textOf(byTestId(c, 'checkup-range-value'))).toBe('B2–A4');
    // Six skills, the slide the one to focus on, in plain words.
    expect([...c.querySelectorAll('[data-testid="checkup-skills"] li')].map((li) => li.getAttribute('data-skill'))).toEqual([
      'range',
      'pitch',
      'steadiness',
      'starts',
      'connected',
      'slides',
    ]);
    expect(byTestId(c, 'checkup-skill-slides')!.dataset.rating).toBe('focus');
    expect(textOf(byTestId(c, 'checkup-skill-slides')!.querySelector('.ck-rating'))).toBe('Focus here');
    expect(textOf(byTestId(c, 'checkup-skill-slides')!.querySelector('.ck-skill__what')).length).toBeGreaterThan(10); // the engine's own sentence about the slide
    const focus = [...c.querySelectorAll('[data-testid="checkup-focus"] .ck-focus__item')].map((li) => li.getAttribute('data-skill'));
    expect(focus).toContain('slides');
    expect(focus.length).toBeLessThanOrEqual(2);
    // Where to start and what opened come from the placement tests, passed in order up to the slide: Match one note to
    // Five notes in a row.
    expect(textOf(byTestId(c, 'checkup-opened-levels'))).toBe('Match one note – Five notes in a row');
    expect(textOf(byTestId(c, 'checkup-start-level')!.querySelector('.ck-start__title'))).toBe('Small slides');
    // Nothing to compare with yet.
    expect(byTestId(c, 'checkup-compare')).toBeNull();
    expect(jargonIn(textOf(c))).toEqual([]);
    expect(textOf(c)).not.toMatch(/\b(push|force|strain)\b/i);

    // Practise the focus: the level the singer is on, and it is open.
    const practise = byTestId<HTMLButtonElement>(c, 'checkup-practise-slides')!;
    expect(textOf(practise)).toBe('Practise Small slides');
    practise.click();
    expect(route.value).toEqual(routeOf('level', { levelId: 'foundations.12' }));
  });

  it('shows the results of the last sitting on Home as a quiet row, and in the dashboard, until a re-check is due', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(T1 + 3 * DAY_MS)); // three days after the check-up
      await runWholeCheckup(T1, [1, 1, 1, 1, 0.1]);
      activeCheckup.value = null; // a relaunch: the session is gone, the log has it
      let c = await show(<Home />);
      const card = byTestId(c, 'checkup-card')!;
      expect(card.dataset.kind).toBe('latest');
      expect(textOf(card)).toContain('Focus: slides');
      c = await show(<Dashboard />);
      expect(c.querySelectorAll('[data-testid="dash-checkup-row"]')).toHaveLength(1);
      expect(byTestId(c, 'dash-checkup-recheck')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Start a check-up and sing every task of it from `start` on (x per task), as the runner would. */
async function runWholeCheckup(start: number, xs: readonly number[]): Promise<void> {
  const c = await show(<Checkup />);
  byTestId<HTMLButtonElement>(c, 'checkup-start')!.click();
  const rows = xs.map((x, i) => sing(i, x, start + (i + 1) * 60_000));
  saveRange(rows[0].createdAt);
}

describe('a second check-up on the real engine', () => {
  it('sets it against the first with the engine\'s headline and lines, and shows the older one on its own results', async () => {
    // The first check-up, a month ago: the slide broke. The singer then relaunched the app.
    await runWholeCheckup(T1, [1, 1, 1, 1, 0.1]);
    activeCheckup.value = null;

    // The second: the slide is smooth now.
    resetRouterForTests([routeOf('home'), routeOf('checkup')]);
    installRouteGuard(() => ({ ok: true }));
    await runWholeCheckup(T2, [1, 1, 1, 1, 1]);
    const c = await show(<Checkup />);
    expect(byTestId(c, 'checkup-screen')!.dataset.view).toBe('results');

    const compare = byTestId(c, 'checkup-compare')!;
    const slides = [...compare.querySelectorAll('[data-testid="checkup-line"]')].find((li) => li.getAttribute('data-skill') === 'slides')!;
    expect(slides.className).toContain('ck-line--better');
    expect(textOf(slides.querySelector('.ck-line__mark'))).toBe('better');
    expect(textOf(byTestId(c, 'checkup-headline')).length).toBeGreaterThan(10); // the engine's one warm sentence
    expect(jargonIn(textOf(compare))).toEqual([]);

    // The pitch lines of both check-ups are offered on the results screen.
    expect(byTestId(c, 'checkup-see-lines')).not.toBeNull();
  });

  it('opens the older check-up\'s own results from the dashboard, set against nothing, and says its range in words', async () => {
    await runWholeCheckup(T1, [1, 1, 1, 1, 0.1]);
    activeCheckup.value = null;
    await runWholeCheckup(T2, [1, 1, 1, 1, 1]);
    activeCheckup.value = null;

    let c = await show(<Dashboard />);
    const rows = [...c.querySelectorAll<HTMLButtonElement>('[data-testid="dash-checkup-row"]')];
    expect(rows).toHaveLength(2);
    // Newest first; the oldest opens its own results.
    rows[1].click();
    expect(route.value.name).toBe('checkup-results');
    const olderId = (route.value.params as { checkupId: string }).checkupId;

    resetRouterForTests([routeOf('home'), routeOf('checkup-results', { checkupId: olderId })]);
    installRouteGuard(() => ({ ok: true }));
    c = await show(<CheckupResults />);
    expect(byTestId(c, 'checkup-results-screen')!.dataset.view).toBe('results');
    // No earlier check-up: no then and now, and its own lines alone.
    expect(byTestId(c, 'checkup-compare')).toBeNull();
    // The saved range now belongs to the newer check-up, so the older one says its range in words (the engine kept only the span).
    expect(byTestId(c, 'checkup-range-value')).toBeNull();
    expect(textOf(byTestId(c, 'checkup-range-words')).length).toBeGreaterThan(10); // the engine's sentence about the span
  });

  it('is not yet time for a re-check a few days later, and is a month on', async () => {
    await runWholeCheckup(T1, [1, 1, 1, 1, 1]);
    activeCheckup.value = null;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(T1 + 5 * DAY_MS));
      let c = await show(<Home />);
      expect(byTestId(c, 'checkup-card')!.dataset.kind).toBe('latest');
      vi.setSystemTime(new Date(T1 + 30 * DAY_MS));
      document.dispatchEvent(new Event('visibilitychange'));
      await flush();
      c = view!.container;
      expect(byTestId(c, 'checkup-card')!.dataset.kind).toBe('recheck');
      expect(textOf(byTestId(c, 'checkup-card'))).toContain('It has been 4 weeks since your last check-up.');
    } finally {
      vi.useRealTimers();
    }
  });
});
