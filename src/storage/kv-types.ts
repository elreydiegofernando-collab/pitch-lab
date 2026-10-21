/**
 * Tiny async key-value store on IndexedDB (no dependency). Falls back to an
 * in-memory map when IndexedDB is unavailable (some private modes), and says so
 * via `persistent: false` so the UI can warn that data will not survive.
 *
 * Key convention: `profile:<profileId>:<thing>`, e.g. `profile:default:settings`.
 */
export interface KVStore {
  readonly persistent: boolean;
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
}
