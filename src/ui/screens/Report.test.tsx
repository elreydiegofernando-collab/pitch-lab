// @vitest-environment happy-dom
/**
 * Report on a real judged take (the synthetic singer through the real analyzers), with the runner's next-step list mocked.
 * A practice try of a lesson reads its lesson from fixture lessons (src/ui/lesson/test-support.ts), never the Foundations
 * content.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';

const flow = vi.hoisted(() => ({ afterTakeActions: vi.fn() }));
vi.mock('../../runtime/flow', () => flow);
const workout = vi.hoisted(() => ({ finishWorkout: vi.fn() }));
vi.mock('../../runtime/workout', () => workout);
vi.mock('../../audio/engine', async () => (await import('../practice/test-fakes')).engineModule());
vi.mock('../../runtime/runner', async () => (await import('../practice/test-fakes')).runnerModule());
vi.mock('../../state/session', async () => (await import('../practice/test-fakes')).sessionModule());
vi.mock('../../state/settings', async () => (await import('../practice/test-fakes')).settingsModule());
vi.mock('../../state/audio', async () => (await import('../practice/test-fakes')).audioModule());
vi.mock('../../lessons', async () => (await import('../lesson/test-support')).lessonsModule());
vi.mock('../../lessons/progress', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lessons/progress')>()),
  ...(await import('../lesson/test-support')).lessonProgressModule(),
}));
const exportMock = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock('../../coaching/export', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../coaching/export')>()), buildCoachingFile: exportMock.build }));

import { back, installRouteGuard, resetRouterForTests, route, routeOf } from '../../router';
import { CHECKUP_TASKS } from '../../checkup/types';
import { coachTake } from '../../coaching/coach';
import { getExercise, getLevel, getWorld } from '../../exercises';
import type { LessonDef } from '../../lessons/types';
import { attempt } from '../../progress/test-fixtures';
import { activeCheckup, startCheckup } from '../../runtime/checkup';
import type { AfterTakeAction, TakeOutcome } from '../../runtime/types';
import type { AttemptRecord } from '../../storage/schema';
import { lessonNumber } from '../lesson/model';
import { fixtureLesson, lessonRig, resetLessons, setLessons } from '../lesson/test-support';
import { makeOutcome } from '../practice/outcome-fixture';
import { createRunnerMock, lastOutcomeSignal, resetRunner, resetSession, runnerState, session, settingsSignal, snapshotAfter, synthMocks, type FakeRunner } from '../practice/test-fakes';
import { DEFAULT_SETTINGS } from '../../state/settings-types';
import { Report } from './Report';

const NEXT: AfterTakeAction[] = [
  { kind: 'retry', label: 'Retry', primary: false, route: routeOf('sing', { target: 'level', levelId: 'foundations.03' }) },
  { kind: 'next-level', label: 'Next level', primary: true, route: routeOf('level', { levelId: 'foundations.13' }) },
];
const MISSED: AfterTakeAction[] = [
  { kind: 'retry', label: 'Retry', primary: true, route: routeOf('sing', { target: 'level', levelId: 'foundations.03' }) },
  { kind: 'level', label: 'Back to level', primary: false, route: routeOf('level', { levelId: 'foundations.03' }) },
];

let container: HTMLElement;

async function mount(outcome: TakeOutcome | null, actions: AfterTakeAction[] = NEXT): Promise<void> {
  flow.afterTakeActions.mockReturnValue(actions);
  lastOutcomeSignal.value = outcome;
  resetRouterForTests([routeOf('home'), routeOf('level', { levelId: 'foundations.03' }), routeOf('report')]);
  installRouteGuard(() => ({ ok: true }));
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(() => {
    render(<Report />, container);
  });
}

const q = <T extends Element = HTMLElement>(sel: string): T | null => container.querySelector<T>(sel);
const text = (): string => container.textContent ?? '';
const flush = (ms: number): Promise<void> => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

const PASSING = makeOutcome({ singer: { biasCents: 2 }, audio: true });
const MISS = makeOutcome({ singer: { offsetSemis: 2 }, audio: true });

beforeEach(() => {
  resetSession(['foundations.01', 'foundations.02']);
  resetRunner();
  resetLessons();
  exportMock.build.mockReset();
  flow.afterTakeActions.mockReset();
  document.documentElement.dataset.reducedMotion = 'on';
});

afterEach(async () => {
  if (container) {
    await act(() => {
      render(null, container);
    });
    container.remove();
  }
  delete document.documentElement.dataset.reducedMotion;
  vi.useRealTimers();
});

describe('Report: the verdict and the score', () => {
  it('has judged takes to work with', () => {
    expect(PASSING.evaluation.passed).toBe(true);
    expect(MISS.evaluation.passed).toBe(false);
  });

  it('says "Passed" with a glyph, shows the score ring and the lit tally lights', async () => {
    await mount(PASSING);
    expect(q('[data-testid="verdict"]')?.textContent).toBe('Passed');
    expect(q('.pl-verdict--passed svg')).not.toBeNull();
    const score = `${Math.round(PASSING.evaluation.score * 100)}%`;
    expect(q('[data-testid="score-reveal"] [role="img"]')?.getAttribute('aria-label')).toBe(`Score ${score}`);
    expect(q('[data-testid="score-reveal"]')?.textContent).toContain(score);
    expect(q(`[role="img"][aria-label^="${PASSING.evaluation.mastery} of 3"]`)).not.toBeNull();
    expect(q('.pl-reveal--accent')).not.toBeNull();
  });

  it('says "Not yet", never alarm copy, when the take missed', async () => {
    await mount(MISS, MISSED);
    expect(q('[data-testid="verdict"]')?.textContent).toBe('Not yet');
    expect(q('.pl-verdict--not-yet')).not.toBeNull();
    expect(q('.pl-reveal--neutral')).not.toBeNull();
    expect(text()).not.toMatch(/fail|wrong|bad/i);
  });

  it('names what was sung, with the tempo for a ladder level', async () => {
    await mount(PASSING);
    expect(q('.pl-verdict')?.textContent).toContain(getLevel('foundations.03')!.title);
    await act(() => {
      render(null, container);
    });
    container.remove();
    const run = makeOutcome({ levelId: 'runs.03', bpm: 45, nextBpm: 68 });
    await mount(run);
    expect(q('.pl-verdict')?.textContent).toContain('sung at 45 bpm');
    expect(q('[data-testid="ladder-line"]')?.textContent).toBe('Next take at 68 bpm');
  });

  it('credits a lower rung that passed its own rule, without calling the level passed', async () => {
    const rung = makeOutcome({ levelId: 'runs.03', bpm: 45, nextBpm: 68 });
    expect(rung.evaluation.passed).toBe(true);
    expect(rung.attempt.passed).toBe(false); // the log never counts a lower rung as passing the level
    await mount({ ...rung, unlocked: [{ kind: 'level-opened', levelId: 'runs.04', title: 'Pentatonic five, up' }] }, MISSED);
    expect(q('[data-testid="verdict"]')?.textContent).toBe('Passed at 45 bpm');
    expect(q('.pl-verdict--passed')).not.toBeNull();
    expect(q('.pl-verdict')?.textContent).toContain('the level passes at 90 bpm');
    expect(q('[data-testid="ladder-line"]')?.textContent).toBe('Next take at 68 bpm');
    // No tally lights (a lower rung cannot light the level's) and no unlock strip: the level has not been passed.
    expect(q('.pl-tally-lights')).toBeNull();
    expect(q('[data-testid="unlocked-strip"]')).toBeNull();
  });

  it('says a take stopped part way was practice and not judged, with no tiles and no lights', async () => {
    const stopped = makeOutcome({ levelId: 'foundations.05' });
    const notJudged = { ...stopped, evaluation: { ...stopped.evaluation, passed: false, mastery: 0 as const, notJudged: 'stopped' as const } };
    await mount(notJudged, MISSED);
    expect(q('[data-testid="verdict"]')?.textContent).toBe('Not judged');
    expect(q('[data-testid="verdict-reason"]')?.textContent).toBe('Stopped early: practice only, not judged for the level.');
    expect(text()).not.toContain('saved range');
    expect(q('.pl-reveal--muted')).not.toBeNull();
    expect(q('.pl-tiles')).toBeNull();
  });

  it('moves focus to the verdict when it opens, so a screen reader reads it', async () => {
    await mount(PASSING);
    expect(document.activeElement).toBe(q('[data-testid="verdict"]'));
  });

  it('shows an audition test with its score but no tally lights (a test lights no level)', async () => {
    const audition = { ...PASSING, prepared: { ...PASSING.prepared, target: { kind: 'audition' as const, worldId: 'foundations' as const }, level: null } };
    await mount(audition);
    expect(q('[data-testid="score-reveal"]')).not.toBeNull();
    expect(q('.pl-tally-lights')).toBeNull();
  });

  it('calls a finished warm-up "Done", never "Passed", and a silent one "Nothing came through"', async () => {
    const routine = (noVoice: boolean): TakeOutcome => ({
      ...PASSING,
      prepared: { ...PASSING.prepared, target: { kind: 'workout', itemIndex: 0 }, level: null },
      analysis: { ...PASSING.analysis, tipContext: { ...PASSING.analysis.tipContext, noVoice } },
    });
    await mount(routine(false), MISSED);
    expect(q('[data-testid="verdict"]')?.textContent).toBe('Done');
    expect(q('.pl-tally-lights')).toBeNull();
    expect(q('[data-testid="unlocked-strip"]')).toBeNull();
    await act(() => {
      render(null, container);
    });
    container.remove();
    await mount(routine(true), MISSED);
    expect(q('[data-testid="verdict"]')?.textContent).toBe('Nothing came through');
  });

  it('says plainly when the recording was not kept, and when the range was not saved', async () => {
    await mount({ ...PASSING, saveError: 'The take counted, but its recording was not kept: this device is out of storage space.' });
    expect(q('.pl-banner--warn')?.textContent).toContain('The take counted, but its recording was not kept');
    expect(container.querySelectorAll('.pl-btn--primary')).toHaveLength(1);
  });

  it('shows no save warning when everything was kept', async () => {
    await mount(PASSING);
    expect(q('.pl-banner')).toBeNull();
  });

  it('shows the ladder line only when the tempo climbed', async () => {
    const stay = makeOutcome({ levelId: 'runs.03', bpm: 45, nextBpm: 45 });
    await mount(stay);
    expect(q('[data-testid="ladder-line"]')).toBeNull();
  });

  it('says a take was not judged when the exercise does not fit the saved range, and greys the score', async () => {
    const tiny = { comfortable: { low: 60, high: 62 }, extended: { low: 60, high: 62 }, measuredAt: '2026-10-21T09:00:00.000Z' };
    const folded = makeOutcome({ levelId: 'foundations.07', range: tiny });
    expect(folded.evaluation.notJudged).toBe('folded');
    await mount(folded, MISSED);
    expect(q('[data-testid="verdict"]')?.textContent).toBe('Not judged');
    expect(text()).toContain('Not judged: this exercise doesn’t fit your saved range.');
    expect(q('.pl-reveal--muted')).not.toBeNull();
    expect(q('.pl-tiles')).toBeNull();
    expect(text()).toContain('does not fit your saved range');
  });
});

describe('Report: tiles, replay, tip', () => {
  it('shows each tile in plain words: its reading, its goal and a glyph for met or unmet (src/ui/practice/ReportParts.tsx)', async () => {
    await mount(PASSING);
    const tiles = [...container.querySelectorAll('.pl-tile')];
    expect(tiles.length).toBe(PASSING.tiles.length);
    expect(tiles.length).toBeGreaterThanOrEqual(2);
    expect(tiles.length).toBeLessThanOrEqual(4);
    for (const [i, el] of tiles.entries()) {
      const t = PASSING.tiles[i];
      expect(el.textContent).toContain(t.label);
      expect(el.querySelector(`[data-testid="tile-${t.metric}-value"]`)?.textContent?.length).toBeGreaterThan(0);
      expect(el.querySelector(`[data-testid="tile-${t.metric}-goal"]`)?.textContent).toMatch(/^Goal: /);
      expect(el.querySelector('svg')).not.toBeNull();
      expect(el.textContent).toMatch(/goal met|goal not met|not measured/);
    }
  });

  it('marks an unmet tile with words as well as a glyph', async () => {
    await mount(MISS, MISSED);
    expect(text()).toContain('goal not met');
  });

  it('shows the replay with its note names and legend, and exactly one coaching tip', async () => {
    await mount(PASSING);
    expect(q('.pl-replay canvas')?.getAttribute('role')).toBe('img');
    expect(q('.pl-replay__gutter')?.textContent).toMatch(/[A-G]/);
    expect(text()).toContain('In the band');
    expect(text()).toContain('Outside the band');
    expect(container.querySelectorAll('[data-testid="tip"]')).toHaveLength(1);
    expect(q('[data-testid="tip"]')?.textContent).toBe(coachTake(PASSING, [], { notation: 'sharps' }).tip);
  });

  it('counts the crack ticks and the run verdicts in the legend', async () => {
    const siren = makeOutcome({ levelId: 'foundations.05', singer: { breaks: [] } });
    await mount(siren);
    expect(text()).not.toContain('cracks marked');
    await act(() => {
      render(null, container);
    });
    container.remove();
    const broken = makeOutcome({ levelId: 'foundations.05' });
    broken.analysis.details.cracks.push({ t: 3, kind: 'jump', cents: 400, durationMs: 20 }, { t: 5, kind: 'dropout', durationMs: 90 });
    await mount(broken);
    expect(text()).toContain('2 cracks marked');
    await act(() => {
      render(null, container);
    });
    container.remove();
    const run = makeOutcome({ levelId: 'runs.03', bpm: 45 });
    expect(run.analysis.details.runs.length).toBeGreaterThan(0);
    await mount(run);
    expect(text()).toMatch(/\d+ defined/);
    expect(text()).toMatch(/\d+ smeared/);
    expect(text()).toMatch(/\d+ missed/);
  });
});

describe('Report: the next steps', () => {
  it('renders exactly one primary action, in the bottom bar', async () => {
    await mount(PASSING);
    const primaries = container.querySelectorAll('.pl-btn--primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0].textContent).toContain('Next level');
    expect(primaries[0].closest('nav')?.getAttribute('aria-label')).toBe('Next steps');
    expect(container.querySelectorAll('nav .pl-btn--secondary')).toHaveLength(1);
  });

  it('keeps it at one when the list arrives with two, or with none', async () => {
    const two: AfterTakeAction[] = NEXT.map((a) => ({ ...a, primary: true }));
    await mount(PASSING, two);
    expect(container.querySelectorAll('.pl-btn--primary')).toHaveLength(1);
    expect(container.querySelector('.pl-btn--primary')!.textContent).toContain('Retry');
    await act(() => {
      render(null, container);
    });
    container.remove();
    const none: AfterTakeAction[] = NEXT.map((a) => ({ ...a, primary: false }));
    await mount(PASSING, none);
    expect(container.querySelectorAll('.pl-btn--primary')).toHaveLength(1);
  });

  it('opens an action with replace, so Back from the next screen skips the report', async () => {
    await mount(PASSING);
    q<HTMLButtonElement>('[data-testid="report-primary"]')!.click();
    expect(route.value).toEqual(routeOf('level', { levelId: 'foundations.13' }));
    // [home, level, report] became [home, level, next level]: the report is gone from the stack.
    resetRouterForTests([routeOf('home'), routeOf('level', { levelId: 'foundations.03' }), routeOf('report')]);
    installRouteGuard(() => ({ ok: true }));
    q<HTMLButtonElement>('[data-testid="report-retry"]')!.click();
    expect(route.value).toEqual(routeOf('sing', { target: 'level', levelId: 'foundations.03' }));
  });

  it('"Back to level" returns to the level the take came from: one Back then leaves it (no second copy)', async () => {
    flow.afterTakeActions.mockReturnValue(MISSED);
    lastOutcomeSignal.value = MISS;
    resetRouterForTests([routeOf('home'), routeOf('map'), routeOf('level', { levelId: 'foundations.03' }), routeOf('report')]);
    installRouteGuard(() => ({ ok: true }));
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(() => {
      render(<Report />, container);
    });
    [...container.querySelectorAll<HTMLButtonElement>('nav button')].find((b) => b.textContent?.includes('Back to level'))!.click();
    expect(route.value).toEqual(routeOf('level', { levelId: 'foundations.03' }));
    expect(back()).toBe(true);
    expect(route.value.name).toBe('map');
  });

  it('"Finish workout" ends the workout first, so the Workout screen opens on its summary', async () => {
    workout.finishWorkout.mockClear();
    const finish: AfterTakeAction[] = [{ kind: 'finish-workout', label: 'Finish workout', primary: true, route: routeOf('workout') }];
    await mount(PASSING, finish);
    q<HTMLButtonElement>('[data-testid="report-primary"]')!.click();
    expect(workout.finishWorkout).toHaveBeenCalledTimes(1);
    expect(route.value.name).toBe('workout');
  });

  it('asks the runner for the actions of this outcome', async () => {
    await mount(PASSING);
    expect(flow.afterTakeActions).toHaveBeenCalledWith(PASSING);
  });

  it('goes back to the level from the app bar', async () => {
    await mount(PASSING);
    q<HTMLButtonElement>('button[aria-label="Back"]')!.click();
    expect(route.value.name).toBe('level');
  });
});

describe('Report: what the take unlocked', () => {
  const events: TakeOutcome['unlocked'] = [
    { kind: 'level-passed', levelId: 'foundations.03', title: 'Hold it', mastery: 2 },
    { kind: 'level-opened', levelId: 'foundations.13', title: 'Hold it steady' },
    { kind: 'feature', featureId: 'live.cracks', title: 'Cracks marked on your Live line' },
  ];

  it('lists what opened after a pass, but not the pass itself', async () => {
    await mount({ ...PASSING, unlocked: events });
    const strip = q('[data-testid="unlocked-strip"]')!;
    expect(strip).not.toBeNull();
    expect(strip.textContent).toContain('Unlocked');
    expect(strip.textContent).toContain('Hold it steady');
    expect(strip.textContent).toContain('Cracks marked on your Live line');
    expect(strip.textContent).not.toContain('Hold it,');
    expect(strip.querySelector('svg')).not.toBeNull();
  });

  it('shows nothing when nothing opened, and nothing after a miss', async () => {
    await mount(PASSING);
    expect(q('[data-testid="unlocked-strip"]')).toBeNull();
    await act(() => {
      render(null, container);
    });
    container.remove();
    await mount({ ...MISS, unlocked: events }, MISSED);
    expect(q('[data-testid="unlocked-strip"]')).toBeNull();
  });
});

describe('Report: the Range finder', () => {
  it('shows the saved range as words and on a keyboard strip', async () => {
    const finder = makeOutcome({ levelId: 'foundations.01', rangeSaved: true });
    session.activeProfile.value = { ...session.activeProfile.value!, range: { comfortable: { low: 48, high: 69 }, extended: { low: 45, high: 72 }, measuredAt: '2026-10-21T09:00:00.000Z' } };
    await mount(finder);
    const card = q('[data-testid="range-card"]')!;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain('Practice range');
    expect(card.textContent).toContain('C3–A4');
    expect(card.textContent).toContain('Full reach');
    expect(card.textContent).toContain('A2–C5');
    expect(card.querySelector('svg rect')).not.toBeNull();
  });

  it('measures rather than grades: "Range saved", no score ring, no tiles', async () => {
    const finder = makeOutcome({ levelId: 'foundations.01', rangeSaved: true });
    session.activeProfile.value = { ...session.activeProfile.value!, range: { comfortable: { low: 48, high: 69 }, extended: { low: 45, high: 72 }, measuredAt: '2026-10-21T09:00:00.000Z' } };
    await mount(finder);
    expect(q('[data-testid="verdict"]')?.textContent).toBe('Range saved');
    expect(container.textContent).toContain('Every exercise now fits your voice.');
    expect(q('[data-testid="score-reveal"]')).toBeNull();
    expect(q('.pl-tiles')).toBeNull();
  });

  it('is absent for any other take', async () => {
    await mount(PASSING);
    expect(q('[data-testid="range-card"]')).toBeNull();
  });
});

describe('Report: a task of the voice check-up', () => {
  const SIREN = makeOutcome({ levelId: 'foundations.05' });
  const RESULTS: AfterTakeAction[] = [{ kind: 'checkup-results', label: 'See your results', primary: true, route: routeOf('checkup') }];
  /** The check-up's siren task (wherever the battery puts it), and its plain title. */
  const SLIDE = CHECKUP_TASKS.findIndex((t) => t.skills.some((s) => s.skill === 'slides'));
  const SLIDE_TITLE = CHECKUP_TASKS[SLIDE].title;

  /** A take of check-up task `taskIndex` (the siren), as the runner prepares and logs it: an audition take tagged with the check-up. */
  function checkupTake(base: TakeOutcome, over: { passed?: boolean; durationSec?: number; noVoice?: boolean; notJudged?: 'stopped' } = {}, taskIndex = SLIDE): TakeOutcome {
    const def = getExercise(CHECKUP_TASKS[taskIndex].exerciseId)!;
    return {
      ...base,
      prepared: { ...base.prepared, target: { kind: 'checkup', taskIndex }, def, level: null, checkup: { taskIndex, taskCount: CHECKUP_TASKS.length, checkupId: 'c1' } },
      analysis: { ...base.analysis, tipContext: { ...base.analysis.tipContext, noVoice: over.noVoice ?? false } },
      evaluation: over.notJudged ? { ...base.evaluation, passed: false, notJudged: over.notJudged } : base.evaluation,
      attempt: {
        ...base.attempt,
        exerciseId: def.id,
        kind: 'audition',
        levelId: null,
        passed: over.passed ?? false,
        metrics: base.analysis.metrics,
        durationSec: over.durationSec ?? base.attempt.durationSec,
        checkupId: 'c1',
      },
    };
  }

  it('names the task plainly, gives a calm verdict and no score ring or tally: a check-up, not a test', async () => {
    await mount(checkupTake(SIREN), RESULTS);
    expect(q('[data-testid="verdict"]')?.textContent).toBe('Sung');
    expect(q('.pl-verdict')?.textContent).toContain(SLIDE_TITLE);
    expect(text()).not.toContain('Audition');
    expect(text()).not.toMatch(/Not yet|fail|wrong/i);
    expect(q('[data-testid="score-reveal"]')).toBeNull();
    expect(q('.pl-tally-lights')).toBeNull();
    expect(q('[data-testid="verdict-reason"]')).toBeNull();
    expect(q('.pl-tiles')).not.toBeNull(); // what it measured
  });

  it('a test that passed says so, and shows what it opened', async () => {
    const opened: TakeOutcome['unlocked'] = [{ kind: 'level-opened', levelId: 'foundations.05', title: 'Sirens' }];
    await mount({ ...checkupTake(SIREN, { passed: true }), unlocked: opened }, RESULTS);
    expect(q('[data-testid="verdict"]')?.textContent).toBe('Passed');
    expect(q('.pl-verdict')?.textContent).toContain(SLIDE_TITLE);
    expect(q('[data-testid="score-reveal"]')).toBeNull();
    expect(q('[data-testid="unlocked-strip"]')?.textContent).toContain('Sirens');
  });

  it('a take that measured nothing says why in check-up words, never “not judged for the level” or “as a test”', async () => {
    const cases: Array<[Parameters<typeof checkupTake>[1], string, string]> = [
      [{ notJudged: 'stopped' }, 'Not measured', 'Stopped early, so this task was not measured.'],
      [{ noVoice: true, durationSec: 0 }, 'Nothing came through', 'Nothing came through the microphone, so this task was not measured.'],
      [{ durationSec: 3 }, 'Not measured', 'Not all of this task was heard, so it was not measured.'],
    ];
    for (const [over, word, reason] of cases) {
      await mount(checkupTake(SIREN, over), RESULTS);
      expect(q('[data-testid="verdict"]')?.textContent, word).toBe(word);
      expect(q('[data-testid="verdict-reason"]')?.textContent).toBe(reason);
      expect(text()).not.toMatch(/judged for the level|as a test/);
      expect(q('[data-testid="score-reveal"]')).toBeNull();
      await act(() => {
        render(null, container);
      });
      container.remove();
    }
  });

  it('“See your results” ends the check-up and goes back to the check-up screen beneath, never a second copy of it', async () => {
    const s = startCheckup();
    activeCheckup.value = { ...s, attemptIds: ['a', 'b', 'c', 'd', 'e'] };
    flow.afterTakeActions.mockReturnValue(RESULTS);
    lastOutcomeSignal.value = checkupTake(SIREN, {}, SLIDE);
    resetRouterForTests([routeOf('home'), routeOf('checkup'), routeOf('report')]);
    installRouteGuard(() => ({ ok: true }));
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(() => {
      render(<Report />, container);
    });
    q<HTMLButtonElement>('[data-testid="report-primary"]')!.click();
    expect(activeCheckup.value?.finishedAt).not.toBeNull();
    expect(route.value).toEqual(routeOf('checkup'));
    expect(back()).toBe(true);
    expect(route.value.name).toBe('home');
    activeCheckup.value = null;
  });
});

