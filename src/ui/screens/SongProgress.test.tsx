// @vitest-environment happy-dom
/**
 * A song's progress from the log: the next step and how many phrases are learned, each phrase's words, best, last,
 * takes and learned, the whole song, "then and now" (the first take against the best whole-song take, drawn from the
 * takes' saved pitch lines, with a table in their place on request), Send to Claude, and a locked song never shown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { makeTrack } from '../../analysis/fixtures';
import { parseUltraStar } from '../../song/ultrastar';
import type { AttemptRecord, TakeRecord } from '../../storage/schema';
import { encodeTrack } from '../../storage/track-codec';

vi.mock('../../audio/engine', () => ({ getEngine: () => undefined }));
vi.mock('../../state/audio', () => ({ getSynth: () => undefined, resetAudio: async () => undefined }));
vi.mock('../../song/library', () => ({ getBundledLibrary: vi.fn() }));
vi.mock('../../coaching/song-export', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../coaching/song-export')>();
  return { ...real, buildSongCoachingFile: vi.fn(async () => Promise.reject(new Error('not in this test'))) };
});
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
    activeProfile: signal({ id: 'p1', profileId: 'p1', createdAt: at(0), updatedAt: '0', deletedAt: null, name: 'Daniel', voiceType: 'tenor', range: null }),
    recordAttempt: async () => undefined,
  };
});
vi.mock('../../state/settings', async () => {
  const { signal } = await import('@preact/signals');
  const types = await import('../../state/settings-types');
  return { settings: signal(types.DEFAULT_SETTINGS), deviceSettings: signal(types.DEFAULT_DEVICE_SETTINGS) };
});

import { buildSongCoachingFile } from '../../coaching/song-export';
import { installRouteGuard, resetRouterForTests, route, routeOf } from '../../router';
import { getBundledLibrary } from '../../song/library';
import { appStorage, attemptLog } from '../../state/session';
import { loadSongs } from '../../state/songs';
import type { AppStorage } from '../../storage';
import { SongProgress, phraseFacts } from './SongProgress';

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
/** Eight notes a second: needs the Runs & Riffs Boss Recital. */
const RUN = `#TITLE:Quick Scale\n#ARTIST:Me\n#BPM:240\n#GAP:0\n: 0 2 0  la\n: 2 2 2  la\n: 4 2 4  la\n: 6 2 5  la\n: 8 2 7  la\n: 10 2 9  la\n: 12 2 11  la\n: 14 2 12  la\nE\n`;

const base = attemptLog.value;
let seq = 0;
function sung(phrase: { from: number; to: number } | null, score: number, songSpeed: number, takeId: string | null): AttemptRecord {
  seq += 1;
  const at = new Date(Date.parse('2026-10-21T19:00:00Z') + seq * 3_600_000).toISOString();
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
    metrics: { 'song.phraseScore': score, 'song.inTolerancePct': score * 90 },
    durationSec: 5,
    tonicMidi: 60,
    tempoBpm: null,
    takeId,
    songId: 'twinkle',
    phrase,
    songShift: 0,
    songSpeed,
  };
}

/** A take's saved pitch line: C4 held, on the take's own timeline. */
function saved(id: string): TakeRecord {
  return {
    id,
    profileId: 'p1',
    createdAt: '2026-10-21T19:00:00.000Z',
    updatedAt: '1',
    deletedAt: null,
    exerciseId: 'song.twinkle',
    track: encodeTrack(makeTrack({ duration: 7, midi: (t) => (t > 1 && t < 6 ? 60 : NaN), jitterCents: 3 })),
    audioRef: null,
    sampleRate: 48000,
    latencyMs: 40,
  };
}

async function until<T>(read: () => T | null | undefined): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const v = read();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timed out waiting for the screen');
}

function open(songId: string): HTMLElement {
  resetRouterForTests([routeOf('home'), routeOf('song', { songId }), routeOf('song-progress', { songId })]);
  installRouteGuard(() => ({ ok: true }));
  const container = document.createElement('div');
  document.body.append(container);
  render(<SongProgress />, container);
  return container;
}

const q = (c: HTMLElement, id: string): HTMLElement | null => c.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(async () => {
  vi.mocked(getBundledLibrary).mockResolvedValue({
    songs: [parseUltraStar(TWINKLE, { id: 'twinkle', source: 'bundled' }).song, parseUltraStar(RUN, { id: 'quick-scale', source: 'bundled' }).song],
    errors: [],
  });
  await loadSongs();
  appStorage.value = { takes: { get: async (id: string) => (id.startsWith('take-') ? saved(id) : undefined) } } as unknown as AppStorage;
});

afterEach(() => {
  for (const c of [...document.body.children]) render(null, c);
  document.body.innerHTML = '';
  attemptLog.value = base;
  appStorage.value = null;
});

