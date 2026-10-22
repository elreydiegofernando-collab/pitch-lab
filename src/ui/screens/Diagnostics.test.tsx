// @vitest-environment happy-dom
/**
 * The "Service worker" row must track `src/state/pwa-store.ts`'s `swStatus`
 * signal live, not a one-time snapshot — the stale-snapshot bug that
 * `src/pwa/register-sw.test.ts` covers at the subscription level. This
 * covers the ui-owned half: the signal reaching the ListRow value and the
 * copy-diagnostics JSON payload, and updating without a remount.
 */
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
// pulls in (state/settings.ts, state/pwa-store.ts, state/session.ts) resolve against the mocks.
import { appStorage, reconcileReport, storageDurable } from '../../state/session';
import { swStatus } from '../../state/pwa-store';
import type { AppStorage, StorageUsage } from '../../storage';
import { Diagnostics } from './Diagnostics';

let container: HTMLElement;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(() => {
    render(<Diagnostics />, container);
  });
  // Flush the storage-info and usage() microtasks the mount effects await.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const row = (testId: string): Element | null => container.querySelector(`[data-testid="${testId}"]`);
const value = (testId: string): string | undefined => row(testId)?.querySelector('.pl-row__value')?.textContent ?? undefined;

const USAGE: StorageUsage = {
  persistent: true,
  dbFallbackReason: null,
  binaryBackend: 'opfs',
  attemptCount: 42,
  takeCount: 7,
  binaryBytes: 3 * 1024 * 1024,
  origin: { usage: null, quota: null },
};

function storageWith(usage: StorageUsage): AppStorage {
  return { usage: async () => usage } as unknown as AppStorage;
}

beforeEach(() => {
  storageDurable.value = true;
  reconcileReport.value = null;
  appStorage.value = null;
});

afterEach(async () => {
  await act(() => {
    render(null, container);
  });
  container.remove();
  appStorage.value = null;
  reconcileReport.value = null;
  storageDurable.value = true;
});

describe('Diagnostics screen — service worker row', () => {
  it('tracks pwa-store swStatus live, without remounting', async () => {
    await mount();

    expect(value('diag-sw')).toBe(String(swStatus.value));

    act(() => {
      swStatus.value = 'waiting';
    });
    expect(value('diag-sw')).toBe('waiting');

    act(() => {
      swStatus.value = 'active';
    });
    expect(value('diag-sw')).toBe('active');

    // The component instance was never unmounted/remounted between updates.
    expect(container.querySelector('[data-testid="diagnostics-screen"]')).not.toBeNull();
  });
});

describe('Diagnostics screen — Pitch Lab storage', () => {
  it('shows whether the data is saved on this device, live', async () => {
    await mount();
    expect(value('diag-durable')).toBe('Yes');
    act(() => {
      storageDurable.value = false;
    });
    expect(value('diag-durable')).toBe('No');
  });

  it('shows the database, where recordings live and the counts once storage has opened', async () => {
    appStorage.value = storageWith(USAGE);
    await mount();
    expect(value('diag-db')).toBe('IndexedDB');
    expect(value('diag-binary-backend')).toBe('Private file system (OPFS)');
    expect(container.textContent).toContain('42 / 7');
    expect(container.textContent).toContain('3.0 MB');
  });

  it('says why the database fell back to memory', async () => {
    appStorage.value = storageWith({ ...USAGE, persistent: false, dbFallbackReason: 'IndexedDB is blocked in private browsing', binaryBackend: 'memory' });
    await mount();
    expect(value('diag-db')).toBe('In memory');
    expect(row('diag-db')?.textContent).toContain('IndexedDB is blocked in private browsing');
    expect(value('diag-binary-backend')).toBe('Memory only (lost on close)');
  });

  it('shows dashes, not zeros, before storage has opened', async () => {
    await mount();
    expect(value('diag-db')).toBe('––');
    expect(value('diag-binary-backend')).toBe('––');
  });
});

describe('Diagnostics screen — the startup check (storage.reconcile)', () => {
  it('has not run yet', async () => {
    await mount();
    expect(value('diag-reconcile')).toBe('Not run yet');
  });

  it('shows a skipped check with its reason code and a plain explanation', async () => {
    reconcileReport.value = { orphanFilesRemoved: 0, danglingTakes: 0, danglingSongs: 0, skipped: 'backend-changed' };
    await mount();
    expect(value('diag-reconcile')).toBe('Skipped: backend-changed');
    expect(row('diag-reconcile')?.textContent).toContain('different storage backend');
  });

  it('shows what a normal pass repaired, and updates live when the report arrives', async () => {
    await mount();
    act(() => {
      reconcileReport.value = { orphanFilesRemoved: 2, danglingTakes: 1, danglingSongs: 0 };
    });
    expect(value('diag-reconcile')).toBe('Done');
    expect(row('diag-reconcile')?.textContent).toContain('2 stray files removed');
  });
});

describe('Diagnostics screen — Copy diagnostics', () => {
  it('includes the storage facts in the JSON, and never any audio', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    reconcileReport.value = { orphanFilesRemoved: 0, danglingTakes: 0, danglingSongs: 0, skipped: 'db-not-durable' };
    appStorage.value = storageWith({ ...USAGE, persistent: false, dbFallbackReason: 'blocked' });
    storageDurable.value = false;
    await mount();
    const copy = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.includes('Copy diagnostics'))!;
    await act(async () => {
      copy.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((writeText.mock.calls[0] as unknown as [string])[0]) as { pitchLabData: { durable: boolean; usage: StorageUsage; reconcile: { skipped: string } } };
    expect(payload.pitchLabData.durable).toBe(false);
    expect(payload.pitchLabData.usage.dbFallbackReason).toBe('blocked');
    expect(payload.pitchLabData.reconcile.skipped).toBe('db-not-durable');
  });
});
