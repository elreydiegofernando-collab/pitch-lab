import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DATABASE_LOOKUP_TIMEOUT_MS, OPFS_MANIFEST_VERSION, OPFS_ROOT_DIR, OPFS_STALE_TEMP_MS, deleteConfirmed, openOpfs, type OpfsStore } from './opfs';
import {
  failIndexedDbOpen,
  freshName,
  installNoOpfs,
  installOpfsMock,
  installUnreachableOpfs,
  lockFilesEndingWith,
  overrideMethod,
  quotaError,
  useOpfsMock,
} from './test-helpers';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ROOT = OPFS_ROOT_DIR;
const hoursAgo = (h: number) => Date.now() - h * 3600 * 1000;

describe.each([
  ['with move() support', { supportsMove: true }],
  ['without move() support', { supportsMove: false }],
  ['with a move() that refuses to replace', { supportsMove: true, moveThrows: true }],
])('OPFS backend (%s)', (_name, quirks) => {
  it('reports backend "opfs" and persistent: true, and writes a version manifest', async () => {
    const mock = installOpfsMock(quirks);
    const store = await openOpfs();
    expect(store.backend).toBe('opfs');
    expect(store.persistent).toBe(true);
    expect(mock.tree()).toContain(`${ROOT}/manifest.json`);
    const manifest = await (await (await mock.root.getDirectoryHandle(ROOT)).getFileHandle('manifest.json')).getFile();
    expect(JSON.parse(await manifest.text())).toEqual({ schemaVersion: OPFS_MANIFEST_VERSION });
  });

  it('leaves no probe or temp file behind after opening', async () => {
    const mock = installOpfsMock(quirks);
    await openOpfs();
    expect(mock.tree()).toEqual([`${ROOT}/manifest.json`]);
  });

  it('writes and reads back a Blob, an ArrayBuffer and a typed array', async () => {
    installOpfsMock(quirks);
    const store = await openOpfs();
    await store.write('takes/a.wav', new Blob(['hello']));
    await store.write('songs/x.bin', new Uint8Array([1, 2, 3, 4]).buffer);
    await store.write('songs/y.bin', new Uint8Array([9, 8, 7]));
    expect(await (await store.read('takes/a.wav'))?.text()).toBe('hello');
    expect((await store.read('songs/x.bin'))?.size).toBe(4);
    expect((await store.read('songs/y.bin'))?.size).toBe(3);
  });

  it('read() of a missing path returns undefined', async () => {
    installOpfsMock(quirks);
    const store = await openOpfs();
    await expect(store.read('takes/nope.wav')).resolves.toBeUndefined();
    await expect(store.read('nodir/nope.wav')).resolves.toBeUndefined();
  });

  it('overwrites an existing path with the newest content only, leaving no temp files', async () => {
    const mock = installOpfsMock(quirks);
    const store = await openOpfs();
    await store.write('takes/a.wav', new Blob(['first']));
    await store.write('takes/a.wav', new Blob(['second']));
    expect(await (await store.read('takes/a.wav'))?.text()).toBe('second');
    expect(await store.list()).toEqual(['takes/a.wav']);
    expect(mock.tree().filter((p) => p.includes('.tmp-'))).toEqual([]);
  });

  it('delete() removes the file, and deleting a missing or invalid path does not throw', async () => {
    installOpfsMock(quirks);
    const store = await openOpfs();
    await store.write('takes/a.wav', new Blob(['x']));
    await store.delete('takes/a.wav');
    await expect(store.read('takes/a.wav')).resolves.toBeUndefined();
    await expect(store.delete('takes/never.wav')).resolves.toBeUndefined();
    await expect(store.delete('../escape')).resolves.toBeUndefined();
  });

  it('list() returns every written path, nested included, filtered by prefix, and never the manifest or temp files', async () => {
    const mock = installOpfsMock(quirks);
    await mock.seed(`${ROOT}/takes/.tmp-leftover-b.wav`, 'junk'); // a fresh temp file: kept, but never listed
    const store = await openOpfs();
    await store.write('takes/a.wav', new Blob(['a']));
    await store.write('takes/b.wav', new Blob(['bb']));
    await store.write('songs/c.backing', new Blob(['ccc']));
    expect((await store.list()).sort()).toEqual(['songs/c.backing', 'takes/a.wav', 'takes/b.wav']);
    expect((await store.list('takes/')).sort()).toEqual(['takes/a.wav', 'takes/b.wav']);
    expect(await store.list('nothing/')).toEqual([]);
  });

  it('totalBytes() sums every file, or just those under a prefix', async () => {
    installOpfsMock(quirks);
    const store = await openOpfs();
    await store.write('takes/a.wav', new Blob(['a'])); // 1 byte
    await store.write('takes/b.wav', new Blob(['bb'])); // 2 bytes
    await store.write('songs/c.backing', new Blob(['ccc'])); // 3 bytes
    await expect(store.totalBytes()).resolves.toBe(6);
    await expect(store.totalBytes('takes/')).resolves.toBe(3);
    await expect(store.totalBytes('songs/')).resolves.toBe(3);
    await expect(store.totalBytes('none/')).resolves.toBe(0);
  });

  it('stat() reports size and modification time, or undefined', async () => {
    installOpfsMock(quirks);
    const store = await openOpfs();
    const before = Date.now();
    await store.write('takes/a.wav', new Blob(['12345']));
    const stat = await store.stat('takes/a.wav');
    expect(stat?.size).toBe(5);
    expect(stat!.modifiedAt).toBeGreaterThanOrEqual(before - 5);
    await expect(store.stat('takes/none.wav')).resolves.toBeUndefined();
  });

  it('rejects paths that could escape, collide with internals, or be ambiguous', async () => {
    installOpfsMock(quirks);
    const store = await openOpfs();
    for (const bad of ['', '/', '../x', 'a/../b', 'a//b', '.hidden', 'a/.tmp-x', 'manifest.json', 'a/b/', 'sp ace/x']) {
      await expect(store.write(bad, new Blob(['x']))).rejects.toThrow(/invalid path|reserved path/);
    }
    await expect(store.read('../x')).resolves.toBeUndefined();
    // a file called manifest.json is fine below the root
    await store.write('takes/manifest.json', new Blob(['ok']));
    expect(await store.list()).toEqual(['takes/manifest.json']);
  });

  it('a write that fails midway leaves the previous content intact and no temp debris', async () => {
    const mock = installOpfsMock(quirks);
    const store = await openOpfs();
    await store.write('takes/a.wav', new Blob(['old']));

    mock.control.onWrite = () => {
      throw quotaError();
    };
    await expect(store.write('takes/a.wav', new Blob(['new']))).rejects.toMatchObject({ name: 'QuotaExceededError' });
    mock.control.onWrite = null;

    expect(await (await store.read('takes/a.wav'))?.text()).toBe('old');
    expect(mock.tree().filter((p) => p.includes('.tmp-'))).toEqual([]);
  });

  it('a failed write of a brand-new path leaves nothing behind - not even an empty file', async () => {
    const mock = installOpfsMock(quirks);
    const store = await openOpfs();
    // Let the temp file take its bytes, then fail the second write (only the copy path makes one).
    let writes = 0;
    mock.control.onWrite = () => {
      writes += 1;
      if (writes === 2) throw quotaError();
    };
    const outcome = await store.write('takes/new.wav', new Blob(['data'])).then(
      () => 'ok',
      () => 'failed',
    );
    mock.control.onWrite = null;

    if (outcome === 'failed') {
      await expect(store.read('takes/new.wav')).resolves.toBeUndefined();
      expect(await store.list()).toEqual([]);
    } else {
      expect(await (await store.read('takes/new.wav'))?.text()).toBe('data'); // the rename path never needed a second write
    }
    expect(mock.tree().filter((p) => p.includes('.tmp-'))).toEqual([]);
  });

  it('notices a silently truncated write and refuses to call it saved', async () => {
    const mock = installOpfsMock(quirks);
    const store = await openOpfs(); // the open-time probe must pass first...
    mock.control.truncateOnClose = true; // ...then the platform starts losing a byte

    await expect(store.write('takes/a.wav', new Blob(['0123456789']))).rejects.toThrow(/verification failed/);
    await expect(store.read('takes/a.wav')).resolves.toBeUndefined();
    expect(mock.tree().filter((p) => p.includes('.tmp-'))).toEqual([]);
  });
});

