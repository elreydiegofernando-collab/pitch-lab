// @vitest-environment happy-dom
/** Smoke render of Settings with a mocked engine/synth — no real audio graph or IndexedDB needed. */
import { describe, expect, it, vi } from 'vitest';
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
import { settingsReady } from '../../state/settings';
import { Settings } from './Settings';

describe('Settings screen (smoke)', () => {
  it('renders the root and every settings section', async () => {
    await settingsReady;
    const container = document.createElement('div');
    render(<Settings />, container);

    expect(container.querySelector('[data-testid="settings-screen"]')).not.toBeNull();
    expect(container.textContent).toContain('Vibrato style');
    expect(container.textContent).toContain('Pitch detector');
    expect(container.textContent).toContain('Reference sound');
    expect(container.textContent).toContain('Notation');
    expect(container.textContent).toContain('Theme');
    expect(container.textContent).toContain('Reduced motion');
    expect(container.textContent).toContain('Note names');
  });
});
