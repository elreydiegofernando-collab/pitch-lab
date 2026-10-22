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

import { resetRouterForTests, routeOf } from '../../router';
import { getBundledLibrary } from '../../song/library';
import { deviceSettings } from '../../state/settings';
import { loadSongs } from '../../state/songs';
import { SongPlayer } from './SongPlayer';

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

  it('never opens a song the singer has not earned', async () => {
    const c = await open('quick-scale');
    await until(() => c.querySelector('.pl-locked'));
    expect(c.querySelector('[data-testid="song-player"]')).toBeNull();
    expect(c.textContent).toContain('Pass the Runs & Riffs Boss Recital to unlock this song.');
  });
});
