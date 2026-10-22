import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Song } from '../song/types';
import { META_KEYS, openDb } from './db';
import { getStorage, openStorage, resetStorageForTests, type AppStorage, type OpenStorageOptions } from './index';
import { profileSettingsKey } from './keys';
import { openKV } from './kv';
import { ORPHAN_MIN_AGE_MS } from './maintenance';
import { openOpfs } from './opfs';
import {
  MemoryKV,
  attemptInput,
  emptyTrack,
  failIndexedDbOpen,
  freshName,
  installNoOpfs,
  installOpfsMock,
  installUnreachableOpfs,
  lockFilesEndingWith,
  useOpfsMock,
  withPersistent,
} from './test-helpers';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetStorageForTests();
});

interface Names {
  dbName: string;
  binaryDbName: string;
  kvDbName: string;
}

function newNames(): Names {
  return { dbName: freshName('app-db'), binaryDbName: freshName('app-bin'), kvDbName: freshName('app-kv') };
}

async function boot(names: Names = newNames(), extra: Partial<OpenStorageOptions> = {}): Promise<{ storage: AppStorage; names: Names }> {
  installNoOpfs(); // the idb-blob binary backend
  return { storage: await openStorage({ ...names, ...extra }), names };
}

const SONG: Song = {
  id: 'song-1',
  title: 'Amazing Grace',
  artist: 'Traditional',
  source: 'ultrastar',
  notes: [{ start: 0, duration: 1, midi: 60, lyric: 'a', type: 'normal' }],
  phrases: [{ start: 0, end: 1, from: 0, to: 1 }],
  backingRef: null,
  offsetMs: 0,
  difficulty: { lowestMidi: 55, highestMidi: 67, rangeSemitones: 12, maxLeapSemitones: 4, notesPerSec: 1, melismaRate: 0, longNoteRatio: 0.3, requiredWorld: 'foundations' },
};

const takeInput = (profileId: string, audio?: Blob) => ({ profileId, exerciseId: 'foundations.sustain.1', track: emptyTrack(), sampleRate: 48000, latencyMs: 12, audio });

describe('first launch', () => {
  it('opens every layer, migrates, and leaves an active default profile', async () => {
    const { storage } = await boot();
    expect(storage.persistent).toBe(true);
    expect(storage.migration.ran).toBe(true);
    expect(storage.migration.error).toBeUndefined();
    const active = await storage.profiles.active();
    expect(active.name).toBe('Me');
    expect((await storage.profiles.list()).map((p) => p.id)).toEqual([active.id]);
    expect(await storage.profiles.activeId()).toBe(active.id);
  });

  it('moves Phase 1 settings under the new profile id', async () => {
    const names = newNames();
    const kv = await openKV(names.kvDbName);
    await kv.set('profile:default:settings', { schemaVersion: 1, theme: 'dark' });
    await kv.set('device:settings', { schemaVersion: 1, route: 'wired' });

    const { storage } = await boot(names);
    const me = await storage.profiles.active();
    expect(await storage.kv.get(profileSettingsKey(me.id))).toEqual({ schemaVersion: 1, theme: 'dark' });
    expect(await storage.kv.get('profile:default:settings')).toBeUndefined();
    expect(await storage.kv.get('device:settings')).toEqual({ schemaVersion: 1, route: 'wired' });
    expect(storage.migration.settingsMigrated).toBe(true);
  });

  it('two launches racing (a home-screen app and a browser tab) still end with one profile', async () => {
    installNoOpfs();
    const names = newNames();
    const [a, b] = await Promise.all([openStorage(names), openStorage(names)]);
    expect(await a.profiles.list()).toHaveLength(1);
    expect((await b.profiles.list()).map((p) => p.id)).toEqual((await a.profiles.list()).map((p) => p.id));
  });
});

describe('a relaunch (the app was killed and reopened)', () => {
  it('finds everything the first session wrote, and does not migrate again', async () => {
    const { storage, names } = await boot();
    const me = await storage.profiles.active();
    await storage.profiles.setRange(me.id, { comfortable: { low: 48, high: 60 }, extended: { low: 43, high: 65 }, measuredAt: '2026-10-21T00:00:00.000Z' });
    const attempt = await storage.attempts.add(attemptInput(me.id));
    const take = await storage.takes.save(takeInput(me.id, new Blob(['wav'])));
    const song = await storage.songs.import(me.id, SONG, new Blob(['backing']));
    await storage.kv.set(profileSettingsKey(me.id), { theme: 'light' });

    const { storage: again } = await boot(names);
    expect(again.migration.ran).toBe(false);
    const meAgain = await again.profiles.active();
    expect(meAgain.id).toBe(me.id);
    expect(meAgain.range?.comfortable).toEqual({ low: 48, high: 60 });
    expect((await again.attempts.listByProfile(me.id)).map((a) => a.id)).toEqual([attempt.id]);
    const savedTake = (await again.takes.get(take.id))!;
    expect(await (await again.takes.audio(savedTake))?.text()).toBe('wav');
    expect((await again.songs.get(song.id))?.song.title).toBe('Amazing Grace');
    expect(await (await again.opfs.read(song.song.backingRef!))?.text()).toBe('backing');
    expect(await again.kv.get(profileSettingsKey(me.id))).toEqual({ theme: 'light' });
  });

  it('keeps a restarted clock ahead of everything already written', async () => {
    const { storage, names } = await boot();
    const me = await storage.profiles.active();
    const before = await storage.attempts.add(attemptInput(me.id));
    const { storage: again } = await boot(names);
    const after = await again.attempts.add(attemptInput(me.id));
    expect(after.updatedAt > before.updatedAt).toBe(true);
    expect((await again.attempts.listByProfile(me.id)).map((a) => a.id)).toEqual([before.id, after.id]);
  });
});

