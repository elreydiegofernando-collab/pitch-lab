// @vitest-environment happy-dom
/**
 * Daily workout screen against a stubbed runtime (src/runtime/workout.ts is the runtime builder's) and the real
 * progress engine's plan: the set list, the 5/10/20 choice, Start, a workout in progress and its summary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'preact/test-utils';
import { render } from 'preact';
import type { KVStore } from '../../storage/kv-types';

vi.mock('../../storage/kv', () => ({
  openKV: async (): Promise<KVStore> => ({ persistent: true, get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] }),
}));
vi.mock('../../runtime/workout', async () => {
  const { signal } = await import('@preact/signals');
  const activeWorkout = signal<unknown>(null);
  return {
    activeWorkout,
    planWorkout: vi.fn(),
    startWorkout: vi.fn(),
    finishWorkout: vi.fn(),
    abandonWorkout: vi.fn(() => {
      activeWorkout.value = null;
    }),
    recordWorkoutTake: vi.fn(),
  };
});

import { WORLDS, getExercise } from '../../exercises';
import { buildDailyWorkout, withRoutines, type Workout as WorkoutPlan } from '../../progress';
import { installRouteGuard, resetRouterForTests, route, routeOf } from '../../router';
import * as runtime from '../../runtime/workout';
import type { WorkoutSession, WorkoutSummary } from '../../runtime/workout';
import { attemptLog, snapshot } from '../../state/session';
import { settings } from '../../state/settings';
import { DEFAULT_SETTINGS } from '../../state/settings-types';
import { passWorld, snapshotOf } from '../progress/test-fixtures';
import { Workout } from './Workout';

const attempts = passWorld('foundations', 'foundations.07');
const planFor = (minutes: 5 | 10 | 20): WorkoutPlan =>
  buildDailyWorkout({ minutes, snapshot: snapshotOf(attempts), worlds: WORLDS, attempts, now: Date.now(), getExercise: withRoutines(getExercise) });

let container: HTMLElement;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(() => {
    render(<Workout />, container);
  });
}

function sessionOf(plan: WorkoutPlan, taken: number[], finishedAt: string | null = null): WorkoutSession {
  return {
    workout: plan,
    startedAt: '2026-10-21T10:00:00.000Z',
    results: plan.items.map((_, i) => ({ attemptIds: Array.from({ length: taken[i] ?? 0 }, (__, k) => `a${i}-${k}`), bestScore: null, passedAny: false })),
    finishedAt,
  };
}

const summary: WorkoutSummary = { itemsDone: 5, itemCount: 5, takes: 9, minutes: 8.2, momentumBefore: 40.4, momentumAfter: 43.6 };
const text = (): string => container.textContent ?? '';
const button = (label: string): HTMLButtonElement => {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no button "${label}"`);
  return found;
};

beforeEach(() => {
  attemptLog.value = attempts;
  snapshot.value = snapshotOf(attempts);
  settings.value = { ...DEFAULT_SETTINGS, workoutMinutes: 10 };
  runtime.activeWorkout.value = null;
  vi.mocked(runtime.planWorkout).mockImplementation((minutes) => planFor(minutes));
  vi.mocked(runtime.startWorkout).mockImplementation((minutes) => {
    const started = sessionOf(planFor(minutes), []);
    runtime.activeWorkout.value = started;
    return started;
  });
  vi.mocked(runtime.finishWorkout).mockImplementation(() => {
    const s = runtime.activeWorkout.value;
    if (s) runtime.activeWorkout.value = { ...s, finishedAt: '2026-10-21T10:12:00.000Z' };
    return summary;
  });
  resetRouterForTests([routeOf('home'), routeOf('workout')]);
  installRouteGuard(() => ({ ok: true }));
});

afterEach(async () => {
  // Preact runs a passive effect's unmount cleanup after paint: flush it here, or it leaks into the next test.
  await act(() => {
    render(null, container);
  });
  container.remove();
  vi.clearAllMocks();
  runtime.activeWorkout.value = null;
  attemptLog.value = [];
  snapshot.value = snapshotOf([]);
});

describe('Workout: before', () => {
  it('shows the 5/10/20 choice with the saved length selected, and the plan as a numbered set list', async () => {
    await mount();
    const radios = Array.from(container.querySelectorAll('[role="radio"]'));
    expect(radios.map((r) => [r.textContent, r.getAttribute('aria-checked')])).toEqual([
      ['5 min', 'false'],
      ['10 min', 'true'],
      ['20 min', 'false'],
    ]);
    const items = Array.from(container.querySelectorAll('.pl-set__item'));
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items[0].textContent).toContain('Warm-up sirens');
    expect(items[0].querySelector('.pl-set__node')!.textContent).toBe('01');
    expect(items[items.length - 1].textContent).toContain('Cool-down glides');
    // Grouped by stage, each stage named once.
    const stages = Array.from(container.querySelectorAll('.pl-set__stage')).map((s) => s.textContent);
    expect(stages).toEqual(expect.arrayContaining(['Warm-up', 'From Foundations', 'Cool-down']));
    expect(new Set(stages).size).toBe(stages.length);
    // The tally light is on the first entry only.
    expect(container.querySelectorAll('.pl-set__item--next')).toHaveLength(1);
    expect(container.querySelector('.pl-set__item--next')).toBe(items[0]);
  });

  it('gives each item its reason, its takes and a duration, and the total', async () => {
    await mount();
    expect(text()).toContain('Easy sirens to wake the voice');
    expect(text()).toContain('Your next level');
    expect(text()).toMatch(/\d+ takes? · about \d+ min/);
    expect(container.querySelector('[data-testid="workout-total"]')!.textContent).toMatch(/^About \d+ of 10 min$/);
  });

  it('saves the length chosen and rebuilds the plan for it', async () => {
    await mount();
    await act(() => {
      button('20 min').click();
    });
    expect(settings.value.workoutMinutes).toBe(20);
    expect(runtime.planWorkout).toHaveBeenCalledWith(20);
    expect(container.querySelector('[data-testid="workout-total"]')!.textContent).toMatch(/of 20 min$/);
  });

  it('Start workout starts it and opens the first item on the Sing screen', async () => {
    await mount();
    await act(() => {
      button('Start workout').click();
    });
    expect(runtime.startWorkout).toHaveBeenCalledWith(10);
    expect(route.value).toEqual(routeOf('sing', { target: 'workout', itemIndex: '0' }));
  });

  it('reports a workout that will not start, and stays put', async () => {
    vi.mocked(runtime.startWorkout).mockImplementation(() => {
      throw new Error('Nothing to sing today.');
    });
    await mount();
    await act(() => {
      button('Start workout').click();
    });
    expect(text()).toContain('Could not start the workout. Nothing to sing today.');
    expect(route.value.name).toBe('workout');
  });

  it('shows the requirement, not a plan, while the workout is locked', async () => {
    vi.mocked(runtime.planWorkout).mockReturnValue({ minutes: 10, locked: true, hint: 'Pass your first level to unlock the daily workout.', items: [], totalEstSeconds: 0, totalEstMinutes: 0 });
    await mount();
    expect(text()).toContain('Pass your first level to unlock the daily workout.');
    expect(container.querySelector('.pl-set')).toBeNull();
    expect(button('Start workout').disabled).toBe(true);
  });
});

describe('Workout: in progress', () => {
  it('marks done items, keeps the light on the next one and continues there', async () => {
    const plan = planFor(10);
    const taken = plan.items.map((it, i) => (i === 0 ? it.takes : 0));
    runtime.activeWorkout.value = sessionOf(plan, taken);
    await mount();
    const items = Array.from(container.querySelectorAll('.pl-set__item'));
    expect(items[0].classList.contains('pl-set__item--done')).toBe(true);
    expect(items[1].classList.contains('pl-set__item--next')).toBe(true);
    expect(text()).toContain(`1 of ${plan.items.length} items done`);
    expect(items[1].textContent).toContain(`0 of ${plan.items[1].takes} takes`);
    await act(() => {
      button('Continue').click();
    });
    expect(route.value).toEqual(routeOf('sing', { target: 'workout', itemIndex: '1' }));
  });

  it('ends early on request and shows what was done', async () => {
    const plan = planFor(10);
    runtime.activeWorkout.value = sessionOf(plan, [plan.items[0].takes]);
    vi.mocked(runtime.finishWorkout).mockImplementation(() => {
      const s = runtime.activeWorkout.value;
      if (s) runtime.activeWorkout.value = { ...s, finishedAt: '2026-10-21T10:05:00.000Z' };
      return { ...summary, itemsDone: 1, itemCount: plan.items.length, takes: plan.items[0].takes };
    });
    await mount();
    await act(() => {
      button('End workout').click();
    });
    expect(container.querySelector('[data-testid="workout-summary-title"]')!.textContent).toBe('Workout ended early');
    expect(text()).toContain(`1 of ${plan.items.length}`);
  });
});

describe('Workout: summary', () => {
  it('shows the summary once every take is sung, asking the runtime for it once', async () => {
    const plan = planFor(10);
    runtime.activeWorkout.value = sessionOf(plan, plan.items.map((it) => it.takes));
    await mount();
    expect(runtime.finishWorkout).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="workout-summary-title"]')!.textContent).toBe('Workout complete');
    expect(text()).toContain('40 → 44'); // momentum before -> after
    expect(text()).toContain('8 min'); // minutes sung
    expect(text()).toContain('5 of 5');
  });

  it('Done clears the workout and returns to Home', async () => {
    const plan = planFor(10);
    runtime.activeWorkout.value = sessionOf(plan, plan.items.map((it) => it.takes));
    await mount();
    await act(() => {
      button('Done').click();
    });
    expect(runtime.abandonWorkout).toHaveBeenCalled();
    expect(route.value.name).toBe('home');
  });

  it('See your progress clears the workout and opens the dashboard on top of Home', async () => {
    const plan = planFor(10);
    runtime.activeWorkout.value = sessionOf(plan, plan.items.map((it) => it.takes));
    await mount();
    await act(() => {
      button('See your progress').click();
    });
    expect(runtime.abandonWorkout).toHaveBeenCalled();
    expect(route.value.name).toBe('dashboard');
  });

  it('clears a finished workout when the screen is left, so the next visit starts a fresh plan', async () => {
    const plan = planFor(10);
    runtime.activeWorkout.value = sessionOf(plan, plan.items.map((it) => it.takes), '2026-10-21T10:12:00.000Z');
    await mount();
    expect(runtime.abandonWorkout).not.toHaveBeenCalled();
    await act(() => {
      render(null, container);
    });
    expect(runtime.abandonWorkout).toHaveBeenCalledTimes(1);
  });
});
