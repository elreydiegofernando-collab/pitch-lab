/**
 * The Phase 3+ data database: IndexedDB database `pitch-lab-data`, separate from
 * the Phase 1 settings KV (`storage/kv.ts`, db `pitch-lab`). Stores: `profiles`,
 * `attempts` (indexed by profileId, exerciseId, createdAt, and profileId+exerciseId),
 * `takes`, `songs`, `meta` (deviceId, hlc state, schemaVersion, active profile,
 * migration marker, binary-backend marker). Falls back to an in-memory database - reporting
 * `persistent: false` and a `fallbackReason` - when IndexedDB is unavailable or
 * fails to open, so callers never need their own fallback path.
 *
 * Durability: every write transaction asks for `durability: 'strict'` and its
 * promise resolves on the transaction's `complete` event, i.e. only once the data
 * is committed. iOS can kill an installed PWA at any moment, so nothing here is
 * ever "flushed later".
 *
 * Clock: every write to a record store (profiles, attempts, takes, songs) also
 * writes the HLC's current state into `meta` IN THE SAME TRANSACTION. So the
 * persisted clock is always at least the newest `updatedAt` on disk, and a
 * restarted device can never stamp below something it already stored - even if
 * the wall clock moved backward while the app was closed.
 */
import { createHlc, isPlausibleHlc, randomDeviceId, sanitizeHlcState, type Hlc, type HlcState } from './hlc';
import {
  IdbConnection,
  applyUpgrades,
  isConstraintError,
  requestToPromise,
  transactionDone,
  type IdbSpec,
  type UpgradeStep,
} from './idb';

export type StoreName = 'profiles' | 'attempts' | 'takes' | 'songs' | 'meta';
export type IndexName = 'profileId' | 'exerciseId' | 'createdAt' | 'profileExercise';
/** An index query: one string, or one string per field for a compound index. */
export type IndexKey = string | readonly string[];

interface IndexDef {
  readonly name: IndexName;
  readonly keyPath: string | readonly string[];
}

const BY_PROFILE: IndexDef = { name: 'profileId', keyPath: 'profileId' };

/** Per-store secondary indexes. Exact-match queries only; repos combine them with a client-side filter when needed. */
export const STORE_INDEXES: Readonly<Record<StoreName, readonly IndexDef[]>> = {
  profiles: [],
  attempts: [
    BY_PROFILE,
    { name: 'exerciseId', keyPath: 'exerciseId' },
    { name: 'createdAt', keyPath: 'createdAt' },
    { name: 'profileExercise', keyPath: ['profileId', 'exerciseId'] },
  ],
  takes: [BY_PROFILE],
  songs: [BY_PROFILE],
  meta: [],
};

export const META_KEYS = {
  deviceId: 'deviceId',
  hlcState: 'hlcState',
  schemaVersion: 'schemaVersion',
  activeProfileId: 'activeProfileId',
  migrationV1: 'migration:v1',
  /** Which binary backend(s) ever received a file, e.g. `opfs` or `idb-blob,opfs` (backend-marker.ts). */
  binaryBackend: 'binaryBackend',
} as const;

export const DB_NAME = 'pitch-lab-data';

/**
 * Schema history. `UPGRADES[i]` takes the database from version i to i + 1, so a future
 * change appends a step (and nothing else) - never edit or reorder an old one, and never
 * delete or rename a store that may hold a user's data.
 */
const UPGRADES: readonly UpgradeStep[] = [
  // v0 -> v1: the initial schema.
  (db) => {
    (Object.keys(STORE_INDEXES) as StoreName[]).forEach((name) => {
      const store = db.createObjectStore(name);
      for (const index of STORE_INDEXES[name]) {
        store.createIndex(index.name, index.keyPath as string | string[], { unique: false });
      }
    });
  },
];

export const DB_VERSION = UPGRADES.length;

const DB_SPEC: IdbSpec = {
  name: DB_NAME,
  version: DB_VERSION,
  upgrade(db, oldVersion, tx) {
    applyUpgrades(UPGRADES, db, oldVersion, tx);
    tx.objectStore('meta').put(DB_VERSION, META_KEYS.schemaVersion);
  },
};

