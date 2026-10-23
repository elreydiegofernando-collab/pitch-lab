// @vitest-environment happy-dom
/** Sing with a fake runner: the controls follow the take's phase, every runner call is made from the click or key event itself. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';

vi.mock('../../audio/engine', async () => (await import('../practice/test-fakes')).engineModule());
vi.mock('../../runtime/runner', async () => (await import('../practice/test-fakes')).runnerModule());
vi.mock('../../state/session', async () => (await import('../practice/test-fakes')).sessionModule());
vi.mock('../../state/settings', async () => (await import('../practice/test-fakes')).settingsModule());
vi.mock('../../state/audio', async () => (await import('../practice/test-fakes')).audioModule());
vi.mock('../pitch-view/PitchViewHost', async () => ({ PitchViewHost: (await import('../practice/test-fakes')).PitchViewHostStub }));

import { FRAME_RATE } from '../../analysis/fixtures';
import { EXERCISES, WORLDS } from '../../exercises';
import { CUE } from '../../exercises/cues';
import { bindDesktopBackKey, installRouteGuard, resetRouterForTests, route, routeOf } from '../../router';
import { paramsForTarget } from '../../runtime/targets';
import type { PreparedRun, RunTarget } from '../../runtime/types';
import { HINT_TICK_MS } from '../practice/live-hint';
import { exercise, note, prepare, rest, voiceFrames } from '../practice/live-hint-fixtures';
import {
  FakeRunner,
  createRunnerMock,
  engineRig,
  hostProbe,
  makePrepared,
  resetRunner,
  resetSession,
  resetView,
  runnerState,
  viewMocks,
} from '../practice/test-fakes';
import { Sing } from './Sing';

const LEVEL: RunTarget = { kind: 'level', levelId: 'foundations.03' };

let container: HTMLElement;

function openStack(target: RunTarget): void {
  resetRouterForTests([routeOf('home'), routeOf('level', { levelId: 'foundations.03' }), routeOf('sing', paramsForTarget(target))]);
  installRouteGuard(() => ({ ok: true }));
}

async function mount(target: RunTarget = LEVEL): Promise<FakeRunner> {
  openStack(target);
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(() => {
    render(<Sing />, container);
  });
  return runnerState.last as FakeRunner;
}

const q = <T extends Element = HTMLElement>(sel: string): T | null => container.querySelector<T>(sel);
const text = (): string => container.textContent ?? '';
const press = (init: KeyboardEventInit): void => {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
};

beforeEach(() => {
  resetSession(['foundations.01', 'foundations.02']);
  resetRunner();
  resetView();
  bindDesktopBackKey();
});

afterEach(async () => {
  await act(() => {
    render(null, container);
  });
  container.remove();
});

describe('Sing: the ready screen', () => {
  it('shows the level, the readouts and the three controls, and makes one runner for the visit', async () => {
    const runner = await mount();
    expect(createRunnerMock).toHaveBeenCalledTimes(1);
    expect(createRunnerMock).toHaveBeenCalledWith(LEVEL);
    expect(runner.target).toEqual(LEVEL);
    expect(text()).toContain(runner.prepared.value!.level!.title);
    expect(q('[data-testid="listen-button"]')?.textContent).toContain('Listen');
    expect(q('[data-testid="sing-button"]')?.textContent).toContain('Sing');
    expect(q('[data-testid="more-button"]')).not.toBeNull();
    expect(q('[data-testid="live-note"]')).not.toBeNull();
  });

  it('previews the material over the canvas until the take starts', async () => {
    const runner = await mount();
    expect(q('.pl-sing__preview')).not.toBeNull();
    await act(() => {
      runner.phase.value = 'starting';
    });
    expect(q('.pl-sing__preview')).toBeNull();
  });

  it('gives the pitch view the level tolerance, the material window and no targets before the take', async () => {
    await mount();
    const props = hostProbe.props!;
    expect(props.toleranceCents).toBe(50); // Sustain I is an easy-tolerance level
    expect(props.targets).toBeUndefined();
    const notes = runnerState.last!.prepared.value!.realized.notes;
    const lows = notes.map((n) => n.midi);
    expect(props.options?.lowMidi).toBeLessThan(Math.min(...lows));
    expect(props.options?.highMidi).toBeGreaterThan(Math.max(...lows));
    expect(props.options?.autoRange).toBe(false);
    expect(props.vibratoZone ?? null).toBeNull();
  });

  it('gives the Range finder a fifth of room past its guide bars, so the trace stays in view as the singer explores', async () => {
    await mount({ kind: 'level', levelId: 'foundations.01' });
    const lows = runnerState.last!.prepared.value!.realized.notes.map((n) => n.midi);
    const props = hostProbe.props!;
    expect(props.options?.lowMidi).toBeLessThanOrEqual(Math.min(...lows) - 7);
    expect(props.options?.highMidi).toBeGreaterThanOrEqual(Math.max(...lows) + 7);
  });

  it('shows the vibrato zone where the exercise scores vibrato', async () => {
    const def = EXERCISES.find((e) => e.analyzers.includes('vibrato') && e.kind !== 'boss-recital')!;
    const level = WORLDS.flatMap((w) => w.levels).find((l) => l.exerciseId === def.id)!;
    await mount({ kind: 'level', levelId: level.id });
    expect(hostProbe.props!.vibratoZone).toEqual({ minExtentCents: 20, maxExtentCents: 60 });
  });

  it('refuses a malformed take with a way back', async () => {
    resetRouterForTests([routeOf('home'), { name: 'sing', params: { target: 'level' } }]);
    installRouteGuard(() => ({ ok: true }));
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(() => {
      render(<Sing />, container);
    });
    expect(q('[data-testid="unavailable"]')).not.toBeNull();
    expect(createRunnerMock).not.toHaveBeenCalled();
  });

  it('survives a runner that cannot be made', async () => {
    runnerState.fail = true;
    await mount();
    expect(q('[data-testid="unavailable"]')).not.toBeNull();
    expect(text()).toContain("couldn't be prepared");
  });
});

describe('Sing: calls the runner straight from the gesture', () => {
  it('calls runner.sing() synchronously inside the click handler', async () => {
    const runner = await mount();
    const button = q<HTMLButtonElement>('[data-testid="sing-button"]')!;
    // No await between the click and the assertion: the call must already have happened.
    button.click();
    expect(runner.sing).toHaveBeenCalledTimes(1);
    expect(runner.stop).not.toHaveBeenCalled();
  });

  it('calls runner.listen() synchronously from the Listen click', async () => {
    const runner = await mount();
    q<HTMLButtonElement>('[data-testid="listen-button"]')!.click();
    expect(runner.listen).toHaveBeenCalledTimes(1);
  });

  it('turns Listen into Stop while the demo plays, and Stop calls listen() again', async () => {
    const runner = await mount();
    await act(() => {
      runner.phase.value = 'listening';
    });
    const listen = q<HTMLButtonElement>('[data-testid="listen-button"]')!;
    expect(listen.textContent).toContain('Stop');
    listen.click();
    expect(runner.listen).toHaveBeenCalledTimes(1);
  });

  it('keeps Sing available while the demo plays', async () => {
    const runner = await mount();
    await act(() => {
      runner.phase.value = 'listening';
    });
    const sing = q<HTMLButtonElement>('[data-testid="sing-button"]')!;
    expect(sing.disabled).toBe(false);
    sing.click();
    expect(runner.sing).toHaveBeenCalledTimes(1);
  });

  it('Space sings and L listens on a desktop, from the key event itself', async () => {
    const runner = await mount();
    press({ code: 'Space', key: ' ' });
    expect(runner.sing).toHaveBeenCalledTimes(1);
    press({ code: 'KeyL', key: 'l' });
    expect(runner.listen).toHaveBeenCalledTimes(1);
  });

  it('ignores a held key, and Space on a focused button (the button does its own click)', async () => {
    const runner = await mount();
    press({ code: 'Space', key: ' ', repeat: true });
    expect(runner.sing).not.toHaveBeenCalled();
    const listen = q<HTMLButtonElement>('[data-testid="listen-button"]')!;
    listen.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true }));
    expect(runner.sing).not.toHaveBeenCalled();
  });
});

describe('Sing: More', () => {
  it('has the Listen volume and Setup, and no Reset audio (that reopens a microphone the runner would not own)', async () => {
    await mount();
    q<HTMLButtonElement>('[data-testid="more-button"]')!.click();
    await act(() => {});
    expect(document.body.textContent).toContain('Listen volume');
    const names = [...document.querySelectorAll('button')].map((b) => b.textContent ?? '');
    expect(names.some((n) => n.includes('Setup'))).toBe(true);
    expect(names.some((n) => n.includes('Reset audio'))).toBe(false);
  });
});

describe('Sing: the phases of a take', () => {
  it('shows "Starting…" while the microphone starts, and nothing can be tapped', async () => {
    const runner = await mount();
    await act(() => {
      runner.phase.value = 'starting';
    });
    const sing = q<HTMLButtonElement>('[data-testid="sing-button"]')!;
    expect(sing.textContent).toContain('Starting…');
    expect(sing.disabled).toBe(true);
    expect(q<HTMLButtonElement>('[data-testid="listen-button"]')!.disabled).toBe(true);
    expect(q<HTMLButtonElement>('[data-testid="more-button"]')!.disabled).toBe(true);
    expect(viewMocks.clear).toHaveBeenCalled();
  });

  it('counts in with a big counter over the canvas, and Sing becomes Stop', async () => {
    const runner = await mount();
    await act(() => {
      runner.phase.value = 'count-in';
      runner.origin.value = 12.5;
      runner.countIn.value = 3;
    });
    const counter = q('[data-testid="count-in"]')!;
    expect(counter.textContent).toContain('3');
    expect(counter.textContent).toContain('1');
    const stop = q<HTMLButtonElement>('[data-testid="sing-button"]')!;
    expect(stop.textContent).toContain('Stop');
    stop.click();
    expect(runner.stop).toHaveBeenCalledTimes(1);
    expect(runner.sing).not.toHaveBeenCalled();
    await act(() => {
      runner.countIn.value = null;
    });
    expect(q('[data-testid="count-in"]')).toBeNull();
  });

  it('puts the targets on the canvas at the runner origin once the take starts', async () => {
    const runner = await mount();
    await act(() => {
      runner.phase.value = 'count-in';
      runner.origin.value = 12.5;
    });
    expect(hostProbe.props!.targetOrigin).toBe(12.5);
    expect(hostProbe.props!.targets).toBe(runner.prepared.value!.realized.notes);
  });

  it('shows the cue, the progress hairline and the context chip while singing', async () => {
    const runner = await mount();
    await act(() => {
      runner.phase.value = 'singing';
      runner.origin.value = 12.5;
      runner.cue.value = 'Hold it steady and straight';
      runner.progress.value = 0.5;
    });
    expect(q('[data-testid="cue-pill"]')?.textContent).toBe('Hold it steady and straight');
    expect(q('[data-testid="progress-hairline"]')?.style.transform).toBe('scaleX(0.5)');
    await act(() => {
      runner.progress.value = null;
    });
    expect(q('[data-testid="progress-hairline"]')?.style.opacity).toBe('0');
  });

  it('freezes the canvas and shows "Scoring…" while the take is judged', async () => {
    const runner = await mount();
    await act(() => {
      runner.phase.value = 'analyzing';
    });
    expect(viewMocks.stop).toHaveBeenCalled();
    const sing = q<HTMLButtonElement>('[data-testid="sing-button"]')!;
    expect(sing.textContent).toContain('Scoring…');
    expect(sing.disabled).toBe(true);
    expect(q('.pl-sing--scoring')).not.toBeNull();
  });

  it('opens the report in place of the take when the runner is done', async () => {
    const runner = await mount();
    await act(() => {
      runner.phase.value = 'done';
    });
    expect(route.value.name).toBe('report');
    // Replaced, not pushed: Back from the report returns to the level.
    expect(route.value).toEqual(routeOf('report'));
  });

  it('disposes the runner when the screen goes away', async () => {
    const runner = await mount();
    await act(() => {
      render(null, container);
    });
    expect(runner.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('Sing: context chips', () => {
  it('names the rung of a tempo ladder', async () => {
    runnerState.prepare = () => makePrepared('runs.03');
    const runner = await mount({ kind: 'level', levelId: 'runs.03' });
    const p = runner.prepared.value!;
    expect(p.ladder).not.toBeNull();
    expect(q('[data-testid="context-chip"]')?.textContent).toBe(`${p.bpm} bpm · rung ${p.ladder!.index + 1} of ${p.ladder!.rungs.length}`);
  });

  it('names the audition test and the workout item', async () => {
    runnerState.prepare = () => ({ ...makePrepared('foundations.03'), audition: { index: 1, count: 4, unlocksFirst: 'Sustain I', unlocksLast: 'Sirens & glides' } });
    await mount({ kind: 'audition', worldId: 'foundations' });
    expect(q('[data-testid="context-chip"]')?.textContent).toBe('Test 2 of 4');
    await act(() => {
      render(null, container);
    });
    container.remove();
    resetRunner();
    const base = makePrepared('foundations.03');
    runnerState.prepare = () => ({
      ...base,
      workout: { item: { stage: 'review' } as never, itemIndex: 2, itemCount: 6, take: 1 },
    });
    await mount({ kind: 'workout', itemIndex: 2 });
    expect(q('[data-testid="context-chip"]')?.textContent).toBe('Workout · 3 of 6');
  });

  it('shows one chip at most, and none for a plain level', async () => {
    await mount();
    expect(q('[data-testid="context-chip"]')).toBeNull();
  });
});

describe('Sing: a check-up task with no range saved', () => {
  const DEFAULT_RANGE_NOTE = 'Using a default range until you pass the Range finder.';
  /** A check-up task's prepared run: `levelId` names the material; the target and the check-up are the task's. */
  const task = (levelId: string, taskIndex: number, range: null | undefined) => ({
    ...makePrepared(levelId, { range }),
    target: { kind: 'checkup' as const, taskIndex },
    checkup: { taskIndex, taskCount: 5, checkupId: 'c1' },
  });

  it('says the task uses a default range: there is no Level screen before it to say so', async () => {
    runnerState.prepare = () => ({ ...task('foundations.05', 2, null), level: null });
    await mount({ kind: 'checkup', taskIndex: 2 });
    expect(q('.pl-banner--info')?.textContent).toContain(DEFAULT_RANGE_NOTE);
    expect(q('[data-testid="context-chip"]')?.textContent).toBe('Check-up · 3 of 5');
  });

  it('says nothing on the Range finder task itself, once a range is saved, or on a level take (its Level screen says it)', async () => {
    const cases: Array<[() => ReturnType<typeof makePrepared>, RunTarget]> = [
      [() => task('foundations.01', 0, null), { kind: 'checkup', taskIndex: 0 }],
      [() => ({ ...task('foundations.05', 2, undefined), level: null }), { kind: 'checkup', taskIndex: 2 }],
      [() => makePrepared('foundations.03', { range: null }), LEVEL],
    ];
    for (const [prepare, target] of cases) {
      resetRunner();
      runnerState.prepare = prepare;
      await mount(target);
      expect(text()).not.toContain(DEFAULT_RANGE_NOTE);
      await act(() => {
        render(null, container);
      });
      container.remove();
    }
  });
});