describe('Song progress', () => {
  it('reads the song phrase by phrase from the log, with the whole song and the next step', async () => {
    attemptLog.value = [...base, sung({ from: 0, to: 1 }, 0.5, 0.75, 'take-1'), sung({ from: 0, to: 1 }, 0.86, 1, null), sung({ from: 0, to: 1 }, 0.74, 1, null), sung(null, 0.6, 1, 'take-4')];
    const c = open('twinkle');
    await until(() => q(c, 'song-progress'));
    const rows = [...c.querySelectorAll('[data-testid="progress-phrase"]')];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Twinkle, twinkle, little star');
    expect(rows[0].textContent).toContain('Best 86% · last 74% · 3 takes');
    expect(rows[0].textContent).toContain('Learned');
    expect(rows[0].querySelector('.pl-song-prog__learned svg')).not.toBeNull();
    expect(rows[1].textContent).toContain('Not sung yet');
    expect(rows[1].textContent).toContain('Not yet');
    expect(q(c, 'progress-whole')?.textContent).toBe('Best 60% · last 60% · 1 take');
    expect(q(c, 'progress-learned')?.textContent).toBe('1 of 2 phrases learned');
    expect(q(c, 'progress-next')?.textContent).toBe('Phrase 2, slowly: “How I wonder what”');
    expect(q(c, 'progress-practise')?.textContent).toBe('Practise in the player');
    // The player sits beneath: the button goes back to it.
    q(c, 'progress-practise')!.click();
    expect(route.value).toEqual(routeOf('song', { songId: 'twinkle' }));
  });

  it('shows then and now: the first take against the best whole-song take, drawn, or as a table', async () => {
    attemptLog.value = [...base, sung({ from: 0, to: 1 }, 0.42, 0.75, 'take-1'), sung(null, 0.65, 1, 'take-2'), sung(null, 0.81, 1, 'take-3')];
    const c = open('twinkle');
    await until(() => (c.querySelectorAll('[data-testid="then-now-take"]').length === 2 ? true : null));
    const [then, now] = [...c.querySelectorAll('[data-testid="then-now-take"]')];
    expect(then.textContent).toContain('Then');
    expect(then.textContent).toContain('42%');
    expect(then.textContent).toContain('Phrase 1, slowly');
    expect(now.textContent).toContain('Now');
    expect(now.textContent).toContain('81%');
    expect(now.textContent).toContain('Whole song');
    for (const take of [then, now]) {
      const svg = take.querySelector('svg.pl-song-chart')!;
      expect(svg.getAttribute('role')).toBe('img');
      expect(svg.querySelectorAll('rect.pl-song-chart__note').length).toBeGreaterThan(0);
      expect(svg.querySelectorAll('polyline').length).toBeGreaterThan(0);
    }
    const toggle = [...c.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Show as table'))!;
    toggle.click();
    await until(() => c.querySelector('table'));
    const cells = [...c.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent));
    expect(cells[0][0]).toBe('1. Twinkle, twinkle, little star');
    expect(cells[1][0]).toBe('2. How I wonder what');
    expect(cells[1][1]).toBe('–'); // the first take never sang phrase 2
    expect(cells[cells.length - 1]).toEqual(['The take as scored', '42%', '81%']);
  });

  it('says so when the first take is still the best whole-song take, and before any take', async () => {
    attemptLog.value = [...base, sung(null, 0.75, 1, 'take-9')];
    let c = open('twinkle');
    await until(() => q(c, 'then-now-take'));
    expect(c.textContent).toContain('First and best');
    expect(c.textContent).toContain('Your first take is still your best whole-song take.');
    render(null, c);

    attemptLog.value = base;
    c = open('twinkle');
    await until(() => q(c, 'song-progress'));
    expect(c.textContent).toContain('Sing a phrase of this song, and your first take will show here.');
    expect(q(c, 'progress-whole')?.textContent).toBe('Not sung through yet.');
  });

  it('opens Send to Claude for the song', async () => {
    attemptLog.value = [...base, sung({ from: 0, to: 1 }, 0.5, 1, null)];
    const c = open('twinkle');
    await until(() => q(c, 'song-progress'));
    q(c, 'progress-send')!.click();
    await until(() => c.querySelector('[role="dialog"]'));
    expect(c.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Send to Claude');
    expect(vi.mocked(buildSongCoachingFile)).toHaveBeenCalledWith(expect.objectContaining({ id: 'twinkle' }), { includeAudio: false });
  });

  it('never shows a song the singer has not earned', async () => {
    const c = open('quick-scale');
    await until(() => c.querySelector('.pl-locked'));
    expect(q(c, 'song-progress')).toBeNull();
    expect(c.textContent).toContain('Pass the Runs & Riffs Boss Recital to unlock this song.');
  });

  it('words a phrase’s facts plainly', () => {
    expect(phraseFacts({ best: null, last: null, takes: 0 })).toBe('Not sung yet');
    expect(phraseFacts({ best: null, last: null, takes: 2 })).toBe('Not sung at full speed yet · 2 takes');
    expect(phraseFacts({ best: 0.9, last: 0.6, takes: 1 })).toBe('Best 90% · last 60% · 1 take');
  });
});
