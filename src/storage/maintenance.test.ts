import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Song } from '../song/types';
import { addAttempt } from './attempts-repo';
import { withBackendMarker } from './backend-marker';
import { META_KEYS, openDb } from './db';
import { profileSettingsKey } from './keys';
import { ORPHAN_MIN_AGE_MS, reconcileBinaries, wipeAllData } from './maintenance';
import { migrateFromV1 } from './migrate';
import { openOpfs } from './opfs';
import { createProfile, getActiveProfileId, listProfiles } from './profiles-repo';
import { getSong, importSong } from './songs-repo';
import { deleteTake, getTake, saveTake } from './takes-repo';
import {
  MemoryKV,
  attemptInput,
  emptyTrack,
  freshName,
  installNoOpfs,
  installOpfsMock,
  lockFilesEndingWith,
  openMemoryDb,
  overrideMethod,
  useOpfsMock,
  withPersistent,
} from './test-helpers';

afterEach(() => {
  vi.unstubAllGlobals();
});

async function setup() {
  installNoOpfs();
  const db = await openDb(freshName('maint'));
  const opfs = await openOpfs({ fallbackDbName: freshName('bin') });
  return { db, opfs };
}

const SONG: Song = {
  id: 'song-1',
  title: 'T',
  artist: 'A',
  source: 'midi',
  notes: [],
  phrases: [],
  backingRef: null,
  offsetMs: 0,
  difficulty: { lowestMidi: 48, highestMidi: 60, rangeSemitones: 12, maxLeapSemitones: 4, notesPerSec: 2, melismaRate: 0, longNoteRatio: 0, requiredWorld: 'foundations' },
};

const takeInput = (audio?: Blob) => ({ profileId: 'p1', exerciseId: 'sustain', track: emptyTrack(), sampleRate: 48000, latencyMs: 0, audio });
/** A "now" far enough ahead that every file counts as old. */
const LATER = Date.now() + 10 * ORPHAN_MIN_AGE_MS;

