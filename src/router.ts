/**
 * In-memory router. The URL never changes after boot: on an iOS home-screen
 * app, writing `location.hash` (or anything else that touches history) while
 * the mic is open can re-trigger the permission prompt (WebKit #215884). The
 * initial hash is read exactly once, for deep links and the e2e suite; after
 * that this module never touches `location` or `history` again.
 *
 * Everything is earned (SPEC §11.1): a locked item cannot be opened, deep links
 * included. Every navigation passes the route guard that the session installs
 * once progress is known (src/runtime/guard.ts). Until then only the
 * always-open utility routes resolve; an initial deep link to anything else
 * waits and is judged when the guard arrives. A refused navigation goes to the
 * guard's redirect (the item's requirement) and publishes the requirement line
 * in `refusal` for the app to show.
 *
 * Contract file (orchestrator-owned): builders report needed changes.
 */
import { computed, signal } from '@preact/signals';

export type RouteName =
  // Utilities: always open (SPEC §11.1)
  | 'home'
  | 'live'
  | 'setup'
  | 'settings'
  | 'diagnostics'
  | 'about'
  | 'profiles'
  | 'data'
  // Progression
  | 'map'
  | 'level'
  | 'sing'
  | 'report'
  | 'audition'
  // Earned tools and features
  | 'vibrato-meter'
  | 'dashboard'
  | 'workout'
  // Song Stage
  | 'songs'
  | 'song-import'
  | 'song';

/** What a take is sung for (src/runtime/types.ts RunTarget, flattened to strings for the route). */
export type SingTargetKind = 'level' | 'record' | 'audition' | 'workout';

/** The params each route reads. Values are strings; the router never parses them. */
export interface RouteParams {
  home: Record<string, never>;
  live: Record<string, never>;
  setup: Record<string, never>;
  settings: Record<string, never>;
  diagnostics: Record<string, never>;
  about: Record<string, never>;
  profiles: Record<string, never>;
  data: Record<string, never>;
  /** worldId: scroll the setlist to that world (default: the current level). */
  map: { worldId?: string };
  level: { levelId: string };
  /**
   * level/record: levelId. audition: worldId (the runner sings that world's NEXT test).
   * workout: itemIndex (into the active workout's items, as a decimal string).
   */
  sing: { target: SingTargetKind; levelId?: string; worldId?: string; itemIndex?: string };
  /** Shows the runner's last outcome (src/runtime/runner.ts lastOutcome). */
  report: Record<string, never>;
  audition: { worldId: string };
  'vibrato-meter': Record<string, never>;
  dashboard: Record<string, never>;
  workout: Record<string, never>;
  songs: Record<string, never>;
  'song-import': Record<string, never>;
  /** songId: Song.id (bundled slug or imported content id). */
  song: { songId: string };
}

/** A route: its name and that route's params. `route.value.name === 'level'` narrows `params` to `{ levelId }`. */
export type Route = { [N in RouteName]: { readonly name: N; readonly params: Readonly<RouteParams[N]> } }[RouteName];

/** The params argument of navigate/replace: optional when every param of the route is optional. */
type ParamsArg<N extends RouteName> = Record<string, never> extends RouteParams[N] ? [params?: RouteParams[N]] : [params: RouteParams[N]];

export function routeOf<N extends RouteName>(name: N, ...args: ParamsArg<N>): Route {
  return { name, params: (args[0] ?? {}) as RouteParams[N] } as Route;
}

/** Utilities and the map: open before progress is known and for every profile (SPEC §11.1). */
export const ALWAYS_OPEN: ReadonlySet<RouteName> = new Set<RouteName>([
  'home',
  'live',
  'setup',
  'settings',
  'diagnostics',
  'about',
  'profiles',
  'data',
  'map',
]);

export type GuardVerdict = { ok: true } | { ok: false; redirect: Route; hint: string };
export type RouteGuard = (route: Route) => GuardVerdict;

/** The requirement line of the last refused navigation (the app shows it as a toast). `at` makes repeats distinct. */
export const refusal = signal<{ hint: string; at: number } | null>(null);

// ---------------------------------------------------------------- deep links (read once)

/** Routes reachable by a bare `#/<name>` deep link. `sing` and `report` are never deep-linkable: a take starts from a tap. */
const BARE_LINKS: ReadonlySet<RouteName> = new Set<RouteName>([
  'live',
  'setup',
  'settings',
  'diagnostics',
  'about',
  'profiles',
  'data',
  'map',
  'vibrato-meter',
  'dashboard',
  'workout',
  'songs',
  'song-import',
]);

