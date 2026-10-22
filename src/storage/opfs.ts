/**
 * Binary store for take audio and imported backing tracks (SPEC §12 export,
 * ROADMAP "OPFS asset/model store"). Backend, in order of preference:
 *  1. OPFS (`navigator.storage.getDirectory()`) - Chrome/Edge, and Safari where the main
 *     thread can write. Safari had OPFS from 15.2 but, for a long time, only through sync
 *     access handles inside a Worker (no `createWritable()` on the main thread, which is
 *     all this module can use). A write probe at open detects that and sends it to (2).
 *  2. IndexedDB blobs, in their own small database - when OPFS is missing or fails the probe.
 *  3. An in-memory map - when `indexedDB` itself is unavailable too.
 * All three speak the same `OpfsStore` interface so callers never branch on backend.
 *
 * The choice is made afresh every launch and a browser can change its answer for good (Safari gaining
 * main-thread createWritable() sends idb-blob -> OPFS; a failing OPFS open or probe sends it back), so
 * `openOpfs` returns a read-through view over the backend in use now AND the other durable one when it
 * already holds data (`LayeredBlobStore`): an old recording still plays, usage counts it, "delete all my
 * data" reaches it, and housekeeping knows which backends its listing covers.
 *
 * `delete()` is best-effort (an already-missing or locked file is not an error), so a delete that is
 * PROMISED - a privacy delete - goes through `deleteConfirmed`, which checks the file is really gone.
 *
 * Paths are logical ("takes/<id>.wav"); every segment before the last becomes an OPFS
 * subdirectory. A `manifest.json` at the OPFS root records a schema version so a future
 * on-disk layout change has somewhere to read "what shape is this?" before migrating.
 *
 * Writes are atomic-ish: the bytes go to a temp file, are verified, then renamed over the
 * target (`move()` where supported; otherwise copied and size-checked). A crash can only
 * ever leave a stale `.tmp-*` file, which the next open sweeps away once it is old enough.
 */
import { IdbConnection, requestToPromise, transactionDone, type IdbSpec } from './idb';
import { newShortId } from './ids';

export type OpfsBackend = 'opfs' | 'idb-blob' | 'memory';

/** Anything the audio code may hand us (WAV encoder output, a file picked by the user). */
export type BinaryData = Blob | ArrayBuffer | ArrayBufferView;

export interface BlobStat {
  size: number;
  /** ms since epoch the file was last written. */
  modifiedAt: number;
}

export interface OpfsStore {
  /** Where NEW files are written. */
  readonly backend: OpfsBackend;
  /**
   * Every backend this store can read, `backend` first (absent: just `backend`). More than one only
   * after the browser switched backends between launches and the old one still holds files - see
   * `openOpfs`. Housekeeping (maintenance.ts) only trusts a listing when it covers every backend that
   * ever received a file.
   */
  readonly backends?: readonly OpfsBackend[];
  /** False for the in-memory fallback: nothing survives a reload. */
  readonly persistent: boolean;
  write(path: string, data: BinaryData): Promise<void>;
  read(path: string): Promise<Blob | undefined>;
  stat(path: string): Promise<BlobStat | undefined>;
  /** Best effort: a missing file is fine, and the OPFS backend also swallows a file it cannot remove. Use `deleteConfirmed` when the delete was promised. */
  delete(path: string): Promise<void>;
  /** Logical paths starting with `prefix` (default all); never internal bookkeeping files. */
  list(prefix?: string): Promise<string[]>;
  /** Bytes stored under `prefix` (default everything). */
  totalBytes(prefix?: string): Promise<number>;
  close(): void;
}

export const OPFS_ROOT_DIR = 'pitch-lab-bin';
export const OPFS_MANIFEST_NAME = 'manifest.json';
export const OPFS_MANIFEST_VERSION = 1;
export const OPFS_TMP_PREFIX = '.tmp-';
const PROBE_PREFIX = '.probe-';
/** A temp file older than this is the debris of a crashed write, never an in-flight one. */
export const OPFS_STALE_TEMP_MS = 60 * 60 * 1000;

