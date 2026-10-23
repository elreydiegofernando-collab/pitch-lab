// @vitest-environment happy-dom
/**
 * Setup with a fake engine that changes state like the real one, a stand-in synth and a stand-in calibration: the route
 * shown is the route stored, and the latency calibration opens the mic itself before it listens for the clicks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import type { EngineError, EngineInfo, EngineState } from '../../audio/engine-types';

const fake = vi.hoisted(() => {
  const order: string[] = [];
  const listeners = new Set<(s: string, e: unknown) => void>();
  const engine = {
    state: 'idle' as string,
    error: null as { code: string; message: string } | null,
    context: null,
    output: null,
    /** What start() ends in: a state, or an error code. */
    startsTo: 'running' as string,
    set(state: string, error: { code: string; message: string } | null = null): void {
      engine.state = state;
      engine.error = error;
      for (const l of [...listeners]) l(state, error);
    },
    start: vi.fn(async () => {
      order.push('engine.start');
      engine.set('starting');
      await Promise.resolve();
      if (engine.startsTo === 'running') engine.set('running');
      else engine.set('error', { code: engine.startsTo, message: engine.startsTo });
    }),
    resume: vi.fn(async () => {
      order.push('engine.resume');
      engine.set('running');
    }),
    reset: vi.fn(async () => undefined),
    stop: vi.fn(async () => engine.set('idle')),
    ensureContext: vi.fn(),
    onState: (l: (s: string, e: unknown) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    onFrame: () => () => undefined,
    onStats: () => () => undefined,
    onTransient: () => () => undefined,
    info: (): Partial<EngineInfo> => ({ state: engine.state as EngineState }),
    listInputs: async () => [],
    setPreferredInput: vi.fn(),
    setTransientDetection: vi.fn(),
  };
  const calibration = {
    result: new Promise<unknown>(() => undefined),
    tap: vi.fn(),
    cancel: vi.fn(),
    onProgress: (_cb: (p: { clicksPlayed: number; clicksTotal: number; eventsDetected: number }) => void): (() => void) => () => undefined,
  };
  const synth = {
    playNote: vi.fn(() => {
      order.push(`playNote while ${engine.state}`);
    }),
  };
  return { order, engine, calibration, synth };
});

vi.mock('../../audio/engine', () => ({ getEngine: () => fake.engine }));
vi.mock('../../state/audio', () => ({
  getSynth: vi.fn(() => {
    fake.order.push(`getSynth while ${fake.engine.state}`);
    return fake.synth;
  }),
  resetAudio: vi.fn(async () => undefined),
}));
vi.mock('../../audio/latency', () => ({
  startCalibration: vi.fn((method: string) => {
    fake.order.push(`startCalibration ${method} while ${fake.engine.state}`);
    return { ...fake.calibration, method };
  }),
}));

import { jargonIn } from '../../coaching/plain';
import { resetRouterForTests, routeOf } from '../../router';
import { startCalibration } from '../../audio/latency';
import { deviceSettings } from '../../state/settings';
import { DEFAULT_DEVICE_SETTINGS } from '../../state/settings-types';
import { Setup } from './Setup';

let container: HTMLElement;

async function mount(): Promise<void> {
  resetRouterForTests([routeOf('home'), routeOf('setup')]);
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(() => {
    render(<Setup />, container);
  });
}

const button = (name: string): HTMLButtonElement =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name)!;

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

async function toLatencyStep(): Promise<void> {
  for (let i = 0; i < 3; i++) await click(button('Next'));
  expect(container.textContent).toContain('Step 4 of 5: Timing check');
}

async function toAudioCheckStep(): Promise<void> {
  for (let i = 0; i < 2; i++) await click(button('Next'));
  expect(container.textContent).toContain('Step 3 of 5: Audio check');
}

beforeEach(() => {
  fake.order.length = 0;
  // Through set(), so the engine-store signal the screen renders from is reset too (not only the engine field).
  fake.engine.set('idle');
  fake.engine.startsTo = 'running';
  fake.engine.start.mockClear();
  fake.engine.resume.mockClear();
  fake.synth.playNote.mockClear();
  vi.mocked(startCalibration).mockClear();
  fake.calibration.result = new Promise<unknown>(() => undefined);
  fake.calibration.onProgress = () => () => undefined;
  deviceSettings.value = { ...DEFAULT_DEVICE_SETTINGS };
});

afterEach(async () => {
  await act(() => {
    render(null, container);
  });
  container.remove();
});

