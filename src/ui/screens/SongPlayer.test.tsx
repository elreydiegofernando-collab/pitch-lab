// @vitest-environment happy-dom
/**
 * The song player on a real song index (the bundled-library loader mocked): the lyric line and the phrase scrubber,
 * the calibration banner with Calibrate as the one primary action until the route has a latency calibration, and a
 * locked song never opened (fail closed even when reached). The canvas host is stubbed: happy-dom has no 2D context.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { parseUltraStar } from '../../song/ultrastar';
import type { LatencyCalibration } from '../../audio/latency-types';

vi.mock('../pitch-view/PitchViewHost', () => ({ PitchViewHost: () => null }));
vi.mock('../../audio/engine', () => ({
  getEngine: () => ({
    state: 'idle',
    error: null,
    context: null,
    output: null,
    onFrame: () => () => undefined,
    onState: () => () => undefined,
    // A mic that never comes up: a take started here ends in the mic error, which is all these tests need.
    start: async () => undefined,
    stop: async () => undefined,
  }),
}));
vi.mock('../../state/engine-store', async () => {
  const { signal } = await import('@preact/signals');
  return { engineState: signal('idle') };
});
vi.mock('../../state/audio', () => ({ getSynth: () => undefined, resetAudio: async () => undefined }));
vi.mock('../../song/library', () => ({ getBundledLibrary: vi.fn() }));
vi.mock('../../state/session', async () => {
  const { signal } = await import('@preact/signals');
  const { computeSnapshot, isFeatureUnlocked } = await import('../../progress');
  const { WORLDS, levelsOf } = await import('../../exercises');
  const at = (i: number): string => new Date(Date.parse('2026-10-22T10:00:00Z') + i * 60_000).toISOString();
  const passed = [...levelsOf('foundations')]
    .sort((a, b) => a.index - b.index)
    .map((level, i) => ({
      id: `a${i}`,
      profileId: 'p1',
      createdAt: at(i),
      updatedAt: at(i),
      deletedAt: null,
      exerciseId: level.exerciseId,
      levelId: level.id,
      kind: level.kind === 'boss' ? ('boss' as const) : ('practice' as const),
      score: 0.9,
      passed: true,
      mastery: 1 as const,
      metrics: {},
      durationSec: 30,
      tonicMidi: null,
      tempoBpm: null,
      takeId: null,
    }));
  const snapshot = signal(computeSnapshot('p1', WORLDS, passed, Date.parse('2026-10-22T12:00:00Z')));
  return {
    snapshot,
    attemptLog: signal(passed),
    isUnlocked: (id: never) => isFeatureUnlocked(id, snapshot.value),
    appStorage: signal(null),
    activeProfile: signal({
      id: 'p1',
      profileId: 'p1',
      createdAt: at(0),
      updatedAt: '0',
      deletedAt: null,
      name: 'Daniel',
      voiceType: 'tenor',
      range: { comfortable: { low: 52, high: 69 }, extended: { low: 45, high: 72 }, measuredAt: at(0) },
    }),
    recordAttempt: async () => undefined,
  };
});
vi.mock('../../state/settings', async () => {
  const { signal } = await import('@preact/signals');
  const types = await import('../../state/settings-types');
  return {
    settings: signal(types.DEFAULT_SETTINGS),
    deviceSettings: signal({ ...types.DEFAULT_DEVICE_SETTINGS, route: 'wired' }),
  };
});

import { installRouteGuard, resetRouterForTests, route, routeOf } from '../../router';
import { getBundledLibrary } from '../../song/library';
import type { AttemptRecord } from '../../storage/schema';
import { activeProfile, attemptLog } from '../../state/session';
import { deviceSettings } from '../../state/settings';
import { loadSongs } from '../../state/songs';
import { SongPlayer, rememberedKey } from './SongPlayer';

const TWINKLE = `#TITLE:Twinkle Twinkle
#ARTIST:Traditional
#BPM:100
#GAP:0
: 0 4 0  Twin
: 4 4 0 kle,
: 8 4 7  twin
: 12 4 7 kle,
: 16 4 9  lit
: 20 4 9 tle
: 24 8 7  star
- 34
: 36 4 5  How
: 40 4 5  I
: 44 4 4  won
: 48 4 4 der
: 52 8 2  what
E
`;
/** Eight notes a second up a scale: needs the Runs & Riffs Boss Recital. */
const RUN = `#TITLE:Quick Scale
#ARTIST:Me
#BPM:240
#GAP:0
: 0 2 0  la
: 2 2 2  la
: 4 2 4  la
: 6 2 5  la
: 8 2 7  la
: 10 2 9  la
: 12 2 11  la
: 14 2 12  la
E
`;

