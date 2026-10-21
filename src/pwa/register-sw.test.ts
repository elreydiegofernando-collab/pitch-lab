/**
 * Regression coverage for the stale-snapshot bug: getSwStatus() alone gave
 * Diagnostics a one-time read with no way to notice a later lifecycle
 * transition (e.g. 'installing' finishing, or a new deploy flipping
 * 'active' -> 'waiting' while the screen is mounted). onStatusChange() must
 * push every transition to subscribers, mirroring AudioEngine.onState.
 *
 * Each test re-imports the module after vi.resetModules() so the
 * module-level `status`/`statusListeners` singleton starts fresh — this file
 * never calls the real 'virtual:pwa-register' (unreachable under Vitest; see
 * isTestEnv()), so every registerServiceWorker() call here takes the
 * synchronous 'unsupported' path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SwStatus } from './register-sw';

async function load() {
  return await import('./register-sw');
}

describe('register-sw status subscriptions', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('starts at "none" before any registration', async () => {
    const { getSwStatus } = await load();
    expect(getSwStatus()).toBe('none');
  });

  it('notifies a subscriber when registerServiceWorker changes the status', async () => {
    const { registerServiceWorker, onStatusChange, getSwStatus } = await load();
    const seen: SwStatus[] = [];
    onStatusChange((s) => seen.push(s));

    registerServiceWorker({ onNeedRefresh: () => {} });

    expect(seen).toEqual(['unsupported']);
    expect(getSwStatus()).toBe('unsupported');
  });

  it('does not replay the current value on subscribe, only future changes', async () => {
    const { registerServiceWorker, onStatusChange } = await load();
    const seen: SwStatus[] = [];
    onStatusChange((s) => seen.push(s));
    expect(seen).toEqual([]);

    registerServiceWorker({ onNeedRefresh: () => {} });
    expect(seen).toEqual(['unsupported']);
  });

  it('stops notifying once unsubscribed', async () => {
    const { registerServiceWorker, onStatusChange } = await load();
    const seen: SwStatus[] = [];
    const unsubscribe = onStatusChange((s) => seen.push(s));
    unsubscribe();

    registerServiceWorker({ onNeedRefresh: () => {} });
    expect(seen).toEqual([]);
  });

  it('does not re-notify when a later transition lands on the same value', async () => {
    const { registerServiceWorker, onStatusChange } = await load();
    registerServiceWorker({ onNeedRefresh: () => {} }); // none -> unsupported, before any subscriber

    const seen: SwStatus[] = [];
    onStatusChange((s) => seen.push(s));
    registerServiceWorker({ onNeedRefresh: () => {} }); // unsupported -> unsupported: no change, no call

    expect(seen).toEqual([]);
  });

  it('supports multiple independent subscribers', async () => {
    const { registerServiceWorker, onStatusChange } = await load();
    const a: SwStatus[] = [];
    const b: SwStatus[] = [];
    onStatusChange((s) => a.push(s));
    const unsubscribeB = onStatusChange((s) => b.push(s));
    unsubscribeB();

    registerServiceWorker({ onNeedRefresh: () => {} });

    expect(a).toEqual(['unsupported']);
    expect(b).toEqual([]);
  });
});
