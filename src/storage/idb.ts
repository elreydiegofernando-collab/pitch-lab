/**
 * Shared IndexedDB plumbing for the Phase 3+ databases (the data db in db.ts and the
 * blob fallback in opfs.ts): promise wrappers, error classification, and a connection
 * that survives the failure modes real browsers hit:
 *  - `versionchange` from a newer tab or build  -> close politely so its upgrade is never blocked;
 *  - a dead connection (iOS "Connection to Indexed Database server lost", site data cleared
 *    underneath us)                             -> reopen once and retry the operation;
 *  - a downgrade (database already at a newer version than this build) -> open it as it is
 *    (stores and indexes only ever grow, so an older build can still read and write it);
 *  - an `open()` that never answers (old WebKit hangs)                  -> give up after a timeout.
 * The Phase 1 key-value store (kv.ts) predates this and keeps its own minimal copy.
 */

export function errorName(err: unknown): string {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  return typeof name === 'string' ? name : '';
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  const message = (err as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' ? message : String(err);
}

/** Storage is full (IndexedDB `QuotaExceededError`, OPFS write failures included). */
export function isQuotaError(err: unknown): boolean {
  const e = err as { name?: unknown; code?: unknown } | null | undefined;
  return !!e && (errorName(e) === 'QuotaExceededError' || e.code === 22 || /quota/i.test(errorMessage(err)));
}

/** `add()` hit an existing key. */
export function isConstraintError(err: unknown): boolean {
  return errorName(err) === 'ConstraintError';
}

/** The connection is closing/closed/lost: worth reopening and retrying once. */
export function isConnectionLostError(err: unknown): boolean {
  if (errorName(err) === 'InvalidStateError') return true;
  return /connection to indexed database server lost|database connection is closing|database is closed/i.test(errorMessage(err));
}

export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/**
 * Resolves when the transaction has COMMITTED (`complete`), which is the durability
 * point callers wait on. On failure it rejects with the underlying DOMException
 * (`ConstraintError`, `QuotaExceededError`, ...), not a generic wrapper: when an
 * unhandled request error bubbles to the transaction, `tx.error` is still null, so
 * the request's own error is the one worth reporting.
 */
export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = (event) => {
      const requestError = (event.target as IDBRequest | null)?.error;
      reject(requestError ?? tx.error ?? new Error('IndexedDB transaction failed'));
    };
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** One schema step: runs inside the versionchange transaction. */
export type UpgradeStep = (db: IDBDatabase, tx: IDBTransaction) => void;

/** Runs the steps newer than `oldVersion`, in order. `steps[i]` upgrades version i to i + 1. */
export function applyUpgrades(steps: readonly UpgradeStep[], db: IDBDatabase, oldVersion: number, tx: IDBTransaction): void {
  for (let v = oldVersion; v < steps.length; v++) steps[v](db, tx);
}

export interface IdbSpec {
  name: string;
  version: number;
  /** Runs inside the versionchange transaction for a fresh or older database. */
  upgrade(db: IDBDatabase, oldVersion: number, tx: IDBTransaction): void;
}

export const DEFAULT_OPEN_TIMEOUT_MS = 10_000;

function openOnce(spec: IdbSpec, version: number | undefined, timeoutMs: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request: IDBOpenDBRequest;
    try {
      request = version === undefined ? indexedDB.open(spec.name) : indexedDB.open(spec.name, version);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`IndexedDB open timed out: ${spec.name}`));
    }, timeoutMs);

    request.onupgradeneeded = (event) => {
      try {
        spec.upgrade(request.result, event.oldVersion, request.transaction as IDBTransaction);
      } catch {
        // A half-applied upgrade must not commit: abort it and let the open fail,
        // leaving the previous version's data untouched.
        try {
          request.transaction?.abort();
        } catch {
          // already aborting
        }
      }
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (settled) {
        request.result.close(); // we already gave up on this open; do not leak the connection
        return;
      }
      settled = true;
      resolve(request.result);
    };
    request.onerror = () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error('IndexedDB open failed'));
    };
    // `blocked` just means another tab still holds an older version open. Its
    // versionchange handler closes it, after which this open proceeds, so wait.
    request.onblocked = () => {};
  });
}

/** Opens (creating or upgrading) the database; opens it as-is when it is already newer than this build. */
export async function openIdbDatabase(spec: IdbSpec, timeoutMs: number = DEFAULT_OPEN_TIMEOUT_MS): Promise<IDBDatabase> {
  try {
    return await openOnce(spec, spec.version, timeoutMs);
  } catch (err) {
    if (errorName(err) !== 'VersionError') throw err;
    return openOnce(spec, undefined, timeoutMs);
  }
}

/**
 * A long-lived connection that closes itself politely on `versionchange` and
 * transparently reopens - once per operation - after the connection is lost.
 */
export class IdbConnection {
  private db: IDBDatabase | null;
  private pending: Promise<IDBDatabase> | null = null;
  private closed = false;

  private constructor(
    private readonly spec: IdbSpec,
    private readonly timeoutMs: number,
    db: IDBDatabase,
  ) {
    this.db = this.track(db);
  }

  static async open(spec: IdbSpec, timeoutMs: number = DEFAULT_OPEN_TIMEOUT_MS): Promise<IdbConnection> {
    return new IdbConnection(spec, timeoutMs, await openIdbDatabase(spec, timeoutMs));
  }

  private track(db: IDBDatabase): IDBDatabase {
    db.onversionchange = () => {
      db.close();
      if (this.db === db) this.db = null;
    };
    db.onclose = () => {
      if (this.db === db) this.db = null;
    };
    return db;
  }

  private live(): Promise<IDBDatabase> {
    if (this.closed) return Promise.reject(new Error('database closed'));
    if (this.db) return Promise.resolve(this.db);
    if (!this.pending) {
      this.pending = openIdbDatabase(this.spec, this.timeoutMs)
        .then((db) => {
          if (this.closed) {
            db.close();
            throw new Error('database closed');
          }
          this.db = this.track(db);
          return db;
        })
        .finally(() => {
          this.pending = null;
        });
    }
    return this.pending;
  }

  /**
   * Runs `fn` against a live connection. If the connection turns out to be dead
   * (see isConnectionLostError) it is discarded, reopened, and `fn` runs once more
   * with `attempt === 1`. Any other failure propagates unchanged.
   */
  async run<R>(fn: (db: IDBDatabase, attempt: number) => Promise<R> | R): Promise<R> {
    const first = await this.live();
    try {
      return await fn(first, 0);
    } catch (err) {
      if (this.closed || !isConnectionLostError(err)) throw err;
      this.discard(first);
      return await fn(await this.live(), 1);
    }
  }

  /** Closes `db`, and forgets it if it is still the current connection (a concurrent recovery may already have replaced it). */
  private discard(db: IDBDatabase | null): void {
    if (db && this.db === db) this.db = null;
    try {
      db?.close();
    } catch {
      // already closed
    }
  }

  /** Permanently closes; later operations reject. */
  close(): void {
    this.closed = true;
    this.discard(this.db);
  }
}
