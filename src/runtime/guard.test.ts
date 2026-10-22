/**
 * The route guard (SPEC §11.1) over the real catalog: every route, every refusal and where it redirects, unknown and
 * malformed ids (fail closed), songs before the library loaded, and the guard installed in the router.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { WORLDS, getExercise } from '../exercises';
import { computeSnapshot, withRoutines } from '../progress';
import { BASE_MS, P1, pass, passAudition, passThrough } from '../progress/test-fixtures';
import { ALWAYS_OPEN, installRouteGuard, navigate, refusal, resetRouterForTests, route, routeOf, type Route, type RouteName } from '../router';
import type { AttemptRecord } from '../storage/schema';
import type { WorldId } from '../exercises/types';
import { guardRoute } from './guard';
import type { GuardContext } from './types';

const SONGS: Readonly<Record<string, WorldId>> = { 'twinkle-twinkle': 'foundations', 'ave-maria': 'runs' };

function ctx(attempts: AttemptRecord[] = [], over: Partial<GuardContext> = {}): GuardContext {
  return {
    snapshot: computeSnapshot(P1, WORLDS, attempts, BASE_MS, { getExercise: withRoutines(getExercise) }),
    worlds: WORLDS,
    songRequiredWorld: (id) => SONGS[id],
    songsLoaded: true,
    hasOutcome: false,
    workoutItems: null,
    ...over,
  };
}

/** Through the Range finder: the first level passed (dashboard, workout and records open). */
const firstPass = (): AttemptRecord[] => [pass('foundations.01')];
/** Through the Foundations Boss Recital: Vibrato, Song Stage and song import open. */
const foundationsDone = (): AttemptRecord[] => passThrough(WORLDS, 'foundations.boss');

function refused(verdict: ReturnType<typeof guardRoute>): { redirect: Route; hint: string } {
  if (verdict.ok) throw new Error('expected a refusal');
  return { redirect: verdict.redirect, hint: verdict.hint };
}

describe('guardRoute: utilities are always open', () => {
  it('opens every always-open route for a brand-new singer, and for any map scroll target', () => {
    const fresh = ctx();
    for (const name of ALWAYS_OPEN) expect(guardRoute({ name, params: {} } as Route, fresh), name).toEqual({ ok: true });
    expect(guardRoute(routeOf('map', { worldId: 'dynamics' }), fresh)).toEqual({ ok: true });
  });
});

describe('guardRoute: levels', () => {
  it('opens the current level and passed levels, and refuses the rest with the requirement and the map at that world', () => {
    expect(guardRoute(routeOf('level', { levelId: 'foundations.01' }), ctx())).toEqual({ ok: true });
    expect(refused(guardRoute(routeOf('level', { levelId: 'foundations.02' }), ctx()))).toEqual({
      redirect: routeOf('map', { worldId: 'foundations' }),
      hint: 'Pass Range finder to unlock.',
    });
    expect(refused(guardRoute(routeOf('level', { levelId: 'foundations.03' }), ctx())).hint).toBe('Pass Pitch match to unlock.');
    const after = ctx(firstPass());
    expect(guardRoute(routeOf('level', { levelId: 'foundations.01' }), after)).toEqual({ ok: true });
    expect(guardRoute(routeOf('level', { levelId: 'foundations.02' }), after)).toEqual({ ok: true });
    expect(refused(guardRoute(routeOf('level', { levelId: 'foundations.03' }), after)).hint).toBe('Pass Pitch match to unlock.');
  });

  it('refuses a level of a locked world with the world requirement', () => {
    expect(refused(guardRoute(routeOf('level', { levelId: 'vibrato.01' }), ctx()))).toEqual({
      redirect: routeOf('map', { worldId: 'vibrato' }),
      hint: 'Pass the Foundations Boss Recital to unlock Vibrato.',
    });
    expect(guardRoute(routeOf('level', { levelId: 'vibrato.01' }), ctx(foundationsDone()))).toEqual({ ok: true });
  });

  it('refuses unknown level ids (fail closed)', () => {
    for (const levelId of ['', 'foundations.99', 'imported.pack.01', '__proto__']) {
      expect(refused(guardRoute(routeOf('level', { levelId }), ctx(foundationsDone())))).toEqual({ redirect: routeOf('map'), hint: 'Not available.' });
    }
  });
});