/** Logical path segment: starts alphanumeric (so `.`, `..` and our dot-prefixed internals are impossible). */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function splitPath(path: string): { dirs: string[]; file: string } {
  const parts = typeof path === 'string' ? path.split('/') : [];
  if (parts.length === 0 || parts.some((p) => !SEGMENT_RE.test(p))) throw new Error(`OpfsStore: invalid path: ${String(path)}`);
  if (parts.length === 1 && parts[0] === OPFS_MANIFEST_NAME) throw new Error(`OpfsStore: reserved path: ${path}`);
  return { dirs: parts.slice(0, -1), file: parts[parts.length - 1] };
}

function toBlob(data: BinaryData): Blob {
  return data instanceof Blob ? data : new Blob([data as BlobPart]);
}

// ---- minimal structural types for the File System Access / OPFS surface we use.
// Defined locally (not from the ambient DOM lib) so this module works the same
// whether or not the lib's OPFS typings are complete, and so the in-memory test
// mock only has to satisfy this small shape. `move()` is newer and feature-detected,
// never assumed. -------------------------------------------------------------
interface FsWritable {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}
interface FsFileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<Blob>;
  createWritable(): Promise<FsWritable>;
  move?(newName: string): Promise<void>;
}
interface FsDirHandle {
  readonly kind: 'directory';
  readonly name: string;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FsDirHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FsFileHandle>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterableIterator<[string, FsFileHandle | FsDirHandle]>;
}

function getStorageManager(): { getDirectory(): Promise<FsDirHandle> } | undefined {
  const nav = (globalThis as { navigator?: unknown }).navigator as
    | { storage?: { getDirectory?: () => Promise<FsDirHandle> } }
    | undefined;
  const storage = nav?.storage;
  return storage && typeof storage.getDirectory === 'function' ? (storage as { getDirectory(): Promise<FsDirHandle> }) : undefined;
}

async function resolveDir(root: FsDirHandle, dirs: string[], create: boolean): Promise<FsDirHandle> {
  let dir = root;
  for (const seg of dirs) dir = await dir.getDirectoryHandle(seg, { create });
  return dir;
}

async function writeAll(handle: FsFileHandle, blob: Blob): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (err) {
    try {
      await writable.abort?.();
    } catch {
      // the stream may already be closed or errored
    }
    throw err;
  }
}

async function readManifest(root: FsDirHandle): Promise<{ schemaVersion: number } | null> {
  try {
    const handle = await root.getFileHandle(OPFS_MANIFEST_NAME, { create: false });
    const parsed = JSON.parse(await (await handle.getFile()).text()) as { schemaVersion?: unknown } | null;
    return parsed && typeof parsed.schemaVersion === 'number' ? { schemaVersion: parsed.schemaVersion } : null;
  } catch {
    return null; // missing or unreadable: treat as a fresh store
  }
}

async function ensureManifest(root: FsDirHandle): Promise<void> {
  const manifest = await readManifest(root);
  // Only version 1 exists today. A future bump migrates existing files here, before
  // writing the new manifest. A manifest from a NEWER build is left alone.
  if (manifest && manifest.schemaVersion >= OPFS_MANIFEST_VERSION) return;
  const handle = await root.getFileHandle(OPFS_MANIFEST_NAME, { create: true });
  await writeAll(handle, new Blob([JSON.stringify({ schemaVersion: OPFS_MANIFEST_VERSION })]));
}

/** Throws unless a file can really be created, written, read back and removed here. */
async function probeWritable(root: FsDirHandle): Promise<void> {
  const name = `${PROBE_PREFIX}${newShortId(8)}`;
  const handle = await root.getFileHandle(name, { create: true });
  try {
    await writeAll(handle, new Blob(['ok']));
    if ((await handle.getFile()).size !== 2) throw new Error('OPFS probe: wrote 2 bytes, read back a different size');
  } finally {
    await root.removeEntry(name).catch(() => {});
  }
}

function isInternalName(name: string): boolean {
  return name.startsWith('.');
}

