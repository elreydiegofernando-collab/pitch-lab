import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { markerIsCovered, readableBackends, withBackendMarker } from './backend-marker';
import { META_KEYS, openDb } from './db';
import { openOpfs } from './opfs';
import { dbWithFailingStore, freshName, installNoOpfs, installOpfsMock, overrideMethod } from './test-helpers';

afterEach(() => {
  vi.unstubAllGlobals();
});

const marker = (db: Awaited<ReturnType<typeof openDb>>) => db.store('meta').get(META_KEYS.binaryBackend);

async function idbSetup() {
  installNoOpfs();
  const db = await openDb(freshName('marker'));
  const binDbName = freshName('bin');
  const store = await openOpfs({ fallbackDbName: binDbName });
  return { db, binDbName, store, marked: withBackendMarker(db, store) };
}

describe('withBackendMarker', () => {
  it('records the backend after the first successful write, and later writes change nothing', async () => {
    const { db, marked } = await idbSetup();
    await expect(marker(db)).resolves.toBeUndefined();
    await marked.write('takes/a.wav', new Blob(['a']));
    await expect(marker(db)).resolves.toBe('idb-blob');
    await marked.write('takes/b.wav', new Blob(['b']));
    await marked.write('takes/a.wav', new Blob(['a again']));
    await expect(marker(db)).resolves.toBe('idb-blob');
  });

  it('adds a backend the files later went to, keeping the first: the marker is the SET of every backend ever written', async () => {
    const { db, binDbName, marked } = await idbSetup();
    await marked.write('takes/a.wav', new Blob(['a']));

    installOpfsMock(); // the browser switches to OPFS; the old blobs stay readable
    const both = withBackendMarker(db, await openOpfs({ fallbackDbName: binDbName }));
    await both.write('takes/b.wav', new Blob(['b']));
    await expect(marker(db)).resolves.toBe('idb-blob,opfs');
    await both.write('takes/c.wav', new Blob(['c']));
    await expect(marker(db)).resolves.toBe('idb-blob,opfs');
    await expect(markerIsCovered(db, both)).resolves.toBe(true);
  });

  it('never records a backend that does not survive a reload', async () => {
    installNoOpfs();
    const db = await openDb(freshName('marker'));
    vi.stubGlobal('indexedDB', undefined);
    const memory = await openOpfs();
    vi.unstubAllGlobals();
    expect(memory.persistent).toBe(false);
    await withBackendMarker(db, memory).write('takes/a.wav', new Blob(['a']));
    await expect(marker(db)).resolves.toBeUndefined();
  });

  it('reads, stats, listings, sizes and deletes pass straight through and record nothing', async () => {
    const { db, store, marked } = await idbSetup();
    await store.write('takes/a.wav', new Blob(['abc'])); // written behind the wrapper's back
    expect(await (await marked.read('takes/a.wav'))?.text()).toBe('abc');
    expect((await marked.stat('takes/a.wav'))?.size).toBe(3);
    expect(await marked.list()).toEqual(['takes/a.wav']);
    expect(await marked.list('songs/')).toEqual([]);
    await expect(marked.totalBytes()).resolves.toBe(3);
    await marked.delete('takes/a.wav');
    expect(await marked.list()).toEqual([]);
    await expect(marker(db)).resolves.toBeUndefined();
  });

  it('describes the store it wraps', async () => {
    const { marked } = await idbSetup();
    expect(marked.backend).toBe('idb-blob');
    expect(marked.backends).toEqual(['idb-blob']);
    expect(marked.persistent).toBe(true);
  });

  it('a failure to record never fails the write, and the next write records it', async () => {
    const { db, store } = await idbSetup();
    const broken = dbWithFailingStore(db, 'meta', 'update', new Error('meta hiccup'));
    await withBackendMarker(broken, store).write('takes/a.wav', new Blob(['a']));
    expect(await store.list()).toEqual(['takes/a.wav']);
    await expect(marker(db)).resolves.toBeUndefined();

    await withBackendMarker(db, store).write('takes/b.wav', new Blob(['b']));
    await expect(marker(db)).resolves.toBe('idb-blob');
  });

  it('a write that fails records nothing', async () => {
    const { db, store } = await idbSetup();
    const failing = overrideMethod(store, 'write', async () => {
      throw new Error('disk full');
    });
    await expect(withBackendMarker(db, failing).write('takes/a.wav', new Blob(['a']))).rejects.toThrow('disk full');
    await expect(marker(db)).resolves.toBeUndefined();
  });

  it('leaves a marker it does not understand alone', async () => {
    const { db, marked } = await idbSetup();
    await db.store('meta').put(42, META_KEYS.binaryBackend);
    await marked.write('takes/a.wav', new Blob(['a']));
    await expect(marker(db)).resolves.toBe(42);
  });
});

describe('markerIsCovered', () => {
  it('is true when nothing was ever recorded', async () => {
    const { db, store } = await idbSetup();
    await expect(markerIsCovered(db, store)).resolves.toBe(true);
  });

  it('is true when the store reads every recorded backend, false when one is out of sight', async () => {
    const { db, store } = await idbSetup();
    await db.store('meta').put('idb-blob', META_KEYS.binaryBackend);
    await expect(markerIsCovered(db, store)).resolves.toBe(true);
    await db.store('meta').put('opfs', META_KEYS.binaryBackend);
    await expect(markerIsCovered(db, store)).resolves.toBe(false);
    await db.store('meta').put('idb-blob,opfs', META_KEYS.binaryBackend);
    await expect(markerIsCovered(db, store)).resolves.toBe(false);
  });

  it('is false for a marker it cannot make sense of', async () => {
    const { db, store } = await idbSetup();
    for (const odd of [42, true, ['idb-blob'], { a: 1 }, 'sqlite-wasm', 'idb-blob,sqlite-wasm']) {
      await db.store('meta').put(odd, META_KEYS.binaryBackend);
      await expect(markerIsCovered(db, store)).resolves.toBe(false);
    }
  });

  it('ignores stray commas and spaces, and an empty marker', async () => {
    const { db, store } = await idbSetup();
    for (const tidy of ['', ' idb-blob , ', ',idb-blob,']) {
      await db.store('meta').put(tidy, META_KEYS.binaryBackend);
      await expect(markerIsCovered(db, store)).resolves.toBe(true);
    }
  });
});

describe('readableBackends', () => {
  it('falls back to the store\'s own backend when it does not say', () => {
    expect(readableBackends({ backend: 'opfs' } as never)).toEqual(['opfs']);
    expect(readableBackends({ backend: 'idb-blob', backends: ['idb-blob', 'opfs'] } as never)).toEqual(['idb-blob', 'opfs']);
  });
});
