import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openKV } from './kv';
import type { KVStore } from './kv-types';

/** A fresh db name per test so fake-indexeddb's simulated engine never leaks state between tests. */
let dbCounter = 0;
function freshDbName(): string {
  dbCounter += 1;
  return `pitch-lab-test-${dbCounter}`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each<[string, () => Promise<KVStore>, boolean]>([
  ['IndexedDB-backed store', () => openKV(freshDbName()), true],
  [
    'in-memory fallback (indexedDB missing)',
    () => {
      vi.stubGlobal('indexedDB', undefined);
      return openKV(freshDbName());
    },
    false,
  ],
])('%s', (_name, makeStore, expectedPersistent) => {
  it(`reports persistent: ${expectedPersistent}`, async () => {
    const store = await makeStore();
    expect(store.persistent).toBe(expectedPersistent);
  });

  it('returns undefined for a missing key', async () => {
    const store = await makeStore();
    await expect(store.get('nope')).resolves.toBeUndefined();
  });

  it('round-trips primitives, arrays and nested objects', async () => {
    const store = await makeStore();
    await store.set('str', 'hello');
    await store.set('num', 42);
    await store.set('arr', [1, 2, 3]);
    await store.set('obj', { schemaVersion: 1, nested: { a: [true, false] } });

    await expect(store.get('str')).resolves.toBe('hello');
    await expect(store.get('num')).resolves.toBe(42);
    await expect(store.get('arr')).resolves.toEqual([1, 2, 3]);
    await expect(store.get('obj')).resolves.toEqual({ schemaVersion: 1, nested: { a: [true, false] } });
  });

  it('overwrites an existing key on set', async () => {
    const store = await makeStore();
    await store.set('k', 'first');
    await store.set('k', 'second');
    await expect(store.get('k')).resolves.toBe('second');
  });

  it('clones values so mutating a returned object does not affect the store', async () => {
    const store = await makeStore();
    await store.set('obj', { count: 1 });

    const first = await store.get<{ count: number }>('obj');
    first!.count = 999;

    const second = await store.get<{ count: number }>('obj');
    expect(second).toEqual({ count: 1 });
  });

  it('deletes a key', async () => {
    const store = await makeStore();
    await store.set('gone', 'soon');
    await store.delete('gone');
    await expect(store.get('gone')).resolves.toBeUndefined();
  });

  it('delete is a no-op for a missing key', async () => {
    const store = await makeStore();
    await expect(store.delete('never-existed')).resolves.toBeUndefined();
  });

  it('keys() with no prefix lists every key', async () => {
    const store = await makeStore();
    await store.set('a', 1);
    await store.set('b', 2);
    await expect(store.keys()).resolves.toEqual(expect.arrayContaining(['a', 'b']));
    await expect(store.keys()).resolves.toHaveLength(2);
  });

  it('keys(prefix) follows the "profile:<id>:<thing>" convention from kv-types.ts', async () => {
    const store = await makeStore();
    await store.set('profile:default:settings', {});
    await store.set('profile:default:history', {});
    await store.set('profile:other:settings', {});
    await store.set('device:settings', {});

    const keys = await store.keys('profile:default:');
    expect(keys.sort()).toEqual(['profile:default:history', 'profile:default:settings']);
  });

  it('keys(prefix) returns an empty array when nothing matches', async () => {
    const store = await makeStore();
    await store.set('profile:default:settings', {});
    await expect(store.keys('profile:missing:')).resolves.toEqual([]);
  });
});

describe('fallback triggers', () => {
  it('falls back to memory when indexedDB is undefined', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const store = await openKV(freshDbName());
    expect(store.persistent).toBe(false);
    await store.set('k', 'v');
    await expect(store.get('k')).resolves.toBe('v');
  });

  it('falls back to memory when indexedDB.open throws', async () => {
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new Error('simulated IndexedDB failure');
      },
    });
    const store = await openKV(freshDbName());
    expect(store.persistent).toBe(false);
    await store.set('k', 'v');
    await expect(store.get('k')).resolves.toBe('v');
  });
});
