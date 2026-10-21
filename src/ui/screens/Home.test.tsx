// @vitest-environment happy-dom
/** Smoke render of Home with a mocked engine — no real IndexedDB/getUserMedia needed. */
import { describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import type { AudioEngine, EngineInfo } from '../../audio/engine-types';
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
vi.mock('../../audio/platform', () => ({
  isIOS: () => false,
  isStandalone: () => false,
  isWindows: () => false,
  isLikelyBluetoothLabel: () => false,
}));
vi.mock('../../storage/kv', () => ({ openKV: async () => createFakeKV() }));

// Static imports are fine here: vi.mock() calls above are hoisted above all
// imports by Vitest, so Home.tsx (and the real state/settings.ts it pulls
// in) resolve against the mocks before any module body runs.
import { settingsReady } from '../../state/settings';
import { Home } from './Home';

describe('Home screen (smoke)', () => {
  it('renders the root, the headline and the primary action', async () => {
    await settingsReady;
    const container = document.createElement('div');
    render(<Home />, container);
    // Flush the settingsReady microtask the component awaits before deciding on the first-run sheet.
    await Promise.resolve();
    await Promise.resolve();

    expect(container.querySelector('[data-testid="home-screen"]')).not.toBeNull();
    expect(container.textContent).toContain('Pitch Lab');
    expect(container.textContent).toContain('Start singing');
    expect(container.textContent).toContain('Live pitch');
    expect(container.textContent).toContain('Setup & calibration');
  });
});