function decodePart(part: string | undefined): string | null {
  if (part === undefined || part === '') return null;
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

/**
 * `#/live`, `#/map`, `#/map/<worldId>`, `#/level/<levelId>`, `#/audition/<worldId>`, `#/song/<songId>`, ...
 * Null for an empty or unknown hash (the app then opens at Home). Exported for tests.
 */
export function parseDeepLink(hash: string): Route | null {
  if (!hash.startsWith('#/')) return null;
  const parts = hash.slice(2).split('/');
  const name = parts[0];
  const arg = decodePart(parts[1]);
  if (parts.length > 2) return null;
  switch (name) {
    case 'map':
      return arg === null ? routeOf('map') : routeOf('map', { worldId: arg });
    case 'level':
      return arg === null ? null : routeOf('level', { levelId: arg });
    case 'audition':
      return arg === null ? null : routeOf('audition', { worldId: arg });
    case 'song':
      return arg === null ? null : routeOf('song', { songId: arg });
    default:
      if (arg !== null || !BARE_LINKS.has(name as RouteName)) return null;
      return { name: name as RouteName, params: {} } as Route;
  }
}

/** Read once at module load (= app boot). Never re-read: see the file doc comment. */
function readInitialLink(): Route | null {
  if (typeof location === 'undefined') return null;
  return parseDeepLink(location.hash);
}

const HOME: Route = routeOf('home');
const initialLink = readInitialLink();

/** The stack starts at Home; an always-open deep link goes on top at once, anything else waits for the guard. */
const stack = signal<readonly Route[]>(initialLink && ALWAYS_OPEN.has(initialLink.name) ? [HOME, initialLink] : [HOME]);
let pendingLink: Route | null = initialLink && !ALWAYS_OPEN.has(initialLink.name) ? initialLink : null;

let guard: RouteGuard | null = null;

/** The current route. Read `.value` in components, or use it inside a computed/effect. */
export const route = computed<Route>(() => stack.value[stack.value.length - 1]);

/** True when there is somewhere to go back to (controls showing a back button). */
export const canGoBack = computed<boolean>(() => stack.value.length > 1);

/** True when `route` is at the root of the stack (Home). */
export const isRoot = computed<boolean>(() => stack.value.length <= 1);

function sameRoute(a: Route, b: Route): boolean {
  if (a.name !== b.name) return false;
  const pa = a.params as Readonly<Record<string, string | undefined>>;
  const pb = b.params as Readonly<Record<string, string | undefined>>;
  const keys = new Set([...Object.keys(pa), ...Object.keys(pb)]);
  for (const k of keys) if (pa[k] !== pb[k]) return false;
  return true;
}

/** Judge a route: always-open routes pass; anything else needs the guard (none yet = refused, fail closed). */
function judge(next: Route): GuardVerdict {
  if (ALWAYS_OPEN.has(next.name)) return { ok: true };
  if (!guard) return { ok: false, redirect: HOME, hint: 'Still loading your progress.' };
  try {
    return guard(next);
  } catch {
    return { ok: false, redirect: HOME, hint: 'Not available.' };
  }
}

function refuse(hint: string): void {
  refusal.value = { hint, at: Date.now() };
}

/** Push `next` (replacing the top when it is the same screen), or its redirect when refused. */
function push(next: Route, mode: 'push' | 'replace'): boolean {
  const verdict = judge(next);
  const target = verdict.ok ? next : verdict.redirect;
  if (!verdict.ok) refuse(verdict.hint);
  const current = stack.value;
  const top = current[current.length - 1];
  if (sameRoute(top, target)) return verdict.ok;
  if (mode === 'replace' || top.name === target.name) {
    // Replace rather than stack duplicates of the same screen.
    stack.value = [...current.slice(0, -1), target];
  } else {
    stack.value = [...current, target];
  }
  return verdict.ok;
}

/** Navigate forward through the guard. Returns false when refused (the guard's redirect was opened instead). */
export function navigate<N extends RouteName>(name: N, ...params: ParamsArg<N>): boolean {
  return push(routeOf(name, ...params), 'push');
}

/** Replace the current screen through the guard (Sing -> Report -> Retry, so Back returns to the level). */
export function replace<N extends RouteName>(name: N, ...params: ParamsArg<N>): boolean {
  return push(routeOf(name, ...params), 'replace');
}

/** Clear the stack to a single route (after a profile switch, a backup import or Delete all data). */
export function resetTo<N extends RouteName>(name: N, ...params: ParamsArg<N>): void {
  const next = routeOf(name, ...params);
  const verdict = judge(next);
  if (!verdict.ok) refuse(verdict.hint);
  const target = verdict.ok ? next : verdict.redirect;
  stack.value = target.name === 'home' ? [HOME] : [HOME, target];
}

/** Pop one entry. Returns false (and does nothing) when already at the root. */
export function back(): boolean {
  if (stack.value.length <= 1) return false;
  stack.value = stack.value.slice(0, -1);
  return true;
}

/**
 * Re-judge the whole stack (progress changed in a way that can close things: a profile switch, a backup import,
 * Delete all data). Entries that no longer pass are dropped; Home always stays.
 */
export function revalidate(): void {
  const kept = stack.value.filter((r, i) => i === 0 || judge(r).ok);
  if (kept.length !== stack.value.length) stack.value = kept.length > 0 ? kept : [HOME];
}

/**
 * Install the guard (once the session knows the active profile's progress), re-judge the stack, then open a
 * waiting deep link: allowed, it goes on top; refused, its redirect does and the requirement is published.
 * Calling it again replaces the guard (tests).
 */
export function installRouteGuard(next: RouteGuard): void {
  guard = next;
  revalidate();
  const link = pendingLink;
  pendingLink = null;
  if (link) push(link, 'push');
}

/** Test helper: back to a fresh router with no guard and the given stack. */
export function resetRouterForTests(initial: readonly Route[] = [HOME], waitingLink: Route | null = null): void {
  guard = null;
  pendingLink = waitingLink;
  stack.value = initial.length > 0 ? initial : [HOME];
  refusal.value = null;
}

let escBound = false;

/** Wire `Esc` = back on desktop. Idempotent; called once from app.tsx. */
export function bindDesktopBackKey(): void {
  if (escBound || typeof window === 'undefined') return;
  escBound = true;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') back();
  });
}
