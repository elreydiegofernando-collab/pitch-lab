/**
 * Storage durability (docs/SPEC.md §6.7, §12 Export/import). Feature-detected:
 * `navigator.storage` and its methods are missing on older browsers.
 */

export interface StorageInfo {
  /** null when the browser can't report it (no Storage Manager API). */
  persisted: boolean | null;
  /** Bytes currently used, or null when `estimate()` is unsupported (Safari < 17). */
  usage: number | null;
  /** Bytes available, or null when `estimate()` is unsupported. */
  quota: number | null;
}

/**
 * Asks the browser not to evict this origin's storage under pressure. On iOS
 * this matters only for a home-screen-installed app (Safari 15.2+); those are
 * already exempt from the 7-day Safari storage cap, but persist() is still the
 * documented way to opt out of ordinary LRU eviction. Chrome/Edge grant it
 * heuristically (site engagement) rather than on every call.
 */
export async function requestPersistentStorage(): Promise<boolean | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return null;
  try {
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

/** For the Diagnostics screen. */
export async function getStorageInfo(): Promise<StorageInfo> {
  const info: StorageInfo = { persisted: null, usage: null, quota: null };
  if (typeof navigator === 'undefined' || !navigator.storage) return info;

  if (navigator.storage.persisted) {
    try {
      info.persisted = await navigator.storage.persisted();
    } catch {
      // Leave null: the Diagnostics screen shows "unknown" rather than a false reading.
    }
  }
  if (navigator.storage.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      info.usage = estimate.usage ?? null;
      info.quota = estimate.quota ?? null;
    } catch {
      // Leave null; same reasoning as above.
    }
  }
  return info;
}
