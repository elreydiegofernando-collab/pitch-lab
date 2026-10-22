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

    navigate('map', { worldId: 'foundations' });
    navigate('map', { worldId: 'vibrato' });
    const r = route.value;
    expect(r.name === 'map' ? r.params.worldId : null).toBe('vibrato');

    // Only one 'map' entry sits on top of 'home'.
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

describe('router: deep links with params', () => {
  it('parses every deep-link form and refuses the rest', async () => {
    const { parseDeepLink } = await import('./router');
    expect(parseDeepLink('#/map')).toEqual({ name: 'map', params: {} });
    expect(parseDeepLink('#/map/vibrato')).toEqual({ name: 'map', params: { worldId: 'vibrato' } });
    expect(parseDeepLink('#/level/foundations.03')).toEqual({ name: 'level', params: { levelId: 'foundations.03' } });
    expect(parseDeepLink('#/audition/foundations')).toEqual({ name: 'audition', params: { worldId: 'foundations' } });
    expect(parseDeepLink('#/song/amazing%20grace')).toEqual({ name: 'song', params: { songId: 'amazing grace' } });
    expect(parseDeepLink('#/songs')).toEqual({ name: 'songs', params: {} });
    // A take starts from a tap, and a report needs a take: never deep-linkable.
    expect(parseDeepLink('#/sing')).toBeNull();
    expect(parseDeepLink('#/report')).toBeNull();
    expect(parseDeepLink('#/home')).toBeNull();
    expect(parseDeepLink('#/level')).toBeNull();
    expect(parseDeepLink('#/level/a/b')).toBeNull();
    expect(parseDeepLink('#/live/extra')).toBeNull();
    expect(parseDeepLink('#/song/%E0%A4%A')).toBeNull();
    expect(parseDeepLink('live')).toBeNull();
  });

  it('opens an always-open deep link at once, on top of Home', async () => {
    window.location.hash = '#/map/runs';
    const { back, route } = await import('./router');
    expect(route.value).toEqual({ name: 'map', params: { worldId: 'runs' } });
    expect(back()).toBe(true);
    expect(route.value.name).toBe('home');
  });
});

describe('router: the guard (SPEC §11.1, everything is earned)', () => {
  const OPEN = { ok: true } as const;

  it('refuses gated routes until a guard is installed (fail closed)', async () => {
    const { navigate, refusal, route } = await import('./router');
    expect(navigate('dashboard')).toBe(false);
    expect(route.value.name).toBe('home');
    expect(refusal.value?.hint).toBeTruthy();
    // Utilities stay open with no guard.
    expect(navigate('settings')).toBe(true);
    expect(route.value.name).toBe('settings');
  });

  it('holds a gated deep link until the guard arrives, then opens it when allowed', async () => {
    window.location.hash = '#/level/foundations.02';
    const { installRouteGuard, route } = await import('./router');
    expect(route.value.name).toBe('home');
    installRouteGuard(() => OPEN);
    expect(route.value).toEqual({ name: 'level', params: { levelId: 'foundations.02' } });
  });

  it('redirects a refused deep link to its requirement and publishes the hint', async () => {
    window.location.hash = '#/level/vibrato.03';
    const { installRouteGuard, refusal, route, routeOf } = await import('./router');
    installRouteGuard((r) =>
      r.name === 'level' ? { ok: false, redirect: routeOf('map', { worldId: 'vibrato' }), hint: 'Pass the Foundations Boss Recital to unlock Vibrato.' } : OPEN,
    );
    expect(route.value).toEqual({ name: 'map', params: { worldId: 'vibrato' } });
    expect(refusal.value?.hint).toBe('Pass the Foundations Boss Recital to unlock Vibrato.');
  });

  it('navigate() returns false and opens the redirect when refused', async () => {
    const { installRouteGuard, navigate, route, routeOf } = await import('./router');
    installRouteGuard((r) => (r.name === 'songs' ? { ok: false, redirect: routeOf('home'), hint: 'Pass the Foundations Boss Recital to open Song Stage.' } : OPEN));
    navigate('map');
    expect(navigate('songs')).toBe(false);
    // The redirect (Home) went on top: nothing locked was opened.
    expect(route.value.name).toBe('home');
    expect(navigate('dashboard')).toBe(true);
    expect(route.value.name).toBe('dashboard');
  });

  it('a guard that throws refuses (fail closed)', async () => {
    const { installRouteGuard, navigate, route } = await import('./router');
    installRouteGuard(() => {
      throw new Error('boom');
    });
    expect(navigate('workout')).toBe(false);
    expect(route.value.name).toBe('home');
  });

  it('replace() swaps the top so Back skips it; resetTo() clears the stack', async () => {
    const { back, installRouteGuard, navigate, replace, resetTo, route } = await import('./router');
    installRouteGuard(() => OPEN);
    navigate('level', { levelId: 'foundations.01' });
    navigate('sing', { target: 'level', levelId: 'foundations.01' });
    replace('report');
    expect(route.value.name).toBe('report');
    replace('sing', { target: 'level', levelId: 'foundations.01' });
    expect(route.value.name).toBe('sing');
    expect(back()).toBe(true);
    expect(route.value).toEqual({ name: 'level', params: { levelId: 'foundations.01' } });
    resetTo('map');
    expect(route.value.name).toBe('map');
    expect(back()).toBe(true);
    expect(route.value.name).toBe('home');
    expect(back()).toBe(false);
  });

  it('revalidate() drops screens that closed (a profile switch)', async () => {
    const { installRouteGuard, navigate, revalidate, route } = await import('./router');
    let tenor = true;
    installRouteGuard((r) => (r.name === 'vibrato-meter' && !tenor ? { ok: false, redirect: { name: 'home', params: {} }, hint: 'Locked.' } : OPEN));
    navigate('map');
    navigate('vibrato-meter');
    tenor = false;
    revalidate();
    expect(route.value.name).toBe('map');
  });
});