describe('Sing: errors and Esc', () => {
  it('shows a mic error inline with its fix, and the primary button says "Try again"', async () => {
    const runner = await mount();
    await act(() => {
      runner.error.value = { code: 'mic', message: 'Microphone blocked. In Settings › Safari › Microphone choose Allow, then tap Try again.' };
      runner.phase.value = 'error';
    });
    expect(text()).toContain('Microphone blocked.');
    const retry = q<HTMLButtonElement>('[data-testid="sing-button"]')!;
    expect(retry.textContent).toContain('Try again');
    retry.click();
    expect(runner.sing).toHaveBeenCalledTimes(1);
    // One amber button on the screen: the banner carries no action of its own.
    expect(container.querySelectorAll('.pl-btn--primary')).toHaveLength(0);
  });

  it('offers only a way back when the take is locked or unknown', async () => {
    const runner = await mount();
    await act(() => {
      runner.error.value = { code: 'locked', message: 'This level is not open yet.' };
      runner.phase.value = 'error';
    });
    expect(text()).toContain('This level is not open yet.');
    expect(q<HTMLButtonElement>('[data-testid="sing-button"]')!.disabled).toBe(true);
    const go = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Go back')!;
    go.click();
    expect(route.value.name).toBe('level');
  });

  it('Esc during a take goes back and discards it: it never submits half a take the way Stop does', async () => {
    const runner = await mount();
    await act(() => {
      runner.phase.value = 'singing';
    });
    press({ key: 'Escape', code: 'Escape' });
    expect(route.value.name).toBe('level');
    await act(() => {
      render(null, container); // the screen leaves: the runner is disposed, which discards the take
    });
    expect(runner.stop).not.toHaveBeenCalled();
    expect(runner.dispose).toHaveBeenCalledTimes(1);
  });

  it('Esc during the count-in goes back too', async () => {
    const runner = await mount();
    await act(() => {
      runner.phase.value = 'count-in';
    });
    press({ key: 'Escape', code: 'Escape' });
    expect(runner.stop).not.toHaveBeenCalled();
    expect(route.value.name).toBe('level');
  });

  it('Esc stops a playing demo first and stays', async () => {
    const runner = await mount();
    await act(() => {
      runner.phase.value = 'listening';
    });
    press({ key: 'Escape', code: 'Escape' });
    expect(runner.listen).toHaveBeenCalledTimes(1);
    expect(route.value.name).toBe('sing');
  });

  it('can still be left while the take is scored: the runner finishes writing it on its own', async () => {
    const runner = await mount();
    await act(() => {
      runner.phase.value = 'analyzing';
    });
    expect(runner.stop).not.toHaveBeenCalled();
    press({ key: 'Escape', code: 'Escape' });
    expect(route.value.name).toBe('level');
    expect(runner.stop).not.toHaveBeenCalled();
  });

  it('Back leaves the screen when idle', async () => {
    await mount();
    container.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!.click();
    expect(route.value.name).toBe('level');
  });
});