describe('Report: a Range finder pass whose range would not save', () => {
  it('is a plain pass, never “Range saved”, and does not promise the exercises fit', async () => {
    const finder = makeOutcome({ levelId: 'foundations.01', rangeSaved: false, saveError: 'Your range was not saved. Sing the Range finder again to save it.' });
    expect(finder.attempt.passed).toBe(true);
    await mount(finder);
    expect(q('[data-testid="verdict"]')?.textContent).toBe('Passed');
    expect(text()).not.toContain('Every exercise now fits your voice.');
    expect(q('.pl-banner--warn')?.textContent).toContain('Your range was not saved');
  });
});

describe('Report: playback', () => {
  it('offers Play and Slow, and Slow waits until the slowed copy is ready', async () => {
    await mount(PASSING);
    const play = q<HTMLButtonElement>('[data-testid="play-take"]')!;
    expect(play.textContent).toContain('Play take');
    expect(play.disabled).toBe(false);
    const slow = q<HTMLButtonElement>('[data-testid="play-slow"]')!;
    await flush(60);
    expect(q<HTMLButtonElement>('[data-testid="play-slow"]')!.disabled).toBe(false);
    expect(slow.textContent).toContain('Slow (0.5×)');
  });

  it('adds "Slow + target" for runs only', async () => {
    await mount(PASSING);
    expect(q('[data-testid="play-slow-target"]')).toBeNull();
    await act(() => {
      render(null, container);
    });
    container.remove();
    await mount(makeOutcome({ levelId: 'runs.03', bpm: 45, audio: true }));
    expect(q('[data-testid="play-slow-target"]')?.textContent).toContain('Slow + target');
  });

  it('says why there is no playback when the take has no audio', async () => {
    await mount(makeOutcome({ audio: false }));
    expect(q('[data-testid="play-take"]')).toBeNull();
    expect(text()).toContain('wasn’t captured'.replace('’', "'"));
    await act(() => {
      render(null, container);
    });
    container.remove();
    settingsSignal.value = { ...DEFAULT_SETTINGS, keepTakeAudio: false };
    await mount(makeOutcome({ audio: false }));
    expect(text()).toContain('Take audio is off');
  });

  it('has nothing that sends audio anywhere: no link, no download, no form', async () => {
    await mount(PASSING);
    expect(container.querySelector('a[href], a[download], form')).toBeNull();
    expect(synthMocks.playNote).not.toHaveBeenCalled();
  });
});

