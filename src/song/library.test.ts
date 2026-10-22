import { beforeEach, describe, expect, it } from 'vitest';
import {
  BUNDLED_CACHE_NAME,
  clearBundledLibraryCache,
  getBundledLibrary,
  loadBundledLibrary,
  loadBundledSong,
  loadSongIndex,
  parseBundledChart,
  parseSongIndex,
  songsUrl,
  type TextStore,
} from './library';

const files = import.meta.glob('../../public/songs/*', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
/** The real bundled files by name: index.json and the charts. */
const REAL = new Map<string, string>(Object.entries(files).map(([path, text]) => [path.split('/').pop() as string, text]));

type Res = { ok: boolean; status: number; text: () => Promise<string> };
const ok = (text: string): Res => ({ ok: true, status: 200, text: async () => text });
const notFound = (): Res => ({ ok: false, status: 404, text: async () => 'not found' });

/** A fake fetch serving `served` (file name -> text) under /pitch-lab/songs/, recording every URL asked for. */
function fakeFetch(served: Map<string, string>, base = '/pitch-lab/') {
  const calls: string[] = [];
  const fetch = async (url: string): Promise<Res> => {
    calls.push(url);
    const prefix = `${base}songs/`;
    if (!url.startsWith(prefix)) return notFound();
    const text = served.get(url.slice(prefix.length));
    return text === undefined ? notFound() : ok(text);
  };
  return { fetch, calls };
}

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const puts: string[] = [];
  const store: TextStore = {
    async get(url) {
      return data.get(url);
    },
    async put(url, text) {
      puts.push(url);
      data.set(url, text);
    },
  };
  return { store, data, puts };
}

const BASE = '/pitch-lab/';

beforeEach(() => clearBundledLibraryCache());

describe('songsUrl', () => {
  it('joins the base path and the songs folder, with or without a trailing slash', () => {
    expect(songsUrl('a.txt', '/pitch-lab/')).toBe('/pitch-lab/songs/a.txt');
    expect(songsUrl('a.txt', '/pitch-lab')).toBe('/pitch-lab/songs/a.txt');
    expect(songsUrl('index.json', '/')).toBe('/songs/index.json');
    expect(songsUrl('a.txt', 'https://example.org/app/')).toBe('https://example.org/app/songs/a.txt');
  });

  it('defaults to Vite\'s BASE_URL', () => {
    expect(songsUrl('a.txt')).toBe(`${import.meta.env.BASE_URL}songs/a.txt`);
  });
});

describe('parseSongIndex', () => {
  const valid = { version: 1, songs: [{ id: 'amazing-grace', file: 'amazing-grace.txt' }] };

  it('accepts a valid index', () => {
    expect(parseSongIndex(valid)).toEqual(valid);
    expect(parseSongIndex({ version: 1, songs: [] }).songs).toEqual([]);
  });

  it('rejects the wrong shape, version, ids, file names and duplicates', () => {
    for (const bad of [null, 'x', 42, {}, { version: 2, songs: [] }, { version: 1 }, { version: 1, songs: 'no' }]) {
      expect(() => parseSongIndex(bad)).toThrow(/index\.json/);
    }
    const one = (e: unknown) => ({ version: 1, songs: [e] });
    expect(() => parseSongIndex(one(null))).toThrow(/string "id" and "file"/);
    expect(() => parseSongIndex(one({ id: 1, file: 'a.txt' }))).toThrow(/string "id" and "file"/);
    expect(() => parseSongIndex(one({ id: 'Has Caps', file: 'a.txt' }))).toThrow(/bad song id/);
    expect(() => parseSongIndex(one({ id: '-lead', file: 'a.txt' }))).toThrow(/bad song id/);
    for (const file of ['../a.txt', 'dir/a.txt', 'a.TXT', 'a.json', '/etc/passwd', 'a.txt?x=1', '']) {
      expect(() => parseSongIndex(one({ id: 'a', file }))).toThrow(/bad file name/);
    }
    expect(() => parseSongIndex({ version: 1, songs: [{ id: 'a', file: 'a.txt' }, { id: 'a', file: 'b.txt' }] })).toThrow(/duplicate/);
  });
});

