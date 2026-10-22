import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IdbConnection,
  applyUpgrades,
  errorMessage,
  errorName,
  isConnectionLostError,
  isConstraintError,
  isQuotaError,
  openIdbDatabase,
  requestToPromise,
  transactionDone,
  type IdbSpec,
  type UpgradeStep,
} from './idb';
import { freshName } from './test-helpers';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function oneStoreSpec(name: string): IdbSpec {
  return {
    name,
    version: 1,
    upgrade: (db) => {
      db.createObjectStore('s');
    },
  };
}

async function put(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  const tx = db.transaction('s', 'readwrite');
  tx.objectStore('s').put(value, key);
  await transactionDone(tx);
}

function getValue(db: IDBDatabase, key: string): Promise<unknown> {
  return requestToPromise(db.transaction('s', 'readonly').objectStore('s').get(key));
}

describe('error classification', () => {
  it('isQuotaError recognises the DOMException, the legacy code and the message', () => {
    expect(isQuotaError(new DOMException('full', 'QuotaExceededError'))).toBe(true);
    expect(isQuotaError({ name: 'SomethingElse', code: 22 })).toBe(true);
    expect(isQuotaError(new Error('The quota has been exceeded.'))).toBe(true);
    expect(isQuotaError(new Error('boom'))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
  });

  it('isConstraintError', () => {
    expect(isConstraintError(new DOMException('dup', 'ConstraintError'))).toBe(true);
    expect(isConstraintError(new Error('dup'))).toBe(false);
    expect(isConstraintError(null)).toBe(false);
  });

  it('isConnectionLostError covers InvalidStateError and the WebKit "server lost" message', () => {
    expect(isConnectionLostError(new DOMException('closing', 'InvalidStateError'))).toBe(true);
    expect(isConnectionLostError(new Error('Connection to Indexed Database server lost. Refresh the page to try again'))).toBe(true);
    expect(isConnectionLostError(new Error('The database connection is closing.'))).toBe(true);
    expect(isConnectionLostError(new DOMException('full', 'QuotaExceededError'))).toBe(false);
    expect(isConnectionLostError(new Error('boom'))).toBe(false);
  });

  it('errorName / errorMessage tolerate odd values', () => {
    expect(errorName(null)).toBe('');
    expect(errorName({ name: 42 })).toBe('');
    expect(errorName(new TypeError('x'))).toBe('TypeError');
    expect(errorMessage(new Error('hi'))).toBe('hi');
    expect(errorMessage({ message: 'plain' })).toBe('plain');
    expect(errorMessage('just text')).toBe('just text');
  });
});

describe('transactionDone', () => {
  it('rejects with the underlying ConstraintError, not a generic wrapper', async () => {
    const db = await openIdbDatabase(oneStoreSpec(freshName('idb')));
    const first = db.transaction('s', 'readwrite');
    first.objectStore('s').add(1, 'k');
    await transactionDone(first);

    const second = db.transaction('s', 'readwrite');
    second.objectStore('s').add(2, 'k');
    const err = await transactionDone(second).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isConstraintError(err)).toBe(true);
    expect(await getValue(db, 'k')).toBe(1);
  });

  it('rejects with the abort reason when a transaction is aborted', async () => {
    const db = await openIdbDatabase(oneStoreSpec(freshName('idb')));
    const tx = db.transaction('s', 'readwrite');
    tx.objectStore('s').put(1, 'k');
    const done = transactionDone(tx);
    tx.abort();
    await expect(done).rejects.toBeDefined();
    expect(await getValue(db, 'k')).toBeUndefined();
  });
});

describe('applyUpgrades', () => {
  it('runs only the steps newer than the old version, in order', async () => {
    const name = freshName('idb');
    const ran: string[] = [];
    const step = (label: string): UpgradeStep => () => {
      ran.push(label);
    };
    const specFor = (steps: UpgradeStep[]): IdbSpec => ({
      name,
      version: steps.length,
      upgrade: (db, oldVersion, tx) => applyUpgrades(steps, db, oldVersion, tx),
    });

    (await openIdbDatabase(specFor([step('v1')]))).close();
    expect(ran).toEqual(['v1']);

    (await openIdbDatabase(specFor([step('v1'), step('v2'), step('v3')]))).close();
    expect(ran).toEqual(['v1', 'v2', 'v3']);
  });
});

