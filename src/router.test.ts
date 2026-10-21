// @vitest-environment happy-dom
/**
 * The router must read location.hash exactly once at load and never write
 * location/history afterward (WebKit #215884 — see src/router.ts's doc
 * comment). Each test gets a fresh module instance via resetModules() + a
 * dynamic import, since the deep link is read at module-evaluation time.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  window.location.hash = '';
});

describe('router: deep link read once', () => {
  it('defaults to home when the hash is empty', async () => {
    const { route } = await import('./router');
    expect(route.value.name).toBe('home');
  });

  it('defaults to home for an unrecognized hash', async () => {
    window.location.hash = '#/not-a-real-route';
    const { route } = await import('./router');
    expect(route.value.name).toBe('home');
  });

  it('picks up a recognized deep link', async () => {
    window.location.hash = '#/diagnostics';
    const { route } = await import('./router');
    expect(route.value.name).toBe('diagnostics');
  });
});

describe('router: never writes location or history', () => {
  it('leaves location/history untouched across navigate() and back()', async () => {
    window.location.hash = '#/live';
    const pushStateSpy = vi.spyOn(window.history, 'pushState');
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

    const { back, navigate, route } = await import('./router');
    expect(route.value.name).toBe('live');

    navigate('settings');
    navigate('diagnostics');
    navigate('diagnostics'); // same route again: must replace, not stack a duplicate
    back();
    back();

    expect(pushStateSpy).not.toHaveBeenCalled();
    expect(replaceStateSpy).not.toHaveBeenCalled();
    // If the router had written location.hash, this would no longer read "#/live".
    expect(window.location.hash).toBe('#/live');
  });
});

describe('router: in-memory navigation stack', () => {
  it('navigate() pushes and back() pops', async () => {
    const { back, canGoBack, navigate, route } = await import('./router');
    expect(route.value.name).toBe('home');
    expect(canGoBack.value).toBe(false);

    navigate('live');
    expect(route.value.name).toBe('live');
    expect(canGoBack.value).toBe(true);

    navigate('setup');
    expect(route.value.name).toBe('setup');

    expect(back()).toBe(true);
    expect(route.value.name).toBe('live');

    expect(back()).toBe(true);
    expect(route.value.name).toBe('home');

    // Already at the root: nothing left to pop.
    expect(back()).toBe(false);
    expect(route.value.name).toBe('home');
  });

  it('navigating to the current route replaces it instead of stacking a duplicate', async () => {
    const { back, navigate, route } = await import('./router');

    navigate('settings', { from: 'a' });
    navigate('settings', { from: 'b' });
    expect(route.value.params.from).toBe('b');

    // Only one 'settings' entry sits on top of 'home'.
    expect(back()).toBe(true);
    expect(route.value.name).toBe('home');
  });

  it('bindDesktopBackKey() wires Esc to back() and is idempotent', async () => {
    const { bindDesktopBackKey, navigate, route } = await import('./router');
    navigate('live');
    navigate('setup');
    bindDesktopBackKey();
    bindDesktopBackKey(); // second call must not double-bind the listener

    // One Escape should pop exactly one entry. If bindDesktopBackKey() had bound
    // a second listener, this single dispatch would pop twice and land on 'home'.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(route.value.name).toBe('live');
  });
});