describe('OPFS open-time housekeeping', () => {
  it('sweeps temp files left by a crashed write once they are old, and keeps recent ones and real files', async () => {
    const mock = installOpfsMock();
    await mock.seed(`${ROOT}/takes/.tmp-crash1-a.wav`, 'partial', hoursAgo(3));
    await mock.seed(`${ROOT}/.tmp-crash2-x`, 'partial', hoursAgo(2));
    await mock.seed(`${ROOT}/takes/.tmp-inflight-b.wav`, 'writing now', Date.now()); // another tab, mid-write
    await mock.seed(`${ROOT}/takes/real.wav`, 'keep me', hoursAgo(50)); // old, but a real file

    const store = await openOpfs();
    const tree = mock.tree();
    expect(tree).not.toContain(`${ROOT}/takes/.tmp-crash1-a.wav`);
    expect(tree).not.toContain(`${ROOT}/.tmp-crash2-x`);
    expect(tree).toContain(`${ROOT}/takes/.tmp-inflight-b.wav`);
    expect(await store.list()).toEqual(['takes/real.wav']);
    expect(OPFS_STALE_TEMP_MS).toBe(3600 * 1000);
  });

  it('rewrites a corrupt or older manifest, and leaves a newer one alone', async () => {
    const read = async (mock: ReturnType<typeof installOpfsMock>) => {
      const file = await (await (await mock.root.getDirectoryHandle(ROOT)).getFileHandle('manifest.json')).getFile();
      return file.text();
    };

    const corrupt = installOpfsMock();
    await corrupt.seed(`${ROOT}/manifest.json`, '{not json');
    await openOpfs();
    expect(JSON.parse(await read(corrupt))).toEqual({ schemaVersion: OPFS_MANIFEST_VERSION });

    const older = installOpfsMock();
    await older.seed(`${ROOT}/manifest.json`, JSON.stringify({ schemaVersion: 0 }));
    await openOpfs();
    expect(JSON.parse(await read(older))).toEqual({ schemaVersion: OPFS_MANIFEST_VERSION });

    const newer = installOpfsMock();
    await newer.seed(`${ROOT}/manifest.json`, JSON.stringify({ schemaVersion: 99 }));
    await openOpfs();
    expect(JSON.parse(await read(newer))).toEqual({ schemaVersion: 99 });
  });

  it('reopening finds what an earlier session wrote', async () => {
    installOpfsMock();
    const first = await openOpfs();
    await first.write('takes/a.wav', new Blob(['persisted']));
    const second = await openOpfs();
    expect(await (await second.read('takes/a.wav'))?.text()).toBe('persisted');
  });
});