describe('openIdbDatabase', () => {
  it('a throwing upgrade aborts the open and leaves the previous version and its data intact', async () => {
    const name = freshName('idb');
    const v1 = oneStoreSpec(name);
    const first = await openIdbDatabase(v1);
    await put(first, 'keep', 'me');
    first.close();

    const bad: IdbSpec = {
      name,
      version: 2,
      upgrade: () => {
        throw new Error('boom');
      },
    };
    await expect(openIdbDatabase(bad)).rejects.toBeDefined();

    const again = await openIdbDatabase(v1);
    expect(again.version).toBe(1);
    expect(await getValue(again, 'keep')).toBe('me');
  });

  it('opens a database that is already newer than this build as it is, without running its upgrade', async () => {
    const name = freshName('idb');
    (
      await openIdbDatabase({
        name,
        version: 3,
        upgrade: (db) => {
          db.createObjectStore('s');
        },
      })
    ).close();

    const old: IdbSpec = {
      name,
      version: 1,
      upgrade: () => {
        throw new Error('must not run');
      },
    };
    const db = await openIdbDatabase(old);
    expect(db.version).toBe(3);
    expect(db.objectStoreNames.contains('s')).toBe(true);
  });

  it('gives up on an open() that never answers', async () => {
    vi.stubGlobal('indexedDB', { open: () => ({}) });
    await expect(openIdbDatabase({ name: 'x', version: 1, upgrade: () => {} }, 30)).rejects.toThrow(/timed out/);
  });

  it('closes a connection that arrives after it already gave up', async () => {
    // A request whose success fires only after the timeout.
    const fakeDb = { close: vi.fn() };
    const request: Record<string, unknown> = {};
    vi.stubGlobal('indexedDB', { open: () => request });
    await expect(openIdbDatabase({ name: 'late', version: 1, upgrade: () => {} }, 20)).rejects.toThrow(/timed out/);
    request.result = fakeDb;
    (request.onsuccess as () => void)();
    expect(fakeDb.close).toHaveBeenCalledOnce();
  });

  it('rejects when indexedDB.open itself throws', async () => {
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new Error('SecurityError: denied');
      },
    });
    await expect(openIdbDatabase({ name: 'x', version: 1, upgrade: () => {} })).rejects.toThrow(/denied/);
  });
});

describe('IdbConnection', () => {
  it('runs operations against a live connection', async () => {
    const conn = await IdbConnection.open(oneStoreSpec(freshName('conn')));
    await conn.run((db) => put(db, 'a', 1));
    await expect(conn.run((db) => getValue(db, 'a'))).resolves.toBe(1);
  });

  it('closes itself on versionchange so a newer build can upgrade, then reopens as-is on the next operation', async () => {
    const name = freshName('conn');
    const conn = await IdbConnection.open(oneStoreSpec(name));
    await conn.run((db) => put(db, 'a', 'before'));

    // A newer build opens version 2. If our connection did not close itself this would be "blocked".
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('blocked: our connection did not close on versionchange'));
    });
    upgraded.close();

    await expect(conn.run((db) => getValue(db, 'a'))).resolves.toBe('before');
    await conn.run((db) => put(db, 'b', 'after'));
    await expect(conn.run((db) => getValue(db, 'b'))).resolves.toBe('after');
  });

  it('retries once, flagged attempt 1, after a lost connection', async () => {
    const conn = await IdbConnection.open(oneStoreSpec(freshName('conn')));
    const seen: number[] = [];
    const result = await conn.run((_db, attempt) => {
      seen.push(attempt);
      if (attempt === 0) throw new DOMException('closing', 'InvalidStateError');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(seen).toEqual([0, 1]);
  });

  it('does not retry any other failure', async () => {
    const conn = await IdbConnection.open(oneStoreSpec(freshName('conn')));
    const seen: number[] = [];
    await expect(
      conn.run((_db, attempt) => {
        seen.push(attempt);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(seen).toEqual([0]);
  });

  it('gives up after the single retry', async () => {
    const conn = await IdbConnection.open(oneStoreSpec(freshName('conn')));
    const seen: number[] = [];
    await expect(
      conn.run((_db, attempt) => {
        seen.push(attempt);
        throw new DOMException('closing', 'InvalidStateError');
      }),
    ).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect(seen).toEqual([0, 1]);
  });

  it('replaces a connection that was closed behind its back', async () => {
    const opened: IDBDatabase[] = [];
    const realOpen = indexedDB.open.bind(indexedDB);
    vi.spyOn(indexedDB, 'open').mockImplementation((...args: Parameters<IDBFactory['open']>) => {
      const request = realOpen(...args);
      request.addEventListener('success', () => opened.push(request.result));
      return request;
    });

    const conn = await IdbConnection.open(oneStoreSpec(freshName('conn')));
    await conn.run((db) => put(db, 'a', 1));
    expect(opened).toHaveLength(1);

    opened[0].close(); // what a dying iOS IndexedDB server looks like from here: transaction() now throws InvalidStateError
    await expect(conn.run((db) => getValue(db, 'a'))).resolves.toBe(1);
    expect(opened).toHaveLength(2);
  });

  it('concurrent operations on a dead connection share one reopen', async () => {
    const opened: IDBDatabase[] = [];
    const realOpen = indexedDB.open.bind(indexedDB);
    vi.spyOn(indexedDB, 'open').mockImplementation((...args: Parameters<IDBFactory['open']>) => {
      const request = realOpen(...args);
      request.addEventListener('success', () => opened.push(request.result));
      return request;
    });
    const conn = await IdbConnection.open(oneStoreSpec(freshName('conn')));
    await conn.run((db) => put(db, 'a', 7));
    opened[0].close();

    const results = await Promise.all(Array.from({ length: 6 }, () => conn.run((db) => getValue(db, 'a'))));
    expect(results).toEqual([7, 7, 7, 7, 7, 7]);
    expect(opened).toHaveLength(2); // the original plus exactly one replacement
  });

  it('close() makes later operations reject', async () => {
    const conn = await IdbConnection.open(oneStoreSpec(freshName('conn')));
    conn.close();
    await expect(conn.run((db) => getValue(db, 'a'))).rejects.toThrow(/closed/);
  });
});
