import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DB_VERSION, META_KEYS, openDb, type PitchLabDb } from './db';
import { formatHlc, isHlc, parseHlc } from './hlc';
import { isConstraintError } from './idb';
import { freshName } from './test-helpers';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Records every IDBDatabase the code under test opens, so a test can break one. */
function captureConnections(): IDBDatabase[] {
  const opened: IDBDatabase[] = [];
  const realOpen = indexedDB.open.bind(indexedDB);
  vi.spyOn(indexedDB, 'open').mockImplementation((...args: Parameters<IDBFactory['open']>) => {
    const request = realOpen(...args);
    request.addEventListener('success', () => opened.push(request.result));
    return request;
  });
  return opened;
}

interface Row {
  n: number;
}

describe.each<[string, () => Promise<PitchLabDb>, boolean]>([
  ['IndexedDB-backed db', () => openDb(freshName('data')), true],
  [
    'in-memory fallback (indexedDB missing)',
    () => {
      vi.stubGlobal('indexedDB', undefined);
      return openDb(freshName('data'));
    },
    false,
  ],
])('%s', (_name, makeDb, expectedPersistent) => {
  it(`reports persistent: ${expectedPersistent}`, async () => {
    const db = await makeDb();
    expect(db.persistent).toBe(expectedPersistent);
    expect(db.fallbackReason === null).toBe(expectedPersistent);
  });

  it('has an 8-character [0-9a-z] deviceId', async () => {
    const db = await makeDb();
    expect(db.deviceId).toMatch(/^[0-9a-z]{8}$/);
  });

  it('nextTimestamp() produces increasing well-formed HLC strings', async () => {
    const db = await makeDb();
    const a = db.nextTimestamp();
    const b = db.nextTimestamp();
    expect(isHlc(a)).toBe(true);
    expect(a < b).toBe(true);
    expect(parseHlc(a)?.deviceId).toBe(db.deviceId);
  });

  it('receiveTimestamp() makes later local stamps sort after the remote one', async () => {
    const db = await makeDb();
    const remote = formatHlc({ wallMs: Date.now() + 60_000, counter: 3, deviceId: 'remote00' });
    const merged = db.receiveTimestamp(remote);
    expect(merged > remote).toBe(true);
    expect(db.nextTimestamp() > merged).toBe(true);
  });

  it('isPlausibleTimestamp() rejects garbage and the far future', async () => {
    const db = await makeDb();
    expect(db.isPlausibleTimestamp(db.nextTimestamp())).toBe(true);
    expect(db.isPlausibleTimestamp('garbage')).toBe(false);
    expect(db.isPlausibleTimestamp(formatHlc({ wallMs: Date.now() + 5 * 366 * 24 * 3600 * 1000, counter: 0, deviceId: 'remote00' }))).toBe(false);
  });

  it('nowIso() is an ISO string', async () => {
    const db = await makeDb();
    expect(db.nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('put()/get() round-trip a value in a given store', async () => {
    const db = await makeDb();
    await db.store<Row>('profiles').put({ n: 1 }, 'p1');
    await expect(db.store<Row>('profiles').get('p1')).resolves.toEqual({ n: 1 });
  });

  it('get() of a missing key is undefined', async () => {
    const db = await makeDb();
    await expect(db.store<Row>('profiles').get('nope')).resolves.toBeUndefined();
  });

  it('copies values in and out, so callers can never mutate stored rows', async () => {
    const db = await makeDb();
    const input = { n: 1, nested: { a: [1, 2] } };
    await db.store<typeof input>('profiles').put(input, 'p1');
    input.nested.a.push(99); // mutating the original after the write must not change the store
    const first = await db.store<typeof input>('profiles').get('p1');
    first!.nested.a.push(100); // nor must mutating a read result
    await expect(db.store<typeof input>('profiles').get('p1')).resolves.toEqual({ n: 1, nested: { a: [1, 2] } });
  });

  it('getAll() / getAllKeys() / count() describe every row in a store', async () => {
    const db = await makeDb();
    const store = db.store<Row>('profiles');
    await store.put({ n: 1 }, 'p1');
    await store.put({ n: 2 }, 'p2');
    expect((await store.getAll()).sort((a, b) => a.n - b.n)).toEqual([{ n: 1 }, { n: 2 }]);
    expect((await store.getAllKeys()).sort()).toEqual(['p1', 'p2']);
    await expect(store.count()).resolves.toBe(2);
  });

  it('delete() / deleteMany() / clear() remove rows', async () => {
    const db = await makeDb();
    const store = db.store<Row>('profiles');
    for (const k of ['a', 'b', 'c', 'd']) await store.put({ n: 1 }, k);
    await store.delete('a');
    await store.deleteMany(['b', 'c']);
    expect(await store.getAllKeys()).toEqual(['d']);
    await store.deleteMany([]);
    await store.delete('never-existed');
    await store.clear();
    await expect(store.count()).resolves.toBe(0);
  });

  it('add() enforces append-only: a second add() with the same key rejects with ConstraintError', async () => {
    const db = await makeDb();
    await db.store<Row>('attempts').add({ n: 1 }, 'a1');
    const err = await db.store<Row>('attempts').add({ n: 2 }, 'a1').then(
      () => null,
      (e: unknown) => e,
    );
    expect(isConstraintError(err)).toBe(true);
    await expect(db.store<Row>('attempts').get('a1')).resolves.toEqual({ n: 1 }); // the original is untouched
  });

  it('add() and put() reject a value that cannot be stored, and store nothing', async () => {
    const db = await makeDb();
    const store = db.store<unknown>('profiles');
    await expect(store.add({ fn: () => 1 }, 'a')).rejects.toMatchObject({ name: 'DataCloneError' });
    await expect(store.put({ fn: () => 1 }, 'b')).rejects.toMatchObject({ name: 'DataCloneError' });
    await expect(store.update('c', () => ({ fn: () => 1 }))).rejects.toMatchObject({ name: 'DataCloneError' });
    await expect(store.count()).resolves.toBe(0);
  });

  it('put() may overwrite an existing key (unlike add())', async () => {
    const db = await makeDb();
    await db.store<Row>('profiles').put({ n: 1 }, 'p1');
    await db.store<Row>('profiles').put({ n: 2 }, 'p1');
    await expect(db.store<Row>('profiles').get('p1')).resolves.toEqual({ n: 2 });
  });

  describe('update() (atomic read-modify-write)', () => {
    it('creates a row when none exists, and returns what it stored', async () => {
      const db = await makeDb();
      const stored = await db.store<Row>('profiles').update('p1', (existing) => {
        expect(existing).toBeUndefined();
        return { n: 1 };
      });
      expect(stored).toEqual({ n: 1 });
      await expect(db.store<Row>('profiles').get('p1')).resolves.toEqual({ n: 1 });
    });

    it('modifies an existing row from its current value', async () => {
      const db = await makeDb();
      await db.store<Row>('profiles').put({ n: 5 }, 'p1');
      await db.store<Row>('profiles').update('p1', (existing) => ({ n: existing!.n + 1 }));
      await expect(db.store<Row>('profiles').get('p1')).resolves.toEqual({ n: 6 });
    });

    it('writes nothing, and resolves undefined, when the callback returns undefined', async () => {
      const db = await makeDb();
      await db.store<Row>('profiles').put({ n: 5 }, 'p1');
      const result = await db.store<Row>('profiles').update('p1', () => undefined);
      expect(result).toBeUndefined();
      await expect(db.store<Row>('profiles').get('p1')).resolves.toEqual({ n: 5 });
      await db.store<Row>('profiles').update('absent', () => undefined);
      await expect(db.store<Row>('profiles').get('absent')).resolves.toBeUndefined();
    });

    it('a throwing callback rejects with its error and writes nothing', async () => {
      const db = await makeDb();
      await db.store<Row>('profiles').put({ n: 5 }, 'p1');
      await expect(
        db.store<Row>('profiles').update('p1', () => {
          throw new Error('nope');
        }),
      ).rejects.toThrow('nope');
      await expect(db.store<Row>('profiles').get('p1')).resolves.toEqual({ n: 5 });
    });

    it('the callback gets a copy: mutating it without returning it changes nothing', async () => {
      const db = await makeDb();
      await db.store<Row>('profiles').put({ n: 5 }, 'p1');
      await db.store<Row>('profiles').update('p1', (existing) => {
        existing!.n = 999;
        return undefined;
      });
      await expect(db.store<Row>('profiles').get('p1')).resolves.toEqual({ n: 5 });
    });

    it('25 concurrent increments all land (no lost updates)', async () => {
      const db = await makeDb();
      await db.store<Row>('profiles').put({ n: 0 }, 'counter');
      await Promise.all(Array.from({ length: 25 }, () => db.store<Row>('profiles').update('counter', (existing) => ({ n: existing!.n + 1 }))));
      await expect(db.store<Row>('profiles').get('counter')).resolves.toEqual({ n: 25 });
    });
  });

  describe('addMissing() (bulk, never overwrites)', () => {
    it('adds new keys and reports the ones that already existed, leaving those untouched', async () => {
      const db = await makeDb();
      const store = db.store<Row>('attempts');
      await store.add({ n: 1 }, 'a');
      const result = await store.addMissing([
        ['a', { n: 100 }],
        ['b', { n: 2 }],
        ['c', { n: 3 }],
      ]);
      expect(result.added.sort()).toEqual(['b', 'c']);
      expect(result.existing).toEqual(['a']);
      await expect(store.get('a')).resolves.toEqual({ n: 1 });
      await expect(store.get('b')).resolves.toEqual({ n: 2 });
    });

    it('treats a duplicate inside the batch itself as existing', async () => {
      const db = await makeDb();
      const store = db.store<Row>('attempts');
      const result = await store.addMissing([
        ['x', { n: 1 }],
        ['x', { n: 2 }],
      ]);
      expect(result.added).toEqual(['x']);
      expect(result.existing).toEqual(['x']);
      await expect(store.get('x')).resolves.toEqual({ n: 1 });
    });

    it('an empty batch is a no-op', async () => {
      const db = await makeDb();
      await expect(db.store<Row>('attempts').addMissing([])).resolves.toEqual({ added: [], existing: [] });
    });

    it('a row that cannot be stored rejects the whole batch and leaves nothing half-committed', async () => {
      const db = await makeDb();
      const store = db.store<unknown>('attempts');
      await expect(
        store.addMissing([
          ['ok-1', { n: 1 }],
          ['bad', { n: 2, fn: () => 1 }], // functions cannot be structured-cloned
          ['ok-2', { n: 3 }],
        ]),
      ).rejects.toMatchObject({ name: 'DataCloneError' });
      await expect(store.count()).resolves.toBe(0);
    });

    it('handles a large batch', async () => {
      const db = await makeDb();
      const entries = Array.from({ length: 1500 }, (_, i): [string, Row] => [`k${i}`, { n: i }]);
      const result = await db.store<Row>('attempts').addMissing(entries);
      expect(result.added).toHaveLength(1500);
      await expect(db.store<Row>('attempts').count()).resolves.toBe(1500);
    });
  });

  describe('getAllByIndex()', () => {
    interface AttemptLike {
      profileId: string;
      exerciseId: string;
      createdAt: string;
    }

    it('finds rows by each indexed field (attempts: profileId, exerciseId, createdAt)', async () => {
      const db = await makeDb();
      const attempts = db.store<AttemptLike>('attempts');
      await attempts.add({ profileId: 'alice', exerciseId: 'sustain', createdAt: '2026-01-01' }, 'a1');
      await attempts.add({ profileId: 'alice', exerciseId: 'siren', createdAt: '2026-01-02' }, 'a2');
      await attempts.add({ profileId: 'bob', exerciseId: 'sustain', createdAt: '2026-01-03' }, 'a3');

      expect((await attempts.getAllByIndex('profileId', 'alice')).map((a) => a.exerciseId).sort()).toEqual(['siren', 'sustain']);
      expect((await attempts.getAllByIndex('exerciseId', 'sustain')).map((a) => a.profileId).sort()).toEqual(['alice', 'bob']);
      expect((await attempts.getAllByIndex('createdAt', '2026-01-02')).map((a) => a.exerciseId)).toEqual(['siren']);
    });

    it('supports the compound profileId+exerciseId index', async () => {
      const db = await makeDb();
      const attempts = db.store<AttemptLike>('attempts');
      await attempts.add({ profileId: 'alice', exerciseId: 'sustain', createdAt: '1' }, 'a1');
      await attempts.add({ profileId: 'alice', exerciseId: 'siren', createdAt: '2' }, 'a2');
      await attempts.add({ profileId: 'bob', exerciseId: 'sustain', createdAt: '3' }, 'a3');
      const hit = await attempts.getAllByIndex('profileExercise', ['alice', 'sustain']);
      expect(hit).toEqual([{ profileId: 'alice', exerciseId: 'sustain', createdAt: '1' }]);
      await expect(attempts.getAllByIndex('profileExercise', ['alice', 'nothing'])).resolves.toEqual([]);
    });

    it('takes and songs are indexed by profileId', async () => {
      const db = await makeDb();
      await db.store<{ profileId: string }>('takes').add({ profileId: 'p1' }, 't1');
      await db.store<{ profileId: string }>('songs').add({ profileId: 'p1' }, 's1');
      await expect(db.store('takes').getAllByIndex('profileId', 'p1')).resolves.toHaveLength(1);
      await expect(db.store('songs').getAllByIndex('profileId', 'p2')).resolves.toHaveLength(0);
    });

    it('does not index a row that lacks the field, and does not choke on it', async () => {
      const db = await makeDb();
      const attempts = db.store<Record<string, unknown>>('attempts');
      await attempts.add({ exerciseId: 'sustain' }, 'headless');
      await expect(attempts.getAllByIndex('profileId', 'alice')).resolves.toEqual([]);
    });

    it('rejects for an index the store does not have, rather than silently returning nothing', async () => {
      const db = await makeDb();
      await expect(db.store<unknown>('profiles').getAllByIndex('profileId', 'x')).rejects.toBeDefined();
    });
  });

  it('meta store holds arbitrary keyed values, independent of the record stores', async () => {
    const db = await makeDb();
    await db.store<number>('meta').put(7, 'customKey');
    await expect(db.store<number>('meta').get('customKey')).resolves.toBe(7);
    await expect(db.store<number>('profiles').get('customKey')).resolves.toBeUndefined();
  });

  it('keeps deviceId and schemaVersion readable from meta whichever backend is in use', async () => {
    const db = await makeDb();
    await expect(db.store<string>('meta').get(META_KEYS.deviceId)).resolves.toBe(db.deviceId);
    await expect(db.store<number>('meta').get(META_KEYS.schemaVersion)).resolves.toBe(DB_VERSION);
  });
});

describe('injectable clock', () => {
  it('nowIso() and the HLC both read the injected clock', async () => {
    const db = await openDb(freshName('data'), { now: () => Date.UTC(2030, 0, 2, 3, 4, 5, 6) });
    expect(db.nowIso()).toBe('2030-01-02T03:04:05.006Z');
    expect(parseHlc(db.nextTimestamp())?.wallMs).toBe(Date.UTC(2030, 0, 2, 3, 4, 5, 6));
  });
});

describe('IndexedDB backend', () => {
  it('creates every store and index', async () => {
    const name = freshName('data');
    await openDb(name);
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    expect([...raw.objectStoreNames].sort()).toEqual(['attempts', 'meta', 'profiles', 'songs', 'takes']);
    const tx = raw.transaction(['attempts', 'takes', 'songs'], 'readonly');
    expect([...tx.objectStore('attempts').indexNames].sort()).toEqual(['createdAt', 'exerciseId', 'profileExercise', 'profileId']);
    expect([...tx.objectStore('takes').indexNames]).toEqual(['profileId']);
    expect([...tx.objectStore('songs').indexNames]).toEqual(['profileId']);
    expect(raw.version).toBe(DB_VERSION);
  });

  it('reuses the same deviceId when the same database is opened again', async () => {
    const name = freshName('data');
    const first = await openDb(name);
    const second = await openDb(name);
    expect(second.deviceId).toBe(first.deviceId);
    expect(first.deviceId).toMatch(/^[0-9a-z]{8}$/);
  });

  it('repairs a corrupt persisted deviceId instead of stamping with it', async () => {
    const name = freshName('data');
    const first = await openDb(name);
    await first.store<string>('meta').put('NOT VALID!', META_KEYS.deviceId);
    const second = await openDb(name);
    expect(second.deviceId).toMatch(/^[0-9a-z]{8}$/);
    await expect(second.store<string>('meta').get(META_KEYS.deviceId)).resolves.toBe(second.deviceId);
  });

  it('a value is visible from a second connection the moment the write resolves (committed, not buffered)', async () => {
    const name = freshName('data');
    const first = await openDb(name);
    const second = await openDb(name);
    await first.store<Row>('songs').put({ n: 9 }, 's1');
    await expect(second.store<Row>('songs').get('s1')).resolves.toEqual({ n: 9 });
  });

  it('asks for strict durability on every write transaction', async () => {
    const opened = captureConnections();
    const db = await openDb(freshName('data'));
    const spy = vi.spyOn(opened[0], 'transaction');
    await db.store<Row>('attempts').add({ n: 1 }, 'a1');
    await db.store<Row>('profiles').put({ n: 1 }, 'p1');
    await db.store<Row>('profiles').update('p1', (e) => ({ n: e!.n + 1 }));
    await db.store<Row>('attempts').addMissing([['a2', { n: 2 }]]);
    await db.store<Row>('profiles').delete('p1');
    const writes = spy.mock.calls.filter((c) => c[1] === 'readwrite');
    expect(writes).toHaveLength(5);
    for (const call of writes) expect(call[2]).toEqual({ durability: 'strict' });
  });

  describe('the clock is persisted atomically with every record write', () => {
    it('a restarted device never stamps below a record it already stored, even if its wall clock went backward', async () => {
      const name = freshName('data');
      const before = await openDb(name, { now: () => 5_000_000 });
      const stamp = before.nextTimestamp();
      await before.store<{ updatedAt: string }>('attempts').add({ updatedAt: stamp }, 'a1');

      // The app was killed; on relaunch the OS clock reads far earlier (a bad NTP step, a manual change).
      const after = await openDb(name, { now: () => 5 });
      expect(after.nextTimestamp() > stamp).toBe(true);
    });

    it('covers every record store (profiles, takes, songs) and the bulk/update paths too', async () => {
      const name = freshName('data');
      const writer = await openDb(name, { now: () => 9_000_000 });
      const stamps: string[] = [];
      const stamp = () => {
        const s = writer.nextTimestamp();
        stamps.push(s);
        return s;
      };
      await writer.store('profiles').put({ updatedAt: stamp() }, 'p');
      await writer.store('takes').add({ updatedAt: stamp() }, 't');
      await writer.store('songs').put({ updatedAt: stamp() }, 's');
      await writer.store('attempts').addMissing([['a', { updatedAt: stamp() }]]);
      await writer.store<{ updatedAt: string }>('profiles').update('p', () => ({ updatedAt: stamp() }));

      const reopened = await openDb(name, { now: () => 1 });
      const next = reopened.nextTimestamp();
      for (const s of stamps) expect(next > s).toBe(true);
    });

    it('stores the state a fresh connection reads back', async () => {
      const name = freshName('data');
      const db = await openDb(name, { now: () => 777 });
      await db.store('attempts').add({ updatedAt: db.nextTimestamp() }, 'a1');
      const state = await db.store<{ wallMs: number; counter: number }>('meta').get(META_KEYS.hlcState);
      expect(state).toEqual({ wallMs: 777, counter: 0 });
    });

    it('never moves the stored clock backward, even when a write snapshots an older state', async () => {
      const db = await openDb(freshName('data'), { now: () => 1000 });
      const meta = db.store<{ wallMs: number; counter: number }>('meta');

      await meta.put({ wallMs: 5_000_000, counter: 9 }, META_KEYS.hlcState); // something later is already stored
      await db.store('attempts').add({ updatedAt: db.nextTimestamp() }, 'a1'); // while this device's clock reads 1000
      await expect(meta.get(META_KEYS.hlcState)).resolves.toEqual({ wallMs: 5_000_000, counter: 9 });

      await meta.put({ wallMs: 1000, counter: 50 }, META_KEYS.hlcState); // same wall time, higher counter stored
      await db.store('profiles').put({ updatedAt: db.nextTimestamp() }, 'p1');
      await expect(meta.get(META_KEYS.hlcState)).resolves.toEqual({ wallMs: 1000, counter: 50 });

      await meta.put({ wallMs: 10, counter: 0 }, META_KEYS.hlcState); // an older state is advanced to ours
      await db.store('profiles').put({ updatedAt: db.nextTimestamp() }, 'p2');
      const advanced = (await meta.get(META_KEYS.hlcState))!;
      expect(advanced.wallMs).toBe(1000);
      expect(advanced.counter).toBeGreaterThan(0);
    });

    it('after overlapping update() and add() calls, the stored clock covers every stamp issued - including ones made inside update()', async () => {
      const name = freshName('data');
      const db = await openDb(name, { now: () => 4_000_000 });
      const stamps: string[] = [];
      await db.store('profiles').put({ updatedAt: db.nextTimestamp() }, 'shared');
      const ops: Array<Promise<unknown>> = [];
      for (let i = 0; i < 40; i++) {
        if (i % 2 === 0) {
          ops.push(
            db.store<{ updatedAt: string }>('profiles').update('shared', () => {
              const s = db.nextTimestamp(); // stamped inside the callback, at the moment the transaction really runs
              stamps.push(s);
              return { updatedAt: s };
            }),
          );
        } else {
          const s = db.nextTimestamp();
          stamps.push(s);
          ops.push(db.store('attempts').add({ updatedAt: s }, `a${i}`));
        }
      }
      await Promise.all(ops);

      const relaunched = await openDb(name, { now: () => 1 }); // the wall clock is wrong after the restart
      const next = relaunched.nextTimestamp();
      for (const s of stamps) expect(next > s).toBe(true);
    });
  });

  describe('connection loss', () => {
    it('reopens transparently when the connection dies between operations', async () => {
      const opened = captureConnections();
      const db = await openDb(freshName('data'));
      await db.store<Row>('profiles').put({ n: 1 }, 'p1');
      const countBefore = opened.length;

      opened[0].close();
      await expect(db.store<Row>('profiles').get('p1')).resolves.toEqual({ n: 1 });
      await db.store<Row>('profiles').put({ n: 2 }, 'p1');
      await expect(db.store<Row>('profiles').get('p1')).resolves.toEqual({ n: 2 });
      expect(opened.length).toBe(countBefore + 1);
    });

    it('survives a lost connection in the middle of every kind of operation', async () => {
      const opened = captureConnections();
      const db = await openDb(freshName('data'));
      const store = db.store<Row>('attempts');
      await store.add({ n: 0 }, 'seed');
      for (const op of [
        () => store.add({ n: 1 }, 'a'),
        () => store.put({ n: 2 }, 'b'),
        () => store.get('a'),
        () => store.getAll(),
        () => store.getAllKeys(),
        () => store.count(),
        () => store.update('a', (e) => ({ n: (e?.n ?? 0) + 1 })),
        () => store.addMissing([['c', { n: 3 }]]),
        () => store.deleteMany(['c']),
        () => store.delete('b'),
      ]) {
        opened[opened.length - 1].close();
        await op();
      }
      await expect(store.getAllKeys()).resolves.toEqual(expect.arrayContaining(['seed', 'a']));
    });

    it('treats a duplicate on the RETRY of add() as "already written", but a first-attempt duplicate still rejects', async () => {
      const opened = captureConnections();
      const db = await openDb(freshName('data'));
      const store = db.store<Row>('attempts');
      await store.add({ n: 1 }, 'a1'); // as if a previous attempt had committed before the connection reported lost

      // First transaction() call fails like a dead connection; the retry then meets the existing row.
      vi.spyOn(opened[0], 'transaction').mockImplementationOnce(() => {
        throw new DOMException('closing', 'InvalidStateError');
      });
      await expect(store.add({ n: 1 }, 'a1')).resolves.toBeUndefined();
      await expect(store.get('a1')).resolves.toEqual({ n: 1 });

      // No lost connection: a genuine duplicate is an error.
      await expect(store.add({ n: 2 }, 'a1')).rejects.toBeDefined();
    });

    it('close() makes later operations reject', async () => {
      const db = await openDb(freshName('data'));
      db.close();
      await expect(db.store('profiles').get('x')).rejects.toThrow(/closed/);
    });
  });

  describe('schema versions', () => {
    it('stays usable when a newer build upgrades the database underneath it (versionchange)', async () => {
      const name = freshName('data');
      const db = await openDb(name);
      await db.store<Row>('profiles').put({ n: 1 }, 'p1');

      const newer = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open(name, DB_VERSION + 1);
        r.onupgradeneeded = () => {
          r.result.createObjectStore('futureStore');
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.onblocked = () => reject(new Error('blocked: the old build kept its connection open'));
      });
      newer.close();

      await expect(db.store<Row>('profiles').get('p1')).resolves.toEqual({ n: 1 });
      await db.store<Row>('profiles').put({ n: 2 }, 'p1');
      await expect(db.store<Row>('profiles').get('p1')).resolves.toEqual({ n: 2 });
    });

    it('opens a database a newer build already upgraded, instead of falling back to memory', async () => {
      const name = freshName('data');
      const first = await openDb(name);
      await first.store<Row>('profiles').put({ n: 1 }, 'p1');
      first.close();
      await new Promise<void>((resolve, reject) => {
        const r = indexedDB.open(name, DB_VERSION + 2);
        r.onsuccess = () => {
          r.result.close();
          resolve();
        };
        r.onerror = () => reject(r.error);
      });

      const reopened = await openDb(name);
      expect(reopened.persistent).toBe(true);
      await expect(reopened.store<Row>('profiles').get('p1')).resolves.toEqual({ n: 1 });
    });
  });
});

describe('fallback triggers', () => {
  it('falls back to memory, saying why, when indexedDB is undefined', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const db = await openDb(freshName('data'));
    expect(db.persistent).toBe(false);
    expect(db.fallbackReason).toBe('indexeddb-unavailable');
    await db.store<Row>('profiles').put({ n: 1 }, 'p1');
    await expect(db.store<Row>('profiles').get('p1')).resolves.toEqual({ n: 1 });
  });

  it('falls back to memory when indexedDB.open throws', async () => {
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new Error('simulated IndexedDB failure');
      },
    });
    const db = await openDb(freshName('data'));
    expect(db.persistent).toBe(false);
    expect(db.fallbackReason).toMatch(/^open-failed: .*simulated IndexedDB failure/);
    await db.store<Row>('profiles').put({ n: 1 }, 'p1');
    await expect(db.store<Row>('profiles').get('p1')).resolves.toEqual({ n: 1 });
  });

  it('falls back to memory when indexedDB.open never answers', async () => {
    vi.stubGlobal('indexedDB', { open: () => ({}) });
    const db = await openDb(freshName('data'), { openTimeoutMs: 30 });
    expect(db.persistent).toBe(false);
    expect(db.fallbackReason).toMatch(/timed out/);
  });

  it('every memory fallback has its own independent data', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const a = await openDb(freshName('data'));
    const b = await openDb(freshName('data'));
    await a.store<Row>('profiles').put({ n: 1 }, 'p1');
    await expect(b.store<Row>('profiles').get('p1')).resolves.toBeUndefined();
    expect(a.deviceId).not.toBe(b.deviceId);
  });
});