describe('IndexedDB blob fallback', () => {
  const FALLBACKS: Array<[string, () => void]> = [
    ['no OPFS at all', () => installNoOpfs()],
    ['OPFS whose root directory cannot be opened', () => {
      vi.stubGlobal('navigator', {
        storage: {
          getDirectory: async () => {
            throw new DOMException('denied', 'SecurityError');
          },
        },
      });
    }],
    ['OPFS without createWritable() (Safari before 26 on the main thread)', () => {
      installOpfsMock({ createWritableMissing: true });
    }],
  ];

  it.each(FALLBACKS)('is chosen for: %s', async (_name, setup) => {
    setup();
    const store = await openOpfs({ fallbackDbName: freshName('bin') });
    expect(store.backend).toBe('idb-blob');
    expect(store.persistent).toBe(true);
  });

  it('round-trips write/read/stat/delete/list/totalBytes', async () => {
    installNoOpfs();
    const store = await openOpfs({ fallbackDbName: freshName('bin') });
    await store.write('takes/a.wav', new Blob(['hello']));
    await store.write('takes/b.wav', new Blob(['hi']));
    await store.write('songs/c.backing', new Uint8Array([1, 2, 3]));

    expect(await (await store.read('takes/a.wav'))?.text()).toBe('hello');
    expect((await store.list()).sort()).toEqual(['songs/c.backing', 'takes/a.wav', 'takes/b.wav']);
    expect((await store.list('takes/')).sort()).toEqual(['takes/a.wav', 'takes/b.wav']);
    await expect(store.totalBytes()).resolves.toBe(10);
    await expect(store.totalBytes('takes/')).resolves.toBe(7);
    expect((await store.stat('takes/b.wav'))?.size).toBe(2);
    await expect(store.stat('takes/none.wav')).resolves.toBeUndefined();

    await store.delete('takes/a.wav');
    await expect(store.read('takes/a.wav')).resolves.toBeUndefined();
    expect((await store.list()).sort()).toEqual(['songs/c.backing', 'takes/b.wav']);
  });

  it('overwrites in place', async () => {
    installNoOpfs();
    const store = await openOpfs({ fallbackDbName: freshName('bin') });
    await store.write('takes/a.wav', new Blob(['first']));
    await store.write('takes/a.wav', new Blob(['second!']));
    expect(await (await store.read('takes/a.wav'))?.text()).toBe('second!');
    await expect(store.totalBytes()).resolves.toBe(7);
  });

  it('rejects the same bad paths as the OPFS backend', async () => {
    installNoOpfs();
    const store = await openOpfs({ fallbackDbName: freshName('bin') });
    for (const bad of ['', '../x', 'a//b', '.hidden', 'manifest.json']) {
      await expect(store.write(bad, new Blob(['x']))).rejects.toThrow(/invalid path|reserved path/);
    }
  });

  it('persists across openOpfs() calls on the same database', async () => {
    installNoOpfs();
    const name = freshName('bin');
    const first = await openOpfs({ fallbackDbName: name });
    await first.write('takes/a.wav', new Blob(['kept']));
    const second = await openOpfs({ fallbackDbName: name });
    expect(await (await second.read('takes/a.wav'))?.text()).toBe('kept');
  });

  it('close() makes later operations reject', async () => {
    installNoOpfs();
    const store = await openOpfs({ fallbackDbName: freshName('bin') });
    store.close();
    await expect(store.read('takes/a.wav')).rejects.toThrow(/closed/);
  });
});