/**
 * Out-of-line key/value access to one object store, backend-agnostic. Reads and
 * writes copy values (structured clone) on the way in and out, on both backends.
 */
export interface RawStore<T> {
  /** Inserts a new row; rejects (ConstraintError) if the key exists. Append-only stores rely on this. */
  add(value: T, key: string): Promise<void>;
  /** Inserts or replaces a row. */
  put(value: T, key: string): Promise<void>;
  get(key: string): Promise<T | undefined>;
  getAll(): Promise<T[]>;
  getAllKeys(): Promise<string[]>;
  /** Exact-match lookup on one of the store's indexes; rejects for an index the store does not have. */
  getAllByIndex(index: IndexName, query: IndexKey): Promise<T[]>;
  /**
   * Atomic read-modify-write in ONE transaction, so concurrent updates never lose each
   * other's changes. `fn` gets the existing row (or undefined) and returns the row to
   * store, or undefined to leave the store untouched; it must be synchronous and may throw
   * to abort. Resolves with the stored row, or undefined when nothing was written.
   */
  update(key: string, fn: (existing: T | undefined) => T | undefined): Promise<T | undefined>;
  /**
   * Bulk insert in ONE transaction: rows whose key already exists are left untouched (never
   * overwritten) and reported in `existing`. The database's key constraint does the dedupe,
   * so it is race-free.
   */
  addMissing(entries: ReadonlyArray<readonly [string, T]>): Promise<{ added: string[]; existing: string[] }>;
  delete(key: string): Promise<void>;
  deleteMany(keys: readonly string[]): Promise<void>;
  count(): Promise<number>;
  clear(): Promise<void>;
}

export interface PitchLabDb {
  /** False when running on the in-memory fallback: nothing survives a reload. */
  readonly persistent: boolean;
  /** Why this is an in-memory database (for Diagnostics), or null when IndexedDB is in use. */
  readonly fallbackReason: string | null;
  readonly deviceId: string;
  /** Current time as an ISO string, from the same (injectable) clock the HLC uses. */
  nowIso(): string;
  /** Stamps a local write. */
  nextTimestamp(): string;
  /** Folds in a remote timestamp (backup import) so later local writes sort after it. */
  receiveTimestamp(remoteTs: string): string;
  /** True when `ts` is a well-formed HLC no further ahead of this device's clock than HLC_MAX_REMOTE_SKEW_MS. */
  isPlausibleTimestamp(ts: unknown): boolean;
  store<T>(name: StoreName): RawStore<T>;
  /** Closes the connection; later operations reject. */
  close(): void;
}

export interface OpenDbOptions {
  /** Injectable wall clock (ms), for deterministic tests. */
  now?: () => number;
  /** Give up on an `indexedDB.open()` that never answers after this long. */
  openTimeoutMs?: number;
}

// ---------------------------------------------------------------- IndexedDB backend

const WRITE: IDBTransactionOptions = { durability: 'strict' };

class IdbRawStore<T> implements RawStore<T> {
  constructor(
    private readonly conn: IdbConnection,
    private readonly name: StoreName,
    /** Present on record stores: their writes also persist the clock (see module doc). */
    private readonly clock: (() => HlcState) | null,
  ) {}

  private writeTx(db: IDBDatabase): IDBTransaction {
    return db.transaction(this.clock ? [this.name, 'meta'] : this.name, 'readwrite', WRITE);
  }

  /**
   * Persists the clock in `tx`, but never lets the stored state go BACKWARD: overlapping
   * transactions each snapshot the clock at slightly different moments and commit in creation
   * order, so a blind overwrite could leave the stored state older than a stamp already
   * committed by a neighbour. Reading first (inside the same transaction) makes it a max().
   */
  private stampClock(tx: IDBTransaction): void {
    if (!this.clock) return;
    const meta = tx.objectStore('meta');
    const read = meta.get(META_KEYS.hlcState);
    read.onsuccess = () => {
      const persisted = sanitizeHlcState(read.result);
      const mine = this.clock!();
      const next = persisted.wallMs > mine.wallMs || (persisted.wallMs === mine.wallMs && persisted.counter >= mine.counter) ? persisted : mine;
      meta.put(next, META_KEYS.hlcState);
    };
  }