describe('Sing: the live hint', () => {
  const DRILL: RunTarget = { kind: 'drill', levelId: 'foundations.03', step: 1 };
  /**
   * An eight-second hold in the medium (+-25) zone of Hold it steady and after, where steady and wobbly are said; the
   * note is the one the exercise was realized at.
   */
  const HOLD = prepare(exercise([note(0, 8)], { tolerance: 'default' }));
  const NOTE = HOLD.realized.steps[0].midi!;
  /** An echo: the app plays the note for two seconds, a one-second rest, then the singer's three. */
  const ECHO = prepare(exercise([note(0, 2, { cue: CUE.listen }), rest(1), note(0, 3, { cue: CUE.sing })]));
  const ORIGIN = 12.5;

  /** The prepared run the screen is given for a target: the level's or the drill's own, with a hand-written exercise in it. */
  const singable =
    (source: typeof HOLD) =>
    (target: RunTarget): PreparedRun => ({
      ...makePrepared('foundations.01'),
      target,
      def: source.def,
      realized: source.realized,
      ...(target.kind === 'drill' ? { drill: { levelId: target.levelId, step: target.step, stepCount: 4, good: 0, needed: 2 } } : {}),
    });

  const hint = (): HTMLElement => q('[data-testid="live-hint"]')!;
  const words = (): string => q('[data-testid="live-hint-text"]')?.textContent ?? '';
  const tick = (): Promise<void> =>
    act(() => {
      vi.advanceTimersByTime(HINT_TICK_MS);
    });
  /** The take is on (or in its count-in), on the runner's clock. */
  const start = (runner: FakeRunner, phase: 'count-in' | 'singing' = 'singing'): Promise<void> =>
    act(() => {
      runner.phase.value = phase;
      runner.origin.value = ORIGIN;
    });
  /** Deliver frames as the engine would, a timer period at a time, with a look after each. */
  async function play(frames: ReturnType<typeof voiceFrames>): Promise<void> {
    const per = Math.round((FRAME_RATE * HINT_TICK_MS) / 1000);
    for (let i = 0; i < frames.length; i += per) {
      engineRig.emit(frames.slice(i, i + per));
      await tick();
    }
  }
  const silence = (from: number, to: number) => voiceFrames(ORIGIN, from, to, () => NaN);
  const sung = (from: number, to: number, cents: number) => voiceFrames(ORIGIN, from, to, () => NOTE + cents / 100, 2);

  beforeEach(() => {
    vi.useFakeTimers();
    runnerState.prepare = singable(HOLD);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is on the canvas from the start, silent, and listening to nothing until the take', async () => {
    const runner = await mount();
    expect(q('.pl-live-body__canvas [data-testid="live-hint"]')).not.toBeNull();
    expect(hint().dataset.kind).toBe('none');
    const quiet = engineRig.listeners; // the readouts
    await act(() => {
      runner.phase.value = 'listening'; // the Listen demo: the app plays, nothing to say
    });
    expect(hint().dataset.kind).toBe('none');
    expect(engineRig.listeners).toBe(quiet);
  });

  it('follows the singer through a take: sing now, a little lower, then steady, and lets go when the take is scored', async () => {
    const runner = await mount();
    const quiet = engineRig.listeners;
    await start(runner);
    expect(engineRig.listeners).toBe(quiet + 1);
    await play(silence(0, 0.6));
    expect(hint().dataset.kind).toBe('sing');
    expect(words()).toBe('sing now');
    await play(sung(0.6, 2.2, 80)); // 80 cents sharp in a medium zone
    expect(words()).toBe('a little lower');
    expect(hint().dataset.glyph).toBe('down');
    await play(sung(2.2, 5.5, 0));
    expect(words()).toBe('steady, good');
    expect(hint().dataset.glyph).toBe('check');
    await act(() => {
      runner.phase.value = 'analyzing';
    });
    expect(hint().dataset.kind).toBe('none');
    expect(engineRig.listeners).toBe(quiet);
  });

  it('reads the gauge against the note asked for, as the hint does (review R1): a half step sharp is off, never "On it"', async () => {
    const runner = await mount();
    await start(runner);
    await play(sung(0.6, 2.4, 100)); // right on the next key up: the nearest note would have read "On it"
    expect(q('[data-testid="live-pitch"]')?.textContent).toBe('A little high');
    expect(words()).toBe('a little lower');
    await play(sung(2.4, 3.6, 0));
    expect(q('[data-testid="live-pitch"]')?.textContent).toBe('On it');
  });

  it('keeps its words while the screen around it changes (the cue, the progress)', async () => {
    const runner = await mount();
    await start(runner);
    await play(silence(0, 0.6));
    expect(words()).toBe('sing now');
    await act(() => {
      runner.cue.value = 'Hold it steady and straight';
      runner.progress.value = 0.3;
    });
    await act(() => {
      runner.cue.value = 'Next note';
    });
    expect(hint().dataset.kind).toBe('sing');
    expect(words()).toBe('sing now');
  });

  it.each([
    ['a level take', LEVEL],
    ['a drill take', DRILL],
  ])('is the same on %s', async (_name, target) => {
    const runner = await mount(target);
    await start(runner);
    await play(silence(0, 0.6));
    expect(words()).toBe('sing now');
    await play(sung(0.6, 2.0, -80));
    expect(words()).toBe('a little higher');
    expect(hint().dataset.glyph).toBe('up');
  });

  it('says "listen..." while the app plays the note, "breathe" in the rest, and "sing now" on the singer\'s turn', async () => {
    runnerState.prepare = singable(ECHO);
    const runner = await mount();
    await start(runner);
    await play(silence(0, 0.9));
    expect(words()).toBe('listen...');
    await play(silence(0.9, 2.5));
    expect(words()).toBe('breathe');
    await play(silence(2.5, 3.6));
    expect(words()).toBe('sing now');
  });

  it('says "listen..." through the count-in while its starting pitch sounds', async () => {
    const runner = await mount();
    await start(runner, 'count-in');
    await play(silence(-1.5, -0.8));
    expect(hint().dataset.kind).toBe('listen');
    expect(words()).toBe('listen...');
  });
});