describe('when storage is not durable', () => {
  it('runs entirely in memory, says so, and still works', async () => {
    vi.stubGlobal('indexedDB', undefined);
    installNoOpfs();
    const storage = await openStorage();
    expect(storage.persistent).toBe(false);
    const me = await storage.profiles.active();
    await storage.attempts.add(attemptInput(me.id));
    await storage.takes.save(takeInput(me.id, new Blob(['audio'])));
    const usage = await storage.usage();
    expect(usage.persistent).toBe(false);
    expect(usage.dbFallbackReason).toBe('indexeddb-unavailable');
    expect(usage.binaryBackend).toBe('memory');
    expect(usage.attemptCount).toBe(1);
  });

  it('is not "persistent" if just one layer fell back', async () => {
    const names = newNames();
    installNoOpfs();
    const { MemoryKV } = await import('./test-helpers');
    const kv = new MemoryKV();
    (kv as { persistent: boolean }).persistent = false;
    const storage = await openStorage({ ...names, kv });
    expect(storage.persistent).toBe(false);
  });
});

describe('profiles', () => {
  it('creating a profile does not steal the active selection; setActive changes it', async () => {
    const { storage } = await boot();
    const me = await storage.profiles.active();
    const beginner = await storage.profiles.create({ name: 'Beginner' });
    expect(await storage.profiles.activeId()).toBe(me.id);
    await storage.profiles.setActive(beginner.id);
    expect((await storage.profiles.active()).id).toBe(beginner.id);
    expect((await storage.profiles.list()).map((p) => p.name)).toEqual(['Me', 'Beginner']);
  });

  it('updates', async () => {
    const { storage } = await boot();
    const me = await storage.profiles.active();
    await storage.profiles.rename(me.id, 'Don');
    await storage.profiles.setVoiceType(me.id, 'tenor');
    await storage.profiles.update(me.id, { name: 'Don J' });
    expect(await storage.profiles.get(me.id)).toMatchObject({ name: 'Don J', voiceType: 'tenor' });
  });

  it('deleting the active profile switches to another live one', async () => {
    const { storage } = await boot();
    const me = await storage.profiles.active();
    const other = await storage.profiles.create({ name: 'Other' });
    await storage.profiles.delete(me.id);
    expect((await storage.profiles.active()).id).toBe(other.id);
    expect((await storage.profiles.list()).map((p) => p.id)).toEqual([other.id]);
    expect(await storage.profiles.get(me.id)).toBeUndefined();
  });

  it('deleting the LAST profile creates a fresh default, so the app never has zero profiles', async () => {
    const { storage } = await boot();
    const me = await storage.profiles.active();
    await storage.profiles.delete(me.id);
    const fresh = await storage.profiles.active();
    expect(fresh.id).not.toBe(me.id);
    expect(fresh.name).toBe('Me');
    expect(await storage.profiles.list()).toHaveLength(1);
  });

  it('a soft delete keeps the history and recordings, and can be undone', async () => {
    const { storage } = await boot();
    const me = await storage.profiles.active();
    await storage.profiles.create({ name: 'Keeper' });
    const attempt = await storage.attempts.add(attemptInput(me.id));
    const take = await storage.takes.save(takeInput(me.id, new Blob(['audio'])));
    await storage.profiles.delete(me.id);
    expect(await storage.attempts.listByProfile(me.id)).toHaveLength(1);
    expect(await storage.takes.get(take.id)).toBeDefined();
    await storage.profiles.restore(me.id);
    expect((await storage.profiles.list()).map((p) => p.id)).toContain(me.id);
    expect((await storage.attempts.get(attempt.id))?.id).toBe(attempt.id);
  });

  it('removeRecordings also deletes the profile\'s takes and audio, for good (attempts stay)', async () => {
    const { storage } = await boot();
    const me = await storage.profiles.active();
    await storage.profiles.create({ name: 'Keeper' });
    await storage.attempts.add(attemptInput(me.id));
    const take = await storage.takes.save(takeInput(me.id, new Blob(['audio'])));
    await storage.profiles.delete(me.id, { removeRecordings: true });
    expect(await storage.takes.listByProfile(me.id)).toEqual([]);
    expect(await storage.opfs.read(take.audioRef!)).toBeUndefined();
    expect(await storage.attempts.listByProfile(me.id)).toHaveLength(1);
  });

  it('removeRecordings also deletes the songs the profile imported, backing tracks included (nothing left unreachable)', async () => {
    const { storage } = await boot();
    const me = await storage.profiles.active();
    const other = await storage.profiles.create({ name: 'Keeper' });
    const mine = await storage.songs.import(me.id, SONG, new Blob(['backing']));
    const theirs = await storage.songs.import(other.id, SONG, new Blob(['their backing']));
    const before = (await storage.usage()).binaryBytes;
    await storage.profiles.delete(me.id, { removeRecordings: true });
    expect(await storage.songs.get(mine.id)).toBeUndefined();
    expect(await storage.opfs.read(mine.song.backingRef!)).toBeUndefined();
    expect((await storage.usage()).binaryBytes).toBeLessThan(before);
    // Another singer's import of the same file is theirs, and stays.
    expect(await storage.songs.get(theirs.id)).toBeDefined();
    expect(await (await storage.opfs.read(theirs.song.backingRef!))?.text()).toBe('their backing');
  });

  it('without removeRecordings the imported songs are kept, so a restored profile gets them back', async () => {
    const { storage } = await boot();
    const me = await storage.profiles.active();
    await storage.profiles.create({ name: 'Keeper' });
    const mine = await storage.songs.import(me.id, SONG, new Blob(['backing']));
    await storage.profiles.delete(me.id);
    expect(await storage.songs.get(mine.id)).toBeDefined();
    await storage.profiles.restore(me.id);
    expect((await storage.songs.listByProfile(me.id)).map((s) => s.id)).toEqual([mine.id]);
  });
});