/** Removes `.tmp-*` / `.probe-*` files left behind by a crash. Best effort, never throws. */
async function sweepStaleTemps(dir: FsDirHandle, now: number): Promise<void> {
  try {
    const stale: string[] = [];
    const subdirs: FsDirHandle[] = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'directory') {
        subdirs.push(handle);
      } else if (name.startsWith(OPFS_TMP_PREFIX) || name.startsWith(PROBE_PREFIX)) {
        const modified = (await handle.getFile()) as Blob & { lastModified?: number };
        if (typeof modified.lastModified === 'number' && now - modified.lastModified > OPFS_STALE_TEMP_MS) stale.push(name);
      }
    }
    for (const name of stale) await dir.removeEntry(name).catch(() => {});
    for (const sub of subdirs) await sweepStaleTemps(sub, now);
  } catch {
    // housekeeping only
  }
}

async function openOpfsRoot(): Promise<FsDirHandle | null> {
  const storage = getStorageManager();
  if (!storage) return null;
  try {
    const origin = await storage.getDirectory();
    const root = await origin.getDirectoryHandle(OPFS_ROOT_DIR, { create: true });
    await ensureManifest(root);
    await probeWritable(root);
    await sweepStaleTemps(root, Date.now());
    return root;
  } catch {
    return null;
  }
}

async function walk(dir: FsDirHandle, prefix: string, root: boolean, out: string[]): Promise<void> {
  for await (const [name, handle] of dir.entries()) {
    if (isInternalName(name) || (root && name === OPFS_MANIFEST_NAME)) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') await walk(handle, path, false, out);
    else out.push(path);
  }
}

class OpfsBackendStore implements OpfsStore {
  readonly backend: OpfsBackend = 'opfs';
  readonly backends: readonly OpfsBackend[] = ['opfs'];
  readonly persistent = true;

  constructor(private readonly root: FsDirHandle) {}

  async write(path: string, data: BinaryData): Promise<void> {
    const { dirs, file } = splitPath(path);
    const blob = toBlob(data);
    const dir = await resolveDir(this.root, dirs, true);
    const tmpName = `${OPFS_TMP_PREFIX}${newShortId(8)}-${file}`;
    let createdReal = false;
    try {
      const tmp = await dir.getFileHandle(tmpName, { create: true });
      await writeAll(tmp, blob);
      if ((await tmp.getFile()).size !== blob.size) throw new Error(`OpfsStore: temp write verification failed for ${path}`);

      if (typeof tmp.move === 'function') {
        try {
          await tmp.move(file); // atomic rename; replaces any existing file of the same name
          return;
        } catch {
          // Some implementations refuse to replace an existing file: fall through to the copy path.
        }
      }
      // No (working) rename: copy the already fully written temp file's bytes into the real
      // file, verify the size landed, then drop the temp file. A spec-compliant writable only
      // replaces the real file on close(), so a failure here still leaves the old content intact.
      const existed = await dir.getFileHandle(file, { create: false }).then(
        () => true,
        () => false,
      );
      const real = await dir.getFileHandle(file, { create: true });
      createdReal = !existed;
      await writeAll(real, blob);
      if ((await real.getFile()).size !== blob.size) throw new Error(`OpfsStore: write verification failed for ${path}`);
      await dir.removeEntry(tmpName).catch(() => {});
    } catch (err) {
      await dir.removeEntry(tmpName).catch(() => {});
      // A brand-new target that never received its bytes must not linger as an empty "take".
      if (createdReal) await dir.removeEntry(file).catch(() => {});
      throw err;
    }
  }

  async read(path: string): Promise<Blob | undefined> {
    try {
      const { dirs, file } = splitPath(path);
      const dir = await resolveDir(this.root, dirs, false);
      return await (await dir.getFileHandle(file, { create: false })).getFile();
    } catch {
      return undefined;
    }
  }

  async stat(path: string): Promise<BlobStat | undefined> {
    const blob = (await this.read(path)) as (Blob & { lastModified?: number }) | undefined;
    return blob ? { size: blob.size, modifiedAt: typeof blob.lastModified === 'number' ? blob.lastModified : 0 } : undefined;
  }

