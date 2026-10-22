// @vitest-environment happy-dom
/** Report on a real judged take (the synthetic singer through the real analyzers), with the runner's next-step list mocked. */
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
const exportMock = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock('../../coaching/export', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../coaching/export')>()), buildCoachingFile: exportMock.build }));

import { back, installRouteGuard, resetRouterForTests, route, routeOf } from '../../router';
import { coachTake } from '../../coaching/coach';
import { attempt } from '../../progress/test-fixtures';
import type { AfterTakeAction, TakeOutcome } from '../../runtime/types';
import { makeOutcome } from '../practice/outcome-fixture';
import { createRunnerMock, lastOutcomeSignal, resetRunner, resetSession, runnerState, session, settingsSignal, snapshotAfter, synthMocks, type FakeRunner } from '../practice/test-fakes';
import { DEFAULT_SETTINGS } from '../../state/settings-types';
import { Report } from './Report';

const NEXT: AfterTakeAction[] = [
  { kind: 'retry', label: 'Retry', primary: false, route: routeOf('sing', { target: 'level', levelId: 'foundations.03' }) },
  { kind: 'next-level', label: 'Next level', primary: true, route: routeOf('level', { levelId: 'foundations.04' }) },
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
    expect(q('.pl-verdict')?.textContent).toContain('Sustain I');
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
  it('shows each tile with its value, its target and a glyph for met or unmet', async () => {
    await mount(PASSING);
    const tiles = [...container.querySelectorAll('.pl-tile')];
    expect(tiles.length).toBe(PASSING.tiles.length);
    expect(tiles.length).toBeGreaterThanOrEqual(2);
    expect(tiles.length).toBeLessThanOrEqual(4);
    for (const [i, el] of tiles.entries()) {
      const t = PASSING.tiles[i];
      expect(el.textContent).toContain(t.label);
      expect(el.textContent).toContain(t.display);
      expect(el.textContent).toContain(t.targetDisplay);
      expect(el.textContent).toContain(t.op === '>=' ? '≥' : '≤');
      expect(el.querySelector('svg')).not.toBeNull();
      expect(el.textContent).toMatch(/target met|target not met|not measured/);
    }
  });

  it('marks an unmet tile with words as well as a glyph', async () => {
    await mount(MISS, MISSED);
    expect(text()).toContain('target not met');
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
    expect(route.value).toEqual(routeOf('level', { levelId: 'foundations.04' }));
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
    { kind: 'level-passed', levelId: 'foundations.03', title: 'Sustain I', mastery: 2 },
    { kind: 'level-opened', levelId: 'foundations.04', title: 'Sustain II' },
    { kind: 'feature', featureId: 'live.cracks', title: 'Crack markers on the Live trace' },
  ];

  it('lists what opened after a pass, but not the pass itself', async () => {
    await mount({ ...PASSING, unlocked: events });
    const strip = q('[data-testid="unlocked-strip"]')!;
    expect(strip).not.toBeNull();
    expect(strip.textContent).toContain('Unlocked');
    expect(strip.textContent).toContain('Sustain II');
    expect(strip.textContent).toContain('Crack markers on the Live trace');
    expect(strip.textContent).not.toContain('Sustain I,');
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