describe('Report: the celebration', () => {
  it('is instant under reduced motion', async () => {
    await mount(PASSING);
    const score = `${Math.round(PASSING.evaluation.score * 100)}%`;
    expect(q('[data-testid="score-reveal"] .pl-readout-l')?.textContent).toBe(score);
    expect(q(`[role="img"][aria-label^="${PASSING.evaluation.mastery} of 3"]`)).not.toBeNull();
  });

  it('counts the ring up over 600 ms, then lights the tally one by one 120 ms apart', async () => {
    delete document.documentElement.dataset.reducedMotion;
    document.documentElement.dataset.reducedMotion = 'off';
    vi.useFakeTimers();
    await mount(PASSING);
    const centre = (): string => q('[data-testid="score-reveal"] .pl-readout-l')!.textContent ?? '';
    const lit = (): string => q('.pl-tally-lights')!.getAttribute('aria-label')!.slice(0, 1);
    expect(centre()).toBe('0%');
    expect(lit()).toBe('0');
    await act(() => {
      vi.advanceTimersByTime(300);
    });
    const mid = Number.parseInt(centre(), 10);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(Math.round(PASSING.evaluation.score * 100));
    expect(lit()).toBe('0');
    await act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(centre()).toBe(`${Math.round(PASSING.evaluation.score * 100)}%`);
    expect(lit()).toBe('1');
    await act(() => {
      vi.advanceTimersByTime(120);
    });
    if (PASSING.evaluation.mastery >= 2) expect(lit()).toBe('2');
    await act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(lit()).toBe(String(PASSING.evaluation.mastery));
  });

  it('does not light the tally in sequence after a miss: it just shows what it has', async () => {
    delete document.documentElement.dataset.reducedMotion;
    document.documentElement.dataset.reducedMotion = 'off';
    await mount(MISS, MISSED);
    expect(q('.pl-tally-lights')!.getAttribute('aria-label')!.slice(0, 1)).toBe('0');
  });
});

