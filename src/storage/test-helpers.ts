/**
 * Shared test doubles for the storage tests (not a test file itself): fresh database names,
 * an in-memory OPFS with switchable quirks, wrappers that inject failures, and record builders.
 */
import { vi } from 'vitest';
import type { NewAttempt } from './attempts-repo';
import { openDb, type PitchLabDb } from './db';
import type { KVStore } from './kv-types';
import type { BinaryData, BlobStat, OpfsStore } from './opfs';
import type { TakeRecord } from './schema';

let nameCounter = 0;

/** A database name nothing else in the test file has used. */
export function freshName(prefix: string): string {
  nameCounter += 1;
  return `${prefix}-${nameCounter}-${Math.random().toString(36).slice(2, 6)}`;
}

export function attemptInput(profileId: string, overrides: Partial<NewAttempt> = {}): NewAttempt {
  return {
    profileId,
    exerciseId: 'foundations.sustain.1',
    levelId: null,
    kind: 'practice',
    score: 0.8,
    passed: true,
    mastery: 1,
    metrics: {},
    durationSec: 4,
    tonicMidi: 60,
    tempoBpm: null,
    takeId: null,
    ...overrides,
  };
}

export function emptyTrack(): TakeRecord['track'] {
  return { frameRate: 93.75, t0: 0, midi: '', rmsDb: '', confidence: '', voiced: '' };
}

// ---------------------------------------------------------------- in-memory OPFS

export interface OpfsMockControl {
  /** File handles expose `move()` (Chrome 110+, Safari 16.4+). */
  supportsMove: boolean;
  /** `move()` exists but refuses (for example because the destination exists). */
  moveThrows: boolean;
  /** File handles have no `createWritable()` (Safari before 26 on the main thread). */
  createWritableMissing: boolean;
  /** Called on every `write()`; throw to simulate a failure such as QuotaExceededError. */
  onWrite: ((fileName: string, bytes: number) => void) | null;
  /** `close()` silently keeps one byte fewer than was written (a truncated write nobody reported). */
  truncateOnClose: boolean;
  /** Called on every `removeEntry()` with the entry's name; throw to simulate a file that cannot be removed (NoModificationAllowedError). */
  onRemove: ((fileName: string) => void) | null;
}

class MockFileHandle {
  readonly kind = 'file' as const;
  content = new Blob([]);
  lastModified = Date.now();

  constructor(
    public name: string,
    private readonly dir: MockDirHandle,
    private readonly ctl: OpfsMockControl,
  ) {}

  async getFile(): Promise<File> {
    return new File([this.content], this.name, { lastModified: this.lastModified });
  }

  get createWritable(): (() => Promise<unknown>) | undefined {
    if (this.ctl.createWritableMissing) return undefined;
    return async () => {
      const parts: Blob[] = [];
      return {
        write: async (data: Blob) => {
          this.ctl.onWrite?.(this.name, data.size);
          parts.push(data);
        },
        close: async () => {
          const blob = new Blob(parts);
          this.content = this.ctl.truncateOnClose && blob.size > 0 ? blob.slice(0, blob.size - 1) : blob;
          this.lastModified = Date.now();
        },
        abort: async () => {},
      };
    };
  }

  get move(): ((newName: string) => Promise<void>) | undefined {
    if (!this.ctl.supportsMove) return undefined;
    return async (newName: string) => {
      if (this.ctl.moveThrows) throw new DOMException('refused to replace', 'InvalidModificationError');
      this.dir.rename(this, newName);
    };
  }
}

export class MockDirHandle {
  readonly kind = 'directory' as const;
  readonly entriesMap = new Map<string, MockFileHandle | MockDirHandle>();