describe('Setup: the route shown is the route stored', () => {
  it('shows Wired chosen on a fresh device, and going on from step 1 stores Wired', async () => {
    expect(deviceSettings.value.route).toBe('unknown');
    await mount();
    const wired = [...container.querySelectorAll('[role="radio"]')].find((r) => r.textContent?.includes('Wired'))!;
    expect(wired.getAttribute('aria-checked')).toBe('true');
    await click(button('Next'));
    expect(deviceSettings.value.route).toBe('wired');
  });

  it('keeps a route the singer chose', async () => {
    deviceSettings.value = { ...DEFAULT_DEVICE_SETTINGS, route: 'speaker' };
    await mount();
    await click(button('Next'));
    expect(deviceSettings.value.route).toBe('speaker');
  });
});

describe('Setup: latency calibration opens the mic itself', () => {
  it('Loopback with the mic off: Run opens the mic first, and the synth and the clicks only once it runs', async () => {
    await mount();
    await toLatencyStep();
    expect(container.querySelector('[data-testid="calibration-mic-note"]')).not.toBeNull();
    await click(button('Run'));
    expect(fake.engine.start).toHaveBeenCalledTimes(1);
    expect(fake.order).toEqual(['engine.start', 'getSynth while running', 'startCalibration loopback while running']);
    expect(startCalibration).toHaveBeenCalledWith('loopback', expect.objectContaining({ engine: fake.engine }));
  });

  it('a mic that will not open shows why, and never starts the clicks', async () => {
    fake.engine.startsTo = 'permission-denied';
    await mount();
    await toLatencyStep();
    await click(button('Run'));
    expect(startCalibration).not.toHaveBeenCalled();
    expect(container.querySelector('.pl-banner--error')?.textContent).toMatch(/^Microphone blocked\./);
  });

  it('an interrupted mic (a call) is resumed inside the tap', async () => {
    fake.engine.state = 'interrupted';
    fake.engine.error = { code: 'mic-ended', message: 'call' } satisfies EngineError;
    await mount();
    await toLatencyStep();
    await click(button('Run'));
    expect(fake.engine.resume).toHaveBeenCalledTimes(1);
    expect(fake.order).toEqual(['engine.resume', 'getSynth while running', 'startCalibration loopback while running']);
  });

  it('a running mic starts the clicks at once', async () => {
    fake.engine.state = 'running';
    await mount();
    await toLatencyStep();
    await click(button('Run'));
    expect(fake.engine.start).not.toHaveBeenCalled();
    expect(startCalibration).toHaveBeenCalledTimes(1);
  });

  it('Tap never touches the mic', async () => {
    await mount();
    await toLatencyStep();
    await click([...container.querySelectorAll<HTMLElement>('[role="radio"]')].find((r) => r.textContent === 'Tap')!);
    expect(container.querySelector('[data-testid="calibration-mic-note"]')).toBeNull();
    await click(button('Run'));
    expect(fake.engine.start).not.toHaveBeenCalled();
    expect(fake.order).toEqual(['getSynth while idle', 'startCalibration tap while idle']);
  });

  it('leaving mid-run cancels the click train', async () => {
    fake.engine.state = 'running';
    await mount();
    await toLatencyStep();
    await click(button('Run'));
    fake.calibration.cancel.mockClear();
    await act(() => {
      render(null, container);
    });
    expect(fake.calibration.cancel).toHaveBeenCalled();
  });
});

describe('Setup: the audio check plays its tone with the mic on', () => {
  it('with the mic off the button is usable: the tap opens the mic first, and the tone plays once it runs', async () => {
    await mount();
    await toAudioCheckStep();
    const tone = button('Play a test sound');
    expect(tone.disabled).toBe(false);
    expect(container.querySelector('[data-testid="tone-mic-note"]')).not.toBeNull();
    await click(tone);
    expect(fake.engine.start).toHaveBeenCalledTimes(1);
    expect(fake.order).toEqual(['engine.start', 'getSynth while running', 'playNote while running']);
  });

  it('a mic that will not open says why and plays nothing', async () => {
    fake.engine.startsTo = 'permission-denied';
    await mount();
    await toAudioCheckStep();
    await click(button('Play a test sound'));
    expect(fake.synth.playNote).not.toHaveBeenCalled();
    expect(container.querySelector('.pl-banner--error')?.textContent).toMatch(/^Microphone blocked\..*tap Play a test sound again\.$/);
  });

  it('an interrupted mic (a call) is resumed inside the tap', async () => {
    fake.engine.set('interrupted', { code: 'mic-ended', message: 'call' } satisfies EngineError);
    await mount();
    await toAudioCheckStep();
    await click(button('Play a test sound'));
    expect(fake.order).toEqual(['engine.resume', 'getSynth while running', 'playNote while running']);
  });

  it('a running mic plays the tone at once', async () => {
    fake.engine.set('running');
    await mount();
    await toAudioCheckStep();
    expect(container.querySelector('[data-testid="tone-mic-note"]')).toBeNull();
    await click(button('Play a test sound'));
    expect(fake.engine.start).not.toHaveBeenCalled();
    expect(fake.synth.playNote).toHaveBeenCalledTimes(1);
  });
});