describe('guardRoute: sing', () => {
  it('sings an openable level and refuses a locked one like the level screen does', () => {
    expect(guardRoute(routeOf('sing', { target: 'level', levelId: 'foundations.01' }), ctx())).toEqual({ ok: true });
    expect(refused(guardRoute(routeOf('sing', { target: 'level', levelId: 'foundations.boss' }), ctx()))).toEqual({
      redirect: routeOf('map', { worldId: 'foundations' }),
      hint: 'Pass Legato lines to unlock.',
    });
  });

  it('refuses malformed sing params', () => {
    const bad: Array<Route> = [
      { name: 'sing', params: { target: 'level' } },
      { name: 'sing', params: { target: 'record', levelId: '' } },
      { name: 'sing', params: { target: 'audition' } },
      { name: 'sing', params: { target: 'audition', worldId: 'nowhere' } },
      { name: 'sing', params: { target: 'workout' } },
      { name: 'sing', params: { target: 'workout', itemIndex: 'x' } },
      { name: 'sing', params: { target: 'workout', itemIndex: '-1' } },
      { name: 'sing', params: { target: 'workout', itemIndex: '12345' } },
      { name: 'sing', params: { target: 'bogus' } } as unknown as Route,
    ];
    for (const r of bad) expect(refused(guardRoute(r, ctx(firstPass(), { workoutItems: 6 }))), JSON.stringify(r.params)).toEqual({ redirect: routeOf('map'), hint: 'Not available.' });
  });

  it('records: only on a passed level, once personal records are open', () => {
    const before = refused(guardRoute(routeOf('sing', { target: 'record', levelId: 'foundations.01' }), ctx()));
    expect(before).toEqual({ redirect: routeOf('level', { levelId: 'foundations.01' }), hint: 'Pass Range finder to chase personal records on it.' });
    expect(guardRoute(routeOf('sing', { target: 'record', levelId: 'foundations.01' }), ctx(firstPass()))).toEqual({ ok: true });
    // Not openable at all: back to the map at its world. A boss is named with its world.
    expect(refused(guardRoute(routeOf('sing', { target: 'record', levelId: 'foundations.boss' }), ctx(firstPass())))).toEqual({
      redirect: routeOf('map', { worldId: 'foundations' }),
      hint: 'Pass the Foundations Boss Recital to chase personal records on it.',
    });
    // The current level is openable but not passed: back to its level screen.
    expect(refused(guardRoute(routeOf('sing', { target: 'record', levelId: 'foundations.02' }), ctx(firstPass()))).redirect).toEqual(
      routeOf('level', { levelId: 'foundations.02' }),
    );
    expect(refused(guardRoute(routeOf('sing', { target: 'record', levelId: 'nope.01' }), ctx(firstPass())))).toEqual({ redirect: routeOf('map'), hint: 'Not available.' });
  });

  it('auditions: the Range finder comes first, a shut world says how to open it, a finished audition says so', () => {
    const audition = (worldId: string) => routeOf('sing', { target: 'audition', worldId });
    expect(refused(guardRoute(audition('foundations'), ctx()))).toEqual({
      redirect: routeOf('map', { worldId: 'foundations' }),
      hint: 'Pass Range finder to unlock the audition.',
    });
    expect(guardRoute(audition('foundations'), ctx(firstPass()))).toEqual({ ok: true });
    expect(refused(guardRoute(audition('vibrato'), ctx(firstPass())))).toEqual({
      redirect: routeOf('map', { worldId: 'vibrato' }),
      hint: 'Pass the Foundations Boss Recital to unlock Vibrato.',
    });
    expect(guardRoute(audition('vibrato'), ctx(foundationsDone()))).toEqual({ ok: true });
    // Every level the tests reach is passed: nothing left to sing.
    expect(refused(guardRoute(audition('foundations'), ctx(passThrough(WORLDS, 'foundations.09'))))).toEqual({
      redirect: routeOf('map', { worldId: 'foundations' }),
      hint: 'This audition has nothing left to unlock.',
    });
    // Song Stage has no audition at all.
    expect(refused(guardRoute(audition('song-stage'), ctx(foundationsDone())))).toEqual({ redirect: routeOf('map'), hint: 'Not available.' });
  });

  it('workout items: the feature first, then a running workout with that item', () => {
    const item = (i: string) => routeOf('sing', { target: 'workout', itemIndex: i });
    expect(refused(guardRoute(item('0'), ctx([], { workoutItems: 6 })))).toEqual({
      redirect: routeOf('home'),
      hint: 'Pass your first level to unlock the daily workout.',
    });
    expect(refused(guardRoute(item('0'), ctx(firstPass())))).toEqual({ redirect: routeOf('workout'), hint: 'Start a workout first.' });
    expect(guardRoute(item('0'), ctx(firstPass(), { workoutItems: 6 }))).toEqual({ ok: true });
    expect(guardRoute(item('5'), ctx(firstPass(), { workoutItems: 6 }))).toEqual({ ok: true });
    expect(refused(guardRoute(item('6'), ctx(firstPass(), { workoutItems: 6 }))).redirect).toEqual(routeOf('workout'));
    expect(refused(guardRoute(item('0'), ctx(firstPass(), { workoutItems: 0 }))).redirect).toEqual(routeOf('workout'));
  });
});

