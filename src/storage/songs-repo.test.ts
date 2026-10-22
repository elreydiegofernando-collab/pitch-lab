import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Song } from '../song/types';
import { openDb } from './db';
import { openOpfs } from './opfs';
import type { SongRecord } from './schema';
import {
  deleteSong,
  findSongByContentId,
  getSong,
  importSong,
  listSongsByProfile,
  setSongBacking,
  songBackingPath,
  updateSongOffset,
} from './songs-repo';
import { FlakyOpfs, freshName, installNoOpfs, installOpfsMock, lockFilesEndingWith, quotaError } from './test-helpers';

afterEach(() => {
  vi.unstubAllGlobals();
});

async function setup() {
  installNoOpfs();
  const db = await openDb(freshName('songs'));
  const opfs = await openOpfs({ fallbackDbName: freshName('bin') });
  return { db, opfs };
}

function song(overrides: Partial<Song> = {}): Song {
  return {
    id: 'song-slug',
    title: 'Example Song',
    artist: 'Traditional',
    source: 'ultrastar',
    notes: [{ start: 0, duration: 1, midi: 60, lyric: 'la', type: 'normal' }],
    phrases: [{ start: 0, end: 1, from: 0, to: 1 }],
    backingRef: null,
    offsetMs: 0,
    difficulty: {
      lowestMidi: 48,
      highestMidi: 60,
      rangeSemitones: 12,
      maxLeapSemitones: 5,
      notesPerSec: 2,
      melismaRate: 0,
      longNoteRatio: 0.2,
      requiredWorld: 'foundations',
    },
    ...overrides,
  };
}

describe('importSong', () => {
  it('imports a song with no backing track', async () => {
    const { db, opfs } = await setup();
    const record = await importSong(db, opfs, 'p1', song());
    expect(record.song.title).toBe('Example Song');
    expect(record.song.backingRef).toBeNull();
    expect(record.profileId).toBe('p1');
    expect(record.deletedAt).toBeNull();
    await expect(getSong(db, record.id)).resolves.toEqual(record);
    expect(await opfs.list()).toEqual([]);
  });

  it('writes a given backing track to the binary store and points song.backingRef at it', async () => {
    const { db, opfs } = await setup();
    const record = await importSong(db, opfs, 'p1', song(), new Blob(['backing-bytes']));
    expect(record.song.backingRef).toBe(songBackingPath(record.id));
    expect(record.song.backingRef).toBe(`songs/${record.id}.backing`);
    expect(await (await opfs.read(record.song.backingRef!))?.text()).toBe('backing-bytes');
  });

  it('ignores a backingRef on the input: the repo owns that path, and a caller-supplied one could dangle', async () => {
    const { db, opfs } = await setup();
    const record = await importSong(db, opfs, 'p1', song({ backingRef: 'songs/somewhere-else.backing' }));
    expect(record.song.backingRef).toBeNull();
  });

  it.each([
    ['null', null],
    ['no id', { title: 'x', notes: [] }],
    ['an empty id', { id: '', title: 'x', notes: [] }],
    ['no notes array', { id: 'a', title: 'x' }],
  ])('rejects %s as a song, storing nothing', async (_label, bad) => {
    const { db, opfs } = await setup();
    await expect(importSong(db, opfs, 'p1', bad as unknown as Song)).rejects.toThrow(TypeError);
    await expect(importSong(db, opfs, '', song())).rejects.toThrow(TypeError);
    await expect(db.store('songs').count()).resolves.toBe(0);
  });

  it('is an upsert on (profile, song id): re-importing refreshes the one record instead of duplicating it', async () => {
    const { db, opfs } = await setup();
    const first = await importSong(db, opfs, 'p1', song({ title: 'Old Title' }));
    const second = await importSong(db, opfs, 'p1', song({ title: 'New Title', notes: [] }));
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt > first.updatedAt).toBe(true);
    expect(second.song.title).toBe('New Title');
    expect(second.song.notes).toEqual([]);
    expect(await listSongsByProfile(db, 'p1')).toHaveLength(1);
  });

  it('keeps the offset the singer calibrated, and the backing track, when the same song is imported again', async () => {
    const { db, opfs } = await setup();
    const first = await importSong(db, opfs, 'p1', song(), new Blob(['backing']));
    await updateSongOffset(db, first.id, 125);
    const again = await importSong(db, opfs, 'p1', song({ offsetMs: 0 }));
    expect(again.song.offsetMs).toBe(125);
    expect(again.song.backingRef).toBe(first.song.backingRef);
    expect(await (await opfs.read(again.song.backingRef!))?.text()).toBe('backing');
  });

  it('replaces the backing track in place when a new one is supplied on re-import', async () => {
    const { db, opfs } = await setup();
    const first = await importSong(db, opfs, 'p1', song(), new Blob(['v1']));
    const again = await importSong(db, opfs, 'p1', song(), new Blob(['version two']));
    expect(again.song.backingRef).toBe(first.song.backingRef);
    expect(await (await opfs.read(again.song.backingRef!))?.text()).toBe('version two');
    expect(await opfs.list()).toEqual([first.song.backingRef]);
  });

  it('keeps separate records per profile and per song id', async () => {
    const { db, opfs } = await setup();
    await importSong(db, opfs, 'p1', song({ id: 'a' }));
    await importSong(db, opfs, 'p2', song({ id: 'a' }));
    await importSong(db, opfs, 'p1', song({ id: 'b' }));
    expect(await listSongsByProfile(db, 'p1')).toHaveLength(2);
    expect(await listSongsByProfile(db, 'p2')).toHaveLength(1);
  });

  it('a double tap (concurrent imports of one song) still yields exactly one record', async () => {
    const { db, opfs } = await setup();
    const records = await Promise.all([importSong(db, opfs, 'p1', song()), importSong(db, opfs, 'p1', song()), importSong(db, opfs, 'p1', song())]);
    expect(new Set(records.map((r) => r.id)).size).toBe(1);
    expect(await listSongsByProfile(db, 'p1')).toHaveLength(1);
  });

  it('a backing track that cannot be stored rejects the import, storing no record and no orphan', async () => {
    const { db, opfs: real } = await setup();
    const opfs = new FlakyOpfs(real, [quotaError()]);
    await expect(importSong(db, opfs, 'p1', song(), new Blob(['too big']))).rejects.toMatchObject({ name: 'QuotaExceededError' });
    await expect(db.store('songs').count()).resolves.toBe(0);
    expect(await real.list()).toEqual([]);
    // and the queue is not wedged by the failure
    await expect(importSong(db, opfs, 'p1', song())).resolves.toBeDefined();
  });

  it('ignores a zero-length backing track', async () => {
    const { db, opfs } = await setup();
    const record = await importSong(db, opfs, 'p1', song(), new Blob([]));
    expect(record.song.backingRef).toBeNull();
    expect(await opfs.list()).toEqual([]);
  });
});