describe('attempts', () => {
  it('is append-only: the API has no way to change or remove an attempt', async () => {
    const { storage } = await boot();
    expect(Object.keys(storage.attempts).sort()).toEqual(['add', 'get', 'listByExercise', 'listByProfile']);
  });

  it('adds and lists', async () => {
    const { storage } = await boot();
    const me = await storage.profiles.active();
    const a = await storage.attempts.add(attemptInput(me.id, { exerciseId: 'x.1' }));
    const b = await storage.attempts.add(attemptInput(me.id, { exerciseId: 'x.2' }));
    expect((await storage.attempts.listByProfile(me.id)).map((r) => r.id)).toEqual([a.id, b.id]);
    expect((await storage.attempts.listByExercise(me.id, 'x.2')).map((r) => r.id)).toEqual([b.id]);
    expect((await storage.attempts.get(a.id))?.exerciseId).toBe('x.1');
  });
});

describe('takes', () => {
  it('applies the retention given at open, and picks up later changes to it', async () => {
    const { storage } = await boot(newNames(), { takeRetention: { maxTakesPerProfile: 2 } });
    const me = await storage.profiles.active();
    for (let i = 0; i < 4; i++) await storage.takes.save(takeInput(me.id));
    expect(await storage.takes.listByProfile(me.id)).toHaveLength(2);

    storage.takes.retention.maxTakesPerProfile = 1;
    await storage.takes.save(takeInput(me.id));
    expect(await storage.takes.listByProfile(me.id)).toHaveLength(1);
  });

  it('saves, reads, deletes', async () => {
    const { storage } = await boot();
    const me = await storage.profiles.active();
    const take = await storage.takes.save(takeInput(me.id, new Blob(['pcm'])));
    expect(await (await storage.takes.audio(take))?.text()).toBe('pcm');
    await storage.takes.delete(take.id);
    expect(await storage.takes.get(take.id)).toBeUndefined();
    expect(await storage.takes.audio(take)).toBeUndefined();
    const a = await storage.takes.save(takeInput(me.id));
    expect(await storage.takes.deleteByProfile(me.id)).toBe(1);
    expect(await storage.takes.get(a.id)).toBeUndefined();
  });
});

describe('songs', () => {
  it('imports, finds, lists, calibrates, changes the backing track, deletes', async () => {
    const { storage } = await boot();
    const me = await storage.profiles.active();
    const record = await storage.songs.import(me.id, SONG);
    expect((await storage.songs.findByContentId(me.id, 'song-1'))?.id).toBe(record.id);
    expect((await storage.songs.listByProfile(me.id)).map((r) => r.id)).toEqual([record.id]);
    expect((await storage.songs.setOffset(record.id, 80)).song.offsetMs).toBe(80);
    const withBacking = await storage.songs.setBacking(record.id, new Blob(['b']));
    expect(await (await storage.opfs.read(withBacking.song.backingRef!))?.text()).toBe('b');
    await storage.songs.delete(record.id);
    expect(await storage.songs.get(record.id)).toBeUndefined();
    expect(await storage.opfs.list()).toEqual([]);
  });
});

