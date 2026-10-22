/**
 * Bundled song library: the public-domain starter charts shipped in `public/songs/`.
 *
 * A static host cannot list a directory, so `songs/index.json` names every chart
 * (`{ id, file }`); the charts themselves are UltraStar `.txt` files whose titles, artists and
 * licence notes (`#COMMENT`) live in the file, not in the index. Everything is fetched
 * relative to Vite's BASE_URL (the app is served under /pitch-lab/), parsed with
 * parseUltraStar as `source: 'bundled'` (id = the index slug, licence = the chart's
 * `#COMMENT`) and rated by rateSong inside the parser, so each Song arrives with its real
 * `difficulty.requiredWorld`. Unlocking stays the progress module's job
 * (isSongUnlocked(song.difficulty.requiredWorld, ...)).
 *
 * Songs are returned in the default key; use transpose.ts to fit the singer.
 *
 * Offline: each fetched file is also copied into the Cache API ("pitchlab-songs-v1") and
 * served from there when the network fails, so the library keeps working offline even if
 * the service worker's precache list does not include `.txt`/`.json` (it must; this is a
 * safety net, not a replacement).
 *
 * A broken chart never takes the whole library down: failures are collected in `errors`.
 */
import type { Song } from './types';
import { parseUltraStar } from './ultrastar';

export interface BundledSongEntry {
  /** Stable slug: becomes Song.id. */
  id: string;
  /** File name inside `songs/` (a plain `name.txt`, validated). */
  file: string;
}

export interface BundledSongIndex {
  version: 1;
  songs: BundledSongEntry[];
}

export interface BundledLibrary {
  /** Parsed and rated songs, in index order. */
  songs: Song[];
  /** Entries that could not be loaded or parsed (the rest still load). */
  errors: Array<{ id: string; message: string }>;
}

/** Where fetched text is mirrored for offline use. */
export interface TextStore {
  get(url: string): Promise<string | undefined>;
  put(url: string, text: string): Promise<void>;
}

export interface LibraryOptions {
  /** Defaults to globalThis.fetch. */
  fetch?: (url: string) => Promise<Pick<Response, 'ok' | 'status' | 'text'>>;
  /** Defaults to import.meta.env.BASE_URL. */
  baseUrl?: string;
  /** Offline mirror. Defaults to the Cache API when available; pass null to disable. */
  store?: TextStore | null;
}

export const BUNDLED_CACHE_NAME = 'pitchlab-songs-v1';

const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;
const SAFE_FILE = /^[a-z0-9][a-z0-9-]*\.txt$/;

function normalizeBase(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

/** URL of a file in the bundled songs folder, e.g. "/pitch-lab/songs/amazing-grace.txt". */
export function songsUrl(file: string, baseUrl: string = import.meta.env.BASE_URL): string {
  return `${normalizeBase(baseUrl)}songs/${file}`;
}

/**
 * Validates a parsed index.json. File names must be plain `name.txt` (no paths: the index is
 * same-origin data, but a stray "../" must never become a request) and ids unique slugs.
 */
export function parseSongIndex(json: unknown): BundledSongIndex {
  const root = json as { version?: unknown; songs?: unknown } | null;
  if (!root || typeof root !== 'object' || root.version !== 1 || !Array.isArray(root.songs)) {
    throw new Error('songs/index.json: expected { "version": 1, "songs": [...] }');
  }
  const seen = new Set<string>();
  const songs: BundledSongEntry[] = [];
  for (const raw of root.songs as unknown[]) {
    const e = raw as { id?: unknown; file?: unknown } | null;
    if (!e || typeof e.id !== 'string' || typeof e.file !== 'string') throw new Error('songs/index.json: every song needs a string "id" and "file"');
    if (!SAFE_ID.test(e.id)) throw new Error(`songs/index.json: bad song id "${e.id}"`);
    if (!SAFE_FILE.test(e.file)) throw new Error(`songs/index.json: bad file name "${e.file}" (a plain name.txt is required)`);
    if (seen.has(e.id)) throw new Error(`songs/index.json: duplicate song id "${e.id}"`);
    seen.add(e.id);
    songs.push({ id: e.id, file: e.file });
  }
  return { version: 1, songs };
}

/** Parses one bundled chart: source 'bundled', id = slug, licence from `#COMMENT`, difficulty rated. Pure. */
export function parseBundledChart(text: string, id: string): Song {
  return parseUltraStar(text, { id, source: 'bundled' }).song;
}

function cacheApiStore(): TextStore | null {
  if (typeof caches === 'undefined') return null;
  return {
    async get(url) {
      const cache = await caches.open(BUNDLED_CACHE_NAME);
      const hit = await cache.match(url);
      return hit ? await hit.text() : undefined;
    },
    async put(url, text) {
      const cache = await caches.open(BUNDLED_CACHE_NAME);
      await cache.put(url, new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8' } }));
    },
  };
}

async function fetchText(url: string, opts: LibraryOptions): Promise<string> {
  const doFetch = opts.fetch ?? (globalThis.fetch ? (u: string) => globalThis.fetch(u) : undefined);
  const store = opts.store === undefined ? cacheApiStore() : opts.store;
  let failure = 'no fetch available';
  if (doFetch) {
    try {
      const res = await doFetch(url);
      if (res.ok) {
        const text = await res.text();
        if (store) void store.put(url, text).catch(() => {}); // mirror for offline; never fail the load over it
        return text;
      }
      failure = `HTTP ${res.status}`;
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }
  }
  if (store) {
    try {
      const cached = await store.get(url);
      if (cached !== undefined) return cached;
    } catch {
      // fall through to the error below
    }
  }
  throw new Error(`Could not load ${url} (${failure})`);
}

/** Fetches and validates songs/index.json. */
export async function loadSongIndex(opts: LibraryOptions = {}): Promise<BundledSongIndex> {
  const text = await fetchText(songsUrl('index.json', opts.baseUrl), opts);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // A dev server answers a missing static file with index.html and status 200.
    throw new Error('songs/index.json is not valid JSON');
  }
  return parseSongIndex(json);
}

/** Fetches and parses one chart. */
export async function loadBundledSong(entry: BundledSongEntry, opts: LibraryOptions = {}): Promise<Song> {
  return parseBundledChart(await fetchText(songsUrl(entry.file, opts.baseUrl), opts), entry.id);
}

/** Loads every chart in the index (in parallel). One bad chart is reported in `errors`, not thrown. */
export async function loadBundledLibrary(opts: LibraryOptions = {}): Promise<BundledLibrary> {
  const index = await loadSongIndex(opts);
  const results = await Promise.all(
    index.songs.map(async (entry) => {
      try {
        return { song: await loadBundledSong(entry, opts) };
      } catch (e) {
        return { error: { id: entry.id, message: e instanceof Error ? e.message : String(e) } };
      }
    }),
  );
  const library: BundledLibrary = { songs: [], errors: [] };
  for (const r of results) {
    if ('song' in r && r.song) library.songs.push(r.song);
    else if ('error' in r && r.error) library.errors.push(r.error);
  }
  return library;
}

let memo: Promise<BundledLibrary> | null = null;

/** loadBundledLibrary, memoised so screens can call it freely. A failed load is not cached (retry works). */
export function getBundledLibrary(opts: LibraryOptions = {}): Promise<BundledLibrary> {
  if (!memo) {
    memo = loadBundledLibrary(opts).catch((e) => {
      memo = null;
      throw e;
    });
  }
  return memo;
}

/** Forgets the memoised library (tests; or after a service-worker update brings new charts). */
export function clearBundledLibraryCache(): void {
  memo = null;
}