describe('Setup: in plain words', () => {
  /** The words a singer should never meet here: the old step names, the method's technical name and every unit. */
  const OLD_WORDS = /\blatency\b|\broute\b|\bloopback\b|narrowband|\bjitter\b|\bms\b|\bmatched\b|routing|ducked|ducking/i;

  it('names the five steps in plain words, and no step uses a unit or a technical term', async () => {
    deviceSettings.value = { ...DEFAULT_DEVICE_SETTINGS, route: 'bluetooth' };
    await mount();
    const labels: string[] = [];
    for (let step = 1; step <= 5; step++) {
      labels.push(container.querySelector('.pl-page > .pl-label')!.textContent ?? '');
      const text = container.textContent ?? '';
      expect(jargonIn(text), `step ${step}`).toEqual([]);
      expect(text, `step ${step}`).not.toMatch(OLD_WORDS);
      if (step < 5) await click(button('Next'));
    }
    expect(labels).toEqual(['Step 1 of 5: Headphones', 'Step 2 of 5: Microphone', 'Step 3 of 5: Audio check', 'Step 4 of 5: Timing check', 'Step 5 of 5: Tips']);
  });

  it('says the Bluetooth warning without a number', async () => {
    deviceSettings.value = { ...DEFAULT_DEVICE_SETTINGS, route: 'bluetooth' };
    await mount();
    const banner = container.querySelector('.pl-banner--warn')!.textContent ?? '';
    expect(banner).toContain('add a short delay');
    expect(banner).not.toMatch(/\d/);
  });

  it('says what a bad sound check means, and that Reset audio is the fix', async () => {
    await mount();
    await toAudioCheckStep();
    await click(button('The earpiece (quiet, tinny)'));
    const banner = container.querySelector('.pl-banner--warn')!.textContent ?? '';
    expect(banner).toContain('The sound went to the wrong place or got very quiet');
    expect(banner).toContain('Reset audio');
    expect(banner).not.toMatch(OLD_WORDS);
    await click(button('Headphones/speaker, normal volume'));
    expect(container.querySelector('.pl-banner--info')?.textContent).toBe('Good: the sound is going where it should.');
  });

  it('names the methods by what the singer does, and still runs the loopback one by its stored name', async () => {
    await mount();
    await toLatencyStep();
    const radios = [...container.querySelectorAll<HTMLElement>('[role="radio"]')].map((r) => r.textContent);
    expect(radios).toEqual(['Hold close', 'Sing', 'Tap']);
    expect(container.textContent).toContain('hold the phone’s speaker (or one earbud) right up to the microphone');
    await click(button('Run'));
    expect(startCalibration).toHaveBeenCalledWith('loopback', expect.anything());
  });

  it('counts the clicks in words while it runs, and says the delay it found as a length of time, never in milliseconds', async () => {
    fake.engine.state = 'running';
    fake.calibration.onProgress = (cb) => {
      cb({ clicksPlayed: 3, clicksTotal: 8, eventsDetected: 2 });
      return () => undefined;
    };
    fake.calibration.result = Promise.resolve({ offsetMs: 142, jitterMs: 3, matched: 9, rejected: 0, ok: true });
    await mount();
    await toLatencyStep();
    await click(button('Run'));
    expect(container.querySelector('[data-testid="timing-progress"]')?.textContent).toBe('Click 3 of 8 · heard 2');
    expect(container.querySelector('[data-testid="timing-delay"]')?.textContent).toBe('About a tenth of a second');
    expect(container.textContent).toContain('Heard 9 clicks.');
    expect(container.textContent).toContain('Good');
    expect(container.textContent).not.toMatch(OLD_WORDS);
    expect(container.textContent).not.toMatch(/\d\s*ms/);
  });

  it('still saves the measured delay, in the unit the app keeps it in', async () => {
    fake.engine.state = 'running';
    fake.calibration.result = Promise.resolve({ offsetMs: 142, jitterMs: 3, matched: 9, rejected: 0, ok: true });
    await mount();
    await toLatencyStep();
    await click(button('Run'));
    await click(button('Save'));
    expect(deviceSettings.value.latency.wired?.roundTripMs).toBe(142);
  });

  it('tells a result it cannot trust that it is not reliable yet, and does not offer to save it', async () => {
    fake.engine.state = 'running';
    fake.calibration.result = Promise.resolve({ offsetMs: 400, jitterMs: 90, matched: 2, rejected: 6, ok: false });
    await mount();
    await toLatencyStep();
    await click(button('Run'));
    expect(container.textContent).toContain('Not reliable yet');
    expect(button('Save').disabled).toBe(true);
  });
});
