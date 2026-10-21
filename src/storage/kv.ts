/**
 * See src/storage/kv-types.ts for the public contract (KVStore).
 *
 * IndexedDB already applies the structured-clone algorithm on every put()/get(),
 * so values are naturally deep-copied in and out without help from this module.
 * The in-memory fallback has no such built-in step, so it clones explicitly with
 * the global structuredClone() (our build targets - Safari 16+, Chrome/Edge 110+,
 * and Vitest's Node >= 22.12 - all have it) to match that same value semantics.
 */
import type { KVStore } from './kv-types';

const STORE_NAME = 'kv';
const DB_VERSION = 1;

function openDatabase(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(dbName, DB_VERSION);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    request.onblocked = () => reject(new Error('IndexedDB open blocked by another open connection'));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** Exclusive upper bound for an IDBKeyRange matching every string starting with `prefix`. */
function prefixRange(prefix: string): IDBKeyRange {
  return IDBKeyRange.bound(prefix, prefix + '￿', false, false);
}

class IndexedDBKVStore implements KVStore {
  readonly persistent = true;

  constructor(private readonly db: IDBDatabase) {}

  async get<T>(key: string): Promise<T | undefined> {
    const tx = this.db.transaction(STORE_NAME, 'readonly');
    return requestToPromise<T | undefined>(tx.objectStore(STORE_NAME).get(key));
  }

  async set<T>(key: string, value: T): Promise<void> {
    const tx = this.db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    await transactionDone(tx);
  }

  async delete(key: string): Promise<void> {
    const tx = this.db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(key);
    await transactionDone(tx);
  }

  async keys(prefix = ''): Promise<string[]> {
    const tx = this.db.transaction(STORE_NAME, 'readonly');
    const range = prefix ? prefixRange(prefix) : undefined;
    const keys = await requestToPromise(tx.objectStore(STORE_NAME).getAllKeys(range));
    return keys.map((k) => String(k));
  }
}

/** Used when IndexedDB is unavailable or fails to open (e.g. some private-browsing modes). */
class MemoryKVStore implements KVStore {
  readonly persistent = false;
  private readonly map = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.map.has(key) ? (structuredClone(this.map.get(key)) as T) : undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.map.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async keys(prefix = ''): Promise<string[]> {
    const out: string[] = [];
    for (const key of this.map.keys()) {
      if (key.startsWith(prefix)) out.push(key);
    }
    return out;
  }
}

/**
 * Opens (creating if needed) the app's key-value store. Falls back to an
 * in-memory `KVStore` - reporting `persistent: false` - when `indexedDB` does
 * not exist or fails to open, so callers never need their own fallback path.
 */
export async function openKV(dbName = 'pitch-lab'): Promise<KVStore> {
  if (typeof indexedDB === 'undefined') {
    return new MemoryKVStore();
  }
  try {
    const db = await openDatabase(dbName);
    return new IndexedDBKVStore(db);
  } catch {
    return new MemoryKVStore();
  }
}