describe('in-memory fallback (no OPFS, no IndexedDB)', () => {
  function setup(): void {
    installNoOpfs();
    vi.stubGlobal('indexedDB', undefined);
  }

  it('reports backend "memory" and persistent: false', async () => {
    setup();
    const store = await openOpfs();
    expect(store.backend).toBe('memory');
    expect(store.persistent).toBe(false);
  });

  it('is also chosen when the IndexedDB fallback cannot open', async () => {
    installNoOpfs();
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new Error('blocked');
      },
    });
    expect((await openOpfs()).backend).toBe('memory');
  });

  it('still round-trips write/read/stat/delete/list/totalBytes', async () => {
    setup();
    const store = await openOpfs();
    await store.write('takes/a.wav', new Blob(['hello']));
    await store.write('songs/b.backing', new Uint8Array([1, 2]));
    expect(await (await store.read('takes/a.wav'))?.text()).toBe('hello');
    expect((await store.list()).sort()).toEqual(['songs/b.backing', 'takes/a.wav']);
    expect(await store.list('songs/')).toEqual(['songs/b.backing']);
    await expect(store.totalBytes()).resolves.toBe(7);
    await expect(store.totalBytes('songs/')).resolves.toBe(2);
    expect((await store.stat('takes/a.wav'))?.size).toBe(5);
    await store.delete('takes/a.wav');
    expect(await store.list()).toEqual(['songs/b.backing']);
  });

  it('rejects bad paths too', async () => {
    setup();
    const store = await openOpfs();
    await expect(store.write('../x', new Blob(['x']))).rejects.toThrow(/invalid path/);
  });
});

describe('which backends a store reports it can read', () => {
  it('a plain backend reports just itself', async () => {
    installOpfsMock();
    expect((await openOpfs({ fallbackDbName: freshName('bin') })).backends).toEqual(['opfs']);
    installNoOpfs();
    expect((await openOpfs({ fallbackDbName: freshName('bin') })).backends).toEqual(['idb-blob']);
    vi.stubGlobal('indexedDB', undefined);
    expect((await openOpfs()).backends).toEqual(['memory']);
  });

  it('the other backend is never created just to look for it', async () => {
    installOpfsMock();
    const dbName = freshName('bin');
    const store = await openOpfs({ fallbackDbName: dbName });
    expect(store.backends).toEqual(['opfs']);
    expect((await indexedDB.databases()).map((info) => info.name)).not.toContain(dbName);
  });
});

