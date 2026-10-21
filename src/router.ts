/**
 * In-memory router. The URL never changes after boot: on an iOS home-screen
 * app, writing `location.hash` (or anything else that touches history) while
 * the mic is open can re-trigger the permission prompt (WebKit #215884). The
 * initial hash is read exactly once, for deep links and the e2e suite; after
 * that this module never touches `location` or `history` again.
 */
import { computed, signal } from '@preact/signals';

export type RouteName = 'home' | 'live' | 'setup' | 'settings' | 'diagnostics' | 'about';

export interface Route {
  readonly name: RouteName;
  /** Freeform params for the destination screen (e.g. a return hint). Empty object by default. */
  readonly params: Readonly<Record<string, string>>;
}

const DEEP_LINKS: Readonly<Record<string, RouteName>> = {
  '#/live': 'live',
  '#/setup': 'setup',
  '#/settings': 'settings',
  '#/diagnostics': 'diagnostics',
  '#/about': 'about',
};

function routeOf(name: RouteName, params: Readonly<Record<string, string>> = {}): Route {
  return { name, params };
}

/** Read once at module load (= app boot). Never re-read: see the file doc comment. */
function readInitialRoute(): Route {
  if (typeof location === 'undefined') return routeOf('home');
  const name = DEEP_LINKS[location.hash];
  return name ? routeOf(name) : routeOf('home');
}

const stack = signal<readonly Route[]>([readInitialRoute()]);

/** The current route. Read `.value` in components, or use it inside a computed/effect. */
export const route = computed<Route>(() => stack.value[stack.value.length - 1]);

/** True when there is somewhere to go back to (controls showing a back button). */
export const canGoBack = computed<boolean>(() => stack.value.length > 1);

/** Navigate forward, pushing onto the in-memory back stack. */
export function navigate(name: RouteName, params: Readonly<Record<string, string>> = {}): void {
  const next = routeOf(name, params);
  const top = stack.value[stack.value.length - 1];
  if (top.name === next.name) {
    // Replace rather than stack duplicates of the same screen.
    stack.value = [...stack.value.slice(0, -1), next];
    return;
  }
  stack.value = [...stack.value, next];
}

/** Pop one entry. Returns false (and does nothing) when already at the root. */
export function back(): boolean {
  if (stack.value.length <= 1) return false;
  stack.value = stack.value.slice(0, -1);
  return true;
}

/** True when `route` is at the root of the stack (Home in Phase 1). */
export const isRoot = computed<boolean>(() => stack.value.length <= 1);

let escBound = false;

/** Wire `Esc` = back on desktop. Idempotent; called once from app.tsx. */
export function bindDesktopBackKey(): void {
  if (escBound || typeof window === 'undefined') return;
  escBound = true;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') back();
  });
}