const CALIBRATION: LatencyCalibration = { route: 'wired', method: 'loopback', roundTripMs: 40, jitterMs: 2, matched: 8, date: '2026-10-22' };

async function until<T>(read: () => T | null | undefined): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = read();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timed out waiting for the screen');
}

async function open(songId: string): Promise<HTMLElement> {
  resetRouterForTests([routeOf('home'), routeOf('song', { songId })]);
  const container = document.createElement('div');
  document.body.append(container);
  render(<SongPlayer />, container);
  return container;
}

beforeEach(async () => {
  vi.mocked(getBundledLibrary).mockResolvedValue({
    songs: [parseUltraStar(TWINKLE, { id: 'twinkle', source: 'bundled' }).song, parseUltraStar(RUN, { id: 'quick-scale', source: 'bundled' }).song],
    errors: [],
  });
  await loadSongs();
});

afterEach(() => {
  for (const c of [...document.body.children]) render(null, c);
  document.body.innerHTML = '';
  deviceSettings.value = { ...deviceSettings.value, latency: {} };
});

describe('Song player', () => {
  it('shows the lyric line and the scrubber, and asks for a calibration before the first take', async () => {
    const c = await open('twinkle');
    await until(() => c.querySelector('[data-testid="song-player"]'));
    expect(c.querySelector('[data-testid="song-lyrics"]')?.textContent).toContain('Twin');
    expect(c.querySelector('[data-testid="song-lyrics"]')?.textContent).toContain('How I won');
    const pills = [...c.querySelectorAll('[data-testid="phrase-scrubber"] button')];
    expect(pills.map((p) => p.textContent)).toEqual(['Whole song', expect.stringContaining('1'), expect.stringContaining('2')]);
    expect(pills[1].getAttribute('aria-pressed')).toBe('true');
    expect(c.textContent).toContain('Calibrate latency first so your takes line up.');
    expect(c.querySelector('[data-testid="song-primary"]')?.textContent).toBe('Calibrate');
  });

  it('offers Sing once the route has a latency calibration', async () => {
    deviceSettings.value = { ...deviceSettings.value, latency: { wired: CALIBRATION } };
    const c = await open('twinkle');
    await until(() => c.querySelector('[data-testid="song-player"]'));
    expect(c.querySelector('[data-testid="song-primary"]')?.textContent).toBe('Sing');
    expect(c.querySelector('[data-testid="song-primary"]')?.getAttribute('aria-label')).toBe('Sing phrase 1');
    expect(c.textContent).not.toContain('Calibrate latency first');
  });

  it('remembers a singer\'s choices for the song, and never hands them to another singer', async () => {
    const pressed = (c: HTMLElement): string[] =>
      [...c.querySelectorAll('[data-testid="phrase-scrubber"] button')].filter((p) => p.getAttribute('aria-pressed') === 'true').map((p) => p.textContent ?? '');
    const me = activeProfile.value!;
    let c = await open('twinkle');
    await until(() => c.querySelector('[data-testid="song-player"]'));
    const pills = [...c.querySelectorAll<HTMLButtonElement>('[data-testid="phrase-scrubber"] button')];
    pills[2].click(); // phrase 2
    await until(() => (pressed(c)[0]?.includes('2') ? true : null));
    render(null, c); // leave: the choices are remembered for this singer

    activeProfile.value = { ...me, id: 'p2', profileId: 'p2', name: 'Beginner' };
    c = await open('twinkle');
    await until(() => c.querySelector('[data-testid="song-player"]'));
    expect(pressed(c)[0]).toContain('1'); // the other singer starts from the default, not from phrase 2
    render(null, c);

    activeProfile.value = me;
    c = await open('twinkle');
    await until(() => c.querySelector('[data-testid="song-player"]'));
    expect(pressed(c)[0]).toContain('2'); // and the first singer gets their own choice back
    expect(rememberedKey('twinkle')).toBe('p1:twinkle');
  });

  it('never opens a song the singer has not earned', async () => {
    const c = await open('quick-scale');
    await until(() => c.querySelector('.pl-locked'));
    expect(c.querySelector('[data-testid="song-player"]')).toBeNull();
    expect(c.textContent).toContain('Pass the Runs & Riffs Boss Recital to unlock this song.');
  });
});

