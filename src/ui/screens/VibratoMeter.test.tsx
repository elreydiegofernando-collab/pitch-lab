// @vitest-environment happy-dom
/** The Vibrato meter: free singing against the style's zone, three readouts and the wobble / bleat / straight chips. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';

vi.mock('../../audio/engine', async () => (await import('../practice/test-fakes')).engineModule());
vi.mock('../../state/session', async () => (await import('../practice/test-fakes')).sessionModule());
vi.mock('../../state/settings', async () => (await import('../practice/test-fakes')).settingsModule());
vi.mock('../../state/audio', async () => (await import('../practice/test-fakes')).audioModule());
vi.mock('../pitch-view/PitchViewHost', async () => ({ PitchViewHost: (await import('../practice/test-fakes')).PitchViewHostStub }));

import { makeTrack, withVibrato } from '../../analysis/fixtures';
import { jargonIn } from '../../coaching/plain';
import { installRouteGuard, resetRouterForTests, route, routeOf } from '../../router';
import { engineState } from '../../state/engine-store';
import {
  engineRig,
  hostProbe,
  levelsBefore,
  resetSession,
  resetView,
  session,
  settingsSignal,
  snapshotAfter,
  synthMocks,
  updateSettingsMock,
} from '../practice/test-fakes';
import { VibratoMeter } from './VibratoMeter';

let container: HTMLElement;

async function mount(passed: readonly string[] = levelsBefore('vibrato.01')): Promise<void> {
  resetSession(passed);
  session.snapshot.value = snapshotAfter(passed);
  resetRouterForTests([routeOf('home'), routeOf('vibrato-meter')]);
  installRouteGuard(() => ({ ok: true }));
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(() => {
    render(<VibratoMeter />, container);
  });
}

const q = <T extends Element = HTMLElement>(sel: string): T | null => container.querySelector<T>(sel);
const text = (): string => container.textContent ?? '';
const tick = (ms = 250): Promise<void> =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });
const value = (id: string): string => q(`[data-testid="meter-${id}-value"]`)?.textContent ?? '';
const state = (id: string): string | null => q(`[data-testid="meter-${id}"]`)?.getAttribute('data-state') ?? null;

const vibrato = (rateHz: number, extent: number, seconds = 3) =>
  makeTrack({ duration: seconds, t0: 0, midi: withVibrato(() => 60, rateHz, extent), jitterCents: 2, seed: 5 });

beforeEach(() => {
  vi.useFakeTimers();
  resetView();
  engineRig.mocks.onFrame.mockClear();
  document.documentElement.dataset.reducedMotion = 'off';
});

afterEach(async () => {
  if (container) {
    await act(() => {
      render(null, container);
    });
    container.remove();
  }
  vi.useRealTimers();
  delete document.documentElement.dataset.reducedMotion;
  engineState.value = 'idle';
});

describe('Vibrato meter: before it is earned', () => {
  it('shows what unlocks it, and nothing that listens to the microphone', async () => {
    await mount([]);
    expect(q('[data-testid="vibrato-meter-locked"]')).not.toBeNull();
    expect(q('.pl-locked')!.textContent).toContain('Pass the Foundations Boss Recital to use the vibrato meter.');
    expect(q('[data-testid="sing-button"]')).toBeNull();
    expect(engineRig.listeners).toBe(0);
  });
});

describe('Vibrato meter: the readouts', () => {
  it('shows three readouts, each with the style zone in words', async () => {
    await mount();
    expect(q('[data-testid="vibrato-meter-screen"]')).not.toBeNull();
    expect(text()).toContain('Rate');
    expect(text()).toContain('Extent');
    expect(text()).toContain('Centring');
    expect(q('[data-testid="meter-rate"]')!.textContent).toContain('Pop 5–7 Hz');
    expect(q('[data-testid="meter-extent"]')!.textContent).toContain('Pop ±20–60¢');
    expect(q('[data-testid="meter-centring"]')!.textContent).toContain('Within ±25¢');
    expect(value('rate')).toBe('–');
    expect(state('rate')).toBe('none');
  });

  it('reads a vibrato in the zone: rate, extent, centring, each with an in-zone glyph', async () => {
    await mount();
    engineRig.emit(vibrato(5.8, 40));
    await tick();
    expect(Number.parseFloat(value('rate'))).toBeGreaterThan(5.3);
    expect(Number.parseFloat(value('rate'))).toBeLessThan(6.3);
    expect(value('extent')).toMatch(/^±\d+$/);
    expect(value('centring')).toMatch(/^(0|[+−]\d+)$/); // a centred vibrato reads a plain 0, never −0
    expect(state('rate')).toBe('in');
    expect(state('extent')).toBe('in');
    expect(state('centring')).toBe('in');
    expect(q('[data-testid="meter-rate"] .pl-visually-hidden')?.textContent).toBe('in the zone');
    expect(q('[data-testid="flag-straight"]')).toBeNull();
    expect(q('[data-testid="flag-wobble"]')).toBeNull();
    expect(q('[data-testid="flag-bleat"]')).toBeNull();
  });

  it('says a wide vibrato is above the zone, with a glyph and words', async () => {
    await mount();
    engineRig.emit(vibrato(5.8, 90));
    await tick();
    expect(state('extent')).toBe('above');
    expect(q('[data-testid="meter-extent"] .pl-visually-hidden')?.textContent).toBe('above the zone');
    // The same vibrato is right for a classical voice.
  });

  it('flags a slow, wide wobble in the alert style, with a glyph and words', async () => {
    await mount();
    engineRig.emit(vibrato(3.6, 140));
    await tick();
    const wobble = q('[data-testid="flag-wobble"]')!;
    expect(wobble).not.toBeNull();
    expect(wobble.textContent).toContain('Wobble');
    expect(wobble.querySelector('svg')).not.toBeNull();
    expect(wobble.className).toContain('pl-pchip--alert');
    expect(state('rate')).toBe('below');
  });

  it('flags a fast bleat', async () => {
    await mount();
    engineRig.emit(vibrato(9, 40));
    await tick();
    expect(q('[data-testid="flag-bleat"]')!.textContent).toContain('Bleat');
    expect(state('rate')).toBe('above');
  });

  it('calls a steady tone a straight tone, neutral and informative, never an error', async () => {
    await mount();
    engineRig.emit(makeTrack({ duration: 3, t0: 0, midi: () => 60.3, jitterCents: 2, seed: 5 }));
    await tick();
    const straight = q('[data-testid="flag-straight"]')!;
    expect(straight.textContent).toContain('Straight tone');
    expect(straight.className).toContain('pl-pchip--neutral');
    expect(straight.className).not.toContain('alert');
    expect(value('rate')).toBe('–');
    // How far the steady tone sits from its note still shows.
    expect(value('centring')).toMatch(/^\+\d+$/);
  });

  it('keeps the last reading on screen, dimmed, when the voice stops', async () => {
    await mount();
    engineRig.emit(vibrato(5.8, 40));
    await tick();
    expect(q('.pl-meter__cluster--stale')).toBeNull();
    engineRig.emit(makeTrack({ duration: 4.5, t0: 3, midi: () => NaN }));
    await tick();
    expect(q('.pl-meter__cluster--stale')).not.toBeNull();
    expect(Number.parseFloat(value('rate'))).toBeGreaterThan(5);
  });

  it('shades the style zone on the trace and follows the voice', async () => {
    await mount();
    expect(hostProbe.props!.vibratoZone).toEqual({ minExtentCents: 20, maxExtentCents: 60 });
    expect(hostProbe.props!.options?.autoRange).toBe(true);
  });
});

describe('Vibrato meter: the style', () => {
  it('changes the zone, the words and the band when the style changes', async () => {
    await mount();
    q<HTMLButtonElement>('[data-testid="more-button"]')!.click();
    await act(() => {});
    const classical = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === 'Classical')!;
    classical.click();
    await act(() => {});
    expect(updateSettingsMock).toHaveBeenCalledWith({ vibratoStyle: 'classical' });
    expect(q('[data-testid="meter-extent"]')!.textContent).toContain('Classical ±40–100¢');
    expect(hostProbe.props!.vibratoZone).toEqual({ minExtentCents: 40, maxExtentCents: 100 });
  });

  it('says the styles in plain words in More, with vibrato a word to tap, and no unit', async () => {
    await mount();
    q<HTMLButtonElement>('[data-testid="more-button"]')!.click();
    await act(() => {});
    const words = (): string => document.querySelector('[data-testid="meter-style-words"]')?.textContent ?? '';
    expect(words()).toContain('A light, narrow vibrato');
    expect(words()).toContain('five to seven wobbles a second');
    expect(jargonIn(words())).toEqual([]);
    expect(document.querySelector('[role="dialog"] button[data-term="vibrato"]')?.textContent).toBe('Vibrato');
    const classical = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === 'Classical')!;
    classical.click();
    await act(() => {});
    expect(words()).toContain('A fuller, wider vibrato');
    expect(words()).not.toMatch(/Hz|¢/);
  });

  it('judges the same vibrato against the style: a 30-cent vibrato fits pop but not classical', async () => {
    await mount();
    engineRig.emit(vibrato(5.8, 30));
    await tick();
    expect(state('extent')).toBe('in');
    await act(() => {
      settingsSignal.value = { ...settingsSignal.value, vibratoStyle: 'classical' };
    });
    await tick();
    expect(state('extent')).toBe('below');
  });

  it('falls back to pop for a style that is out of set', async () => {
    await mount();
    await act(() => {
      settingsSignal.value = { ...settingsSignal.value, vibratoStyle: 'jazz' as never };
    });
    expect(q('[data-testid="meter-rate"]')!.textContent).toContain('Pop 5–7 Hz');
  });
});

describe('Vibrato meter: the controls', () => {
  it('starts the microphone straight from the tap, and waits while it starts', async () => {
    await mount();
    engineRig.mocks.start.mockImplementationOnce(() => new Promise(() => {}));
    q<HTMLButtonElement>('[data-testid="sing-button"]')!.click();
    expect(engineRig.mocks.start).toHaveBeenCalledTimes(1);
    await act(() => {});
    expect(q<HTMLButtonElement>('[data-testid="sing-button"]')!.disabled).toBe(true);
  });

  it('stops the microphone straight from the tap once it is running', async () => {
    await mount();
    await act(() => {
      engineState.value = 'running';
    });
    const stop = q<HTMLButtonElement>('[data-testid="sing-button"]')!;
    expect(stop.textContent).toContain('Stop');
    stop.click();
    expect(engineRig.mocks.stop).toHaveBeenCalledTimes(1);
  });

  it('plays a tone with vibrato at the middle of the zone, on the note you last sang', async () => {
    await mount();
    engineRig.emit(makeTrack({ duration: 0.3, t0: 0, midi: () => 64.2 }));
    q<HTMLButtonElement>('[data-testid="listen-button"]')!.click();
    expect(synthMocks.playNote).toHaveBeenCalledTimes(1);
    const spec = (synthMocks.playNote.mock.calls[0] as unknown as [{ midi: number; vibrato: { rateHz: number; extentCents: number } }])[0];
    expect(spec.midi).toBe(64);
    expect(spec.vibrato.rateHz).toBe(6);
    expect(spec.vibrato.extentCents).toBe(40);
  });

  it('goes back from the app bar', async () => {
    await mount();
    q<HTMLButtonElement>('button[aria-label="Back"]')!.click();
    expect(route.value.name).toBe('home');
  });
});
