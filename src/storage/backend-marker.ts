/**
 * Remembers which binary backend(s) the stored references point into, so housekeeping never judges a
 * file by a listing that cannot see where it lives.
 *
 * The binary store is chosen afresh every launch (opfs.ts). A launch that gets a different backend and
 * cannot read the old one sees NONE of the files its records reference: reconcile would clear every
 * `audioRef` / `backingRef` as "dangling", and the next launch on the original backend would then delete
 * the real files as "orphans". The marker is the data db's memory of where files have gone:
 * `meta.binaryBackend`, a comma-separated set of every durable backend a file was ever written to
 * (normally one: `opfs` or `idb-blob`). Reconcile acts only when its listing COVERS all of them.
 *
 * It is written in ONE place - `withBackendMarker`, the thin wrapper `openStorage` puts around the binary
 * store - after each successful write, so no repo has to remember to. It is never cleared except by
 * "delete all my data" (maintenance.ts), which removes every file it can see along with every reference.
 */
import { META_KEYS, type PitchLabDb } from './db';
import type { BinaryData, BlobStat, OpfsBackend, OpfsStore } from './opfs';

/** The backends a store can read (`OpfsStore.backends`, which a plain store may leave out). */
export function readableBackends(store: OpfsStore): readonly OpfsBackend[] {
  return store.backends ?? [store.backend];
}

function parseBackends(marker: string): string[] {
  return marker
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/**
 * True when `store` can read every backend the marker says ever received a file. Also true when there is
 * no marker (no file was ever written). An unrecognisable marker counts as NOT covered: when in doubt,
 * housekeeping does nothing.
 */
export async function markerIsCovered(db: PitchLabDb, store: OpfsStore): Promise<boolean> {
  const marker = await db.store<unknown>('meta').get(META_KEYS.binaryBackend);
  if (marker === undefined) return true;
  if (typeof marker !== 'string') return false;
  const readable = new Set<string>(readableBackends(store));
  return parseBackends(marker).every((name) => readable.has(name));
}

/** Delegates to `inner`; every successful write also records the backend it went to. */
class MarkedBlobStore implements OpfsStore {
  constructor(
    private readonly db: PitchLabDb,
    private readonly inner: OpfsStore,
  ) {}

  get backend(): OpfsBackend {
    return this.inner.backend;
  }

  get backends(): readonly OpfsBackend[] | undefined {
    return this.inner.backends;
  }

  get persistent(): boolean {
    return this.inner.persistent;
  }

  async write(path: string, data: BinaryData): Promise<void> {
    await this.inner.write(path, data);
    await this.note();
  }

  /**
   * Adds the backend to the marker (an atomic read-modify-write that writes nothing once it is listed).
   * Deliberately NOT cached per session: "delete all my data" clears the marker, and a cache would
   * then leave the next files unprotected. Best effort - a failure here must not fail the write.
   */
  private async note(): Promise<void> {
    if (!this.inner.persistent) return; // a file in memory dies with the page: nothing to protect
    const backend = this.inner.backend;
    try {
      await this.db.store<unknown>('meta').update(META_KEYS.binaryBackend, (current) => {
        if (current === undefined) return backend;
        if (typeof current !== 'string') return undefined; // unrecognised: leave it be (it makes reconcile skip)
        return parseBackends(current).includes(backend) ? undefined : `${current},${backend}`;
      });
    } catch {
      // the next write tries again
    }
  }

  read(path: string): Promise<Blob | undefined> {
    return this.inner.read(path);
  }

  stat(path: string): Promise<BlobStat | undefined> {
    return this.inner.stat(path);
  }

  delete(path: string): Promise<void> {
    return this.inner.delete(path);
  }

  list(prefix?: string): Promise<string[]> {
    return this.inner.list(prefix);
  }

  totalBytes(prefix?: string): Promise<number> {
    return this.inner.totalBytes(prefix);
  }

  close(): void {
    this.inner.close();
  }
}

/** A view of `store` that records, in the data db, which backend each written file went to. */
export function withBackendMarker(db: PitchLabDb, store: OpfsStore): OpfsStore {
  return new MarkedBlobStore(db, store);
}