describe('backup', () => {
  it('moves everything to a fresh device: profiles, attempts and settings, retiring the empty default', async () => {
    const { storage: source } = await boot();
    const tenor = await source.profiles.active();
    await source.profiles.rename(tenor.id, 'Tenor');
    const beginner = await source.profiles.create({ name: 'Beginner' });
    const a1 = await source.attempts.add(attemptInput(tenor.id));
    const a2 = await source.attempts.add(attemptInput(beginner.id));
    await source.takes.save(takeInput(tenor.id, new Blob(['private audio'])));
    await source.kv.set(profileSettingsKey(tenor.id), { schemaVersion: 1, theme: 'dark' });
    const text = await source.backup.exportJson();
    expect(text).not.toContain('private audio');
    expect(source.backup.fileName(new Date('2026-10-21T00:00:00Z'))).toBe('pitch-lab-backup-2026-10-21.json');

    const { storage: dest } = await boot();
    const defaultMe = await dest.profiles.active();
    expect(defaultMe.name).toBe('Me');

    const report = await dest.backup.import(text);
    expect(report.ok).toBe(true);
    expect(report).toMatchObject({ profilesAdded: 2, attemptsAdded: 2, settingsRestored: 1, retiredDefaultProfileId: defaultMe.id });
    expect((await dest.profiles.list()).map((p) => p.name)).toEqual(['Tenor', 'Beginner']);
    expect((await dest.profiles.active()).id).toBe(tenor.id);
    expect((await dest.attempts.get(a1.id))?.exerciseId).toBe(a1.exerciseId);
    expect((await dest.attempts.listByProfile(beginner.id)).map((a) => a.id)).toEqual([a2.id]);
    expect(await dest.kv.get(profileSettingsKey(tenor.id))).toEqual({ schemaVersion: 1, theme: 'dark' });
    expect(await dest.takes.listByProfile(tenor.id)).toEqual([]); // audio never travels
  });

  it('can be told not to retire the default profile', async () => {
    const { storage: source } = await boot();
    await source.profiles.create({ name: 'Extra' });
    const file = await source.backup.export();
    const { storage: dest } = await boot();
    const me = await dest.profiles.active();
    const report = await dest.backup.import(file, { retireEmptyDefaultProfile: false });
    expect(report.retiredDefaultProfileId).toBeNull();
    expect(await dest.profiles.get(me.id)).toBeDefined();
  });

  it('a garbage file reports an error and changes nothing, leaving a usable active profile', async () => {
    const { storage } = await boot();
    const me = await storage.profiles.active();
    const report = await storage.backup.import('definitely not a backup');
    expect(report.ok).toBe(false);
    expect(report.errors).toHaveLength(1);
    expect((await storage.profiles.active()).id).toBe(me.id);
    expect(await storage.profiles.list()).toHaveLength(1);
  });

  it('brings back a profile deleted after the backup was made, when the import is an explicit restore (and only then)', async () => {
    const { storage } = await boot();
    const me = await storage.profiles.active();
    const sam = await storage.profiles.create({ name: 'Sam' });
    const attempt = await storage.attempts.add(attemptInput(sam.id));
    const backup = await storage.backup.exportJson(); // "Export a backup first", as the Delete sheet offers
    await storage.profiles.delete(sam.id);
    expect((await storage.profiles.list()).map((p) => p.id)).toEqual([me.id]);

    // A sync-style merge keeps the newer deletion.
    const merge = await storage.backup.import(backup);
    expect(merge).toMatchObject({ profilesRestored: 0, profilesUpdated: 0 });
    expect((await storage.profiles.list()).map((p) => p.id)).toEqual([me.id]);

    // The singer restoring from the file gets Sam back, history included.
    const restore = await storage.backup.import(backup, { restoreDeleted: true });
    expect(restore).toMatchObject({ ok: true, profilesRestored: 1, profilesUpdated: 1 });
    expect((await storage.profiles.list()).map((p) => p.name)).toEqual(['Me', 'Sam']);
    expect((await storage.attempts.listByProfile(sam.id)).map((a) => a.id)).toEqual([attempt.id]);
    // A profile the file holds deleted is never brought back by it.
    const again = await storage.backup.import(backup, { restoreDeleted: true });
    expect(again.profilesRestored).toBe(0);
  });

  it('exports a chosen profile only', async () => {
    const { storage } = await boot();
    const me = await storage.profiles.active();
    const other = await storage.profiles.create({ name: 'Other' });
    const file = await storage.backup.export([other.id]);
    expect(file.profiles.map((p) => p.id)).toEqual([other.id]);
    expect(file.profiles.map((p) => p.id)).not.toContain(me.id);
  });
});

