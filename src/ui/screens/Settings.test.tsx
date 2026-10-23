// @vitest-environment happy-dom
/** Settings with a mocked engine/synth — no real audio graph or IndexedDB needed — and the real unlock registry. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'preact/test-utils';
import { render } from 'preact';
import type { AudioEngine, EngineInfo } from '../../audio/engine-types';
import type { ReferenceSynth } from '../../audio/synth-types';
import type { KVStore } from '../../storage/kv-types';

function createFakeEngine(): AudioEngine {
  return {
    state: 'idle',
    error: null,
    context: null,
    output: null,
    ensureContext: vi.fn(() => new AudioContext()),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),
    onFrame: vi.fn(() => () => {}),
    onState: vi.fn(() => () => {}),
    onStats: vi.fn(() => () => {}),
    onTransient: vi.fn(() => () => {}),
    info: vi.fn((): EngineInfo => ({
      state: 'idle',
      sampleRate: null,
      baseLatency: null,
      outputLatency: null,
      windowSize: 2048,
      hopSize: null,
      detector: 'mpm',
      detectorCostMs: null,
      trackSettings: null,
      audioSessionType: null,
      inputDeviceLabel: null,
      isIOS: false,
      isStandalone: false,
      userAgent: 'test',
    })),
    listInputs: vi.fn(async () => []),
    setPreferredInput: vi.fn(),
    setDetector: vi.fn(),
    setGating: vi.fn(),
    setTransientDetection: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(async () => ({ samples: new Float32Array(), sampleRate: 48000, startTime: 0 })),
  };
}

function createFakeSynth(): ReferenceSynth {
  const handle = { startAt: 0, endAt: 0, stop: vi.fn() };
  return {
    setVolume: vi.fn(),
    playNote: vi.fn(() => handle),
    playGlide: vi.fn(() => handle),
    playSequence: vi.fn(() => handle),
    click: vi.fn(),
    startMetronome: vi.fn(() => ({ ...handle, bpm: 120, beat0: 0, setBpm: vi.fn() })),
    stopAll: vi.fn(),
  };
}

function createFakeKV(): KVStore {
  return {
    persistent: true,
    get: async () => undefined,
    set: async () => {},
    delete: async () => {},
    keys: async () => [],
  };
}

vi.mock('../../audio/engine', () => ({ getEngine: () => createFakeEngine() }));
vi.mock('../../audio/synth', () => ({ createSynth: () => createFakeSynth() }));
vi.mock('../../storage/kv', () => ({ openKV: async () => createFakeKV() }));

// Static imports are fine: vi.mock() above is hoisted above all imports by
// Vitest, so Settings.tsx and the real modules it pulls in (state/audio.ts,
// state/engine-store.ts, state/settings.ts) resolve against the mocks.
import { jargonIn } from '../../coaching/plain';
import { resetRouterForTests, route, routeOf } from '../../router';
import { activeProfile, snapshot } from '../../state/session';
import { settings } from '../../state/settings';
import { DEFAULT_SETTINGS } from '../../state/settings-types';
import { passWorld, profileRecord, snapshotOf } from '../progress/test-fixtures';
import { Settings } from './Settings';

let container: HTMLElement;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(() => {
    render(<Settings />, container);
  });
}

const text = (): string => container.textContent ?? '';
const vibratoStyleControl = (): Element | null => container.querySelector('[role="radiogroup"][aria-label="Vibrato style"]');
const toggle = (label: string): HTMLButtonElement => container.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)!;

beforeEach(() => {
  settings.value = { ...DEFAULT_SETTINGS };
  snapshot.value = snapshotOf([]);
  activeProfile.value = profileRecord({ id: 'p1', name: 'Daniel' });
  resetRouterForTests([routeOf('home'), routeOf('settings')]);
});

afterEach(async () => {
  await act(() => {
    render(null, container);
  });
  container.remove();
  snapshot.value = snapshotOf([]);
  activeProfile.value = null;
});

describe('Settings screen (smoke)', () => {
  it('renders the root and every settings section', async () => {
    await mount();

    expect(container.querySelector('[data-testid="settings-screen"]')).not.toBeNull();
    expect(text()).toContain('Vibrato style');
    expect(text()).toContain('Pitch detector');
    expect(text()).toContain('Listen sound');
    expect(text()).toContain('Sharps or flats');
    expect(text()).toContain('Theme');
    expect(text()).toContain('Reduced motion');
    expect(text()).toContain('Note names');
    expect(text()).toContain('Keep take audio');
  });
});

describe('Settings: in plain words', () => {
  it('uses no unit, no algorithm name and no jargon, for a singer who has earned every setting', async () => {
    snapshot.value = snapshotOf(passWorld('foundations'));
    await mount();
    const all = text();
    expect(jargonIn(all)).toEqual([]);
    expect(all).not.toMatch(/\bMPM\b|\bYIN\b|\bSine\b|timbre|Notation|tolerance/i);
    expect(all).not.toMatch(/\d\s*(?:Hz|¢|dB|ms)\b/);
  });

  it('names the detector choices Standard and Alternative, and still saves the detector it always saved', async () => {
    await mount();
    const choice = (label: string): HTMLButtonElement =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="Pitch detector"] [role="radio"]')).find((b) => b.textContent === label)!;
    expect(choice('Standard').getAttribute('aria-checked')).toBe('true');
    await act(() => {
      choice('Alternative').click();
    });
    expect(settings.value.detector).toBe('yin');
    await act(() => {
      choice('Standard').click();
    });
    expect(settings.value.detector).toBe('mpm');
    expect(text()).toContain('How the app works out which note you are singing');
  });

  it('calls the pure tone Pure, and says what the listen sound is for', async () => {
    await mount();
    const pure = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="Listen sound"] [role="radio"]')).find((b) => b.textContent === 'Pure')!;
    await act(() => {
      pure.click();
    });
    expect(settings.value.referenceTimbre).toBe('sine');
    expect(text()).toContain('The sound the app plays when you tap Listen.');
  });

  it('explains sharps and flats in a line, and offers the words to tap: vibrato, pitch, sharp and flat', async () => {
    await mount();
    expect(text()).toContain('C♯ and D♭ are the same note');
    for (const id of ['vibrato', 'pitch', 'sharp', 'flat']) expect(container.querySelector(`button[data-term="${id}"]`), id).not.toBeNull();
    await act(() => {
      container.querySelector<HTMLButtonElement>('button[data-term="sharp"]')!.click();
    });
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Sharp');
    await act(() => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click();
    });
  });
});

describe('Settings: the vibrato style is earned', () => {
  it('is hidden until the Vibrato world is unlocked: a locked line with its requirement, and no control', async () => {
    await mount();
    expect(vibratoStyleControl()).toBeNull();
    expect(text()).toContain('Pass the Foundations Boss Recital to choose a vibrato style.');
    expect(container.querySelector('.pl-locked')).not.toBeNull();
    // Nothing about the zones it would set leaks out either.
    expect(text()).not.toContain('Pop / R&B');
    expect(text()).not.toContain('Classical');
  });

  it('appears, working, once the Foundations Boss Recital has been passed', async () => {
    snapshot.value = snapshotOf(passWorld('foundations'));
    await mount();
    expect(vibratoStyleControl()).not.toBeNull();
    expect(container.querySelector('.pl-locked')).toBeNull();
    expect(container.querySelector('[data-testid="vibrato-words"]')!.textContent).toContain('A light, narrow vibrato');
    expect(text()).toContain('five to seven wobbles a second');
    const classical = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find((b) => b.textContent === 'Classical')!;
    await act(() => {
      classical.click();
    });
    expect(settings.value.vibratoStyle).toBe('classical');
    expect(container.querySelector('[data-testid="vibrato-words"]')!.textContent).toContain('A fuller, wider vibrato');
  });

  it('stays hidden after only part of Foundations', async () => {
    snapshot.value = snapshotOf(passWorld('foundations', 'foundations.09'));
    await mount();
    expect(vibratoStyleControl()).toBeNull();
  });
});

describe('Settings: take audio and its privacy line', () => {
  it('has a Keep take audio toggle, on by default, that changes the setting', async () => {
    await mount();
    expect(toggle('Keep take audio').getAttribute('aria-checked')).toBe('true');
    await act(() => {
      toggle('Keep take audio').click();
    });
    expect(settings.value.keepTakeAudio).toBe(false);
    expect(toggle('Keep take audio').getAttribute('aria-checked')).toBe('false');
  });

  it('says plainly that audio never leaves the device except by an export', async () => {
    await mount();
    const privacy = container.querySelector('[data-testid="audio-privacy"]')!.textContent ?? '';
    expect(privacy).toContain('never leaves this device');
    expect(privacy).toContain('Export WAV');
    // The coaching file can carry audio too, when the singer turns Include audio on (review R3).
    expect(privacy).toContain('Send to Claude with Include audio');
  });
});

describe('Settings: doors to Profiles and Data & backup', () => {
  it('opens Profiles, showing who is singing', async () => {
    await mount();
    const row = Array.from(container.querySelectorAll<HTMLButtonElement>('button.pl-row')).find((b) => b.textContent?.includes('Profiles'))!;
    expect(row.textContent).toContain('Daniel');
    await act(() => {
      row.click();
    });
    expect(route.value.name).toBe('profiles');
  });

  it('opens Data & backup', async () => {
    await mount();
    const row = Array.from(container.querySelectorAll<HTMLButtonElement>('button.pl-row')).find((b) => b.textContent?.includes('Data & backup'))!;
    await act(() => {
      row.click();
    });
    expect(route.value.name).toBe('data');
  });
});