describe('a browser that switches binary backend between launches', () => {
  const OLD = 'recorded last month';

  describe('IndexedDB blobs -> OPFS (Safari gains main-thread writes)', () => {
    async function afterTheSwitch() {
      installNoOpfs();
      const dbName = freshName('bin');
      const before = await openOpfs({ fallbackDbName: dbName });
      await before.write('takes/old.wav', new Blob([OLD]));
      await before.write('songs/s1.backing', new Blob(['backing']));
      before.close();
      const mock = installOpfsMock();
      const store = await openOpfs({ fallbackDbName: dbName });
      return { dbName, mock, store };
    }

    it('writes new files to OPFS but still reads, stats, lists and counts the old ones', async () => {
      const { mock, store } = await afterTheSwitch();
      expect(store.backend).toBe('opfs');
      expect(store.backends).toEqual(['opfs', 'idb-blob']);
      expect(store.persistent).toBe(true);
      expect(await (await store.read('takes/old.wav'))?.text()).toBe(OLD);
      expect((await store.stat('takes/old.wav'))?.size).toBe(OLD.length);

      await store.write('takes/new.wav', new Blob(['new']));
      expect(mock.tree()).toContain(`${ROOT}/takes/new.wav`);
      expect(mock.tree().filter((path) => path.endsWith('old.wav'))).toEqual([]); // nothing was copied at open
      expect((await store.list()).sort()).toEqual(['songs/s1.backing', 'takes/new.wav', 'takes/old.wav']);
      expect((await store.list('takes/')).sort()).toEqual(['takes/new.wav', 'takes/old.wav']);
      await expect(store.totalBytes()).resolves.toBe(OLD.length + 'backing'.length + 'new'.length);
      await expect(store.totalBytes('takes/')).resolves.toBe(OLD.length + 'new'.length);
      await expect(store.read('takes/none.wav')).resolves.toBeUndefined();
      await expect(store.stat('takes/none.wav')).resolves.toBeUndefined();
    });

    it('deleting an old file removes it for good', async () => {
      const { store } = await afterTheSwitch();
      await store.delete('takes/old.wav');
      await expect(store.read('takes/old.wav')).resolves.toBeUndefined();
      expect(await store.list()).toEqual(['songs/s1.backing']);
    });

    it('rewriting an old path stores the new bytes in OPFS and drops the stale copy', async () => {
      const { dbName, store } = await afterTheSwitch();
      await store.write('songs/s1.backing', new Blob(['version two']));
      expect(await (await store.read('songs/s1.backing'))?.text()).toBe('version two');
      expect(await store.list('songs/')).toEqual(['songs/s1.backing']);

      installNoOpfs(); // a later launch that only has IndexedDB no longer finds the stale copy
      const idbOnly = await openOpfs({ fallbackDbName: dbName });
      expect(await idbOnly.list('songs/')).toEqual([]);
    });

    it('a file present in both backends is listed once, read from the current one, counted twice and deleted from both', async () => {
      const mock = installOpfsMock();
      const dbName = freshName('bin');
      await (await openOpfs({ fallbackDbName: dbName })).write('takes/dup.wav', new Blob(['opfs copy']));
      installNoOpfs(); // a launch without OPFS writes the same path to IndexedDB
      await (await openOpfs({ fallbackDbName: dbName })).write('takes/dup.wav', new Blob(['idb copy']));

      useOpfsMock(mock);
      const store = await openOpfs({ fallbackDbName: dbName });
      expect(store.backends).toEqual(['opfs', 'idb-blob']);
      expect(await store.list()).toEqual(['takes/dup.wav']);
      expect(await (await store.read('takes/dup.wav'))?.text()).toBe('opfs copy');
      await expect(store.totalBytes()).resolves.toBe('opfs copy'.length + 'idb copy'.length);

      await store.delete('takes/dup.wav');
      await expect(store.stat('takes/dup.wav')).resolves.toBeUndefined();
      expect(mock.tree().filter((path) => path.endsWith('dup.wav'))).toEqual([]);
      installNoOpfs();
      expect(await (await openOpfs({ fallbackDbName: dbName })).list()).toEqual([]);
    });
  });

  describe('OPFS -> IndexedDB blobs (the OPFS write probe starts failing)', () => {
    async function afterTheSwitch() {
      const mock = installOpfsMock();
      const dbName = freshName('bin');
      await (await openOpfs({ fallbackDbName: dbName })).write('takes/old.wav', new Blob([OLD]));
      mock.control.createWritableMissing = true; // from the next launch on, OPFS cannot be written
      const store = await openOpfs({ fallbackDbName: dbName });
      return { mock, dbName, store };
    }

    it('old files stay readable, listed, counted and deletable', async () => {
      const { mock, store } = await afterTheSwitch();
      expect(store.backend).toBe('idb-blob');
      expect(store.backends).toEqual(['idb-blob', 'opfs']);
      expect(await (await store.read('takes/old.wav'))?.text()).toBe(OLD);

      await store.write('takes/new.wav', new Blob(['new'])); // goes to IndexedDB
      expect((await store.list()).sort()).toEqual(['takes/new.wav', 'takes/old.wav']);
      await expect(store.totalBytes()).resolves.toBe(OLD.length + 'new'.length);

      await store.delete('takes/old.wav');
      expect(mock.tree().filter((path) => path.endsWith('old.wav'))).toEqual([]);
      await expect(store.read('takes/old.wav')).resolves.toBeUndefined();
    });

    it('an OPFS that cannot be reached at all cannot be read, and the store admits it does not cover it', async () => {
      const { dbName } = await afterTheSwitch();
      installUnreachableOpfs();
      const store = await openOpfs({ fallbackDbName: dbName });
      expect(store.backend).toBe('idb-blob');
      expect(store.backends).toEqual(['idb-blob']);
      await expect(store.read('takes/old.wav')).resolves.toBeUndefined();
    });
  });

  it('a database lookup that never answers cannot hang the launch: the other backend is just not covered', async () => {
    installNoOpfs();
    const dbName = freshName('bin');
    (await openOpfs({ fallbackDbName: dbName })).close(); // the blob database exists: normally it would be found
    installOpfsMock();
    vi.spyOn(indexedDB, 'databases').mockReturnValue(new Promise(() => {}));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const opening = openOpfs({ fallbackDbName: dbName });
    await vi.advanceTimersByTimeAsync(DATABASE_LOOKUP_TIMEOUT_MS);
    const store = await opening;
    expect(store.backend).toBe('opfs');
    expect(store.backends).toEqual(['opfs']);
  });

  it('a database lookup that throws leaves the other backend uncovered too', async () => {
    installNoOpfs();
    const dbName = freshName('bin');
    (await openOpfs({ fallbackDbName: dbName })).close();
    installOpfsMock();
    vi.spyOn(indexedDB, 'databases').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect((await openOpfs({ fallbackDbName: dbName })).backends).toEqual(['opfs']);
  });

  it('a blob database that holds files but cannot be opened is reported, not ignored', async () => {
    installNoOpfs();
    const dbName = freshName('bin');
    (await openOpfs({ fallbackDbName: dbName })).close(); // creates the database
    installOpfsMock();
    failIndexedDbOpen(dbName);

    const store = await openOpfs({ fallbackDbName: dbName });
    expect(store.backend).toBe('opfs');
    expect(store.backends).toEqual(['opfs']); // it covers nothing in the unreadable one
    await store.write('takes/a.wav', new Blob(['a']));
    expect(await (await store.read('takes/a.wav'))?.text()).toBe('a'); // the current backend still works
    await expect(store.list()).rejects.toThrow(/could not be opened/); // but nothing may act on a partial listing
    await expect(store.totalBytes()).rejects.toThrow(/could not be opened/);
    await expect(store.read('takes/b.wav')).rejects.toThrow(/could not be opened/);
  });
});