describe('housekeeping', () => {
  it('reconcile() clears the reference to audio the browser evicted', async () => {
    const { storage } = await boot();
    const me = await storage.profiles.active();
    const take = await storage.takes.save(takeInput(me.id, new Blob(['audio'])));
    await storage.opfs.delete(take.audioRef!);
    const report = await storage.reconcile();
    expect(report.danglingTakes).toBe(1);
    expect((await storage.takes.get(take.id))?.audioRef).toBeNull();
  });

  it('usage() reports counts and bytes', async () => {
    const { storage } = await boot();
    const me = await storage.profiles.active();
    await storage.attempts.add(attemptInput(me.id));
    await storage.attempts.add(attemptInput(me.id));
    await storage.takes.save(takeInput(me.id, new Blob(['12345'])));
    await storage.songs.import(me.id, SONG, new Blob(['123']));
    const usage = await storage.usage();
    expect(usage).toMatchObject({ persistent: true, dbFallbackReason: null, binaryBackend: 'idb-blob', attemptCount: 2, takeCount: 1, binaryBytes: 8 });
    expect(usage.origin).toEqual({ usage: null, quota: null }); // no navigator.storage.estimate in the test stub
  });

  it('usage() passes through the browser\'s quota estimate when it has one', async () => {
    installNoOpfs();
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ usage: 123, quota: 456 }) } });
    const storage = await openStorage(newNames());
    expect((await storage.usage()).origin).toEqual({ usage: 123, quota: 456 });
  });

  it('deleteAllData wipes the singers\' data, keeps device settings, and recreates a default profile', async () => {
    const { storage } = await boot();
    const me = await storage.profiles.active();
    await storage.attempts.add(attemptInput(me.id));
    await storage.takes.save(takeInput(me.id, new Blob(['audio'])));
    await storage.songs.import(me.id, SONG, new Blob(['b']));
    await storage.kv.set(profileSettingsKey(me.id), { theme: 'dark' });
    await storage.kv.set('device:settings', { route: 'wired' });

    await storage.deleteAllData();

    const fresh = await storage.profiles.active();
    expect(fresh.id).not.toBe(me.id);
    expect(await storage.profiles.list()).toHaveLength(1);
    expect(await storage.attempts.listByProfile(me.id)).toEqual([]);
    expect(await storage.opfs.list()).toEqual([]);
    expect(await storage.kv.get(profileSettingsKey(me.id))).toBeUndefined();
    expect(await storage.kv.get('device:settings')).toEqual({ route: 'wired' });
    expect((await storage.usage()).attemptCount).toBe(0);
  });
});

describe('getStorage', () => {
  it('opens once and hands every caller the same instance', async () => {
    installNoOpfs();
    const [a, b] = await Promise.all([getStorage(), getStorage()]);
    expect(a).toBe(b);
    expect(await getStorage()).toBe(a);
  });

  it('a reset (tests only) opens a new one', async () => {
    installNoOpfs();
    const a = await getStorage();
    resetStorageForTests();
    const b = await getStorage();
    expect(b).not.toBe(a);
  });

  it('close() releases the connections', async () => {
    const { storage } = await boot();
    storage.close();
    await expect(storage.profiles.list()).rejects.toThrow(/closed/);
  });
});

describe('persistent', () => {
  type Layer = 'db' | 'opfs' | 'kv';

  /** Every layer durable except the named one (injected, so each can be taken down singly). */
  async function openWithDown(layer?: Layer): Promise<AppStorage> {
    installNoOpfs();
    const names = newNames();
    const db = await openDb(names.dbName);
    const opfs = await openOpfs({ fallbackDbName: names.binaryDbName });
    const kv = new MemoryKV();
    if (layer === 'kv') kv.persistent = false;
    return openStorage({ ...names, db: layer === 'db' ? withPersistent(db, false) : db, opfs: layer === 'opfs' ? withPersistent(opfs, false) : opfs, kv });
  }

  it.each<Layer>(['db', 'opfs', 'kv'])('is false, in AppStorage and in usage(), when only the %s layer is not durable', async (layer) => {
    const storage = await openWithDown(layer);
    expect(storage.persistent).toBe(false);
    expect((await storage.usage()).persistent).toBe(false);
  });

  it('is true in both when every layer is durable', async () => {
    const storage = await openWithDown();
    expect(storage.persistent).toBe(true);
    expect((await storage.usage()).persistent).toBe(true);
  });
});

describe('the binary backend marker is written in one place, whichever way a binary gets written', () => {
  const marker = (storage: AppStorage) => storage.db.store('meta').get(META_KEYS.binaryBackend);

  it('takes.save, songs.import and songs.setBacking each record it; saving no audio records nothing', async () => {
    const saveTake = await boot();
    const me = await saveTake.storage.profiles.active();
    await saveTake.storage.takes.save(takeInput(me.id)); // track only: no binary
    await expect(marker(saveTake.storage)).resolves.toBeUndefined();
    await saveTake.storage.takes.save(takeInput(me.id, new Blob(['audio'])));
    await expect(marker(saveTake.storage)).resolves.toBe('idb-blob');

    const importSong = await boot();
    await importSong.storage.songs.import((await importSong.storage.profiles.active()).id, SONG, new Blob(['backing']));
    await expect(marker(importSong.storage)).resolves.toBe('idb-blob');

    const setBacking = await boot();
    const record = await setBacking.storage.songs.import((await setBacking.storage.profiles.active()).id, SONG);
    await expect(marker(setBacking.storage)).resolves.toBeUndefined();
    await setBacking.storage.songs.setBacking(record.id, new Blob(['b']));
    await expect(marker(setBacking.storage)).resolves.toBe('idb-blob');
  });

  it('records the OPFS backend when that is where the files go', async () => {
    installOpfsMock();
    const storage = await openStorage(newNames());
    await storage.takes.save(takeInput((await storage.profiles.active()).id, new Blob(['audio'])));
    await expect(marker(storage)).resolves.toBe('opfs');
  });
});