  async delete(path: string): Promise<void> {
    try {
      const { dirs, file } = splitPath(path);
      const dir = await resolveDir(this.root, dirs, false);
      await dir.removeEntry(file);
    } catch {
      // already gone: fine
    }
  }

  async list(prefix = ''): Promise<string[]> {
    const all: string[] = [];
    await walk(this.root, '', true, all);
    return prefix ? all.filter((p) => p.startsWith(prefix)) : all;
  }

  async totalBytes(prefix = ''): Promise<number> {
    let total = 0;
    for (const path of await this.list(prefix)) total += (await this.stat(path))?.size ?? 0;
    return total;
  }

  close(): void {
    // handles need no release
  }
}

// ---------------------------------------------------------------- IndexedDB blob fallback

const BLOB_STORE = 'blobs';
export const BLOB_DB_NAME = 'pitch-lab-bin';

const BLOB_SPEC: IdbSpec = {
  name: BLOB_DB_NAME,
  version: 1,
  upgrade(db) {
    if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE);
  },
};

interface BlobRow {
  size: number;
  savedAt: number;
  blob: Blob;
}

function prefixRange(prefix: string): IDBKeyRange | undefined {
  return prefix ? IDBKeyRange.bound(prefix, prefix + String.fromCharCode(0xffff)) : undefined;
}

class IdbBlobStore implements OpfsStore {
  readonly backend: OpfsBackend = 'idb-blob';
  readonly backends: readonly OpfsBackend[] = ['idb-blob'];
  readonly persistent = true;

  constructor(private readonly conn: IdbConnection) {}

  async write(path: string, data: BinaryData): Promise<void> {
    splitPath(path);
    const blob = toBlob(data);
    const row: BlobRow = { size: blob.size, savedAt: Date.now(), blob };
    await this.conn.run(async (db) => {
      // An IDB transaction is already atomic: no temp file and rename needed.
      const tx = db.transaction(BLOB_STORE, 'readwrite', { durability: 'strict' });
      tx.objectStore(BLOB_STORE).put(row, path);
      await transactionDone(tx);
    });
  }

  private row(path: string): Promise<BlobRow | undefined> {
    return this.conn.run((db) => {
      const tx = db.transaction(BLOB_STORE, 'readonly');
      return requestToPromise<BlobRow | undefined>(tx.objectStore(BLOB_STORE).get(path));
    });
  }

  async read(path: string): Promise<Blob | undefined> {
    return (await this.row(path))?.blob;
  }

  async stat(path: string): Promise<BlobStat | undefined> {
    const row = await this.row(path);
    return row ? { size: row.size, modifiedAt: row.savedAt } : undefined;
  }

  async delete(path: string): Promise<void> {
    await this.conn.run(async (db) => {
      const tx = db.transaction(BLOB_STORE, 'readwrite');
      tx.objectStore(BLOB_STORE).delete(path);
      await transactionDone(tx);
    });
  }

  async list(prefix = ''): Promise<string[]> {
    return this.conn.run(async (db) => {
      const tx = db.transaction(BLOB_STORE, 'readonly');
      const keys = await requestToPromise(tx.objectStore(BLOB_STORE).getAllKeys(prefixRange(prefix)));
      return keys.map((k) => String(k));
    });
  }

  async totalBytes(prefix = ''): Promise<number> {
    return this.conn.run(
      (db) =>
        new Promise<number>((resolve, reject) => {
          const tx = db.transaction(BLOB_STORE, 'readonly');
          const request = tx.objectStore(BLOB_STORE).openCursor(prefixRange(prefix));
          let total = 0;
          request.onsuccess = () => {
            const cursor = request.result;
            if (cursor) {
              total += (cursor.value as BlobRow).size;
              cursor.continue();
            } else {
              resolve(total);
            }
          };
          request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor failed'));
        }),
    );
  }

  close(): void {
    this.conn.close();
  }
}

// ---------------------------------------------------------------- in-memory fallback

class MemoryBlobStore implements OpfsStore {
  readonly backend: OpfsBackend = 'memory';
  readonly backends: readonly OpfsBackend[] = ['memory'];
  readonly persistent = false;
  private readonly rows = new Map<string, BlobRow>();

