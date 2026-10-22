// @vitest-environment happy-dom
/** Live: a new singer sees note, cents, Hz and dB and nothing else; each readout appears only once the skill behind it is earned. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';

vi.mock('../../audio/engine', async () => (await import('../practice/test-fakes')).engineModule());
vi.mock('../../state/session', async () => (await import('../practice/test-fakes')).sessionModule());
vi.mock('../../state/settings', async () => (await import('../practice/test-fakes')).settingsModule());
vi.mock('../../state/audio', async () => (await import('../practice/test-fakes')).audioModule());
vi.mock('../pitch-view/PitchViewHost', async () => ({ PitchViewHost: (await import('../practice/test-fakes')).PitchViewHostStub }));

import { makeTrack, withVibrato } from '../../analysis/fixtures';
import { installRouteGuard, resetRouterForTests, route, routeOf } from '../../router';
import { engineError, engineState } from '../../state/engine-store';
import { DEFAULT_SETTINGS } from '../../state/settings-types';
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
  viewMocks,
} from '../practice/test-fakes';
import { Live } from './Live';

let container: HTMLElement;

async function mount(passed: readonly string[] = []): Promise<void> {
  resetSession(passed);
  session.snapshot.value = snapshotAfter(passed);
  resetRouterForTests([routeOf('home'), routeOf('live')]);
  installRouteGuard(() => ({ ok: true }));
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(() => {
    render(<Live />, container);
  });
}

const q = <T extends Element = HTMLElement>(sel: string): T | null => container.querySelector<T>(sel);
const text = (): string => container.textContent ?? '';
const tick = (ms = 250): Promise<void> =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

const CRACKED = makeTrack({ duration: 2, t0: 5, midi: (t) => (t < 6 ? 60 : 69) });
const VIBRATO = makeTrack({ duration: 3, t0: 0, midi: withVibrato(() => 60, 5.8, 40), jitterCents: 2, seed: 5 });
const SCOOPED = makeTrack({ duration: 2.4, t0: 10, midi: (t) => (t < 10.5 ? NaN : 60 - 0.6 * Math.exp(-(t - 10.5) / 0.08)), jitterCents: 1, seed: 8 });

beforeEach(() => {
  vi.useFakeTimers();
  resetView();
  document.documentElement.dataset.reducedMotion = 'off';
});

afterEach(async () => {
  await act(() => {
    render(null, container);
  });
  container.remove();
  vi.useRealTimers();
  delete document.documentElement.dataset.reducedMotion;
  engineState.value = 'idle';
  engineError.value = null;
});

describe('Live: a singer who has passed nothing', () => {
  it('sees the basics: note, cents, Hz and dB, and the trace', async () => {
    await mount();
    expect(q('[data-testid="live-screen"]')).not.toBeNull();
    expect(q('[data-testid="live-note"]')).not.toBeNull();
    expect(q('[data-testid="live-cents"]')).not.toBeNull();
    expect(q('[data-testid="live-hz"]')).not.toBeNull();
    expect(q('[data-testid="live-db"]')).not.toBeNull();
    expect(q('[data-testid="pitch-view-host"]')).not.toBeNull();
  });

  it('hides every readout that is not unlocked: no chips, no vibrato zone, no markers', async () => {
    await mount();
    expect(q('.pl-live-status')).toBeNull();
    expect(q('[data-testid="live-onset"]')).toBeNull();
    expect(q('[data-testid="live-vibrato"]')).toBeNull();
    expect(hostProbe.props!.vibratoZone ?? null).toBeNull();
    engineRig.emit(CRACKED);
    await tick(1000);
    expect(viewMocks.addMarker).not.toHaveBeenCalled();
    engineRig.emit(SCOOPED);
    await tick(1000);
    expect(viewMocks.addMarker).not.toHaveBeenCalled();
    engineRig.emit(VIBRATO);
    await tick(1000);
    expect(q('.pl-live-status')).toBeNull();
  });

  it('costs nothing extra: only the readouts and the note-picker default listen to frames', async () => {
    await mount();
    expect(engineRig.listeners).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lists the readouts it has not earned, each with what unlocks it, in the More sheet', async () => {
    await mount();
    q<HTMLButtonElement>('[data-testid="live-screen"] button[aria-label="More options"]')!.click();
    await act(() => {});
    const list = document.querySelector('[data-testid="live-readouts"]')!;
    expect(list.querySelectorAll('.pl-locked')).toHaveLength(3);
    expect(list.textContent).toContain('Pass Sirens & glides to see crack markers on the trace.');
    expect(list.textContent).toContain('Pass Crispness to see settle and scoop readouts.');
    expect(list.textContent).toContain('Pass the Foundations Boss Recital to see vibrato readouts.');
    expect(list.querySelectorAll('button')).toHaveLength(0);
  });
});

describe('Live: crack markers after Sirens & glides', () => {
  it('marks a crack on the trace, once, at the time it happened', async () => {
    await mount(levelsBefore('foundations.06'));
    expect(q('.pl-live-status')).toBeNull(); // markers are drawn on the trace; there is no chip for them
    engineRig.emit(CRACKED);
    await tick();
    expect(viewMocks.addMarker).toHaveBeenCalledTimes(1);
    const [t, kind, label] = viewMocks.addMarker.mock.calls[0];
    expect(kind).toBe('crack');
    expect(label).toBe('crack');
    expect(t).toBeGreaterThan(5.9);
    expect(t).toBeLessThan(6.1);
    await tick(1000);
    expect(viewMocks.addMarker).toHaveBeenCalledTimes(1);
  });

  it('shows the crack readout as On in More, and the others still locked', async () => {
    await mount(levelsBefore('foundations.06'));
    q<HTMLButtonElement>('[data-testid="live-screen"] button[aria-label="More options"]')!.click();
    await act(() => {});
    const list = document.querySelector('[data-testid="live-readouts"]')!;
    expect(list.textContent).toContain('Crack markers');
    expect(list.textContent).toContain('On');
    expect(list.querySelectorAll('.pl-locked')).toHaveLength(2);
  });
});

describe('Live: settle and scoop after Crispness', () => {
  it('reads how a note started, once it has landed', async () => {
    await mount(levelsBefore('foundations.07'));
    const chip = (): string => q('[data-testid="live-onset"]')?.textContent ?? '';
    expect(chip()).toContain('Settle –');
    engineRig.emit(SCOOPED.filter((f) => f.t < 11.0));
    await tick();
    expect(chip()).toContain('Settling…');
    engineRig.emit(SCOOPED.filter((f) => f.t >= 11.0));
    await tick();
    expect(chip()).toMatch(/Settle \d+ ms · Scoop \d+¢/);
    expect(viewMocks.addMarker).toHaveBeenCalledWith(expect.closeTo(10.5, 1), 'onset');
    // The vibrato readout is still locked.
    expect(q('[data-testid="live-vibrato"]')).toBeNull();
  });

  it('judges against the note the singer picked, when they picked one', async () => {
    await mount(levelsBefore('foundations.07'));
    q<HTMLButtonElement>('[data-testid="live-screen"] button[aria-label="More options"]')!.click();
    await act(() => {});
    // A4 = 69: the singer is on 60, nine semitones away, so the note never settles in the band.
    const a4 = document.querySelector<HTMLButtonElement>('button[data-midi="69"]')!;
    a4.click();
    await act(() => {});
    engineRig.emit(SCOOPED);
    await tick();
    expect(q('[data-testid="live-onset"]')?.textContent).toContain('Not settled');
  });
});

describe('Live: vibrato after the Foundations Boss Recital', () => {
  it('shows rate, extent and the zone, and shades the zone on the trace', async () => {
    await mount(levelsBefore('vibrato.01'));
    expect(hostProbe.props!.vibratoZone).toEqual({ minExtentCents: 20, maxExtentCents: 60 });
    const chip = (): string => q('[data-testid="live-vibrato"]')?.textContent ?? '';
    expect(chip()).toContain('Vibrato –');
    engineRig.emit(VIBRATO);
    await tick();
    expect(chip()).toMatch(/Vibrato 5\.\d Hz ±\d+¢/);
    expect(chip()).toContain('in the zone');
  });

  it('calls a steady tone a straight tone, which is information, not an error', async () => {
    await mount(levelsBefore('vibrato.01'));
    engineRig.emit(makeTrack({ duration: 3, t0: 0, midi: () => 60, jitterCents: 2, seed: 5 }));
    await tick();
    expect(q('[data-testid="live-vibrato"]')?.textContent).toContain('Straight tone');
  });

  it('follows the vibrato style setting', async () => {
    await mount(levelsBefore('vibrato.01'));
    await act(() => {
      settingsSignal.value = { ...DEFAULT_SETTINGS, vibratoStyle: 'classical' };
    });
    expect(hostProbe.props!.vibratoZone).toEqual({ minExtentCents: 40, maxExtentCents: 100 });
  });

  it('turns every readout on for a singer who has passed everything', async () => {
    await mount(levelsBefore('vibrato.01'));
    expect(q('[data-testid="live-onset"]')).not.toBeNull();
    expect(q('[data-testid="live-vibrato"]')).not.toBeNull();
    expect(engineRig.listeners).toBe(3);
  });
});

describe('Live: the canvas and the controls', () => {
  it('follows the voice (auto range), and reads the OS motion preference unless the setting says otherwise', async () => {
    await mount();
    expect(hostProbe.props!.options?.autoRange).toBe(true);
    expect(hostProbe.props!.options?.reducedMotion).toBeUndefined();
    await act(() => {
      settingsSignal.value = { ...DEFAULT_SETTINGS, reducedMotion: 'on' };
    });
    expect(hostProbe.props!.options?.reducedMotion).toBe(true);
    await act(() => {
      settingsSignal.value = { ...DEFAULT_SETTINGS, reducedMotion: 'off' };
    });
    expect(hostProbe.props!.options?.reducedMotion).toBe(false);
  });

  it('starts the microphone straight from the Sing tap', async () => {
    await mount();
    q<HTMLButtonElement>('[data-testid="sing-button"]')!.click();
    expect(engineRig.mocks.start).toHaveBeenCalledTimes(1);
  });

  it('plays the reference note straight from the Listen tap', async () => {
    await mount();
    q<HTMLButtonElement>('button[aria-label="Listen to the reference tone"]')!.click();
    expect(synthMocks.playNote).toHaveBeenCalledTimes(1);
  });

  it('says what went wrong with the microphone and offers one way to reconnect', async () => {
    await mount();
    await act(() => {
      engineError.value = { code: 'mic-ended', message: 'x' };
      engineState.value = 'interrupted';
    });
    expect(text()).toContain('The microphone stopped');
    const reconnect = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Tap to reconnect')!;
    reconnect.click();
    expect(engineRig.mocks.resume).toHaveBeenCalledTimes(1);
    // One amber button on the screen: the Sing control. The banner's button is a secondary.
    expect(container.querySelectorAll('.pl-btn--primary')).toHaveLength(0);
  });

  it('goes back from the app bar', async () => {
    await mount();
    q<HTMLButtonElement>('button[aria-label="Back"]')!.click();
    expect(route.value.name).toBe('home');
  });
});

describe('Live: the mic when leaving', () => {
  it('turns the mic off again when Live turned it on, so the indicator goes off and playback routes normally', async () => {
    engineRig.mocks.state = 'idle';
    await mount();
    engineRig.mocks.stop.mockClear();
    engineRig.mocks.state = 'running'; // the singer tapped Sing here
    await act(() => {
      render(null, container);
    });
    expect(engineRig.mocks.stop).toHaveBeenCalledTimes(1);
    engineRig.mocks.state = 'idle';
  });

  it('leaves a mic that was already on when Live opened as it was', async () => {
    engineRig.mocks.state = 'running';
    await mount();
    engineRig.mocks.stop.mockClear();
    await act(() => {
      render(null, container);
    });
    expect(engineRig.mocks.stop).not.toHaveBeenCalled();
    engineRig.mocks.state = 'idle';
  });
});