describe('reconcile() only acts on a picture it can trust', () => {
  const ZEROS = { orphanFilesRemoved: 0, danglingTakes: 0, danglingSongs: 0 };

  /** Every file written so far counts as old (an unreferenced file younger than ORPHAN_MIN_AGE_MS is never deleted). */
  function jumpAhead(): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 10 * ORPHAN_MIN_AGE_MS);
  }

  /** A first launch on OPFS that saves two recordings and a song with a backing track, then is closed. */
  async function firstLaunchOnOpfs() {
    const mock = installOpfsMock();
    const names = newNames();
    const first = await openStorage(names);
    const me = await first.profiles.active();
    const take1 = await first.takes.save(takeInput(me.id, new Blob(['one'])));
    const take2 = await first.takes.save(takeInput(me.id, new Blob(['two'])));
    const song = await first.songs.import(me.id, SONG, new Blob(['backing']));
    first.close();
    return { mock, names, take1, take2, song };
  }

  it('a data db that fell back to memory deletes no recording (it used to sweep every real file as an orphan)', async () => {
    const { names, take1, take2, song } = await firstLaunchOnOpfs();
    jumpAhead();
    failIndexedDbOpen(names.dbName); // the data db will not open on this launch
    const degraded = await openStorage(names);
    expect(degraded.db.persistent).toBe(false);
    expect(degraded.opfs.backend).toBe('opfs');

    await expect(degraded.reconcile()).resolves.toEqual({ ...ZEROS, skipped: 'db-not-durable' });
    expect(await degraded.opfs.list()).toHaveLength(3);
    degraded.close();

    vi.restoreAllMocks(); // the next launch is healthy: the real records still point at real files
    const healthy = await openStorage(names);
    expect((await healthy.takes.get(take1.id))?.audioRef).toBe(take1.audioRef);
    expect(await (await healthy.takes.audio(take2))?.text()).toBe('two');
    expect(await (await healthy.opfs.read(song.song.backingRef!))?.text()).toBe('backing');
    await expect(healthy.reconcile()).resolves.toEqual(ZEROS); // and reconcile works as usual again
  });

  it('a storage that is entirely in memory reconciles nothing', async () => {
    vi.stubGlobal('indexedDB', undefined);
    installNoOpfs();
    const storage = await openStorage();
    await storage.takes.save(takeInput((await storage.profiles.active()).id, new Blob(['audio'])));
    jumpAhead();
    const report = await storage.reconcile();
    expect(report.skipped).toBe('db-not-durable');
    expect(await storage.opfs.list()).toHaveLength(1);
  });

  it('an OPFS that stops opening (OPFS -> idb-blob) neither nulls the references nor lets a later launch delete the files', async () => {
    const { mock, names, take1, take2, song } = await firstLaunchOnOpfs();
    jumpAhead();
    installUnreachableOpfs(); // getDirectory() rejects: this launch falls back to IndexedDB blobs
    const flipped = await openStorage(names);
    expect(flipped.opfs.backend).toBe('idb-blob');

    await expect(flipped.reconcile()).resolves.toEqual({ ...ZEROS, skipped: 'backend-changed' });
    expect((await flipped.takes.get(take1.id))?.audioRef).toBe(take1.audioRef);
    expect((await flipped.takes.get(take2.id))?.audioRef).toBe(take2.audioRef);
    expect((await flipped.songs.get(song.id))?.song.backingRef).toBe(song.song.backingRef);
    flipped.close();

    useOpfsMock(mock); // OPFS opens again: nothing was lost
    const back = await openStorage(names);
    expect(back.opfs.backend).toBe('opfs');
    await expect(back.reconcile()).resolves.toEqual(ZEROS);
    expect(await (await back.takes.audio(take2))?.text()).toBe('two');
    expect(await back.opfs.list()).toHaveLength(3);
  });

  it('when the old backend cannot even be detected, reconcile does nothing rather than guess (idb-blob -> OPFS)', async () => {
    installNoOpfs();
    const names = newNames();
    const first = await openStorage(names);
    const take = await first.takes.save(takeInput((await first.profiles.active()).id, new Blob(['recorded on idb'])));
    first.close();
    jumpAhead();

    installOpfsMock();
    vi.spyOn(indexedDB, 'databases').mockRejectedValue(new Error('not supported')); // the old blob database cannot be looked up
    const blind = await openStorage(names);
    expect(blind.opfs.backend).toBe('opfs');
    expect(blind.opfs.backends).toEqual(['opfs']);
    await expect(blind.reconcile()).resolves.toEqual({ ...ZEROS, skipped: 'backend-changed' });
    expect((await blind.takes.get(take.id))?.audioRef).toBe(take.audioRef);
    blind.close();

    vi.restoreAllMocks();
    installNoOpfs(); // back on the old backend, everything is where the record says
    const old = await openStorage(names);
    await expect(old.reconcile()).resolves.toEqual(ZEROS);
    expect(await (await old.takes.audio(take))?.text()).toBe('recorded on idb');
  });
});