describe('reconcileBinaries', () => {
  it('does nothing when records and binaries already agree', async () => {
    const { db, opfs } = await setup();
    const take = await saveTake(db, opfs, takeInput(new Blob(['audio'])));
    const song = await importSong(db, opfs, 'p1', SONG, new Blob(['backing']));
    await expect(reconcileBinaries(db, opfs, { now: LATER })).resolves.toEqual({ orphanFilesRemoved: 0, danglingTakes: 0, danglingSongs: 0 });
    await expect(getTake(db, take.id)).resolves.toMatchObject({ audioRef: take.audioRef });
    await expect(getSong(db, song.id)).resolves.toMatchObject({ song: { backingRef: song.song.backingRef } });
  });

  it('deletes a file no record references (a crash between the binary write and the record write)', async () => {
    const { db, opfs } = await setup();
    const kept = await saveTake(db, opfs, takeInput(new Blob(['keep'])));
    await opfs.write('takes/orphan.wav', new Blob(['lost']));
    await opfs.write('songs/orphan.backing', new Blob(['lost too']));

    const report = await reconcileBinaries(db, opfs, { now: LATER });
    expect(report.orphanFilesRemoved).toBe(2);
    expect(await opfs.list()).toEqual([kept.audioRef]);
  });

  it('leaves a recent unreferenced file alone: it may belong to a save still in flight', async () => {
    const { db, opfs } = await setup();
    await opfs.write('takes/in-flight.wav', new Blob(['being saved right now']));
    const report = await reconcileBinaries(db, opfs); // real "now": the file is only milliseconds old
    expect(report.orphanFilesRemoved).toBe(0);
    expect(await opfs.list()).toEqual(['takes/in-flight.wav']);
  });

  it('honours a custom minimum age', async () => {
    const { db, opfs } = await setup();
    await opfs.write('takes/young.wav', new Blob(['x']));
    expect((await reconcileBinaries(db, opfs, { minAgeMs: 0, now: Date.now() + 1 })).orphanFilesRemoved).toBe(1);
  });

  it('clears the reference of a take whose audio is gone (the browser evicted it), keeping the take and its track', async () => {
    const { db, opfs } = await setup();
    const take = await saveTake(db, opfs, takeInput(new Blob(['audio'])));
    await opfs.delete(take.audioRef!);

    const report = await reconcileBinaries(db, opfs, { now: LATER });
    expect(report.danglingTakes).toBe(1);
    await expect(getTake(db, take.id)).resolves.toMatchObject({ audioRef: null, track: take.track, exerciseId: 'sustain' });
  });

  it('clears the reference of a song whose backing track is gone', async () => {
    const { db, opfs } = await setup();
    const song = await importSong(db, opfs, 'p1', SONG, new Blob(['backing']));
    await opfs.delete(song.song.backingRef!);

    const report = await reconcileBinaries(db, opfs, { now: LATER });
    expect(report.danglingSongs).toBe(1);
    const after = (await getSong(db, song.id))!;
    expect(after.song.backingRef).toBeNull();
    expect(after.song.title).toBe('T');
  });

  it('handles several problems at once', async () => {
    const { db, opfs } = await setup();
    const lostAudio = await saveTake(db, opfs, takeInput(new Blob(['a'])));
    const fine = await saveTake(db, opfs, takeInput(new Blob(['b'])));
    await opfs.delete(lostAudio.audioRef!);
    await opfs.write('takes/orphan.wav', new Blob(['o']));
    const report = await reconcileBinaries(db, opfs, { now: LATER });
    expect(report).toEqual({ orphanFilesRemoved: 1, danglingTakes: 1, danglingSongs: 0 });
    expect(await opfs.list()).toEqual([fine.audioRef]);
  });

  it('a take saved while the reconcile is running keeps its audio reference (records are read before files are listed)', async () => {
    const { db, opfs } = await setup();
    const racing = overrideMethod(opfs, 'list', async (prefix?: string) => {
      // the save completes after the records were read but before the files are listed
      await saveTake(db, opfs, takeInput(new Blob(['saved mid-reconcile'])));
      return opfs.list(prefix);
    });
    const report = await reconcileBinaries(db, racing); // real "now": the fresh file is young, so it is protected
    expect(report).toEqual({ orphanFilesRemoved: 0, danglingTakes: 0, danglingSongs: 0 });
    const [take] = await db.store<{ id: string; audioRef: string | null }>('takes').getAll();
    expect(take.audioRef).not.toBeNull();
    expect(await opfs.list()).toEqual([take.audioRef]);
  });

  it('a take evicted while the reconcile is running is not counted, and nothing is written for it', async () => {
    const { db, opfs } = await setup();
    const victim = await saveTake(db, opfs, takeInput(new Blob(['about to be evicted'])));
    const racing = overrideMethod(opfs, 'list', async (prefix?: string) => {
      await deleteTake(db, opfs, victim.id); // retention removes it after the records were read
      return opfs.list(prefix);
    });
    const report = await reconcileBinaries(db, racing, { now: LATER });
    expect(report).toEqual({ orphanFilesRemoved: 0, danglingTakes: 0, danglingSongs: 0 });
    await expect(getTake(db, victim.id)).resolves.toBeUndefined();
  });

  it('changes nothing - and does not clear a single reference - if the binary store cannot even be listed', async () => {
    const { db, opfs: real } = await setup();
    const take = await saveTake(db, real, takeInput(new Blob(['audio'])));
    const flaky = overrideMethod(real, 'list', async () => {
      throw new Error('OPFS hiccup');
    });
    await expect(reconcileBinaries(db, flaky, { now: LATER })).rejects.toThrow('OPFS hiccup');
    await expect(getTake(db, take.id)).resolves.toMatchObject({ audioRef: take.audioRef });
    expect(await real.list()).toEqual([take.audioRef]);
  });
});