  async write(path: string, data: BinaryData): Promise<void> {
    splitPath(path);
    const blob = toBlob(data);
    this.rows.set(path, { size: blob.size, savedAt: Date.now(), blob });
  }

  async read(path: string): Promise<Blob | undefined> {
    return this.rows.get(path)?.blob;
  }

  async stat(path: string): Promise<BlobStat | undefined> {
    const row = this.rows.get(path);
    return row ? { size: row.size, modifiedAt: row.savedAt } : undefined;
  }

  async delete(path: string): Promise<void> {
    this.rows.delete(path);
  }

  async list(prefix = ''): Promise<string[]> {
    return [...this.rows.keys()].filter((p) => p.startsWith(prefix));
  }

  async totalBytes(prefix = ''): Promise<number> {
    let total = 0;
    for (const [path, row] of this.rows) if (path.startsWith(prefix)) total += row.size;
    return total;
  }

  close(): void {
    // nothing to release
  }
}

// ---------------------------------------------------------------- two backends at once

/**
 * Stands in for a backend that exists and holds data but cannot be opened. Every call rejects: pretending
 * its files are not there would let housekeeping delete references to them, and "delete all my data"
 * report success with audio still on the device.
 */
class UnreadableBlobStore implements OpfsStore {
  readonly persistent = true;
  readonly backends: readonly OpfsBackend[] = []; // reads nothing

  constructor(
    readonly backend: OpfsBackend,
    private readonly cause: unknown,
  ) {}

  private fail(): never {
    const why = this.cause instanceof Error ? this.cause.message : String(this.cause);
    throw new Error(`OpfsStore: the ${this.backend} store holds files but could not be opened (${why})`);
  }

  async write(): Promise<void> {
    this.fail();
  }
  async read(): Promise<Blob | undefined> {
    return this.fail();
  }
  async stat(): Promise<BlobStat | undefined> {
    return this.fail();
  }
  async delete(): Promise<void> {
    this.fail();
  }
  async list(): Promise<string[]> {
    return this.fail();
  }
  async totalBytes(): Promise<number> {
    return this.fail();
  }
  close(): void {
    // nothing was opened
  }
}

/**
 * A read-through view over the backend in use now (`primary`, the only one ever written) and the other
 * durable backend that already holds data (`secondary`):
 *  - read/stat fall back to the secondary, so a recording made before the switch still plays;
 *  - list() is the de-duplicated union and totalBytes() the sum, so usage, "delete all my data" and
 *    housekeeping see every file. list() REJECTS when the secondary cannot be listed: a partial listing
 *    would let housekeeping act on a wrong picture (maintenance.ts aborts untouched on a list failure);
 *  - delete() reaches both, so a deleted recording is gone wherever it lives;
 *  - write() goes to the primary and drops a now-stale copy from the secondary.
 * Nothing is migrated at open: a multi-MB copy at launch is its own crash window and doubles space use.
 */
class LayeredBlobStore implements OpfsStore {
  readonly backends: readonly OpfsBackend[];

  constructor(
    private readonly primary: OpfsStore,
    private readonly secondary: OpfsStore,
  ) {
    this.backends = [...new Set([...(primary.backends ?? [primary.backend]), ...(secondary.backends ?? [secondary.backend])])];
  }

  get backend(): OpfsBackend {
    return this.primary.backend;
  }

  get persistent(): boolean {
    return this.primary.persistent;
  }

  async write(path: string, data: BinaryData): Promise<void> {
    await this.primary.write(path, data);
    await this.secondary.delete(path).catch(() => {}); // a stale copy lingering is harmless: reads prefer the primary and deletes reach both
  }

  async read(path: string): Promise<Blob | undefined> {
    return (await this.primary.read(path)) ?? (await this.secondary.read(path));
  }

  async stat(path: string): Promise<BlobStat | undefined> {
    return (await this.primary.stat(path)) ?? (await this.secondary.stat(path));
  }

  async delete(path: string): Promise<void> {
    const outcomes = await Promise.allSettled([this.primary.delete(path), this.secondary.delete(path)]);
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  }