  add(value: T, key: string): Promise<void> {
    return this.conn.run(async (db, attempt) => {
      const tx = this.writeTx(db);
      tx.objectStore(this.name).add(value, key);
      this.stampClock(tx);
      try {
        await transactionDone(tx);
      } catch (err) {
        // After a lost connection the first attempt may in fact have committed; a
        // ConstraintError on the retry then means "already written", not a real duplicate.
        if (attempt > 0 && isConstraintError(err)) return;
        throw err;
      }
    });
  }

  put(value: T, key: string): Promise<void> {
    return this.conn.run(async (db) => {
      const tx = this.writeTx(db);
      tx.objectStore(this.name).put(value, key);
      this.stampClock(tx);
      await transactionDone(tx);
    });
  }

  get(key: string): Promise<T | undefined> {
    return this.conn.run((db) => {
      const tx = db.transaction(this.name, 'readonly');
      return requestToPromise<T | undefined>(tx.objectStore(this.name).get(key));
    });
  }

  getAll(): Promise<T[]> {
    return this.conn.run((db) => {
      const tx = db.transaction(this.name, 'readonly');
      return requestToPromise<T[]>(tx.objectStore(this.name).getAll());
    });
  }

  getAllKeys(): Promise<string[]> {
    return this.conn.run(async (db) => {
      const tx = db.transaction(this.name, 'readonly');
      const keys = await requestToPromise(tx.objectStore(this.name).getAllKeys());
      return keys.map((k) => String(k));
    });
  }

  getAllByIndex(index: IndexName, query: IndexKey): Promise<T[]> {
    return this.conn.run((db) => {
      const tx = db.transaction(this.name, 'readonly');
      return requestToPromise<T[]>(tx.objectStore(this.name).index(index).getAll(query as IDBValidKey));
    });
  }

  update(key: string, fn: (existing: T | undefined) => T | undefined): Promise<T | undefined> {
    return this.conn.run(
      (db) =>
        new Promise<T | undefined>((resolve, reject) => {
          const tx = this.writeTx(db);
          const store = tx.objectStore(this.name);
          let written: T | undefined;
          const read = store.get(key);
          read.onsuccess = () => {
            try {
              const next = fn(read.result as T | undefined);
              if (next !== undefined) {
                store.put(next, key);
                this.stampClock(tx);
                written = next;
              }
            } catch (err) {
              reject(err);
              try {
                tx.abort();
              } catch {
                // already finished
              }
            }
          };
          tx.oncomplete = () => resolve(written);
          tx.onerror = (event) => reject((event.target as IDBRequest | null)?.error ?? tx.error ?? new Error('IndexedDB transaction failed'));
          tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
        }),
    );
  }

  addMissing(entries: ReadonlyArray<readonly [string, T]>): Promise<{ added: string[]; existing: string[] }> {
    return this.conn.run(async (db) => {
      const added: string[] = [];
      const existing: string[] = [];
      if (entries.length === 0) return { added, existing };
      const tx = this.writeTx(db);
      const store = tx.objectStore(this.name);
      try {
        for (const [key, value] of entries) {
          const request = store.add(value, key);
          request.onsuccess = () => {
            added.push(key);
          };
          request.onerror = (event) => {
            if (isConstraintError(request.error)) {
              // Expected for a duplicate: swallow it so it does not abort the whole batch.
              event.preventDefault();
              event.stopPropagation();
              existing.push(key);
            }
          };
        }
        this.stampClock(tx);
      } catch (err) {
        // A row that cannot be stored (say, it holds a function) must not leave the batch half-committed.
        try {
          tx.abort();
        } catch {
          // already finished
        }
        throw err;
      }
      await transactionDone(tx);
      return { added, existing };
    });
  }

  delete(key: string): Promise<void> {
    return this.conn.run(async (db) => {
      const tx = this.writeTx(db);
      tx.objectStore(this.name).delete(key);
      await transactionDone(tx);
    });
  }