describe('reconcileBinaries only acts on a picture it can trust', () => {
  const ZEROS = { orphanFilesRemoved: 0, danglingTakes: 0, danglingSongs: 0 };

  /** Two recordings and a song with a backing track on IndexedDB blobs, written the way the app writes them (through the marker). */
  async function withSavedFiles() {
    installNoOpfs();
    const db = await openDb(freshName('maint'));
    const binDbName = freshName('bin');
    const opfs = await openOpfs({ fallbackDbName: binDbName });
    const marked = withBackendMarker(db, opfs);
    const t1 = await saveTake(db, marked, takeInput(new Blob(['one'])));
    const t2 = await saveTake(db, marked, takeInput(new Blob(['two'])));
    const song = await importSong(db, marked, 'p1', SONG, new Blob(['backing']));
    return { db, binDbName, opfs, marked, t1, t2, song };
  }

  type Saved = Awaited<ReturnType<typeof withSavedFiles>>;

  /** Nothing was deleted and no reference was cleared. */
  async function expectIntact(saved: Pick<Saved, 'db' | 't1' | 't2' | 'song'>, store: { list(): Promise<string[]> }, files = 3) {
    expect(await store.list()).toHaveLength(files);
    await expect(getTake(saved.db, saved.t1.id)).resolves.toMatchObject({ audioRef: saved.t1.audioRef });
    await expect(getTake(saved.db, saved.t2.id)).resolves.toMatchObject({ audioRef: saved.t2.audioRef });
    await expect(getSong(saved.db, saved.song.id)).resolves.toMatchObject({ song: { backingRef: saved.song.song.backingRef } });
  }

  it('does nothing when the data db fell back to memory: the files are real, the records are not there', async () => {
    const saved = await withSavedFiles();
    const memory = await openMemoryDb();
    expect(memory.persistent).toBe(false);
    await expect(reconcileBinaries(memory, saved.opfs, { now: LATER })).resolves.toEqual({ ...ZEROS, skipped: 'db-not-durable' });
    await expectIntact(saved, saved.opfs);
  });

  it('does nothing when the binary store is memory: the records are real, the files are not there', async () => {
    const saved = await withSavedFiles();
    await expect(reconcileBinaries(saved.db, withPersistent(saved.opfs, false), { now: LATER })).resolves.toEqual({
      ...ZEROS,
      skipped: 'binaries-not-durable',
    });
    await expectIntact(saved, saved.opfs);
  });

  it('does nothing when files went to a backend this launch cannot read, and a later launch that can read it reconciles normally', async () => {
    const saved = await withSavedFiles(); // marker: idb-blob
    installOpfsMock();
    const blind = await openOpfs({ fallbackDbName: freshName('other-bin') }); // OPFS, and the old blobs are out of sight
    expect(blind.backends).toEqual(['opfs']);

    await expect(reconcileBinaries(saved.db, blind, { now: LATER })).resolves.toEqual({ ...ZEROS, skipped: 'backend-changed' });
    await expectIntact(saved, saved.opfs); // no reference was cleared, and nothing was deleted from the old backend

    installNoOpfs(); // the next launch sees the real files again
    const healthy = await openOpfs({ fallbackDbName: saved.binDbName });
    await healthy.write('takes/orphan.wav', new Blob(['debris']));
    await expect(reconcileBinaries(saved.db, healthy, { now: LATER })).resolves.toEqual({ ...ZEROS, orphanFilesRemoved: 1 });
    await expectIntact(saved, healthy);
  });

  it('the same goes for the other direction: files in OPFS, a launch that only has IndexedDB', async () => {
    const mock = installOpfsMock();
    const db = await openDb(freshName('maint'));
    const opfs = withBackendMarker(db, await openOpfs({ fallbackDbName: freshName('bin') }));
    const take = await saveTake(db, opfs, takeInput(new Blob(['in opfs'])));
    expect(opfs.backend).toBe('opfs');

    installNoOpfs(); // the OPFS open fails: this launch falls back to IndexedDB blobs and cannot see the file
    const blind = await openOpfs({ fallbackDbName: freshName('bin') });
    expect(blind.backend).toBe('idb-blob');
    await expect(reconcileBinaries(db, blind, { now: LATER })).resolves.toEqual({ ...ZEROS, skipped: 'backend-changed' });
    await expect(getTake(db, take.id)).resolves.toMatchObject({ audioRef: take.audioRef });

    useOpfsMock(mock); // OPFS is back: the file was never lost
    const healthy = await openOpfs({ fallbackDbName: freshName('bin') });
    await expect(reconcileBinaries(db, healthy, { now: LATER })).resolves.toEqual(ZEROS);
    expect(await (await healthy.read(take.audioRef!))?.text()).toBe('in opfs');
  });

  it('a switch that left the old files readable (the store covers both) reconciles across both, never judging by one', async () => {
    const saved = await withSavedFiles(); // idb-blob era: marker idb-blob
    await saved.opfs.write('songs/old-orphan.backing', new Blob(['debris from the old era']));
    installOpfsMock(); // Safari gains OPFS: the store now covers both backends
    const both = await openOpfs({ fallbackDbName: saved.binDbName });
    expect(both.backends).toEqual(['opfs', 'idb-blob']);

    await expect(reconcileBinaries(saved.db, both, { now: LATER })).resolves.toEqual({ ...ZEROS, orphanFilesRemoved: 1 });
    await expectIntact(saved, both); // the referenced files in the OLD backend are not "missing"
  });

  it('an unrecognisable marker means do nothing: when in doubt, change nothing', async () => {
    const saved = await withSavedFiles();
    for (const odd of [42, { opfs: true }, 'sqlite-wasm', 'idb-blob,sqlite-wasm']) {
      await saved.db.store('meta').put(odd, META_KEYS.binaryBackend);
      await expect(reconcileBinaries(saved.db, saved.opfs, { now: LATER })).resolves.toEqual({ ...ZEROS, skipped: 'backend-changed' });
    }
    await expectIntact(saved, saved.opfs);
  });

  it('works as before when nothing was ever recorded (no marker yet), and when the marker names exactly what it can read', async () => {
    const { db, opfs } = await setup();
    await expect(reconcileBinaries(db, opfs, { now: LATER })).resolves.toEqual(ZEROS);
    await db.store('meta').put('idb-blob', META_KEYS.binaryBackend);
    await expect(reconcileBinaries(db, opfs, { now: LATER })).resolves.toEqual(ZEROS);
  });

  it('the happy-path report has no `skipped` field at all', async () => {
    const saved = await withSavedFiles();
    const report = await reconcileBinaries(saved.db, saved.opfs, { now: LATER });
    expect(report).toEqual(ZEROS);
    expect('skipped' in report).toBe(false);
  });
});

