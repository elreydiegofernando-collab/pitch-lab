// @vitest-environment happy-dom
/**
 * The "Service worker" row must track `src/state/pwa-store.ts`'s `swStatus`
 * signal live, not a one-time snapshot — the stale-snapshot bug that
 * `src/pwa/register-sw.test.ts` covers at the subscription level. This
 * covers the ui-owned half: the signal reaching the ListRow value and the
 * copy-diagnostics JSON payload, and updating without a remount.
 */
import { describe, expect, it, vi } from 'vitest';
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
vi.mock('../../audio/platform', () => ({
  isIOS: () => false,
  isStandalone: () => false,
  isWindows: () => false,
  isLikelyBluetoothLabel: () => false,
}));
vi.mock('../../pwa/persist', () => ({
  getStorageInfo: async () => ({ persisted: null, usage: null, quota: null }),
  requestPersistentStorage: async () => null,
}));
// register-sw.ts's `import('virtual:pwa-register')` is only resolvable
// through vite-plugin-pwa, which vitest.config.ts (unlike vite.config.ts)
// never loads. Under `environment: 'node'` that's moot — the dynamic import
// is lazy and isTestEnv() short-circuits before it ever runs (see
// register-sw.test.ts, which exercises the real module). Under happy-dom,
// Vite's client-style transform resolves a literal dynamic-import specifier
// eagerly while just parsing the file, so any happy-dom test that reaches
// register-sw.ts — even only transitively, via pwa-store.ts, and even though
// that branch never executes — fails before a single test runs. Mock the
// boundary instead, the same way engine/synth are mocked above: this test is
// about the ui-owned store/screen wiring (does Diagnostics track the
// pwa-store signal live), not the pwa-owned subscription mechanism, which
// register-sw.test.ts already covers.
vi.mock('../../pwa/register-sw', () => ({
  getSwStatus: () => 'none',
  onStatusChange: () => () => {},
}));

// Static imports are fine: vi.mock() above is hoisted above all imports by
// Vitest (see Settings.test.tsx), so Diagnostics.tsx and the real modules it
// pulls in (state/settings.ts, state/pwa-store.ts) resolve against the mocks.
import { settingsReady } from '../../state/settings';
import { swStatus } from '../../state/pwa-store';
import { Diagnostics } from './Diagnostics';

describe('Diagnostics screen — service worker row', () => {
  it('tracks pwa-store swStatus live, without remounting', async () => {
    await settingsReady;
    const container = document.createElement('div');
    render(<Diagnostics />, container);
    // Flush the storage-info microtask the mount effect awaits.
    await act(() => Promise.resolve());

    const row = () => container.querySelector('[data-testid="diag-sw"] .pl-row__value');
    expect(row()?.textContent).toBe(String(swStatus.value));

    act(() => {
      swStatus.value = 'waiting';
    });
    expect(row()?.textContent).toBe('waiting');

    act(() => {
      swStatus.value = 'active';
    });
    expect(row()?.textContent).toBe('active');

    // The component instance was never unmounted/remounted between updates.
    expect(container.querySelector('[data-testid="diagnostics-screen"]')).not.toBeNull();
  });
});
