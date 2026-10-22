/**
 * The song index: bundled charts and the active profile's imports merged, reloaded on a profile switch (failing
 * closed in between), never rejecting. The library loader and the session are mocked; the charts are real UltraStar
 * text through the real parser and rater.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BundledLibrary } from '../song/library';
import { parseUltraStar } from '../song/ultrastar';
import type { Song } from '../song/types';
import type { AppStorage } from '../storage';
import type { ProfileRecord, SongRecord } from '../storage/schema';

vi.mock('../song/library', () => ({ getBundledLibrary: vi.fn() }));
vi.mock('./session', async () => {
  const { signal } = await import('@preact/signals');
  return { appStorage: signal(null), activeProfile: signal(null) };
});

/** A slow Foundations hymn line. */
const HYMN = `#TITLE:Morning Hymn
#ARTIST:Traditional
#BPM:80
#GAP:0
#COMMENT:Public domain melody. Chart by Pitch Lab.
: 0 4 0  Glo
: 4 4 2  ry
: 8 4 4  be
E
`;
/** Eight notes a second up a scale: Runs & Riffs material. */
const RUN = `#TITLE:Quick Scale
#ARTIST:Me
#BPM:240
#GAP:1500
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
const OTHER = `#TITLE:Another Song
#ARTIST:Me
#BPM:100
#GAP:0
: 0 8 0  oh
: 8 8 4  yes
E
`;

const bundled = (text: string, id: string): Song => parseUltraStar(text, { id, source: 'bundled' }).song;
const imported = (text: string): Song => parseUltraStar(text).song;

function record(id: string, profileId: string, song: Song): SongRecord {
  return { id, profileId, createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '1', deletedAt: null, song };
}

function profile(id: string): ProfileRecord {
  return { id, profileId: id, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '0', deletedAt: null, name: id, voiceType: 'tenor', range: null };
}

/** A fresh copy of songs.ts (its index is module state), with the mocked library and session. */
async function fresh(library: BundledLibrary | Error, records: Record<string, SongRecord[]>) {
  vi.resetModules();
  const lib = await import('../song/library');
  vi.mocked(lib.getBundledLibrary).mockImplementation(() => (library instanceof Error ? Promise.reject(library) : Promise.resolve(library)));
  const session = await import('./session');
  const byId = new Map(Object.values(records).flat().map((r) => [r.id, r]));
  const storage = {
    songs: {
      listByProfile: vi.fn(async (profileId: string) => records[profileId] ?? []),
      get: vi.fn(async (id: string) => byId.get(id)),
    },
  };
  session.appStorage.value = storage as unknown as AppStorage;
  session.activeProfile.value = null;
  const songs = await import('./songs');
  return { ...songs, session, storage, byId };
}

const LIBRARY: BundledLibrary = {
  songs: [bundled(HYMN, 'morning-hymn')],
  errors: [{ id: 'broken-chart', message: 'Line 3: Expected a note line' }],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadSongs', () => {
  it('merges the bundled charts with the active profile’s imports', async () => {
    const run = imported(RUN);
    const s = await fresh(LIBRARY, { p1: [record('rec-run', 'p1', run)] });
    s.session.activeProfile.value = profile('p1');
    expect(s.songsLoaded.value).toBe(false);
    await s.loadSongs();

    expect(s.songsLoaded.value).toBe(true);
    expect([...s.songIndex.value.keys()]).toEqual(['morning-hymn', run.id]);
    expect(s.songIndex.value.get('morning-hymn')).toMatchObject({
      title: 'Morning Hymn',
      artist: 'Traditional',
      source: 'bundled',
      bundled: true,
      licence: 'Public domain melody. Chart by Pitch Lab.',
      recordId: null,
      caption: null,
      difficulty: { requiredWorld: 'foundations' },
    });
    expect(s.songIndex.value.get('morning-hymn')?.durationSec).toBeCloseTo(12 * (60 / 320), 9);
    const yours = s.songIndex.value.get(run.id)!;
    expect(yours).toMatchObject({ source: 'ultrastar', bundled: false, licence: null, recordId: 'rec-run', difficulty: { requiredWorld: 'runs' } });
    expect(yours.caption).toMatch(/notes/);
    expect(s.songLoadErrors.value).toEqual(LIBRARY.errors);
    expect(s.storage.songs.listByProfile).toHaveBeenCalledWith('p1');
  });

  it('reloads on a profile switch, dropping the last singer’s imports at once', async () => {
    const run = imported(RUN);
    const other = imported(OTHER);
    const s = await fresh(LIBRARY, { p1: [record('rec-run', 'p1', run)], p2: [record('rec-other', 'p2', other)] });
    s.session.activeProfile.value = profile('p1');
    await s.loadSongs();
    expect(s.songIndex.value.has(run.id)).toBe(true);

    s.session.activeProfile.value = profile('p2');
    const reload = s.loadSongs();
    // Before the reload finishes, nothing of p1's is left for the route guard to open.
    expect([...s.songIndex.value.keys()]).toEqual(['morning-hymn']);
    await reload;
    expect([...s.songIndex.value.keys()]).toEqual(['morning-hymn', other.id]);
    expect(await s.getSong(run.id)).toBeUndefined();
  });

  it('a slower, older load never overwrites a newer one', async () => {
    const run = imported(RUN);
    const other = imported(OTHER);
    const s = await fresh(LIBRARY, { p2: [record('rec-other', 'p2', other)] });
    let release: (rows: SongRecord[]) => void = () => {};
    s.storage.songs.listByProfile.mockImplementationOnce(() => new Promise<SongRecord[]>((resolve) => (release = resolve)));
    s.session.activeProfile.value = profile('p1');
    const slow = s.loadSongs();
    s.session.activeProfile.value = profile('p2');
    await s.loadSongs();
    release([record('rec-run', 'p1', run)]);
    await slow;
    expect([...s.songIndex.value.keys()]).toEqual(['morning-hymn', other.id]);
  });

  it('never rejects: a failed library still lists the imports and says what failed', async () => {
    const run = imported(RUN);
    const s = await fresh(new Error('Could not load /pitch-lab/songs/index.json (HTTP 404)'), { p1: [record('rec-run', 'p1', run)] });
    s.session.activeProfile.value = profile('p1');
    s.storage.songs.listByProfile.mockRejectedValueOnce(new Error('database closed'));
    await expect(s.loadSongs()).resolves.toBeUndefined();
    expect(s.songsLoaded.value).toBe(true);
    expect(s.songIndex.value.size).toBe(0);
    expect(s.songLoadErrors.value).toEqual([
      { id: 'songs/index.json', message: 'Could not load /pitch-lab/songs/index.json (HTTP 404)' },
      { id: 'imported songs', message: 'database closed' },
    ]);
    await s.loadSongs(); // a retry reloads
    expect([...s.songIndex.value.keys()]).toEqual([run.id]);
  });

  it('lists bundled charts alone before any profile is active', async () => {
    const s = await fresh(LIBRARY, {});
    await s.loadSongs();
    expect([...s.songIndex.value.keys()]).toEqual(['morning-hymn']);
    expect(s.storage.songs.listByProfile).not.toHaveBeenCalled();
  });
});

describe('getSong', () => {
  it('returns bundled charts from memory and imports fresh from storage', async () => {
    const run = imported(RUN);
    const s = await fresh(LIBRARY, { p1: [record('rec-run', 'p1', run)] });
    s.session.activeProfile.value = profile('p1');
    await s.loadSongs();

    expect((await s.getSong('morning-hymn'))?.notes).toHaveLength(3);
    // The singer moved the backing offset after the index was built: the player gets the stored song.
    s.byId.set('rec-run', record('rec-run', 'p1', { ...run, offsetMs: 1750 }));
    expect((await s.getSong(run.id))?.offsetMs).toBe(1750);
    s.byId.delete('rec-run');
    expect(await s.getSong(run.id)).toBeUndefined(); // deleted meanwhile
    expect(await s.getSong('no-such-song')).toBeUndefined();
  });
});