describe('guardRoute: report and audition screens', () => {
  it('opens the report only when a take outcome exists', () => {
    expect(refused(guardRoute(routeOf('report'), ctx()))).toEqual({ redirect: routeOf('map'), hint: 'Sing a take first.' });
    expect(guardRoute(routeOf('report'), ctx([], { hasOutcome: true }))).toEqual({ ok: true });
  });

  it('opens an open world audition screen (even before its first test can be sung), never a shut or missing one', () => {
    expect(guardRoute(routeOf('audition', { worldId: 'foundations' }), ctx())).toEqual({ ok: true });
    expect(refused(guardRoute(routeOf('audition', { worldId: 'vibrato' }), ctx()))).toEqual({
      redirect: routeOf('map', { worldId: 'vibrato' }),
      hint: 'Pass the Foundations Boss Recital to unlock Vibrato.',
    });
    expect(guardRoute(routeOf('audition', { worldId: 'vibrato' }), ctx(foundationsDone()))).toEqual({ ok: true });
    for (const worldId of ['song-stage', 'nowhere', '']) {
      expect(refused(guardRoute(routeOf('audition', { worldId }), ctx(foundationsDone()))), worldId).toEqual({ redirect: routeOf('map'), hint: 'Not available.' });
    }
  });

  it('passing an audition test keeps the next one open', () => {
    const afterTest1 = ctx([pass('foundations.01'), passAudition('foundations', 1)]);
    expect(guardRoute(routeOf('sing', { target: 'audition', worldId: 'foundations' }), afterTest1)).toEqual({ ok: true });
    expect(guardRoute(routeOf('level', { levelId: 'foundations.05' }), afterTest1)).toEqual({ ok: true });
  });
});

describe('guardRoute: earned tools and Song Stage', () => {
  it('refuses each earned tool to Home with its requirement until it is earned', () => {
    const cases: Array<[RouteName, string, () => AttemptRecord[]]> = [
      ['vibrato-meter', 'Pass the Foundations Boss Recital to use the vibrato meter.', foundationsDone],
      ['dashboard', 'Pass your first level to see the progress dashboard.', firstPass],
      ['workout', 'Pass your first level to unlock the daily workout.', firstPass],
      ['songs', 'Pass the Foundations Boss Recital to open Song Stage.', foundationsDone],
      ['song-import', 'Pass the Foundations Boss Recital to import your own songs.', foundationsDone],
    ];
    for (const [name, hint, earn] of cases) {
      const r = { name, params: {} } as Route;
      expect(refused(guardRoute(r, ctx())), name).toEqual({ redirect: routeOf('home'), hint });
      expect(guardRoute(r, ctx(earn())), name).toEqual({ ok: true });
    }
  });

  it('a song: Song Stage first, then the library loaded, then a known song whose world is passed', () => {
    const song = (songId: string) => routeOf('song', { songId });
    expect(refused(guardRoute(song('twinkle-twinkle'), ctx()))).toEqual({ redirect: routeOf('home'), hint: 'Pass the Foundations Boss Recital to open Song Stage.' });
    expect(refused(guardRoute(song('twinkle-twinkle'), ctx(foundationsDone(), { songsLoaded: false })))).toEqual({
      redirect: routeOf('songs'),
      hint: 'Loading the song library.',
    });
    expect(refused(guardRoute(song('no-such-song'), ctx(foundationsDone())))).toEqual({ redirect: routeOf('songs'), hint: 'Song not found.' });
    expect(guardRoute(song('twinkle-twinkle'), ctx(foundationsDone()))).toEqual({ ok: true });
    expect(refused(guardRoute(song('ave-maria'), ctx(foundationsDone())))).toEqual({
      redirect: routeOf('songs'),
      hint: 'Pass the Runs & Riffs Boss Recital to unlock this song.',
    });
  });

  it('refuses a route it does not know', () => {
    expect(refused(guardRoute({ name: 'admin', params: {} } as unknown as Route, ctx(foundationsDone())))).toEqual({ redirect: routeOf('home'), hint: 'Not available.' });
  });
});

describe('the guard in the router', () => {
  beforeEach(() => resetRouterForTests());

  it('redirects a locked navigation to its requirement and publishes the line', () => {
    const c = ctx(firstPass());
    installRouteGuard((r) => guardRoute(r, c));
    expect(navigate('level', { levelId: 'foundations.02' })).toBe(true);
    expect(route.value).toEqual(routeOf('level', { levelId: 'foundations.02' }));
    expect(navigate('level', { levelId: 'foundations.04' })).toBe(false);
    expect(route.value).toEqual(routeOf('map', { worldId: 'foundations' }));
    expect(refusal.value?.hint).toBe('Pass Sustain I to unlock.');
  });

  it('judges a waiting deep link once the guard arrives', () => {
    resetRouterForTests([routeOf('home')], routeOf('song', { songId: 'ave-maria' }));
    const c = ctx(foundationsDone());
    installRouteGuard((r) => guardRoute(r, c));
    expect(route.value).toEqual(routeOf('songs'));
    expect(refusal.value?.hint).toBe('Pass the Runs & Riffs Boss Recital to unlock this song.');
  });
});