describe('Learning the song', () => {
  const base = attemptLog.value;
  let me = activeProfile.value!;
  const q = (c: HTMLElement, id: string): HTMLElement | null => c.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  let seq = 0;
  function sung(phrase: { from: number; to: number } | null, score: number, songSpeed = 1): AttemptRecord {
    seq += 1;
    const at = new Date(Date.parse('2026-10-22T13:00:00Z') + seq * 60_000).toISOString();
    return {
      id: `song-${seq}`,
      profileId: 'p1',
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      exerciseId: 'song.twinkle',
      levelId: null,
      kind: 'song',
      score,
      passed: score >= 0.7,
      mastery: 0,
      metrics: { 'song.phraseScore': score },
      durationSec: 4,
      tonicMidi: 60,
      tempoBpm: null,
      takeId: null,
      songId: 'twinkle',
      phrase,
      songShift: 0,
      songSpeed,
    };
  }

  beforeEach(() => {
    me = activeProfile.value!;
  });
  afterEach(() => {
    activeProfile.value = me;
    attemptLog.value = base;
  });

  it('walks the path: listen first, then the first phrase slowly, set up and started in one tap', async () => {
    activeProfile.value = { ...me, id: 'p-learn', profileId: 'p-learn' }; // a singer with nothing remembered for this song
    deviceSettings.value = { ...deviceSettings.value, latency: { wired: CALIBRATION } };
    const c = await open('twinkle');
    await until(() => q(c, 'learn-panel'));
    expect(q(c, 'learn-count')?.textContent).toBe('Step 1 of 7');
    expect(q(c, 'learn-step')?.textContent).toBe('Listen to the whole song');
    expect(q(c, 'learn-learned')?.textContent).toBe('0 of 2 phrases learned');
    q(c, 'learn-start')!.click(); // Listen: the whole song plays, and the path moves on for this visit
    await until(() => (q(c, 'learn-count')?.textContent === 'Step 2 of 7' ? true : null));
    expect(q(c, 'learn-step')?.textContent).toBe('Phrase 1, slowly: “Twinkle, twinkle, little star”');
    expect(q(c, 'learn-start')?.textContent).toBe('Sing it slowly');

    q(c, 'learn-start')!.click(); // set up phrase 1, slowly, looping, and start the take
    await until(() => (c.querySelector('[data-phrase="0"]')?.getAttribute('aria-pressed') === 'true' ? true : null));
    expect(c.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe('75%');
    expect(c.querySelector('[aria-label="Loop the phrase"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('waits for a calibration before a sung step', async () => {
    activeProfile.value = { ...me, id: 'p-learn-2', profileId: 'p-learn-2' };
    attemptLog.value = [...base, sung({ from: 0, to: 1 }, 0.4, 0.75)];
    const c = await open('twinkle');
    await until(() => q(c, 'learn-panel'));
    expect(q(c, 'learn-step')?.textContent).toBe('Phrase 1, slowly: “Twinkle, twinkle, little star”');
    expect((q(c, 'learn-start') as HTMLButtonElement).disabled).toBe(true);
    expect(c.textContent).toContain('Calibrate latency first so your takes line up.');
  });

  it('shows each phrase’s best and a learned glyph from the log, and links to the song’s progress', async () => {
    attemptLog.value = [...base, sung({ from: 0, to: 1 }, 0.85), sung({ from: 1, to: 2 }, 0.55), sung({ from: 1, to: 2 }, 0.95, 0.75)];
    const c = await open('twinkle');
    await until(() => q(c, 'learn-panel'));
    const [first, second] = [c.querySelector<HTMLElement>('[data-phrase="0"]')!, c.querySelector<HTMLElement>('[data-phrase="1"]')!];
    expect(first.getAttribute('aria-label')).toBe('Phrase 1, Twinkle, twinkle, little star, learned, best 85%');
    expect(first.classList.contains('pl-song-pill--on')).toBe(true);
    expect(first.querySelector('.pl-song-pill__learned')).not.toBeNull();
    expect(first.textContent).toContain('85');
    // A slowed take is practice: the best is the full-speed one.
    expect(second.getAttribute('aria-label')).toBe('Phrase 2, How I wonder what, not learned yet, best 55%');
    expect(second.classList.contains('pl-song-pill--off')).toBe(true);
    expect(q(c, 'learn-learned')?.textContent).toBe('1 of 2 phrases learned');

    installRouteGuard(() => ({ ok: true })); // the session's guard opens an earned song's progress (guard.ts)
    q(c, 'learn-progress')!.click();
    expect(route.value).toEqual(routeOf('song-progress', { songId: 'twinkle' }));
  });
});