  constructor(
    public name: string,
    private readonly ctl: OpfsMockControl,
  ) {}

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<MockDirHandle> {
    const existing = this.entriesMap.get(name);
    if (existing) {
      if (existing.kind !== 'directory') throw new DOMException('not a directory', 'TypeMismatchError');
      return existing;
    }
    if (!opts?.create) throw new DOMException('no such directory', 'NotFoundError');
    const dir = new MockDirHandle(name, this.ctl);
    this.entriesMap.set(name, dir);
    return dir;
  }

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<MockFileHandle> {
    const existing = this.entriesMap.get(name);
    if (existing) {
      if (existing.kind !== 'file') throw new DOMException('not a file', 'TypeMismatchError');
      return existing;
    }
    if (!opts?.create) throw new DOMException('no such file', 'NotFoundError');
    const file = new MockFileHandle(name, this, this.ctl);
    this.entriesMap.set(name, file);
    return file;
  }

  async removeEntry(name: string): Promise<void> {
    this.ctl.onRemove?.(name);
    if (!this.entriesMap.has(name)) throw new DOMException('no such entry', 'NotFoundError');
    this.entriesMap.delete(name);
  }

  async *entries(): AsyncIterableIterator<[string, MockFileHandle | MockDirHandle]> {
    for (const entry of [...this.entriesMap]) yield entry;
  }

  /** Renames a file in this directory, replacing any entry already at the new name. */
  rename(file: MockFileHandle, newName: string): void {
    this.entriesMap.delete(file.name);
    file.name = newName;
    this.entriesMap.set(newName, file);
  }
}

export interface OpfsMock {
  root: MockDirHandle;
  control: OpfsMockControl;
  /** Every file path under the root, internal files included, e.g. `pitch-lab-bin/takes/x.wav`. */
  tree(): string[];
  /** Plants a file directly (any path under the root), optionally with an old modification time. */
  seed(path: string, content: string, lastModified?: number): Promise<void>;
}

function treeOf(dir: MockDirHandle, prefix: string, out: string[]): void {
  for (const [name, handle] of dir.entriesMap) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') treeOf(handle, path, out);
    else out.push(path);
  }
}

/** Installs a fake `navigator.storage.getDirectory()` backed by memory. Call `vi.unstubAllGlobals()` in afterEach. */
export function installOpfsMock(options: Partial<OpfsMockControl> = {}): OpfsMock {
  const control: OpfsMockControl = {
    supportsMove: true,
    moveThrows: false,
    createWritableMissing: false,
    onWrite: null,
    truncateOnClose: false,
    onRemove: null,
    ...options,
  };
  const root = new MockDirHandle('', control);
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
  return {
    root,
    control,
    tree: () => {
      const out: string[] = [];
      treeOf(root, '', out);
      return out;
    },
    seed: async (path, content, lastModified) => {
      const parts = path.split('/');
      let dir = root;
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      const file = await dir.getFileHandle(parts[parts.length - 1], { create: true });
      file.content = new Blob([content]);
      if (lastModified !== undefined) file.lastModified = lastModified;
    },
  };
}

/** Installs a `navigator` with no OPFS at all. */
export function installNoOpfs(): void {
  vi.stubGlobal('navigator', { storage: {} });
}

/** Points `navigator` at an already installed OPFS mock again (a later launch of the same browser profile finds the same files). */
export function useOpfsMock(mock: OpfsMock): void {
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => mock.root } });
}

/** Installs a `navigator` whose OPFS cannot be reached at all: `getDirectory()` rejects, as when the browser denies access. */
export function installUnreachableOpfs(): void {
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => {
        throw new DOMException('denied', 'SecurityError');
      },
    },
  });
}

/** An OPFS `removeEntry` hook that refuses to remove entries whose name ends with `suffix` (a locked file), except half-written temp files. */
export function lockFilesEndingWith(suffix: string): (fileName: string) => void {
  return (fileName) => {
    if (fileName.endsWith(suffix) && !fileName.startsWith('.tmp-')) throw new DOMException('locked', 'NoModificationAllowedError');
  };
}

// ---------------------------------------------------------------- failure injection