describe('parseBundledChart', () => {
  it('builds a bundled, rated, licensed song under the given slug', () => {
    const song = parseBundledChart(REAL.get('amazing-grace.txt') as string, 'amazing-grace');
    expect(song.id).toBe('amazing-grace');
    expect(song.source).toBe('bundled');
    expect(song.licence).toMatch(/Public domain/);
    expect(song.difficulty.requiredWorld).toBe('vibrato');
  });
});

describe('loading the library', () => {
  it('fetches the index and every chart relative to the base path', async () => {
    const { fetch, calls } = fakeFetch(REAL, BASE);
    const lib = await loadBundledLibrary({ fetch, baseUrl: BASE, store: null });
    expect(lib.errors).toEqual([]);
    expect(lib.songs.map((s) => s.id)).toEqual(['twinkle-twinkle', 'auld-lang-syne', 'amazing-grace', 'silent-night', 'danny-boy', 'ave-maria']);
    expect(calls[0]).toBe('/pitch-lab/songs/index.json');
    expect(new Set(calls.slice(1))).toEqual(new Set(lib.songs.map((s) => `/pitch-lab/songs/${s.id}.txt`)));
    expect(lib.songs.every((s) => s.source === 'bundled' && s.difficulty.rangeSemitones > 0)).toBe(true);
  });

  it('loads a single song', async () => {
    const { fetch } = fakeFetch(REAL, BASE);
    const song = await loadBundledSong({ id: 'danny-boy', file: 'danny-boy.txt' }, { fetch, baseUrl: BASE, store: null });
    expect(song.title).toBe('Danny Boy');
  });

  it('one broken chart is reported, not fatal', async () => {
    const served = new Map(REAL);
    served.set('danny-boy.txt', 'this is not an UltraStar chart');
    served.delete('silent-night.txt');
    const { fetch } = fakeFetch(served, BASE);
    const lib = await loadBundledLibrary({ fetch, baseUrl: BASE, store: null });
    expect(lib.songs.map((s) => s.id)).toEqual(['twinkle-twinkle', 'auld-lang-syne', 'amazing-grace', 'ave-maria']);
    expect(lib.errors.map((e) => e.id).sort()).toEqual(['danny-boy', 'silent-night']);
    expect(lib.errors.find((e) => e.id === 'silent-night')!.message).toMatch(/HTTP 404/);
    expect(lib.errors.find((e) => e.id === 'danny-boy')!.message).toMatch(/#BPM|Unrecognized/);
  });

  it('fails clearly when the index is missing, unreadable or not JSON (a dev server answers a missing file with HTML)', async () => {
    const missing = fakeFetch(new Map(), BASE);
    await expect(loadSongIndex({ fetch: missing.fetch, baseUrl: BASE, store: null })).rejects.toThrow(/Could not load .*index\.json \(HTTP 404\)/);
    const html = fakeFetch(new Map([['index.json', '<!doctype html><html></html>']]), BASE);
    await expect(loadSongIndex({ fetch: html.fetch, baseUrl: BASE, store: null })).rejects.toThrow(/not valid JSON/);
    const wrong = fakeFetch(new Map([['index.json', '{"version":9,"songs":[]}']]), BASE);
    await expect(loadSongIndex({ fetch: wrong.fetch, baseUrl: BASE, store: null })).rejects.toThrow(/expected/);
    const down = async (): Promise<Res> => {
      throw new TypeError('Failed to fetch');
    };
    await expect(loadSongIndex({ fetch: down, baseUrl: BASE, store: null })).rejects.toThrow(/Failed to fetch/);
  });

  it('honours an explicit base path', async () => {
    const { fetch, calls } = fakeFetch(REAL, '/other/');
    await loadBundledLibrary({ fetch, baseUrl: '/other/', store: null });
    expect(calls[0]).toBe('/other/songs/index.json');
  });
});

describe('getBundledLibrary (memoised)', () => {
  it('loads once and shares the result', async () => {
    const { fetch, calls } = fakeFetch(REAL, BASE);
    const a = await getBundledLibrary({ fetch, baseUrl: BASE, store: null });
    const n = calls.length;
    const b = await getBundledLibrary({ fetch, baseUrl: BASE, store: null });
    expect(b).toBe(a);
    expect(calls.length).toBe(n);
    clearBundledLibraryCache();
    await getBundledLibrary({ fetch, baseUrl: BASE, store: null });
    expect(calls.length).toBe(2 * n);
  });

  it('shares one in-flight load between concurrent callers', async () => {
    const { fetch, calls } = fakeFetch(REAL, BASE);
    const [a, b] = await Promise.all([getBundledLibrary({ fetch, baseUrl: BASE, store: null }), getBundledLibrary({ fetch, baseUrl: BASE, store: null })]);
    expect(a).toBe(b);
    expect(calls.filter((c) => c.endsWith('index.json'))).toHaveLength(1);
  });

  it('does not cache a failed load, so a retry can succeed', async () => {
    await expect(getBundledLibrary({ fetch: fakeFetch(new Map(), BASE).fetch, baseUrl: BASE, store: null })).rejects.toThrow();
    const lib = await getBundledLibrary({ fetch: fakeFetch(REAL, BASE).fetch, baseUrl: BASE, store: null });
    expect(lib.songs).toHaveLength(6);
  });
});

describe('offline mirror', () => {
  it('copies every fetched file into the store', async () => {
    const { fetch } = fakeFetch(REAL, BASE);
    const { store, puts } = memoryStore();
    await loadBundledLibrary({ fetch, baseUrl: BASE, store });
    expect(new Set(puts)).toEqual(new Set([...REAL.keys()].map((f) => `${BASE}songs/${f}`)));
  });

  it('serves from the store when the network is down, so the library works offline', async () => {
    const online = fakeFetch(REAL, BASE);
    const { store } = memoryStore();
    await loadBundledLibrary({ fetch: online.fetch, baseUrl: BASE, store });
    const offline = async (): Promise<Res> => {
      throw new TypeError('Failed to fetch');
    };
    const lib = await loadBundledLibrary({ fetch: offline, baseUrl: BASE, store });
    expect(lib.errors).toEqual([]);
    expect(lib.songs).toHaveLength(6);
  });

  it('also falls back to the store on an HTTP error, but still reports a file the store never had', async () => {
    const { store } = memoryStore({ [`${BASE}songs/index.json`]: REAL.get('index.json') as string, [`${BASE}songs/amazing-grace.txt`]: REAL.get('amazing-grace.txt') as string });
    const lib = await loadBundledLibrary({ fetch: fakeFetch(new Map(), BASE).fetch, baseUrl: BASE, store });
    expect(lib.songs.map((s) => s.id)).toEqual(['amazing-grace']);
    expect(lib.errors).toHaveLength(5);
  });

  it('never lets a failing store break an online load', async () => {
    const broken: TextStore = {
      async get() {
        throw new Error('quota');
      },
      async put() {
        throw new Error('quota');
      },
    };
    const lib = await loadBundledLibrary({ fetch: fakeFetch(REAL, BASE).fetch, baseUrl: BASE, store: broken });
    expect(lib.songs).toHaveLength(6);
    const down = async (): Promise<Res> => {
      throw new TypeError('offline');
    };
    await expect(loadSongIndex({ fetch: down, baseUrl: BASE, store: broken })).rejects.toThrow(/Could not load/);
  });

  it('names the cache so the service worker owner can find it', () => {
    expect(BUNDLED_CACHE_NAME).toBe('pitchlab-songs-v1');
  });
});