describe('reconcileBinaries and files that refuse to go', () => {
  it('counts an orphan only when it is really gone, and one stubborn file does not stop the pass', async () => {
    const mock = installOpfsMock();
    const db = await openDb(freshName('maint'));
    const opfs = await openOpfs();
    await opfs.write('takes/a-stuck.wav', new Blob(['locked']));
    await opfs.write('takes/b-free.wav', new Blob(['free']));
    await opfs.write('takes/c-free.wav', new Blob(['free too']));
    mock.control.onRemove = lockFilesEndingWith('a-stuck.wav');

    const report = await reconcileBinaries(db, opfs, { now: LATER });
    expect(report.orphanFilesRemoved).toBe(2);
    expect(await opfs.list()).toEqual(['takes/a-stuck.wav']);

    mock.control.onRemove = null; // the lock clears: the next pass finishes the job
    expect((await reconcileBinaries(db, opfs, { now: LATER })).orphanFilesRemoved).toBe(1);
    expect(await opfs.list()).toEqual([]);
  });

  it('a stat or delete that throws for one orphan is skipped, not fatal', async () => {
    const { db, opfs: real } = await setup();
    await real.write('takes/bad.wav', new Blob(['x']));
    await real.write('takes/good.wav', new Blob(['y']));
    const flaky = overrideMethod(real, 'stat', async (path: string) => {
      if (path === 'takes/bad.wav') throw new Error('stat hiccup');
      return real.stat(path);
    });
    const report = await reconcileBinaries(db, flaky, { now: LATER });
    expect(report.orphanFilesRemoved).toBe(1);
    expect(await real.list()).toEqual(['takes/bad.wav']);
  });
});