/** Wraps an OpfsStore so the next writes fail with the given errors (null = let that write through). */
export class FlakyOpfs implements OpfsStore {
  constructor(
    private readonly inner: OpfsStore,
    public writePlan: Array<Error | null>,
  ) {}

  get backend() {
    return this.inner.backend;
  }
  get backends() {
    return this.inner.backends;
  }
  get persistent() {
    return this.inner.persistent;
  }
  writes = 0;

  async write(path: string, data: BinaryData): Promise<void> {
    this.writes += 1;
    const next = this.writePlan.shift();
    if (next) throw next;
    return this.inner.write(path, data);
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

export function quotaError(): Error {
  return new DOMException('The quota has been exceeded.', 'QuotaExceededError');
}

/** A view of `target` whose method `name` is replaced by `impl`; everything else (getters included) passes through. */
export function overrideMethod<T extends object>(target: T, name: string, impl: (...args: never[]) => unknown): T {
  return new Proxy(target, {
    get(obj, prop) {
      if (prop === name) return impl;
      const value = Reflect.get(obj, prop, obj);
      return typeof value === 'function' ? value.bind(obj) : value;
    },
  });
}

/** A view of `target` (a db or a binary store) that reports `persistent` as given; everything else passes through. */
export function withPersistent<T extends { readonly persistent: boolean }>(target: T, persistent: boolean): T {
  return new Proxy(target, {
    get(obj, prop) {
      if (prop === 'persistent') return persistent;
      const value = Reflect.get(obj, prop, obj);
      return typeof value === 'function' ? value.bind(obj) : value;
    },
  });
}

/** A data db that fell back to memory (`persistent: false`), as when IndexedDB is missing. Other globals are left as they are. */
export async function openMemoryDb(): Promise<PitchLabDb> {
  const original = (globalThis as { indexedDB?: unknown }).indexedDB;
  vi.stubGlobal('indexedDB', undefined);
  try {
    return await openDb(freshName('memdb'));
  } finally {
    vi.stubGlobal('indexedDB', original);
  }
}

/**
 * Makes `indexedDB.open()` throw for the named databases while every other name keeps working: a browser
 * that blocks one database. The spy goes away with `vi.restoreAllMocks()`.
 */
export function failIndexedDbOpen(...names: string[]): void {
  const original = indexedDB.open.bind(indexedDB);
  vi.spyOn(indexedDB, 'open').mockImplementation(((name: string, version?: number) => {
    if (names.includes(name)) throw new DOMException(`blocked for the test: ${name}`, 'SecurityError');
    return version === undefined ? original(name) : original(name, version);
  }) as never);
}

/** A view of `db` in which `method` of the named store always rejects with `error`. */
export function dbWithFailingStore<D extends { store: (name: never) => object }>(db: D, storeName: string, method: string, error: Error): D {
  return overrideMethod(db, 'store', (name: string) => {
    const store = db.store(name as never);
    return name === storeName ? overrideMethod(store, method, async () => Promise.reject(error)) : store;
  });
}

/** A plain in-memory KVStore with switchable failures. Set `persistent = false` to play a settings store that fell back to memory. */
export class MemoryKV implements KVStore {
  persistent = true;
  readonly map = new Map<string, unknown>();
  /** Operations that throw while set. */
  failing = new Set<'get' | 'set' | 'delete' | 'keys'>();

  private check(op: 'get' | 'set' | 'delete' | 'keys'): void {
    if (this.failing.has(op)) throw new Error(`kv ${op} failed`);
  }
  async get<T>(key: string): Promise<T | undefined> {
    this.check('get');
    return this.map.has(key) ? (structuredClone(this.map.get(key)) as T) : undefined;
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.check('set');
    this.map.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<void> {
    this.check('delete');
    this.map.delete(key);
  }
  async keys(prefix = ''): Promise<string[]> {
    this.check('keys');
    return [...this.map.keys()].filter((k) => k.startsWith(prefix));
  }
}