describe('deleteConfirmed', () => {
  it('resolves once the file is gone, including when it never existed', async () => {
    installNoOpfs();
    const store = await openOpfs({ fallbackDbName: freshName('bin') });
    await store.write('takes/a.wav', new Blob(['x']));
    await expect(deleteConfirmed(store, 'takes/a.wav')).resolves.toBeUndefined();
    await expect(store.stat('takes/a.wav')).resolves.toBeUndefined();
    await expect(deleteConfirmed(store, 'takes/never.wav')).resolves.toBeUndefined();
  });

  it('rejects when a best-effort delete left the file in place (a locked OPFS file), and succeeds once it can go', async () => {
    const mock = installOpfsMock();
    const store = await openOpfs();
    await store.write('takes/a.wav', new Blob(['x']));
    mock.control.onRemove = lockFilesEndingWith('.wav');
    await expect(store.delete('takes/a.wav')).resolves.toBeUndefined(); // delete() itself is best-effort
    await expect(deleteConfirmed(store, 'takes/a.wav')).rejects.toThrow(/could not be deleted/);
    expect(await store.list()).toEqual(['takes/a.wav']);

    mock.control.onRemove = null;
    await expect(deleteConfirmed(store, 'takes/a.wav')).resolves.toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it('passes on a delete that fails loudly (an IndexedDB error)', async () => {
    installNoOpfs();
    const real = await openOpfs({ fallbackDbName: freshName('bin') });
    const broken: OpfsStore = overrideMethod(real, 'delete', async () => {
      throw new Error('idb exploded');
    });
    await expect(deleteConfirmed(broken, 'takes/a.wav')).rejects.toThrow('idb exploded');
  });
});