  deleteMany(keys: readonly string[]): Promise<void> {
    return this.conn.run(async (db) => {
      if (keys.length === 0) return;
      const tx = this.writeTx(db);
      const store = tx.objectStore(this.name);
      for (const key of keys) store.delete(key);
      await transactionDone(tx);
    });
  }

  count(): Promise<number> {
    return this.conn.run((db) => {
      const tx = db.transaction(this.name, 'readonly');
      return requestToPromise<number>(tx.objectStore(this.name).count());
    });
  }

  clear(): Promise<void> {
    return this.conn.run(async (db) => {
      const tx = this.writeTx(db);
      tx.objectStore(this.name).clear();
      await transactionDone(tx);
    });
  }
}

class IndexedDbPitchLabDb implements PitchLabDb {
  readonly persistent = true;
  readonly fallbackReason = null;
  private readonly hlc: Hlc;
  private readonly cache = new Map<StoreName, RawStore<unknown>>();

  constructor(
    private readonly conn: IdbConnection,
    readonly deviceId: string,
    hlcState: HlcState,
    private readonly now: () => number,
  ) {
    this.hlc = createHlc(deviceId, hlcState, now);
  }

  nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  nextTimestamp(): string {
    return this.hlc.next();
  }

  receiveTimestamp(remoteTs: string): string {
    return this.hlc.receive(remoteTs);
  }

  isPlausibleTimestamp(ts: unknown): boolean {
    return isPlausibleHlc(ts, this.now());
  }

  store<T>(name: StoreName): RawStore<T> {
    let s = this.cache.get(name);
    if (!s) {
      s = new IdbRawStore<unknown>(this.conn, name, name === 'meta' ? null : () => this.hlc.snapshot());
      this.cache.set(name, s);
    }
    return s as unknown as RawStore<T>;
  }

  close(): void {
    this.conn.close();
  }
}

// ---------------------------------------------------------------- in-memory fallback

function rowKey(row: unknown, keyPath: string | readonly string[]): IndexKey | undefined {
  const field = (path: string): unknown => (row as Record<string, unknown> | null)?.[path];
  if (typeof keyPath === 'string') {
    const v = field(keyPath);
    return typeof v === 'string' ? v : undefined;
  }
  const parts = keyPath.map(field);
  return parts.every((p) => typeof p === 'string') ? (parts as string[]) : undefined;
}

function sameKey(a: IndexKey, b: IndexKey): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return a.length === b.length && a.every((part, i) => part === b[i]);
}

class MemoryRawStore<T> implements RawStore<T> {
  private readonly rows = new Map<string, T>();

  constructor(private readonly indexes: readonly IndexDef[]) {}

  async add(value: T, key: string): Promise<void> {
    if (this.rows.has(key)) throw new DOMException(`Key already exists: ${key}`, 'ConstraintError');
    this.rows.set(key, structuredClone(value));
  }

  async put(value: T, key: string): Promise<void> {
    this.rows.set(key, structuredClone(value));
  }

  async get(key: string): Promise<T | undefined> {
    const v = this.rows.get(key);
    return v === undefined ? undefined : structuredClone(v);
  }

  async getAll(): Promise<T[]> {
    return [...this.rows.values()].map((v) => structuredClone(v));
  }

  async getAllKeys(): Promise<string[]> {
    return [...this.rows.keys()];
  }

  async getAllByIndex(index: IndexName, query: IndexKey): Promise<T[]> {
    const def = this.indexes.find((i) => i.name === index);
    if (!def) throw new DOMException(`No such index: ${index}`, 'NotFoundError');
    const out: T[] = [];
    for (const row of this.rows.values()) {
      const k = rowKey(row, def.keyPath);
      if (k !== undefined && sameKey(k, query)) out.push(structuredClone(row));
    }
    return out;
  }

  async update(key: string, fn: (existing: T | undefined) => T | undefined): Promise<T | undefined> {
    const current = this.rows.get(key);
    const next = fn(current === undefined ? undefined : structuredClone(current));
    if (next === undefined) return undefined;
    this.rows.set(key, structuredClone(next));
    return next;
  }