describe('a browser that switches binary backend (the old recordings are not stranded)', () => {
  const ZEROS = { orphanFilesRemoved: 0, danglingTakes: 0, danglingSongs: 0 };

  /** A device that recorded on IndexedDB blobs, then gains working OPFS. */
  async function gainOpfs() {
    installNoOpfs();
    const names = newNames();
    const first = await openStorage(names);
    const me = await first.profiles.active();
    const oldTake = await first.takes.save(takeInput(me.id, new Blob(['old recording'])));
    const song = await first.songs.import(me.id, SONG, new Blob(['old backing']));
    await first.opfs.write('takes/orphan-from-the-old-era.wav', new Blob(['debris']));
    first.close();

    const mock = installOpfsMock();
    const storage = await openStorage(names);
    return { names, mock, storage, me, oldTake, song };
  }

  it('idb-blob -> OPFS: the old recording still plays, usage counts it, new recordings go to OPFS', async () => {
    const { mock, storage, me, oldTake, song } = await gainOpfs();
    expect(storage.opfs.backend).toBe('opfs');
    expect((await storage.usage()).binaryBackend).toBe('opfs');
    const stored = (await storage.takes.get(oldTake.id))!;
    expect(await (await storage.takes.audio(stored))?.text()).toBe('old recording');
    expect(await (await storage.opfs.read(song.song.backingRef!))?.text()).toBe('old backing');

    const fresh = await storage.takes.save(takeInput(me.id, new Blob(['new recording'])));
    expect(mock.tree()).toContain(`pitch-lab-bin/${fresh.audioRef}`);
    const bytes = 'old recording'.length + 'old backing'.length + 'debris'.length + 'new recording'.length;
    expect((await storage.usage()).binaryBytes).toBe(bytes);
  });

  it('idb-blob -> OPFS: reconcile removes debris from the old backend but never its referenced files', async () => {
    const { storage, oldTake, song } = await gainOpfs();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 10 * ORPHAN_MIN_AGE_MS);

    await expect(storage.reconcile()).resolves.toEqual({ ...ZEROS, orphanFilesRemoved: 1 });
    expect(await (await storage.takes.audio((await storage.takes.get(oldTake.id))!))?.text()).toBe('old recording');
    expect(await (await storage.opfs.read(song.song.backingRef!))?.text()).toBe('old backing');
    expect(await storage.opfs.list()).toHaveLength(2);
  });

  it('idb-blob -> OPFS: "delete all my data" empties BOTH stores', async () => {
    const { names, mock, storage, me } = await gainOpfs();
    await storage.takes.save(takeInput(me.id, new Blob(['new recording'])));

    await storage.deleteAllData();

    expect(await storage.opfs.list()).toEqual([]);
    expect(mock.tree().filter((path) => path.endsWith('.wav') || path.endsWith('.backing'))).toEqual([]);
    expect((await storage.usage()).binaryBytes).toBe(0);
    storage.close();
    installNoOpfs(); // and nothing is left behind in IndexedDB either
    const idbOnly = await openStorage(names);
    expect(await idbOnly.opfs.list()).toEqual([]);
  });

  it('OPFS -> idb-blob (the write probe fails): the old recording still plays, counts, and deletes', async () => {
    const mock = installOpfsMock();
    const names = newNames();
    const first = await openStorage(names);
    const me = await first.profiles.active();
    const oldTake = await first.takes.save(takeInput(me.id, new Blob(['recorded on opfs'])));
    first.close();

    mock.control.createWritableMissing = true; // the next launch cannot write to OPFS any more
    const storage = await openStorage(names);
    expect(storage.opfs.backend).toBe('idb-blob');
    const stored = (await storage.takes.get(oldTake.id))!;
    expect(await (await storage.takes.audio(stored))?.text()).toBe('recorded on opfs');
    expect((await storage.usage()).binaryBytes).toBe('recorded on opfs'.length);

    await storage.takes.delete(oldTake.id);
    expect(mock.tree().filter((path) => path.endsWith('.wav'))).toEqual([]);
    expect(await storage.takes.get(oldTake.id)).toBeUndefined();
  });

  it('OPFS -> idb-blob: "delete all my data" empties BOTH stores too', async () => {
    const mock = installOpfsMock();
    const names = newNames();
    const first = await openStorage(names);
    const me = await first.profiles.active();
    await first.takes.save(takeInput(me.id, new Blob(['recorded on opfs'])));
    first.close();

    mock.control.createWritableMissing = true;
    const storage = await openStorage(names);
    await storage.takes.save(takeInput(me.id, new Blob(['recorded on idb'])));
    expect(await storage.opfs.list()).toHaveLength(2);

    await storage.deleteAllData();
    expect(await storage.opfs.list()).toEqual([]);
    expect(mock.tree().filter((path) => path.endsWith('.wav'))).toEqual([]);
    storage.close();

    mock.control.createWritableMissing = false; // OPFS works again: nothing is left in either store
    const again = await openStorage(names);
    expect(await again.opfs.list()).toEqual([]);
  });
});