describe('wipeAllData', () => {
  it('deletes every profile, attempt, take, song, binary and per-profile setting', async () => {
    const { db, opfs } = await setup();
    const kv = new MemoryKV();
    const profile = await createProfile(db, { name: 'Tenor' });
    await addAttempt(db, attemptInput(profile.id));
    await saveTake(db, opfs, takeInput(new Blob(['audio'])));
    await importSong(db, opfs, profile.id, SONG, new Blob(['backing']));
    await kv.set(profileSettingsKey(profile.id), { theme: 'dark' });
    await kv.set('profile:default:settings', { theme: 'light' });

    await wipeAllData(db, opfs, kv);

    for (const store of ['profiles', 'attempts', 'takes', 'songs'] as const) await expect(db.store(store).count()).resolves.toBe(0);
    expect(await opfs.list()).toEqual([]);
    expect(await kv.keys('profile:')).toEqual([]);
    await expect(getActiveProfileId(db)).resolves.toBeUndefined();
  });

  it('keeps what describes the device, not the singers', async () => {
    const { db, opfs } = await setup();
    const kv = new MemoryKV();
    await kv.set('device:settings', { route: 'wired' });
    await createProfile(db, { name: 'T' });
    await addAttempt(db, attemptInput('p'));
    const deviceId = await db.store('meta').get(META_KEYS.deviceId);
    const clock = await db.store('meta').get(META_KEYS.hlcState);
    const version = await db.store('meta').get(META_KEYS.schemaVersion);

    await wipeAllData(db, opfs, kv);

    expect(await kv.get('device:settings')).toEqual({ route: 'wired' });
    await expect(db.store('meta').get(META_KEYS.deviceId)).resolves.toBe(deviceId);
    await expect(db.store('meta').get(META_KEYS.hlcState)).resolves.toEqual(clock);
    await expect(db.store('meta').get(META_KEYS.schemaVersion)).resolves.toBe(version);
  });

  it('works without a KV store, and on an already empty database', async () => {
    const { db, opfs } = await setup();
    await expect(wipeAllData(db, opfs)).resolves.toBeUndefined();
    await expect(wipeAllData(db, opfs)).resolves.toBeUndefined();
  });

  it('after a wipe, the next launch migrates to a fresh default profile as on a first run', async () => {
    const { db, opfs } = await setup();
    const kv = new MemoryKV();
    const first = (await migrateFromV1(db, kv)).profile!;
    await wipeAllData(db, opfs, kv);
    const again = await migrateFromV1(db, kv);
    expect(again.ran).toBe(true);
    expect(again.profile?.name).toBe('Me');
    expect(again.profile?.id).not.toBe(first.id);
    expect(await listProfiles(db, { includeDeleted: true })).toHaveLength(1);
  });

  it('deletes the binaries FIRST (the audio is the sensitive part), then the records', async () => {
    const { db, opfs } = await setup();
    await saveTake(db, opfs, takeInput(new Blob(['audio'])));
    await importSong(db, opfs, 'p1', SONG, new Blob(['backing']));
    const order: string[] = [];
    const watchedDb = overrideMethod(db, 'store', (name: string) => {
      const store = db.store(name as never);
      return overrideMethod(store, 'clear', async () => {
        order.push(`clear:${name}`);
        return store.clear();
      });
    });
    const watchedOpfs = overrideMethod(opfs, 'delete', async (path: string) => {
      order.push('delete');
      return opfs.delete(path);
    });

    await wipeAllData(watchedDb, watchedOpfs);

    expect(order.filter((step) => step === 'delete')).toHaveLength(2);
    expect(order.findIndex((step) => step.startsWith('clear:'))).toBeGreaterThan(order.lastIndexOf('delete'));
  });

  it('rejects - after clearing everything else - when a recording will not delete, so "all deleted" is never reported falsely', async () => {
    const mock = installOpfsMock();
    const db = await openDb(freshName('maint'));
    const opfs = await openOpfs();
    const kv = new MemoryKV();
    const profile = await createProfile(db, { name: 'Tenor' });
    await addAttempt(db, attemptInput(profile.id));
    const take = await saveTake(db, opfs, takeInput(new Blob(['voice'])));
    await kv.set(profileSettingsKey(profile.id), { theme: 'dark' });
    mock.control.onRemove = lockFilesEndingWith('.wav');

    await expect(wipeAllData(db, opfs, kv)).rejects.toThrow(/1 recording file\(s\) could not be deleted/);

    for (const store of ['profiles', 'attempts', 'takes', 'songs'] as const) await expect(db.store(store).count()).resolves.toBe(0);
    expect(await kv.keys('profile:')).toEqual([]);
    expect(await opfs.list()).toEqual([take.audioRef]); // the one file that would not go

    mock.control.onRemove = null; // the lock clears: it has no record now, so reconcile sweeps it
    await expect(reconcileBinaries(db, opfs, { now: LATER })).resolves.toMatchObject({ orphanFilesRemoved: 1 });
    expect(await opfs.list()).toEqual([]);
  });

  it('still clears the records, and rejects, when the recordings cannot even be listed', async () => {
    const { db, opfs: real } = await setup();
    await saveTake(db, real, takeInput(new Blob(['voice'])));
    const unlistable = overrideMethod(real, 'list', async () => {
      throw new Error('OPFS hiccup');
    });
    await expect(wipeAllData(db, unlistable)).rejects.toThrow(/could not list the recordings: OPFS hiccup/);
    await expect(db.store('takes').count()).resolves.toBe(0);
    expect(await real.list()).toHaveLength(1); // reported, not hidden
  });

  it('keeps going past one file that fails to delete, and past a failing settings store, reporting both', async () => {
    const { db, opfs: real } = await setup();
    await saveTake(db, real, takeInput(new Blob(['a'])));
    await saveTake(db, real, takeInput(new Blob(['b'])));
    const kv = new MemoryKV();
    await kv.set(profileSettingsKey('p1'), { theme: 'dark' });
    kv.failing.add('delete');
    let calls = 0;
    const throwing = overrideMethod(real, 'delete', async (path: string) => {
      calls += 1;
      if (calls === 1) throw new Error('idb hiccup');
      return real.delete(path);
    });
    const error = await wipeAllData(db, throwing, kv).then(
      () => null,
      (err: Error) => err,
    );
    expect(error?.message).toMatch(/1 recording file\(s\) could not be deleted/);
    expect(error?.message).toMatch(/could not clear the settings: kv delete failed/);
    expect(calls).toBe(2); // the second file was still attempted
    expect(await real.list()).toHaveLength(1);
    await expect(db.store('takes').count()).resolves.toBe(0);
  });

  it('clears the backend marker with the records it protected, and the next file is marked again (no stale session cache)', async () => {
    const { db, opfs: real } = await setup();
    const opfs = withBackendMarker(db, real);
    await saveTake(db, opfs, takeInput(new Blob(['a'])));
    await expect(db.store('meta').get(META_KEYS.binaryBackend)).resolves.toBe('idb-blob');
    await wipeAllData(db, opfs);
    await expect(db.store('meta').get(META_KEYS.binaryBackend)).resolves.toBeUndefined();
    await saveTake(db, opfs, takeInput(new Blob(['b'])));
    await expect(db.store('meta').get(META_KEYS.binaryBackend)).resolves.toBe('idb-blob');
  });

  it('reaches recordings that were left in the other backend by a switch', async () => {
    installNoOpfs();
    const db = await openDb(freshName('maint'));
    const binDbName = freshName('bin');
    const oldEra = withBackendMarker(db, await openOpfs({ fallbackDbName: binDbName }));
    await saveTake(db, oldEra, takeInput(new Blob(['recorded before the switch'])));

    const mock = installOpfsMock(); // the browser now offers OPFS
    const both = withBackendMarker(db, await openOpfs({ fallbackDbName: binDbName }));
    await saveTake(db, both, takeInput(new Blob(['recorded after'])));
    expect(await both.list()).toHaveLength(2);

    await wipeAllData(db, both);

    expect(await both.list()).toEqual([]);
    expect(mock.tree().filter((path) => path.endsWith('.wav'))).toEqual([]);
    installNoOpfs(); // and nothing is left behind in IndexedDB either
    expect(await (await openOpfs({ fallbackDbName: binDbName })).list()).toEqual([]);
  });
});