describe('lookup and listing', () => {
  it('findSongByContentId finds a profile\'s record by the song id', async () => {
    const { db, opfs } = await setup();
    const record = await importSong(db, opfs, 'p1', song({ id: 'hash-1' }));
    await expect(findSongByContentId(db, 'p1', 'hash-1')).resolves.toEqual(record);
    await expect(findSongByContentId(db, 'p2', 'hash-1')).resolves.toBeUndefined();
    await expect(findSongByContentId(db, 'p1', 'other')).resolves.toBeUndefined();
  });

  it('scopes to the profile and sorts alphabetically by title, ignoring case', async () => {
    const { db, opfs } = await setup();
    await importSong(db, opfs, 'p1', song({ id: 's1', title: 'zebra song' }));
    await importSong(db, opfs, 'p1', song({ id: 's2', title: 'Apple Song' }));
    await importSong(db, opfs, 'p1', song({ id: 's3', title: 'banana song' }));
    await importSong(db, opfs, 'p2', song({ id: 's4', title: 'Other Profile Song' }));
    expect((await listSongsByProfile(db, 'p1')).map((r) => r.song.title)).toEqual(['Apple Song', 'banana song', 'zebra song']);
  });

  it('hides tombstoned rows (none are written locally, but a merge may bring some)', async () => {
    const { db, opfs } = await setup();
    const record = await importSong(db, opfs, 'p1', song());
    await db.store<SongRecord>('songs').put({ ...record, deletedAt: '2026-01-01T00:00:00.000Z' }, record.id);
    await expect(getSong(db, record.id)).resolves.toBeUndefined();
    await expect(listSongsByProfile(db, 'p1')).resolves.toEqual([]);
    await expect(findSongByContentId(db, 'p1', record.song.id)).resolves.toBeUndefined();
    await expect(updateSongOffset(db, record.id, 5)).rejects.toThrow(/no such song/);
  });
});

describe('updateSongOffset', () => {
  it('updates only the offset, leaving the rest of the song intact', async () => {
    const { db, opfs } = await setup();
    const record = await importSong(db, opfs, 'p1', song());
    const updated = await updateSongOffset(db, record.id, 125);
    expect(updated.song.offsetMs).toBe(125);
    expect(updated.song.title).toBe(record.song.title);
    expect(updated.song.notes).toEqual(record.song.notes);
    expect(updated.updatedAt > record.updatedAt).toBe(true);
    await updateSongOffset(db, record.id, -40);
    expect((await getSong(db, record.id))?.song.offsetMs).toBe(-40);
  });

  it('rejects a song that does not exist, and a non-finite offset', async () => {
    const { db, opfs } = await setup();
    await expect(updateSongOffset(db, 'nope', 10)).rejects.toThrow(/no such song/);
    const record = await importSong(db, opfs, 'p1', song());
    await expect(updateSongOffset(db, record.id, NaN)).rejects.toThrow(TypeError);
    await expect(updateSongOffset(db, record.id, '5' as unknown as number)).rejects.toThrow(TypeError);
  });
});