describe('Report: without a take', () => {
  it('says so, with the way back', async () => {
    await mount(null);
    expect(q('[data-testid="unavailable"]')).not.toBeNull();
    expect(text()).toContain('no take to show');
  });
});

describe('Report: progress snapshots are not needed to render', () => {
  it('renders from the outcome alone', async () => {
    session.snapshot.value = snapshotAfter([]);
    await mount(PASSING);
    expect(q('[data-testid="report-screen"]')).not.toBeNull();
  });
});

describe('Report: the coaching', () => {
  /** `n` earlier misses of the take's exercise in the log, then the take itself. */
  function logWith(outcome: TakeOutcome, n: number): void {
    const earlier = Array.from({ length: n }, (_, i) =>
      attempt({ profileId: outcome.attempt.profileId, exerciseId: outcome.prepared.def.id, levelId: 'foundations.03', passed: false, score: 0.3, createdAt: new Date(Date.parse(outcome.attempt.createdAt) - (n - i) * 600_000).toISOString() }),
    );
    session.attemptLog.value = [...earlier, outcome.attempt];
  }

  it('replaces the tip card with the coaching card: where it slipped, in plain words, then the tip', async () => {
    logWith(MISS, 0);
    await mount(MISS, MISSED);
    const card = q('[data-testid="coach-card"]')!;
    expect(card).not.toBeNull();
    const coaching = coachTake(MISS, session.attemptLog.value, { notation: 'sharps' });
    expect(card.getAttribute('data-depth')).toBe('1');
    expect(q('[data-testid="coach-what"]')?.textContent).toBe(coaching.problem.what);
    expect(q('[data-testid="tip"]')?.textContent).toBe(coaching.tip);
    expect(text()).not.toContain('Coaching tip');
    // It sits under the replay, as the one tip did (docs/DESIGN.md §13.5).
    expect(q('.pl-replay')!.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('marks a spot on the replay when its chip is tapped, and clears it on a second tap', async () => {
    logWith(MISS, 0);
    await mount(MISS, MISSED);
    const chips = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="coach-spot"]')];
    expect(chips.length).toBeGreaterThan(0);
    expect(q('[data-testid="replay-mark"]')).toBeNull();
    await act(() => {
      chips[0].click();
    });
    expect(chips[0].getAttribute('aria-pressed')).toBe('true');
    expect(q('[data-testid="replay-mark-text"]')?.textContent).toBe(`Marked on the replay: ${chips[0].textContent}`);
    await act(() => {
      chips[0].click();
    });
    expect(chips[0].getAttribute('aria-pressed')).toBe('false');
    expect(q('[data-testid="replay-mark-text"]')?.textContent).toBe('');
  });

  it('deepens with the misses in a row in the log, and keeps the report’s own action the one amber button', async () => {
    logWith(MISS, 4);
    await mount(MISS, MISSED);
    expect(q('[data-testid="coach-card"]')?.getAttribute('data-depth')).toBe('4');
    expect(q('[data-testid="coach-depth"]')?.textContent).toBe('Fifth try in a row, so here is a gentler way in.');
    expect(q('[data-testid="coach-send"]')).not.toBeNull();
    expect(q('[data-testid="coach-listen"]')?.textContent).toBe('Listen again');
    expect(container.querySelectorAll('.pl-btn--primary')).toHaveLength(1);
    expect(q('.pl-btn--primary')?.closest('nav')).not.toBeNull();
  });

  it('plays the level’s demo again from the listen move, made inside the tap', async () => {
    logWith(MISS, 4);
    await mount(MISS, MISSED);
    q<HTMLButtonElement>('[data-testid="coach-listen"]')!.click();
    expect(createRunnerMock).toHaveBeenCalledWith({ kind: 'level', levelId: 'foundations.03' });
    const runner = runnerState.last as FakeRunner;
    expect(runner.listen).toHaveBeenCalledTimes(1);
    await act(() => {
      runner.phase.value = 'listening';
    });
    expect(q('[data-testid="coach-listen"]')?.textContent).toBe('Stop');
    await act(() => {
      render(null, container);
    });
    expect(runner.dispose).toHaveBeenCalledTimes(1);
  });

  it('opens Send to Claude from the coaching, with the file made for this exercise', async () => {
    exportMock.build.mockResolvedValue({ level: { id: 'foundations.03' }, exercise: MISS.prepared.def, exportedAt: '2026-10-22T14:05:00.000Z', takes: [] });
    logWith(MISS, 2);
    await mount(MISS, MISSED);
    expect(q('[data-testid="coach-card"]')?.getAttribute('data-depth')).toBe('3');
    await act(() => {
      q<HTMLButtonElement>('[data-testid="coach-send"]')!.click();
    });
    await flush(0);
    expect(q('[role="dialog"][aria-label="Send to Claude"]')).not.toBeNull();
    expect(exportMock.build).toHaveBeenCalledWith(MISS.prepared.def.id, { includeAudio: false });
  });

  it('after a pass: the polish or next-step tip, with no deeper help and no moves', async () => {
    logWith(PASSING, 3);
    await mount(PASSING);
    expect(q('[data-testid="coach-card"]')?.getAttribute('data-depth')).toBe('1');
    expect(q('[data-testid="coach-depth"]')).toBeNull();
    expect(q('[data-testid="coach-why"]')).toBeNull();
    expect(q('[data-testid="coach-send"]')).toBeNull();
  });
});

describe('Report: a practice try of a lesson (training, not testing)', () => {
  const LEVEL_ID = 'foundations.13';
  const lessonNo = (): number => lessonNumber(getWorld('foundations'), getLevel(LEVEL_ID)!);

  /** The fixture lesson, with step `real` singing the takes' own exercise (so the coaching reads a real exercise). */
  function lessonWith(real: number): LessonDef {
    const base = fixtureLesson(LEVEL_ID);
    return { ...base, practice: base.practice.map((p, i) => (i === real ? { ...p, exerciseId: MISS.prepared.def.id } : p)) };
  }

  /** `base` as a try of practice step `step`, as the runner writes one: kind 'practice', no level, and the step's counts. */
  function drillTake(base: TakeOutcome, step: number, counts: { good: number; needed: number } | null = null): TakeOutcome {
    const lesson = lessonRig.lessons[LEVEL_ID];
    const practice = lesson.practice[step];
    return {
      ...base,
      prepared: {
        ...base.prepared,
        target: { kind: 'drill', levelId: LEVEL_ID, step },
        level: null,
        passLines: [],
        drill: counts ? { levelId: LEVEL_ID, step, stepCount: lesson.practice.length, ...counts } : null,
      },
      attempt: { ...base.attempt, kind: 'practice', levelId: null, exerciseId: practice.exerciseId, metrics: base.analysis.metrics },
    };
  }

  /** Earlier tries of a step in the log, good (in tune most of the time, the fixture rule) or not. */
  function tries(step: number, n: number, good: boolean): AttemptRecord[] {
    const exerciseId = lessonRig.lessons[LEVEL_ID].practice[step].exerciseId;
    return Array.from({ length: n }, () =>
      attempt({ profileId: 'singer-1', exerciseId, levelId: null, passed: good, score: good ? 0.8 : 0.2, metrics: { 'accuracy.inTolerancePct': good ? 90 : 10 } }),
    );
  }

  const actions = (step: number): AfterTakeAction[] => [
    { kind: 'next-try', label: 'Again', primary: true, route: routeOf('sing', { target: 'drill', levelId: LEVEL_ID, itemIndex: String(step) }) },
    { kind: 'lesson', label: 'Back to the lesson', primary: false, route: routeOf('level', { levelId: LEVEL_ID }) },
  ];

  beforeEach(() => setLessons(lessonWith(1)));

  it('has a good and a not-good try to work with (the fixture rule: in tune at least half the time)', () => {
    expect(PASSING.analysis.metrics['accuracy.inTolerancePct'] ?? 0).toBeGreaterThanOrEqual(50);
    expect(MISS.analysis.metrics['accuracy.inTolerancePct'] ?? 0).toBeLessThan(50);
  });

  it('says "Good try" with a glyph, the lesson and step, and the step’s good tries: no score ring, tiles or celebration', async () => {
    const take = { ...drillTake(PASSING, 1), unlocked: [{ kind: 'level-opened' as const, levelId: 'foundations.05', title: 'Next' }] };
    session.attemptLog.value = [...tries(1, 1, true), take.attempt];
    await mount(take, actions(1));
    expect(q('[data-testid="verdict"]')?.textContent).toBe('Good try');
    expect(q('.pl-drill--good svg')).not.toBeNull();
    expect(q('[data-testid="drill-step"]')?.textContent).toBe(`Lesson ${lessonNo()} · Step 2 of 3: ${lessonRig.lessons[LEVEL_ID].practice[1].title}`);
    expect(q('[data-testid="drill-verdict"] [data-testid="good-tries"]')?.textContent).toBe('2 of 3 good tries');
    expect(q('[data-testid="drill-verdict"]')?.querySelectorAll('.pl-tries__dot--good')).toHaveLength(2);
    expect(q('[data-testid="drill-next"]')).toBeNull();
    expect(q('[data-testid="score-reveal"]')).toBeNull();
    expect(q('.pl-tiles')).toBeNull();
    expect(q('.pl-tally-lights')).toBeNull();
    expect(q('[data-testid="unlocked-strip"]')).toBeNull();
    expect(q('.pl-appbar__title')?.textContent).toBe('Practice');
    expect(document.activeElement).toBe(q('[data-testid="verdict"]'));
  });

  it('says when the try finished its step', async () => {
    const take = drillTake(PASSING, 1);
    session.attemptLog.value = [...tries(1, 2, true), take.attempt];
    await mount(take, actions(1));
    expect(q('[data-testid="good-tries"]')?.textContent).toBe('3 of 3 good tries');
    expect(q('[data-testid="drill-next"]')?.textContent).toBe('This step is done. On to the next one.');
  });

  it('says the singer is ready for the check once every step is done, and the check is the next move', async () => {
    setLessons(lessonWith(2));
    const take = drillTake(PASSING, 2);
    session.attemptLog.value = [...tries(0, 2, true), ...tries(1, 3, true), ...tries(2, 1, true), take.attempt];
    await mount(take, [{ kind: 'take-check', label: 'Take the check', primary: true, route: routeOf('sing', { target: 'level', levelId: LEVEL_ID }) }]);
    expect(q('[data-testid="good-tries"]')?.textContent).toBe('2 of 2 good tries');
    expect(q('[data-testid="drill-next"]')?.textContent).toBe('Every practice step is done: you are ready for the check.');
    q<HTMLButtonElement>('[data-testid="report-primary"]')!.click();
    expect(route.value).toEqual(routeOf('sing', { target: 'level', levelId: LEVEL_ID }));
  });

  it('says "Not quite yet", never alarm copy, and keeps the coaching and the replay (they are the training)', async () => {
    const take = drillTake(MISS, 1);
    session.attemptLog.value = [...tries(1, 1, true), take.attempt];
    await mount(take, actions(1));
    expect(q('[data-testid="verdict"]')?.textContent).toBe('Not quite yet');
    expect(q('.pl-drill--not-yet svg')).not.toBeNull();
    expect(q('[data-testid="good-tries"]')?.textContent).toBe('1 of 3 good tries');
    expect(text()).not.toMatch(/fail|wrong|bad/i);
    expect(q('[data-testid="score-reveal"]')).toBeNull();
    expect(q('.pl-tiles')).toBeNull();
    expect(q('[data-testid="coach-card"]')).not.toBeNull();
    expect(q('.pl-replay canvas')).not.toBeNull();
  });

  it('says why a try stopped early, or with nothing heard, did not count', async () => {
    lessonRig.good = false; // what the lesson's rule says of a try that did not run to its end
    const take = drillTake(PASSING, 1);
    await mount({ ...take, evaluation: { ...take.evaluation, passed: false, notJudged: 'stopped' } }, actions(1));
    expect(q('[data-testid="verdict"]')?.textContent).toBe('Not quite yet');
    expect(q('[data-testid="verdict-reason"]')?.textContent).toBe('Stopped early: a try counts when you sing it to the end.');
    await act(() => {
      render(null, container);
    });
    container.remove();
    await mount({ ...take, analysis: { ...take.analysis, tipContext: { ...take.analysis.tipContext, noVoice: true } } }, actions(1));
    expect(q('[data-testid="verdict"]')?.textContent).toBe('Nothing came through');
    expect(q('.pl-drill--silent')).not.toBeNull();
    expect(q('[data-testid="verdict-reason"]')?.textContent).toContain('Nothing came through the microphone');
  });

  it('sings the same step again from the amber button, replacing the report', async () => {
    const take = drillTake(MISS, 1);
    await mount(take, actions(1));
    expect(q('[data-testid="report-primary"]')?.textContent).toContain('Again');
    q<HTMLButtonElement>('[data-testid="report-primary"]')!.click();
    expect(route.value).toEqual(routeOf('sing', { target: 'drill', levelId: LEVEL_ID, itemIndex: '1' }));
    expect(back()).toBe(true);
    expect(route.value).toEqual(routeOf('level', { levelId: 'foundations.03' }));
  });

  it('"Back to the lesson" returns to the lesson page the try came from: one Back then leaves it (no second copy)', async () => {
    flow.afterTakeActions.mockReturnValue(actions(1));
    lastOutcomeSignal.value = drillTake(MISS, 1);
    resetRouterForTests([routeOf('home'), routeOf('map'), routeOf('level', { levelId: LEVEL_ID }), routeOf('report')]);
    installRouteGuard(() => ({ ok: true }));
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(() => {
      render(<Report />, container);
    });
    [...container.querySelectorAll<HTMLButtonElement>('nav button')].find((b) => b.textContent?.includes('Back to the lesson'))!.click();
    expect(route.value).toEqual(routeOf('level', { levelId: LEVEL_ID }));
    expect(back()).toBe(true);
    expect(route.value.name).toBe('map');
  });

  it('plays the try’s own demo from the coaching’s listen move, never the level’s check', async () => {
    const take = drillTake(MISS, 1);
    session.attemptLog.value = [...tries(1, 4, false), take.attempt];
    await mount(take, actions(1));
    expect(q('[data-testid="coach-card"]')?.getAttribute('data-depth')).toBe('4');
    q<HTMLButtonElement>('[data-testid="coach-listen"]')!.click();
    expect(createRunnerMock).toHaveBeenCalledWith({ kind: 'drill', levelId: LEVEL_ID, step: 1 });
    expect((runnerState.last as FakeRunner).listen).toHaveBeenCalledTimes(1);
  });

  it('still reports a try of a lesson it cannot find, from the counts the runner wrote', async () => {
    const take = drillTake(PASSING, 1, { good: 2, needed: 3 });
    setLessons();
    await mount(take, actions(1));
    expect(q('[data-testid="verdict"]')?.textContent).toBe('Good try');
    expect(q('[data-testid="drill-step"]')?.textContent).toBe('Step 2 of 3');
    expect(q('[data-testid="good-tries"]')?.textContent).toBe('2 of 3 good tries');
    expect(q('[data-testid="score-reveal"]')).toBeNull();
  });
});