describe('a degraded launch never strands the Phase 1 settings', () => {
  const LEGACY = { schemaVersion: 1, theme: 'dark', referenceVolume: 0.3, vibratoStyle: 'classical' };

  it('(a) data db in memory, settings store real: the legacy key is untouched; the next healthy launch moves it under the real profile', async () => {
    installNoOpfs();
    const names = newNames();
    const kv = await openKV(names.kvDbName);
    await kv.set('profile:default:settings', LEGACY);

    failIndexedDbOpen(names.dbName);
    const degraded = await openStorage(names);
    expect(degraded.db.persistent).toBe(false);
    expect(degraded.migration).toEqual({ ran: false, profile: null, settingsMigrated: false });
    expect(await degraded.kv.get('profile:default:settings')).toEqual(LEGACY);
    expect(await degraded.kv.keys('profile:')).toEqual(['profile:default:settings']); // no copy under a throwaway id
    expect((await degraded.profiles.active()).name).toBe('Me'); // the session still has a profile to work with
    degraded.close();

    vi.restoreAllMocks();
    const healthy = await openStorage(names);
    const me = await healthy.profiles.active();
    expect(healthy.migration).toMatchObject({ ran: true, settingsMigrated: true });
    expect(healthy.migration.profile?.id).toBe(me.id);
    expect(await healthy.kv.get(profileSettingsKey(me.id))).toEqual(LEGACY);
    expect(await healthy.kv.get('profile:default:settings')).toBeUndefined();
    expect(await healthy.kv.keys('profile:')).toEqual([profileSettingsKey(me.id)]);
  });

  it('(b) settings store in memory, data db real: nothing is marked done, and the next healthy launch finishes with the same profile', async () => {
    installNoOpfs();
    const names = newNames();
    const kv = await openKV(names.kvDbName);
    await kv.set('profile:default:settings', LEGACY);

    failIndexedDbOpen(names.kvDbName); // this launch cannot open the settings database
    const degraded = await openStorage(names);
    expect(degraded.kv.persistent).toBe(false);
    expect(degraded.persistent).toBe(false);
    expect(degraded.migration).toMatchObject({ ran: true, settingsMigrated: false, error: 'settings store is not persistent' });
    const me = await degraded.profiles.active();
    degraded.close();

    vi.restoreAllMocks();
    const healthy = await openStorage(names);
    expect(healthy.migration).toMatchObject({ ran: true, settingsMigrated: true });
    expect((await healthy.profiles.active()).id).toBe(me.id);
    expect(await healthy.profiles.list()).toHaveLength(1);
    expect(await healthy.kv.get(profileSettingsKey(me.id))).toEqual(LEGACY);
    expect(await healthy.kv.get('profile:default:settings')).toBeUndefined();

    expect((await openStorage(names)).migration.ran).toBe(false); // a third launch has nothing left to do
  });
});

describe('deleting recordings is verified end to end', () => {
  async function openOnOpfs() {
    const mock = installOpfsMock();
    const storage = await openStorage(newNames());
    const me = await storage.profiles.active();
    return { mock, storage, me };
  }

  it('takes.delete rejects and keeps the take when its audio file will not go; a retry finishes', async () => {
    const { mock, storage, me } = await openOnOpfs();
    const take = await storage.takes.save(takeInput(me.id, new Blob(['voice'])));
    mock.control.onRemove = lockFilesEndingWith('.wav');

    await expect(storage.takes.delete(take.id)).rejects.toThrow(/could not be deleted/);
    expect(await storage.takes.get(take.id)).toBeDefined();
    expect(await storage.opfs.list()).toEqual([take.audioRef]);

    mock.control.onRemove = null;
    await storage.takes.delete(take.id);
    expect(await storage.takes.get(take.id)).toBeUndefined();
    expect(await storage.opfs.list()).toEqual([]);
  });

  it('profiles.delete with removeRecordings reports a recording that would not delete, and keeps the profile for a retry', async () => {
    const { mock, storage, me } = await openOnOpfs();
    await storage.profiles.create({ name: 'Other' });
    const take = await storage.takes.save(takeInput(me.id, new Blob(['voice'])));
    mock.control.onRemove = lockFilesEndingWith('.wav');

    await expect(storage.profiles.delete(me.id, { removeRecordings: true })).rejects.toThrow(/could not be deleted/);
    expect(await storage.profiles.get(me.id)).toBeDefined();

    mock.control.onRemove = null;
    await storage.profiles.delete(me.id, { removeRecordings: true });
    expect(await storage.profiles.get(me.id)).toBeUndefined();
    expect(await storage.opfs.read(take.audioRef!)).toBeUndefined();
  });

  it('deleteAllData rejects - after clearing the rest, leaving a usable profile - when a recording will not delete; reconcile sweeps it later', async () => {
    const { mock, storage, me } = await openOnOpfs();
    await storage.attempts.add(attemptInput(me.id));
    const take = await storage.takes.save(takeInput(me.id, new Blob(['voice'])));
    await storage.kv.set(profileSettingsKey(me.id), { theme: 'dark' });
    mock.control.onRemove = lockFilesEndingWith('.wav');

    await expect(storage.deleteAllData()).rejects.toThrow(/1 recording file\(s\) could not be deleted/);

    expect(await storage.attempts.listByProfile(me.id)).toEqual([]);
    expect(await storage.takes.listByProfile(me.id)).toEqual([]);
    expect(await storage.kv.get(profileSettingsKey(me.id))).toBeUndefined();
    const fresh = await storage.profiles.active(); // the app is never left without a profile
    expect(fresh.id).not.toBe(me.id);
    expect(await storage.opfs.list()).toEqual([take.audioRef]); // the file that would not go

    mock.control.onRemove = null;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 10 * ORPHAN_MIN_AGE_MS);
    await expect(storage.reconcile()).resolves.toMatchObject({ orphanFilesRemoved: 1 });
    expect(await storage.opfs.list()).toEqual([]);
  });
});