  async list(prefix = ''): Promise<string[]> {
    const [own, other] = await Promise.all([this.primary.list(prefix), this.secondary.list(prefix)]);
    if (other.length === 0) return own;
    const seen = new Set(own);
    return [...own, ...other.filter((path) => !seen.has(path))];
  }

  async totalBytes(prefix = ''): Promise<number> {
    const [own, other] = await Promise.all([this.primary.totalBytes(prefix), this.secondary.totalBytes(prefix)]);
    return own + other;
  }

  close(): void {
    this.primary.close();
    this.secondary.close();
  }
}

/** `primary` alone, or a view that also reads `other` when that backend holds data. */
function withOtherBackend(primary: OpfsStore, other: OpfsStore | null): OpfsStore {
  return other ? new LayeredBlobStore(primary, other) : primary;
}

/**
 * The OPFS directory, if it already exists - never created. Null: nothing was ever written there, OR it
 * cannot be told (`getDirectory()` rejects): the backend marker in the data db (backend-marker.ts) is
 * what stops housekeeping from acting on a listing that is missing it.
 */
async function findExistingOpfs(): Promise<OpfsStore | null> {
  const storage = getStorageManager();
  if (!storage) return null;
  try {
    const origin = await storage.getDirectory();
    return new OpfsBackendStore(await origin.getDirectoryHandle(OPFS_ROOT_DIR, { create: false }));
  } catch {
    return null;
  }
}

/** How long to wait for `indexedDB.databases()` before giving up on the lookup: the launch must never hang on it. */
export const DATABASE_LOOKUP_TIMEOUT_MS = 3000;

/** `promise`'s value, or undefined if it rejects or has not settled within `ms`. */
function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

/** The IndexedDB blob database, if it already exists - never created (`indexedDB.databases()` lists it). Null as for `findExistingOpfs`. */
async function findExistingIdbBlobs(name: string): Promise<OpfsStore | null> {
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return null;
  try {
    const known = await settledWithin(indexedDB.databases(), DATABASE_LOOKUP_TIMEOUT_MS);
    if (!known?.some((info) => info.name === name)) return null;
  } catch {
    return null; // databases() threw synchronously
  }
  try {
    return new IdbBlobStore(await IdbConnection.open({ ...BLOB_SPEC, name }));
  } catch (err) {
    return new UnreadableBlobStore('idb-blob', err);
  }
}

// ---------------------------------------------------------------- open

export interface OpenOpfsOptions {
  /** Name of the IndexedDB database used when OPFS is unavailable (tests use a fresh one each). */
  fallbackDbName?: string;
}

/**
 * Opens the binary store, trying OPFS, then IndexedDB blobs, then memory (see module doc). New files go
 * to the first that works; the other durable backend is read too when it already holds files.
 */
export async function openOpfs(options: OpenOpfsOptions = {}): Promise<OpfsStore> {
  const blobDbName = options.fallbackDbName ?? BLOB_DB_NAME;
  const root = await openOpfsRoot();
  if (root) return withOtherBackend(new OpfsBackendStore(root), await findExistingIdbBlobs(blobDbName));

  let primary: OpfsStore;
  if (typeof indexedDB === 'undefined') {
    primary = new MemoryBlobStore();
  } else {
    try {
      primary = new IdbBlobStore(await IdbConnection.open({ ...BLOB_SPEC, name: blobDbName }));
    } catch {
      primary = new MemoryBlobStore();
    }
  }
  return withOtherBackend(primary, await findExistingOpfs());
}

/**
 * Deletes `path` and CONFIRMS it is gone. A store's delete() is best-effort (it swallows a locked or
 * failing file), so any delete the singer was promised - a recording, "delete all my data" - goes
 * through here: it rejects when the file is still there, leaving the caller's record in place to retry.
 */
export async function deleteConfirmed(store: OpfsStore, path: string): Promise<void> {
  await store.delete(path);
  if (await store.stat(path)) throw new Error(`OpfsStore: ${path} could not be deleted (the file is still there)`);
}