describe('setSongBacking', () => {
  it('adds, replaces and removes a backing track', async () => {
    const { db, opfs } = await setup();
    const record = await importSong(db, opfs, 'p1', song());

    const added = await setSongBacking(db, opfs, record.id, new Blob(['one']));
    expect(added.song.backingRef).toBe(songBackingPath(record.id));
    expect(await (await opfs.read(added.song.backingRef!))?.text()).toBe('one');

    const replaced = await setSongBacking(db, opfs, record.id, new Uint8Array([1, 2, 3, 4]));
    expect((await opfs.read(replaced.song.backingRef!))?.size).toBe(4);
    expect(await opfs.list()).toEqual([songBackingPath(record.id)]);

    const removed = await setSongBacking(db, opfs, record.id, null);
    expect(removed.song.backingRef).toBeNull();
    expect(await opfs.list()).toEqual([]);
    expect((await getSong(db, record.id))?.song.backingRef).toBeNull();
  });

  it('treats a zero-length track as removal, and rejects a missing song', async () => {
    const { db, opfs } = await setup();
    const record = await importSong(db, opfs, 'p1', song(), new Blob(['x']));
    expect((await setSongBacking(db, opfs, record.id, new Blob([]))).song.backingRef).toBeNull();
    expect(await opfs.list()).toEqual([]);
    await expect(setSongBacking(db, opfs, 'nope', new Blob(['x']))).rejects.toThrow(/no such song/);
  });
});

describe('deleteSong', () => {
  it('removes the backing-track binary (if any) and the record', async () => {
    const { db, opfs } = await setup();
    const record = await importSong(db, opfs, 'p1', song(), new Blob(['bytes']));
    await deleteSong(db, opfs, record.id);
    await expect(getSong(db, record.id)).resolves.toBeUndefined();
    await expect(opfs.read(record.song.backingRef!)).resolves.toBeUndefined();
  });

  it('deleting a song with no backing track, or none at all, is harmless', async () => {
    const { db, opfs } = await setup();
    const keeper = await importSong(db, opfs, 'p1', song({ id: 'keep' }), new Blob(['stay']));
    const record = await importSong(db, opfs, 'p1', song({ id: 'drop' }));
    await expect(deleteSong(db, opfs, record.id)).resolves.toBeUndefined();
    await expect(deleteSong(db, opfs, 'never-existed')).resolves.toBeUndefined();
    await expect(opfs.read(keeper.song.backingRef!)).resolves.toBeDefined();
  });

  it('after a delete, the same song can be imported again as a fresh record', async () => {
    const { db, opfs } = await setup();
    const first = await importSong(db, opfs, 'p1', song());
    await deleteSong(db, opfs, first.id);
    const again = await importSong(db, opfs, 'p1', song());
    expect(again.id).not.toBe(first.id);
    expect(again.song.offsetMs).toBe(0);
  });
});

describe('removing a backing track is verified', () => {
  async function setupOpfs() {
    const mock = installOpfsMock();
    const db = await openDb(freshName('songs'));
    const opfs = await openOpfs({ fallbackDbName: freshName('bin') });
    return { mock, db, opfs };
  }

  it('deleteSong rejects, keeping the record, when the backing file will not go - and a retry finishes the job', async () => {
    const { mock, db, opfs } = await setupOpfs();
    const record = await importSong(db, opfs, 'p1', song(), new Blob(['backing']));
    mock.control.onRemove = lockFilesEndingWith('.backing');

    await expect(deleteSong(db, opfs, record.id)).rejects.toThrow(/could not be deleted/);
    await expect(getSong(db, record.id)).resolves.toMatchObject({ song: { backingRef: record.song.backingRef } });
    expect(await opfs.list()).toEqual([record.song.backingRef]);

    mock.control.onRemove = null;
    await deleteSong(db, opfs, record.id);
    await expect(getSong(db, record.id)).resolves.toBeUndefined();
    expect(await opfs.list()).toEqual([]);
  });

  it('removing the backing track rejects with the reference intact when the file will not go, rather than leaving a silent orphan', async () => {
    const { mock, db, opfs } = await setupOpfs();
    const record = await importSong(db, opfs, 'p1', song(), new Blob(['backing']));
    mock.control.onRemove = lockFilesEndingWith('.backing');

    await expect(setSongBacking(db, opfs, record.id, null)).rejects.toThrow(/could not be deleted/);
    expect((await getSong(db, record.id))?.song.backingRef).toBe(record.song.backingRef);

    mock.control.onRemove = null;
    expect((await setSongBacking(db, opfs, record.id, null)).song.backingRef).toBeNull();
    expect(await opfs.list()).toEqual([]);
  });
});