  async addMissing(entries: ReadonlyArray<readonly [string, T]>): Promise<{ added: string[]; existing: string[] }> {
    // Clone everything first: a row that cannot be cloned must reject the whole batch before any of it lands.
    const cloned = entries.map(([key, value]) => [key, structuredClone(value)] as const);
    const added: string[] = [];
    const existing: string[] = [];
    for (const [key, value] of cloned) {
      if (this.rows.has(key)) {
        existing.push(key);
      } else {
        this.rows.set(key, value);
        added.push(key);
      }
    }
    return { added, existing };
  }

  async delete(key: string): Promise<void> {
    this.rows.delete(key);
  }

  async deleteMany(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.rows.delete(key);
  }

  async count(): Promise<number> {
    return this.rows.size;
  }

  async clear(): Promise<void> {
    this.rows.clear();
  }
}

class MemoryPitchLabDb implements PitchLabDb {
  readonly persistent = false;
  readonly deviceId: string;
  private readonly hlc: Hlc;
  private readonly stores = new Map<StoreName, MemoryRawStore<unknown>>();

  constructor(
    readonly fallbackReason: string,
    private readonly now: () => number,
  ) {
    this.deviceId = randomDeviceId();
    this.hlc = createHlc(this.deviceId, undefined, now);
    // Mirrored into `meta` too (nothing here survives a reload) so callers read
    // deviceId and schemaVersion the same way whichever backend they ended up with.
    void this.store<string>('meta').put(this.deviceId, META_KEYS.deviceId);
    void this.store<number>('meta').put(DB_VERSION, META_KEYS.schemaVersion);
  }

  nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  nextTimestamp(): string {
    return this.hlc.next();
  }

  receiveTimestamp(remoteTs: string): string {
    return this.hlc.receive(remoteTs);
  }

  isPlausibleTimestamp(ts: unknown): boolean {
    return isPlausibleHlc(ts, this.now());
  }

  store<T>(name: StoreName): RawStore<T> {
    let s = this.stores.get(name);
    if (!s) {
      s = new MemoryRawStore<unknown>(STORE_INDEXES[name]);
      this.stores.set(name, s);
    }
    return s as unknown as RawStore<T>;
  }

  close(): void {
    // nothing to release
  }
}

// ---------------------------------------------------------------- open

const DEVICE_ID_RE = /^[0-9a-z]{8}$/;

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * Opens (creating and upgrading if needed) the app's data database. Reads or
 * creates this device's id and persisted clock state from `meta`. Falls back to
 * an in-memory `PitchLabDb` - reporting `persistent: false` and why - when
 * `indexedDB` does not exist or fails to open (some private-browsing modes).
 */
export async function openDb(dbName: string = DB_NAME, options: OpenDbOptions = {}): Promise<PitchLabDb> {
  const now = options.now ?? Date.now;
  if (typeof indexedDB === 'undefined') return new MemoryPitchLabDb('indexeddb-unavailable', now);

  let conn: IdbConnection | null = null;
  try {
    conn = await IdbConnection.open({ ...DB_SPEC, name: dbName }, options.openTimeoutMs);
    const meta = new IdbRawStore<unknown>(conn, 'meta', null);

    // Atomic: two tabs opening the very first time must agree on one device id.
    await meta.update(META_KEYS.deviceId, (existing) =>
      typeof existing === 'string' && DEVICE_ID_RE.test(existing) ? undefined : randomDeviceId(),
    );
    const deviceId = (await meta.get(META_KEYS.deviceId)) as string;
    const hlcState = sanitizeHlcState(await meta.get(META_KEYS.hlcState));
    await meta.update(META_KEYS.schemaVersion, (existing) => (existing === undefined ? DB_VERSION : undefined));

    return new IndexedDbPitchLabDb(conn, deviceId, hlcState, now);
  } catch (err) {
    conn?.close();
    return new MemoryPitchLabDb(`open-failed: ${describeError(err)}`, now);
  }
}
